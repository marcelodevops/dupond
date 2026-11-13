import express, { Request, Response } from 'express';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);
function resolveListenPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 3000;
  const parsed = Number(raw);
  // Port 0 is the kernel ephemeral assignment. `|| 3000` would discard it.
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return 3000;
  return parsed;
}

const PORT = resolveListenPort(process.env.PORT);
const BIND_HOST = process.env.DUPOND_BIND_HOST?.trim() || '';
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '10mb' }));

import { coordinator } from './src/server/coordinator.js';
import { defaultLifecycleService } from './src/server/lifecycle/lifecycleService.js';
import { handleRepositoryDispatch } from './src/server/deliveryHandler.js';
import { taskStore } from './src/server/db/database.js';
import { defaultGitHubDelivery } from './src/server/delivery/githubDelivery.js';
import { requireAuth } from './src/server/auth.js';
import { hasGeminiKey } from './src/server/gemini.js';
import { parsePlan } from './src/server/planning/planBreakdown.js';
import { allocateResources } from './src/server/planning/resourceAllocation.js';
import { generateStakeholderReport } from './src/server/reporting/stakeholderReport.js';
import { syncJiraTask } from './src/server/integrations/jira.js';
import { dispatchSlack } from './src/server/integrations/slack.js';
import {
  executeCustomProvider,
  pingCustomProvider,
  isBlockedError,
} from './src/server/integrations/customProviders.js';
import { handleChat } from './src/server/chat/chatDirective.js';
import { suggestRole } from './src/server/chat/roleSuggestion.js';
import { toClientMessage } from './src/server/utils/errors.js';
import { createProjectRouter, parseProjectContextHeader } from './src/server/projects/projectApi.js';
import { defaultProjectStore, ProjectApiError } from './src/server/projects/projectStore.js';

app.use(requireAuth);
app.use('/api', createProjectRouter({
  onProjectStateMutated: (projectId) => coordinator.reloadState(projectId),
}));

function projectContext(req: Request, res: Response, resourceProjectId?: string | null): string | null {
  try {
    const context = parseProjectContextHeader(req);
    if (!context) {
      res.status(400).json({ error: 'X-Dupond-Project-Id is required for project-scoped API operations.', code: 'PROJECT_CONTEXT_REQUIRED' });
      return null;
    }
    if (!defaultProjectStore.getProject(context)) {
      res.status(404).json({ error: `Project ${context} does not exist.`, code: 'PROJECT_NOT_FOUND' });
      return null;
    }
    if (resourceProjectId && resourceProjectId !== context) {
      res.status(403).json({
        error: `Resource belongs to project ${resourceProjectId}, not ${context}.`,
        code: 'PROJECT_CONTEXT_MISMATCH',
      });
      return null;
    }
    return context;
  } catch (error) {
    const err = error instanceof ProjectApiError ? error : new ProjectApiError(400, 'INVALID_REQUEST', 'Invalid project context.');
    res.status(err.httpStatus).json({ error: err.message, code: err.code });
    return null;
  }
}

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    hasGeminiKey: hasGeminiKey(),
    daemonRunning: coordinator.isDaemonRunning(),
    timestamp: new Date().toISOString(),
  });
});

// Endpoint: Server-authoritative state management
app.get('/api/orchestrate/state', (req: Request, res: Response) => {
  const projectId = projectContext(req, res);
  if (!projectId) return;
  res.json(coordinator.getStateView(projectId));
});

app.post('/api/orchestrate/state', (req: Request, res: Response) => {
  const projectId = projectContext(req, res);
  if (!projectId) return;
  const result = coordinator.updateState(req.body, { projectId });
  if (!result.success) {
    return res.status(422).json({
      success: false,
      state: coordinator.getStateView(projectId),
      rejectedDoneTasks: result.rejectedDoneTasks,
      error: result.error,
    });
  }
  res.json(result);
});

