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
import { Sparkles, Bot, AlertCircle, CheckCircle, Bell } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('kanban');
  const [projectTitle, setProjectTitle] = useState<string>(SAMPLE_PLANS[0].title);
  const [cycleCount, setCycleCount] = useState<number>(5);
  const [isRunningAuto, setIsRunningAuto] = useState<boolean>(false);
  const [isProcessingStep, setIsProcessingStep] = useState<boolean>(false);
  const [activeProcessingTaskId, setActiveProcessingTaskId] = useState<string | undefined>(undefined);

  // Load state from localStorage or default
  const [tasks, setTasks] = useState<Task[]>(() => {
    try {
      const saved = localStorage.getItem('aegis_tasks');
      return saved ? JSON.parse(saved) : DEFAULT_TASKS;
    } catch {
      return DEFAULT_TASKS;
    }
  });

  const [agents, setAgents] = useState<Agent[]>(() => {
    try {
      const saved = localStorage.getItem('aegis_agents');
      return saved ? JSON.parse(saved) : DEFAULT_AGENTS;
    } catch {
      return DEFAULT_AGENTS;
    }
  });

  const [epics, setEpics] = useState<Epic[]>(() => {
    try {
      const saved = localStorage.getItem('aegis_epics');
      return saved ? JSON.parse(saved) : DEFAULT_EPICS;
    } catch {
      return DEFAULT_EPICS;
    }
  });

  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig>(() => {
    try {
      const saved = localStorage.getItem('aegis_orchestrator_config');
      return saved ? JSON.parse(saved) : DEFAULT_ORCHESTRATOR_CONFIG;
    } catch {
      return DEFAULT_ORCHESTRATOR_CONFIG;
    }
  });

  const [integrationConfig, setIntegrationConfig] = useState<IntegrationConfig>(() => {
    try {
      const saved = localStorage.getItem('aegis_integration_config');
      return saved ? JSON.parse(saved) : DEFAULT_INTEGRATION_CONFIG;
    } catch {
      return DEFAULT_INTEGRATION_CONFIG;
    }
  });

  const [communications, setCommunications] = useState<CommunicationMessage[]>(() => {
    try {
      const saved = localStorage.getItem('aegis_communications');
      return saved ? JSON.parse(saved) : DEFAULT_COMMUNICATIONS;
    } catch {
      return DEFAULT_COMMUNICATIONS;
    }
  });

  // Server-authoritative state synchronization (survives browser close)
  useEffect(() => {
    const fetchServerState = async () => {
      try {
        const res = await fetch('/api/orchestrate/state');
        if (res.ok) {
          const data = await res.json();
          if (data.tasks && data.tasks.length > 0) setTasks(data.tasks);
          if (data.agents && data.agents.length > 0) setAgents(data.agents);
          if (data.epics && data.epics.length > 0) setEpics(data.epics);
          if (data.communications && data.communications.length > 0) setCommunications(data.communications);
          if (typeof data.daemonRunning === 'boolean') setIsRunningAuto(data.daemonRunning);
          if (typeof data.cycleCount === 'number') setCycleCount(data.cycleCount);
        }
      } catch (err) {
        console.warn('Server state sync error:', err);
      }
    };

    fetchServerState();
    const syncInterval = setInterval(fetchServerState, 3500);
    return () => clearInterval(syncInterval);
  }, []);

  // Push local updates to server-authoritative state
  const syncToServer = async (partialState: any) => {
    try {
      await fetch('/api/orchestrate/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partialState),
      });
    } catch (e) {
      console.warn('Failed to push state to server:', e);
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

  // Execute single agent step on a specific task
  const executeAgentStep = async (targetTask: Task, activeAgent: Agent) => {
    setIsProcessingStep(true);
    setActiveProcessingTaskId(targetTask.id);

    try {
      const response = await fetch('/api/orchestrate/agent-step', {
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

      // Update Task status & deliverables
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
        fetch('/api/integrations/jira/sync', {
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

  // Find next actionable task for autonomous engine
  const runNextAutonomousStep = async () => {
    // Priority order: Tasks in 'in_progress' first, then 'review', then 'todo'
    const inProgressTask = tasks.find((t) => t.status === 'in_progress');
    const reviewTask = tasks.find((t) => t.status === 'review');
    const todoTask = tasks.find((t) => {
      if (t.status !== 'todo') return false;
      // verify dependencies
      const depsSatisfied = (t.dependencies || []).every((depId) => {
        const dep = tasks.find((d) => d.id === depId);
        return dep?.status === 'done';
      });
      return depsSatisfied;
    });

    const target = inProgressTask || reviewTask || todoTask;
    if (!target) {
      showToast('Sprint Milestone Reached', 'All eligible sprint tasks are up to date.', 'info');
      setIsRunningAuto(false);
      return;
    }

    const assignedAgent = agents.find((a) => a.id === target.assignedAgentId) || agents[1];
    await executeAgentStep(target, assignedAgent);
  };

  // Auto-Pilot loop timer
  const autoPilotTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (isRunningAuto) {
      autoPilotTimerRef.current = setInterval(() => {
        if (!isProcessingStep) {
          runNextAutonomousStep();
        }
      }, 4500);
    } else {
      if (autoPilotTimerRef.current) {
        clearInterval(autoPilotTimerRef.current);
        autoPilotTimerRef.current = null;
      }
    }

    return () => {
      if (autoPilotTimerRef.current) {
        clearInterval(autoPilotTimerRef.current);
      }
    };
  }, [isRunningAuto, isProcessingStep, tasks]);

  // Handlers
  const handleUpdateTaskStatus = (taskId: string, newStatus: TaskStatus) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newStatus, lastUpdated: 'Just now' } : t))
    );
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      showToast('Task Status Updated', `${task.key} moved to ${newStatus.toUpperCase()}`, 'info');
    }
  };

  const handleUpdateTask = (updatedTask: Task) => {
    setTasks((prev) => prev.map((t) => (t.id === updatedTask.id ? updatedTask : t)));
    setSelectedTaskForModal(updatedTask);
  };

  const handleAddTask = (newTask: Task) => {
    setTasks((prev) => [newTask, ...prev]);
    showToast('Task Created', `${newTask.key}: ${newTask.title} added to sprint board.`, 'success');
  };

  const handleAdoptPlan = (newEpics: Epic[], newTasks: Task[], planSummary: string) => {
    setEpics(newEpics);
    setTasks(newTasks);
    setProjectTitle(planSummary.slice(0, 50));
    setCycleCount(1);
    showToast('Plan Adopted', `Generated ${newTasks.length} tasks across ${newEpics.length} epics.`, 'success');
  };

  const handleRebalanceComplete = (
    newAssignments: { taskId: string; agentId: string; roleAssumed: string }[]
  ) => {
    setTasks((prev) =>
      prev.map((task) => {
        const assignment = newAssignments.find((a) => a.taskId === task.id);
        if (assignment) {
          return { ...task, assignedAgentId: assignment.agentId };
        }
        return task;
      })
    );
    showToast('AI Allocation Complete', 'Specialist assignments rebalanced for optimal velocity.', 'success');
  };

  const handleUpdateAgentRole = (agentId: string, newRole: string, reason: string) => {
    setAgents((prev) =>
      prev.map((a) => {
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
      })
    );

    // Broadcast inter-agent message
    const agent = agents.find((a) => a.id === agentId);
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
      setCommunications((prev) => [msg, ...prev]);
      showToast('Dynamic Role Assumed', `${agent.name} is now ${newRole}`, 'success');
    }
  };

  const handleDispatchSlack = async (message: string, channel: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/integrations/slack/dispatch', {
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

      {/* Main Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isRunningAuto={isRunningAuto}
        onToggleAuto={async () => {
          const next = !isRunningAuto;
          setIsRunningAuto(next);
          try {
            const ep = next ? '/api/orchestrate/engine/start' : '/api/orchestrate/engine/stop';
            await fetch(ep, { method: 'POST' });
            showToast(
              next ? 'Server Background Coordinator ACTIVE' : 'Server Coordinator PAUSED',
              next ? 'Autonomous background daemon active. Will continue executing even if browser is closed.' : 'Server coordinator paused.',
              next ? 'success' : 'info'
            );
          } catch (err) {
            console.warn('Failed to toggle server daemon:', err);
          }
        }}
        onRunSingleStep={runNextAutonomousStep}
        isProcessingStep={isProcessingStep}
        onOpenIngestModal={() => setIsIngestModalOpen(true)}
        onOpenReportModal={() => setActiveTab('reports')}
        projectTitle={projectTitle}
        cycleCount={cycleCount}
      />

      {/* Main Workspace Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5">
        {activeTab === 'kanban' && (
          <KanbanBoard
            tasks={tasks}
            agents={agents}
            epics={epics}
            onTaskClick={(task) => setSelectedTaskForModal(task)}
            onUpdateTaskStatus={handleUpdateTaskStatus}
            onOpenAddTaskModal={() => setIsAddTaskModalOpen(true)}
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
    </div>
  );
}
