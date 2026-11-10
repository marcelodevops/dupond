import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { TaskStore, taskStore as defaultTaskStore } from '../db/database.js';
import { DeliveryRecord } from '../db/schema.js';
import { AuthoritativeVerifier, defaultAuthoritativeVerifier } from '../verification/authoritativeVerifier.js';
import {
  ApprovalExpectation,
  assessEvidenceValidity,
  computeEvidenceBinding,
  verifiedRefForRun,
} from '../verification/evidenceBinding.js';
import { LifecycleService } from '../lifecycle/lifecycleService.js';
import { normalizeRepoSlug, isLocalRemoteOrigin, areRepoSlugsCompatible } from '../workspace/targetRepositoryResolver.js';

export interface DispatchDeliveryOptions {
  runId: string;
  approvedBy?: string;
  isApproved?: boolean;
  targetBaseBranch?: string;
  repoUrl?: string;
  disposableRemoteDir?: string; // For testing delivery against local bare repository
}

export interface DispatchDeliveryResult {
  success: boolean;
  status: number;
  blocked?: boolean;
  approvalRequired?: boolean;
  deliveryRecord?: DeliveryRecord;
  prUrl?: string;
  branch?: string;
  deliveredCommit?: string;
  baseCommit?: string;
  ciStatus?: string;
  error?: string;
  message?: string;
}

export class GitHubDeliveryService {
  private store: TaskStore;
  private verifier: AuthoritativeVerifier;

  constructor(store: TaskStore = defaultTaskStore, verifier: AuthoritativeVerifier = defaultAuthoritativeVerifier) {
    this.store = store;
    this.verifier = verifier;
  }

