import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { TaskRecord, TaskRunRecord } from '../db/schema.js';
import { TaskStore, taskStore as defaultTaskStore } from '../db/database.js';
import { WorkspaceManager, defaultWorkspaceManager } from '../workspace/workspaceManager.js';
import { CodingWorkerAdapter, WorkerExecutionContext } from '../worker/types.js';
import { defaultCodingWorker } from '../worker/geminiWorkerAdapter.js';
import { AuthoritativeVerifier, defaultAuthoritativeVerifier } from '../verification/authoritativeVerifier.js';

export interface ExecutionLoopOptions {
  task: TaskRecord;
  worker?: CodingWorkerAdapter;
  store?: TaskStore;
  workspaceManager?: WorkspaceManager;
  verifier?: AuthoritativeVerifier;
  onAttemptComplete?: (attemptNum: number, passed: boolean) => void;
}

export class RepairCoordinator {
  private store: TaskStore;
  private workspaceManager: WorkspaceManager;
  private verifier: AuthoritativeVerifier;
  private activeCancellations: Set<string> = new Set();

  constructor(
    store: TaskStore = defaultTaskStore,
    workspaceManager: WorkspaceManager = defaultWorkspaceManager,
    verifier: AuthoritativeVerifier = defaultAuthoritativeVerifier,
  ) {
    this.store = store;
    this.workspaceManager = workspaceManager;
    this.verifier = verifier;
  }

  public cancelRun(runId: string): void {
    this.activeCancellations.add(runId);
  }

  public isCancelled(runId: string): boolean {
    return this.activeCancellations.has(runId);
  }

  /**
   * Executes the full bounded task-to-verification loop:
   * Workspace Preparation -> Worker Attempt -> Verification -> Bounded Repair -> Attestation
   */
  public async executeTaskRun(options: ExecutionLoopOptions): Promise<TaskRunRecord> {
    const { task } = options;
    const worker = options.worker || defaultCodingWorker;
    const startTime = Date.now();

    const runId = `run-${task.key.toLowerCase()}-${Date.now()}`;
    const branchName = `dupond/${task.key}-feat-${Date.now()}`;

    // 1. Prepare isolated worktree
    let worktreeInfo;
    try {
      worktreeInfo = this.workspaceManager.createWorktree(runId, branchName, task.baseCommit);
    } catch (err: any) {
      this.store.unclaimTask(task.id, 'blocked', `Failed to prepare isolated workspace: ${err.message}`);
      const failedRun = this.store.createRun({
        id: runId,
        taskId: task.id,
        status: 'failed',
        baseCommit: task.baseCommit,
        targetBranch: branchName,
        currentAttempt: 0,
        durationMs: Date.now() - startTime,
        failureType: 'implementation',
        failureReason: `Workspace preparation failed: ${err.message}`,
      });
      return failedRun;
    }

    // 2. Create persistent run record
    const run = this.store.createRun({
      id: runId,
      taskId: task.id,
      status: 'running',
      baseCommit: task.baseCommit,
      targetBranch: branchName,
      worktreePath: worktreeInfo.worktreePath,
      currentAttempt: 0,
      durationMs: 0,
    });

    let repairFeedback: WorkerExecutionContext['repairFeedback'] | undefined;
    let finalVerificationSha: string | undefined;
    let completedSuccessfully = false;
    let lastFailureReason = 'Unknown failure';
    let lastFailureType: TaskRunRecord['failureType'] = 'implementation';

    const maxAttempts = task.maxAttempts || 3;

    try {
      for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
        if (this.isCancelled(runId)) {
          lastFailureReason = 'Run cancelled by user';
          lastFailureType = 'cancelled';
          break;
        }

        const attemptStartTime = Date.now();
        const attempt = this.store.createAttempt({
          runId: run.id,
          attemptNumber: attemptNum,
          status: 'running',
          workerType: worker.name,
          filesModified: [],
          durationMs: 0,
          startedAt: new Date().toISOString(),
        });

        this.store.updateRun(run.id, { currentAttempt: attemptNum });

        // Invoke real coding worker
        const workerContext: WorkerExecutionContext = {
          taskId: task.id,
          taskKey: task.key,
          taskTitle: task.title,
          taskDescription: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          worktreePath: worktreeInfo.worktreePath,
          allowedPaths: task.allowedPaths,
          protectedPaths: task.protectedPaths,
          attemptNumber: attemptNum,
          repairFeedback,
          timeoutMs: (task.timeoutSeconds || 300) * 1000,
        };

        let workerResult;
        try {
          workerResult = await worker.execute(workerContext);
        } catch (workerErr: any) {
          this.store.updateAttempt(attempt.id, {
            status: 'failed',
            errorMessage: workerErr.message,
            durationMs: Date.now() - attemptStartTime,
            completedAt: new Date().toISOString(),
          });
          lastFailureReason = `Worker failed on attempt ${attemptNum}: ${workerErr.message}`;
          lastFailureType = 'implementation';
          repairFeedback = {
            failingCommand: 'worker.execute',
            stderr: workerErr.message,
          };
          continue;
        }

        if (!workerResult.success && workerResult.errorMessage) {
          this.store.updateAttempt(attempt.id, {
            status: 'failed',
            errorMessage: workerResult.errorMessage,
            logs: workerResult.logs.join('\n'),
            durationMs: workerResult.durationMs,
            completedAt: new Date().toISOString(),
          });
          lastFailureReason = workerResult.errorMessage;
          lastFailureType = 'implementation';
          repairFeedback = {
            failingCommand: 'worker.execute',
            stderr: workerResult.errorMessage,
          };
          continue;
        }

        // Commit worker's changes in the worktree
        let commitSha: string;
        try {
          const statusOutput = execFileSync('git', ['status', '--porcelain'], {
            cwd: worktreeInfo.worktreePath,
            encoding: 'utf-8',
          }).trim();

          if (statusOutput) {
            execFileSync('git', ['add', '-A'], { cwd: worktreeInfo.worktreePath });
            execFileSync('git', ['commit', '-m', workerResult.commitMessage || `feat(${task.key}): implement changes`], {
              cwd: worktreeInfo.worktreePath,
            });
          }

          commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: worktreeInfo.worktreePath,
            encoding: 'utf-8',
          }).trim();
        } catch (gitErr: any) {
          this.store.updateAttempt(attempt.id, {
            status: 'failed',
            errorMessage: `Git commit failed: ${gitErr.message}`,
            durationMs: Date.now() - attemptStartTime,
            completedAt: new Date().toISOString(),
          });
          lastFailureReason = `Failed to commit changes: ${gitErr.message}`;
          lastFailureType = 'implementation';
          continue;
        }

