import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/server/db/database.ts';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.ts';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.ts';
import { GitHubDeliveryService } from '../src/server/delivery/githubDelivery.ts';

async function main() {
  console.log('=== RUNNING GITHUB DELIVERY & RECONCILIATION TESTS ===\n');

  const store = new TaskStore(':memory:');
  const workspaceManager = new WorkspaceManager(process.cwd());
  const verifier = new AuthoritativeVerifier();
  const deliveryService = new GitHubDeliveryService(store, verifier);

  // Setup: create task and run with an isolated worktree
  const runId = `delivery-test-${Date.now()}`;
  const branchName = `dupond/delivery-test-branch-${Date.now()}`;
  const worktree = workspaceManager.createWorktree(runId, branchName, 'HEAD');

  // Make and commit a small change in worktree
  const testFile = path.resolve(worktree.worktreePath, 'deliveredFeature.txt');
  fs.writeFileSync(testFile, 'Verified feature content\n');
  execFileSync('git', ['add', '-A'], { cwd: worktree.worktreePath });
  execFileSync('git', ['commit', '-m', 'feat: verified feature delivery'], { cwd: worktree.worktreePath });
  const deliveredCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree.worktreePath, encoding: 'utf-8' }).trim();

  // Create disposable bare repository to safely test push operations without touching remote
  const disposableRemote = path.resolve(process.cwd(), `.dupond_worktrees/disposable-remote-${Date.now()}.git`);
  fs.mkdirSync(disposableRemote, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: disposableRemote });
  execFileSync('git', ['--git-dir', disposableRemote, 'config', 'receive.shallowUpdate', 'true']);
  execFileSync('git', ['push', disposableRemote, `${worktree.baseCommit}:refs/heads/main`], { cwd: process.cwd() });

  const task = store.createTask({
    key: 'AEG-801',
    title: 'Delivery Verification Task',
    description: 'Ensure PR delivery policies and reconciliation work',
    status: 'review',
    priority: 'high',
    targetRepo: 'marcelodevops/dupond',
    baseCommit: worktree.baseCommit,
    allowedPaths: ['*'],
    protectedPaths: [],
    verificationCommands: ['echo ok'],
    acceptanceCriteria: [{ id: 'crit-del', title: 'Delivered', completed: true }],
    workerConfig: { provider: 'test', model: 'test' },
    maxAttempts: 1,
    timeoutSeconds: 60,
    requireApproval: true, // Requires explicit operator approval
  });

  const run = store.createRun({
    id: runId,
    taskId: task.id,
    status: 'completed',
    baseCommit: worktree.baseCommit,
    targetBranch: branchName,
    worktreePath: worktree.worktreePath,
    currentAttempt: 1,
    durationMs: 500,
  });

  const attempt = store.createAttempt({
    runId: run.id,
    attemptNumber: 1,
    status: 'succeeded',
    workerType: 'test',
    filesModified: ['deliveredFeature.txt'],
    durationMs: 200,
    startedAt: new Date().toISOString(),
  });

  try {
    // Test 1: Delivery blocked without passing quality gates
    const unverifiedResult = await deliveryService.dispatchDelivery({
      runId: run.id,
      isApproved: true,
      disposableRemoteDir: disposableRemote,
    });
    assert.strictEqual(unverifiedResult.success, false);
    assert.strictEqual(unverifiedResult.status, 400);
    assert.ok(unverifiedResult.error?.includes('has not passed authoritative quality gates'));
    console.log('✔ [PASS] Delivery blocked fail-closed when quality gates are unverified');

    // Record passing verification
    store.recordVerification({
      runId: run.id,
      attemptId: attempt.id,
      revisionSha: deliveredCommit,
      passed: true,
      checks: [{ command: 'echo ok', exitCode: 0, stdout: 'ok', stderr: '', passed: true, durationMs: 10 }],
      criteriaVerified: ['crit-del'],
    });

    // Test 2: Delivery blocked by approval policy when isApproved is false
    const unapprovedResult = await deliveryService.dispatchDelivery({
      runId: run.id,
      isApproved: false,
      disposableRemoteDir: disposableRemote,
    });
    assert.strictEqual(unapprovedResult.success, false);
    assert.strictEqual(unapprovedResult.status, 403);
    assert.strictEqual(unapprovedResult.approvalRequired, true);
    assert.ok(unapprovedResult.error?.includes('requires explicit operator approval'));

    // Test 2b: Delivery blocked by approval policy when isApproved or approvedBy are omitted
    const omittedApprovalResult = await deliveryService.dispatchDelivery({
      runId: run.id,
      disposableRemoteDir: disposableRemote,
    });
    assert.strictEqual(omittedApprovalResult.success, false);
    assert.strictEqual(omittedApprovalResult.status, 403);
    assert.strictEqual(omittedApprovalResult.approvalRequired, true);

    const missingApproverResult = await deliveryService.dispatchDelivery({
      runId: run.id,
      isApproved: true,
      // approvedBy omitted
      disposableRemoteDir: disposableRemote,
    });
    assert.strictEqual(missingApproverResult.success, false);
    assert.strictEqual(missingApproverResult.status, 403);
    assert.strictEqual(missingApproverResult.approvalRequired, true);
    console.log('✔ [PASS] Backend approval policy prevents unauthorized PR delivery (defaults to denied)');

    // Test 3: Approved delivery succeeds against disposable remote
    const deliveryResult = await deliveryService.dispatchDelivery({
      runId: run.id,
      isApproved: true,
      approvedBy: 'lead-devops-operator',
      disposableRemoteDir: disposableRemote,
      repoUrl: 'marcelodevops/dupond',
    });

    assert.strictEqual(deliveryResult.success, true);
    assert.strictEqual(deliveryResult.status, 200);
    assert.ok(deliveryResult.prUrl?.includes('/pull/'), 'PR URL generated');
    assert.strictEqual(deliveryResult.deliveredCommit, deliveredCommit);
    assert.strictEqual(deliveryResult.baseCommit, worktree.baseCommit);

    const updatedTask = store.getTask(task.id);
    assert.strictEqual(updatedTask?.status, 'done', 'Task advanced to done upon verified delivery');
    console.log(`✔ [PASS] Approved delivery pushed branch and recorded PR (${deliveryResult.prUrl})`);

    // Test 4: Idempotent delivery reconciliation - repeating delivery returns existing PR without duplicate creation
    const repeatedDeliveryResult = await deliveryService.dispatchDelivery({
      runId: run.id,
      isApproved: true,
      approvedBy: 'lead-devops-operator',
      disposableRemoteDir: disposableRemote,
    });

    assert.strictEqual(repeatedDeliveryResult.success, true);
    assert.strictEqual(repeatedDeliveryResult.prUrl, deliveryResult.prUrl, 'Must return same PR URL');
    assert.ok(repeatedDeliveryResult.message?.includes('Existing pull request reconciled'), 'Reconciliation message returned');
    console.log('✔ [PASS] Repeated delivery reconciles existing branch & PR without creating duplicates');

  } finally {
    workspaceManager.cleanupWorktree(worktree.worktreePath, branchName);
    if (fs.existsSync(disposableRemote)) {
      fs.rmSync(disposableRemote, { recursive: true, force: true });
    }
  }

  console.log('\n=== ALL DELIVERY & RECONCILIATION TESTS PASSED CLEANLY ===');
}

main().catch((err) => {
  console.error('Delivery test failed:', err);
  process.exit(1);
});
