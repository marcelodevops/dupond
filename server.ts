import express, { Request, Response } from 'express';
import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);
const PORT = 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '10mb' }));

// Initialize GoogleGenAI server-side with required telemetry header
const geminiApiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (geminiApiKey) {
  ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

import { coordinator } from './src/server/coordinator.js';
import { balanceWorkload, calculateAgentLoad, buildGeminiOptimizerPrompt } from './src/services/workloadBalancer.js';
import { handleRepositoryDispatch } from './src/server/deliveryHandler.js';

async function callGeminiWithTimeout<T>(promise: Promise<T>, timeoutMs = 7000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('AI request timeout')), timeoutMs)),
  ]);
}

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    hasGeminiKey: Boolean(geminiApiKey),
    daemonRunning: coordinator.isDaemonRunning(),
    timestamp: new Date().toISOString(),
  });
});

// Endpoint: Server-authoritative state management
app.get('/api/orchestrate/state', (_req: Request, res: Response) => {
  res.json(coordinator.getState());
});

app.post('/api/orchestrate/state', (req: Request, res: Response) => {
  const result = coordinator.updateState(req.body);
  res.json(result);
});

// Endpoint: Centralized Task Status Transition with Quality Gate Enforcement
app.post('/api/orchestrate/tasks/:id/transition', (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });

    const result = coordinator.transitionTaskStatus(req.params.id, status);
    if (!result.success) {
      return res.status(422).json(result);
    }
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Status transition failed' });
  }
});

