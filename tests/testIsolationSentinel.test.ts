import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'vitest';
import { createDisposableRepo } from './fixtures/disposableRepo.js';
import { TaskStore } from '../src/server/db/database.js';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.js';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.js';
import { RepairCoordinator } from '../src/server/coordinator/repairCoordinator.js';
import {
  captureRepoBaseline,
  inspectAndVerifyRepoChanges,
} from '../src/server/worker/opencodeWorkerAdapter.js';

function snapshotFile(filePath: string): { exists: boolean; size?: number; sha256?: string } {
  if (!fs.existsSync(filePath)) {
    return { exists: false };
  }
  const buf = fs.readFileSync(filePath);
  return {
    exists: true,
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

function captureRepoAndStorageSentinel(cwd: string) {
  return {
    refs: execFileSync('git', ['show-ref'], { cwd, encoding: 'utf-8' }),
    worktrees: execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf-8' }),
    db: snapshotFile(path.join(cwd, 'data', 'dupond.db')),
    state: snapshotFile(path.join(cwd, 'data', 'dupond_state.json')),
    connKey: snapshotFile(path.join(cwd, 'data', '.dupond_conn_key')),
  };
}

describe('Test isolation sentinel and shared Git-ref attribution', () => {
  it('leaves invoking repository refs, worktrees, DB, state, and connection-key files unchanged', async () => {
    const before = captureRepoAndStorageSentinel(process.cwd());
    const repo = createDisposableRepo('dupond-sentinel-');

    try {
      const store = new TaskStore(':memory:');
      const wm = new WorkspaceManager(repo.repoDir);
      const verifier = new AuthoritativeVerifier();
      const coordinator = new RepairCoordinator(store, wm, verifier);

      const task = store.createTask({
        key: 'SENT-101',
        title: 'Sentinel isolation check',
        description: 'Must execute only inside disposable repo',
        status: 'todo',
        priority: 'medium',
        targetRepo: 'disposable-test/repo',
        targetRepoPath: repo.repoDir,
        baseCommit: 'HEAD',
        allowedPaths: ['src/**'],
        protectedPaths: [],
        verificationCommands: ['node -e "process.exit(0)"'],
        acceptanceCriteria: [{ id: 'c1', title: 'Exit 0', completed: false, checkCommand: 'node -e "process.exit(0)"' }],
        workerConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
        maxAttempts: 1,
        timeoutSeconds: 30,
        requireApproval: false,
      });

      const run = await coordinator.executeTaskRun({
        task,
        worker: {
          name: 'sentinel_mock_worker',
          async isAvailable() { return { available: true }; },
          async execute(ctx) {
            fs.writeFileSync(path.join(ctx.worktreePath, 'src', 'sentinel.ts'), 'export const s = 1;\n');
            return {
              success: true,
              filesModified: ['src/sentinel.ts'],
              diff: '+export const s = 1;',
              commitMessage: 'feat: sentinel check',
              logs: ['ok'],
              durationMs: 10,
            };
          },
        },
        store,
        workspaceManager: wm,
        verifier,
      });

      assert.strictEqual(run.status, 'completed');
    } finally {
      repo.cleanup();
    }

    const after = captureRepoAndStorageSentinel(process.cwd());
    assert.strictEqual(after.refs, before.refs, 'Invoking repo Git refs must remain unchanged');
    assert.strictEqual(after.worktrees, before.worktrees, 'Invoking repo Git worktrees must remain unchanged');
    assert.deepStrictEqual(after.db, before.db, 'Invoking repo data/dupond.db must remain unchanged');
    assert.deepStrictEqual(after.state, before.state, 'Invoking repo data/dupond_state.json must remain unchanged');
    assert.deepStrictEqual(after.connKey, before.connKey, 'Invoking repo data/.dupond_conn_key must remain unchanged');
  });

  it('blocks genuine worker ref edits and describes concurrent shared-ref deltas with unknown attribution', () => {
    const repo = createDisposableRepo('dupond-ref-attr-');
    const wtWorker = path.join(repo.tmpBase, 'wt-worker');
    const wtOther = path.join(repo.tmpBase, 'wt-other');

    try {
      execFileSync('git', ['worktree', 'add', '-b', 'dupond/worker-run', wtWorker, 'HEAD'], { cwd: repo.repoDir });
      execFileSync('git', ['worktree', 'add', '-b', 'dupond/other-run', wtOther, 'HEAD'], { cwd: repo.repoDir });

      // 1. Concurrent shared-ref change from another worktree fails closed with unknown-attribution wording
      const baselineConcurrent = captureRepoBaseline(wtWorker);
      fs.writeFileSync(path.join(wtOther, 'src', 'other.ts'), 'export const other = true;\n');
      execFileSync('git', ['add', '.'], { cwd: wtOther });
      execFileSync('git', ['commit', '-m', 'concurrent commit in other worktree'], { cwd: wtOther });

      const concurrentResult = inspectAndVerifyRepoChanges(wtWorker, baselineConcurrent, {
        allowedPaths: ['src/**'],
        protectedPaths: [],
      });
      assert.strictEqual(concurrentResult.filesModified.length, 0);
      assert.ok(
        concurrentResult.violations.some((v) =>
          v.includes('Shared Git ref changed concurrently with unknown attribution (worker or external process): refs/heads/dupond/other-run'),
        ),
        `Expected unknown-attribution violation for concurrent shared ref, got: ${concurrentResult.violations.join('; ')}`,
      );
      assert.ok(
        !concurrentResult.violations.some((v) => v.includes('Unauthorized Git ref modification: refs/heads/dupond/other-run')),
        'Must not assert worker mutated an external shared ref when attribution is unknown',
      );

      // 2. Genuine worker ref/HEAD modification in wtWorker remains blocked as unauthorized
      const baselineWorker = captureRepoBaseline(wtWorker);
      fs.writeFileSync(path.join(wtWorker, 'src', 'index.ts'), 'export const placeholder = false;\n');
      execFileSync('git', ['add', '.'], { cwd: wtWorker });
      execFileSync('git', ['commit', '-m', 'worker unauthorized commit'], { cwd: wtWorker });

      const workerResult = inspectAndVerifyRepoChanges(wtWorker, baselineWorker, {
        allowedPaths: ['src/**'],
        protectedPaths: [],
      });
      assert.ok(
        workerResult.violations.some((v) => v.startsWith('Unauthorized HEAD commit change')),
        'Genuine worker HEAD commit must remain blocked',
      );
      assert.ok(
        workerResult.violations.some((v) => v === 'Unauthorized Git ref modification: refs/heads/dupond/worker-run'),
        'Genuine worker modification of its own worktree branch ref must remain blocked',
      );
    } finally {
      repo.cleanup();
    }
  });
});