// Endpoint: Centralized Task Status Transition with Quality Gate Enforcement
app.post('/api/orchestrate/tasks/:id/transition', async (req: Request, res: Response) => {
  try {
    const requestedProjectId = parseProjectContextHeader(req) || undefined;
    const dbProjectId =
      (requestedProjectId ? taskStore.getTaskScoped(req.params.id, requestedProjectId)?.projectId : undefined) ||
      taskStore.getProjectIdForTask(req.params.id);
    const inCoordinator = coordinator.getState(requestedProjectId || 'default').tasks.some((t) => t.id === req.params.id || t.key === req.params.id);
    const taskProjectId = dbProjectId || (inCoordinator ? (requestedProjectId || 'default') : null);
    const projectId = projectContext(req, res, taskProjectId);
    if (!projectId) return;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });

    const result = await coordinator.transitionTaskStatus(req.params.id, status, projectId);
    if (!result.success) {
      return res.status(422).json(result);
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Status transition failed') });
  }
});

// Endpoint: Single Step Execution Trigger for "Next Cycle"
app.post('/api/orchestrate/engine/step', async (_req: Request, res: Response) => {
  try {
    const projectId = projectContext(_req, res);
    if (!projectId) return;
    if (projectId !== 'default') {
      return res.status(501).json({ error: 'Project engine automation is not yet available for non-default projects.', code: 'PROJECT_ENGINE_UNSUPPORTED' });
    }
    const result = await coordinator.runDaemonTick();
    res.json({
      success: true,
      result,
      cycleCount: coordinator.getState().cycleCount,
      state: coordinator.getStateView(),
    });
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Step execution failed') });
  }
});

// Endpoint: Server-side Background Coordinator Daemon controls
app.post('/api/orchestrate/engine/start', (req: Request, res: Response) => {
  const projectId = projectContext(req, res);
  if (!projectId) return;
  if (projectId !== 'default') {
    return res.status(501).json({ error: 'Project engine automation is not yet available for non-default projects.', code: 'PROJECT_ENGINE_UNSUPPORTED' });
  }
  const { intervalMs = 7000 } = req.body || {};
  coordinator.startDaemon(intervalMs);
  res.json({ success: true, running: true, message: 'Server background coordinator daemon started.' });
});

app.post('/api/orchestrate/engine/stop', (_req: Request, res: Response) => {
  const projectId = projectContext(_req, res);
  if (!projectId) return;
  if (projectId !== 'default') {
    return res.status(501).json({ error: 'Project engine automation is not yet available for non-default projects.', code: 'PROJECT_ENGINE_UNSUPPORTED' });
  }
  coordinator.stopDaemon();
  res.json({ success: true, running: false, message: 'Server background coordinator daemon paused.' });
});

app.get('/api/orchestrate/engine/status', (_req: Request, res: Response) => {
  const projectId = projectContext(_req, res);
  if (!projectId) return;
  if (projectId !== 'default') {
    return res.status(501).json({ error: 'Project engine automation is not yet available for non-default projects.', code: 'PROJECT_ENGINE_UNSUPPORTED' });
  }
  res.json({
    running: coordinator.isDaemonRunning(),
    cycleCount: coordinator.getState().cycleCount,
    lastUpdated: coordinator.getState().lastUpdated,
  });
});

// Endpoint: Strict Quality Gate Verification for "Done"
app.post('/api/orchestrate/verify-task', async (req: Request, res: Response) => {
  try {
    const { task } = req.body;
    if (!task) return res.status(400).json({ error: 'task is required' });
    const requestedProjectId = parseProjectContextHeader(req) || undefined;
    const taskProjectId =
      (requestedProjectId ? taskStore.getTaskScoped(task.id || task.key, requestedProjectId)?.projectId : undefined) ||
      taskStore.getProjectIdForTask(task.id || task.key);
    const projectId = projectContext(req, res, taskProjectId);
    if (!projectId) return;

    const verification = await coordinator.verifyTaskQualityGates(task);
    res.json(verification);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Verification failed') });
  }
});

