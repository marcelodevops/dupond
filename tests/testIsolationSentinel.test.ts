import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it } from 'vitest';
import { createDisposableRepo } from './fixtures/disposableRepo.js';
import { TaskStore } from '../src/server/db/database.js';
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

function captureInvokingRepoSentinel(repoDir: string) {
  const dataDir = path.join(repoDir, 'data');
  return {
    refs: execFileSync('git', ['show-ref'], { cwd: repoDir, encoding: 'utf-8' }),
    worktrees: execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, encoding: 'utf-8' }),
    worktreesDirExists: fs.existsSync(path.join(repoDir, '.dupond_worktrees')),
    db: snapshotFile(path.join(dataDir, 'dupond.db')),
    dbWal: snapshotFile(path.join(dataDir, 'dupond.db-wal')),
    dbShm: snapshotFile(path.join(dataDir, 'dupond.db-shm')),
    state: snapshotFile(path.join(dataDir, 'dupond_state.json')),
    connKey: snapshotFile(path.join(dataDir, '.dupond_conn_key')),
  };
}

describe('Test isolation sentinel and shared Git-ref attribution', () => {
  it(
    'runs all seven repaired suites from a disposable invoking repo without mutating its refs, worktrees, or storage/WAL/SHM files',
    () => {
      const repoRoot = path.resolve(import.meta.dirname, '..');
      const invokingRepo = createDisposableRepo('dupond-invoking-sentinel-');

      try {
        // Seed sentinel storage files inside the disposable invoking repo BEFORE any child imports
        const dataDir = path.join(invokingRepo.repoDir, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        const dbPath = path.join(dataDir, 'dupond.db');
        const sentinelStore = new TaskStore(dbPath);
        sentinelStore.createTask({
          id: 'sentinel-task-1',
          key: 'SEN-1',
          title: 'Sentinel task',
          description: 'Must remain untouched',
          status: 'todo',
          priority: 'medium',
          targetRepo: 'disposable-test/repo',
          targetRepoPath: invokingRepo.repoDir,
          baseCommit: 'HEAD',
        });
        sentinelStore.getRawDb().close();

        fs.writeFileSync(
          path.join(dataDir, 'dupond_state.json'),
          JSON.stringify({ tasks: [{ id: 'sentinel-task-1', key: 'SEN-1', status: 'todo' }] }, null, 2),
        );
        fs.writeFileSync(path.join(dataDir, '.dupond_conn_key'), '0'.repeat(64) + '\n');

        const before = captureInvokingRepoSentinel(invokingRepo.repoDir);

        const vitestBin = path.join(repoRoot, 'node_modules', '.bin', 'vitest');
        const repairedSuites = [
          path.join(repoRoot, 'tests', 'repairLoop.test.ts'),
          path.join(repoRoot, 'tests', 'delivery.test.ts'),
          path.join(repoRoot, 'tests', 'securityTier1.test.ts'),
          path.join(repoRoot, 'tests', 'sandbox.test.ts'),
          path.join(repoRoot, 'tests', 'workerAdapter.test.ts'),
          path.join(repoRoot, 'tests', 'e2ePipeline.test.ts'),
          path.join(repoRoot, 'tests', 'providerWorkers.test.ts'),
        ];

        // Build clean child env: synthetic credentials only, no ambient storage overrides
        const childEnv: Record<string, string | undefined> = {
          ...process.env,
          GEMINI_API_KEY: 'AIzaSyTestSyntheticKey000000',
          OPENAI_API_KEY: 'sk-test-synthetic-key-000000',
        };
        delete childEnv.GOOGLE_API_KEY;
        delete childEnv.DUPOND_DB_PATH;
        delete childEnv.DUPOND_STATE_FILE;
        delete childEnv.DUPOND_CONN_KEY_PATH;
        delete childEnv.DUPOND_APPROVAL_TOKEN;
        delete childEnv.GITHUB_TOKEN;

        const child = spawnSync(
          vitestBin,
          ['run', '--root', repoRoot, ...repairedSuites],
          {
            cwd: invokingRepo.repoDir,
            env: childEnv as NodeJS.ProcessEnv,
            encoding: 'utf-8',
            timeout: 120_000,
          },
        );

        assert.strictEqual(
          child.status,
          0,
          `Child vitest run failed (status=${child.status}):\n${child.stdout}\n${child.stderr}`,
        );

        const after = captureInvokingRepoSentinel(invokingRepo.repoDir);
        assert.strictEqual(after.refs, before.refs, 'Invoking repo Git refs must remain unchanged');
        assert.strictEqual(after.worktrees, before.worktrees, 'Invoking repo Git worktrees must remain unchanged');
        assert.strictEqual(after.worktreesDirExists, false, 'Invoking repo .dupond_worktrees must not be created');
        assert.deepStrictEqual(after.db, before.db, 'Invoking repo data/dupond.db must remain unchanged');
        assert.deepStrictEqual(after.dbWal, before.dbWal, 'Invoking repo data/dupond.db-wal must remain unchanged');
        assert.deepStrictEqual(after.dbShm, before.dbShm, 'Invoking repo data/dupond.db-shm must remain unchanged');
        assert.deepStrictEqual(after.state, before.state, 'Invoking repo data/dupond_state.json must remain unchanged');
        assert.deepStrictEqual(after.connKey, before.connKey, 'Invoking repo data/.dupond_conn_key must remain unchanged');
      } finally {
        invokingRepo.cleanup();
      }
    },
    120_000,
  );

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
