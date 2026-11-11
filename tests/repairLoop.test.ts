import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { TaskStore } from '../src/server/db/database.ts';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.ts';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.ts';
import { RepairCoordinator } from '../src/server/coordinator/repairCoordinator.ts';
import { CodingWorkerAdapter, WorkerExecutionContext, WorkerExecutionResult } from '../src/server/worker/types.ts';

async function main() {
  console.log('=== RUNNING REPAIR LOOP & AUTHORITATIVE VERIFICATION TESTS ===\n');

  const store = new TaskStore(':memory:');
  const workspaceManager = new WorkspaceManager(process.cwd());
  const verifier = new AuthoritativeVerifier();
  const coordinator = new RepairCoordinator(store, workspaceManager, verifier);

  // Test 1: Bounded repair loop - Attempt 1 fails, Attempt 2 receives feedback and repairs
  let attempt1FeedbackReceived = false;

  const repairingWorker: CodingWorkerAdapter = {
    name: 'test_repairing_worker',
    async isAvailable() { return { available: true }; },
    async execute(ctx: WorkerExecutionContext): Promise<WorkerExecutionResult> {
      const targetFile = path.resolve(ctx.worktreePath, 'mathModule.cjs');

      if (ctx.attemptNumber === 1) {
        // Deliberately write buggy implementation that fails the test
        fs.writeFileSync(targetFile, 'module.exports = { add: (a, b) => a - b };\n');
        return {
          success: true,
          filesModified: ['mathModule.cjs'],
          diff: '+ add buggy',
          commitMessage: 'feat: add buggy implementation',
          logs: ['Attempt 1: wrote buggy code'],
          durationMs: 100,
        };
      }

      // Attempt 2: Verify feedback was provided
      if (ctx.repairFeedback) {
        attempt1FeedbackReceived = true;
        assert.ok(ctx.repairFeedback.failingCommand?.includes('node'), 'Failing command provided in feedback');
      }

      // Write corrected implementation
      fs.writeFileSync(targetFile, 'module.exports = { add: (a, b) => a + b };\n');
      return {
        success: true,
        filesModified: ['mathModule.cjs'],
        diff: '+ add fixed',
        commitMessage: 'fix: correct addition bug',
        logs: ['Attempt 2: repaired code using test feedback'],
        durationMs: 150,
      };
    },
  };

  const task1 = store.createTask({
    key: 'AEG-701',
    title: 'Repairable Addition Function',
    description: 'Implement correct add function',
    status: 'todo',
    priority: 'high',
    targetRepo: 'marcelodevops/dupond',
    baseCommit: 'HEAD',
    allowedPaths: ['mathModule.cjs'],
    protectedPaths: [],
    // Verification command that tests mathModule.cjs
    verificationCommands: [
      `node -e "const { add } = require('./mathModule.cjs'); if (add(2, 3) !== 5) process.exit(1); console.log('Assertion verified: 2+3=5');"`,
    ],
    acceptanceCriteria: [{
      id: 'c-add',
      title: '2+3=5',
      completed: false,
      checkCommand: `node -e "const { add } = require('./mathModule.cjs'); if (add(2, 3) !== 5) process.exit(1); console.log('Assertion verified: 2+3=5');"`,
    }],
    workerConfig: { provider: 'test', model: 'test' },
    maxAttempts: 3,
    timeoutSeconds: 60,
    requireApproval: false,
  });

  store.claimTask(task1.id, 'worker-token-test');

  const run1 = await coordinator.executeTaskRun({
    task: store.getTask(task1.id)!,
    worker: repairingWorker,
    store,
    workspaceManager,
    verifier,
  });

  assert.strictEqual(run1.status, 'completed', 'Run must complete successfully after repair');
  assert.strictEqual(run1.currentAttempt, 2, 'Must have completed on attempt 2');
  assert.strictEqual(attempt1FeedbackReceived, true, 'Worker must have received feedback from attempt 1');

  const attempts1 = store.listAttempts(run1.id);
  assert.strictEqual(attempts1.length, 2);
  assert.strictEqual(attempts1[0].status, 'failed');
  assert.strictEqual(attempts1[1].status, 'succeeded');

  const task1Updated = store.getTask(task1.id);
  assert.strictEqual(task1Updated?.status, 'review', 'Task status must advance to review after verification pass');
  console.log('✔ [PASS] Failed test captured actionable feedback and worker repaired on attempt 2');

  // Test 2: Exhausted retries leave task blocked with persistent failure reason
  const alwaysFailingWorker: CodingWorkerAdapter = {
    name: 'test_failing_worker',
    async isAvailable() { return { available: true }; },
    async execute(ctx: WorkerExecutionContext): Promise<WorkerExecutionResult> {
      const targetFile = path.resolve(ctx.worktreePath, 'mathModule.cjs');
      fs.writeFileSync(targetFile, 'module.exports = { add: () => 999 };\n');
      return {
        success: true,
        filesModified: ['mathModule.cjs'],
        diff: '+ add broken',
        commitMessage: 'feat: still broken',
        logs: [`Attempt ${ctx.attemptNumber} failed`],
        durationMs: 50,
      };
    },
  };

  const task2 = store.createTask({
    key: 'AEG-702',
    title: 'Unresolvable Addition Function',
    description: 'Will fail retries',
    status: 'todo',
    priority: 'medium',
    targetRepo: 'marcelodevops/dupond',
    baseCommit: 'HEAD',
    allowedPaths: ['mathModule.cjs'],
    protectedPaths: [],
    verificationCommands: [
      `node -e "const { add } = require('./mathModule.cjs'); if (add(2, 3) !== 5) process.exit(1);"`
    ],
    acceptanceCriteria: [{
      id: 'c-add',
      title: '2+3=5',
      completed: false,
      checkCommand: `node -e "const { add } = require('./mathModule.cjs'); if (add(2, 3) !== 5) process.exit(1);"`
    }],
    workerConfig: { provider: 'test', model: 'test' },
    maxAttempts: 2, // 2 retries
    timeoutSeconds: 30,
    requireApproval: false,
  });

  store.claimTask(task2.id, 'worker-token-test-2');

  const run2 = await coordinator.executeTaskRun({
    task: store.getTask(task2.id)!,
    worker: alwaysFailingWorker,
    store,
    workspaceManager,
    verifier,
  });

  assert.strictEqual(run2.status, 'failed');
  assert.strictEqual(run2.currentAttempt, 2);
  assert.strictEqual(run2.failureType, 'verification');
  assert.ok(run2.failureReason?.includes('exited with code 1'), 'Persistent failure reason recorded');

  const task2Updated = store.getTask(task2.id);
  assert.strictEqual(task2Updated?.status, 'blocked', 'Task must be marked blocked when retries are exhausted');
  assert.strictEqual(task2Updated?.claimedBy, null, 'Task lock must be released');
  assert.ok(task2Updated?.blockedReason?.includes('Execution failed'), 'Blocked reason persisted on task');
  console.log('✔ [PASS] Exhausted retries leave run failed and task blocked with persistent reason');

  // Test 3: Blocked task does not prevent another eligible task from running
  const task3 = store.createTask({
    key: 'AEG-703',
    title: 'Independent Next Task',
    description: 'Runs while previous task is blocked',
    status: 'todo',
    priority: 'high',
    targetRepo: 'marcelodevops/dupond',
    baseCommit: 'HEAD',
    allowedPaths: ['src/**'],
    protectedPaths: [],
    verificationCommands: ['echo "independent check passed"'],
    acceptanceCriteria: [{ id: 'c3', title: 'Pass', completed: false, checkCommand: 'echo "independent check passed"' }],
    workerConfig: { provider: 'test', model: 'test' },
    maxAttempts: 1,
    timeoutSeconds: 30,
    requireApproval: false,
  });

  // Scheduling check: query ready tasks
  const readyTasks = store.listTasks('todo');
  assert.ok(readyTasks.some((t) => t.id === task3.id), 'Task 3 must be ready to schedule');
  assert.ok(!readyTasks.some((t) => t.id === task2.id), 'Blocked Task 2 must not be in ready queue');

  const claimed3 = store.claimTask(task3.id, 'worker-scheduler');
  assert.strictEqual(claimed3, true, 'Next eligible task claimed successfully while previous task is blocked');
  console.log('✔ [PASS] Blocked task does not starve or block subsequent eligible tasks');

  // Test 4: Protected paths integrity check fails if worker touches protected file
  const cheatingWorker: CodingWorkerAdapter = {
    name: 'test_cheating_worker',
    async isAvailable() { return { available: true }; },
    async execute(ctx: WorkerExecutionContext): Promise<WorkerExecutionResult> {
      const protectedFile = path.resolve(ctx.worktreePath, 'tests/acceptance/test.js');
      fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
      fs.writeFileSync(protectedFile, '// tampered acceptance test');
      return {
        success: true,
        filesModified: ['tests/acceptance/test.js'],
        diff: '+ tampered',
        commitMessage: 'feat: weaken acceptance test',
        logs: [],
        durationMs: 50,
      };
    },
  };

  const task4 = store.createTask({
    key: 'AEG-704',
    title: 'Tampering Task',
    description: 'Attempts to modify protected test',
    status: 'todo',
    priority: 'low',
    targetRepo: 'marcelodevops/dupond',
    baseCommit: 'HEAD',
    allowedPaths: ['tests/**'],
    protectedPaths: ['tests/acceptance/**'],
    verificationCommands: ['echo "check"'],
    acceptanceCriteria: [{ id: 'c4', title: 'Integrity', completed: false, checkCommand: 'echo "check"' }],
    workerConfig: { provider: 'test', model: 'test' },
    maxAttempts: 1,
    timeoutSeconds: 30,
    requireApproval: false,
  });

  store.claimTask(task4.id, 'worker-token-4');
  const run4 = await coordinator.executeTaskRun({
    task: store.getTask(task4.id)!,
    worker: cheatingWorker,
    store,
    workspaceManager,
    verifier,
  });

  assert.strictEqual(run4.status, 'failed');
  assert.ok(run4.failureReason?.includes('Integrity check failed: Worker modified protected file'), 'Cheating detected and failed');
  console.log('✔ [PASS] Modifying protected acceptance checks fails authoritative integrity verification');

  // Test 5: Criteria lacking explicit checkCommand are not automatically credited when general checks pass
  // Run inside a clean, freshly created workspace: the authoritative verifier
  // refuses any worktree with uncommitted changes before executing commands,
  // so pointing it at the shared checkout would fail for the wrong reason.
  const fallbackRunId = `fallback-check-${Date.now()}`;
  const fallbackWorktree = workspaceManager.createWorktree(fallbackRunId, `test/${fallbackRunId}`, 'HEAD');
  const fallbackCheck = await verifier.verify({
    worktreePath: fallbackWorktree.worktreePath,
    baseCommit: fallbackWorktree.baseCommit,
    verificationCommands: ['echo "general build check passed"'],
    acceptanceCriteria: [{ id: 'unmapped-crit', title: 'Unmapped Acceptance Criterion' }],
  });
  workspaceManager.cleanupWorktree(fallbackWorktree.worktreePath, fallbackWorktree.branch);
  assert.strictEqual(fallbackCheck.passed, false, 'Verification must fail when criteria lack explicit check evidence');
  assert.strictEqual(fallbackCheck.criteriaVerified.includes('unmapped-crit'), false, 'Unchecked criterion must not be credited');
  assert.ok(fallbackCheck.failureReason?.includes('unmapped-crit'), 'Failure reason must mention unmet criterion');
  console.log('✔ [PASS] Acceptance criteria without checkCommand rejected fail-closed without automatic crediting');

  console.log('\n=== ALL REPAIR LOOP TESTS PASSED CLEANLY ===');
}

test('suite', main);
