import React, { useState, useEffect, useRef } from 'react';
import { Task, Agent, Epic, TaskStatus, Priority } from '../types';
import { projectApi } from '../lib/projectApi';
import type { TaskRunsEvidenceResponse } from '../types/projectContract';
import { withPromotedChecklistItem } from '../services/acceptanceMapping';
import { AgentAvatar } from './AgentAvatar';
import {
  X,
  CheckCircle2,
  Clock,
  AlertCircle,
  Sparkles,
  RotateCw,
  FileCode,
  GitBranch,
  Layers,
  Terminal,
  ShieldAlert,
} from 'lucide-react';

interface TaskDetailModalProps {
  task: Task | null;
  projectId?: string;
  onClose: () => void;
  onUpdateTask: (updatedTask: Task) => void;
  onUpdateTaskStatus?: (taskId: string, targetStatus: TaskStatus) => Promise<void>;
  transitionFeedback?: {
    taskId: string;
    targetStatus: TaskStatus;
    reason?: string;
    nextAction?: string;
    message: string;
  } | null;
  lastExecutionInfo?: {
    runId?: string;
    status: 'succeeded' | 'blocked' | 'failed';
    message: string;
    timestamp: string;
  } | null;
  runRefreshKey?: number;
  agents: Agent[];
  epics: Epic[];
  allTasks: Task[];
  onExecuteAgentOnTask: (task: Task, agent: Agent) => Promise<void>;
  isExecutingStep: boolean;
  onRegisterTask?: (
    taskId: string,
  ) => Promise<{ ok: boolean; code?: string; nextAction?: string; error?: string }>;
  onResolveIdentityConflict?: (taskId: string, variantIndex: number) => Promise<{ ok: boolean; error?: string }>;
  onOpenProjectSettings?: () => void;
  onOpenAppSettings?: () => void;
  onReviewTask?: (
    taskId: string,
    decision: 'approve' | 'request_changes',
    candidateBinding: {
      runId: string;
      verificationId: string;
      revisionSha: string;
      requirementsFingerprint: string;
      verificationConfigFingerprint: string;
      evidenceBindingVersion: string;
    },
    comment?: string,
    approvalToken?: string
  ) => Promise<{ ok: boolean; error?: string; code?: string }>;
  onDeliverRun?: (
    taskId: string,
    runId: string,
    isApproved: boolean,
    approvalToken?: string,
    candidateBinding?: {
      verificationId?: string;
      revisionSha?: string;
      requirementsFingerprint?: string;
      verificationConfigFingerprint?: string;
      evidenceBindingVersion?: string;
    }
  ) => Promise<{ ok: boolean; error?: string; code?: string; prUrl?: string }>;
}

export const TaskDetailModal: React.FC<TaskDetailModalProps> = (props) => {
  if (!props.task) return null;
  const effectiveProjectId = props.projectId || 'default';
  return (
    <TaskDetailModalBody
      key={`${effectiveProjectId}:${props.task.id}`}
      {...props}
      projectId={effectiveProjectId}
      task={props.task}
    />
  );
};

