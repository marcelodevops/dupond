import React, { useState, useEffect, useRef } from 'react';
import { 
  Task, 
  Agent, 
  Epic, 
  TaskStatus, 
  OrchestratorConfig, 
  IntegrationConfig, 
  CommunicationMessage 
} from './types';
import { 
  DEFAULT_AGENTS, 
  DEFAULT_EPICS, 
  DEFAULT_TASKS, 
  DEFAULT_ORCHESTRATOR_CONFIG, 
  DEFAULT_INTEGRATION_CONFIG, 
  DEFAULT_COMMUNICATIONS,
  SAMPLE_PLANS 
} from './data/defaultData';
import { Header } from './components/Header';
import { KanbanBoard } from './components/KanbanBoard';
import { DiagramsProgress } from './components/DiagramsProgress';
import { ResourceAllocationMatrix } from './components/ResourceAllocationMatrix';
import { StakeholderReports } from './components/StakeholderReports';
import { OrchestratorStudio } from './components/OrchestratorStudio';
import { IntegrationsView } from './components/IntegrationsView';
import { PlanIngestionModal } from './components/PlanIngestionModal';
import { TaskDetailModal } from './components/TaskDetailModal';
import { AddTaskModal } from './components/AddTaskModal';
import { Sparkles, Bot, AlertCircle, CheckCircle, Bell, Lock } from 'lucide-react';
import { apiFetch, getApiToken, isAuthRequired, onAuthStateChange, setApiToken } from './lib/api';
import { ProjectProvider, useProject } from './context/ProjectContext';
import { ProjectWizardModal } from './components/ProjectWizardModal';
import { ProjectLifecycleModal } from './components/ProjectLifecycleModal';
import { getActiveProjectId } from './lib/projectApi';

