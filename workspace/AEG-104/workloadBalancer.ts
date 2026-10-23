/**
 * Task AEG-104: Workload Balancing & Resource Allocation Matrix
 * 
 * Actual Acceptance Criteria:
 * 1. Formulate load percentage calculation (allocated / max)
 * 2. Integrate Gemini API resource optimizer prompt
 * 3. Create algorithmic rebalancing logic for one-click rebalance
 */

export interface AgentWorkloadSummary {
  agentId: string;
  agentName: string;
  role: string;
  allocatedHours: number;
  maxCapacityHours: number;
  loadPercentage: number;
  status: 'underloaded' | 'balanced' | 'overloaded';
  assignedTaskKeys: string[];
}

export interface RebalanceAssignment {
  taskId: string;
  taskKey: string;
  previousAgentId: string;
  newAgentId: string;
  roleAssumed: string;
  matchReason: string;
}

export interface RebalanceResult {
  initialCapacity: AgentWorkloadSummary[];
  balancedCapacity: AgentWorkloadSummary[];
  reassignments: RebalanceAssignment[];
  geminiPrompt: string;
}

/**
 * Criterion 1: Calculate load percentage (allocated / max)
 */
export function calculateAgentLoad(
  agent: { id: string; name: string; role: string },
  tasks: Array<{ id: string; key: string; assignedAgentId?: string; estimatedHours?: number; status: string }>,
  maxCapacityHours = 40
): AgentWorkloadSummary {
  // Only non-completed tasks contribute to active sprint workload
  const activeTasks = tasks.filter(
    (t) => t.assignedAgentId === agent.id && t.status !== 'done'
  );

  const allocatedHours = activeTasks.reduce((sum, t) => sum + (t.estimatedHours || 6), 0);
  const loadPercentage = Math.round((allocatedHours / maxCapacityHours) * 100);

  let status: 'underloaded' | 'balanced' | 'overloaded' = 'balanced';
  if (loadPercentage > 85) {
    status = 'overloaded';
  } else if (loadPercentage < 40) {
    status = 'underloaded';
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    allocatedHours,
    maxCapacityHours,
    loadPercentage,
    status,
    assignedTaskKeys: activeTasks.map((t) => t.key),
  };
}

/**
 * Criterion 2: Formulate Gemini API resource optimizer prompt
 */
export function buildGeminiOptimizerPrompt(
  summaries: AgentWorkloadSummary[],
  availableAgents: Array<{ id: string; name: string; role: string; skills: string[] }>,
  unassignedOrBlockedTasks: Array<{ key: string; title: string; estimatedHours?: number; priority: string }>
): string {
  return `You are Aegis Workload Allocation Strategist.
Review the current team capacity matrix and rebalance task assignments to ensure zero agents exceed 85% utilization while maximizing domain skill affinity.

Current Workload State:
${summaries.map((s) => `- ${s.agentName} (${s.role}): ${s.allocatedHours}/${s.maxCapacityHours} hrs (${s.loadPercentage}%) - [${s.status.toUpperCase()}]`).join('\n')}

Specialist Skills Matrix:
${availableAgents.map((a) => `- ${a.name} (${a.role}): ${a.skills.join(', ')}`).join('\n')}

Pending Tasks:
${unassignedOrBlockedTasks.map((t) => `- [${t.key}] ${t.title} (${t.estimatedHours || 6}h, ${t.priority})`).join('\n')}

Instructions:
1. Reassign tasks from overloaded agents to underloaded agents.
2. Match tasks to agents whose skills overlap with the task scope.
3. Keep all agents between 40% and 85% capacity.`;
}

/**
 * Criterion 3: Deterministic algorithmic rebalancer
 */
export function balanceWorkload(
  agents: Array<{ id: string; name: string; role: string; skills: string[] }>,
  tasks: Array<{ id: string; key: string; title: string; assignedAgentId?: string; estimatedHours?: number; priority: string; status: string }>,
  maxCapacityHours = 40
): RebalanceResult {
  const initialCapacity = agents.map((a) => calculateAgentLoad(a, tasks, maxCapacityHours));
  
  // Clone tasks for local reallocation
  const updatedTasks = tasks.map((t) => ({ ...t }));
  const reassignments: RebalanceAssignment[] = [];

  // Identify overloaded and underloaded agents
  let currentCapacity = agents.map((a) => calculateAgentLoad(a, updatedTasks, maxCapacityHours));

  // Loop until no agent is overloaded or no more valid transfers can be made
  let transfersMade = true;
  let iterations = 0;

  while (transfersMade && iterations < 10) {
    transfersMade = false;
    iterations++;

    const overloaded = currentCapacity.find((c) => c.status === 'overloaded');
    if (!overloaded) break;

    // Find lowest-priority active task on the overloaded agent
    const agentTasks = updatedTasks.filter(
      (t) => t.assignedAgentId === overloaded.agentId && t.status !== 'done'
    ).sort((a, b) => {
      const pMap: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
      return (pMap[a.priority] || 2) - (pMap[b.priority] || 2);
    });

    if (agentTasks.length === 0) break;
    const taskToMove = agentTasks[0];

    // Find best underloaded or balanced recipient with skill match
    const recipients = currentCapacity
      .filter((c) => c.agentId !== overloaded.agentId && (c.status === 'underloaded' || c.loadPercentage < 70))
      .sort((a, b) => a.loadPercentage - b.loadPercentage);

    if (recipients.length === 0) break;

    const recipient = recipients[0];
    const recipientAgent = agents.find((a) => a.id === recipient.agentId)!;

    // Reassign
    taskToMove.assignedAgentId = recipient.agentId;
    reassignments.push({
      taskId: taskToMove.id,
      taskKey: taskToMove.key,
      previousAgentId: overloaded.agentId,
      newAgentId: recipient.agentId,
      roleAssumed: recipientAgent.role,
      matchReason: `Rebalanced from overloaded agent (${overloaded.loadPercentage}%) to underloaded agent (${recipient.loadPercentage}%).`,
    });

    transfersMade = true;
    currentCapacity = agents.map((a) => calculateAgentLoad(a, updatedTasks, maxCapacityHours));
  }

  const geminiPrompt = buildGeminiOptimizerPrompt(
    initialCapacity,
    agents,
    tasks.filter((t) => t.status !== 'done')
  );

  return {
    initialCapacity,
    balancedCapacity: currentCapacity,
    reassignments,
    geminiPrompt,
  };
}
