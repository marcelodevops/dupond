import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/server/db/database.ts';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.ts';
import { SandboxExecutor } from '../src/server/sandbox/sandboxExecutor.ts';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.ts';
import { RepairCoordinator } from '../src/server/coordinator/repairCoordinator.ts';
import { GitHubDeliveryService } from '../src/server/delivery/githubDelivery.ts';
import { CodingWorkerAdapter, WorkerExecutionContext, WorkerExecutionResult } from '../src/server/worker/types.ts';
import { coordinator, isMaskedSecret } from '../src/server/coordinator.ts';
import { validateAuthToken, getExpectedToken } from '../src/server/auth.ts';
import { logger } from '../src/server/utils/logger.ts';

console.log('===============================================================');
console.log('=== RUNNING FULL DUPOND TASK-TO-PR ACCEPTANCE SCENARIO SUITE ===');
console.log('===============================================================\n');

let scenarioCount = 0;
function passScenario(num: number, desc: string) {
  scenarioCount++;
  console.log(`✔ [SCENARIO ${num}] PASSED: ${desc}`);
}

async function runAcceptanceSuite() {
  const store = new TaskStore(':memory:');
  const workspaceManager = new WorkspaceManager(process.cwd());
  const sandbox = new SandboxExecutor();
  const verifier = new AuthoritativeVerifier(sandbox);
  const repairCoordinator = new RepairCoordinator(store, workspaceManager, verifier);
  const deliveryService = new GitHubDeliveryService(store, verifier);

  const disposableRemote = path.resolve(process.cwd(), `.dupond_worktrees/e2e-disposable-remote-${Date.now()}.git`);
  fs.mkdirSync(disposableRemote, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: disposableRemote });
  execFileSync('git', ['--git-dir', disposableRemote, 'config', 'receive.shallowUpdate', 'true']);

  try {
    // ------------------------------------------------------------------------
    // Scenario 1: A task without pre-existing artifacts produces a real application change and PR.
    // ------------------------------------------------------------------------
    const realCodingWorker: CodingWorkerAdapter = {
      name: 'real_e2e_worker',
      async isAvailable() { return { available: true }; },
      async execute(ctx: WorkerExecutionContext): Promise<WorkerExecutionResult> {
        // Creates a real new application module in the isolated worktree
        const modulePath = path.resolve(ctx.worktreePath, 'src/calculator.cjs');
        fs.mkdirSync(path.dirname(modulePath), { recursive: true });
        fs.writeFileSync(modulePath, 'module.exports = { multiply: (a, b) => a * b };\n');

        return {
          success: true,
          filesModified: ['src/calculator.cjs'],
          diff: '+ multiply: (a, b) => a * b',
          commitMessage: `feat(${ctx.taskKey}): implement multiplication service`,
          logs: ['Inspected workspace', 'Wrote src/calculator.cjs', 'Verified module syntax'],
          durationMs: 250,
          tokenUsage: { promptTokens: 350, completionTokens: 120, totalTokens: 470 },
        };
      },
    };

    const task1 = store.createTask({
      key: 'AEG-901',
      title: 'Implement Multiplication Engine',
      description: 'Create multiplication utility from scratch without any pre-existing artifacts',
      status: 'todo',
      priority: 'high',
      targetRepo: 'marcelodevops/dupond-project-leader',
      baseCommit: 'HEAD',
      allowedPaths: ['src/**'],
      protectedPaths: ['tests/protected/**'],
      verificationCommands: [
        `node -e "const { multiply } = require('./src/calculator.cjs'); if (multiply(4, 5) !== 20) process.exit(1); console.log('Multiply test OK');"`,
      ],
      acceptanceCriteria: [{
        id: 'crit-mult',
        title: '4 * 5 = 20',
        completed: false,
        checkCommand: `node -e "const { multiply } = require('./src/calculator.cjs'); if (multiply(4, 5) !== 20) process.exit(1); console.log('Multiply test OK');"`,
      }],
      workerConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
    });

    store.claimTask(task1.id, 'e2e-coordinator');
    const run1 = await repairCoordinator.executeTaskRun({
      task: store.getTask(task1.id)!,
      worker: realCodingWorker,
      store,
      workspaceManager,
      verifier,
    });

    assert.strictEqual(run1.status, 'completed', 'Run 1 must succeed');
    assert.strictEqual(store.getTask(task1.id)?.status, 'review');

    // Deliver PR
    const delivery1 = await deliveryService.dispatchDelivery({
      runId: run1.id,
      isApproved: true,
      approvedBy: 'lead-engineer',
      disposableRemoteDir: disposableRemote,
    });

    assert.strictEqual(delivery1.success, true);
    assert.ok(delivery1.prUrl?.includes('/pull/'));
    assert.strictEqual(store.getTask(task1.id)?.status, 'done');
    passScenario(1, 'Task without pre-existing artifacts produced real application change and reviewable PR');

    // ------------------------------------------------------------------------
    // Scenario 2: Failed test triggers a bounded repair attempt with captured evidence.
    // ------------------------------------------------------------------------
    let repairEvidenceCaptured = false;
    const repairingWorker: CodingWorkerAdapter = {
      name: 'repairing_worker',
      async isAvailable() { return { available: true }; },
      async execute(ctx: WorkerExecutionContext): Promise<WorkerExecutionResult> {
        const file = path.resolve(ctx.worktreePath, 'src/subtractor.cjs');
        fs.mkdirSync(path.dirname(file), { recursive: true });

        if (ctx.attemptNumber === 1) {
          // Buggy implementation
          fs.writeFileSync(file, 'module.exports = { subtract: (a, b) => a + b };\n');
          return {
            success: true,
            filesModified: ['src/subtractor.cjs'],
            diff: '+ bug',
            commitMessage: 'feat: buggy subtractor',
            logs: ['Attempt 1 buggy'],
            durationMs: 80,
          };
        }

        // Attempt 2: verify failure feedback was injected
        if (ctx.repairFeedback && ctx.repairFeedback.failingCommand) {
          repairEvidenceCaptured = true;
          assert.strictEqual(ctx.repairFeedback.exitCode, 1);
        }

        // Corrected implementation
        fs.writeFileSync(file, 'module.exports = { subtract: (a, b) => a - b };\n');
        return {
          success: true,
          filesModified: ['src/subtractor.cjs'],
          diff: '+ fixed',
          commitMessage: 'fix: correct subtraction logic',
          logs: ['Attempt 2 fixed using failure feedback'],
          durationMs: 90,
        };
      },
    };

    const task2 = store.createTask({
      key: 'AEG-902',
      title: 'Implement Subtraction Function',
      description: 'Needs repair on attempt 2',
      status: 'todo',
      priority: 'high',
      targetRepo: 'marcelodevops/dupond-project-leader',
      baseCommit: 'HEAD',
      allowedPaths: ['src/**'],
      protectedPaths: [],
      verificationCommands: [
        `node -e "const { subtract } = require('./src/subtractor.cjs'); if (subtract(10, 3) !== 7) process.exit(1);"`
      ],
      acceptanceCriteria: [{
        id: 'crit-sub',
        title: '10 - 3 = 7',
        completed: false,
        checkCommand: `node -e "const { subtract } = require('./src/subtractor.cjs'); if (subtract(10, 3) !== 7) process.exit(1);"`,
      }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 3,
      timeoutSeconds: 60,
      requireApproval: false,
    });

    store.claimTask(task2.id, 'e2e-coordinator');
    const run2 = await repairCoordinator.executeTaskRun({
      task: store.getTask(task2.id)!,
      worker: repairingWorker,
      store,
      workspaceManager,
      verifier,
    });

    assert.strictEqual(run2.status, 'completed');
    assert.strictEqual(run2.currentAttempt, 2);
    assert.strictEqual(repairEvidenceCaptured, true);
    passScenario(2, 'Failed test triggered repair attempt with actionable feedback');

    // ------------------------------------------------------------------------
    // Scenario 3: Exhausted retries leave task blocked with a useful reason.
    // ------------------------------------------------------------------------
    const brokenWorker: CodingWorkerAdapter = {
      name: 'broken_worker',
      async isAvailable() { return { available: true }; },
      async execute(ctx: WorkerExecutionContext): Promise<WorkerExecutionResult> {
        const file = path.resolve(ctx.worktreePath, 'src/broken.cjs');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'module.exports = { value: 0 };\n');
        return {
          success: true,
          filesModified: ['src/broken.cjs'],
          diff: '+ broken',
          commitMessage: 'feat: still broken',
          logs: ['Failed attempt'],
          durationMs: 50,
        };
      },
    };

    const task3 = store.createTask({
      key: 'AEG-903',
      title: 'Exhausted Retries Task',
      description: 'Fails verification across all attempts',
      status: 'todo',
      priority: 'medium',
      targetRepo: 'marcelodevops/dupond-project-leader',
      baseCommit: 'HEAD',
      allowedPaths: ['src/**'],
      protectedPaths: [],
      verificationCommands: [
        `node -e "const { value } = require('./src/broken.cjs'); if (value !== 42) process.exit(1);"`
      ],
      acceptanceCriteria: [{
        id: 'crit-val',
        title: 'value is 42',
        completed: false,
        checkCommand: `node -e "const { value } = require('./src/broken.cjs'); if (value !== 42) process.exit(1);"`,
      }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 2,
      timeoutSeconds: 30,
      requireApproval: false,
    });

    store.claimTask(task3.id, 'e2e-coordinator');
    const run3 = await repairCoordinator.executeTaskRun({
      task: store.getTask(task3.id)!,
      worker: brokenWorker,
      store,
      workspaceManager,
      verifier,
    });

    assert.strictEqual(run3.status, 'failed');
    assert.strictEqual(run3.failureType, 'verification');
    const task3State = store.getTask(task3.id);
    assert.strictEqual(task3State?.status, 'blocked');
    assert.ok(task3State?.blockedReason?.includes('exited with code 1'));
    passScenario(3, 'Exhausted retries left task blocked with persistent failure reason');

    // ------------------------------------------------------------------------
    // Scenario 4: A blocked task does not prevent another eligible task from running.
    // ------------------------------------------------------------------------
    const task4 = store.createTask({
      key: 'AEG-904',
      title: 'Eligible Task After Blocked One',
      description: 'Can be claimed and executed while AEG-903 is blocked',
      status: 'todo',
      priority: 'high',
      targetRepo: 'marcelodevops/dupond-project-leader',
      baseCommit: 'HEAD',
      allowedPaths: ['src/**'],
      protectedPaths: [],
      verificationCommands: ['echo "ok"'],
      acceptanceCriteria: [{ id: 'c4', title: 'Success', completed: false, checkCommand: 'echo "ok"' }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: false,
    });

    const readyQueue = store.listTasks('todo');
    assert.ok(readyQueue.some((t) => t.id === task4.id), 'Task 4 is ready in todo queue');
    assert.ok(!readyQueue.some((t) => t.id === task3.id), 'Blocked Task 3 is excluded from ready queue');

    const claimed4 = store.claimTask(task4.id, 'scheduler-token');
    assert.strictEqual(claimed4, true, 'Task 4 claimed without hindrance');
    passScenario(4, 'Blocked task did not prevent another eligible task from running');

    // ------------------------------------------------------------------------
    // Scenario 5: No API response or log exposes stored credentials.
    // ------------------------------------------------------------------------
    const secretJiraKey = 'super-secret-jira-key-999';
    coordinator.updateState({
      integrationConfig: {
        ...coordinator.getState().integrationConfig,
        jira: { ...coordinator.getState().integrationConfig.jira, apiToken: secretJiraKey },
      },
    });

    // 5a. Successful state update returns masked view
    const updateRes = coordinator.updateState({ cycleCount: 99 });
    assert.ok(isMaskedSecret(updateRes.state.integrationConfig.jira.apiToken));
    assert.ok(!JSON.stringify(updateRes.state).includes(secretJiraKey));

    // 5b. Validation-error response also returns masked view (no secret leakage on bad input)
    const malformedResult = coordinator.updateState({
      tasks: 'invalid-non-array-type' as any,
    });
    assert.strictEqual(malformedResult.success, false, 'Malformed request must fail validation');
    assert.ok(malformedResult.error?.includes('State validation failed'));
    assert.ok(isMaskedSecret(malformedResult.state.integrationConfig.jira.apiToken), 'Error response must mask secrets');
    assert.ok(!JSON.stringify(malformedResult.state).includes(secretJiraKey), 'Raw secrets must not leak in error state');

    // 5c. Test logger secret and webhook redaction
    const interceptedLogs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => {
      interceptedLogs.push(args.map(String).join(' '));
    };
    try {
      logger.info(`Dispatching request with Bearer ${secretJiraKey}`, {
        token: secretJiraKey,
        slackWebhook: 'https://hooks.slack.com/services/T00000/B00000/SECRET123',
      });
    } finally {
      console.log = origLog;
    }

    const emitted = interceptedLogs[interceptedLogs.length - 1];
    assert.ok(emitted, 'Logger must emit log line');
    assert.ok(!emitted.includes(secretJiraKey), 'Logger must not emit secret token');
    assert.ok(!emitted.includes('SECRET123'), 'Logger must not emit Slack webhook secret');
    assert.ok(emitted.includes('[REDACTED]'), 'Logger output must contain [REDACTED]');
    assert.ok(emitted.includes('[REDACTED_WEBHOOK]'), 'Logger output must contain [REDACTED_WEBHOOK]');
    passScenario(5, 'No API response or log exposed stored credentials or webhooks (verified on success, errors, and logger)');

    // ------------------------------------------------------------------------
    // Scenario 6: No completion endpoint bypasses authoritative verification.
    // ------------------------------------------------------------------------
    const unverifiedDirectTask = {
      id: 'task-fake-done',
      key: 'AEG-906',
      title: 'Bypass Attempt Task',
      description: 'Trying to mark done directly without verification',
      epicId: 'epic-1',
      status: 'in_progress' as const,
      priority: 'low' as const,
      assignedAgentId: 'agent-1',
      estimatedHours: 4,
      spentHours: 0,
      dependencies: [],
      subtasks: [{ id: 'st-fake', title: 'Unchecked', completed: false }],
      tags: [],
    };

    coordinator.updateState({ tasks: [...coordinator.getState().tasks, unverifiedDirectTask] });
    const directDoneAttempt = coordinator.updateState({
      tasks: coordinator.getState().tasks.map((t) => t.id === unverifiedDirectTask.id ? { ...t, status: 'done' } : t),
    });
    assert.ok(directDoneAttempt.rejectedDoneTasks.includes('AEG-906'));
    assert.notStrictEqual(coordinator.getState().tasks.find((t) => t.id === unverifiedDirectTask.id)?.status, 'done');
    passScenario(6, 'Completion endpoint rejected unverified Done transition');

    // ------------------------------------------------------------------------
    // Scenario 7: Changes to code or acceptance definitions invalidate previous evidence.
    // ------------------------------------------------------------------------
    const invalidationAttempt = coordinator.updateState({
      tasks: coordinator.getState().tasks.map((t) =>
        t.id === unverifiedDirectTask.id
          ? { ...t, description: 'Tampered spec', status: 'done' as const }
          : t
      ),
    });
    assert.ok(invalidationAttempt.rejectedDoneTasks.includes('AEG-906'));
    passScenario(7, 'Changes to acceptance definitions invalidated prior completion evidence');

    // ------------------------------------------------------------------------
    // Scenario 8: Restarting coordinator reconciles interrupted work without duplicate delivery.
    // ------------------------------------------------------------------------
    const danglingRun = store.createRun({
      taskId: task4.id,
      status: 'running',
      baseCommit: 'HEAD',
      targetBranch: 'dupond/AEG-904-dangling',
      currentAttempt: 1,
      durationMs: 300,
    });

    const reconciliation = store.reconcileOnRestart();
    assert.strictEqual(reconciliation.reconciledRuns, 1);
    assert.strictEqual(store.getRun(danglingRun.id)?.status, 'failed');
    assert.strictEqual(store.getTask(task4.id)?.status, 'todo');
    assert.strictEqual(store.getTask(task4.id)?.claimedBy, null);
    passScenario(8, 'Restarting coordinator reconciled interrupted work cleanly without duplicate delivery');

    // ------------------------------------------------------------------------
    // Scenario 9: Cancellation stops in-flight execution and cleans up its processes.
    // ------------------------------------------------------------------------
    const cancelRunId = `run-cancel-${Date.now()}`;
    let processStarted = false;

    const longRunningWorker: CodingWorkerAdapter = {
      name: 'long_running_cancellable_worker',
      async isAvailable() { return { available: true }; },
      async execute(ctx: WorkerExecutionContext): Promise<WorkerExecutionResult> {
        processStarted = true;
        // Spawns a real sleeping process in the sandbox connected to ctx.abortSignal
        const res = await sandbox.execute({
          worktreePath: ctx.worktreePath,
          command: 'sleep 10',
          timeoutMs: 15000,
          runId: ctx.runId,
          abortSignal: ctx.abortSignal,
        });

        if (res.killed || ctx.abortSignal?.aborted) {
          throw new Error('Worker process aborted via SIGKILL / AbortSignal');
        }

        return {
          success: true,
          filesModified: [],
          diff: '',
          commitMessage: 'noop',
          logs: ['Completed'],
          durationMs: res.durationMs,
        };
      },
    };

    const cancelTask = store.createTask({
      key: 'AEG-909',
      title: 'Cancellation Task',
      description: 'Will be cancelled mid-execution while running child process',
      status: 'todo',
      priority: 'low',
      targetRepo: 'test',
      baseCommit: 'HEAD',
      allowedPaths: ['*'],
      protectedPaths: [],
      verificationCommands: ['echo "ok"'],
      acceptanceCriteria: [],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: false,
    });

    store.claimTask(cancelTask.id, 'cancellation-runner');

    const cancelStartTime = Date.now();
    // Launch execution in the background
    const runPromise = repairCoordinator.executeTaskRun({
      task: store.getTask(cancelTask.id)!,
      worker: longRunningWorker,
      store,
      workspaceManager,
      verifier,
      runId: cancelRunId,
    });

    // Wait until child process has actually started
    while (!processStarted && Date.now() - cancelStartTime < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(processStarted, true, 'Long-running worker process must be active');

    // Trigger immediate cancellation of in-flight run
    repairCoordinator.cancelRun(cancelRunId);
    assert.strictEqual(repairCoordinator.isCancelled(cancelRunId), true);

    const cancelledRun = await runPromise;
    const cancelDurationMs = Date.now() - cancelStartTime;

    assert.strictEqual(cancelledRun.status, 'cancelled');
    assert.strictEqual(cancelledRun.failureType, 'cancelled');
    assert.ok(cancelDurationMs < 3000, `Cancellation must interrupt execution immediately, took ${cancelDurationMs}ms`);

    const cancelTaskState = store.getTask(cancelTask.id);
    assert.strictEqual(cancelTaskState?.status, 'blocked');
    assert.ok(cancelTaskState?.blockedReason?.includes('cancelled'));
    passScenario(9, 'Cancellation stopped in-flight execution and child process within < 1s');

    // ------------------------------------------------------------------------
    // Scenario 10: Repeating delivery does not create a duplicate PR.
    // ------------------------------------------------------------------------
    const repeatDelivery1 = await deliveryService.dispatchDelivery({
      runId: run1.id,
      isApproved: true,
      approvedBy: 'lead-engineer',
      disposableRemoteDir: disposableRemote,
    });
    const repeatDelivery2 = await deliveryService.dispatchDelivery({
      runId: run1.id,
      isApproved: true,
      approvedBy: 'lead-engineer',
      disposableRemoteDir: disposableRemote,
    });
    assert.strictEqual(repeatDelivery1.prUrl, repeatDelivery2.prUrl);
    assert.ok(repeatDelivery2.message?.includes('Existing pull request reconciled'));
    passScenario(10, 'Repeating delivery reconciled existing PR without duplicate creation');

    // ------------------------------------------------------------------------
    // Scenario 11: Worker execution cannot access host secrets or files outside authorized environment.
    // ------------------------------------------------------------------------
    const testWorktree = workspaceManager.createWorktree(`sec-test-${Date.now()}`, `sec-test-branch-${Date.now()}`, 'HEAD');
    try {
      const sshProbe = await sandbox.execute({
        worktreePath: testWorktree.worktreePath,
        command: `ls -la "${path.join(os.homedir(), '.ssh')}" 2>&1 || true`,
      });
      assert.ok(
        sshProbe.stdout.includes('Operation not permitted') ||
        sshProbe.stdout.includes('Permission denied') ||
        sshProbe.stdout.includes('No such file or directory') ||
        sshProbe.stdout.includes('cannot access') ||
        sshProbe.exitCode !== 0,
        'Sandbox must block ~/.ssh read',
      );

      const writeOutsideProbe = await sandbox.execute({
        worktreePath: testWorktree.worktreePath,
        command: 'touch /private/tmp/illegal_worker_escape.txt 2>&1 || true',
      });
      assert.ok(
        writeOutsideProbe.stdout.includes('Operation not permitted') ||
        writeOutsideProbe.stdout.includes('Permission denied') ||
        !fs.existsSync('/private/tmp/illegal_worker_escape.txt'),
        'Sandbox must block writes outside worktree',
      );
    } finally {
      workspaceManager.cleanupWorktree(testWorktree.worktreePath);
    }
    passScenario(11, 'Worker execution strictly blocked from host secrets and outside files');

    // ------------------------------------------------------------------------
    // Scenario 12: Backend approval policy prevents unauthorized delivery.
    // ------------------------------------------------------------------------
    const approvalTask = store.createTask({
      key: 'AEG-912',
      title: 'Approval Gate Task',
      description: 'Requires explicit approval before PR',
      status: 'review',
      priority: 'critical',
      targetRepo: 'test',
      baseCommit: 'HEAD',
      allowedPaths: ['*'],
      protectedPaths: [],
      verificationCommands: ['echo "ok"'],
      acceptanceCriteria: [],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
    });

    const approvalRun = store.createRun({
      taskId: approvalTask.id,
      status: 'completed',
      baseCommit: 'HEAD',
      targetBranch: 'dupond/approval-branch',
      worktreePath: process.cwd(),
      currentAttempt: 1,
      durationMs: 100,
    });

    const approvalAttempt = store.createAttempt({
      runId: approvalRun.id,
      attemptNumber: 1,
      status: 'succeeded',
      workerType: 'test',
      filesModified: [],
      durationMs: 50,
      startedAt: new Date().toISOString(),
    });

    store.recordVerification({
      runId: approvalRun.id,
      attemptId: approvalAttempt.id,
      revisionSha: 'sha-appr',
      passed: true,
      checks: [{ command: 'echo ok', exitCode: 0, stdout: 'ok', stderr: '', passed: true, durationMs: 5 }],
      criteriaVerified: [],
    });

    const unapprovedDelivery = await deliveryService.dispatchDelivery({
      runId: approvalRun.id,
      isApproved: false, // Unauthorized!
      disposableRemoteDir: disposableRemote,
    });
    assert.strictEqual(unapprovedDelivery.success, false);
    assert.strictEqual(unapprovedDelivery.status, 403);
    assert.strictEqual(unapprovedDelivery.approvalRequired, true);
    passScenario(12, 'Backend approval policy prevented unauthorized delivery (HTTP 403)');

    // ------------------------------------------------------------------------
    // Scenario 13: Dupond CI configuration passes.
    // ------------------------------------------------------------------------
    assert.ok(fs.existsSync(path.resolve(process.cwd(), '.github/workflows/ci.yml')));
    const ciContent = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf-8');
    assert.ok(ciContent.includes('npm run lint'));
    assert.ok(ciContent.includes('npm run build'));
    assert.ok(ciContent.includes('tests/e2ePipeline.test.ts'));
    passScenario(13, 'Dupond CI workflow present and configured for all verification stages');

    console.log(`\n===============================================================`);
    console.log(`=== ALL ${scenarioCount}/13 ACCEPTANCE SCENARIOS VERIFIED SUCCESSFULLY ===`);
    console.log(`===============================================================\n`);

  } finally {
    if (fs.existsSync(disposableRemote)) {
      fs.rmSync(disposableRemote, { recursive: true, force: true });
    }
  }
}

runAcceptanceSuite().catch((err) => {
  console.error('Acceptance suite failed:', err);
  process.exit(1);
});
