import { DomainError } from '../utils/errors';
import { isSafeGitRef } from '../utils/gitRefs.js';
import { isSafePathSegment, isPathLexicallyContained } from '../artifactPaths.js';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

export class WorkspaceManager {
  private baseRepoDir: string;
  private worktreesRoot: string;

  constructor(baseRepoDir: string = process.cwd(), worktreesRoot?: string) {
    this.baseRepoDir = path.resolve(baseRepoDir);
    this.worktreesRoot = worktreesRoot || path.resolve(this.baseRepoDir, '.dupond_worktrees');
  }

  public getBaseRepoDir(): string {
    return this.baseRepoDir;
  }

  public ensureWorktreesRoot(): void {
    if (!fs.existsSync(this.worktreesRoot)) {
      fs.mkdirSync(this.worktreesRoot, { recursive: true });
    }
  }

  /**
   * Prepares an isolated Git worktree pinned to the given base commit.
   */
  public createWorktree(runId: string, branchName: string, baseCommit: string): WorktreeInfo {
    // runId becomes a path component under worktreesRoot: a key like `../../x`
    // must not be able to place (or delete via cleanup) worktrees outside the
    // managed root. Branch names and base commits become git argv: leading
    // dashes would be parsed as git options.
    if (!isSafePathSegment(runId)) {
      throw new DomainError(`Worktree blocked: run id "${runId}" is not a safe path component (letters, digits, underscore, dash only).`);
    }
    if (!isSafeGitRef(branchName)) {
      throw new DomainError(`Worktree blocked: branch name "${branchName}" is not a valid git refname.`);
    }
    if (!isSafeGitRef(baseCommit)) {
      throw new DomainError(`Worktree blocked: base commit "${baseCommit}" is not a valid git revision.`);
    }

    this.ensureWorktreesRoot();
    const worktreePath = path.resolve(this.worktreesRoot, runId);
    if (!isPathLexicallyContained(this.worktreesRoot, worktreePath) || worktreePath === path.resolve(this.worktreesRoot)) {
      throw new DomainError(`Worktree blocked: resolved worktree path escapes the managed worktrees root.`);
    }

    // If a worktree already exists at this path from an interrupted run, clean it up first
    if (fs.existsSync(worktreePath)) {
      this.cleanupWorktree(worktreePath, branchName);
    }

    // Ensure base commit exists in the repo
    try {
      execFileSync('git', ['rev-parse', '--verify', `${baseCommit}^{commit}`], {
        cwd: this.baseRepoDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err: any) {
      throw new DomainError(`Base commit ${baseCommit} is not a valid commit in repository ${this.baseRepoDir}: ${err.message}`);
    }

    // Create the worktree: git worktree add -B <branchName> <worktreePath> <baseCommit>
    try {
      execFileSync('git', ['worktree', 'add', '-B', branchName, worktreePath, baseCommit], {
        cwd: this.baseRepoDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err: any) {
      throw new DomainError(`Failed to create worktree at ${worktreePath}: ${err.stderr || err.message}`);
    }

    // Verify current HEAD in worktree matches baseCommit
    const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();

    const expectedSha = execFileSync('git', ['rev-parse', baseCommit], {
      cwd: this.baseRepoDir,
      encoding: 'utf-8',
    }).trim();

    if (currentSha !== expectedSha) {
      this.cleanupWorktree(worktreePath, branchName);
      throw new DomainError(`Worktree revision mismatch: expected ${expectedSha}, got ${currentSha}`);
    }

    return {
      worktreePath,
      branch: branchName,
      baseCommit: expectedSha,
    };
  }

  /**
   * Safely removes a worktree and cleans up references.
   */
  public cleanupWorktree(worktreePath: string, branchNameToDelete?: string): void {
    try {
      spawnSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: this.baseRepoDir,
        stdio: 'ignore',
      });
    } catch {
      // Ignore git worktree remove failures
    }

    try {
      spawnSync('git', ['worktree', 'prune'], {
        cwd: this.baseRepoDir,
        stdio: 'ignore',
      });
    } catch {
      // Ignore prune errors
    }

    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (err: any) {
        console.warn(`Warning: failed to force-delete worktree path ${worktreePath}:`, err.message);
      }
    }

    if (branchNameToDelete) {
      try {
        spawnSync('git', ['branch', '-D', branchNameToDelete], {
          cwd: this.baseRepoDir,
          stdio: 'ignore',
        });
      } catch {
        // Ignore branch delete failures
      }
    }
  }

  public getWorktreesRoot(): string {
    return this.worktreesRoot;
  }

  /**
   * Pins a verified commit under a durable ref so the exact verified content
   * survives worktree removal and branch deletion. Resolution stays in git:
   * no parallel snapshot format is introduced.
   */
  public pinRevision(refName: string, commitSha: string): void {
    execFileSync('git', ['update-ref', refName, commitSha], {
      cwd: this.baseRepoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  }

  public resolvePinnedRevision(refName: string): string | null {
    try {
      return execFileSync('git', ['rev-parse', '--verify', refName], {
        cwd: this.baseRepoDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch {
      return null;
    }
  }
}

export const defaultWorkspaceManager = new WorkspaceManager();
