/**
 * Task AEG-104: Workload Balancing & Resource Allocation Matrix
 * Specialist: Nexus-7 (Solutions Architect & Tech Lead)
 * Verified against acceptance criteria: st-10, st-11, st-12
 */

function calculateAgentLoad(agent, tasks, maxCapacityHours = 40) {
  const activeTasks = tasks.filter(
    (t) => t.assignedAgentId === agent.id && t.status !== 'done'
  );

  const allocatedHours = activeTasks.reduce((sum, t) => sum + (t.estimatedHours || 6), 0);
  const loadPercentage = Math.round((allocatedHours / maxCapacityHours) * 100);

  let status = 'balanced';
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

function buildGeminiOptimizerPrompt(summaries, availableAgents, pendingTasks) {
  return `You are Aegis Workload Allocation Strategist.
Review the current team capacity matrix and rebalance task assignments to ensure zero agents exceed 85% utilization while maximizing domain skill affinity.

Current Workload State:
${summaries.map((s) => `- ${s.agentName} (${s.role}): ${s.allocatedHours}/${s.maxCapacityHours} hrs (${s.loadPercentage}%) - [${s.status.toUpperCase()}]`).join('\n')}

Specialist Skills Matrix:
${availableAgents.map((a) => `- ${a.name} (${a.role}): ${a.skills.join(', ')}`).join('\n')}

Pending Tasks:
${pendingTasks.map((t) => `- [${t.key}] ${t.title} (${t.estimatedHours || 6}h, ${t.priority})`).join('\n')}`;
}

function balanceWorkload(agents, tasks, maxCapacityHours = 40) {
  const initialCapacity = agents.map((a) => calculateAgentLoad(a, tasks, maxCapacityHours));
  const updatedTasks = tasks.map((t) => Object.assign({}, t));
  const reassignments = [];

  let currentCapacity = agents.map((a) => calculateAgentLoad(a, updatedTasks, maxCapacityHours));
  let transfersMade = true;
  let iterations = 0;

  while (transfersMade && iterations < 10) {
    transfersMade = false;
    iterations++;

    const overloaded = currentCapacity.find((c) => c.status === 'overloaded');
    if (!overloaded) break;

    const agentTasks = updatedTasks.filter(
      (t) => t.assignedAgentId === overloaded.agentId && t.status !== 'done'
    ).sort((a, b) => {
      const pMap = { low: 1, medium: 2, high: 3, critical: 4 };
      return (pMap[a.priority] || 2) - (pMap[b.priority] || 2);
    });

    if (agentTasks.length === 0) break;
    const taskToMove = agentTasks[0];

    const recipients = currentCapacity
      .filter((c) => c.agentId !== overloaded.agentId && (c.status === 'underloaded' || c.loadPercentage < 70))
      .sort((a, b) => a.loadPercentage - b.loadPercentage);

    if (recipients.length === 0) break;

    const recipient = recipients[0];
    const recipientAgent = agents.find((a) => a.id === recipient.agentId);

    taskToMove.assignedAgentId = recipient.agentId;
    reassignments.push({
      taskId: taskToMove.id,
      taskKey: taskToMove.key,
      previousAgentId: overloaded.agentId,
      newAgentId: recipient.agentId,
      roleAssumed: recipientAgent ? recipientAgent.role : 'Specialist',
      matchReason: `Rebalanced from overloaded agent (${overloaded.loadPercentage}%) to underloaded agent (${recipient.loadPercentage}%).`,
    });

    transfersMade = true;
    currentCapacity = agents.map((a) => calculateAgentLoad(a, updatedTasks, maxCapacityHours));
  }

  return {
    initialCapacity,
    balancedCapacity: currentCapacity,
    reassignments,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculateAgentLoad, buildGeminiOptimizerPrompt, balanceWorkload };
}
