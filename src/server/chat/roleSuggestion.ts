import { callGeminiWithTimeout, GEMINI_MODEL, getGeminiClient } from '../gemini.js';

interface RoleSuggestionResult {
  status: number;
  body: unknown;
}

/**
 * AI-assisted dynamic role suggestion: analyzes an agent profile, skill set,
 * and sprint bottlenecks via Gemini, with a deterministic fallback.
 */
export async function suggestRole(
  agent: any,
  tasks: any[],
  communications: any[]
): Promise<RoleSuggestionResult> {
  const ai = getGeminiClient();
  if (ai) {
    try {
      const prompt = `You are Dupond Agent Role Strategist.
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
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        }),
        6000
      );

      const parsed = JSON.parse(response.text || '{}');
      return { status: 200, body: parsed };
    } catch (err: any) {
      console.warn('Gemini role suggestion error:', err.message);
    }
  }

  return {
    status: 200,
    body: {
      suggestedRole: `${agent.baseRole} Lead`,
      reason: 'Dynamic role assumed to focus on high-priority critical path sprint deliverables.',
      recommendedTaskKey: tasks.find((t: any) => t.priority === 'critical')?.key || 'AEG-102',
    },
  };
}
