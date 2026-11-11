import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/server/db/database.js';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.js';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.js';
import { GitHubDeliveryService } from '../src/server/delivery/githubDelivery.js';
import { RepairCoordinator } from '../src/server/coordinator/repairCoordinator.js';
import {
  resolveTargetRepository,
  canonicalizeRepoSlug,
  areRepoSlugsCompatible,
  isOrchestratorSelfTarget,
} from '../src/server/workspace/targetRepositoryResolver.js';
import { CodingWorkerAdapter, WorkerExecutionContext } from '../src/server/worker/types.js';

async function main() {
  console.log('===============================================================');
  console.log('=== TARGET SELECTION & REMOTE BASE ADVANCE TEST SUITE ===');
  console.log('===============================================================\n');

  const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp_target_drift_test_')));
  const bareRemoteDir = path.join(tmpBase, 'bare-remote.git');
  const clone1Dir = path.join(tmpBase, 'clone-1-work');
  const clone2Dir = path.join(tmpBase, 'clone-2-remote-dev');

  try {
    // ------------------------------------------------------------------------
    // Part 1: Fail Closed on Target Repository Selection
    // ------------------------------------------------------------------------
    console.log('--- Testing Target Repository Selection Fail-Closed Policies ---');

    // 1. Missing target configuration
    assert.throws(() => {
      resolveTargetRepository({});
    }, (err: any) => {
      assert.ok(err.message.includes('No target repository configured'));
      assert.ok(err.message.includes('Refusing to silently select the orchestrator repository'));
      return true;
    }, 'Missing target repository configuration must throw fail-closed');
    console.log('✔ [PASS] Missing target configuration fails closed');

    // 2. Non-existent local target path
    const nonExistentPath = path.join(tmpBase, 'does_not_exist');
    assert.throws(() => {
      resolveTargetRepository({ targetRepoPath: nonExistentPath });
    }, (err: any) => {
      assert.ok(err.message.includes('does not exist. A valid local checkout is required'));
      return true;
    }, 'Non-existent local target path must fail closed');
    console.log('✔ [PASS] Non-existent local target path fails closed');

    // 3. Non-git directory
    const emptyDir = path.join(tmpBase, 'empty_dir');
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.throws(() => {
      resolveTargetRepository({ targetRepoPath: emptyDir });
    }, (err: any) => {
      assert.ok(err.message.includes('is not a valid Git repository'));
      return true;
    }, 'Non-git target directory must fail closed');
    console.log('✔ [PASS] Non-git target directory fails closed');

    // 4. Remote-only target with no local checkout
    assert.throws(() => {
      resolveTargetRepository({ targetRepo: 'github.com/some-org/remote-only-repo' });
    }, (err: any) => {
      assert.ok(err.message.includes('remote reference with no local checkout'));
      assert.ok(err.message.includes('A valid local checkout is required'));
      return true;
    }, 'Remote-only target without local checkout must fail closed');
    console.log('✔ [PASS] Remote-only target without checkout explains local checkout is required');

    // 5. Silent fallback to orchestrator repository is prohibited
    assert.throws(() => {
      resolveTargetRepository({ targetRepoPath: process.cwd(), allowOrchestratorRepo: false });
    }, (err: any) => {
      assert.ok(err.message.includes('Never silently select the orchestrator repository'));
      return true;
    }, 'Silent fallback to orchestrator repository is prohibited');
    console.log('✔ [PASS] Silent fallback to orchestrator repository prohibited');

    // 6. Repository slug canonicalization and backward-compatibility with legacy slug
    assert.strictEqual(canonicalizeRepoSlug('marcelodevops/dupond-project-leader'), 'marcelodevops/dupond');
    assert.strictEqual(canonicalizeRepoSlug('git@github.com:marcelodevops/dupond-project-leader.git'), 'marcelodevops/dupond');
    assert.strictEqual(canonicalizeRepoSlug('https://github.com/marcelodevops/dupond.git'), 'marcelodevops/dupond');
    assert.strictEqual(canonicalizeRepoSlug('marcelodevops/other-repo'), 'marcelodevops/other-repo');

    assert.strictEqual(areRepoSlugsCompatible('marcelodevops/dupond-project-leader', 'marcelodevops/dupond'), true);
    assert.strictEqual(areRepoSlugsCompatible('git@github.com:marcelodevops/dupond-project-leader.git', 'https://github.com/marcelodevops/dupond.git'), true);
    assert.strictEqual(areRepoSlugsCompatible('marcelodevops/dupond', 'marcelodevops/dupond'), true);
    assert.strictEqual(areRepoSlugsCompatible('marcelodevops/dupond', 'marcelodevops/different-repo'), false);

    assert.strictEqual(isOrchestratorSelfTarget('marcelodevops/dupond'), true);
    assert.strictEqual(isOrchestratorSelfTarget('marcelodevops/dupond-project-leader'), true);
    assert.strictEqual(isOrchestratorSelfTarget('marcelodevops/unrelated-repo'), false);
    console.log('✔ [PASS] Repository rename compatibility and self-target protection verified');

    // ------------------------------------------------------------------------
    // Part 2: Remote Base Advanced Through a Second Clone
    // ------------------------------------------------------------------------
    console.log('\n--- Setting up Bare Remote and Dual Clones ---');

    // 1. Create bare remote with explicit default branch and symbolic HEAD
    fs.mkdirSync(bareRemoteDir, { recursive: true });
    execFileSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: bareRemoteDir });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareRemoteDir });
    execFileSync('git', ['--git-dir', bareRemoteDir, 'config', 'receive.shallowUpdate', 'true']);

    // 2. Setup Clone 1 (Dupond's target workspace repository)
    fs.mkdirSync(clone1Dir, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: clone1Dir });
    execFileSync('git', ['config', 'user.name', 'Dupond Clone 1'], { cwd: clone1Dir });
    execFileSync('git', ['config', 'user.email', 'dupond1@example.com'], { cwd: clone1Dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: clone1Dir });
    execFileSync('git', ['remote', 'add', 'origin', bareRemoteDir], { cwd: clone1Dir });

    // Initial files in target repo
    fs.mkdirSync(path.join(clone1Dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(clone1Dir, 'package.json'), JSON.stringify({ name: 'dual-clone-app', version: '1.0.0' }));
    fs.writeFileSync(path.join(clone1Dir, 'src', 'math.cjs'), `function add(a, b) { return a + b; }\nmodule.exports = { add };\n`);
    fs.writeFileSync(path.join(clone1Dir, 'test.js'), `const { add } = require('./src/math.cjs');\nif (add(1, 2) !== 3) process.exit(1);\nconsole.log('Math test OK');\n`);

    execFileSync('git', ['add', '-A'], { cwd: clone1Dir });
    execFileSync('git', ['commit', '-m', 'initial commit in target repo'], { cwd: clone1Dir });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: clone1Dir });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: clone1Dir });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareRemoteDir });

    const initialBaseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone1Dir, encoding: 'utf-8' }).trim();
    console.log(`[Setup] Base commit initialized on bare remote: ${initialBaseCommit}`);

    // 3. Setup Clone 2 (Independent clone representing remote base advancement)
    execFileSync('git', ['clone', '--branch', 'main', bareRemoteDir, clone2Dir]);
    execFileSync('git', ['checkout', 'main'], { cwd: clone2Dir });
    execFileSync('git', ['config', 'user.name', 'Second Clone Dev'], { cwd: clone2Dir });
    execFileSync('git', ['config', 'user.email', 'second@example.com'], { cwd: clone2Dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: clone2Dir });

    const store = new TaskStore(':memory:');
    const verifier = new AuthoritativeVerifier();
    const repairCoordinator = new RepairCoordinator(store, new WorkspaceManager(clone1Dir), verifier);
    const deliveryService = new GitHubDeliveryService(store, verifier);

    // ------------------------------------------------------------------------
    // Scenario A: Clean Integration & Approval Invalidation
    // ------------------------------------------------------------------------
    console.log('\n--- Scenario A: Remote Base Clean Integration & Approval Invalidation ---');

    const taskA = store.createTask({
      key: 'AEG-DRIFT-A',
      title: 'Add Subtract Function',
      description: 'Implement subtract in math.cjs',
      status: 'in_progress',
      priority: 'high',
      targetRepo: 'example/dual-clone-app',
      targetRepoPath: clone1Dir,
      baseCommit: initialBaseCommit,
      allowedPaths: ['src/**', 'test.js'],
      protectedPaths: [],
      verificationCommands: ['node test.js'],
      acceptanceCriteria: [{ id: 'crit-sub', title: 'Subtract works', completed: false, checkCommand: 'node test.js' }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
    });

    const subtractWorker: CodingWorkerAdapter = {
      name: 'subtract_worker',
      isAvailable: async () => ({ available: true }),
      execute: async (context: WorkerExecutionContext) => {
        fs.writeFileSync(path.join(context.worktreePath, 'src', 'math.cjs'), `function add(a, b) { return a + b; }\nfunction subtract(a, b) { return a - b; }\nmodule.exports = { add, subtract };\n`);
        fs.writeFileSync(path.join(context.worktreePath, 'test.js'), `const { add, subtract } = require('./src/math.cjs');\nif (add(1, 2) !== 3 || subtract(5, 2) !== 3) process.exit(1);\nconsole.log('Subtract test OK');\n`);
        return {
          success: true,
          filesModified: ['src/math.cjs', 'test.js'],
          diff: '+subtract',
          commitMessage: 'feat: add subtract',
          logs: ['Implemented subtract'],
          durationMs: 50,
        };
      },
    };

    const runA = await repairCoordinator.executeTaskRun({ task: taskA, worker: subtractWorker });
    assert.strictEqual(runA.status, 'completed', 'Task A run must complete');
    const workerCommitA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runA.worktreePath!, encoding: 'utf-8' }).trim();

    // Now Clone 2 advances main on bare remote with an independent non-conflicting commit
    fs.writeFileSync(path.join(clone2Dir, 'README.md'), '# Dual Clone Project\nDocumentation updated remotely.\n');
    execFileSync('git', ['add', 'README.md'], { cwd: clone2Dir });
    execFileSync('git', ['commit', '-m', 'docs: add README from clone 2'], { cwd: clone2Dir });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone2Dir });
    const remoteBaseShaA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone2Dir, encoding: 'utf-8' }).trim();

    // Delivery attempt 1: Notice that Clone 1 local repository does NOT have the new commit cached.
    // GitHubDeliveryService MUST fetch the remote base, merge it, re-verify, and invalidate approval!
    const deliveryAttempt1 = await deliveryService.dispatchDelivery({
      runId: runA.id,
      isApproved: true,
      approvedBy: 'operator-1',
      repoUrl: 'example/dual-clone-app',
      targetBaseBranch: 'main',
    });

    assert.strictEqual(deliveryAttempt1.success, false, 'Delivery must block when remote base drift creates a new revision');
    assert.strictEqual(deliveryAttempt1.status, 403, 'Must return HTTP 403 approval required');
    assert.strictEqual(deliveryAttempt1.approvalRequired, true);
    assert.notStrictEqual(deliveryAttempt1.deliveredCommit, workerCommitA, 'New revision must be different from pre-drift commit');
    assert.ok(deliveryAttempt1.error?.includes('Prior approval for') && deliveryAttempt1.error?.includes('is invalidated'));
    console.log('✔ [PASS] Base drift detected via git fetch; prior approval invalidated fail-closed');

    // Operator inspects new integrated revision and explicitly approves it
    const deliveryAttempt2 = await deliveryService.dispatchDelivery({
      runId: runA.id,
      isApproved: true,
      approvedBy: 'operator-reapproved',
      repoUrl: 'example/dual-clone-app',
      targetBaseBranch: 'main',
    });

    assert.strictEqual(deliveryAttempt2.success, true, 'Delivery with re-approved merged commit must succeed');
    assert.strictEqual(deliveryAttempt2.status, 200);
    assert.strictEqual(deliveryAttempt2.deliveredCommit, deliveryAttempt1.deliveredCommit);

    // Verify bare remote contains both the worker change AND the clone 2 README change
    const remoteReadme = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', `${runA.targetBranch}:README.md`], { encoding: 'utf-8' });
    assert.ok(remoteReadme.includes('Documentation updated remotely'), 'Remote bare must have Clone 2 commit');
    const remoteMath = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', `${runA.targetBranch}:src/math.cjs`], { encoding: 'utf-8' });
    assert.ok(remoteMath.includes('function subtract'), 'Remote bare must have worker subtract');
    console.log('✔ [PASS] Clean remote base integration verified and delivered to remote origin');

    // ------------------------------------------------------------------------
    // Scenario B: Remote Base Conflict Through Second Clone
    // ------------------------------------------------------------------------
    console.log('\n--- Scenario B: Remote Base Conflict Through Second Clone ---');

    // Pull latest main into Clone 2
    execFileSync('git', ['pull', 'origin', 'main'], { cwd: clone2Dir });

    const taskB = store.createTask({
      key: 'AEG-DRIFT-B',
      title: 'Conflicting Change Task',
      description: 'Changes math.cjs in a way that conflicts with clone 2',
      status: 'in_progress',
      priority: 'high',
      targetRepo: 'example/dual-clone-app',
      targetRepoPath: clone1Dir,
      baseCommit: remoteBaseShaA,
      allowedPaths: ['src/**'],
      protectedPaths: [],
      verificationCommands: ['node test.js'],
      acceptanceCriteria: [{ id: 'crit-b', title: 'Check', completed: false, checkCommand: 'node test.js' }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
    });

    const conflictWorker: CodingWorkerAdapter = {
      name: 'conflict_worker',
      isAvailable: async () => ({ available: true }),
      execute: async (context: WorkerExecutionContext) => {
        fs.writeFileSync(path.join(context.worktreePath, 'src', 'math.cjs'), `// WORKER VERSION\nfunction add(a, b) { return a + b + 0; }\nmodule.exports = { add };\n`);
        return {
          success: true,
          filesModified: ['src/math.cjs'],
          diff: 'worker math.cjs',
          commitMessage: 'feat: worker change',
          logs: ['worker updated math.cjs'],
          durationMs: 30,
        };
      },
    };

    const runB = await repairCoordinator.executeTaskRun({ task: taskB, worker: conflictWorker });
    assert.strictEqual(runB.status, 'completed');

    // Clone 2 edits the exact same line in math.cjs and pushes to main
    fs.writeFileSync(path.join(clone2Dir, 'src', 'math.cjs'), `// CLONE 2 VERSION\nfunction add(a, b) { return (a + b) | 0; }\nmodule.exports = { add };\n`);
    execFileSync('git', ['add', 'src/math.cjs'], { cwd: clone2Dir });
    execFileSync('git', ['commit', '-m', 'conflicting change on main from clone 2'], { cwd: clone2Dir });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone2Dir });

    // Dupond delivery attempt: must fail-closed on merge conflict
    const conflictResult = await deliveryService.dispatchDelivery({
      runId: runB.id,
      isApproved: true,
      approvedBy: 'operator-1',
      repoUrl: 'example/dual-clone-app',
      targetBaseBranch: 'main',
    });

    assert.strictEqual(conflictResult.success, false, 'Delivery must fail when remote base conflicts');
    assert.strictEqual(conflictResult.status, 409, 'Must return HTTP 409 conflict');
    assert.strictEqual(conflictResult.blocked, true);
    assert.ok(conflictResult.error?.includes('could not be merged cleanly'));
    console.log('✔ [PASS] Remote base merge conflict blocked fail-closed with HTTP 409');

    // ------------------------------------------------------------------------
    // Scenario C: Remote Base Breaking Verification Checks Through Second Clone
    // ------------------------------------------------------------------------
    console.log('\n--- Scenario C: Remote Base Breaking Tests Through Second Clone ---');

    // Clone 2 advances main with a change to test.js that requires a new exported function
    fs.writeFileSync(path.join(clone2Dir, 'test.js'), `const { add, multiply } = require('./src/math.cjs');\nif (multiply(2, 3) !== 6) process.exit(1);\n`);
    execFileSync('git', ['add', 'test.js'], { cwd: clone2Dir });
    execFileSync('git', ['commit', '-m', 'break math tests by requiring multiply'], { cwd: clone2Dir });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone2Dir });
    const brokenRemoteBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone2Dir, encoding: 'utf-8' }).trim();

    const taskC = store.createTask({
      key: 'AEG-DRIFT-C',
      title: 'Worker does not implement multiply',
      description: 'Clean merge with main, but fails new test on main',
      status: 'in_progress',
      priority: 'high',
      targetRepo: 'example/dual-clone-app',
      targetRepoPath: clone1Dir,
      baseCommit: remoteBaseShaA,
      allowedPaths: ['src/**'],
      protectedPaths: [],
      verificationCommands: ['node test.js'],
      acceptanceCriteria: [{ id: 'crit-c', title: 'Test check', completed: false, checkCommand: 'node test.js' }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
    });

    const runC = await repairCoordinator.executeTaskRun({
      task: taskC,
      worker: {
        name: 'non_multiply_worker',
        isAvailable: async () => ({ available: true }),
        execute: async (context: WorkerExecutionContext) => {
          fs.writeFileSync(path.join(context.worktreePath, 'src', 'notes.txt'), 'worker notes\n');
          return {
            success: true,
            filesModified: ['src/notes.txt'],
            diff: 'notes',
            commitMessage: 'feat: add notes',
            logs: ['added notes'],
            durationMs: 30,
          };
        },
      },
    });
    assert.strictEqual(runC.status, 'completed');

    // Delivery attempt: Clean merge will succeed, but authoritative re-validation will fail!
    const brokenCheckResult = await deliveryService.dispatchDelivery({
      runId: runC.id,
      isApproved: true,
      approvedBy: 'operator-1',
      repoUrl: 'example/dual-clone-app',
      targetBaseBranch: 'main',
    });

    assert.strictEqual(brokenCheckResult.success, false, 'Delivery must fail when combined changes fail re-validation');
    assert.strictEqual(brokenCheckResult.status, 409, 'Must return HTTP 409');
    assert.strictEqual(brokenCheckResult.blocked, true);
    assert.ok(brokenCheckResult.error?.includes('combined changes failed re-validation'));
    console.log('✔ [PASS] Combined changes failing authoritative verification blocked fail-closed with HTTP 409');

    // ------------------------------------------------------------------------
    // Scenario D: Unavailable Remote Reference Fails Closed (HTTP 502)
    // ------------------------------------------------------------------------
    console.log('\n--- Scenario D: Unavailable Remote Reference Fails Closed ---');

    const unavailableResult = await deliveryService.dispatchDelivery({
      runId: runA.id,
      isApproved: true,
      approvedBy: 'operator-1',
      repoUrl: 'example/dual-clone-app',
      targetBaseBranch: 'nonexistent-remote-branch-xyz',
    });

    assert.strictEqual(unavailableResult.success, false, 'Delivery must fail when remote branch does not exist');
    assert.strictEqual(unavailableResult.status, 502, 'Must return HTTP 502 Bad Gateway');
    assert.strictEqual(unavailableResult.blocked, true);
    assert.ok(unavailableResult.error?.includes('Failed to fetch remote base branch'));
    console.log('✔ [PASS] Unavailable remote reference blocked fail-closed with HTTP 502');

    // ------------------------------------------------------------------------
    // Part 3: Repository Identity Guards Are Not Name-Shaped
    // ------------------------------------------------------------------------
    console.log('\n--- Part 3: Target Identity Guards (Name Bypass & Request Override) ---');

    // A repository whose *name* contains the word used by test fixtures must not
    // be mistaken for a test stand-in. The exemption is transport, not vocabulary.
    const mirrorDir = path.join(tmpBase, 'mirror-with-remote-name');
    fs.mkdirSync(mirrorDir, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: mirrorDir });
    execFileSync('git', ['config', 'user.name', 'Mirror Repo'], { cwd: mirrorDir });
    execFileSync('git', ['config', 'user.email', 'mirror@example.com'], { cwd: mirrorDir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: mirrorDir });
    fs.writeFileSync(path.join(mirrorDir, 'package.json'), JSON.stringify({ name: 'mirror-app', version: '1.0.0' }));
    execFileSync('git', ['add', '-A'], { cwd: mirrorDir });
    execFileSync('git', ['commit', '-m', 'mirror initial'], { cwd: mirrorDir });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: mirrorDir });
    // Non-resolving host (RFC 6761) with a repository name shaped like a fixture.
    execFileSync('git', ['remote', 'add', 'origin', 'https://identity-guards.invalid/acme/disposable-mirror.git'], { cwd: mirrorDir });

    assert.throws(() => {
      resolveTargetRepository({ targetRepo: 'acme/real-service', targetRepoPath: mirrorDir });
    }, (err: any) => {
      assert.ok(err.message.includes('Target repository mismatch'), `Expected mismatch refusal, got: ${err.message}`);
      return true;
    }, 'A network remote must be identity-checked even when its name contains a fixture word');
    console.log('✔ [PASS] Fixture-shaped remote name no longer skips the identity check');

    const matchedTarget = resolveTargetRepository({ targetRepo: 'acme/disposable-mirror', targetRepoPath: mirrorDir });
    assert.strictEqual(matchedTarget.repoPath, fs.realpathSync(mirrorDir), 'Exact remote match must still resolve');
    console.log('✔ [PASS] Matching configured target still resolves normally');

    // The sanctioned fixture shape is a local filesystem remote, which carries no
    // network identity to compare.
    const localRemoteExempt = resolveTargetRepository({ targetRepo: 'acme/real-service', targetRepoPath: clone1Dir });
    assert.strictEqual(localRemoteExempt.repoPath, fs.realpathSync(clone1Dir), 'Local bare remote must remain exempt');
    console.log('✔ [PASS] Local filesystem remote remains exempt by transport');

    // A request must not be able to rename the identity the remote is compared to.
    const overrideAttempt = await deliveryService.dispatchDelivery({
      runId: runA.id,
      isApproved: true,
      approvedBy: 'operator-override',
      repoUrl: 'evil-org/attacker-repo',
      targetBaseBranch: 'main',
    });
    assert.strictEqual(overrideAttempt.success, false, 'Conflicting request repoUrl must be refused');
    assert.strictEqual(overrideAttempt.status, 400);
    assert.strictEqual(overrideAttempt.blocked, true);
    assert.ok(overrideAttempt.error?.includes('conflicts with the target recorded for run'), `Got: ${overrideAttempt.error}`);
    console.log('✔ [PASS] Request repoUrl conflicting with the persisted run target is rejected');

    const agreeingAttempt = await deliveryService.dispatchDelivery({
      runId: runA.id,
      isApproved: true,
      approvedBy: 'operator-agree',
      repoUrl: 'example/dual-clone-app',
      targetBaseBranch: 'main',
    });
    assert.ok(!agreeingAttempt.error?.includes('conflicts with the target recorded'), 'Agreeing repoUrl must not be refused as an override');
    console.log('✔ [PASS] Request repoUrl agreeing with the persisted target is still accepted');

    // Delivery must refuse a workspace whose delivery remote mismatches the run's
    // recorded target, before any push is attempted.
    const mirrorWorktree = new WorkspaceManager(mirrorDir).createWorktree(
      `identity-guard-run-${Date.now()}`,
      `dupond/identity-guard-${Date.now()}`,
      'main',
    );
    const guardTask = store.createTask({
      key: 'AEG-GUARD-1',
      title: 'Identity Guard Delivery Task',
      description: 'Delivery must bind to the recorded target repository',
      status: 'review',
      priority: 'high',
      targetRepo: 'acme/real-service',
      targetRepoPath: mirrorDir,
      baseCommit: mirrorWorktree.baseCommit,
      allowedPaths: ['*'],
      protectedPaths: [],
      verificationCommands: ['echo ok'],
      acceptanceCriteria: [{ id: 'crit-guard', title: 'Guarded', completed: true }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
    });
    const guardRun = store.createRun({
      id: `identity-guard-run-${Date.now()}`,
      taskId: guardTask.id,
      status: 'completed',
      targetRepo: 'acme/real-service',
      baseCommit: mirrorWorktree.baseCommit,
      targetBranch: mirrorWorktree.branch,
      worktreePath: mirrorWorktree.worktreePath,
      currentAttempt: 1,
      durationMs: 100,
    });
    const guardAttempt = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: mirrorWorktree.worktreePath, encoding: 'utf-8' }).trim();
    store.recordVerification({
      runId: guardRun.id,
      attemptId: store.createAttempt({
        runId: guardRun.id,
        attemptNumber: 1,
        status: 'succeeded',
        workerType: 'test',
        filesModified: [],
        durationMs: 10,
        startedAt: new Date().toISOString(),
      }).id,
      revisionSha: guardAttempt,
      passed: true,
      checks: [{ command: 'echo ok', exitCode: 0, stdout: 'ok', stderr: '', passed: true, durationMs: 5 }],
      criteriaVerified: ['crit-guard'],
    });

    const guardDelivery = await deliveryService.dispatchDelivery({
      runId: guardRun.id,
      isApproved: true,
      approvedBy: 'operator-guard',
      targetBaseBranch: 'main',
    });
    assert.strictEqual(guardDelivery.success, false, 'Mismatched delivery remote must be refused');
    assert.strictEqual(guardDelivery.status, 400);
    assert.strictEqual(guardDelivery.blocked, true);
    assert.ok(guardDelivery.error?.includes('does not match configured target repository'), `Got: ${guardDelivery.error}`);
    console.log('✔ [PASS] Delivery blocked on remote/target mismatch before any push');

    // A run with no recorded target has nothing to validate against and must not
    // fall back to whatever the caller supplies.
    const unrecordedTask = store.createTask({
      key: 'AEG-GUARD-2',
      title: 'Unrecorded Target Task',
      description: 'No repository identity was ever recorded for this work',
      status: 'review',
      priority: 'high',
      targetRepo: '',
      baseCommit: runA.baseCommit,
      allowedPaths: ['*'],
      protectedPaths: [],
      verificationCommands: ['echo ok'],
      acceptanceCriteria: [{ id: 'crit-unrecorded', title: 'Guarded', completed: true }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
    });
    const unrecordedRun = store.createRun({
      id: `unrecorded-target-run-${Date.now()}`,
      taskId: unrecordedTask.id,
      status: 'completed',
      targetRepo: '',
      baseCommit: runA.baseCommit,
      targetBranch: runA.targetBranch,
      worktreePath: runA.worktreePath,
      currentAttempt: 1,
      durationMs: 100,
    });
    const unrecordedDelivery = await deliveryService.dispatchDelivery({
      runId: unrecordedRun.id,
      isApproved: true,
      approvedBy: 'operator-unrecorded',
      repoUrl: 'example/dual-clone-app',
      targetBaseBranch: 'main',
    });
    assert.strictEqual(unrecordedDelivery.success, false, 'Run without a persisted target must fail closed');
    assert.strictEqual(unrecordedDelivery.blocked, true);
    assert.ok(unrecordedDelivery.error?.includes('no persisted target repository'), `Got: ${unrecordedDelivery.error}`);
    console.log('✔ [PASS] Run without a persisted target repository fails closed');

  } finally {
    if (fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  }


  console.log('\n===============================================================');
  console.log('=== ALL TARGET SELECTION & REMOTE BASE TESTS PASSED CLEANLY ===');
  console.log('===============================================================');
}

test('suite', main);