// Endpoint: Parse and decompose a curated plan into epics and tasks
app.post('/api/orchestrate/parse-plan', async (req: Request, res: Response) => {
  try {
    const projectId = projectContext(req, res);
    if (!projectId) return;

    const { planText, currentAgents = [] } = req.body || {};
    if (!planText || typeof planText !== 'string' || !planText.trim()) {
      return res.status(400).json({ error: 'planText is required', code: 'INVALID_PLAN' });
    }

    const store = defaultProjectStore;
    const savedPlan = store.saveSourcePlan({
      projectId,
      sourceText: planText,
      status: 'submitted',
    });

    try {
      const breakdown = await parsePlan(planText, currentAgents);
      store.updateSourcePlanStatus(savedPlan.id, {
        status: 'parsed',
        summary: breakdown.summary,
        breakdownJson: JSON.stringify(breakdown),
      });
      res.json({
        ...breakdown,
        sourcePlanId: savedPlan.id,
        planRevision: savedPlan.revision,
      });
    } catch (parseErr: any) {
      store.updateSourcePlanStatus(savedPlan.id, {
        status: 'parse_failed',
        errorMessage: parseErr.message,
      });
      throw parseErr;
    }
  } catch (error: any) {
    if (error instanceof ProjectApiError) {
      return res.status(error.httpStatus).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: toClientMessage(error, 'Failed to parse plan'), code: 'PLAN_PARSING_FAILED' });
  }
});

// Endpoint: AI-driven resource allocation & workload balancing (Connected to AEG-104 module)
app.post('/api/orchestrate/allocate-resources', async (req: Request, res: Response) => {
  try {
    const projectId = projectContext(req, res);
    if (!projectId) return;

    const { tasks = [], agents = [] } = req.body;

    if (tasks.length === 0 || agents.length === 0) {
      return res.status(400).json({ error: 'tasks and agents are required' });
    }

    const result = await allocateResources(tasks, agents);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    console.error('Error allocating resources:', error);
    res.status(500).json({ error: toClientMessage(error, 'Failed to allocate resources') });
  }
});