  public async dispatchDelivery(options: DispatchDeliveryOptions): Promise<DispatchDeliveryResult> {
    const run = this.store.getRun(options.runId);
    if (!run) {
      return { success: false, status: 404, error: `Run ${options.runId} not found` };
    }

    const task = this.store.getTask(run.taskId);
    if (!task) {
      return { success: false, status: 404, error: `Task for run ${options.runId} not found` };
    }

    // 0. Repository authority. The identity this delivery is checked against is
    // the one persisted for the run, not whatever the request claims. A caller
    // that could name its own expectation could make any origin match it.
    const persistedTargetRepo = run.targetRepo || task.targetRepo;
    if (!persistedTargetRepo) {
      return {
        success: false,
        status: 400,
        blocked: true,
        error: `Delivery blocked: Run ${run.id} has no persisted target repository. Refusing to deliver against an unrecorded identity.`,
      };
    }
    if (options.repoUrl && !areRepoSlugsCompatible(options.repoUrl, persistedTargetRepo)) {
      return {
        success: false,
        status: 400,
        blocked: true,
        error: `Delivery blocked: Request repository "${normalizeRepoSlug(options.repoUrl)}" conflicts with the target recorded for run ${run.id} ("${normalizeRepoSlug(persistedTargetRepo)}"). Request overrides are not accepted.`,
      };
    }

    // 1. Quality Gate Check: Delivery requires passing authoritative verification
    const verification = this.store.getLatestVerification(run.id);
    if (!verification || !verification.passed) {
      return {
        success: false,
        status: 400,
        blocked: true,
        error: `Delivery blocked: Task ${task.key} has not passed authoritative quality gates. Run must be verified before delivery.`,
      };
    }

    // 2. Approval Policy Enforcement
    if (task.requireApproval && (!options.isApproved || !options.approvedBy)) {
      return {
        success: false,
        status: 403,
        blocked: true,
        approvalRequired: true,
        error: `Delivery blocked: Backend approval policy requires explicit operator approval before delivery.`,
      };
    }

    // 3. Worktree inspection and remote target validation
    if (!run.worktreePath || !fs.existsSync(run.worktreePath)) {
      return {
        success: false,
        status: 400,
        blocked: true,
        error: `Delivery blocked: Worktree for run ${run.id} does not exist at ${run.worktreePath}.`,
      };
    }

    const realWorktree = fs.realpathSync(run.worktreePath);
    let deliveredCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: realWorktree,
      encoding: 'utf-8',
    }).trim();

    // Check that verified revision strictly matches delivered commit revision
    if (verification.revisionSha !== deliveredCommit) {
      return {
        success: false,
        status: 409,
        blocked: true,
        error: `Delivery blocked: Stale verification evidence. Latest verified revision (${verification.revisionSha}) does not match current commit to deliver (${deliveredCommit}). Re-verification required.`,
      };
    }

    // Check that all acceptance criteria have been verified
    const requiredCriteria = (task.acceptanceCriteria || []).map((c) => c.id);
    const unverifiedCriteria = requiredCriteria.filter((cid) => !(verification.criteriaVerified || []).includes(cid));
    if (unverifiedCriteria.length > 0) {
      return {
        success: false,
        status: 400,
        blocked: true,
        error: `Delivery blocked: Acceptance criteria [${unverifiedCriteria.join(', ')}] have not been verified for commit ${deliveredCommit}.`,
      };
    }

    // Determine target remote
    const remoteTarget = options.disposableRemoteDir && fs.existsSync(options.disposableRemoteDir)
      ? options.disposableRemoteDir
      : 'origin';

    let originUrl: string | undefined;
    try {
      originUrl = execFileSync('git', ['remote', 'get-url', remoteTarget], {
        cwd: realWorktree,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch {
      if (remoteTarget !== 'origin') {
        originUrl = remoteTarget;
      }
    }

    if (!originUrl && remoteTarget === 'origin') {
      return {
        success: false,
        status: 400,
        blocked: true,
        error: `Delivery blocked: Workspace repository at ${realWorktree} has no '${remoteTarget}' remote configured for delivery.`,
      };
    }

    // Validate that the workspace repository and delivery remote match the target
    // recorded for the run.
    const expectedRepo = persistedTargetRepo;
    if (expectedRepo && originUrl) {
      const expectedSlug = normalizeRepoSlug(expectedRepo);
      const originSlug = normalizeRepoSlug(originUrl);
      if (!isLocalRemoteOrigin(originUrl) && expectedSlug && originSlug && !areRepoSlugsCompatible(expectedSlug, originSlug)) {
        return {
          success: false,
          status: 400,
          blocked: true,
          error: `Delivery blocked: Workspace repository delivery remote '${originSlug}' does not match configured target repository '${expectedSlug}'.`,
        };
      }
    }

    // Evidence currency: the passing record must be bound to the task's current
    // requirements and verification configuration. Legacy (unbound), stale, or
    // re-configured evidence requires fresh verification before delivery.
    const validity = assessEvidenceValidity(task, verification);
    if (!validity.valid) {
      return {
        success: false,
        status: 409,
        blocked: true,
        error: `Delivery blocked (${validity.reason}): ${validity.detail} Fresh verification against the current requirements is required.`,
      };
    }

    // 4. Remote Base Branch Fetch and Drift Verification
    const baseBranch = options.targetBaseBranch || 'main';
    let latestRemoteBaseSha = '';

    try {
      execFileSync('git', ['fetch', remoteTarget, baseBranch], {
        cwd: realWorktree,
        stdio: 'pipe',
      });
    } catch (fetchErr: any) {
      return {
        success: false,
        status: 502,
        blocked: true,
        error: `Delivery blocked: Failed to fetch remote base branch '${baseBranch}' from '${remoteTarget}': ${fetchErr.stderr?.toString() || fetchErr.message}`,
      };
    }

    try {
      latestRemoteBaseSha = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
        cwd: realWorktree,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch (revErr: any) {
      return {
        success: false,
        status: 502,
        blocked: true,
        error: `Delivery blocked: Failed to resolve FETCH_HEAD for remote base branch '${baseBranch}': ${revErr.message}`,
      };
    }

    if (!latestRemoteBaseSha) {
      return {
        success: false,
        status: 502,
        blocked: true,
        error: `Delivery blocked: Remote base branch '${baseBranch}' resolved to empty commit SHA.`,
      };
    }

    if (latestRemoteBaseSha !== run.baseCommit) {
      console.log(`[Delivery] Remote base branch '${baseBranch}' advanced from ${run.baseCommit} to ${latestRemoteBaseSha}. Merging and re-verifying combined result...`);

      try {
        execFileSync('git', ['merge', '--no-edit', latestRemoteBaseSha], {
          cwd: realWorktree,
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_COMMITTER_NAME: 'Dupond Orchestrator',
            GIT_COMMITTER_EMAIL: 'dupond@example.com',
            GIT_AUTHOR_NAME: 'Dupond Orchestrator',
            GIT_AUTHOR_EMAIL: 'dupond@example.com',
          },
        });
      } catch (mergeErr: any) {
        try {
          execFileSync('git', ['merge', '--abort'], { cwd: realWorktree, stdio: 'pipe' });
        } catch {}
        return {
          success: false,
          status: 409,
          blocked: true,
          error: `Delivery blocked: Base branch ${baseBranch} has advanced to ${latestRemoteBaseSha} and could not be merged cleanly into ${run.targetBranch}: ${mergeErr.stderr?.toString() || mergeErr.message}`,
        };
      }

      const mergedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: realWorktree,
        encoding: 'utf-8',
      }).trim();

      const recheck = await this.verifier.verify({
        worktreePath: realWorktree,
        baseCommit: latestRemoteBaseSha,
        verificationCommands: task.verificationCommands,
        protectedPaths: task.protectedPaths,
        acceptanceCriteria: task.acceptanceCriteria,
        description: task.description,
      });

      if (!recheck.passed) {
        return {
          success: false,
          status: 409,
          blocked: true,
          error: `Delivery blocked: Base branch ${baseBranch} has advanced and combined changes failed re-validation: ${recheck.failureReason}`,
        };
      }

      // Record fresh passing verification tied to merged SHA
      this.store.recordVerification({
        id: `ver-drift-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        runId: run.id,
        attemptId: verification.attemptId || `drift-merge-${Date.now()}`,
        revisionSha: mergedSha,
        passed: true,
        checks: recheck.checks,
        criteriaVerified: recheck.criteriaVerified,
        failureReason: null,
        revisionTreeSha: recheck.treeSha || null,
        requirementsFingerprint: recheck.binding?.requirementsFingerprint || null,
        verificationConfigFingerprint: recheck.binding?.verificationConfigFingerprint || null,
        evidenceBindingVersion: recheck.binding?.evidenceBindingVersion || null,
      });

      // Re-pin the durable verified ref to the newly accepted merged revision
      try {
        execFileSync('git', ['update-ref', verifiedRefForRun(run.id), mergedSha], {
          cwd: realWorktree,
          stdio: 'pipe',
        });
      } catch (pinErr: any) {
        this.store.recordAudit({
          taskId: task.id,
          runId: run.id,
          eventType: 'REVISION_PIN_FAILED',
          actor: 'delivery',
          details: { error: pinErr.message, commitSha: mergedSha },
        });
      }

      // Update run's baseCommit
      this.store.updateRun(run.id, { baseCommit: latestRemoteBaseSha });
      run.baseCommit = latestRemoteBaseSha;

      // If integration changes the approved revision, invalidate its approval and require approval for the new revision
      if (mergedSha !== deliveredCommit) {
        return {
          success: false,
          status: 403,
          blocked: true,
          approvalRequired: true,
          deliveredCommit: mergedSha,
          baseCommit: latestRemoteBaseSha,
          error: `Delivery blocked: Base branch ${baseBranch} advanced to ${latestRemoteBaseSha} and integration produced a new commit ${mergedSha}. Prior approval for ${deliveredCommit} is invalidated; operator approval is required for ${mergedSha}.`,
        };
      }

      deliveredCommit = mergedSha;
    }

    // 4b. Approval identity. Everything the operator is being asked to accept —
    // the candidate revision, the contract (specification, criteria, and
    // verification configuration), and the evidence row it rests on — is
    // snapshotted once here and handed to the approval write, which re-validates
    // it inside its own transaction. Anything that changed while this delivery
    // was running makes the approval refuse rather than certify a contract that
    // was never reviewed.
    const approvalTask = this.store.getTask(task.id);
    const approvalVerification = this.store.getLatestVerification(run.id);
    if (!approvalTask || !approvalVerification) {
      return {
        success: false,
        status: 409,
        blocked: true,
        error: `Delivery blocked: The task or its evidence for run ${run.id} is no longer recorded; nothing was approved.`,
      };
    }
    const approvalBinding = computeEvidenceBinding(approvalTask);
    const approvalExpectation: ApprovalExpectation = {
      revisionSha: deliveredCommit,
      requirementsFingerprint: approvalBinding.requirementsFingerprint,
      verificationConfigFingerprint: approvalBinding.verificationConfigFingerprint,
      verificationId: approvalVerification.id,
      evidenceBindingVersion: approvalBinding.evidenceBindingVersion,
    };

    // 5. Idempotent Delivery Reconciliation: Check for existing delivery on this branch/run
    let prNumber: number | null = null;
    let prUrl: string = '';
    let ciStatus: DeliveryRecord['ciStatus'] = 'pending';

    const existingDelivery = this.store.getDeliveryForRun(run.id) || this.store.getDeliveryByBranch(run.targetBranch);
    if (existingDelivery && existingDelivery.prUrl) {
      if (existingDelivery.deliveredCommit === deliveredCommit) {
        console.log(`[Delivery] Existing PR found for branch ${run.targetBranch}: ${existingDelivery.prUrl} matching delivered commit ${deliveredCommit}. Reconciling...`);

        // Re-approval: the PR and delivered commit are reused, but the early
        // return must not skip the approval that this call explicitly carries.
        // After a requirements change the delivery sits at pending_approval;
        // reaching here already passed the approval gate, so record the fresh
        // operator approval against the existing delivery — never restoring it
        // silently — and apply the lifecycle transition, which re-validates
        // the current evidence inside its own transaction.
        let reconciledDelivery = existingDelivery;
        let reapproved = false;
        if (task.requireApproval && (existingDelivery.approvalStatus !== 'approved' || options.isApproved === true)) {
          if (options.isApproved === true && options.approvedBy) {
            const approval = this.store.approveDelivery(existingDelivery.id, options.approvedBy, approvalExpectation);
            if (!approval.approved || !approval.delivery) {
              return {
                success: false,
                status: 409,
                blocked: true,
                approvalRequired: true,
                deliveryRecord: approval.delivery || existingDelivery,
                prUrl: existingDelivery.prUrl,
                branch: existingDelivery.branch,
                deliveredCommit: existingDelivery.deliveredCommit,
                error: `Delivery blocked: Approval was refused because it no longer matches the current requirements or evidence — ${approval.detail}`,
              };
            }
            reconciledDelivery = approval.delivery;
            reapproved = true;
          } else {
            return {
              success: false,
              status: 403,
              blocked: true,
              approvalRequired: true,
              error: `Delivery blocked: Approval for delivered commit ${deliveredCommit} is "${existingDelivery.approvalStatus}" and was not re-granted. Explicit operator approval against the current evidence is required.`,
            };
          }
        }

        const reconcileLifecycle = new LifecycleService(this.store);
        const reconcileTransition = reconcileLifecycle.transition({
          taskId: task.id,
          to: 'done',
          actor: options.approvedBy || 'delivery-reconcile',
          viaDelivery: true,
          reason: existingDelivery.prUrl,
        });
        if (!reconcileTransition.ok) {
          this.store.recordAudit({
            taskId: task.id,
            runId: run.id,
            eventType: 'DELIVERY_STATUS_NOT_APPLIED',
            actor: 'delivery',
            details: { reason: reconcileTransition.reason, detail: reconcileTransition.detail },
          });
        }

        return {
          success: true,
          status: 200,
          deliveryRecord: reconciledDelivery,
          prUrl: existingDelivery.prUrl,
          branch: existingDelivery.branch,
          deliveredCommit: existingDelivery.deliveredCommit,
          baseCommit: existingDelivery.baseCommit,
          ciStatus: existingDelivery.ciStatus,
          message: reapproved
            ? `Idempotent delivery: Existing pull request reconciled at ${existingDelivery.prUrl}; fresh operator approval recorded against commit ${deliveredCommit}`
            : `Idempotent delivery: Existing pull request reconciled at ${existingDelivery.prUrl}`,
        };
      } else {
        console.log(`[Delivery] Existing PR found at ${existingDelivery.prUrl} for older revision ${existingDelivery.deliveredCommit}. Advancing PR to new verified commit ${deliveredCommit}...`);
        prUrl = existingDelivery.prUrl;
        prNumber = existingDelivery.prNumber ?? null;
      }
    }

    // 6. Ensure the pushed commit is the verified commit
    const headBeforePush = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: realWorktree,
      encoding: 'utf-8',
    }).trim();

    if (headBeforePush !== deliveredCommit) {
      return {
        success: false,
        status: 409,
        blocked: true,
        error: `Delivery blocked: Repository HEAD (${headBeforePush}) does not match delivery commit (${deliveredCommit}).`,
      };
    }

    const currentVerification = this.store.getLatestVerification(run.id);
    if (!currentVerification || !currentVerification.passed || currentVerification.revisionSha !== deliveredCommit) {
      return {
        success: false,
        status: 409,
        blocked: true,
        error: `Delivery blocked: Pushed commit (${deliveredCommit}) must have passing authoritative verification evidence for its exact revision.`,
      };
    }

    const repoTarget = persistedTargetRepo;

    // Support disposable bare git repository for isolated testing
    if (options.disposableRemoteDir && fs.existsSync(options.disposableRemoteDir)) {
      try {
        execFileSync('git', ['push', options.disposableRemoteDir, `${run.targetBranch}:${run.targetBranch}`], {
          cwd: realWorktree,
          stdio: 'pipe',
        });
        prNumber = Math.floor(Math.random() * 900) + 100;
        prUrl = `https://github.com/${repoTarget}/pull/${prNumber}`;
        ciStatus = 'pending';
      } catch (err: any) {
        return {
          success: false,
          status: 500,
          error: `Failed to push to disposable repository: ${err.message}`,
        };
      }
    } else {
      let isLocalBareOrigin = false;
      try {
        const originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
          cwd: realWorktree,
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim();
        if (isLocalRemoteOrigin(originUrl)) {
          isLocalBareOrigin = true;
        }
      } catch {
        // no origin configured
      }

      if (isLocalBareOrigin) {
        try {
          execFileSync('git', ['push', '-u', 'origin', run.targetBranch], {
            cwd: realWorktree,
            stdio: 'pipe',
          });
          prNumber = Math.floor(Math.random() * 900) + 100;
          prUrl = `https://github.com/${repoTarget}/pull/${prNumber}`;
          ciStatus = 'pending';
        } catch (err: any) {
          return {
            success: false,
            status: 500,
            error: `Failed to push to workspace repository origin: ${err.message}`,
          };
        }
      } else {
        // Real GitHub flow using gh CLI
        try {
          // Push branch to origin
          execFileSync('git', ['push', '-u', 'origin', run.targetBranch], {
            cwd: realWorktree,
            stdio: 'pipe',
          });

        // Check if PR already exists via gh pr list
        const prListOut = execFileSync('gh', ['pr', 'list', '--head', run.targetBranch, '--json', 'number,url'], {
          cwd: realWorktree,
          encoding: 'utf-8',
        }).trim();

        const prList = prListOut ? JSON.parse(prListOut) : [];
        if (prList.length > 0) {
          prNumber = prList[0].number;
          prUrl = prList[0].url;
        } else {
          // Create PR via gh pr create
          const prBody = `## Autonomous PR Delivery: ${task.key} - ${task.title}
### Acceptance Criteria Verified:
${task.acceptanceCriteria.map((c) => `- [x] ${c.title}`).join('\n')}

**Base Commit:** \`${run.baseCommit}\`
**Delivered Commit:** \`${deliveredCommit}\`
**Verification Revision:** \`${verification.revisionSha}\`
**Quality Gate Status:** Passed (authoritative verification attested)

*Automated pull request delivered by Dupond Orchestrator. Human review required before merging.*`;

          const prCreateOut = execFileSync('gh', [
            'pr', 'create',
            '--title', `[${task.key}] ${task.title}`,
            '--body', prBody,
            '--head', run.targetBranch,
            '--base', baseBranch,
          ], {
            cwd: realWorktree,
            encoding: 'utf-8',
          }).trim();

          prUrl = prCreateOut;
          const matchNum = prUrl.match(/\/pull\/(\d+)/);
          if (matchNum) prNumber = parseInt(matchNum[1], 10);
        }

        // Check CI status
        try {
          const checksOut = execFileSync('gh', ['pr', 'checks', run.targetBranch], {
            cwd: realWorktree,
            encoding: 'utf-8',
            stdio: 'pipe',
          });
          ciStatus = checksOut.includes('fail') ? 'failure' : 'pending';
        } catch {
          ciStatus = 'pending';
        }

      } catch (err: any) {
        return {
          success: false,
          status: 502,
          error: `GitHub delivery failed during git push or gh pr create: ${err.stderr || err.message}`,
        };
      }
    }
  }

    // 7. Record Delivery in Store
    const deliveryRecord = this.store.recordDelivery({
      runId: run.id,
      provider: 'github',
      repoUrl: repoTarget,
      baseCommit: run.baseCommit,
      deliveredCommit,
      branch: run.targetBranch,
      prNumber,
      prUrl,
      ciStatus,
      approvalStatus: 'approved',
      approvedBy: options.approvedBy || 'authorized-operator',
    }, approvalExpectation);

    if (task.requireApproval && deliveryRecord.approvalStatus !== 'approved') {
      // The pull request genuinely exists and is kept; only the approval is
      // refused, so the operator re-approves against current evidence and the
      // reconcile path reuses this PR instead of opening a second one.
      return {
        success: false,
        status: 409,
        blocked: true,
        approvalRequired: true,
        deliveryRecord,
        prUrl,
        branch: run.targetBranch,
        deliveredCommit,
        baseCommit: run.baseCommit,
        ciStatus,
        error: `Delivery blocked: Pull request ${prUrl} was delivered, but the approval was refused because the requirements or evidence changed while delivery was running. Re-approval against the current evidence is required.`,
      };
    }

    // Advance task status to done through the authoritative lifecycle service
    // (re-checks evidence binding and the just-recorded approval, applied with
    // compare-and-swap plus audit event in one transaction).
    const lifecycle = new LifecycleService(this.store);
    const doneTransition = lifecycle.transition({
      taskId: task.id,
      to: 'done',
      actor: options.approvedBy || 'delivery',
      viaDelivery: true,
      reason: prUrl || `delivered ${deliveredCommit}`,
    });
    if (!doneTransition.ok) {
      this.store.recordAudit({
        taskId: task.id,
        runId: run.id,
        eventType: 'DELIVERY_STATUS_NOT_APPLIED',
        actor: 'delivery',
        details: { reason: doneTransition.reason, detail: doneTransition.detail },
      });
    }

    return {
      success: true,
      status: 200,
      deliveryRecord,
      prUrl,
      branch: run.targetBranch,
      deliveredCommit,
      baseCommit: run.baseCommit,
      ciStatus,
      message: `Pull request successfully delivered: ${prUrl}`,
    };
  }
}

export const defaultGitHubDelivery = new GitHubDeliveryService();
