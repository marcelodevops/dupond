const assert = require('assert');

// Verify that the actual functions exist and execute accurately
assert.strictEqual(typeof calculateAgentLoad, 'function', 'calculateAgentLoad must be exported');
assert.strictEqual(typeof buildGeminiOptimizerPrompt, 'function', 'buildGeminiOptimizerPrompt must be exported');
assert.strictEqual(typeof balanceWorkload, 'function', 'balanceWorkload must be exported');

// Test 1 & 2: Load Percentage Calculation and Thresholds (Evidence for st-10)
const agent = { id: 'a1', name: 'Nexus-7', role: 'Architect' };
const tasks = [
  { id: 't1', key: 'AEG-1', assignedAgentId: 'a1', estimatedHours: 8, status: 'in_progress' },
  { id: 't2', key: 'AEG-2', assignedAgentId: 'a1', estimatedHours: 12, status: 'todo' },
];
const summary = calculateAgentLoad(agent, tasks, 40);
assert.strictEqual(summary.allocatedHours, 20);
assert.strictEqual(summary.loadPercentage, 50);
assert.strictEqual(summary.status, 'balanced');

const overSummary = calculateAgentLoad(agent, [{ id: 't3', key: 'AEG-3', assignedAgentId: 'a1', estimatedHours: 36, status: 'todo' }], 40);
assert.strictEqual(overSummary.loadPercentage, 90);
assert.strictEqual(overSummary.status, 'overloaded');

if (typeof passCriterion === 'function') {
  passCriterion('st-10');
}

// Test 3: Gemini Resource Optimizer Prompt Formulation (Evidence for st-11)
const prompt = buildGeminiOptimizerPrompt(
  [summary, overSummary],
  [{ id: 'a1', name: 'Nexus-7', role: 'Architect', skills: ['System Design'] }],
  [{ key: 'AEG-99', title: 'Pending Task', estimatedHours: 6, priority: 'high' }]
);
assert.ok(prompt.includes('Nexus-7'), 'Prompt must contain agent telemetry');
assert.ok(prompt.includes('90%'), 'Prompt must reflect overloaded status');

if (typeof passCriterion === 'function') {
  passCriterion('st-11');
}

// Test 4: Algorithmic Workload Rebalancing (Evidence for st-12)
const agents = [
  { id: 'a1', name: 'Nexus-7', role: 'Architect', skills: ['System Design'] },
  { id: 'a2', name: 'Kaelen Dev', role: 'Backend', skills: ['APIs'] },
];
const sprintTasks = [
  { id: 't1', key: 'AEG-1', title: 'Task 1', assignedAgentId: 'a1', estimatedHours: 20, priority: 'critical', status: 'in_progress' },
  { id: 't2', key: 'AEG-2', title: 'Task 2', assignedAgentId: 'a1', estimatedHours: 16, priority: 'low', status: 'todo' },
  { id: 't3', key: 'AEG-3', title: 'Task 3', assignedAgentId: 'a2', estimatedHours: 8, priority: 'medium', status: 'todo' },
];

const rebalance = balanceWorkload(agents, sprintTasks, 40);
assert.strictEqual(rebalance.reassignments.length, 1);
assert.strictEqual(rebalance.reassignments[0].taskKey, 'AEG-2');
assert.strictEqual(rebalance.reassignments[0].newAgentId, 'a2');

if (typeof passCriterion === 'function') {
  passCriterion('st-12');
}