const TaskDetailModalBody: React.FC<Omit<TaskDetailModalProps, 'task' | 'projectId'> & { task: Task; projectId: string }> = ({
  task,
  projectId,
  onClose,
  onUpdateTask,
  onUpdateTaskStatus,
  transitionFeedback,
  lastExecutionInfo,
  runRefreshKey = 0,
  agents,
  epics,
  allTasks,
  onExecuteAgentOnTask,
  isExecutingStep,
  onRegisterTask,
  onResolveIdentityConflict,
  onOpenProjectSettings,
  onOpenAppSettings,
  onReviewTask,
  onDeliverRun,
}) => {
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [newCriterionTitle, setNewCriterionTitle] = useState('');
  const [openAIConfigured, setOpenAIConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (task.workerConfig?.provider !== 'openai') {
      setOpenAIConfigured(null);
      return;
    }
    let cancelled = false;
    projectApi
      .getOpenAICredentialStatus()
      .then((status) => {
        if (!cancelled) setOpenAIConfigured(status.configured);
      })
      .catch(() => {
        if (!cancelled) setOpenAIConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, [task.workerConfig?.provider, runRefreshKey]);
  const [newCriterionCommand, setNewCriterionCommand] = useState('');
  const [isTransitioningStatus, setIsTransitioningStatus] = useState(false);

  const [reviewComment, setReviewComment] = useState('');
  const [approvalTokenInput, setApprovalTokenInput] = useState('');
  const [showApprovalTokenField, setShowApprovalTokenField] = useState(false);
  const [reviewActionError, setReviewActionError] = useState<string | null>(null);
  const [isSubmittingReviewOrDelivery, setIsSubmittingReviewOrDelivery] = useState(false);
  const [localReviewApproved, setLocalReviewApproved] = useState(false);

  const [runEvidence, setRunEvidence] = useState<TaskRunsEvidenceResponse | null>(null);
  const [authoritativeTaskRegistered, setAuthoritativeTaskRegistered] = useState<boolean | null>(null);
  const [isRegisteringTask, setIsRegisteringTask] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registrationCode, setRegistrationCode] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [isLoadingRuns, setIsLoadingRuns] = useState(true);
  const [runsLoadError, setRunsLoadError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let active = true;

    const loadRuns = async (isInitial: boolean) => {
      if (isInitial) {
        setIsLoadingRuns(true);
        setRunsLoadError(null);
      }
      try {
        const res = await projectApi.getTaskRunsWithRegistration(projectId, task.id, selectedRunId, controller.signal);
        if (!active || !mountedRef.current || controller.signal.aborted) return;
        setRunEvidence(res.evidence);
        setAuthoritativeTaskRegistered(res.authoritativeTaskRegistered);
        setRunsLoadError(null);

        if (res.evidence && (res.evidence.run.status === 'pending' || res.evidence.run.status === 'running')) {
          pollTimer = setTimeout(() => {
            if (active && mountedRef.current && !controller.signal.aborted) {
              void loadRuns(false);
            }
          }, 2500);
        }
      } catch (err: any) {
        if (!active || !mountedRef.current || controller.signal.aborted || err?.name === 'AbortError') {
          return;
        }
        setRunsLoadError(err?.message || 'Failed to load run and verification evidence.');
      } finally {
        if (active && mountedRef.current && !controller.signal.aborted && isInitial) {
          setIsLoadingRuns(false);
        }
      }
    };

    void loadRuns(true);

    return () => {
      active = false;
      controller.abort();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [projectId, task.id, selectedRunId, runRefreshKey]);

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

  const handleStatusChange = async (newStatus: TaskStatus) => {
    if (newStatus === task.status || isTransitioningStatus || !onUpdateTaskStatus) return;
    setIsTransitioningStatus(true);
    try {
      await onUpdateTaskStatus(task.id, newStatus);
    } finally {
      if (mountedRef.current) setIsTransitioningStatus(false);
    }
  };

  // Run agent execution step on this task
  const handleRunAgent = async () => {
    if (!assignee) return;
    await onExecuteAgentOnTask(task, assignee);
  };

  const renderRegistrationControl = (buttonTestId: string) => (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {onRegisterTask && (
          <button
            type="button"
            data-testid={buttonTestId}
            disabled={isRegisteringTask}
            onClick={async () => {
              setRegistrationError(null);
              setRegistrationCode(null);
              setIsRegisteringTask(true);
              try {
                const res = await onRegisterTask(task.id);
                if (!res.ok && mountedRef.current) {
                  setRegistrationCode(res.code || null);
                  setRegistrationError(res.error || 'Task registration failed.');
                }
              } finally {
                if (mountedRef.current) setIsRegisteringTask(false);
              }
            }}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50"
          >
            {isRegisteringTask ? 'Registering...' : 'Register and Return to To Do'}
          </button>
        )}
        {registrationCode === 'REPOSITORY_CONFIGURATION_REQUIRED' && onOpenProjectSettings && (
          <button
            type="button"
            data-testid="open-project-settings-from-task-btn"
            onClick={() => {
              onClose();
              onOpenProjectSettings();
            }}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold"
          >
            Open Project Settings
          </button>
        )}
      </div>
      {registrationError && (
        <p data-testid="task-registration-error" className="text-[11px] text-rose-300">
          {registrationError}
        </p>
      )}
    </>
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-5 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Task ${task.key} details`}
        data-testid="task-detail-modal"
        className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full shadow-2xl overflow-hidden my-auto flex flex-col max-h-[92vh]"
      >
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
              <label htmlFor="task-detail-status-select" className="text-[10px] uppercase font-bold text-slate-400 block mb-1">
                Status
              </label>
              <select
                id="task-detail-status-select"
                data-testid="task-detail-status-select"
                value={task.status}
                disabled={isTransitioningStatus}
                onChange={(e) => handleStatusChange(e.target.value as TaskStatus)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-semibold disabled:opacity-60"
              >
                <option value="backlog">Backlog</option>
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="review">Review & QA (Requires Passing Verification)</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done (Requires Verified Delivery & Approval)</option>
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
              <div className="flex items-center space-x-2">
                {assignee && <AgentAvatar agent={assignee} size={28} />}
                <select
                  value={task.assignedAgentId}
                  onChange={(e) => onUpdateTask({ ...task, assignedAgentId: e.target.value })}
                  className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.role.split(' ')[0]})
                    </option>
                  ))}
                </select>
              </div>
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

          {task.workerConfig?.provider === 'openai' && openAIConfigured === false && onOpenAppSettings && (
            <div
              data-testid="openai-worker-credential-warning"
              className="p-3 rounded-xl border bg-amber-950/30 border-amber-800/60 text-amber-200 text-xs flex flex-wrap items-center justify-between gap-2"
            >
              <span>No OpenAI API key is configured on this server for OpenAI coding workers.</span>
              <button
                type="button"
                data-testid="open-app-settings-from-task-btn"
                onClick={() => {
                  onClose();
                  onOpenAppSettings();
                }}
                className="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-semibold"
              >
                Configure OpenAI in Application Settings
              </button>
            </div>
          )}

          {/* Task Identity Conflict Recovery */}
          {task.identityConflict && (
            <div
              data-testid="task-identity-conflict-banner"
              className="p-3.5 rounded-xl border bg-amber-950/45 border-amber-700/70 text-amber-100 text-xs space-y-2"
            >
              <div className="font-bold uppercase tracking-wider text-amber-300">
                Identity Conflict Detected ({task.identityConflict.variantCount} variants for {task.key})
              </div>
              <p className="text-[11px] text-amber-100/90 leading-relaxed">
                Multiple conflicting board copies share ID <span className="font-mono">{task.id}</span>. Choose which
                preserved variant to keep before registering or transitioning this task.
              </p>
              <div className="space-y-2">
                {task.identityConflict.variants.map((variant, idx) => (
                  <div
                    key={idx}
                    className="p-2.5 rounded-lg bg-slate-950/80 border border-amber-800/50 flex flex-wrap items-center justify-between gap-2"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="font-semibold text-slate-100">
                        Variant {idx + 1}: {String(variant.title || task.title)} ({String(variant.status || 'unknown')})
                      </div>
                      {variant.description ? (
                        <div className="text-[11px] text-slate-400 truncate">
                          {String(variant.description)}
                        </div>
                      ) : null}
                    </div>
                    {onResolveIdentityConflict && (
                      <button
                        type="button"
                        data-testid={`resolve-conflict-variant-${idx}`}
                        disabled={isRegisteringTask}
                        onClick={() => void onResolveIdentityConflict(task.id, idx)}
                        className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-semibold"
                      >
                        Use Variant {idx + 1}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Persistent Authoritative Transition Refusal */}
          {transitionFeedback && (
            <div
              data-testid="task-transition-refusal"
              className="p-3.5 rounded-xl border bg-rose-950/40 border-rose-800/70 text-rose-200 text-xs space-y-1"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-bold uppercase tracking-wider flex items-center gap-1.5 text-rose-300">
                  <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>Transition to {transitionFeedback.targetStatus.toUpperCase()} Blocked</span>
                </span>
                {transitionFeedback.reason && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-rose-900/50 border border-rose-700/50 text-rose-200">
                    {transitionFeedback.reason}
                  </span>
                )}
              </div>
              <p className="leading-relaxed text-rose-100">{transitionFeedback.message}</p>
              {transitionFeedback.reason === 'unregistered-task' ? (
                <div className="pt-1.5 space-y-2">
                  <p className="text-[11px] text-rose-200/90">
                    This task has no authoritative execution record. Registering will move it to To Do. Fresh
                    execution and verification are required before Review.
                  </p>
                  {renderRegistrationControl('register-authoritative-task-btn')}
                </div>
              ) : transitionFeedback.nextAction === 'execute_agent_step' ? (
                <p className="text-[11px] text-rose-200/90">
                  Authoritative status remains <span className="font-mono font-semibold">{task.status}</span>. Next
                  action: run <span className="font-semibold">Execute Agent Step on This Task</span> below to generate
                  fresh passing verification evidence.
                </p>
              ) : (transitionFeedback.nextAction === 'approve_and_deliver' || transitionFeedback.targetStatus === 'done') && (
                <p className="text-[11px] text-rose-200/90">
                  Authoritative status remains <span className="font-mono font-semibold">{task.status}</span>. Move to
                  Done is separate from <span className="font-semibold">Approve Review</span> and{' '}
                  <span className="font-semibold">Deliver PR</span>: inspect <span className="font-semibold">Runs &amp; Evidence</span>{' '}
                  below, click <span className="font-semibold">Approve Review</span>, then click{' '}
                  <span className="font-semibold">Push &amp; Create PR</span> (or{' '}
                  <span className="font-semibold">Approve &amp; Deliver PR</span>).
                </p>
              )}
            </div>
          )}

          {/* Persistent Execute Agent Step Outcome */}
          {lastExecutionInfo && (
            <div
              data-testid="task-execution-status-banner"
              className={`p-3 rounded-xl border text-xs space-y-1 ${
                lastExecutionInfo.status === 'succeeded'
                  ? 'bg-emerald-950/30 border-emerald-800/60 text-emerald-200'
                  : 'bg-amber-950/30 border-amber-800/60 text-amber-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-semibold">
                  {lastExecutionInfo.status === 'succeeded'
                    ? 'Last Agent Step Recorded'
                    : 'Last Agent Step Blocked / Failed'}
                </span>
                {lastExecutionInfo.runId && (
                  <span className="font-mono text-[10px] text-slate-300" data-testid="task-execution-run-id">
                    Run: {lastExecutionInfo.runId}
                  </span>
                )}
              </div>
              <p className="text-[11px]">{lastExecutionInfo.message}</p>
              {onOpenAppSettings &&
                task.workerConfig?.provider === 'openai' &&
                /No OpenAI API key|OPENAI_API_KEY|OpenAI.*not configured/i.test(lastExecutionInfo.message) && (
                  <div className="pt-1">
                    <button
                      type="button"
                      data-testid="open-app-settings-from-task-btn"
                      onClick={() => {
                        onClose();
                        onOpenAppSettings();
                      }}
                      className="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-semibold"
                    >
                      Configure OpenAI in Application Settings
                    </button>
                  </div>
                )}
            </div>
          )}

          {/* Honest Review & QA Semantics + Operator Review & Delivery Controls */}
          {(task.status === 'review' || runEvidence?.verification || runEvidence?.delivery) && (
            <div
              data-testid="task-review-honest-notice"
              className="p-3.5 rounded-xl border bg-amber-950/25 border-amber-800/50 text-amber-100 text-xs space-y-2.5"
            >
              <div className="font-semibold text-amber-300 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Review &amp; QA Decision &amp; PR Delivery</span>
              </div>
              {runEvidence?.verification?.passed ? (
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  Automated verification <span className="font-semibold text-emerald-300">passed</span> for candidate revision{' '}
                  <span className="font-mono">{runEvidence.verification.revisionSha.slice(0, 12)}</span>. Human review/approval and external PR delivery are separate steps.
                </p>
              ) : (
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  Task is in Review &amp; QA, but passing verification evidence is not currently recorded for the latest run. Human approval and PR delivery remain separate steps.
                </p>
              )}

              {runEvidence?.delivery && (
                <div
                  data-testid="run-delivery-status"
                  className="p-2.5 rounded-lg bg-emerald-950/35 border border-emerald-800/60 text-emerald-100 text-[11px] space-y-1"
                >
                  <div className="font-semibold text-emerald-300">
                    Delivery Recorded ({runEvidence.delivery.approvalStatus})
                  </div>
                  {runEvidence.delivery.prUrl && (
                    <div>
                      PR:{' '}
                      <a
                        href={runEvidence.delivery.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline font-mono text-emerald-200 break-all"
                      >
                        {runEvidence.delivery.prUrl}
                      </a>
                    </div>
                  )}
                  <div className="font-mono text-[10px] text-slate-300">
                    Branch: {runEvidence.delivery.branch} • Commit: {runEvidence.delivery.deliveredCommit.slice(0, 12)}
                  </div>
                </div>
              )}

              {runEvidence?.unresolvedReviewFeedback && runEvidence.unresolvedReviewFeedback.length > 0 && (
                <div
                  data-testid="task-unresolved-review-feedback"
                  className="p-2.5 rounded-lg bg-amber-950/50 border border-amber-700/60 text-amber-100 text-[11px] space-y-1"
                >
                  <div className="font-semibold text-amber-300">
                    Unresolved Operator Change Requests ({runEvidence.unresolvedReviewFeedback.length})
                  </div>
                  {runEvidence.unresolvedReviewFeedback.map((fb) => (
                    <div key={fb.id} className="text-[11px] text-slate-200">
                      <span className="font-mono text-amber-300">[{fb.revisionSha.slice(0, 10)}]</span>{' '}
                      {fb.comment || 'Changes requested.'}
                    </div>
                  ))}
                </div>
              )}

              {runEvidence?.reviewDecisions && runEvidence.reviewDecisions.length > 0 && (
                <div
                  data-testid="run-review-decisions"
                  className="p-2 rounded-lg bg-slate-950/70 border border-slate-800 text-[11px] space-y-1"
                >
                  <div className="font-semibold text-slate-300">
                    Review History ({runEvidence.reviewDecisions.length})
                  </div>
                  {runEvidence.reviewDecisions.map((rev) => (
                    <div key={rev.id} className="text-[10px] text-slate-300">
                      <span className="font-mono uppercase text-amber-300">{rev.decision}</span> by {rev.actor} on{' '}
                      <span className="font-mono">{rev.revisionSha.slice(0, 10)}</span>
                      {rev.comment ? `: ${rev.comment}` : ''}
                    </div>
                  ))}
                </div>
              )}

              {task.status === 'review' && runEvidence?.verification?.passed && !runEvidence.verification.revokedAt && runEvidence?.run && (onReviewTask || onDeliverRun) && (() => {
                const ver = runEvidence.verification;
                const candidateBinding =
                  ver.requirementsFingerprint && ver.verificationConfigFingerprint && ver.evidenceBindingVersion
                    ? {
                        runId: runEvidence.run.id,
                        verificationId: ver.id,
                        revisionSha: ver.revisionSha,
                        requirementsFingerprint: ver.requirementsFingerprint,
                        verificationConfigFingerprint: ver.verificationConfigFingerprint,
                        evidenceBindingVersion: ver.evidenceBindingVersion,
                      }
                    : null;
                if (!candidateBinding) return null;
                return (
                <div className="space-y-2 pt-1 border-t border-amber-800/40">
                  <textarea
                    data-testid="review-feedback-input"
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    rows={2}
                    placeholder="Optional review note or feedback when requesting changes..."
                    className="w-full bg-slate-950/90 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />

                  {showApprovalTokenField ? (
                    <input
                      data-testid="review-approval-token-input"
                      type="password"
                      value={approvalTokenInput}
                      onChange={(e) => setApprovalTokenInput(e.target.value)}
                      placeholder="Operator approval token (X-Dupond-Approval-Token)"
                      className="w-full bg-slate-950/90 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowApprovalTokenField(true)}
                      className="text-[10px] text-slate-400 hover:text-slate-200 underline"
                    >
                      Provide approval token (if configured)
                    </button>
                  )}

                  {reviewActionError && (
                    <p
                      data-testid="review-delivery-error"
                      className="text-[11px] text-rose-300 bg-rose-950/40 border border-rose-800/60 rounded-lg p-2"
                    >
                      {reviewActionError}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {onDeliverRun && (
                      <button
                        type="button"
                        data-testid="approve-deliver-pr-btn"
                        disabled={isSubmittingReviewOrDelivery}
                        onClick={async () => {
                          setReviewActionError(null);
                          setIsSubmittingReviewOrDelivery(true);
                          try {
                            const res = await onDeliverRun(task.id, runEvidence.run.id, true, approvalTokenInput, candidateBinding);
                            if (!res.ok) {
                              if (res.code === 'APPROVAL_CREDENTIAL_REQUIRED') {
                                setShowApprovalTokenField(true);
                              }
                              setReviewActionError(res.error || 'Delivery failed.');
                            }
                          } finally {
                            if (mountedRef.current) setIsSubmittingReviewOrDelivery(false);
                          }
                        }}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-50"
                      >
                        Approve &amp; Deliver PR
                      </button>
                    )}

                    {onReviewTask && !localReviewApproved && (
                      <button
                        type="button"
                        data-testid="approve-review-btn"
                        disabled={isSubmittingReviewOrDelivery}
                        onClick={async () => {
                          setReviewActionError(null);
                          setIsSubmittingReviewOrDelivery(true);
                          try {
                            const res = await onReviewTask(task.id, 'approve', candidateBinding, reviewComment, approvalTokenInput);
                            if (!res.ok) {
                              if (res.code === 'APPROVAL_CREDENTIAL_REQUIRED') {
                                setShowApprovalTokenField(true);
                              }
                              setReviewActionError(res.error || 'Approval failed.');
                            } else {
                              setLocalReviewApproved(true);
                            }
                          } finally {
                            if (mountedRef.current) setIsSubmittingReviewOrDelivery(false);
                          }
                        }}
                        className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-50"
                      >
                        Approve Review
                      </button>
                    )}

                    {localReviewApproved && onDeliverRun && (
                      <button
                        type="button"
                        data-testid="deliver-pr-btn"
                        disabled={isSubmittingReviewOrDelivery}
                        onClick={async () => {
                          setReviewActionError(null);
                          setIsSubmittingReviewOrDelivery(true);
                          try {
                            const res = await onDeliverRun(task.id, runEvidence.run.id, true, approvalTokenInput, candidateBinding);
                            if (!res.ok) {
                              if (res.code === 'APPROVAL_CREDENTIAL_REQUIRED') {
                                setShowApprovalTokenField(true);
                              }
                              setReviewActionError(res.error || 'Delivery failed.');
                            }
                          } finally {
                            if (mountedRef.current) setIsSubmittingReviewOrDelivery(false);
                          }
                        }}
                        className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
                      >
                        Push &amp; Create PR
                      </button>
                    )}

                    {onReviewTask && (
                      <button
                        type="button"
                        data-testid="request-changes-btn"
                        disabled={isSubmittingReviewOrDelivery}
                        onClick={async () => {
                          setReviewActionError(null);
                          setIsSubmittingReviewOrDelivery(true);
                          try {
                            const res = await onReviewTask(task.id, 'request_changes', candidateBinding, reviewComment);
                            if (!res.ok) {
                              setReviewActionError(res.error || 'Request changes failed.');
                            } else {
                              setLocalReviewApproved(false);
                              setReviewComment('');
                            }
                          } finally {
                            if (mountedRef.current) setIsSubmittingReviewOrDelivery(false);
                          }
                        }}
                        className="px-3 py-1.5 rounded-lg bg-amber-700/80 hover:bg-amber-600 text-white text-xs font-semibold disabled:opacity-50"
                      >
                        Request Changes
                      </button>
                    )}
                  </div>
                </div>
                );
              })()}
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

          {/* Authoritative Runs & Evidence Section (Read-Only) */}
          <div className="space-y-3 pt-2 border-t border-slate-800/80" data-testid="task-runs-evidence-section">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-1.5">
                <GitBranch className="w-4 h-4 text-indigo-400" />
                <span>Runs &amp; Evidence</span>
              </h4>
              {runEvidence?.runs && runEvidence.runs.length > 1 && (
                <select
                  aria-label="Select recorded run"
                  data-testid="run-history-select"
                  value={runEvidence.run.id}
                  onChange={(e) => setSelectedRunId(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg text-[11px] font-mono text-slate-200 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  {runEvidence.runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id} ({r.status})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {isLoadingRuns ? (
              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-400 flex items-center gap-2">
                <RotateCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                <span>Loading authoritative run history...</span>
              </div>
            ) : runsLoadError ? (
              <div
                data-testid="task-runs-error"
                className="p-3 rounded-lg bg-rose-950/40 border border-rose-800/60 text-xs text-rose-200"
              >
                {runsLoadError}
              </div>
            ) : !runEvidence ? (
              authoritativeTaskRegistered === false ? (
                <div
                  data-testid="unregistered-task-state"
                  className="p-3.5 rounded-lg bg-amber-950/35 border border-amber-800/60 text-xs text-amber-100 space-y-2"
                >
                  <p className="font-semibold text-amber-300">
                    Unregistered Board Task (Missing Authoritative Record)
                  </p>
                  <p className="text-[11px] text-amber-100/90 leading-relaxed">
                    This task has no authoritative execution record. Registering will move it to To Do. Fresh
                    execution and verification are required before Review.
                  </p>
                  {renderRegistrationControl('runs-register-authoritative-task-btn')}
                </div>
              ) : (
                <div
                  data-testid="task-no-runs-state"
                  className="p-3 rounded-lg bg-slate-950/60 border border-slate-800 text-xs text-slate-300 space-y-1.5"
                >
                  <p className="font-semibold text-slate-200">
                    No runs or verification evidence recorded for this task yet.
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Missing requirement: passing authoritative run verification. Next action: click{' '}
                    <span className="font-semibold text-indigo-300">Execute Agent Step on This Task</span> below.
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Run ID: Not recorded · Candidate Revision: Not recorded · Verification: Not available
                  </p>
                </div>
              )
            ) : (
              <div className="space-y-3">
                {/* Run Metadata Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px]">
                  <div>
                    <span className="text-slate-500 block">Run ID</span>
                    <span className="font-mono text-slate-200 break-all" data-testid="run-id-value">
                      {runEvidence.run.id}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Project / Task</span>
                    <span className="font-mono text-slate-200 break-all">
                      {runEvidence.run.projectId} / {runEvidence.run.taskId}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Run Status</span>
                    <span
                      data-testid="run-status-value"
                      className={`inline-block font-semibold uppercase text-[10px] px-1.5 py-0.5 rounded border ${
                        runEvidence.run.status === 'completed'
                          ? 'bg-emerald-950/50 border-emerald-800 text-emerald-300'
                          : runEvidence.run.status === 'failed'
                            ? 'bg-rose-950/50 border-rose-800 text-rose-300'
                            : 'bg-amber-950/50 border-amber-800 text-amber-300'
                      }`}
                    >
                      {runEvidence.run.status}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Provider / Model</span>
                    <span className="font-mono text-slate-200">
                      {runEvidence.evidence.provider || 'Not recorded'} / {runEvidence.evidence.model || 'Not available'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Attempts</span>
                    <span className="font-mono text-slate-200">
                      {runEvidence.attempts.length} (current #{runEvidence.run.currentAttempt})
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Timestamps</span>
                    <span className="font-mono text-slate-300">
                      {new Date(runEvidence.run.createdAt).toLocaleString()} → {new Date(runEvidence.run.updatedAt).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Target Repository</span>
                    <span className="font-mono text-slate-200 break-all">
                      {runEvidence.evidence.targetRepo || 'Not recorded'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Target Branch</span>
                    <span className="font-mono text-slate-200 break-all">
                      {runEvidence.evidence.targetBranch || 'Not recorded'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Base Commit</span>
                    <span className="font-mono text-slate-200 break-all">
                      {runEvidence.evidence.baseCommit || 'Not recorded'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Candidate Revision</span>
                    <span className="font-mono text-slate-200 break-all" data-testid="run-candidate-revision">
                      {runEvidence.evidence.candidateRevision || 'Not recorded'}
                    </span>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-slate-500 block">Delivery / PR Reference</span>
                    <span className="font-mono text-slate-200 break-all" data-testid="run-delivery-ref">
                      {runEvidence.delivery?.prUrl
                        ? `${runEvidence.delivery.prUrl} (${runEvidence.delivery.approvalStatus})`
                        : runEvidence.delivery
                          ? `Recorded (${runEvidence.delivery.approvalStatus})`
                          : 'Not recorded'}
                    </span>
                  </div>
                </div>

                {/* Failure / Blocker Reason */}
                {(runEvidence.run.failureReason || runEvidence.verification?.failureReason) && (
                  <div
                    data-testid="run-failure-reason"
                    className="p-3 rounded-xl bg-rose-950/35 border border-rose-800/60 text-xs text-rose-200 space-y-1"
                  >
                    <span className="font-semibold text-rose-300 block">Run Failure / Blocker Reason</span>
                    <p className="whitespace-pre-wrap break-words">
                      {runEvidence.run.failureReason || runEvidence.verification?.failureReason}
                    </p>
                  </div>
                )}

                {/* Attempts */}
                <div className="space-y-1.5" data-testid="run-attempts-list">
                  <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Attempts ({runEvidence.attempts.length})
                  </h5>
                  {runEvidence.attempts.length === 0 ? (
                    <p className="text-xs text-slate-500 italic">No attempts recorded.</p>
                  ) : (
                    runEvidence.attempts.map((attempt) => {
                      const isVerifiedAttempt =
                        Boolean(runEvidence.verification?.passed) &&
                        runEvidence.verification?.runId === runEvidence.run.id &&
                        runEvidence.verification?.attemptId === attempt.id;
                      return (
                        <div
                          key={attempt.id}
                          className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] space-y-1.5"
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="font-mono font-semibold text-slate-200">
                              Attempt #{attempt.attemptNumber} · {attempt.workerType}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`text-[10px] px-1.5 py-0.5 rounded border ${
                                  isVerifiedAttempt
                                    ? 'bg-cyan-950/50 border-cyan-800 text-cyan-300'
                                    : 'bg-slate-900 border-slate-700 text-slate-400'
                                }`}
                              >
                                {isVerifiedAttempt ? 'Verified attempt' : 'Unverified attempt evidence'}
                              </span>
                              <span
                                className={`font-semibold uppercase text-[10px] px-1.5 py-0.5 rounded ${
                                  attempt.status === 'succeeded'
                                    ? 'bg-emerald-950/50 text-emerald-300'
                                    : attempt.status === 'failed' || attempt.status === 'timeout'
                                      ? 'bg-rose-950/50 text-rose-300'
                                      : 'bg-amber-950/50 text-amber-300'
                                }`}
                              >
                                {attempt.status} ({attempt.durationMs}ms)
                              </span>
                            </div>
                          </div>
                        {attempt.errorMessage && (
                          <p className="text-rose-300 whitespace-pre-wrap break-words">{attempt.errorMessage}</p>
                        )}
                        {attempt.logs && (
                          <pre className="bg-slate-900/80 border border-slate-800 rounded p-2 text-[10px] font-mono text-slate-300 whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto">
                            {attempt.logs}
                          </pre>
                        )}
                      </div>
                      );
                    })
                  )}
                </div>

                {/* Verification Outcomes & Checks */}
                <div className="space-y-1.5" data-testid="run-verification-checks">
                  <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Verification Commands &amp; Results</span>
                  </h5>
                  {!runEvidence.verification ? (
                    <p className="text-xs text-slate-500 italic">Verification record: Not available.</p>
                  ) : (
                    <div className="space-y-2 p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px]">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className={runEvidence.verification.passed ? 'text-emerald-300 font-semibold' : 'text-rose-300 font-semibold'}>
                          {runEvidence.verification.passed ? 'Verification Passed' : 'Verification Failed'}
                        </span>
                        <span className="font-mono text-[10px] text-slate-400">
                          {new Date(runEvidence.verification.verifiedAt).toLocaleString()}
                        </span>
                      </div>
                      {runEvidence.verification.checks.map((chk, idx) => (
                        <div key={idx} className="p-2 rounded bg-slate-900/70 border border-slate-800 space-y-1">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <code className="text-[11px] text-slate-200 break-all">{chk.command}</code>
                            <span className={`font-mono text-[10px] ${chk.passed ? 'text-emerald-300' : 'text-rose-300'}`}>
                              exit {chk.exitCode} · {chk.durationMs}ms
                            </span>
                          </div>
                          {chk.stdout && (
                            <pre className="text-[10px] font-mono text-slate-300 whitespace-pre-wrap overflow-x-auto max-h-28 overflow-y-auto">
                              {chk.stdout}
                            </pre>
                          )}
                          {chk.stderr && (
                            <pre className="text-[10px] font-mono text-rose-300 whitespace-pre-wrap overflow-x-auto max-h-28 overflow-y-auto">
                              {chk.stderr}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Read-Only Candidate Changes & Diff */}
                <div className="space-y-1.5" data-testid="run-candidate-diff-section">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h5 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Candidate Changes &amp; Diff
                    </h5>
                    <span className="font-mono text-[10px] text-slate-500">
                      Source: {runEvidence.evidence.provenance}
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2 text-[11px]">
                    <div>
                      <span className="text-slate-500 block mb-1">Changed Files</span>
                      {runEvidence.evidence.changedFiles.length > 0 ? (
                        <ul className="space-y-0.5 font-mono text-slate-200" data-testid="run-changed-files">
                          {runEvidence.evidence.changedFiles.map((f) => (
                            <li key={f} className="break-all">
                              {f}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-slate-500 italic">Not recorded</span>
                      )}
                    </div>

                    {runEvidence.evidence.candidateDiffStatus === 'available' && runEvidence.evidence.candidateDiff !== null ? (
                      <div className="space-y-1">
                        {runEvidence.evidence.candidateDiffTruncated && (
                          <span className="text-[10px] text-amber-300 block">
                            Diff truncated to safe display size.
                          </span>
                        )}
                        <pre
                          data-testid="run-candidate-diff"
                          className="bg-slate-900/90 border border-slate-800 rounded p-2.5 text-[11px] font-mono text-slate-200 whitespace-pre overflow-x-auto max-h-60 overflow-y-auto"
                        >
                          {runEvidence.evidence.candidateDiff}
                        </pre>
                      </div>
                    ) : (
                      <p
                        data-testid="run-candidate-diff-unavailable"
                        className="text-xs text-amber-200/90 bg-amber-950/30 border border-amber-800/50 rounded p-2"
                      >
                        {runEvidence.evidence.candidateDiffUnavailableReason || 'Candidate diff is not available.'}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
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
                <AgentAvatar agent={assignee} size={24} />
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
