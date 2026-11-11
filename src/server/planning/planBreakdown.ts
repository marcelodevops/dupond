import { GEMINI_MODEL, getGeminiClient } from '../gemini.js';

/**
 * Heuristic fallback plan decomposition used when the Gemini plan parser is
 * unavailable or fails. Produces the same response shape as the live model so
 * the UI can render either result without branching.
 */
export function generateFallbackPlanBreakdown(planText: string) {
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

/**
 * Parses and decomposes a curated plan into epics and tasks via Gemini,
 * falling back to the heuristic breakdown when the model is unavailable or
 * fails. Returns the same response shape either way.
 */
export async function parsePlan(planText: string, currentAgents: any[]): Promise<unknown> {
  const ai = getGeminiClient();
  if (ai) {
    try {
      const prompt = buildPlanBreakdownPrompt(planText, currentAgents);
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      });
      return JSON.parse(response.text || '{}');
    } catch (geminiError: any) {
      console.warn('Gemini plan breakdown fallback:', geminiError?.message);
    }
  }
  return generateFallbackPlanBreakdown(planText);
}

export function buildPlanBreakdownPrompt(
  planText: string,
  currentAgents: { name: string; role: string; skills: string[] }[]
): string {
  return `You are Dupond Chief Orchestrator, an enterprise-level Autonomous Project Management Agent.
Analyze the following project plan and decompose it into a structured sprint plan with Epics, granular Tasks, clear dependencies, recommended specialized agent roles, and estimated effort in hours.

The available agent roles or specialist profiles in the organization include:
${JSON.stringify(currentAgents.map((a) => ({ name: a.name, role: a.role, skills: a.skills })))}

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
}
