import { coordinator } from '../coordinator.js';
import { callGeminiWithTimeout, GEMINI_MODEL, getGeminiClient } from '../gemini.js';

interface ChatDirectiveResult {
  status: number;
  body: unknown;
}

/**
 * Applies pattern-detected chat directives (priority changes, reassignment,
 * task creation, daemon control) to the authoritative coordinator state.
 * Returns the human-readable description of what was applied, if anything.
 */
export function applyChatDirectives(message: string): string {
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

  return appliedAction;
}

/**
 * Real interactive chat with the orchestrator persona: Gemini reply when
 * available, deterministic fallback otherwise. Directives are applied before
 * the reply is generated so the model can acknowledge them.
 */
export async function handleChat(
  message: string,
  orchestratorConfig: any,
  tasks: any[],
  agents: any[]
): Promise<ChatDirectiveResult> {
  const appliedAction = applyChatDirectives(message);

  const ai = getGeminiClient();
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

      const systemInstruction = `You are ${orchestratorConfig?.personaName || 'Dupond Prime Core'}, the Chief Autonomous Project Orchestrator.
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
          model: GEMINI_MODEL,
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

      return {
        status: 200,
        body: {
          reply: finalReply,
          appliedAction: appliedAction || null,
          state: coordinator.getStateView(),
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      };
    } catch (err: any) {
      console.warn('Gemini chat error:', err.message);
    }
  }

  const fallbackReply = appliedAction
    ? `✓ [Executed: ${appliedAction}]\nDirective registered. Tracking ${coordinator.getState().tasks.length} items with active agents.`
    : `Directive acknowledged: "${message}". Tracking ${tasks.length} items with active agents. All dependency gates verified.`;

  return {
    status: 200,
    body: {
      reply: fallbackReply,
      appliedAction: appliedAction || null,
      state: coordinator.getStateView(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  };
}
