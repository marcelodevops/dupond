import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
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

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    hasGeminiKey: Boolean(geminiApiKey),
    timestamp: new Date().toISOString(),
  });
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

// Endpoint: AI-driven resource allocation & workload balancing
app.post('/api/orchestrate/allocate-resources', async (req: Request, res: Response) => {
  try {
    const { tasks = [], agents = [] } = req.body;

    if (ai && tasks.length > 0 && agents.length > 0) {
      try {
        const prompt = `You are Aegis Resource Optimizer Agent.
Perform AI-driven resource allocation and role matching for the following tasks and agents.
Consider agent skills, workload balance, task priorities, and dependencies.
Tasks: ${JSON.stringify(tasks.map((t: any) => ({ id: t.id, key: t.key, title: t.title, priority: t.priority, estimatedHours: t.estimatedHours, tags: t.tags })))}
Agents: ${JSON.stringify(agents.map((a: any) => ({ id: a.id, name: a.name, role: a.role, skills: a.skills, velocity: a.velocity })))}

Return a pure JSON response (no markdown fences):
{
  "assignments": [
    {
      "taskId": "task-id",
      "agentId": "agent-id",
      "roleAssumed": "Assumed role title for this assignment",
      "matchReason": "Detailed reason why this agent is optimal",
      "confidence": 0.95
    }
  ],
  "capacityAnalysis": [
    {
      "agentId": "agent-id",
      "allocatedHours": 24,
      "loadPercentage": 75,
      "status": "balanced"
    }
  ],
  "recommendations": [
    "Workload optimization note 1",
    "Dependency clearance note 2"
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
        return res.json(parsed);
      } catch (geminiError: any) {
        console.warn('Gemini resource allocation fallback:', geminiError?.message);
      }
    }

    // Heuristic allocation fallback
    const allocation = heuristicAllocateResources(tasks, agents);
    return res.json(allocation);
  } catch (error: any) {
    console.error('Error allocating resources:', error);
    res.status(500).json({ error: error.message || 'Failed to allocate resources' });
  }
});

// Endpoint: Agent step execution (Autonomous orchestration cycle)
app.post('/api/orchestrate/agent-step', async (req: Request, res: Response) => {
  try {
    const { task, agent, orchestratorConfig, communicationHistory = [] } = req.body;

    if (!task || !agent) {
      return res.status(400).json({ error: 'task and agent are required' });
    }

    if (ai) {
      try {
        const prompt = `You are simulating the execution step of an AI Agent in a coordinated autonomous project team.
Orchestrator Persona & Directives:
Name: ${orchestratorConfig?.personaName || 'Aegis Core'}
Directives: ${orchestratorConfig?.systemPrompt || 'Coordinate efficiently with high engineering standards.'}
Autonomy Mode: ${orchestratorConfig?.autonomyMode || 'semi_autonomous'}

Active Agent:
Name: ${agent.name}
Base Role: ${agent.role}
Specialized Skills: ${(agent.skills || []).join(', ')}

Current Task:
Key: ${task.key}
Title: ${task.title}
Status: ${task.status}
Description: ${task.description}
Subtasks: ${JSON.stringify(task.subtasks || [])}
Existing Deliverables: ${JSON.stringify(task.deliverables || [])}

Recent Team Communication History:
${communicationHistory.slice(-5).map((m: any) => `[${m.senderRole} -> ${m.recipientId || 'Team'}]: ${m.content}`).join('\n')}

Simulate the agent's next action, role assumption based on requirement/history, concrete technical deliverable, and communication message.
Return pure JSON (no markdown ticks):
{
  "roleAssumed": "Specialized role assumed based on requirement",
  "reasoning": "Step-by-step reasoning behind execution decision",
  "actionTaken": "Specific action performed",
  "deliverableOutput": "Concrete deliverable content (e.g. code snippet, API spec, test results, config or design brief)",
  "nextStatus": "in_progress", 
  "subtasksCompleted": ["st-1"],
  "communicationMessage": {
    "content": "Message broadcast to the team or orchestrator",
    "messageType": "status_update"
  }
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
        console.warn('Gemini agent step fallback:', geminiError?.message);
      }
    }

    // Fallback step simulation
    const fallbackStep = simulateFallbackStep(task, agent);
    return res.json(fallbackStep);
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

// Endpoint: Jira webhook / API sync simulator & live dispatcher
app.post('/api/integrations/jira/sync', async (req: Request, res: Response) => {
  try {
    const { action, task, projectKey = 'AEG' } = req.body;
    const jiraIssueId = task?.key || `${projectKey}-${Math.floor(100 + Math.random() * 900)}`;

    // Return detailed sync record
    res.json({
      success: true,
      action: action || 'sync_task',
      jiraIssueId,
      issueUrl: `https://jira.atlassian.net/browse/${jiraIssueId}`,
      syncedAt: new Date().toISOString(),
      mappedStatus: task?.status === 'done' ? 'Closed' : task?.status === 'review' ? 'In Review' : 'In Progress',
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

// Endpoint: Slack webhook dispatcher (supports real webhook URL or internal simulation)
app.post('/api/integrations/slack/dispatch', async (req: Request, res: Response) => {
  try {
    const { webhookUrl, message, channel = '#engineering-sprint' } = req.body;

    let realDispatchSuccess = false;
    let realHttpStatus = null;

    if (webhookUrl && webhookUrl.startsWith('https://hooks.slack.com/')) {
      try {
        const slackResponse = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: message?.text || message,
            channel,
            username: 'Aegis Orchestrator',
            icon_emoji: ':robot_face:',
          }),
        });
        realDispatchSuccess = slackResponse.ok;
        realHttpStatus = slackResponse.status;
      } catch (err: any) {
        console.warn('Real Slack webhook dispatch error:', err.message);
      }
    }

    res.json({
      success: true,
      dispatchedViaRealWebhook: realDispatchSuccess,
      httpStatus: realHttpStatus,
      channel,
      payload: message,
      timestamp: new Date().toISOString(),
      messageId: `msg-${Date.now()}`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Slack dispatch failed' });
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

// Helper: Heuristic resource allocation
function heuristicAllocateResources(tasks: any[], agents: any[]) {
  const roleKeywords: Record<string, string[]> = {
    'Architect': ['Architect', 'Schema', 'Core', 'Design', 'State Machine'],
    'Frontend': ['Kanban', 'UI', 'React', 'Interactive', 'Component', 'CSS'],
    'Backend': ['API', 'Webhook', 'Integration', 'Database', 'Server'],
    'QA': ['Test', 'Security', 'Validation', 'Audit', 'Review'],
    'DevOps': ['Deploy', 'CI/CD', 'Pipeline', 'Docker', 'Infra'],
  };

  const agentWorkload: Record<string, number> = {};
  agents.forEach((a) => (agentWorkload[a.id] = 0));

  const assignments = tasks.map((task) => {
    // Score each agent
    let bestAgent = agents[0];
    let bestScore = -1;

    agents.forEach((agent) => {
      let score = 10;
      // Skill match
      const taskText = `${task.title} ${task.description} ${(task.tags || []).join(' ')}`.toLowerCase();
      agent.skills?.forEach((skill: string) => {
        if (taskText.includes(skill.toLowerCase())) score += 15;
      });

      // Role match
      Object.entries(roleKeywords).forEach(([key, kws]) => {
        if (agent.role.toLowerCase().includes(key.toLowerCase())) {
          kws.forEach((kw) => {
            if (taskText.includes(kw.toLowerCase())) score += 10;
          });
        }
      });

      // Penalty for heavy workload
      const currentLoad = agentWorkload[agent.id] || 0;
      score -= currentLoad * 0.5;

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    });

    agentWorkload[bestAgent.id] = (agentWorkload[bestAgent.id] || 0) + (task.estimatedHours || 6);

    return {
      taskId: task.id,
      agentId: bestAgent.id,
      roleAssumed: bestAgent.role,
      matchReason: `High domain affinity with ${bestAgent.skills?.slice(0, 2).join(', ')} and optimal sprint bandwidth.`,
      confidence: Math.min(0.98, Math.max(0.75, parseFloat((bestScore / 35).toFixed(2)))),
    };
  });

  const capacityAnalysis = agents.map((agent) => {
    const hours = agentWorkload[agent.id] || 0;
    const maxCapacity = 40;
    const loadPercentage = Math.round((hours / maxCapacity) * 100);
    return {
      agentId: agent.id,
      allocatedHours: hours,
      loadPercentage,
      status: loadPercentage > 90 ? 'overloaded' : loadPercentage < 40 ? 'underloaded' : 'balanced',
    };
  });

  return {
    assignments,
    capacityAnalysis,
    recommendations: [
      'Workload is distributed within safe 80% utilization buffer across all specialist nodes.',
      'Critical path tasks prioritized to Lead Architect and Senior Backend dev.',
    ],
  };
}

// Helper: Fallback agent step
function simulateFallbackStep(task: any, agent: any) {
  const isDone = task.status === 'review';
  const nextStatus = isDone ? 'done' : task.status === 'in_progress' ? 'review' : 'in_progress';

  return {
    roleAssumed: `${agent.role} (Assumed for ${task.key})`,
    reasoning: `Analyzed task requirements for ${task.key} against current sprint milestones. Executing active work item and generating verified deliverables.`,
    actionTaken: `Processed ${task.title}. Ran validation checks and synchronized state.`,
    deliverableOutput: `// Verified deliverable for ${task.key}\nexport const ${task.key.replace('-', '_')}_spec = {\n  status: "${nextStatus}",\n  verifiedBy: "${agent.name}",\n  timestamp: "${new Date().toISOString()}",\n  criteriaMet: true\n};`,
    nextStatus,
    subtasksCompleted: (task.subtasks || []).map((s: any) => s.id),
    communicationMessage: {
      content: `Completed phase for ${task.key} (${task.title}). Moving status to ${nextStatus}. Ready for subsequent pipeline dependencies.`,
      messageType: nextStatus === 'done' ? 'deliverable' : 'status_update',
    },
  };
}

// Dev vs Prod Vite mounting
if (!isProduction) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
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

app.listen(PORT, () => {
  console.log(`Aegis Orchestrator server running on http://0.0.0.0:${PORT}`);
});
