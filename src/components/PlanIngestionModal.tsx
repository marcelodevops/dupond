import React, { useState } from 'react';
import { PlanTemplate, Task, Epic, Agent } from '../types';
import { SAMPLE_PLANS } from '../data/defaultData';
import { 
  Sparkles, 
  RotateCw, 
  FileText, 
  Check, 
  ArrowRight, 
  Layers, 
  Bot, 
  Calendar, 
  Clock, 
  Tag
} from 'lucide-react';

interface PlanIngestionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdoptPlan: (newEpics: Epic[], newTasks: Task[], planSummary: string) => void;
  agents: Agent[];
}

export const PlanIngestionModal: React.FC<PlanIngestionModalProps> = ({
  isOpen,
  onClose,
  onAdoptPlan,
  agents,
}) => {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(SAMPLE_PLANS[0].id);
  const [planTextInput, setPlanTextInput] = useState<string>(SAMPLE_PLANS[0].planContent);
  const [isDecomposing, setIsDecomposing] = useState<boolean>(false);
  const [parsedResult, setParsedResult] = useState<{
    summary?: string;
    suggestedTimelineWeeks?: number;
    epics?: Epic[];
    tasks?: Task[];
  } | null>(null);

  if (!isOpen) return null;

  const handleSelectTemplate = (template: PlanTemplate) => {
    setSelectedTemplateId(template.id);
    setPlanTextInput(template.planContent);
    setParsedResult(null);
  };

  const handleDecomposePlan = async () => {
    if (!planTextInput.trim()) return;
    setIsDecomposing(true);
    setParsedResult(null);

    try {
      const response = await fetch('/api/orchestrate/parse-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planText: planTextInput,
          currentAgents: agents,
        }),
      });

      const data = await response.json();
      setParsedResult(data);
    } catch (err) {
      console.error('Failed to decompose plan:', err);
    } finally {
      setIsDecomposing(false);
    }
  };

  const handleConfirmAdopt = () => {
    if (!parsedResult || !parsedResult.tasks || !parsedResult.epics) return;
    onAdoptPlan(
      parsedResult.epics,
      parsedResult.tasks,
      parsedResult.summary || 'Custom Orchestrated Sprint Plan'
    );
    onClose();
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
              <h3 className="text-sm font-bold text-slate-100">
                Curated Plan Ingestion & AI Decomposition Engine
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
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
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
                onClick={() => {
                  setSelectedTemplateId('custom');
                  setPlanTextInput('');
                  setParsedResult(null);
                }}
                className="text-xs text-indigo-400 hover:text-indigo-300 underline"
              >
                Clear / New Custom Plan
              </button>
            </div>
            <textarea
              value={planTextInput}
              onChange={(e) => {
                setPlanTextInput(e.target.value);
                setSelectedTemplateId('custom');
              }}
              rows={8}
              placeholder="# Project Title\n## Objectives\n1. Core backend architecture..."
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 leading-relaxed"
            />
          </div>

          {/* Decompose Button */}
          <div className="flex justify-center">
            <button
              onClick={handleDecomposePlan}
              disabled={isDecomposing || !planTextInput.trim()}
              className="flex items-center space-x-2 px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white text-xs font-bold rounded-xl shadow-lg shadow-indigo-600/30 transition-all active:scale-95 disabled:opacity-50"
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
                          {task.key || `AEG-${100 + idx}`}
                        </span>
                        <span className="text-slate-200 truncate font-medium">{task.title}</span>
                      </div>
                      <div className="flex items-center space-x-3 shrink-0 text-[11px]">
                        <span className="text-slate-400 font-mono">{task.estimatedHours || 6}h</span>
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
