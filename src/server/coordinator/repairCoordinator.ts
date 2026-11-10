import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { TaskRecord, TaskRunRecord } from '../db/schema.js';
import { TaskStore, taskStore as defaultTaskStore } from '../db/database.js';
import { WorkspaceManager, defaultWorkspaceManager } from '../workspace/workspaceManager.js';
import { resolveTargetRepository, isOrchestratorSelfTarget } from '../workspace/targetRepositoryResolver.js';
import { CodingWorkerAdapter, WorkerExecutionContext } from '../worker/types.js';
import { defaultCodingWorker } from '../worker/geminiWorkerAdapter.js';
import { resolveCodingWorker } from '../worker/workerRegistry.js';
import { AuthoritativeVerifier, defaultAuthoritativeVerifier } from '../verification/authoritativeVerifier.js';
import { verifiedRefForRun } from '../verification/evidenceBinding.js';
import { LifecycleService } from '../lifecycle/lifecycleService.js';
import { defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';

export interface ExecutionLoopOptions {
  task: TaskRecord;
  worker?: CodingWorkerAdapter;
  store?: TaskStore;
  workspaceManager?: WorkspaceManager;
  verifier?: AuthoritativeVerifier;
  runId?: string;
  onAttemptComplete?: (attemptNum: number, passed: boolean) => void;
}

export class RepairCoordinator {
  private store: TaskStore;
  private workspaceManager: WorkspaceManager;
  private verifier: AuthoritativeVerifier;
  private activeCancellations: Set<string> = new Set();
  private activeAbortControllers: Map<string, AbortController> = new Map();

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
    const controller = this.activeAbortControllers.get(runId);
    if (controller) {
      controller.abort();
    }
    this.verifier.getSandbox().killRun(runId);
    defaultSandboxExecutor.killRun(runId);
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
    const startTime = Date.now();

    const runId = options.runId || `run-${task.key.toLowerCase()}-${Date.now()}`;
    const branchName = `dupond/${task.key}-feat-${Date.now()}`;
    const abortController = new AbortController();
    this.activeAbortControllers.set(runId, abortController);

    // 0. Resolve coding worker fail-closed
    let worker: CodingWorkerAdapter;
    try {
      worker = options.worker || resolveCodingWorker(task.workerConfig, this.verifier.getSandbox());
    } catch (err: any) {
      this.store.unclaimTask(task.id, 'blocked', err.message);
      const failedRun = this.store.createRun({
        id: runId,
        taskId: task.id,
        status: 'failed',
        targetRepo: task.targetRepo,
        baseCommit: task.baseCommit,
        targetBranch: branchName,
        currentAttempt: 0,
        durationMs: Date.now() - startTime,
        failureType: 'implementation',
        failureReason: `Worker configuration invalid: ${err.message}`,
      });
      return failedRun;
    }

    const workerAvail = await worker.isAvailable();
    if (!workerAvail.available) {
      this.store.unclaimTask(task.id, 'blocked', workerAvail.error || 'Worker unavailable');
      const failedRun = this.store.createRun({
        id: runId,
        taskId: task.id,
        status: 'failed',
        targetRepo: task.targetRepo,
        baseCommit: task.baseCommit,
        targetBranch: branchName,
        currentAttempt: 0,
        durationMs: Date.now() - startTime,
        failureType: 'implementation',
        failureReason: `Worker prerequisite unavailable: ${workerAvail.error}`,
      });
      return failedRun;
    }

    // 1. Resolve target workspace fail-closed
    let wsManager = options.workspaceManager;
    let resolvedIdentity: string | undefined;

    try {
      const resolved = resolveTargetRepository({
        targetRepo: task.targetRepo,
        targetRepoPath: task.targetRepoPath,
        allowOrchestratorRepo: isOrchestratorSelfTarget(task.targetRepo),
      });
      resolvedIdentity = resolved.repoIdentity;
      if (!wsManager || path.resolve(wsManager.getBaseRepoDir()) !== path.resolve(resolved.repoPath)) {
        wsManager = new WorkspaceManager(resolved.repoPath);
      }
    } catch (err: any) {
      this.store.unclaimTask(task.id, 'blocked', err.message);
      const failedRun = this.store.createRun({
        id: runId,
        taskId: task.id,
        status: 'failed',
        targetRepo: task.targetRepo,
        baseCommit: task.baseCommit,
        targetBranch: branchName,
        currentAttempt: 0,
        durationMs: Date.now() - startTime,
        failureType: 'implementation',
        failureReason: `Target repository configuration blocked: ${err.message}`,
      });
      return failedRun;
    }

    let worktreeInfo;
    try {
      worktreeInfo = wsManager.createWorktree(runId, branchName, task.baseCommit);
    } catch (err: any) {
      this.store.unclaimTask(task.id, 'blocked', `Failed to prepare isolated workspace: ${err.message}`);
      const failedRun = this.store.createRun({
        id: runId,
        taskId: task.id,
        status: 'failed',
        targetRepo: task.targetRepo || resolvedIdentity,
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
      targetRepo: task.targetRepo || resolvedIdentity,
      baseCommit: worktreeInfo.baseCommit,
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
        const workerIdentifier = worker.provider && worker.model ? `${worker.provider}:${worker.model}` : worker.name;
        const attempt = this.store.createAttempt({
          runId: run.id,
          attemptNumber: attemptNum,
          status: 'running',
          workerType: workerIdentifier,
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
          runId,
          abortSignal: abortController.signal,
          workerConfig: task.workerConfig,
        };

        let workerResult;
        try {
          workerResult = await worker.execute(workerContext);
        } catch (workerErr: any) {
          const wasCancelled = this.isCancelled(runId) || abortController.signal.aborted;
          this.store.updateAttempt(attempt.id, {
            status: 'failed',
            errorMessage: wasCancelled ? 'Cancelled by user' : workerErr.message,
            durationMs: Date.now() - attemptStartTime,
            completedAt: new Date().toISOString(),
          });
          if (wasCancelled) {
            lastFailureReason = 'Run cancelled by user';
            lastFailureType = 'cancelled';
            break;
          }
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
          description: task.description,
          runId,
          abortSignal: abortController.signal,
        });

        if (this.isCancelled(runId) || abortController.signal.aborted) {
          lastFailureReason = 'Run cancelled by user';
          lastFailureType = 'cancelled';
          break;
        }

        // Record verification bound to the exact revision, requirements, and config
        this.store.recordVerification({
          runId: run.id,
          attemptId: attempt.id,
          revisionSha: commitSha,
          passed: verification.passed,
          checks: verification.checks,
          criteriaVerified: verification.criteriaVerified,
          failureReason: verification.failureReason,
          revisionTreeSha: verification.treeSha || null,
          requirementsFingerprint: verification.binding?.requirementsFingerprint || null,
          verificationConfigFingerprint: verification.binding?.verificationConfigFingerprint || null,
          evidenceBindingVersion: verification.binding?.evidenceBindingVersion || null,
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

        // Pin the verified commit so the exact accepted content remains
        // resolvable after the ephemeral worktree and branch are removed.
        if (finalVerificationSha) {
          try {
            wsManager.pinRevision(verifiedRefForRun(run.id), finalVerificationSha);
          } catch (pinErr: any) {
            this.store.recordAudit({
              taskId: task.id,
              runId: run.id,
              eventType: 'REVISION_PIN_FAILED',
              actor: 'verifier',
              details: { error: pinErr.message, commitSha: finalVerificationSha },
            });
          }
        }

        // Enter Review only through the authoritative lifecycle service, which
        // re-checks that the recorded evidence is bound to the current spec.
        const lifecycle = new LifecycleService(this.store);
        const reviewTransition = lifecycle.transition({
          taskId: task.id,
          to: 'review',
          actor: 'verifier',
          reason: 'Authoritative verification passed',
        });
        if (!reviewTransition.ok) {
          this.store.unclaimTask(
            task.id,
            'blocked',
            `Verification passed but Review was refused by the lifecycle service: ${reviewTransition.detail}`,
          );
        }
      } else {
        const isCancelled = this.isCancelled(runId) || abortController.signal.aborted;
        const finalStatus = isCancelled ? 'cancelled' : 'failed';
        this.store.updateRun(run.id, {
          status: finalStatus,
          durationMs: totalDuration,
          failureType: isCancelled ? 'cancelled' : lastFailureType,
          failureReason: lastFailureReason,
        });
        // Unclaim and mark task blocked so other eligible tasks can run!
        this.store.unclaimTask(task.id, 'blocked', `Execution ${finalStatus}: ${lastFailureReason}`);
      }

      return this.store.getRun(run.id)!;
    } finally {
      this.activeAbortControllers.delete(runId);
      this.activeCancellations.delete(runId);
    }
  }
}

export const defaultRepairCoordinator = new RepairCoordinator();