        // Run Authoritative Verification
        const verification = await this.verifier.verify({
          worktreePath: worktreeInfo.worktreePath,
          baseCommit: worktreeInfo.baseCommit,
          verificationCommands: task.verificationCommands,
          protectedPaths: task.protectedPaths,
          acceptanceCriteria: task.acceptanceCriteria,
        });

        // Record verification record
        this.store.recordVerification({
          runId: run.id,
          attemptId: attempt.id,
          revisionSha: commitSha,
          passed: verification.passed,
          checks: verification.checks,
          criteriaVerified: verification.criteriaVerified,
          failureReason: verification.failureReason,
        });

        // Update attempt record with verified outcomes
        this.store.updateAttempt(attempt.id, {
          status: verification.passed ? 'succeeded' : 'failed',
          diff: workerResult.diff,
          filesModified: workerResult.filesModified,
          logs: workerResult.logs.join('\n'),
          tokenUsage: workerResult.tokenUsage,
          durationMs: Date.now() - attemptStartTime,
          errorMessage: verification.failureReason,
          completedAt: new Date().toISOString(),
        });

        options.onAttemptComplete?.(attemptNum, verification.passed);

        if (verification.passed) {
          completedSuccessfully = true;
          finalVerificationSha = commitSha;
          break;
        } else {
          // Bounded repair preparation: feed failing evidence back to worker
          lastFailureReason = verification.failureReason || 'Verification checks failed';
          lastFailureType = 'verification';

          const firstFailingCheck = verification.checks.find((c) => !c.passed);
          repairFeedback = {
            failingCommand: firstFailingCheck?.command,
            exitCode: firstFailingCheck?.exitCode,
            stdout: firstFailingCheck?.stdout,
            stderr: firstFailingCheck?.stderr,
            unmetCriteria: task.acceptanceCriteria.map((c) => c.id),
          };
        }
      }

      const totalDuration = Date.now() - startTime;

      if (completedSuccessfully) {
        this.store.updateRun(run.id, {
          status: 'completed',
          durationMs: totalDuration,
        });
        // Transition task to review (ready for PR delivery)
        this.store.updateTaskStatus(task.id, 'review');
      } else {
        const isCancelled = this.isCancelled(runId);
        const finalStatus = isCancelled ? 'cancelled' : 'failed';
        this.store.updateRun(run.id, {
          status: finalStatus,
          durationMs: totalDuration,
          failureType: lastFailureType,
          failureReason: lastFailureReason,
        });
        // Unclaim and mark task blocked so other eligible tasks can run!
        this.store.unclaimTask(task.id, 'blocked', `Execution ${finalStatus}: ${lastFailureReason}`);
      }

      return this.store.getRun(run.id)!;
    } finally {
      this.activeCancellations.delete(runId);
    }
  }
}

export const defaultRepairCoordinator = new RepairCoordinator();