function AppWorkspace() {
  const {
    currentProject,
    isArchived,
    isSwitchingProject,
    openResetModal,
    isCreateWizardOpen,
    setIsCreateWizardOpen,
  } = useProject();

  const [activeTab, setActiveTab] = useState<string>('kanban');
  const [customPlanTitle, setCustomPlanTitle] = useState<string | null>(null);
  const projectTitle = customPlanTitle || currentProject?.name || SAMPLE_PLANS[0].title;
  const [cycleCount, setCycleCount] = useState<number>(5);
  const [isRunningAuto, setIsRunningAuto] = useState<boolean>(false);
  const [isProcessingStep, setIsProcessingStep] = useState<boolean>(false);
  const [activeProcessingTaskId, setActiveProcessingTaskId] = useState<string | undefined>(undefined);

  // Load state from localStorage or default
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      const saved = localStorage.getItem('dupond_tasks');
      return saved ? JSON.parse(saved) : DEFAULT_TASKS;
    } catch {
      return DEFAULT_TASKS;
    }
  });

  const [agents, setAgents] = useState<Agent[]>(() => {
    try {
      const saved = localStorage.getItem('dupond_agents');
      return saved ? JSON.parse(saved) : DEFAULT_AGENTS;
    } catch {
      return DEFAULT_AGENTS;
    }
  });

  const [epics, setEpics] = useState<Epic[]>(() => {
    try {
      const saved = localStorage.getItem('dupond_epics');
      return saved ? JSON.parse(saved) : DEFAULT_EPICS;
    } catch {
      return DEFAULT_EPICS;
    }
  });

  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig>(() => {
    try {
      const saved = localStorage.getItem('dupond_orchestrator_config');
      return saved ? JSON.parse(saved) : DEFAULT_ORCHESTRATOR_CONFIG;
    } catch {
      return DEFAULT_ORCHESTRATOR_CONFIG;
    }
  });

  const [integrationConfig, setIntegrationConfig] = useState<IntegrationConfig>(() => {
    try {
      const saved = localStorage.getItem('dupond_integration_config');
      return saved ? JSON.parse(saved) : DEFAULT_INTEGRATION_CONFIG;
    } catch {
      return DEFAULT_INTEGRATION_CONFIG;
    }
  });

  const [communications, setCommunications] = useState<CommunicationMessage[]>(() => {
    try {
      const saved = localStorage.getItem('dupond_communications');
      return saved ? JSON.parse(saved) : DEFAULT_COMMUNICATIONS;
    } catch {
      return DEFAULT_COMMUNICATIONS;
    }
  });

  // Server-authoritative state synchronization (survives browser close)
  useEffect(() => {
    let isCancelled = false;
    const fetchServerState = async () => {
      if (isAuthRequired()) return;
      const capturedProjectId = currentProject?.id || getActiveProjectId();
      try {
        const res = await apiFetch('/api/orchestrate/state');
        if (res.ok) {
          const data = await res.json();
          // Verify response is not stale and still belongs to the currently active project
          if (!isCancelled && capturedProjectId === (currentProject?.id || getActiveProjectId())) {
            if (Array.isArray(data.tasks)) setTasks(data.tasks);
            if (Array.isArray(data.agents)) setAgents(data.agents);
            if (Array.isArray(data.epics)) setEpics(data.epics);
            if (Array.isArray(data.communications)) setCommunications(data.communications);
            if (typeof data.daemonRunning === 'boolean') setIsRunningAuto(data.daemonRunning);
            if (typeof data.cycleCount === 'number') setCycleCount(data.cycleCount);
          }
        }
      } catch (err) {
        console.warn('Server state sync error:', err);
      }
    };

    fetchServerState();
    const syncInterval = setInterval(fetchServerState, 3500);
    return () => {
      isCancelled = true;
      clearInterval(syncInterval);
    };
  }, [currentProject?.id]);

  // Push local updates to server-authoritative state
  const syncToServer = async (partialState: any) => {
    if (isArchived) {
      showToast('Project is Archived', 'Archived projects are read-only. Task modifications cannot be saved.', 'alert');
      return;
    }
    try {
      const res = await apiFetch('/api/orchestrate/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partialState),
      });
      if (!res.ok) {
        const detail = res.status === 401
          ? 'the API rejected the stored token'
          : `server responded ${res.status}`;
        showToast('Changes Not Saved', `Board updates are local only — ${detail}.`, 'alert');
      }
    } catch (e) {
      showToast('Changes Not Saved', 'Could not reach the Dupond API; board updates are local only.', 'alert');
    }
  };

  // Modals state
  const [selectedTaskForModal, setSelectedTaskForModal] = useState<Task | null>(null);
  const [isIngestModalOpen, setIsIngestModalOpen] = useState<boolean>(false);
  const [isAddTaskModalOpen, setIsAddTaskModalOpen] = useState<boolean>(false);

  // Toast Notification state
  const [toastMessage, setToastMessage] = useState<{ title: string; desc: string; type: 'info' | 'success' | 'alert' } | null>(null);

  const showToast = (title: string, desc: string, type: 'info' | 'success' | 'alert' = 'info') => {
    setToastMessage({ title, desc, type });
    setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  };

  // A 401 means the board has no server backing, so it is surfaced instead of
  // falling back to the bundled seed data.
  const [authRequired, setAuthRequired] = useState<boolean>(() => isAuthRequired());
  const [tokenDraft, setTokenDraft] = useState<string>(() => getApiToken() ?? '');

  useEffect(() => onAuthStateChange(setAuthRequired), []);

  const handleConnect = () => {
    setApiToken(tokenDraft);
    showToast('Token stored', 'Re-syncing with the server…', 'info');
  };

  // Execute single agent step on a specific task
  const executeAgentStep = async (targetTask: Task, activeAgent: Agent) => {
    setIsProcessingStep(true);
    setActiveProcessingTaskId(targetTask.id);

    try {
      const response = await apiFetch('/api/orchestrate/agent-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: targetTask,
          agent: activeAgent,
          orchestratorConfig,
          communicationHistory: communications,
        }),
      });

      const result = await response.json();

      // Check HTTP status and blocked response: DO NOT treat blocked execution as progress
      if (!response.ok || !result.success || result.blocked) {
        showToast(
          'Execution Blocked',
          result.error || `Task execution blocked: No capable worker or quality gate failed for ${targetTask.key}.`,
          'alert'
        );
        return;
      }

      // Update Task status & deliverables only on verified success
      const nextStatus = result.nextStatus || (targetTask.status === 'in_progress' ? 'review' : 'done');
      const newDeliverables = result.deliverableOutput
        ? [...(targetTask.deliverables || []), result.deliverableOutput]
        : targetTask.deliverables || [];

      // Update subtasks completed
      const updatedSubtasks = (targetTask.subtasks || []).map((st) => {
        if (result.subtasksCompleted && result.subtasksCompleted.includes(st.id)) {
          return { ...st, completed: true };
        }
        return st;
      });

      const updatedTask: Task = {
        ...targetTask,
        status: nextStatus,
        deliverables: newDeliverables,
        subtasks: updatedSubtasks,
        spentHours: (targetTask.spentHours || 0) + 2,
        lastAgentComment: `${activeAgent.name}: ${result.actionTaken || 'Advanced task stage'}`,
        lastUpdated: 'Just now',
      };

      setTasks((prev) => prev.map((t) => (t.id === targetTask.id ? updatedTask : t)));

      // If modal is open for this task, sync modal view
      if (selectedTaskForModal && selectedTaskForModal.id === targetTask.id) {
        setSelectedTaskForModal(updatedTask);
      }

      // Update Agent role and dynamic history
      if (result.roleAssumed) {
        setAgents((prev) =>
          prev.map((a) => {
            if (a.id === activeAgent.id) {
              const newHistory = [
                ...(a.dynamicRoleHistory || []),
                {
                  role: result.roleAssumed,
                  taskKey: targetTask.key,
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                },
              ];
              return {
                ...a,
                role: result.roleAssumed,
                dynamicRoleHistory: newHistory,
                completedTasksCount: nextStatus === 'done' ? a.completedTasksCount + 1 : a.completedTasksCount,
              };
            }
            return a;
          })
        );
      }

      // Append inter-agent message
      if (result.communicationMessage) {
        const newComm: CommunicationMessage = {
          id: `comm-${Date.now()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          senderId: activeAgent.id,
          senderName: activeAgent.name,
          senderRole: result.roleAssumed || activeAgent.role,
          recipientId: 'all',
          content: result.communicationMessage.content,
          messageType: result.communicationMessage.messageType || 'status_update',
          taskId: targetTask.key,
        };
        setCommunications((prev) => [newComm, ...prev]);
      }

      setCycleCount((c) => c + 1);

      showToast(
        `${activeAgent.name} • ${targetTask.key}`,
        `Advanced to ${nextStatus.toUpperCase()}. ${result.roleAssumed ? `Assumed role: ${result.roleAssumed}` : ''}`,
        'success'
      );

      // Auto Jira / Slack sync if enabled
      if (orchestratorConfig.autoJiraSync) {
        apiFetch('/api/integrations/jira/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: updatedTask, projectKey: integrationConfig.jira.projectKey }),
        }).catch(() => {});
      }
    } catch (err: any) {
      console.error('Agent step execution error:', err);
      showToast('Orchestration Warning', 'Autonomous step fallback triggered.', 'alert');
    } finally {
      setIsProcessingStep(false);
      setActiveProcessingTaskId(undefined);
    }
  };

  // Single-step execution on the server engine (Next Cycle)
  const handleRunServerCycle = async () => {
    if (isArchived) {
      showToast('Project is Archived', 'Cannot run automated engine cycles on an archived project.', 'alert');
      return;
    }
    setIsProcessingStep(true);
    try {
      const res = await apiFetch('/api/orchestrate/engine/step', { method: 'POST' });
      const data = await res.json();
      if (data.state) {
        setTasks(data.state.tasks);
        setAgents(data.state.agents);
        setCommunications(data.state.communications);
        setCycleCount(data.state.cycleCount);
      }
      if (data.result?.action) {
        showToast('Cycle Executed', `Coordinator step: ${data.result.action.replace(/_/g, ' ')}`, 'success');
      } else {
        showToast('Sprint Status', 'No eligible tasks currently ready for transition.', 'info');
      }
    } catch (err: any) {
      console.warn('Engine step error:', err);
      showToast('Cycle Warning', err.message || 'Failed to execute engine cycle', 'alert');
    } finally {
      setIsProcessingStep(false);
    }
  };

  // Handlers with Centralized Quality Gate Enforcement & Server Sync
  const handleUpdateTaskStatus = async (taskId: string, newStatus: TaskStatus) => {
    if (isArchived) {
      showToast('Project is Archived', 'Archived projects are read-only. Task status cannot be modified.', 'alert');
      return;
    }
    try {
      const res = await apiFetch(`/api/orchestrate/tasks/${taskId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        const failureDetails = data.verification?.checks
          ?.filter((c: any) => !c.passed)
          ?.map((c: any) => c.rule)
          ?.join(', ') || data.error || 'Quality gates failed';

        showToast('Quality Gate Blocked', `Cannot move to ${newStatus.toUpperCase()}: ${failureDetails}`, 'alert');
        // Refresh server state to ensure UI stays accurate
        const stateRes = await apiFetch('/api/orchestrate/state');
        if (stateRes.ok) {
          const fresh = await stateRes.json();
          setTasks(fresh.tasks);
        }
        return;
      }

      setTasks((prev) => prev.map((t) => (t.id === taskId ? data.task : t)));
      showToast('Task Status Updated', `${data.task.key} moved to ${newStatus.toUpperCase()}`, 'success');
    } catch (err: any) {
      showToast('Status Update Error', err.message || 'Failed to update status', 'alert');
    }
  };

  const handleUpdateTask = (updatedTask: Task) => {
    const updated = tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t));
    setTasks(updated);
    setSelectedTaskForModal(updatedTask);
    syncToServer({ tasks: updated });
  };

  const handleAddTask = (newTask: Task) => {
    const updated = [newTask, ...tasks];
    setTasks(updated);
    syncToServer({ tasks: updated });
    showToast('Task Created', `${newTask.key}: ${newTask.title} added to sprint board.`, 'success');
  };

  const handleAdoptPlan = (newEpics: Epic[], newTasks: Task[], planSummary: string) => {
    setEpics(newEpics);
    setTasks(newTasks);
    setCustomPlanTitle(planSummary.slice(0, 50));
    setCycleCount(1);
    syncToServer({ epics: newEpics, tasks: newTasks });
    showToast('Plan Adopted', `Generated ${newTasks.length} tasks across ${newEpics.length} epics.`, 'success');
  };

  const handleRebalanceComplete = (
    newAssignments: { taskId: string; agentId: string; roleAssumed: string }[]
  ) => {
    const updated = tasks.map((task) => {
      const assignment = newAssignments.find((a) => a.taskId === task.id);
      if (assignment) {
        return { ...task, assignedAgentId: assignment.agentId };
      }
      return task;
    });
    setTasks(updated);
    syncToServer({ tasks: updated });
    showToast('AI Allocation Complete', 'Specialist assignments rebalanced for optimal velocity.', 'success');
  };

  const handleUpdateAgentRole = (agentId: string, newRole: string, reason: string) => {
    const updatedAgents = agents.map((a) => {
      if (a.id === agentId) {
        const newHist = [
          ...(a.dynamicRoleHistory || []),
          {
            role: newRole,
            taskKey: 'DYNAMIC-ASSUME',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ];
        return { ...a, role: newRole, dynamicRoleHistory: newHist };
      }
      return a;
    });

    const agent = agents.find((a) => a.id === agentId);
    let updatedComms = communications;
    if (agent) {
      const msg: CommunicationMessage = {
        id: `comm-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        senderId: agent.id,
        senderName: agent.name,
        senderRole: newRole,
        recipientId: 'all',
        content: `Assumed dynamic role "${newRole}": ${reason}`,
        messageType: 'status_update',
      };
      updatedComms = [msg, ...communications];
      setCommunications(updatedComms);
    }

    setAgents(updatedAgents);
    syncToServer({ agents: updatedAgents, communications: updatedComms });
    showToast('Dynamic Role Assumed', `${agent?.name || 'Agent'} is now ${newRole}`, 'success');
  };

  const handleDispatchSlack = async (message: string, channel: string): Promise<boolean> => {
    try {
      const res = await apiFetch('/api/integrations/slack/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: integrationConfig.slack.webhookUrl,
          channel,
          message: { text: message },
        }),
      });
      const data = await res.json();
      showToast('Slack Dispatched', `Broadcast posted to ${channel}`, 'success');
      return data.success;
    } catch {
      return false;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Toast Notification Alert Banner */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 flex items-start space-x-3 p-3.5 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl max-w-sm animate-bounce-short">
          <div className="shrink-0 mt-0.5">
            {toastMessage.type === 'success' ? (
              <CheckCircle className="w-4 h-4 text-emerald-400" />
            ) : toastMessage.type === 'alert' ? (
              <AlertCircle className="w-4 h-4 text-amber-400" />
            ) : (
              <Bot className="w-4 h-4 text-indigo-400" />
            )}
          </div>
          <div className="flex-1">
            <h5 className="text-xs font-bold text-slate-100">{toastMessage.title}</h5>
            <p className="text-[11px] text-slate-300 mt-0.5 leading-snug">{toastMessage.desc}</p>
          </div>
        </div>
      )}

      {/* Authentication gate: blocks the board while the API refuses the token */}
      {authRequired && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90 px-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-start space-x-3">
              <Lock className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-slate-100">Authentication required</h4>
                <p className="text-xs text-slate-300 mt-1 leading-snug">
                  The Dupond API answered 401. Nothing on this board is server state and no edits are being
                  saved until a valid operator token is provided.
                </p>
              </div>
            </div>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                handleConnect();
              }}
            >
              <input
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="Operator token"
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!tokenDraft.trim()}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Connect
                </button>
              </div>
            </form>
            <p className="mt-3 text-[11px] leading-snug text-slate-500">
              The token is the server's <code>data/.dupond_auth_token</code> file, or the{' '}
              <code>DUPOND_API_KEY</code> / <code>DUPOND_AUTH_TOKEN</code> it was started with.
            </p>
          </div>
        </div>
      )}

      {/* Main Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isRunningAuto={isRunningAuto}
        onToggleAuto={async () => {
          if (isArchived) {
            showToast('Project is Archived', 'Cannot run automated engine on an archived project.', 'alert');
            return;
          }
          const next = !isRunningAuto;
          setIsRunningAuto(next);
          try {
            const ep = next ? '/api/orchestrate/engine/start' : '/api/orchestrate/engine/stop';
            const res = await apiFetch(ep, { method: 'POST' });
            if (!res.ok) {
              setIsRunningAuto(!next);
              showToast(
                'Coordinator Unchanged',
                `The API refused to ${next ? 'start' : 'stop'} the coordinator (HTTP ${res.status}).`,
                'alert'
              );
              return;
            }
            showToast(
              next ? 'Server Background Coordinator ACTIVE' : 'Server Coordinator PAUSED',
              next ? 'Autonomous background daemon active. Will continue executing even if browser is closed.' : 'Server coordinator paused.',
              next ? 'success' : 'info'
            );
          } catch (err) {
            console.warn('Failed to toggle server daemon:', err);
          }
        }}
        onRunSingleStep={handleRunServerCycle}
        isProcessingStep={isProcessingStep}
        onOpenIngestModal={() => setIsIngestModalOpen(true)}
        onOpenReportModal={() => setActiveTab('reports')}
        projectTitle={projectTitle}
        cycleCount={cycleCount}
      />

      {/* Archived Read-Only Banner */}
      {isArchived && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
          <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/60 text-amber-200 text-xs flex flex-wrap items-center justify-between gap-2 shadow-sm">
            <div className="flex items-center space-x-2.5">
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Archived Project
              </span>
              <span>
                <strong>{currentProject?.name}</strong> is in read-only audit mode. Task modifications and autonomous execution cycles are disabled.
              </span>
            </div>
            <button
              type="button"
              onClick={() => openResetModal()}
              className="px-2.5 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300 hover:text-white text-[11px] font-semibold transition-colors"
            >
              Reset Workspace
            </button>
          </div>
        </div>
      )}

      {/* Main Workspace Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5">
        {activeTab === 'kanban' && (
          <KanbanBoard
            tasks={tasks}
            agents={agents}
            epics={epics}
            onTaskClick={(task) => setSelectedTaskForModal(task)}
            onUpdateTaskStatus={handleUpdateTaskStatus}
            onOpenAddTaskModal={() => {
              if (isArchived) {
                showToast('Project is Archived', 'Cannot add tasks to an archived project.', 'alert');
                return;
              }
              setIsAddTaskModalOpen(true);
            }}
            onOpenIngestModal={() => setIsIngestModalOpen(true)}
            onOpenIntegrations={() => setActiveTab('integrations')}
            activeProcessingTaskId={activeProcessingTaskId}
          />
        )}

        {activeTab === 'diagrams' && (
          <DiagramsProgress
            tasks={tasks}
            agents={agents}
            epics={epics}
            onTaskClick={(task) => setSelectedTaskForModal(task)}
          />
        )}

        {activeTab === 'resources' && (
          <ResourceAllocationMatrix
            agents={agents}
            tasks={tasks}
            onRebalanceComplete={handleRebalanceComplete}
            onUpdateAgentRole={handleUpdateAgentRole}
            onTaskClick={(task) => setSelectedTaskForModal(task)}
          />
        )}

        {activeTab === 'reports' && (
          <StakeholderReports
            tasks={tasks}
            agents={agents}
            epics={epics}
            onDispatchSlack={handleDispatchSlack}
          />
        )}

        {activeTab === 'orchestrator' && (
          <OrchestratorStudio
            config={orchestratorConfig}
            onUpdateConfig={(updated) => {
              setOrchestratorConfig(updated);
              syncToServer({ orchestratorConfig: updated });
              showToast('Directives Saved', 'Orchestrator configuration updated.', 'success');
            }}
            customProviders={integrationConfig.customProviders}
            tasks={tasks}
            agents={agents}
          />
        )}

        {activeTab === 'integrations' && (
          <IntegrationsView
            integrationConfig={integrationConfig}
            onUpdateIntegrationConfig={(updated) => {
              setIntegrationConfig(updated);
              syncToServer({ integrationConfig: updated });
              showToast('Integrations Saved', 'Webhook and provider settings stored.', 'success');
            }}
            communications={communications}
            tasks={tasks}
          />
        )}
      </main>

      {/* Plan Ingestion Modal */}
      <PlanIngestionModal
        isOpen={isIngestModalOpen}
        onClose={() => setIsIngestModalOpen(false)}
        onAdoptPlan={handleAdoptPlan}
        agents={agents}
      />

      {/* Task Detail Modal */}
      <TaskDetailModal
        task={selectedTaskForModal}
        onClose={() => setSelectedTaskForModal(null)}
        onUpdateTask={handleUpdateTask}
        agents={agents}
        epics={epics}
        allTasks={tasks}
        onExecuteAgentOnTask={executeAgentStep}
        isExecutingStep={isProcessingStep}
      />

      {/* Add Task Modal */}
      <AddTaskModal
        isOpen={isAddTaskModalOpen}
        onClose={() => setIsAddTaskModalOpen(false)}
        onAddTask={handleAddTask}
        agents={agents}
        epics={epics}
        existingTasksCount={tasks.length}
      />

      {/* Project Wizard Modal */}
      <ProjectWizardModal
        isOpen={isCreateWizardOpen}
        onClose={() => setIsCreateWizardOpen(false)}
      />

      {/* Project Lifecycle Management Modal (Reset & Archive) */}
      <ProjectLifecycleModal />
    </div>
  );
}

export default function App() {
  return (
    <ProjectProvider>
      <AppWorkspace />
    </ProjectProvider>
  );
}
