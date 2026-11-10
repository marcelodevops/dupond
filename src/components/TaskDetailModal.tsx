import React, { useState } from 'react';
import { Task, Agent, Epic, TaskStatus, Priority } from '../types';
import { apiFetch } from '../lib/api';
import { withPromotedChecklistItem } from '../services/acceptanceMapping';
import { 
  X, 
  CheckCircle2, 
  Clock, 
  User, 
  Tag, 
  Layers, 
  AlertCircle, 
  Sparkles, 
  RotateCw, 
  FileCode, 
  Link2, 
  Send,
  ArrowRight
} from 'lucide-react';

interface TaskDetailModalProps {
  task: Task | null;
  onClose: () => void;
  onUpdateTask: (updatedTask: Task) => void;
  agents: Agent[];
  epics: Epic[];
  allTasks: Task[];
  onExecuteAgentOnTask: (task: Task, agent: Agent) => Promise<void>;
  isExecutingStep: boolean;
}

export const TaskDetailModal: React.FC<TaskDetailModalProps> = ({
  task,
  onClose,
  onUpdateTask,
  agents,
  epics,
  allTasks,
  onExecuteAgentOnTask,
  isExecutingStep,
}) => {
  if (!task) return null;

  const [activeTab, setActiveTab] = useState<'details' | 'subtasks' | 'deliverables'>('details');
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [newCriterionTitle, setNewCriterionTitle] = useState('');
  const [newCriterionCommand, setNewCriterionCommand] = useState('');

  const assignee = agents.find((a) => a.id === task.assignedAgentId);
  const epic = epics.find((e) => e.id === task.epicId);

  // Check dependencies
  const dependencyDetails = (task.dependencies || []).map((depId) => {
    const depTask = allTasks.find((t) => t.id === depId);
    return {
      id: depId,
      key: depTask?.key || depId,
      title: depTask?.title || 'Unknown Task',
      status: depTask?.status || 'todo',
      isDone: depTask?.status === 'done',
    };
  });

  const allDependenciesMet = dependencyDetails.every((d) => d.isDone);

  // Toggle subtask — progress only. Completion of a checklist row is never an
  // acceptance decision, so it writes to subtasks and nothing else.
  const handleToggleSubtask = (subtaskId: string) => {
    const updatedSubtasks = task.subtasks.map((st) =>
      st.id === subtaskId ? { ...st, completed: !st.completed } : st
    );
    onUpdateTask({ ...task, subtasks: updatedSubtasks });
  };

  // Add subtask
  const handleAddSubtask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubtaskTitle.trim()) return;
    const newSt = {
      id: `st-${Date.now()}`,
      title: newSubtaskTitle.trim(),
      completed: false,
    };
    onUpdateTask({ ...task, subtasks: [...task.subtasks, newSt] });
    setNewSubtaskTitle('');
  };

  const criteria = task.acceptanceCriteria || [];

  // Acceptance edits write task.acceptanceCriteria — the contract the
  // authoritative gates enforce — and post the full list explicitly so the
  // server can tell an edit from a field that was never sent. Edits are held
  // as drafts and committed on blur or Enter, because every posted contract
  // change revokes the evidence bound to the previous one and a keystroke is
  // not a decision.
  const postCriteria = (next: typeof criteria) => {
    onUpdateTask({ ...task, acceptanceCriteria: next });
  };

  const [criterionDrafts, setCriterionDrafts] = useState<Record<string, { title: string; checkCommand: string }>>({});
  const draftFor = (criterion: (typeof criteria)[number]) =>
    criterionDrafts[criterion.id] ?? { title: criterion.title, checkCommand: criterion.checkCommand ?? '' };

  const handleCriterionDraftChange = (id: string, field: 'title' | 'checkCommand', value: string) => {
    const criterion = criteria.find((c) => c.id === id);
    if (!criterion) return;
    setCriterionDrafts((drafts) => ({ ...drafts, [id]: { ...draftFor(criterion), [field]: value } }));
  };

  const commitCriterionDraft = (id: string) => {
    const draft = criterionDrafts[id];
    if (!draft) return;
    setCriterionDrafts((drafts) => {
      const rest = { ...drafts };
      delete rest[id];
      return rest;
    });
    postCriteria(criteria.map((c) => (c.id === id
      ? { ...c, title: draft.title.trim() || c.title, checkCommand: draft.checkCommand }
      : c)));
  };

  const handleAddCriterion = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCriterionTitle.trim()) return;
    const id = `crit-${Date.now()}`;
    postCriteria([
      ...criteria,
      {
        id,
        title: newCriterionTitle.trim(),
        completed: false,
        ...(newCriterionCommand.trim() ? { checkCommand: newCriterionCommand.trim() } : {}),
      },
    ]);
    setNewCriterionTitle('');
    setNewCriterionCommand('');
  };

  const handleRemoveCriterion = (id: string) => {
    postCriteria(criteria.filter((c) => c.id !== id));
  };

  const handlePromoteSubtask = (subtaskId: string) => {
    const item = task.subtasks.find((st) => st.id === subtaskId);
    if (!item) return;
    postCriteria(withPromotedChecklistItem(criteria, item));
  };

  const [verificationResult, setVerificationResult] = useState<{
    passed: boolean;
    checks: { rule: string; passed: boolean; detail: string }[];
    logs: string;
    timestamp?: string;
  } | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const handleStatusChange = async (newStatus: TaskStatus) => {
    if (newStatus === 'done') {
      await handleVerifyAndMarkDone();
    } else {
      setVerificationResult(null);
      onUpdateTask({ ...task, status: newStatus });
    }
  };

  const handleVerifyAndMarkDone = async () => {
    setIsVerifying(true);
    setVerificationResult(null);
    try {
      const res = await apiFetch('/api/orchestrate/verify-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      });
      const data = await res.json();
      setVerificationResult(data);
      if (data.passed) {
        onUpdateTask({ ...task, status: 'done', lastAgentComment: 'Passed all verification quality gates.' });
      }
    } catch (err) {
      console.warn('Verification error:', err);
    } finally {
      setIsVerifying(false);
    }
  };

  // Run agent execution step on this task
  const handleRunAgent = async () => {
    if (!assignee) return;
    await onExecuteAgentOnTask(task, assignee);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden my-auto flex flex-col max-h-[90vh]">
        {/* Modal Top Bar */}
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-slate-800 bg-slate-950/80">
          <div className="flex items-center space-x-2">
            <span className="font-mono text-xs font-bold text-indigo-400 bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-900/40">
              {task.key}
            </span>
            {epic && (
              <span className="text-xs text-slate-400 flex items-center space-x-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: epic.color }} />
                <span>{epic.title}</span>
              </span>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 text-sm p-1 rounded-lg hover:bg-slate-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Modal Content */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Title */}
          <div>
            <h2 className="text-base font-bold text-slate-100 leading-snug">
              {task.title}
            </h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              {task.description}
            </p>
          </div>

          {/* Quick Controls Bar: Status, Priority, Assignee */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-slate-950 rounded-xl border border-slate-800">
            {/* Status */}
            <div>
              <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                Status
              </label>
              <select
                value={task.status}
                onChange={(e) => handleStatusChange(e.target.value as TaskStatus)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
              >
                <option value="backlog">Backlog</option>
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="review">Review & QA</option>
                <option value="done">Done (Requires Quality Gate)</option>
              </select>
            </div>

            {/* Priority */}
            <div>
              <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                Priority
              </label>
              <select
                value={task.priority}
                onChange={(e) => onUpdateTask({ ...task, priority: e.target.value as Priority })}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>

            {/* Assignee */}
            <div>
              <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                Assigned Specialist
              </label>
              <select
                value={task.assignedAgentId}
                onChange={(e) => onUpdateTask({ ...task, assignedAgentId: e.target.value })}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role.split(' ')[0]})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Coding Worker Provider & Model */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                Worker Provider
              </label>
              <select
                value={task.workerConfig?.provider || 'gemini'}
                onChange={(e) => {
                  const prov = e.target.value;
                  const defaultMod = prov === 'openai' ? 'gpt-4o-mini' : 'gemini-3.8-flash';
                  onUpdateTask({
                    ...task,
                    workerConfig: {
                      provider: prov,
                      model: defaultMod,
                    },
                  });
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold"
              >
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                Worker Model
              </label>
              <select
                value={task.workerConfig?.model || (task.workerConfig?.provider === 'openai' ? 'gpt-4o-mini' : 'gemini-3.8-flash')}
                onChange={(e) => {
                  onUpdateTask({
                    ...task,
                    workerConfig: {
                      provider: task.workerConfig?.provider || 'gemini',
                      model: e.target.value,
                    },
                  });
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {(task.workerConfig?.provider || 'gemini') === 'gemini' ? (
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
            </div>
          </div>

          {/* Quality Gates Verification Report Card */}
          {verificationResult && (
            <div className={`p-4 rounded-xl border ${verificationResult.passed ? 'bg-emerald-950/40 border-emerald-800/60' : 'bg-rose-950/40 border-rose-800/60'} space-y-2.5 animate-fadeIn`}>
              <div className="flex items-center justify-between">
                <span className={`text-xs font-bold uppercase tracking-wider flex items-center space-x-1.5 ${verificationResult.passed ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {verificationResult.passed ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <AlertCircle className="w-4 h-4 text-rose-400" />}
                  <span>{verificationResult.passed ? 'Quality Gate PASSED: Verified for "Done"' : 'Quality Gate FAILED: "Done" Blocked'}</span>
                </span>
                <span className="text-[10px] font-mono text-slate-400">{verificationResult.timestamp}</span>
              </div>

              <div className="space-y-1.5">
                {verificationResult.checks.map((check, i) => (
                  <div key={i} className="flex items-start space-x-2 text-xs">
                    <span className={`font-bold mt-0.5 ${check.passed ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {check.passed ? '✓' : '✕'}
                    </span>
                    <div>
                      <span className="font-semibold text-slate-200">{check.rule}: </span>
                      <span className={check.passed ? 'text-slate-300' : 'text-rose-200'}>{check.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dependency Check Banner */}
          {dependencyDetails.length > 0 && (
            <div className={`p-3 rounded-xl border text-xs ${allDependenciesMet ? 'bg-slate-950/60 border-slate-800 text-slate-300' : 'bg-amber-950/30 border-amber-800/40 text-amber-200'}`}>
              <div className="flex items-center space-x-1.5 font-semibold mb-1.5">
                <AlertCircle className={`w-3.5 h-3.5 ${allDependenciesMet ? 'text-emerald-400' : 'text-amber-400'}`} />
                <span>Prerequisite Dependencies:</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {dependencyDetails.map((dep) => (
                  <span
                    key={dep.id}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                      dep.isDone
                        ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
                        : 'bg-amber-950/60 border-amber-800/60 text-amber-300'
                    }`}
                  >
                    {dep.key}: {dep.title} ({dep.status})
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Acceptance Criteria Section — the authoritative contract */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-1.5">
                <CheckCircle2 className="w-4 h-4 text-indigo-400" />
                <span>Acceptance Criteria</span>
              </h4>
              <span className="text-xs text-slate-400 font-mono">
                {criteria.length} requirement{criteria.length === 1 ? '' : 's'}
              </span>
            </div>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              These are the requirements the authoritative gates verify. Editing this list re-binds the task's
              evidence and revokes any granted Review or Done until fresh verification passes.
            </p>

            <div className="space-y-2">
              {criteria.length === 0 && (
                <p className="text-xs text-slate-500 italic bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
                  No acceptance requirements recorded. Add one, or promote a checklist item below.
                </p>
              )}
              {criteria.map((criterion) => (
                <div
                  key={criterion.id}
                  className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/80 space-y-2 text-xs"
                >
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      value={draftFor(criterion).title}
                      onChange={(e) => handleCriterionDraftChange(criterion.id, 'title', e.target.value)}
                      onBlur={() => commitCriterionDraft(criterion.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitCriterionDraft(criterion.id); }}
                      className="flex-1 px-2 py-1 bg-slate-900 border border-slate-800 rounded text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveCriterion(criterion.id)}
                      className="px-2 py-1 text-slate-500 hover:text-rose-300 border border-slate-800 rounded"
                      title="Remove requirement"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <input
                    type="text"
                    value={draftFor(criterion).checkCommand}
                    onChange={(e) => handleCriterionDraftChange(criterion.id, 'checkCommand', e.target.value)}
                    onBlur={() => commitCriterionDraft(criterion.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitCriterionDraft(criterion.id); }}
                    placeholder="check command (an unproven requirement cannot be accepted)"
                    className="w-full px-2 py-1 bg-slate-900 border border-slate-800 rounded font-mono text-[11px] text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              ))}
            </div>

            <form onSubmit={handleAddCriterion} className="space-y-2 pt-1">
              <input
                type="text"
                value={newCriterionTitle}
                onChange={(e) => setNewCriterionTitle(e.target.value)}
                placeholder="Add acceptance requirement..."
                className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={newCriterionCommand}
                  onChange={(e) => setNewCriterionCommand(e.target.value)}
                  placeholder="optional check command"
                  className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg"
                >
                  Add
                </button>
              </div>
            </form>
          </div>

          {/* Checklist Subtasks — progress only */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-1.5">
                <Layers className="w-4 h-4 text-slate-400" />
                <span>Checklist (progress only)</span>
              </h4>
              <span className="text-xs text-slate-400 font-mono">
                {task.subtasks.filter((s) => s.completed).length}/{task.subtasks.length} Done
              </span>
            </div>

            <div className="space-y-1.5">
              {task.subtasks.map((st) => (
                <div
                  key={st.id}
                  className="flex items-center space-x-2.5 p-2 rounded-lg bg-slate-950/70 border border-slate-800/80 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={st.completed}
                    onChange={() => handleToggleSubtask(st.id)}
                    className="rounded border-slate-700 bg-slate-900 text-indigo-600"
                  />
                  <span className={`flex-1 ${st.completed ? 'line-through text-slate-500' : 'text-slate-200'}`}>
                    {st.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => handlePromoteSubtask(st.id)}
                    className="px-2 py-0.5 text-[10px] text-slate-400 hover:text-indigo-300 border border-slate-800 rounded uppercase tracking-wide"
                    title="Promote to acceptance requirement"
                  >
                    Require
                  </button>
                </div>
              ))}
            </div>

            {/* Add subtask */}
            <form onSubmit={handleAddSubtask} className="flex space-x-2 pt-1">
              <input
                type="text"
                value={newSubtaskTitle}
                onChange={(e) => setNewSubtaskTitle(e.target.value)}
                placeholder="Add subtask acceptance criterion..."
                className="flex-1 px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="submit"
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg"
              >
                Add
              </button>
            </form>
          </div>

          {/* Deliverables Section */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-1.5">
              <FileCode className="w-4 h-4 text-cyan-400" />
              <span>Agent Deliverables & Code Artifacts</span>
            </h4>

            {task.deliverables && task.deliverables.length > 0 ? (
              <div className="space-y-2">
                {task.deliverables.map((deliv, idx) => (
                  <pre
                    key={idx}
                    className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed"
                  >
                    {deliv}
                  </pre>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic bg-slate-950/60 p-3 rounded-lg border border-slate-800">
                No deliverables generated yet. Click "Execute Agent Step on This Task" below to trigger specialist execution.
              </p>
            )}
          </div>
        </div>

        {/* Modal Bottom Bar: Run Agent Action */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            {assignee && (
              <div className="flex items-center space-x-2 text-xs text-slate-300">
                <img
                  src={assignee.avatar}
                  alt={assignee.name}
                  className="w-5 h-5 rounded-full object-cover border border-slate-700"
                />
                <span className="font-medium">{assignee.name}</span>
                <span className="text-[10px] text-indigo-400 bg-indigo-950 px-1 rounded">
                  {assignee.role}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              Close
            </button>

            <button
              onClick={handleRunAgent}
              disabled={isExecutingStep || !assignee}
              className="flex items-center space-x-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold shadow-md shadow-indigo-600/20 transition-all disabled:opacity-50"
            >
              {isExecutingStep ? (
                <>
                  <RotateCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Agent Executing...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Execute Agent Step on This Task</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
