import React, { useEffect, useState } from 'react';
import { Task, Agent, Epic, Priority } from '../types';
import { projectApi } from '../lib/projectApi';
import type { AgyAuthStatus } from '../types/projectContract';
import { Plus, X } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';

interface AddTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddTask: (newTask: Task) => void;
  agents: Agent[];
  epics: Epic[];
  existingTasksCount: number;
  onOpenAppSettings?: () => void;
}

export const AddTaskModal: React.FC<AddTaskModalProps> = ({
  isOpen,
  onClose,
  onAddTask,
  agents,
  epics,
  existingTasksCount,
  onOpenAppSettings,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [epicId, setEpicId] = useState(epics[0]?.id || 'epic-core');
  const [priority, setPriority] = useState<Priority>('medium');
  const [assignedAgentId, setAssignedAgentId] = useState(agents[0]?.id || 'agent-arch');
  const [workerProvider, setWorkerProvider] = useState<'gemini' | 'openai' | 'opencode' | 'agy'>('gemini');
  const [workerModel, setWorkerModel] = useState('gemini-3.8-flash');
  const [agyStatus, setAgyStatus] = useState<AgyAuthStatus | null>(null);
  const [agyCustomModelMode, setAgyCustomModelMode] = useState(false);
  const [estimatedHours, setEstimatedHours] = useState(8);
  const [tagsInput, setTagsInput] = useState('Core, Architecture');

  useEffect(() => {
    if (!isOpen || workerProvider !== 'agy') return;
    let cancelled = false;
    projectApi
      .getAgyAuthStatus()
      .then((status) => {
        if (!cancelled) {
          setAgyStatus(status);
          if (status.defaultModel && !agyCustomModelMode && workerModel === 'gemini-3.8-flash-medium' && status.models?.length) {
            setWorkerModel(status.models[0]);
          }
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setAgyStatus({
            cliAvailable: false,
            executablePath: null,
            version: null,
            credentialsPresent: false,
            profileAuthenticated: false,
            profileAuthVerified: false,
            sandboxAuthVerified: false,
            executionVerified: false,
            onboardingSupported: false,
            availableModelsCount: 0,
            models: [],
            defaultModel: 'gemini-3.8-flash-medium',
            error: err?.message || 'Failed to check Antigravity CLI availability.',
            session: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, workerProvider]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const key = `AEG-${100 + existingTasksCount + 1}`;
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const newTask: Task = {
      id: `task-${Date.now()}`,
      key,
      title: title.trim(),
      description: description.trim() || 'No detailed description provided.',
      epicId,
      status: 'todo',
      priority,
      assignedAgentId,
      estimatedHours: Number(estimatedHours) || 6,
      spentHours: 0,
      dependencies: [],
      subtasks: [
        { id: `st-${Date.now()}-1`, title: 'Implement initial requirements', completed: false },
        { id: `st-${Date.now()}-2`, title: 'Verify and run QA tests', completed: false },
      ],
      tags,
      deliverables: [],
      workerConfig: {
        provider: workerProvider,
        model: workerModel,
      },
      jiraSynced: true,
      slackNotified: false,
      lastUpdated: 'Just now',
    };

    onAddTask(newTask);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/80">
          <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
            <Plus className="w-4 h-4 text-indigo-400" />
            <span>Create New Task</span>
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-sm p-1 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Task Title
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Implement OAuth JWT token rotation"
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Description & Acceptance Criteria
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Provide technical specifics and constraints..."
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Epic
              </label>
              <select
                value={epicId}
                onChange={(e) => setEpicId(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
              >
                {epics.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Assign Specialist Agent
              </label>
              <div className="flex items-center space-x-2">
                {(() => {
                  const selectedAgent = agents.find((a) => a.id === assignedAgentId);
                  return selectedAgent ? <AgentAvatar agent={selectedAgent} size={28} /> : null;
                })()}
                <select
                  value={assignedAgentId}
                  onChange={(e) => setAssignedAgentId(e.target.value)}
                  className="flex-1 min-w-0 px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.role.split(' ')[0]})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Estimated Hours
              </label>
              <input
                type="number"
                min="1"
                max="80"
                value={estimatedHours}
                onChange={(e) => setEstimatedHours(parseInt(e.target.value) || 6)}
                className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Coding Worker Provider
              </label>
              <select
                data-testid="add-task-worker-provider-select"
                value={workerProvider}
                onChange={(e) => {
                  const prov = e.target.value as 'gemini' | 'openai' | 'opencode' | 'agy';
                  setWorkerProvider(prov);
                  setAgyCustomModelMode(false);
                  setWorkerModel(
                    prov === 'gemini'
                      ? 'gemini-3.8-flash'
                      : prov === 'agy'
                        ? agyStatus?.models?.[0] || agyStatus?.defaultModel || 'gemini-3.8-flash-medium'
                        : prov === 'opencode'
                          ? 'github-copilot/gpt-5.3-codex'
                          : 'gpt-4o-mini',
                  );
                }}
                className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
              >
                <option value="gemini">Google Gemini</option>
                <option value="agy">Antigravity CLI (Agy)</option>
                <option value="openai">OpenAI</option>
                <option value="opencode">OpenCode CLI</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">
                Model Identifier
              </label>
              {workerProvider === 'opencode' ? (
                <input
                  type="text"
                  value={workerModel}
                  onChange={(e) => setWorkerModel(e.target.value)}
                  placeholder="github-copilot/gpt-5.3-codex"
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono"
                />
              ) : workerProvider === 'agy' ? (
                <div className="space-y-1.5">
                  {(() => {
                    const presets = agyStatus?.models?.length
                      ? agyStatus.models
                      : [agyStatus?.defaultModel || 'gemini-3.8-flash-medium'];
                    const presetList = Array.from(new Set(presets));
                    const isCustom = agyCustomModelMode || !presetList.includes(workerModel);
                    return (
                      <>
                        <select
                          data-testid="add-task-agy-model-select"
                          value={isCustom ? '__custom__' : workerModel}
                          onChange={(e) => {
                            if (e.target.value === '__custom__') {
                              setAgyCustomModelMode(true);
                            } else {
                              setAgyCustomModelMode(false);
                              setWorkerModel(e.target.value);
                            }
                          }}
                          className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                        >
                          {presetList.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                          <option value="__custom__">Custom model...</option>
                        </select>
                        {isCustom && (
                          <input
                            type="text"
                            data-testid="add-task-agy-custom-model-input"
                            value={workerModel}
                            onChange={(e) => setWorkerModel(e.target.value)}
                            placeholder="gemini-3.8-flash-medium"
                            className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white font-mono"
                          />
                        )}
                      </>
                    );
                  })()}
                </div>
              ) : (
                <select
                  value={workerModel}
                  onChange={(e) => setWorkerModel(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
                >
                  {workerProvider === 'gemini' ? (
                    <>
                      <option value="gemini-3.8-flash">gemini-3.8-flash (Recommended)</option>
                      <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                    </>
                  ) : (
                    <>
                      <option value="gpt-4o-mini">gpt-4o-mini (Recommended)</option>
                      <option value="gpt-4o">gpt-4o</option>
                      <option value="o3-mini">o3-mini</option>
                      <option value="o1">o1</option>
                      <option value="gpt-4.5-preview">gpt-4.5-preview</option>
                    </>
                  )}
                </select>
              )}
            </div>
          </div>

          {workerProvider === 'agy' && agyStatus && (!agyStatus.cliAvailable || !agyStatus.profileAuthenticated) && (
            <div
              data-testid="add-task-agy-readiness-warning"
              className="p-2.5 rounded-lg border bg-amber-950/30 border-amber-800/60 text-amber-200 text-xs flex flex-wrap items-center justify-between gap-2"
            >
              <span>
                {agyStatus.error || 'Dedicated Antigravity profile is not authenticated. Connect Antigravity CLI before executing.'}
              </span>
              {onOpenAppSettings && (
                <button
                  type="button"
                  data-testid="add-task-open-app-settings-btn"
                  onClick={() => {
                    onClose();
                    onOpenAppSettings();
                  }}
                  className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-semibold"
                >
                  Open Application Settings
                </button>
              )}
            </div>
          )}

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Tags (comma separated)
            </label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="Backend, Security, API"
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="flex justify-end space-x-2 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20"
            >
              Create Task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
