import assert from 'node:assert';
import { TaskStore } from '../src/server/db/database.ts';

async function main() {
  console.log('=== RUNNING TRANSACTIONAL SQLITE TASKSTORE TESTS ===\n');

  const store = new TaskStore(':memory:');

  // Test 1: Task creation and retrieval
  const task = store.createTask({
    key: 'AEG-501',
    title: 'Test Autonomous Execution Contract',
    description: 'Ensure isolated workspace and verification',
    status: 'todo',
    priority: 'high',
    targetRepo: 'marcelodevops/dupond-project-leader',
    baseCommit: 'c0d1c2588d352c58a6b2bc3ea26b7f7f3e072d76',
    allowedPaths: ['src/**'],
    protectedPaths: ['tests/acceptance/**'],
    verificationCommands: ['npm test'],
    acceptanceCriteria: [
      { id: 'crit-1', title: 'Task contract persisted', completed: false },
    ],
    workerConfig: {
      provider: 'gemini',
      model: 'gemini-3.8-flash',
    },
    maxAttempts: 3,
    timeoutSeconds: 300,
    requireApproval: true,
  });

  assert.ok(task.id, 'Task ID generated');
  assert.strictEqual(task.key, 'AEG-501');

  const fetched = store.getTask('AEG-501');
  assert.strictEqual(fetched?.id, task.id);
  assert.deepStrictEqual(fetched?.allowedPaths, ['src/**']);
  assert.strictEqual(fetched?.requireApproval, true);
  console.log('✔ [PASS] Task contract stored and retrieved accurately');

  // Test 2: Atomic task claim & concurrency control
  const claimed = store.claimTask(task.id, 'worker-token-alpha');
  assert.strictEqual(claimed, true, 'First claim must succeed');

  const claimedAgain = store.claimTask(task.id, 'worker-token-beta');
  assert.strictEqual(claimedAgain, false, 'Second claim must fail (already claimed)');

  const inProgressTask = store.getTask(task.id);
  assert.strictEqual(inProgressTask?.status, 'in_progress');
  assert.strictEqual(inProgressTask?.claimedBy, 'worker-token-alpha');
  console.log('✔ [PASS] Atomic task claim prevents race conditions and duplicate claims');

  // Test 3: Run and attempt tracking
  const run = store.createRun({
    taskId: task.id,
    status: 'running',
    baseCommit: task.baseCommit,
    targetBranch: 'dupond/AEG-501-feature',
    worktreePath: '/tmp/worktree-aeg-501',
    currentAttempt: 1,
    durationMs: 0,
  });

  assert.ok(run.id, 'Run ID generated');

  const attempt = store.createAttempt({
    runId: run.id,
    attemptNumber: 1,
    status: 'running',
    workerType: 'gemini_tool_calling',
    filesModified: ['src/index.ts'],
    durationMs: 1200,
    startedAt: new Date().toISOString(),
  });

  store.updateAttempt(attempt.id, {
    status: 'succeeded',
    completedAt: new Date().toISOString(),
    logs: 'Modified src/index.ts successfully',
  });

  store.updateRun(run.id, {
    status: 'completed',
    currentAttempt: 1,
    durationMs: 1200,
  });

  const attempts = store.listAttempts(run.id);
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(attempts[0].status, 'succeeded');
  console.log('✔ [PASS] Run and attempt execution lifecycle tracked with timing');

  // Test 4: Verification record persistence
  const verification = store.recordVerification({
    runId: run.id,
    attemptId: attempt.id,
    revisionSha: 'abc123commitsha',
    passed: true,
    checks: [
      { command: 'npm test', exitCode: 0, stdout: 'All tests pass', stderr: '', passed: true, durationMs: 2500 },
    ],
    criteriaVerified: ['crit-1'],
  });

  assert.strictEqual(verification.passed, true);
  const latestVer = store.getLatestVerification(run.id);
  assert.strictEqual(latestVer?.revisionSha, 'abc123commitsha');
  assert.strictEqual(latestVer?.checks[0].exitCode, 0);
  console.log('✔ [PASS] Verification records bind exact revision SHA and command output');

  // Test 5: Delivery records and PR deduplication
  const delivery = store.recordDelivery({
    runId: run.id,
    provider: 'github',
    repoUrl: 'https://github.com/marcelodevops/dupond-project-leader',
    baseCommit: task.baseCommit,
    deliveredCommit: 'abc123commitsha',
    branch: 'dupond/AEG-501-feature',
    prNumber: 42,
    prUrl: 'https://github.com/marcelodevops/dupond-project-leader/pull/42',
    ciStatus: 'pending',
    approvalStatus: 'approved',
    approvedBy: 'operator-1',
  });

  assert.strictEqual(delivery.prNumber, 42);
  const existingDelivery = store.getDeliveryByBranch('dupond/AEG-501-feature');
  assert.strictEqual(existingDelivery?.prUrl, 'https://github.com/marcelodevops/dupond-project-leader/pull/42');
  console.log('✔ [PASS] Delivery record stores PR URL, CI status and facilitates branch reconciliation');

  // Test 6: Restart reconciliation
  // Simulate active running run and task in progress
  const run2 = store.createRun({
    taskId: task.id,
    status: 'running',
    baseCommit: task.baseCommit,
    targetBranch: 'dupond/AEG-501-restart-test',
    currentAttempt: 1,
    durationMs: 500,
  });

  const reconciliation = store.reconcileOnRestart();
  assert.strictEqual(reconciliation.reconciledRuns, 1, 'Active run reconciled to failed');
  assert.strictEqual(reconciliation.unclaimedTasks, 1, 'In-progress task unclaimed back to todo');

  const reconciledRun = store.getRun(run2.id);
  assert.strictEqual(reconciledRun?.status, 'failed');
  assert.strictEqual(reconciledRun?.failureType, 'cancelled');

  const resetTask = store.getTask(task.id);
  assert.strictEqual(resetTask?.status, 'todo');
  assert.strictEqual(resetTask?.claimedBy, null);
  console.log('✔ [PASS] Restart reconciliation cleans up interrupted runs without phantom execution');

  // Test 7: Audit trail
  const audits = store.listAuditEvents(task.id);
  assert.ok(audits.length >= 3, 'Audit events captured for task lifecycle');
  console.log('✔ [PASS] Audit events recorded across task operations');

  console.log('\n=== ALL TASKSTORE TESTS PASSED CLEANLY ===');
}

main().catch((err) => {
  console.error('TaskStore test failed:', err);
  process.exit(1);
});