// Endpoint: Agent step execution (Enforced via coordinator quality gate)
app.post('/api/orchestrate/agent-step', async (req: Request, res: Response) => {
  try {
    const { task, agent } = req.body;

    if (!task || !agent) {
      return res.status(400).json({ error: 'task and agent are required' });
    }
    const requestedProjectId = parseProjectContextHeader(req) || undefined;
    const taskProjectId =
      (requestedProjectId ? taskStore.getTaskScoped(task.id || task.key, requestedProjectId)?.projectId : undefined) ||
      taskStore.getProjectIdForTask(task.id || task.key);
    const projectId = projectContext(req, res, taskProjectId);
    if (!projectId) return;

    try {
      // Execute the real worker step through the central coordinator
      const workerResult = await coordinator.executeWorkerStep(task, agent, projectId);

      // Store-backed tasks advance only through the authoritative lifecycle
      // service: Review requires evidence bound to the current spec, and Done
      // waits for a recorded delivery (plus approval when the task requires
      // it). The posted task blob cannot grant either.
      const dbTask = taskStore.getTask(task.id || '', projectId) || taskStore.getTask(task.key || '', projectId);
      if (dbTask) {
        let fresh = dbTask;
        if (dbTask.status !== 'review') {
          const transition = defaultLifecycleService.transition({
            taskId: dbTask.id,
            to: 'review',
            actor: 'api',
            reason: 'Worker step executed via orchestration API',
          });
          fresh = taskStore.getTask(dbTask.id, projectId) || dbTask;
          if (!transition.ok) {
            return res.status(400).json({
              success: false,
              blocked: true,
              error: `Lifecycle service did not grant Review for ${task.key}: ${transition.detail || transition.reason}`,
              authoritativeStatus: fresh.status,
              evidence: transition.evidence,
            });
          }
        }
        const nextStatus = fresh.status;
        return res.json({
          success: true,
          runId: workerResult.runId,
          roleAssumed: `${agent.role} (Assumed for ${task.key})`,
          reasoning: `Inspected workspace and executed verified work for ${task.key}. Authoritative status is ${String(nextStatus).toUpperCase()}. ${nextStatus === 'review' ? 'Done requires a recorded delivery and approval, not an agent step.' : ''}`,
          actionTaken: workerResult.actionTaken,
          deliverableOutput: workerResult.deliverableContent,
          nextStatus,
          subtasksCompleted: workerResult.subtasksCompleted,
          communicationMessage: {
            content: `Executed worker step for ${task.key} (${task.title}). Authoritative status: ${String(nextStatus).toUpperCase()}.`,
            messageType: 'status_update',
          },
        });
      }

      const isDone = task.status === 'review';
      const nextStatus = isDone ? 'done' : task.status === 'in_progress' ? 'review' : 'in_progress';

      // Legacy JSON-only tasks: centralized artifact-based quality gate before
      // advancing to 'done'.
      if (nextStatus === 'done') {
        const taskForVerification = {
          ...task,
          subtasks: (task.subtasks || []).map((s: any) => ({
            ...s,
            completed: s.completed || (workerResult.subtasksCompleted && workerResult.subtasksCompleted.includes(s.id)),
          })),
          deliverables: [...(task.deliverables || []), workerResult.deliverableContent],
        };

        const verification = await coordinator.verifyTaskQualityGates(taskForVerification);
        if (!verification.passed) {
          const failedRules = verification.checks
            .filter((c: any) => !c.passed)
            .map((c: any) => `${c.rule}: ${c.detail}`)
            .join('; ');
          return res.status(400).json({
            success: false,
            blocked: true,
            error: `Quality gates failed for ${task.key}. Cannot mark Done: ${failedRules}`,
            verification,
          });
        }
      }

      return res.json({
        success: true,
        runId: workerResult.runId,
        roleAssumed: `${agent.role} (Assumed for ${task.key})`,
        reasoning: `Inspected workspace and executed verified test suite for ${task.key} (${workerResult.fileSize} bytes, SHA-256: ${workerResult.sha256.slice(0, 10)}...).`,
        actionTaken: workerResult.actionTaken,
        deliverableOutput: workerResult.deliverableContent,
        nextStatus,
        subtasksCompleted: workerResult.subtasksCompleted,
        communicationMessage: {
          content: `Delivered verified code for ${task.key} (${task.title}). Moving status to ${nextStatus.toUpperCase()}. SHA-256: ${workerResult.sha256.slice(0, 12)}...`,
          messageType: nextStatus === 'done' ? 'deliverable' : 'status_update',
        },
      });
    } catch (workerErr: any) {
      return res.status(400).json({
        success: false,
        blocked: true,
        error: workerErr.message || `No capable worker or verified code for ${task.key}`,
      });
    }
  } catch (error: any) {
    console.error('Error executing agent step:', error);
    res.status(500).json({ error: toClientMessage(error, 'Failed to execute agent step') });
  }
});

// Endpoint: Automated status reporting for stakeholders
app.post('/api/orchestrate/generate-report', async (req: Request, res: Response) => {
  try {
    const projectId = projectContext(req, res);
    if (!projectId) return;

    const { tasks = [], agents = [], sprintNumber = 1, period = 'Current Sprint' } = req.body;

    const result = await generateStakeholderReport(tasks, agents, sprintNumber, period);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: toClientMessage(error, 'Failed to generate status report') });
  }
});

// Endpoint: Atlassian Jira Cloud REST integration
app.post('/api/integrations/jira/sync', async (req: Request, res: Response) => {
  try {
    const requestedProjectId = parseProjectContextHeader(req) || undefined;
    const taskRef = req.body?.task?.id || req.body?.task?.key;
    const taskProjectId =
      (requestedProjectId && taskRef ? taskStore.getTaskScoped(taskRef, requestedProjectId)?.projectId : undefined) ||
      taskStore.getProjectIdForTask(taskRef);
    const projectId = projectContext(req, res, taskProjectId);
    if (!projectId) return;
    const result = await syncJiraTask(req.body || {}, projectId);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    if (isBlockedError(error)) {
      return res.status(403).json({ success: false, blocked: true, error: error.message });
    }
    res.status(500).json({ error: toClientMessage(error, 'Jira sync failed') });
  }
});

