import {
  balanceWorkload,
  calculateAgentLoad,
  buildGeminiOptimizerPrompt,
} from '../../services/workloadBalancer.js';
import { GEMINI_MODEL, getGeminiClient } from '../gemini.js';

interface AllocateResourcesResult {
  status: number;
  body: unknown;
}

/**
 * AI-driven resource allocation: runs the verified AEG-104 workload balancing
 * algorithm, optionally refines assignments via the Gemini optimizer, and
 * falls back to the algorithmic result when the model is unavailable or fails.
 */
export async function allocateResources(
  tasks: any[],
  agents: any[]
): Promise<AllocateResourcesResult> {
  const balanced = balanceWorkload(agents, tasks);

  const ai = getGeminiClient();
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
        model: GEMINI_MODEL,
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

        return {
          status: 200,
          body: {
            assignments: parsed.assignments,
            initialCapacity: balanced.initialCapacity,
            capacityAnalysis: geminiCapacity,
            recommendations: parsed.recommendations || [
              `Rebalanced ${parsed.assignments.length} assignments via Gemini optimizer.`,
            ],
          },
        };
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

  return {
    status: 200,
    body: {
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
    },
  };
}
