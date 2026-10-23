import assert from 'node:assert';
import { 
  calculateAgentLoad, 
  buildGeminiOptimizerPrompt, 
  balanceWorkload 
} from './workloadBalancer.js';

console.log('--- RUNNING INDEPENDENT TESTS FOR AEG-104 ---');

// Test 1: Acceptance Criterion 1 - Exact Load Percentage Calculation
{
  const mockAgent = { id: 'agent-1', name: 'Nexus-7', role: 'Architect' };
  const mockTasks = [
    { id: 't-1', key: 'AEG-1', assignedAgentId: 'agent-1', estimatedHours: 8, status: 'in_progress' },
    { id: 't-2', key: 'AEG-2', assignedAgentId: 'agent-1', estimatedHours: 12, status: 'todo' },
    { id: 't-3', key: 'AEG-3', assignedAgentId: 'agent-1', estimatedHours: 4, status: 'done' }, // Done should not count
  ];

  const summary = calculateAgentLoad(mockAgent, mockTasks, 40);
  assert.strictEqual(summary.allocatedHours, 20, 'Allocated hours should sum active tasks only (8 + 12 = 20)');
  assert.strictEqual(summary.loadPercentage, 50, 'Load percentage must be (20 / 40) * 100 = 50%');
  assert.strictEqual(summary.status, 'balanced', '50% load must be classified as balanced');
  console.log('✔ Criterion 1 Test passed: Exact load percentage formulated (50%, balanced)');
}

// Test 2: Acceptance Criterion 1 - Overloaded & Underloaded Classification
{
  const mockAgent = { id: 'agent-2', name: 'Lyra', role: 'Frontend' };
  
  // Overloaded (36h / 40h = 90% > 85%)
  const heavyTasks = [
    { id: 't-1', key: 'AEG-1', assignedAgentId: 'agent-2', estimatedHours: 20, status: 'in_progress' },
    { id: 't-2', key: 'AEG-2', assignedAgentId: 'agent-2', estimatedHours: 16, status: 'todo' },
  ];
  const heavySummary = calculateAgentLoad(mockAgent, heavyTasks, 40);
  assert.strictEqual(heavySummary.loadPercentage, 90);
  assert.strictEqual(heavySummary.status, 'overloaded', '90% must be marked overloaded');

  // Underloaded (12h / 40h = 30% < 40%)
  const lightTasks = [
    { id: 't-3', key: 'AEG-3', assignedAgentId: 'agent-2', estimatedHours: 12, status: 'todo' },
  ];
  const lightSummary = calculateAgentLoad(mockAgent, lightTasks, 40);
  assert.strictEqual(lightSummary.loadPercentage, 30);
  assert.strictEqual(lightSummary.status, 'underloaded', '30% must be marked underloaded');
  console.log('✔ Criterion 1 Thresholds passed: >85% overloaded, <40% underloaded verified');
}

// Test 3: Acceptance Criterion 2 - Formulate Gemini API Resource Optimizer Prompt
{
  const summaries = [
    { agentId: 'a1', agentName: 'Nexus-7', role: 'Architect', allocatedHours: 36, maxCapacityHours: 40, loadPercentage: 90, status: 'overloaded' as const, assignedTaskKeys: ['AEG-1', 'AEG-2'] },
    { agentId: 'a2', agentName: 'Kaelen', role: 'Backend', allocatedHours: 10, maxCapacityHours: 40, loadPercentage: 25, status: 'underloaded' as const, assignedTaskKeys: ['AEG-3'] },
  ];
  const agents = [
    { id: 'a1', name: 'Nexus-7', role: 'Architect', skills: ['System Design', 'Schemas'] },
    { id: 'a2', name: 'Kaelen', role: 'Backend', skills: ['APIs', 'Node.js'] },
  ];
  const tasks = [
    { key: 'AEG-2', title: 'Data Migration', estimatedHours: 16, priority: 'medium' },
  ];

  const prompt = buildGeminiOptimizerPrompt(summaries, agents, tasks);
  assert.ok(prompt.includes('Nexus-7'), 'Prompt must include agent name');
  assert.ok(prompt.includes('90%'), 'Prompt must state current utilization');
  assert.ok(prompt.includes('OVERLOADED'), 'Prompt must flag overloaded state');
  assert.ok(prompt.includes('System Design'), 'Prompt must include skills matrix');
  console.log('✔ Criterion 2 Test passed: Gemini resource optimizer prompt contains capacity & skill telemetry');
}

// Test 4: Acceptance Criterion 3 - Algorithmic Rebalancer
{
  const agents = [
    { id: 'a1', name: 'Nexus-7', role: 'Architect', skills: ['Schemas', 'APIs'] },
    { id: 'a2', name: 'Kaelen Dev', role: 'Backend', skills: ['Node.js', 'APIs'] },
  ];
  const tasks = [
    { id: 't-1', key: 'AEG-101', title: 'Core Schema', assignedAgentId: 'a1', estimatedHours: 20, priority: 'critical', status: 'in_progress' },
    { id: 't-2', key: 'AEG-102', title: 'Secondary API', assignedAgentId: 'a1', estimatedHours: 16, priority: 'low', status: 'todo' },
    { id: 't-3', key: 'AEG-103', title: 'Health Route', assignedAgentId: 'a2', estimatedHours: 8, priority: 'medium', status: 'todo' },
  ];

  // a1 has 36h / 40h = 90% (overloaded)
  // a2 has 8h / 40h = 20% (underloaded)
  const result = balanceWorkload(agents, tasks, 40);

  assert.strictEqual(result.reassignments.length, 1, 'Exactly one task should be rebalanced');
  assert.strictEqual(result.reassignments[0].taskKey, 'AEG-102', 'Lower-priority task AEG-102 should be moved');
  assert.strictEqual(result.reassignments[0].previousAgentId, 'a1');
  assert.strictEqual(result.reassignments[0].newAgentId, 'a2');

  const a1Balanced = result.balancedCapacity.find((c) => c.agentId === 'a1')!;
  const a2Balanced = result.balancedCapacity.find((c) => c.agentId === 'a2')!;

  assert.strictEqual(a1Balanced.allocatedHours, 20, 'a1 hours reduced to 20');
  assert.strictEqual(a1Balanced.loadPercentage, 50, 'a1 load reduced to 50%');
  assert.strictEqual(a1Balanced.status, 'balanced', 'a1 status is now balanced');

  assert.strictEqual(a2Balanced.allocatedHours, 24, 'a2 hours increased to 24 (8 + 16)');
  assert.strictEqual(a2Balanced.loadPercentage, 60, 'a2 load increased to 60%');
  assert.strictEqual(a2Balanced.status, 'balanced', 'a2 status is now balanced');
  console.log('✔ Criterion 3 Test passed: Rebalanced overloaded agent (90% -> 50%) and underloaded agent (20% -> 60%)');
}

console.log('--- ALL 4 INDEPENDENT TEST SUITES PASSED CLEANLY ---');