// Endpoint: Real Slack Block Kit Webhook Dispatcher
app.post('/api/integrations/slack/dispatch', async (req: Request, res: Response) => {
  try {
    const projectId = projectContext(req, res);
    if (!projectId) return;
    const result = await dispatchSlack(req.body);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Slack dispatch failed') });
  }
});

// Endpoint: Destination Repository & Delivery Dispatcher
app.post('/api/integrations/repository/dispatch', async (req: Request, res: Response) => {
  try {
    const { action = 'verify', repoConfig, task, allowOverwrite = false, runId, isApproved = false, approvedBy } = req.body || {};
    const requestedProjectId = parseProjectContextHeader(req) || undefined;
    const taskRef = task?.id || task?.key;
    const resourceProjectId =
      (runId ? taskStore.getProjectIdForRun(runId) : null) ||
      (requestedProjectId && taskRef ? taskStore.getTaskScoped(taskRef, requestedProjectId)?.projectId : undefined) ||
      taskStore.getProjectIdForTask(taskRef);
    const projectId = projectContext(req, res, resourceProjectId);
    if (!projectId) return;

    if (action === 'create_pr' || action === 'deliver') {
      const targetRun = runId
        ? taskStore.getRunScoped(runId, projectId)
        : task
        ? (taskStore.getLatestRunForTask(task.id, projectId) || taskStore.getRunScoped(task.id, projectId))
        : null;

      if (targetRun) {
        const deliveryResult = await defaultGitHubDelivery.dispatchDelivery({
          runId: targetRun.id,
          isApproved: isApproved === true,
          approvedBy: isApproved === true ? (approvedBy || 'operator') : undefined,
          repoUrl: repoConfig?.repoUrl,
          targetBaseBranch: repoConfig?.defaultBranch || 'main',
        });
        // Delivery may have granted Done (or revoked acceptance) in the
        // authoritative store; project that outcome into the UI state.
        coordinator.projectAuthoritativeStatuses(projectId);
        return res.status(deliveryResult.status).json(deliveryResult);
      }
    }

    const result = await handleRepositoryDispatch({ action, repoConfig, task, allowOverwrite });
    return res.status(result.status).json(result.body);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Repository dispatch failed') });
  }
});

// Endpoint: Explicit Pull Request Delivery Dispatcher
app.post('/api/delivery/dispatch', async (req: Request, res: Response) => {
  try {
    const { runId, isApproved = false, approvedBy, repoUrl, targetBaseBranch } = req.body || {};
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    const projectId = projectContext(req, res, taskStore.getProjectIdForRun(runId));
    if (!projectId) return;
    const result = await defaultGitHubDelivery.dispatchDelivery({
      runId,
      isApproved: isApproved === true,
      approvedBy: isApproved === true ? (approvedBy || 'operator') : undefined,
      repoUrl,
      targetBaseBranch,
    });
    coordinator.projectAuthoritativeStatuses(projectId);
    return res.status(result.status).json(result);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Delivery dispatch failed') });
  }
});

