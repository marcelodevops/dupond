import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { SandboxExecutor, defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';

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
   * Authoritatively verifies changes in a worktree against operator-configured checks.
   * Does NOT rely on worker declarations or passCriterion calls.
   */
  public async verify(params: {
    worktreePath: string;
    baseCommit: string;
    verificationCommands: Array<string | { command: string; criteriaIds?: string[] }>;
    protectedPaths?: string[];
    acceptanceCriteria?: Array<{ id: string; title: string; checkCommand?: string }>;
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

    // 2. Integrity Check: verify no protected files were modified
    const protectedPaths = params.protectedPaths || [];
    if (protectedPaths.length > 0) {
      try {
        const modifiedFiles = execFileSync('git', ['diff', '--name-only', params.baseCommit, 'HEAD'], {
          cwd: realWorktree,
          encoding: 'utf-8',
        }).trim().split('\n').filter(Boolean);

        for (const file of modifiedFiles) {
          const isProtected = protectedPaths.some((p) => {
            const clean = p.replace(/\*\*?$/, '');
            return file.startsWith(clean) || file === clean;
          });
          if (isProtected) {
            return {
              passed: false,
              revisionSha,
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
          checks: [],
          criteriaVerified: [],
          failureReason: `Integrity check failed during git diff: ${err.message}`,
          durationMs: Date.now() - startTime,
        };
      }
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

    return {
      passed: allPassed,
      revisionSha,
      checks,
      criteriaVerified,
      failureReason: allPassed ? undefined : firstFailingReason,
      durationMs: Date.now() - startTime,
    };
  }
}

export const defaultAuthoritativeVerifier = new AuthoritativeVerifier();
