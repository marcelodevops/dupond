import { z } from 'zod';
import { GEMINI_MODEL, getGeminiClient } from '../gemini.js';
import { ProjectApiError } from '../projects/projectStore.js';
import type { PlanningReadiness } from '../../types/projectContract.js';

export const PlanEpicSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  color: z.string().optional().default('#3B82F6'),
});

export const PlanSubtaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  completed: z.boolean().optional().default(false),
  checkCommand: z.string().optional(),
});

export const PlanTaskSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional().default(''),
  epicId: z.string().min(1),
  status: z.enum(['backlog', 'todo']).optional().default('backlog'),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional().default('medium'),
  estimatedHours: z.number().optional().default(4),
  recommendedRole: z.string().optional(),
  dependencies: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  subtasks: z.array(PlanSubtaskSchema).optional().default([]),
});

export const PlanDecompositionSchema = z.object({
  summary: z.string().min(1),
  suggestedTimelineWeeks: z.number().optional(),
  epics: z.array(PlanEpicSchema).min(1, 'At least one epic is required'),
  tasks: z.array(PlanTaskSchema).min(1, 'At least one task is required'),
});

export type PlanDecompositionResult = z.infer<typeof PlanDecompositionSchema>;

/**
 * Returns current planning engine capability and readiness.
 * Note: AI planning currently only supports Gemini.
 */
export function getPlanningReadiness(): PlanningReadiness {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return {
      provider: 'gemini',
      model: GEMINI_MODEL,
      ready: false,
      error: 'GEMINI_API_KEY is not configured on the server. AI plan decomposition is unavailable.',
    };
  }
  return {
    provider: 'gemini',
    model: GEMINI_MODEL,
    ready: true,
  };
}

/**
 * Parses and decomposes a curated plan into epics and tasks via Gemini.
 * Never falls back to fabricated canned tasks on failure.
 */
export async function parsePlan(planText: string, currentAgents: any[] = []): Promise<PlanDecompositionResult> {
  const text = (planText || '').trim();
  if (!text) {
    throw new ProjectApiError(400, 'INVALID_PLAN', 'Plan text is required and cannot be empty.');
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new ProjectApiError(
      503,
      'PLANNER_UNAVAILABLE',
      'AI plan decomposition is unavailable: GEMINI_API_KEY is not configured on the server.'
    );
  }

  const ai = getGeminiClient();
  if (!ai) {
    throw new ProjectApiError(
      503,
      'PLANNER_UNAVAILABLE',
      'AI planning client failed to initialize with provided credentials.'
    );
  }

  let rawJson: string;
  try {
    const prompt = buildPlanBreakdownPrompt(text, currentAgents);
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });
    rawJson = response.text || '';
  } catch (apiErr: any) {
    throw new ProjectApiError(
      502,
      'PLAN_PARSING_FAILED',
      `AI plan decomposition request failed: ${apiErr?.message || 'Upstream provider error'}`
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new ProjectApiError(
      502,
      'PLAN_PARSING_FAILED',
      'AI plan decomposition returned invalid non-JSON output.'
    );
  }

  const validation = PlanDecompositionSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ProjectApiError(
      422,
      'PLAN_PARSING_FAILED',
      `AI plan decomposition produced an invalid structure: ${issues}`
    );
  }

  const result = validation.data;
  // Safety invariant: Newly parsed tasks must never claim execution or completion
  result.tasks = result.tasks.map((task) => ({
    ...task,
    status: 'backlog',
    subtasks: (task.subtasks || []).map((sub) => ({ ...sub, completed: false })),
  }));

  return result;
}

export function buildPlanBreakdownPrompt(
  planText: string,
  currentAgents: { name: string; role: string; skills: string[] }[] = []
): string {
  return `You are Dupond Chief Orchestrator, an enterprise-level Autonomous Project Management Agent.
Analyze the following project plan and decompose it into a structured sprint plan with Epics, granular Tasks, clear dependencies, recommended specialized agent roles, and estimated effort in hours.

The available agent roles or specialist profiles in the organization include:
${JSON.stringify((currentAgents || []).map((a) => ({ name: a.name, role: a.role, skills: a.skills })))}

Plan to parse:
"""
${planText}
"""

Return a pure JSON response matching this schema:
{
  "summary": "High-level orchestration summary of the project scope",
  "suggestedTimelineWeeks": 3,
  "epics": [
    {
      "id": "epic-1",
      "title": "Epic Name",
      "description": "Epic description",
      "color": "#3B82F6"
    }
  ],
  "tasks": [
    {
      "id": "task-1",
      "key": "TSK-01",
      "title": "Task title",
      "description": "Task description",
      "epicId": "epic-1",
      "priority": "high",
      "estimatedHours": 8,
      "recommendedRole": "Specialist Role",
      "dependencies": [],
      "tags": ["tag1"],
      "subtasks": [
        { "id": "st-1", "title": "Subtask title", "completed": false }
      ]
    }
  ]
}`;
}

/**
 * Test-only deterministic breakdown fixture. Used strictly in tests when explicit
 * mock decomposition is requested. Never called in normal production execution.
 */
export function generateDeterministicTestBreakdown(planText: string): PlanDecompositionResult {
  const lines = planText.split('\n').filter((l) => l.trim().length > 0);
  const title = lines[0] ? lines[0].replace(/^#+\s*/, '') : 'Orchestrated Project Sprint';

  return {
    summary: `Structured execution roadmap generated for: ${title}.`,
    suggestedTimelineWeeks: 2,
    epics: [
      {
        id: 'epic-core',
        title: 'Core Engine & Architecture',
        description: 'Foundational services, domain schemas, and high-throughput pipelines',
        color: '#3B82F6',
      },
    ],
    tasks: [
      {
        id: 'task-test-1',
        key: 'TEST-01',
        title: `Implement foundational components for: ${title}`,
        description: 'Construct core data structures and validation boundaries.',
        epicId: 'epic-core',
        status: 'backlog',
        priority: 'high',
        estimatedHours: 6,
        recommendedRole: 'Solutions Architect',
        dependencies: [],
        tags: ['Architecture', 'Core'],
        subtasks: [
          { id: 'st-test-1', title: 'Define interface types', completed: false },
          { id: 'st-test-2', title: 'Implement validation hooks', completed: false },
        ],
      },
    ],
  };
}
