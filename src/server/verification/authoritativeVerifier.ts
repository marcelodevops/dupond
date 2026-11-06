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

  /**
   * Authoritatively verifies changes in a worktree against operator-configured checks.
   * Does NOT rely on worker declarations or passCriterion calls.
   */
  public async verify(params: {
    worktreePath: string;
    baseCommit: string;
    verificationCommands: string[];
    protectedPaths?: string[];
    acceptanceCriteria?: Array<{ id: string; title: string }>;
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

    // 3. Run Operator-Configured Verification Commands
    const commands = params.verificationCommands.length > 0
      ? params.verificationCommands
      : ['npm test'];

    const checks: AuthoritativeCheckResult[] = [];
    let allPassed = true;
    let firstFailingReason: string | undefined;

    for (const cmd of commands) {
      const res = await this.sandbox.execute({
        worktreePath: realWorktree,
        command: cmd,
        timeoutMs: 60000,
      });

      const passed = res.exitCode === 0;
      checks.push({
        command: cmd,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        passed,
        durationMs: res.durationMs,
      });

      if (!passed) {
        allPassed = false;
        if (!firstFailingReason) {
          firstFailingReason = `Command "${cmd}" exited with code ${res.exitCode}: ${res.stderr || res.stdout || 'Check failed'}`;
        }
      }
    }

    // 4. Map verified criteria strictly upon passing all checks
    const criteriaVerified = allPassed && params.acceptanceCriteria
      ? params.acceptanceCriteria.map((c) => c.id)
      : [];

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
