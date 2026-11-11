import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/server/db/database.ts';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.ts';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.ts';
import { GitHubDeliveryService } from '../src/server/delivery/githubDelivery.ts';
import { RepairCoordinator } from '../src/server/coordinator/repairCoordinator.ts';
import { CodingWorkerAdapter } from '../src/server/worker/types.ts';

async function main() {
  console.log('=== PROVING SEPARATE DISPOSABLE REPOSITORY WORKSPACE SELECTION & PR DELIVERY ===\n');

  const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp_disposable_test_')));
  const bareRemoteDir = path.join(tmpBase, 'disposable-remote.git');
  const disposableRepoDir = path.join(tmpBase, 'disposable-repo');

  // 1. Create bare remote repository (serves as origin for the disposable repository)
  fs.mkdirSync(bareRemoteDir, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: bareRemoteDir });
  execFileSync('git', ['--git-dir', bareRemoteDir, 'config', 'receive.shallowUpdate', 'true']);

  // 2. Initialize separate disposable local repository
  fs.mkdirSync(disposableRepoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: disposableRepoDir });
  execFileSync('git', ['config', 'user.name', 'Disposable Test'], { cwd: disposableRepoDir });
  execFileSync('git', ['config', 'user.email', 'disposable@example.com']);
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: disposableRepoDir });
  execFileSync('git', ['remote', 'add', 'origin', bareRemoteDir], { cwd: disposableRepoDir });

  // Initial files in disposable repository
  const pkgJson = {
    name: 'disposable-app',
    version: '1.0.0',
    scripts: { test: 'node test.js' },
  };
  fs.writeFileSync(path.join(disposableRepoDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

  fs.mkdirSync(path.join(disposableRepoDir, 'src'), { recursive: true });
  const initialCalc = `function multiply(a, b) { return a * b; }\nmodule.exports = { multiply };\n`;
  fs.writeFileSync(path.join(disposableRepoDir, 'src', 'calculator.cjs'), initialCalc);

  const testFile = `const { multiply } = require('./src/calculator.cjs');\nif (multiply(3, 4) !== 12) process.exit(1);\nconsole.log('Initial tests pass');\n`;
  fs.writeFileSync(path.join(disposableRepoDir, 'test.js'), testFile);

  execFileSync('git', ['add', '-A'], { cwd: disposableRepoDir });
  execFileSync('git', ['commit', '-m', 'initial commit in disposable repository'], { cwd: disposableRepoDir });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: disposableRepoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: disposableRepoDir });

  const initialBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: disposableRepoDir, encoding: 'utf-8' }).trim();
  console.log(`[Setup] Disposable repository initialized at ${disposableRepoDir} (base: ${initialBaseSha})`);
  console.log(`[Setup] Bare remote repository at ${bareRemoteDir}`);

  // Snapshot Dupond's own directory status
  const dupondBranchesBefore = execFileSync('git', ['branch'], { cwd: process.cwd(), encoding: 'utf-8' });
  const dupondGitStatusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: process.cwd(), encoding: 'utf-8' });

  // 3. Configure Dupond Coordinator with the separate repository
  const store = new TaskStore(':memory:');
  const verifier = new AuthoritativeVerifier();
  const deliveryService = new GitHubDeliveryService(store, verifier);
  const repairCoordinator = new RepairCoordinator(store, new WorkspaceManager(disposableRepoDir), verifier);

  const customWorker: CodingWorkerAdapter = {
    name: 'disposable_worker',
    isAvailable: async () => ({ available: true }),
    execute: async (context) => {
      // Worker edits files inside the prepared worktree (which must belong to disposableRepoDir)
      const worktreeCalcPath = path.join(context.worktreePath, 'src', 'calculator.cjs');
      const worktreeTestPath = path.join(context.worktreePath, 'test.js');

      assert.ok(fs.existsSync(worktreeCalcPath), 'Target worktree must contain disposable repo file');
      assert.ok(context.worktreePath.startsWith(disposableRepoDir), 'Worktree must be rooted inside disposable repository root');

      const updatedCalc = `function multiply(a, b) { return a * b; }\nfunction power(a, b) { return Math.pow(a, b); }\nmodule.exports = { multiply, power };\n`;
      fs.writeFileSync(worktreeCalcPath, updatedCalc);

      const updatedTest = `const { multiply, power } = require('./src/calculator.cjs');\nif (multiply(3, 4) !== 12) process.exit(1);\nif (!power || power(2, 3) !== 8) process.exit(1);\nconsole.log('Power tests pass!');\n`;
      fs.writeFileSync(worktreeTestPath, updatedTest);

      return {
        success: true,
        filesModified: ['src/calculator.cjs', 'test.js'],
        diff: '+function power',
        commitMessage: 'feat: add power function',
        logs: ['File src/calculator.cjs updated', 'File test.js updated'],
        durationMs: 150,
      };
    },
  };

  try {
    // ------------------------------------------------------------------------
    // Part 1: Task Execution in Separate Repository
    // ------------------------------------------------------------------------
    const taskRecord = store.createTask({
      key: 'AEG-DISP-01',
      title: 'Add Power Function to Disposable App',
      description: 'Implement power(a, b) in calculator.cjs within separate repository',
      status: 'in_progress',
      priority: 'high',
      targetRepo: 'disposable-org/disposable-repo',
      targetRepoPath: disposableRepoDir,
      baseCommit: initialBaseSha,
      allowedPaths: ['src/**', 'test.js'],
      protectedPaths: ['.github/**', 'package.json'],
      verificationCommands: ['node test.js'],
      acceptanceCriteria: [{
        id: 'crit-pow',
        title: 'power(2, 3) = 8',
        completed: false,
        checkCommand: 'node test.js',
      }],
      workerConfig: { provider: 'custom', model: 'mock' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
    });

    const run = await repairCoordinator.executeTaskRun({
      task: taskRecord,
      worker: customWorker,
    });

    if (run.status !== 'completed') {
      console.error('[Run Failure Reason]:', run.failureReason, run.failureType);
    }
    assert.strictEqual(run.status, 'completed', 'Execution run must complete successfully');
    assert.strictEqual(run.baseCommit, initialBaseSha, 'Run base commit must match initial commit of disposable repo');
    assert.ok(run.worktreePath?.startsWith(disposableRepoDir), 'Worktree path must reside under disposable repo');

    const latestVer = store.getLatestVerification(run.id);
    assert.ok(latestVer && latestVer.passed, 'Authoritative verification must pass');
    console.log('✔ [PASS] Dupond isolated workspace prepared and executed inside separate disposable repository');

    // ------------------------------------------------------------------------
    // Part 2: Delivery to Separate Repository's Origin
    // ------------------------------------------------------------------------
    const deliveryResult = await deliveryService.dispatchDelivery({
      runId: run.id,
      isApproved: true,
      approvedBy: 'qa-lead',
      repoUrl: 'disposable-org/disposable-repo',
      targetBaseBranch: 'main',
    });

    assert.strictEqual(deliveryResult.success, true, 'Delivery must succeed');
    assert.strictEqual(deliveryResult.status, 200);
    assert.ok(deliveryResult.prUrl?.includes('disposable-org/disposable-repo/pull/'), 'PR URL points to disposable repository');
    console.log(`✔ [PASS] Delivery pushed branch and opened PR for disposable repository: ${deliveryResult.prUrl}`);

    // Verify remote bare repository actually received the pushed branch and commit!
    const remoteBranches = execFileSync('git', ['--git-dir', bareRemoteDir, 'branch'], { encoding: 'utf-8' });
    assert.ok(remoteBranches.includes(run.targetBranch), `Bare remote must contain delivered branch ${run.targetBranch}`);

    const deliveredFileInRemote = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', `${run.targetBranch}:src/calculator.cjs`], { encoding: 'utf-8' });
    assert.ok(deliveredFileInRemote.includes('function power(a, b)'), 'Delivered commit in bare remote contains power function');
    console.log('✔ [PASS] Disposable bare remote received branch and verified code modifications');

    // ------------------------------------------------------------------------
    // Part 3: Verify Dupond's Own Repository Remains Untouched
    // ------------------------------------------------------------------------
    const dupondBranchesAfter = execFileSync('git', ['branch'], { cwd: process.cwd(), encoding: 'utf-8' });
    const dupondGitStatusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: process.cwd(), encoding: 'utf-8' });

    assert.strictEqual(dupondBranchesAfter, dupondBranchesBefore, "Dupond's own git branches must be untouched");
    assert.strictEqual(dupondGitStatusAfter, dupondGitStatusBefore, "Dupond's own working tree must have no modified files");
    console.log("✔ [PASS] Dupond repository completely isolated and untouched by separate repo execution");

    // ------------------------------------------------------------------------
    // Part 4: Base-Drift Verification (Merging updated base and verifying combined result)
    // ------------------------------------------------------------------------
    console.log('\n--- Testing Base-Drift Reconciliation in Disposable Repository ---');

    // Create a new task based on the current branch commit
    const taskRecord2 = store.createTask({
      key: 'AEG-DISP-02',
      title: 'Add Divide Function to Disposable App',
      description: 'Implement divide(a, b)',
      status: 'in_progress',
      priority: 'high',
      targetRepo: 'disposable-org/disposable-repo',
      targetRepoPath: disposableRepoDir,
      baseCommit: initialBaseSha,
      allowedPaths: ['src/**', 'test.js'],
      protectedPaths: ['.github/**', 'package.json'],
      verificationCommands: ['node test.js'],
      acceptanceCriteria: [{
        id: 'crit-div',
        title: 'divide(10, 2) = 5',
        completed: false,
        checkCommand: 'node test.js',
      }],
      workerConfig: { provider: 'custom', model: 'mock' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
    });

    const divideWorker: CodingWorkerAdapter = {
      name: 'divide_worker',
      isAvailable: async () => ({ available: true }),
      execute: async (context) => {
        const calcPath = path.join(context.worktreePath, 'src', 'calculator.cjs');
        const testPath = path.join(context.worktreePath, 'test.js');

        fs.writeFileSync(calcPath, `function multiply(a, b) { return a * b; }\nfunction divide(a, b) { return a / b; }\nmodule.exports = { multiply, divide };\n`);
        fs.writeFileSync(testPath, `const { multiply, divide } = require('./src/calculator.cjs');\nif (multiply(3, 4) !== 12) process.exit(1);\nif (!divide || divide(10, 2) !== 5) process.exit(1);\nconsole.log('Divide tests pass!');\n`);

        return {
          success: true,
          filesModified: ['src/calculator.cjs', 'test.js'],
          diff: '+function divide',
          commitMessage: 'feat: add divide',
          logs: ['Implemented divide'],
          durationMs: 100,
        };
      },
    };

    const run2 = await repairCoordinator.executeTaskRun({
      task: taskRecord2,
      worker: divideWorker,
    });

    assert.strictEqual(run2.status, 'completed');
    const preDriftCommit = run2.worktreePath ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: run2.worktreePath, encoding: 'utf-8' }).trim() : '';

    // Now advance main base branch in disposable repo with an independent non-conflicting commit
    fs.writeFileSync(path.join(disposableRepoDir, 'README.md'), '# Disposable Project\nAdvanced base commit\n');
    execFileSync('git', ['add', 'README.md'], { cwd: disposableRepoDir });
    execFileSync('git', ['commit', '-m', 'chore: update README on main'], { cwd: disposableRepoDir });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: disposableRepoDir });

    const advancedBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: disposableRepoDir, encoding: 'utf-8' }).trim();
    assert.notStrictEqual(advancedBaseSha, initialBaseSha, 'Base branch must have advanced');

    // Deliver task 2 - GitHubDeliveryService must detect drift, merge advancedBaseSha into worktree, re-verify combined result,
    // and invalidate prior approval since integration produced a new revision
    const initialDriftDelivery = await deliveryService.dispatchDelivery({
      runId: run2.id,
      isApproved: true,
      approvedBy: 'qa-lead',
      repoUrl: 'disposable-org/disposable-repo',
      targetBaseBranch: 'main',
    });

    assert.strictEqual(initialDriftDelivery.success, false, 'Delivery must block when integration changes the approved revision');
    assert.strictEqual(initialDriftDelivery.status, 403);
    assert.strictEqual(initialDriftDelivery.approvalRequired, true);
    assert.notStrictEqual(initialDriftDelivery.deliveredCommit, preDriftCommit, 'Integration commit must differ from pre-drift commit');
    assert.ok(initialDriftDelivery.error?.includes('Prior approval for') && initialDriftDelivery.error?.includes('is invalidated'));
    console.log('✔ [PASS] Base drift integration invalidated prior approval and required operator re-approval for new revision');

    // Operator inspects combined result and grants re-approval for the new merged revision
    const driftDelivery = await deliveryService.dispatchDelivery({
      runId: run2.id,
      isApproved: true,
      approvedBy: 'qa-lead-reapproved',
      repoUrl: 'disposable-org/disposable-repo',
      targetBaseBranch: 'main',
    });

    assert.strictEqual(driftDelivery.success, true, 'Delivery with re-approved combined result must succeed');
    assert.strictEqual(driftDelivery.status, 200);
    assert.strictEqual(driftDelivery.deliveredCommit, initialDriftDelivery.deliveredCommit, 'Delivered commit must be the re-approved merged commit');

    // Verify the combined worktree in remote bare origin has BOTH the worker changes AND the README from the updated base!
    const readmeInDelivered = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', `${run2.targetBranch}:README.md`], { encoding: 'utf-8' });
    assert.ok(readmeInDelivered.includes('Advanced base commit'), 'Combined delivered commit must include updated base README');

    const calcInDelivered = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', `${run2.targetBranch}:src/calculator.cjs`], { encoding: 'utf-8' });
    assert.ok(calcInDelivered.includes('function divide(a, b)'), 'Combined delivered commit must include worker divide function');
    console.log('✔ [PASS] Base-drift detected, clean merge performed, approval invalidated & re-approved, and combined result delivered');

    // ------------------------------------------------------------------------
    // Part 5: Base-Drift Merge Conflict Fails Closed
    // ------------------------------------------------------------------------
    console.log('\n--- Testing Base-Drift Merge Conflict Failure ---');
    const taskRecord3 = store.createTask({
      key: 'AEG-DISP-03',
      title: 'Conflicting Task',
      description: 'Creates shared feature file',
      status: 'in_progress',
      priority: 'high',
      targetRepo: 'disposable-org/disposable-repo',
      targetRepoPath: disposableRepoDir,
      baseCommit: advancedBaseSha,
      allowedPaths: ['src/**'],
      protectedPaths: [],
      verificationCommands: ['node -e "if (!require(\'fs\').existsSync(\'./src/shared.txt\')) process.exit(1);"'],
      acceptanceCriteria: [{ id: 'crit-c', title: 'Check', completed: false, checkCommand: 'node -e "if (!require(\'fs\').existsSync(\'./src/shared.txt\')) process.exit(1);"' }],
      workerConfig: { provider: 'custom', model: 'mock' },
      maxAttempts: 1,
      timeoutSeconds: 60,
      requireApproval: true,
    });

    const run3 = await repairCoordinator.executeTaskRun({
      task: taskRecord3,
      worker: {
        name: 'conflict_worker',
        isAvailable: async () => ({ available: true }),
        execute: async (context) => {
          fs.writeFileSync(path.join(context.worktreePath, 'src', 'shared.txt'), 'WORKER_CONTENT_LINE_1\n');
          return {
            success: true,
            filesModified: ['src/shared.txt'],
            diff: 'shared file created',
            commitMessage: 'worker add shared',
            logs: ['worker added shared.txt'],
            durationMs: 50,
          };
        },
      },
    });

    assert.strictEqual(run3.status, 'completed', 'Run 3 must pass initial verification before drift testing');

    // Advance main in disposable repo by creating the same file with conflicting content
    fs.writeFileSync(path.join(disposableRepoDir, 'src', 'shared.txt'), 'BASE_CONFLICTING_CONTENT_LINE_1\n');
    execFileSync('git', ['add', 'src/shared.txt'], { cwd: disposableRepoDir });
    execFileSync('git', ['commit', '-m', 'conflicting commit on main'], { cwd: disposableRepoDir });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: disposableRepoDir });

    const conflictDelivery = await deliveryService.dispatchDelivery({
      runId: run3.id,
      isApproved: true,
      approvedBy: 'qa-lead',
      repoUrl: 'disposable-org/disposable-repo',
      targetBaseBranch: 'main',
    });

    assert.strictEqual(conflictDelivery.success, false, 'Delivery must fail when base branch conflicts');
    assert.strictEqual(conflictDelivery.status, 409);
    assert.strictEqual(conflictDelivery.blocked, true);
    assert.ok(conflictDelivery.error?.includes('could not be merged cleanly'), 'Error message states clean merge was impossible');
    console.log('✔ [PASS] Base-drift conflict correctly blocked fail-closed with HTTP 409');

  } finally {
    if (fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  }

  console.log('\n=== ALL DISPOSABLE REPOSITORY WORKSPACE & DELIVERY PROOFS PASSED ===');
}

test('suite', main);
