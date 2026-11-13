import React, { useState, useEffect, useRef } from 'react';
import { PlanTemplate, Task, Epic, Agent } from '../types';
import { SAMPLE_PLANS } from '../data/defaultData';
import { projectApi } from '../lib/projectApi';
import { useProject } from '../context/ProjectContext';
import { PlanningReadiness } from '../types/projectContract';
import { 
  Sparkles, 
  RotateCw, 
  FileText, 
  Check, 
  ArrowRight, 
  AlertTriangle,
  Info,
  Clock,
  Layers
} from 'lucide-react';

interface PlanIngestionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdoptPlan: (newEpics: Epic[], newTasks: Task[], planSummary: string, sourcePlanId?: string, planRevision?: number) => Promise<boolean | void> | void;
  agents: Agent[];
}

export const PlanIngestionModal: React.FC<PlanIngestionModalProps> = ({
  isOpen,
  onClose,
  onAdoptPlan,
  agents,
}) => {
  const { currentProject } = useProject();
  const currentProjectId = currentProject?.id || 'default';

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(SAMPLE_PLANS[0].id);
  const [planTextInput, setPlanTextInput] = useState<string>(SAMPLE_PLANS[0].planContent);
  const [isDecomposing, setIsDecomposing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<PlanningReadiness | null>(null);
  const [sourcePlanId, setSourcePlanId] = useState<string | null>(null);
  const [sourcePlanRevision, setSourcePlanRevision] = useState<number | null>(null);
  const [parsedResult, setParsedResult] = useState<{
    summary?: string;
    suggestedTimelineWeeks?: number;
    epics?: Epic[];
    tasks?: Task[];
    sourcePlanId?: string;
    planRevision?: number;
  } | null>(null);

  const activeProjectRef = useRef<string>(currentProjectId);
  activeProjectRef.current = currentProjectId;

  // Fetch planning readiness on modal open
  useEffect(() => {
    if (!isOpen) return;
    let mounted = true;
    projectApi
      .getPlanningReadiness()
      .then((data) => {
        if (mounted) setReadiness(data);
      })
      .catch((err) => {
        if (mounted) {
          setReadiness({
            provider: 'gemini',
            model: 'gemini-3.8-flash',
            ready: false,
            error: err.message || 'Could not verify planning service status.',
          });
        }
      });
    return () => {
      mounted = false;
    };
  }, [isOpen]);

  // Load existing source plan if available on open or project switch
  useEffect(() => {
    if (!isOpen || !currentProjectId) return;
    let mounted = true;
    projectApi
      .getProjectPlan(currentProjectId)
      .then((res) => {
        if (!mounted) return;
        if (res.latest && res.latest.sourceText) {
          setPlanTextInput(res.latest.sourceText);
          setSelectedTemplateId('custom');
          setSourcePlanId(res.latest.id);
          setSourcePlanRevision(res.latest.revision);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [isOpen, currentProjectId]);

  if (!isOpen) return null;

  const handleSelectTemplate = (template: PlanTemplate) => {
    setSelectedTemplateId(template.id);
    setPlanTextInput(template.planContent);
    setParsedResult(null);
    setErrorMessage(null);
  };

  const handleTextChange = (text: string) => {
    setPlanTextInput(text);
    setSelectedTemplateId('custom');
    // Invalidate stale breakdown immediately on any text change
    setParsedResult(null);
    setErrorMessage(null);
  };

  const handleDecomposePlan = async () => {
    if (!planTextInput.trim()) return;
    setIsDecomposing(true);
    setErrorMessage(null);
    setParsedResult(null);

    const capturedProject = activeProjectRef.current;

    try {
      const data = await projectApi.parseProjectPlan(capturedProject, {
        planText: planTextInput,
        currentAgents: agents,
      });

      // Guard against project switching during in-flight network call
      if (capturedProject !== activeProjectRef.current) {
        return;
      }

      setParsedResult(data);
      if (data.sourcePlanId) setSourcePlanId(data.sourcePlanId);
      if (data.planRevision) setSourcePlanRevision(data.planRevision);
    } catch (err: any) {
      if (capturedProject !== activeProjectRef.current) return;
      const detail = err.message || 'AI plan decomposition failed.';
      setErrorMessage(detail);
    } finally {
      setIsDecomposing(false);
    }
  };

  const handleConfirmAdopt = async () => {
    if (!parsedResult || !parsedResult.tasks || !parsedResult.epics) return;
    setIsDecomposing(true);
    setErrorMessage(null);
    try {
      await onAdoptPlan(
        parsedResult.epics,
        parsedResult.tasks,
        parsedResult.summary || 'Custom Orchestrated Sprint Plan',
        sourcePlanId || undefined,
        sourcePlanRevision || undefined
      );
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to adopt plan into project.');
    } finally {
      setIsDecomposing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full shadow-2xl overflow-hidden my-auto flex flex-col max-h-[92vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/30 border border-indigo-500/50 flex items-center justify-center text-indigo-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
                <span>Curated Plan Ingestion & AI Decomposition Engine</span>
                <span className="text-[11px] font-mono text-indigo-400 px-2 py-0.5 bg-indigo-950/60 border border-indigo-900/40 rounded-full">
                  Project: {currentProject?.name || currentProjectId}
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Supply a well-curated plan, markdown spec, or select an enterprise template for autonomous breakdown.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-sm p-1 rounded-lg hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Provider Readiness Status Bar */}
          <div className={`p-3 rounded-xl border text-xs flex items-center justify-between ${
            readiness?.ready
              ? 'bg-emerald-950/30 border-emerald-800/60 text-emerald-300'
              : 'bg-amber-950/30 border-amber-800/60 text-amber-300'
          }`}>
            <div className="flex items-center space-x-2">
              {readiness?.ready ? (
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              )}
              <span>
                <strong>Planning Engine:</strong> {readiness?.provider || 'gemini'} ({readiness?.model || 'gemini-3.8-flash'})
                {' — '}
                {readiness?.ready ? (
                  <span className="text-emerald-400 font-semibold">Ready for decomposition</span>
                ) : (
                  <span className="text-amber-400 font-semibold">Key Not Configured ({readiness?.error || 'Unavailable'})</span>
                )}
              </span>
            </div>
            {sourcePlanRevision && (
              <span className="text-[11px] font-mono bg-slate-900 px-2 py-0.5 rounded border border-slate-800 text-slate-300">
                Revision #{sourcePlanRevision}
              </span>
            )}
          </div>

          {/* Persistent Actionable Error Banner */}
          {errorMessage && (
            <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-800/80 text-rose-200 text-xs space-y-1.5 animate-fadeIn">
              <div className="flex items-center space-x-2 font-bold text-rose-100">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>Plan Decomposition Failed</span>
              </div>
              <p className="leading-relaxed text-rose-300">
                {errorMessage}
              </p>
              <p className="text-[11px] text-rose-400">
                Your submitted plan text is preserved below. Configure <code>GEMINI_API_KEY</code> on the server to enable autonomous decomposition.
              </p>
            </div>
          )}

          {/* Template Selection Chips */}
          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-2">
              Select Curated Plan Template (or write custom):
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {SAMPLE_PLANS.map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleSelectTemplate(template)}
                  className={`text-left p-3 rounded-xl border transition-all ${
                    selectedTemplateId === template.id
                      ? 'bg-indigo-950/50 border-indigo-500 text-white shadow-sm'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200'
                  }`}
                >
                  <span className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider block mb-1">
                    {template.category}
                  </span>
                  <h4 className="text-xs font-bold text-slate-200 line-clamp-1">{template.title}</h4>
                  <p className="text-[11px] text-slate-400 line-clamp-2 mt-1 leading-snug">
                    {template.description}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Plan Textarea Editor */}
          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-slate-300">
                Plan Content (Markdown or Structured Text):
              </label>
              <button
                onClick={() => handleTextChange('')}
                className="text-xs text-indigo-400 hover:text-indigo-300 underline"
              >
                Clear / New Custom Plan
              </button>
            </div>
            <textarea
              value={planTextInput}
              onChange={(e) => handleTextChange(e.target.value)}
              rows={8}
              placeholder="# Project Title&#10;## Objectives&#10;1. Core backend architecture..."
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed"
            />
          </div>

          {/* Decompose Button */}
          <div className="flex justify-center">
            <button
              onClick={handleDecomposePlan}
              disabled={isDecomposing || !planTextInput.trim() || readiness?.ready === false}
              title={readiness?.ready === false ? 'GEMINI_API_KEY must be configured on the server' : undefined}
              className="flex items-center space-x-2 px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/30 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isDecomposing ? (
                <>
                  <RotateCw className="w-4 h-4 animate-spin" />
                  <span>Decomposing & Organizing Sprint Plan...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 text-indigo-200" />
                  <span>Decompose & Orchestrate Plan with AI</span>
                </>
              )}
            </button>
          </div>

          {/* Decomposed Breakdown Preview */}
          {parsedResult && parsedResult.tasks && (
            <div className="space-y-4 pt-4 border-t border-slate-800 animate-fadeIn">
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-indigo-300 uppercase tracking-wider flex items-center space-x-1.5">
                    <Check className="w-4 h-4 text-emerald-400" />
                    <span>Decomposition Summary</span>
                  </span>
                  {parsedResult.suggestedTimelineWeeks && (
                    <span className="text-xs text-slate-400">
                      Suggested Sprint: <strong className="text-slate-200">{parsedResult.suggestedTimelineWeeks} Weeks</strong>
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {parsedResult.summary}
                </p>
              </div>

              {/* Decomposed Tasks Preview Table */}
              <div>
                <h4 className="text-xs font-semibold text-slate-300 mb-2">
                  Generated Epics & Tasks ({parsedResult.tasks.length} tasks ready to orchestrate):
                </h4>
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {parsedResult.tasks.map((task, idx) => (
                    <div
                      key={idx}
                      className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-2.5 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center space-x-2.5 truncate mr-2">
                        <span className="font-mono text-[11px] font-bold text-indigo-400 shrink-0">
                          {task.key || `TASK-${100 + idx}`}
                        </span>
                        <span className="text-slate-200 truncate font-medium">{task.title}</span>
                      </div>
                      <div className="flex items-center space-x-3 shrink-0 text-[11px]">
                        <span className="text-slate-400 font-mono">{task.estimatedHours || 4}h</span>
                        <span className="text-indigo-400 text-[10px] bg-indigo-950 px-1.5 py-0.5 rounded border border-indigo-900/40">
                          {task.priority || 'medium'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
          >
            Cancel
          </button>

          {parsedResult && parsedResult.tasks && (
            <button
              onClick={handleConfirmAdopt}
              className="flex items-center space-x-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-700/20 transition-all active:scale-95"
            >
              <span>Adopt Plan to Kanban Board</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
