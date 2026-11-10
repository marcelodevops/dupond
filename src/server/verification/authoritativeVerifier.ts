import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { SandboxExecutor, defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';
import { computeEvidenceBinding, EvidenceBinding } from './evidenceBinding.js';

export interface AuthoritativeCheckResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
}

export interface AuthoritativeVerificationResult {
  passed: boolean;
  revisionSha: string;
  /** Git tree of the verified commit: the exact content this evidence proves. */
  treeSha?: string;
  /** Fingerprint of the requirements/config the evidence is bound to. */
  binding?: EvidenceBinding;
  checks: AuthoritativeCheckResult[];
  criteriaVerified: string[];
  failureReason?: string;
  durationMs: number;
}

export class AuthoritativeVerifier {
  private sandbox: SandboxExecutor;

  constructor(sandbox: SandboxExecutor = defaultSandboxExecutor) {
    this.sandbox = sandbox;
  }

  public getSandbox(): SandboxExecutor {
    return this.sandbox;
  }

  /**
   * Uncommitted worktree content: modified/added/deleted tracked files and
   * untracked (non-ignored) files. Git ignores build output that .gitignore
   * excludes, so ordinary test-run side effects that are not part of the
   * candidate do not register here.
   */
  private uncommittedChanges(worktreePath: string): string[] {
    try {
      return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: worktreePath,
        encoding: 'utf-8',
      }).split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      // Unreadable status must not certify anything; treat it as dirty.
      return ['(git status failed)'];
    }
  }

  /**
   * Authoritatively verifies changes in a worktree against operator-configured checks.
   * Does NOT rely on worker declarations or passCriterion calls.
   *
   * Evidence certifies a commit, so the checks must run against exactly that
   * commit's content. The worktree is required to be clean before any command
   * executes and to remain unchanged (same HEAD, still clean) afterwards:
   * uncommitted content — including content produced by the verification
   * commands themselves — is a different candidate from the recorded revision
   * and can never be certified by it.
   */
  public async verify(params: {
    worktreePath: string;
    baseCommit: string;
    verificationCommands: Array<string | { command: string; criteriaIds?: string[] }>;
    protectedPaths?: string[];
    acceptanceCriteria?: Array<{ id: string; title: string; checkCommand?: string }>;
    description?: string;
    runId?: string;
    abortSignal?: AbortSignal;
  }): Promise<AuthoritativeVerificationResult> {
    const startTime = Date.now();
    const realWorktree = fs.realpathSync(params.worktreePath);

    // 1. Get current commit revision
    let revisionSha: string;
    try {
      revisionSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: realWorktree,
        encoding: 'utf-8',
      }).trim();
    } catch (err: any) {
      return {
        passed: false,
        revisionSha: 'unknown',
        checks: [],
        criteriaVerified: [],
        failureReason: `Failed to determine revision SHA in worktree: ${err.message}`,
        durationMs: Date.now() - startTime,
      };
    }

    let treeSha: string | undefined;
    try {
      treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: realWorktree,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // tree remains unknown; evidence stays bound to the commit revision
    }

    const binding = computeEvidenceBinding({
      description: params.description,
      acceptanceCriteria: params.acceptanceCriteria,
      verificationCommands: params.verificationCommands,
      protectedPaths: params.protectedPaths,
    });

    // 1. Integrity Check: verify no protected files were modified
    const protectedPaths = params.protectedPaths || [];
    if (protectedPaths.length > 0) {
      try {
        // Committed *and* working-tree changes count against protected paths.
        // Diffing the index against the base revision catches a worker that
        // modified package.json and never committed it, which a baseCommit..HEAD
        // diff alone would certify as clean.
        const modifiedFiles = execFileSync(
          'git',
          ['diff', '--name-only', params.baseCommit, '--', '.'],
          { cwd: realWorktree, encoding: 'utf-8' },
        ).trim().split('\n').filter(Boolean);

        const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: realWorktree,
          encoding: 'utf-8',
        }).trim().split('\n').filter(Boolean);

        const touched = Array.from(new Set([...modifiedFiles, ...untracked]));
        for (const file of touched) {
          const isProtected = protectedPaths.some((p) => {
            const clean = p.replace(/\*\*?$/, '');
            return file.startsWith(clean) || file === clean;
          });
          if (isProtected) {
            return {
              passed: false,
              revisionSha,
              treeSha,
              binding,
              checks: [],
              criteriaVerified: [],
              failureReason: `Integrity check failed: Worker modified protected file "${file}". Modifying protected acceptance checks or build manifests is forbidden.`,
              durationMs: Date.now() - startTime,
            };
          }
        }
      } catch (err: any) {
        return {
          passed: false,
          revisionSha,
          treeSha,
          binding,
          checks: [],
          criteriaVerified: [],
          failureReason: `Integrity check failed during git diff: ${err.message}`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 1b. Candidate integrity: the checks below execute against the working
    // tree. If it differs from the recorded revision, the evidence would
    // certify content that cannot be delivered. Fail closed instead.
    const dirtyBefore = this.uncommittedChanges(realWorktree);
    if (dirtyBefore.length > 0) {
      return {
        passed: false,
        revisionSha,
        treeSha,
        binding,
        checks: [],
        criteriaVerified: [],
        failureReason:
          `Candidate not deliverable: worktree at ${realWorktree} has ${dirtyBefore.length} uncommitted change(s) ` +
          `(${dirtyBefore.slice(0, 5).join('; ')}). Verification would test content that differs from revision ` +
          `${revisionSha}; a fix in the working tree must never be certified by a commit. Commit the changes as a ` +
          `new candidate revision and verify again.`,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Run Operator-Configured Verification Commands & Map to Criteria
    const commands = params.verificationCommands.length > 0
      ? params.verificationCommands
      : ['npm test'];

    const checks: AuthoritativeCheckResult[] = [];
    let allPassed = true;
    let firstFailingReason: string | undefined;
    const criteriaVerifiedSet = new Set<string>();

    for (const cmdItem of commands) {
      let cmdString = typeof cmdItem === 'string' ? cmdItem : (cmdItem as any).command;
      let mappedCriteria: string[] = [];

      try {
        if (typeof cmdItem === 'string' && cmdItem.startsWith('{')) {
          const parsed = JSON.parse(cmdItem);
          cmdString = parsed.command;
          mappedCriteria = parsed.criteriaIds || [];
        } else if (typeof cmdItem === 'object' && (cmdItem as any).command) {
          cmdString = (cmdItem as any).command;
          mappedCriteria = (cmdItem as any).criteriaIds || [];
        }
      } catch {
        // use plain string
      }

      if (params.abortSignal?.aborted) {
        checks.push({
          command: cmdString,
          exitCode: 130,
          stdout: '',
          stderr: 'Verification aborted by user',
          passed: false,
          durationMs: 0,
        });
        break;
      }

      const res = await this.sandbox.execute({
        worktreePath: realWorktree,
        command: cmdString,
        timeoutMs: 60000,
        runId: params.runId,
        abortSignal: params.abortSignal,
      });

      const passed = res.exitCode === 0;
      checks.push({
        command: cmdString,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        passed,
        durationMs: res.durationMs,
      });

      if (passed) {
        if (mappedCriteria.length > 0) {
          mappedCriteria.forEach((cid) => criteriaVerifiedSet.add(cid));
        }
      } else {
        allPassed = false;
        if (!firstFailingReason) {
          firstFailingReason = `Command "${cmdString}" exited with code ${res.exitCode}: ${res.stderr || res.stdout || 'Check failed'}`;
        }
      }
    }

    // Also check criteria with individual checkCommand definitions
    if (params.acceptanceCriteria) {
      for (const criterion of params.acceptanceCriteria as any[]) {
        if (criterion.checkCommand) {
          const res = await this.sandbox.execute({
            worktreePath: realWorktree,
            command: criterion.checkCommand,
            timeoutMs: 60000,
            runId: params.runId,
            abortSignal: params.abortSignal,
          });
          const passed = res.exitCode === 0;
          checks.push({
            command: criterion.checkCommand,
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            passed,
            durationMs: res.durationMs,
          });
          if (passed) {
            criteriaVerifiedSet.add(criterion.id);
          } else {
            allPassed = false;
            if (!firstFailingReason) {
              firstFailingReason = `Acceptance criterion "${criterion.title}" check failed with exit code ${res.exitCode}`;
            }
          }
        }
      }
    }

    const criteriaVerified = Array.from(criteriaVerifiedSet);
    const requiredCriteria = (params.acceptanceCriteria || []).map((c) => c.id);
    const unmetCriteria = requiredCriteria.filter((id) => !criteriaVerifiedSet.has(id));

    if (unmetCriteria.length > 0) {
      allPassed = false;
      if (!firstFailingReason) {
        firstFailingReason = `Verification incomplete: Acceptance criteria [${unmetCriteria.join(', ')}] have no passing check evidence.`;
      }
    }

    // Post-run candidate integrity: verification commands that edit the tree
    // or advance HEAD mean the content that passed is no longer the recorded
    // revision. Reject the candidate; the next attempt must deliberately
    // prepare a new committed candidate and reverify.
    const headAfterChecks = (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: realWorktree, encoding: 'utf-8' }).trim();
      } catch {
        return revisionSha;
      }
    })();
    const dirtyAfter = this.uncommittedChanges(realWorktree);
    if (allPassed && (dirtyAfter.length > 0 || headAfterChecks !== revisionSha)) {
      allPassed = false;
      firstFailingReason =
        `Verification commands altered the candidate: ` +
        (headAfterChecks !== revisionSha
          ? `HEAD advanced from ${revisionSha} to ${headAfterChecks} during checks. `
          : `Worktree has ${dirtyAfter.length} uncommitted change(s) (${dirtyAfter.slice(0, 5).join('; ')}) after checks. `) +
        `Revision ${revisionSha} cannot be certified from content its checks did not run against. Prepare a new candidate commit and reverify.`;
    }

    return {
      passed: allPassed,
      revisionSha,
      treeSha,
      binding,
      checks,
      criteriaVerified,
      failureReason: allPassed ? undefined : firstFailingReason,
      durationMs: Date.now() - startTime,
    };
  }
}

export const defaultAuthoritativeVerifier = new AuthoritativeVerifier();
