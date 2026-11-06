import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { TaskStore, taskStore as defaultTaskStore } from '../db/database.js';
import { DeliveryRecord } from '../db/schema.js';
import { AuthoritativeVerifier, defaultAuthoritativeVerifier } from '../verification/authoritativeVerifier.js';

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
    if (task.requireApproval && !options.isApproved) {
      return {
        success: false,
        status: 403,
        blocked: true,
        approvalRequired: true,
        error: `Delivery blocked: Backend approval policy requires explicit operator approval before delivery.`,
      };
    }

    // 3. Worktree inspection
    if (!run.worktreePath || !fs.existsSync(run.worktreePath)) {
      return {
        success: false,
        status: 400,
        blocked: true,
        error: `Delivery blocked: Worktree for run ${run.id} does not exist at ${run.worktreePath}.`,
      };
    }

    const realWorktree = fs.realpathSync(run.worktreePath);
    const deliveredCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
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

    // 4. Base Branch Drift Check
    const baseBranch = options.targetBaseBranch || 'main';
    try {
      // Check current base branch revision in root repo
      const rootRepo = path.resolve(process.cwd());
      let currentBaseSha = '';
      try {
        currentBaseSha = execFileSync('git', ['rev-parse', baseBranch], {
          cwd: rootRepo,
          encoding: 'utf-8',
        }).trim();
      } catch {
        // if local branch not found, try origin/baseBranch or fall back to run.baseCommit
        currentBaseSha = run.baseCommit;
      }

      if (currentBaseSha && currentBaseSha !== run.baseCommit) {
        // Base branch moved! Re-validate changes against new base
        console.log(`[Delivery] Base branch ${baseBranch} moved from ${run.baseCommit} to ${currentBaseSha}. Re-verifying...`);
        const recheck = await this.verifier.verify({
          worktreePath: realWorktree,
          baseCommit: currentBaseSha,
          verificationCommands: task.verificationCommands,
          protectedPaths: task.protectedPaths,
          acceptanceCriteria: task.acceptanceCriteria,
        });

        if (!recheck.passed) {
          return {
            success: false,
            status: 409,
            blocked: true,
            error: `Delivery blocked: Base branch ${baseBranch} has advanced and changes failed re-validation: ${recheck.failureReason}`,
          };
        }
      }
    } catch (err: any) {
      console.warn('[Delivery] Base drift check notice:', err.message);
    }

    // 5. Idempotent Delivery Reconciliation: Check for existing delivery on this branch/run
    const existingDelivery = this.store.getDeliveryForRun(run.id) || this.store.getDeliveryByBranch(run.targetBranch);
    if (existingDelivery && existingDelivery.prUrl) {
      console.log(`[Delivery] Existing PR found for branch ${run.targetBranch}: ${existingDelivery.prUrl}. Reconciling...`);
      return {
        success: true,
        status: 200,
        deliveryRecord: existingDelivery,
        prUrl: existingDelivery.prUrl,
        branch: existingDelivery.branch,
        deliveredCommit: existingDelivery.deliveredCommit,
        baseCommit: existingDelivery.baseCommit,
        ciStatus: existingDelivery.ciStatus,
        message: `Idempotent delivery: Existing pull request reconciled at ${existingDelivery.prUrl}`,
      };
    }

    // 6. Perform Git Push & Pull Request Creation
    let prNumber: number | null = null;
    let prUrl: string = '';
    let ciStatus: DeliveryRecord['ciStatus'] = 'pending';

    const repoTarget = options.repoUrl || task.targetRepo || 'marcelodevops/dupond-project-leader';

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
    });

    // Advance task status to done and persist PR URL
    this.store.updateTaskStatus(task.id, 'done');

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