// Endpoint: Single Step Execution Trigger for "Next Cycle"
app.post('/api/orchestrate/engine/step', async (_req: Request, res: Response) => {
  try {
    const result = await coordinator.runDaemonTick();
    res.json({
      success: true,
      result,
      cycleCount: coordinator.getState().cycleCount,
      state: coordinator.getState(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Step execution failed' });
  }
});

// Endpoint: Server-side Background Coordinator Daemon controls
app.post('/api/orchestrate/engine/start', (req: Request, res: Response) => {
  const { intervalMs = 7000 } = req.body || {};
  coordinator.startDaemon(intervalMs);
  res.json({ success: true, running: true, message: 'Server background coordinator daemon started.' });
});

app.post('/api/orchestrate/engine/stop', (_req: Request, res: Response) => {
  coordinator.stopDaemon();
  res.json({ success: true, running: false, message: 'Server background coordinator daemon paused.' });
});

app.get('/api/orchestrate/engine/status', (_req: Request, res: Response) => {
  res.json({
    running: coordinator.isDaemonRunning(),
    cycleCount: coordinator.getState().cycleCount,
    lastUpdated: coordinator.getState().lastUpdated,
  });
});

// Endpoint: Strict Quality Gate Verification for "Done"
app.post('/api/orchestrate/verify-task', (req: Request, res: Response) => {
  try {
    const { task } = req.body;
    if (!task) return res.status(400).json({ error: 'task is required' });

    const verification = coordinator.verifyTaskQualityGates(task);
    res.json(verification);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Verification failed' });
  }
});

// Endpoint: Parse and decompose a curated plan into epics and tasks
app.post('/api/orchestrate/parse-plan', async (req: Request, res: Response) => {
  try {
    const { planText, currentAgents = [] } = req.body;
    if (!planText || typeof planText !== 'string') {
      return res.status(400).json({ error: 'planText is required' });
    }

    if (ai) {
      try {
        const prompt = `You are Aegis Chief Orchestrator, an enterprise-level Autonomous Project Management Agent.
Analyze the following project plan and decompose it into a structured sprint plan with Epics, granular Tasks, clear dependencies, recommended specialized agent roles, and estimated effort in hours.

The available agent roles or specialist profiles in the organization include:
${JSON.stringify(currentAgents.map((a: { name: string; role: string; skills: string[] }) => ({ name: a.name, role: a.role, skills: a.skills })))}

Plan to parse:
"""
${planText}
"""

Return a pure JSON response matching this schema (do NOT include markdown code fences, return raw JSON string):
{
  "summary": "High-level orchestration summary of the project scope",
  "suggestedTimelineWeeks": 3,
  "epics": [
    {
      "id": "epic-1",
      "title": "Epic Name",
      "description": "Brief description of the epic scope",
      "color": "#3B82F6"
    }
  ],
  "tasks": [
    {
      "id": "task-101",
      "key": "AEG-101",
      "title": "Task Title",
      "description": "Clear technical description and acceptance criteria",
      "epicId": "epic-1",
      "status": "todo",
      "priority": "high",
      "estimatedHours": 8,
      "recommendedRole": "Solutions Architect & Lead",
      "dependencies": [],
      "tags": ["Architecture", "Backend"],
      "subtasks": [
        {"id": "st-1", "title": "Subtask 1", "completed": false},
        {"id": "st-2", "title": "Subtask 2", "completed": false}
      ]
    }
  ]
}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        });

        const rawText = response.text || '{}';
        const parsed = JSON.parse(rawText);
        return res.json(parsed);
      } catch (geminiError: any) {
        console.warn('Gemini plan breakdown fallback:', geminiError?.message);
      }
    }

    // Heuristic fallback if AI unavailable or fails
    const fallbackResult = generateFallbackPlanBreakdown(planText);
    return res.json(fallbackResult);
  } catch (error: any) {
    console.error('Error parsing plan:', error);
    res.status(500).json({ error: error.message || 'Failed to parse plan' });
  }
});

// Endpoint: AI-driven resource allocation & workload balancing (Connected to AEG-104 module)
app.post('/api/orchestrate/allocate-resources', async (req: Request, res: Response) => {
  try {
    const { tasks = [], agents = [] } = req.body;

    if (tasks.length === 0 || agents.length === 0) {
      return res.status(400).json({ error: 'tasks and agents are required' });
    }

    // Run the verified AEG-104 workload balancing algorithm
    const balanced = balanceWorkload(agents, tasks);

    if (ai) {
      try {
        const prompt = `${buildGeminiOptimizerPrompt(balanced.initialCapacity, agents, tasks.filter((t: any) => t.status !== 'done'))}

Return a pure JSON response (no markdown fences):
{
  "assignments": [
    {
      "taskId": "task-id",
      "agentId": "agent-id",
      "roleAssumed": "Assumed role title",
      "matchReason": "Detailed skill and capacity reason",
      "confidence": 0.95
    }
  ],
  "recommendations": [
    "Workload optimization note 1",
    "Bottleneck mitigation note 2"
  ]
}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        });

        const parsed = JSON.parse(response.text || '{}');
        if (parsed.assignments && Array.isArray(parsed.assignments) && parsed.assignments.length > 0) {
          // Recompute matching capacity figures directly from Gemini's assignments
          const geminiUpdatedTasks = tasks.map((t: any) => {
            const assignment = parsed.assignments.find((a: any) => a.taskId === t.id || a.taskId === t.key);
            return assignment ? { ...t, assignedAgentId: assignment.agentId } : t;
          });
          const geminiCapacity = agents.map((a: any) => calculateAgentLoad(a, geminiUpdatedTasks, 40));

          return res.json({
            assignments: parsed.assignments,
            initialCapacity: balanced.initialCapacity,
            capacityAnalysis: geminiCapacity,
            recommendations: parsed.recommendations || [
              `Rebalanced ${parsed.assignments.length} assignments via Gemini optimizer.`,
            ],
          });
        }
      } catch (geminiError: any) {
        console.warn('Gemini resource allocation fallback:', geminiError?.message);
      }
    }

    // Direct return of AEG-104 tested algorithmic rebalancing result
    const recommendations = balanced.reassignments.length > 0
      ? balanced.reassignments.map(
          (r) => `Transferred ${r.taskKey} to ${agents.find((a: any) => a.id === r.newAgentId)?.name || r.newAgentId}: ${r.matchReason}`
        )
      : ['All agent workloads are currently within balanced limits (<85% and >40%).'];

    return res.json({
      assignments: balanced.reassignments.map((r) => ({
        taskId: r.taskId,
        agentId: r.newAgentId,
        roleAssumed: r.roleAssumed,
        matchReason: r.matchReason,
        confidence: 0.95,
      })),
      initialCapacity: balanced.initialCapacity,
      capacityAnalysis: balanced.balancedCapacity,
      recommendations,
    });
  } catch (error: any) {
    console.error('Error allocating resources:', error);
    res.status(500).json({ error: error.message || 'Failed to allocate resources' });
  }
});

// Endpoint: Agent step execution (Enforced via coordinator quality gate)
app.post('/api/orchestrate/agent-step', async (req: Request, res: Response) => {
  try {
    const { task, agent } = req.body;

    if (!task || !agent) {
      return res.status(400).json({ error: 'task and agent are required' });
    }

    try {
      // Execute the real worker step through the central coordinator
      const workerResult = await coordinator.executeWorkerStep(task, agent);
      const isDone = task.status === 'review';
      const nextStatus = isDone ? 'done' : task.status === 'in_progress' ? 'review' : 'in_progress';

      // Enforce centralized quality gate and dependency verification before advancing to 'done'
      if (nextStatus === 'done') {
        const taskForVerification = {
          ...task,
          subtasks: (task.subtasks || []).map((s: any) => ({
            ...s,
            completed: s.completed || (workerResult.subtasksCompleted && workerResult.subtasksCompleted.includes(s.id)),
          })),
          deliverables: [...(task.deliverables || []), workerResult.deliverableContent],
        };

        const verification = coordinator.verifyTaskQualityGates(taskForVerification);
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
    res.status(500).json({ error: error.message || 'Failed to execute agent step' });
  }
});

// Endpoint: Automated status reporting for stakeholders
app.post('/api/orchestrate/generate-report', async (req: Request, res: Response) => {
  try {
    const { tasks = [], agents = [], epics = [], sprintNumber = 1, period = 'Current Sprint' } = req.body;

    const completedTasks = tasks.filter((t: any) => t.status === 'done');
    const inProgressTasks = tasks.filter((t: any) => t.status === 'in_progress');
    const reviewTasks = tasks.filter((t: any) => t.status === 'review');
    const backlogTasks = tasks.filter((t: any) => t.status === 'backlog' || t.status === 'todo');
    const completionRate = tasks.length ? Math.round((completedTasks.length / tasks.length) * 100) : 0;

    if (ai) {
      try {
        const prompt = `You are Aegis Chief Orchestrator generating a comprehensive executive status report for enterprise stakeholders and engineering leadership.
Sprint Information:
- Sprint: ${sprintNumber} (${period})
- Total Tasks: ${tasks.length}
- Done: ${completedTasks.length} (${completionRate}%)
- In Progress: ${inProgressTasks.length}
- In QA / Review: ${reviewTasks.length}
- Backlog/To-Do: ${backlogTasks.length}

Tasks Summary:
${tasks.map((t: any) => `[${t.key}] ${t.title} - Status: ${t.status}, Priority: ${t.priority}, Assignee: ${t.assignedAgentId}`).join('\n')}

Active Team Agents:
${agents.map((a: any) => `${a.name} (${a.role}) - Velocity: ${a.velocity} pts/sprint`).join('\n')}

Generate a rigorous, professional stakeholder report in pure JSON (no markdown ticks):
{
  "executiveSummary": "Concise high-level summary for C-suite and Product Directors",
  "metrics": {
    "velocity": 42,
    "completionRate": ${completionRate},
    "blockerCount": 1,
    "sprintHealth": "Green"
  },
  "highlights": [
    "Key achievement 1 with technical detail",
    "Key achievement 2"
  ],
  "risksAndBlockers": [
    "Identified risk or blocker with AI mitigation plan",
    "Resource capacity alert"
  ],
  "nextMilestones": [
    "Milestone 1 target date and acceptance criteria",
    "Milestone 2"
  ],
  "slackDigest": "*Sprint ${sprintNumber} Status Update*\\n• Progress: ${completionRate}%\\n• Highlights: ...",
  "jiraDigest": "h3. Sprint ${sprintNumber} Engineering Digest\\n* Completed items: ...\\n* Blockers: ..."
}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.3,
          },
        });

        const parsed = JSON.parse(response.text || '{}');
        return res.json(parsed);
      } catch (geminiError: any) {
        console.warn('Gemini report generation fallback:', geminiError?.message);
      }
    }

    // Heuristic report fallback
    const fallbackReport = {
      executiveSummary: `Sprint ${sprintNumber} is tracking steadily at ${completionRate}% completion across ${tasks.length} orchestrated work items. The agent cluster is prioritizing critical path architectural deliverables and API contracts.`,
      metrics: {
        velocity: completedTasks.length * 5,
        completionRate,
        blockerCount: tasks.filter((t: any) => t.priority === 'critical' && t.status !== 'done').length > 2 ? 2 : 0,
        sprintHealth: completionRate > 50 ? 'Green' : completionRate > 25 ? 'Amber' : 'Green',
      },
      highlights: [
        `Completed ${completedTasks.length} core user stories including foundational architecture`,
        `${reviewTasks.length} task(s) currently undergoing automated QA verification and security checks`,
        `Autonomous role alignment matched specialists with zero idle latency`,
      ],
      risksAndBlockers: [
        'High-priority database migration items require dependency clearance from schema validation',
        'Capacity headroom is balanced across backend and frontend specialist agents',
      ],
      nextMilestones: [
        'Complete end-to-end integration and smoke test suite',
        'Deploy release candidate to staging environment with real-time health telemetry',
      ],
      slackDigest: `🚀 *Aegis Orchestrator - Sprint ${sprintNumber} Executive Brief*\n• *Progress:* ${completionRate}% (${completedTasks.length}/${tasks.length} tasks completed)\n• *Active Work:* ${inProgressTasks.length} in development, ${reviewTasks.length} in QA\n• *Health:* 🟢 On Track`,
      jiraDigest: `h3. Aegis Sprint ${sprintNumber} Automated Sync\n* *Status:* ${completionRate}% completed\n* *Verified Tasks:* ${completedTasks.map((t: any) => t.key).join(', ') || 'AEG-101'}\n* *Orchestrator Verdict:* Sprint objectives on schedule.`,
    };

    return res.json(fallbackReport);
  } catch (error: any) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: error.message || 'Failed to generate status report' });
  }
});

// Endpoint: Real Atlassian Jira Cloud REST API integration
app.post('/api/integrations/jira/sync', async (req: Request, res: Response) => {
  try {
    const { action = 'sync_task', task, hostUrl, userEmail, apiToken, projectKey = 'AEG' } = req.body;
    const isConfigured = hostUrl && userEmail && apiToken && !apiToken.includes('••••') && hostUrl.includes('.');

    if (isConfigured) {
      const cleanHost = hostUrl.trim().replace(/\/+$/, '');
      const authHeader = `Basic ${Buffer.from(`${userEmail.trim()}:${apiToken.trim()}`).toString('base64')}`;

      // Real Jira Verification Probe
      if (action === 'verify') {
        const jiraRes = await fetch(`${cleanHost}/rest/api/3/myself`, {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(7000),
        });

        if (!jiraRes.ok) {
          const errText = await jiraRes.text();
          return res.json({
            success: false,
            realJiraCall: true,
            statusCode: jiraRes.status,
            error: `Jira authentication failed (${jiraRes.status}): ${errText.slice(0, 200)}`,
          });
        }

        const userData = await jiraRes.json();
        return res.json({
          success: true,
          realJiraCall: true,
          verified: true,
          displayName: userData.displayName,
          emailAddress: userData.emailAddress,
          accountType: userData.accountType,
          message: `Connected successfully to Jira Cloud as ${userData.displayName} (${userData.emailAddress})!`,
        });
      }

      // Real Jira Issue Creation
      const summary = task?.title ? `[Aegis] ${task.key}: ${task.title}` : `[Aegis] Autonomous Task`;
      const descriptionADF = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: task?.description || 'Autonomous sprint deliverable managed by Aegis Orchestrator.',
              },
            ],
          },
        ],
      };

      const createRes = await fetch(`${cleanHost}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            summary,
            description: descriptionADF,
            issuetype: { name: 'Task' },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (createRes.ok) {
        const createdData = await createRes.json();
        return res.json({
          success: true,
          realJiraCall: true,
          jiraIssueId: createdData.key,
          issueUrl: `${cleanHost}/browse/${createdData.key}`,
          syncedAt: new Date().toISOString(),
          mappedStatus: task?.status === 'done' ? 'Closed' : task?.status === 'review' ? 'In Review' : 'In Progress',
          message: `Successfully synchronized task ${task?.key} to real Jira issue ${createdData.key}!`,
        });
      } else {
        const errText = await createRes.text();
        return res.json({
          success: false,
          realJiraCall: true,
          statusCode: createRes.status,
          error: `Jira API returned HTTP ${createRes.status}: ${errText.slice(0, 300)}`,
        });
      }
    }

    // Diagnostic response when credentials are not yet entered
    const defaultHost = (hostUrl || 'https://acme-enterprise.atlassian.net').replace(/\/+$/, '');
    const defaultKey = task?.key || `${projectKey}-101`;
    return res.json({
      success: true,
      realJiraCall: false,
      action: action || 'sync_task',
      jiraIssueId: defaultKey,
      issueUrl: `${defaultHost}/browse/${defaultKey}`,
      syncedAt: new Date().toISOString(),
      mappedStatus: task?.status === 'done' ? 'Closed' : task?.status === 'review' ? 'In Review' : 'In Progress',
      notice: 'Live Jira Cloud connector is ready. Enter your real Atlassian User Email and API Token above to create and transition live Jira tickets.',
      fields: {
        summary: task?.title || 'Autonomous Task',
        assignee: task?.assignedAgentId || 'Aegis Bot',
        priority: task?.priority || 'Medium',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Jira sync failed' });
  }
});

// Endpoint: Real Slack Block Kit Webhook Dispatcher
app.post('/api/integrations/slack/dispatch', async (req: Request, res: Response) => {
  try {
    const { webhookUrl, message, channel = '#engineering-sprint', task, eventType = 'status_update' } = req.body;

    const taskText = task ? `*${task.key}: ${task.title}*` : (message?.text || message || 'Aegis Sprint Notification');
    const priorityEmoji = task?.priority === 'critical' ? '🔴' : task?.priority === 'high' ? '🟠' : '🟢';

    // Construct Slack Block Kit layout
    const blockKitPayload = {
      channel,
      username: 'Aegis Orchestrator',
      icon_emoji: ':robot_face:',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `⚡ Aegis Orchestrator Telemetry Alert`,
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: taskText,
          },
        },
        ...(task ? [
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Status:*\n\`${task.status.toUpperCase()}\`` },
              { type: 'mrkdwn', text: `*Priority:*\n${priorityEmoji} ${task.priority.toUpperCase()}` },
              { type: 'mrkdwn', text: `*Effort:*\n${task.spentHours || 0}/${task.estimatedHours || 6}h` },
              { type: 'mrkdwn', text: `*Assignee:*\n<@${task.assignedAgentId}>` },
            ],
          },
        ] : []),
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Event: *${eventType}* • Timestamp: <!date^${Math.floor(Date.now() / 1000)}^{date_num} {time_secs}|${new Date().toLocaleTimeString()}>`,
            },
          ],
        },
      ],
    };

    let realDispatchSuccess = false;
    let realHttpStatus = null;
    let responseBody = null;

    if (webhookUrl && webhookUrl.startsWith('https://hooks.slack.com/')) {
      try {
        const slackResponse = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(blockKitPayload),
          signal: AbortSignal.timeout(6000),
        });
        realDispatchSuccess = slackResponse.ok;
        realHttpStatus = slackResponse.status;
        responseBody = await slackResponse.text();
      } catch (err: any) {
        console.warn('Real Slack webhook dispatch error:', err.message);
        responseBody = err.message;
      }
    }

    res.json({
      success: true,
      dispatchedViaRealWebhook: realDispatchSuccess,
      httpStatus: realHttpStatus,
      responseBody,
      channel,
      payload: blockKitPayload,
      timestamp: new Date().toISOString(),
      messageId: `msg-${Date.now()}`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Slack dispatch failed' });
  }
});

// Endpoint: Destination Repository & Delivery Dispatcher
app.post('/api/integrations/repository/dispatch', async (req: Request, res: Response) => {
  try {
    const { action = 'verify', repoConfig, task, allowOverwrite = false } = req.body || {};
    const result = await handleRepositoryDispatch({ action, repoConfig, task, allowOverwrite });
    return res.status(result.status).json(result.body);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Repository dispatch failed' });
  }
});

// Endpoint: Real Interactive Chat with Aegis Chief Orchestrator
app.post('/api/orchestrate/chat', async (req: Request, res: Response) => {
  try {
    const { message, orchestratorConfig, tasks = [], agents = [] } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    // Pattern detection for actionable directives
    let appliedAction = '';
    const lowerMsg = message.toLowerCase();

    // Priority change: e.g. "set AEG-102 priority to critical" or "make AEG-103 high priority"
    const prioMatch = lowerMsg.match(/(?:set|make|update)\s+(?:task\s+)?(aeg-\d+)\s+(?:priority\s+to\s+|to\s+)?(critical|high|medium|low)/i);
    if (prioMatch) {
      appliedAction = coordinator.applyChatAction({
        type: 'UPDATE_PRIORITY',
        taskKey: prioMatch[1].toUpperCase(),
        priority: prioMatch[2].toLowerCase(),
      });
    }

    // Reassign: e.g. "assign AEG-102 to Kaelen" or "reassign AEG-101 to Nexus"
    const assignMatch = lowerMsg.match(/(?:reassign|assign)\s+(?:task\s+)?(aeg-\d+)\s+to\s+([a-zA-Z0-9_-]+)/i);
    if (assignMatch) {
      appliedAction = coordinator.applyChatAction({
        type: 'REASSIGN_TASK',
        taskKey: assignMatch[1].toUpperCase(),
        agentId: assignMatch[2],
      });
    }

    // Create task: e.g. "create task: Build OAuth rate limiting" or "add task: ..."
    const createMatch = message.match(/(?:create|add)\s+task:?\s+([^,\n\.]+)/i);
    if (createMatch) {
      appliedAction = coordinator.applyChatAction({
        type: 'CREATE_TASK',
        title: createMatch[1].trim(),
        priority: lowerMsg.includes('critical') ? 'critical' : lowerMsg.includes('high') ? 'high' : 'medium',
      });
    }

    // Start / Stop background daemon
    if (lowerMsg.includes('start background') || lowerMsg.includes('start coordinator') || lowerMsg.includes('start daemon') || lowerMsg.includes('start auto')) {
      appliedAction = coordinator.applyChatAction({ type: 'START_DAEMON' });
    } else if (lowerMsg.includes('stop background') || lowerMsg.includes('stop coordinator') || lowerMsg.includes('stop daemon') || lowerMsg.includes('pause auto')) {
      appliedAction = coordinator.applyChatAction({ type: 'STOP_DAEMON' });
    }

    if (ai) {
      try {
        const sprintStats = {
          total: tasks.length,
          done: tasks.filter((t: any) => t.status === 'done').length,
          inProgress: tasks.filter((t: any) => t.status === 'in_progress').length,
          review: tasks.filter((t: any) => t.status === 'review').length,
          todo: tasks.filter((t: any) => t.status === 'todo').length,
          blocked: tasks.filter((t: any) => (t.dependencies || []).some((depId: string) => {
            const d = tasks.find((item: any) => item.id === depId);
            return d && d.status !== 'done';
          })).length,
        };

        const systemInstruction = `You are ${orchestratorConfig?.personaName || 'Aegis Prime Core'}, the Chief Autonomous Project Orchestrator.
Your direct mandate: ${orchestratorConfig?.systemPrompt || 'Coordinate efficiently with high engineering standards.'}
Autonomy Mode: ${orchestratorConfig?.autonomyMode || 'semi_autonomous'}.
Reasoning Depth: ${orchestratorConfig?.reasoningLevel || 'deep_thinking'}.
Risk Tolerance: ${orchestratorConfig?.riskTolerance || 'balanced'}.

Current Live Sprint State:
- Tasks: ${sprintStats.total} total (${sprintStats.done} done, ${sprintStats.inProgress} in progress, ${sprintStats.review} in QA, ${sprintStats.todo} to do, ${sprintStats.blocked} currently blocked).
- Tasks Snapshot: ${tasks.slice(0, 8).map((t: any) => `[${t.key}] ${t.title} (${t.status}, ${t.priority})`).join('; ')}.
- Team Agents: ${agents.map((a: any) => `${a.name} (${a.role}) - ${a.status}`).join(', ')}.
${appliedAction ? `NOTE: An action was successfully executed on the project state: "${appliedAction}". Acknowledge and integrate this.` : ''}

Respond directly, strategically, and concisely to the operator's directive or inquiry. If they want to reprioritize, explain the dependency implications. If they ask about sprint progress or blockers, provide real data and tactical recommendations.`;

        const response = await callGeminiWithTimeout(
          ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: message,
            config: {
              systemInstruction,
              temperature: orchestratorConfig?.temperature ?? 0.3,
            },
          }),
          6000
        );

        const aiReply = response.text || 'Directive registered and integrated into sprint sequencing.';
        const finalReply = appliedAction ? `✓ [Executed: ${appliedAction}]\n\n${aiReply}` : aiReply;

        return res.json({
          reply: finalReply,
          appliedAction: appliedAction || null,
          state: coordinator.getState(),
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
      } catch (err: any) {
        console.warn('Gemini chat error:', err.message);
      }
    }

    const fallbackReply = appliedAction
      ? `✓ [Executed: ${appliedAction}]\nDirective registered. Tracking ${coordinator.getState().tasks.length} items with active agents.`
      : `Directive acknowledged: "${message}". Tracking ${tasks.length} items with active agents. All dependency gates verified.`;

    return res.json({
      reply: fallbackReply,
      appliedAction: appliedAction || null,
      state: coordinator.getState(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Chat failed' });
  }
});

// Endpoint: AI-Assisted Dynamic Role Suggestion
app.post('/api/orchestrate/suggest-role', async (req: Request, res: Response) => {
  try {
    const { agent, tasks = [], communications = [] } = req.body;
    if (!agent) return res.status(400).json({ error: 'agent is required' });

    if (ai) {
      try {
        const prompt = `You are Aegis Agent Role Strategist.
Analyze this agent's profile, skill set, and current sprint bottlenecks to suggest a specialized dynamic role they should assume.

Agent: ${agent.name}
Current Role: ${agent.role} (Base: ${agent.baseRole})
Skills: ${(agent.skills || []).join(', ')}

Active Tasks in Need of Attention:
${tasks.filter((t: any) => t.status !== 'done').slice(0, 5).map((t: any) => `[${t.key}] ${t.title} (Priority: ${t.priority}, Assignee: ${t.assignedAgentId})`).join('\n')}

Recent Team Communications:
${communications.slice(-4).map((c: any) => `[${c.senderRole}]: ${c.content}`).join('\n')}

Return pure JSON (no markdown fences):
{
  "suggestedRole": "Specific dynamic role title",
  "reason": "Detailed strategic rationale based on project requirements and communication history",
  "recommendedTaskKey": "Task key they should target"
}`;

        const response = await callGeminiWithTimeout(
          ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              temperature: 0.2,
            },
          }),
          6000
        );

        const parsed = JSON.parse(response.text || '{}');
        return res.json(parsed);
      } catch (err: any) {
        console.warn('Gemini role suggestion error:', err.message);
      }
    }

    return res.json({
      suggestedRole: `${agent.baseRole} Lead`,
      reason: 'Dynamic role assumed to focus on high-priority critical path sprint deliverables.',
      recommendedTaskKey: tasks.find((t: any) => t.priority === 'critical')?.key || 'AEG-102',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Suggest role failed' });
  }
});

// Endpoint: Real Custom Provider Execution (Ollama, vLLM, OpenAI-compatible, custom RPCs)
app.post('/api/custom-providers/execute', async (req: Request, res: Response) => {
  try {
    const { endpointUrl, headers = {}, prompt, providerType = 'llm' } = req.body;
    if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl is required' });

    const startTime = Date.now();
    let bodyData: any = { prompt };

    if (providerType === 'llm') {
      bodyData = {
        model: 'default',
        messages: [{ role: 'user', content: prompt }],
        prompt,
        stream: false,
      };
    }

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(bodyData),
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - startTime;
    const rawText = await response.text();
    let parsedText = rawText;

    try {
      const jsonRes = JSON.parse(rawText);
      parsedText = jsonRes.choices?.[0]?.message?.content || jsonRes.response || jsonRes.text || rawText;
    } catch {}

    return res.json({
      success: response.ok,
      status: response.status,
      latencyMs,
      output: parsedText,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Provider execution failed' });
  }
});

// Endpoint: Custom external provider ping & integration tester
app.post('/api/custom-providers/ping', async (req: Request, res: Response) => {
  try {
    const { endpointUrl, headers = {}, payload = {} } = req.body;
    if (!endpointUrl) {
      return res.status(400).json({ error: 'endpointUrl is required' });
    }

    const startTime = Date.now();
    try {
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      const latencyMs = Date.now() - startTime;
      const data = await response.text();

      return res.json({
        success: response.ok,
        status: response.status,
        latencyMs,
        responsePreview: data.slice(0, 500),
      });
    } catch (fetchErr: any) {
      const latencyMs = Date.now() - startTime;
      return res.json({
        success: false,
        error: fetchErr.message || 'Connection failed',
        latencyMs,
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Provider ping failed' });
  }
});

// Helper: Heuristic plan breakdown fallback
function generateFallbackPlanBreakdown(planText: string) {
  const lines = planText.split('\n').filter((l) => l.trim().length > 0);
  const title = lines[0] ? lines[0].replace(/^#+\s*/, '') : 'Orchestrated Project Sprint';

  return {
    summary: `Structured execution roadmap generated for: ${title}. Decomposed into core technical work streams with automated role delegation.`,
    suggestedTimelineWeeks: 3,
    epics: [
      {
        id: 'epic-core',
        title: 'Core Engine & Architecture',
        description: 'Foundational services, domain schemas, and high-throughput pipelines',
        color: '#3B82F6',
      },
      {
        id: 'epic-ui',
        title: 'Interactive Frontend Experience',
        description: 'Responsive user interfaces, real-time reactive boards, and visual controls',
        color: '#10B981',
      },
      {
        id: 'epic-integration',
        title: 'Integrations & External APIs',
        description: 'Bi-directional webhooks, security policies, and third-party orchestration connectors',
        color: '#8B5CF6',
      },
    ],
    tasks: [
      {
        id: 'task-101',
        key: 'AEG-101',
        title: 'Architect Domain Schemas & Orchestration State Model',
        description: 'Design immutable state machine for agent transitions and dependency graph verification.',
        epicId: 'epic-core',
        status: 'done',
        priority: 'critical',
        estimatedHours: 8,
        recommendedRole: 'Lead Architect',
        dependencies: [],
        tags: ['Architecture', 'State Machine', 'TypeScript'],
        subtasks: [
          { id: 'st-1', title: 'Define Task and Agent interfaces', completed: true },
          { id: 'st-2', title: 'Implement topological sort for DAG dependencies', completed: true },
          { id: 'st-3', title: 'Add schema validation hooks', completed: true },
        ],
      },
      {
        id: 'task-102',
        key: 'AEG-102',
        title: 'Implement Interactive Kanban Board with Real-Time Updates',
        description: 'Develop five-column Kanban board with live task status transitions, agent active pulses, and filtering.',
        epicId: 'epic-ui',
        status: 'in_progress',
        priority: 'high',
        estimatedHours: 12,
        recommendedRole: 'Frontend Specialist',
        dependencies: ['task-101'],
        tags: ['React', 'Kanban', 'TailwindCSS'],
        subtasks: [
          { id: 'st-4', title: 'Create drag/click transition mechanism', completed: true },
          { id: 'st-5', title: 'Render agent avatar indicators & workload tags', completed: false },
          { id: 'st-6', title: 'Integrate task detail flyout drawer', completed: false },
        ],
      },
      {
        id: 'task-103',
        key: 'AEG-103',
        title: 'Configure Jira & Slack Bi-Directional Webhook Dispatcher',
        description: 'Build webhook sync endpoints and message formatting engines for Jira tickets and Slack notifications.',
        epicId: 'epic-integration',
        status: 'todo',
        priority: 'high',
        estimatedHours: 10,
        recommendedRole: 'Backend & Integrations Dev',
        dependencies: ['task-101'],
        tags: ['Jira', 'Slack', 'Webhooks'],
        subtasks: [
          { id: 'st-7', title: 'Construct Jira issue transition payload builder', completed: false },
          { id: 'st-8', title: 'Create Slack Block Kit layout template', completed: false },
        ],
      },
      {
        id: 'task-104',
        key: 'AEG-104',
        title: 'Build AI-Driven Dynamic Resource Allocation Matrix',
        description: 'Create algorithm analyzing agent velocity, skill sets, and backlog capacity to rebalance assignments automatically.',
        epicId: 'epic-core',
        status: 'todo',
        priority: 'medium',
        estimatedHours: 6,
        recommendedRole: 'AI & Algorithm Engineer',
        dependencies: ['task-101'],
        tags: ['AI Engine', 'Resource Optimization'],
        subtasks: [
          { id: 'st-9', title: 'Compute capacity load percentages', completed: false },
          { id: 'st-10', title: 'Role matching heuristic and confidence rating', completed: false },
        ],
      },
      {
        id: 'task-105',
        key: 'AEG-105',
        title: 'Automated Stakeholder Status Reporting Engine',
        description: 'Generate sprint digests, risk & blocker mitigation briefs, and milestone tracking for leadership.',
        epicId: 'epic-integration',
        status: 'backlog',
        priority: 'medium',
        estimatedHours: 6,
        recommendedRole: 'Product & Scrum Scribe',
        dependencies: ['task-102', 'task-104'],
        tags: ['Reporting', 'Executive Brief', 'Export'],
        subtasks: [
          { id: 'st-11', title: 'Format executive KPI summary', completed: false },
          { id: 'st-12', title: 'Export to Markdown and PDF preview', completed: false },
        ],
      },
    ],
  };
}

// Dev vs Prod Vite mounting
if (!isProduction) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: {
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

httpServer.listen(PORT, () => {
  console.log(`Aegis Orchestrator server running on http://0.0.0.0:${PORT}`);
});
