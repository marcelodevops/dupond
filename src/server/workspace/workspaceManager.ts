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
    this.ensureWorktreesRoot();
    const worktreePath = path.resolve(this.worktreesRoot, runId);

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
      throw new Error(`Base commit ${baseCommit} is not a valid commit in repository ${this.baseRepoDir}: ${err.message}`);
    }

    // Create the worktree: git worktree add -B <branchName> <worktreePath> <baseCommit>
    try {
      execFileSync('git', ['worktree', 'add', '-B', branchName, worktreePath, baseCommit], {
        cwd: this.baseRepoDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err: any) {
      throw new Error(`Failed to create worktree at ${worktreePath}: ${err.stderr || err.message}`);
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
      throw new Error(`Worktree revision mismatch: expected ${expectedSha}, got ${currentSha}`);
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
}

export const defaultWorkspaceManager = new WorkspaceManager();