// Endpoint: Read Run Details & Verification Evidence
app.get('/api/runs/:id', (req: Request, res: Response) => {
  try {
    const runProjectId = taskStore.getProjectIdForRun(req.params.id);
    const projectId = projectContext(req, res, runProjectId);
    if (!projectId) return;
    const run = taskStore.getRunScoped(req.params.id, projectId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const attempts = taskStore.listAttempts(run.id, projectId);
    const verification = taskStore.getLatestVerification(run.id, projectId);
    const delivery = taskStore.getDeliveryForRun(run.id, projectId);
    return res.json({ run, attempts, verification, delivery });
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Failed to get run') });
  }
});

// Endpoint: Read Latest Run for Task
app.get('/api/tasks/:id/runs', (req: Request, res: Response) => {
  try {
    const requestedProjectId = parseProjectContextHeader(req) || undefined;
    const taskProjectId =
      (requestedProjectId ? taskStore.getTaskScoped(req.params.id, requestedProjectId)?.projectId : undefined) ||
      taskStore.getProjectIdForTask(req.params.id);
    const projectId = projectContext(req, res, taskProjectId);
    if (!projectId) return;
    const run = taskStore.getLatestRunForTask(req.params.id, projectId) || taskStore.getRunScoped(req.params.id, projectId);
    if (!run) return res.status(404).json({ error: 'No run found for task' });
    const attempts = taskStore.listAttempts(run.id, projectId);
    const verification = taskStore.getLatestVerification(run.id, projectId);
    const delivery = taskStore.getDeliveryForRun(run.id, projectId);
    return res.json({ run, attempts, verification, delivery });
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Failed to get task runs') });
  }
});

// Endpoint: Real Interactive Chat with Dupond Chief Orchestrator
app.post('/api/orchestrate/chat', async (req: Request, res: Response) => {
  try {
    const projectId = projectContext(req, res);
    if (!projectId) return;

    const { message, orchestratorConfig, tasks = [], agents = [] } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const result = await handleChat(message, orchestratorConfig, tasks, agents);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Chat failed') });
  }
});

// Endpoint: AI-Assisted Dynamic Role Suggestion
app.post('/api/orchestrate/suggest-role', async (req: Request, res: Response) => {
  try {
    const projectId = projectContext(req, res);
    if (!projectId) return;

    const { agent, tasks = [], communications = [] } = req.body;
    if (!agent) return res.status(400).json({ error: 'agent is required' });

    const result = await suggestRole(agent, tasks, communications);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Suggest role failed') });
  }
});

// Endpoint: Real Custom Provider Execution (Ollama, vLLM, OpenAI-compatible, custom RPCs)
app.post('/api/custom-providers/execute', async (req: Request, res: Response) => {
  try {
    const { endpointUrl } = req.body;
    if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl is required' });

    const result = await executeCustomProvider(req.body);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Provider execution failed') });
  }
});

// Endpoint: Custom external provider ping & integration tester
app.post('/api/custom-providers/ping', async (req: Request, res: Response) => {
  try {
    const { endpointUrl } = req.body;
    if (!endpointUrl) {
      return res.status(400).json({ error: 'endpointUrl is required' });
    }

    const result = await pingCustomProvider(req.body);
    res.status(result.status).json(result.body);
  } catch (error: any) {
    res.status(500).json({ error: toClientMessage(error, 'Provider ping failed') });
  }
});

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API route not found', code: 'API_NOT_FOUND' });
});

// Dev vs Prod Vite mounting
if (!isProduction) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      ws: {
        server: httpServer,
      },
    },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const distPath = path.resolve(__dirname, 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.resolve(distPath, 'index.html'));
  });
}

httpServer.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
    console.error(`👉 You can free port ${PORT} or run on an alternate port:`);
    console.error(`   PORT=${PORT + 1} npm run dev\n`);
    process.exit(1);
  }
  throw err;
});

const onListening = () => {
  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : PORT;
  const boundHost = typeof addr === 'object' && addr ? addr.address : (BIND_HOST || '0.0.0.0');
  console.log(`Dupond Orchestrator server running on http://0.0.0.0:${boundPort}`);
  console.log(`DUPOND_READY host=${boundHost} port=${boundPort}`);
};

// Default remains an unspecified bind. Tests set DUPOND_BIND_HOST so the
// readiness probe targets the same address family the socket opened.
if (BIND_HOST) {
  httpServer.listen(PORT, BIND_HOST, onListening);
} else {
  httpServer.listen(PORT, onListening);
}
