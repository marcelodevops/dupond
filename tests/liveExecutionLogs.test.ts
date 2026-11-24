import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'vitest';

const isolatedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-live-logs-test-')));
process.env.DUPOND_DB_PATH = path.join(isolatedDir, 'dupond.db');
process.env.DUPOND_STATE_FILE = path.join(isolatedDir, 'dupond_state.json');
process.env.DUPOND_CONN_KEY_PATH = path.join(isolatedDir, '.dupond_conn_key');

function createTempRepo(baseDir: string): string {
  const repoDir = path.join(baseDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main', '--template='], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, '.gitignore'), '.dupond_worktrees/\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const x = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
  return repoDir;
}

describe('Live execution progress and log streaming', () => {
  it('persists incremental worker logs to running attempts and preserves them on failure', async () => {
    const { TaskStore } = await import('../src/server/db/database.js');
    const { WorkspaceManager } = await import('../src/server/workspace/workspaceManager.js');
    const { AuthoritativeVerifier } = await import('../src/server/verification/authoritativeVerifier.js');
    const { RepairCoordinator } = await import('../src/server/coordinator/repairCoordinator.js');
    const { SandboxExecutor } = await import('../src/server/sandbox/sandboxExecutor.js');

    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-live-logs-run-')));
    try {
      const repoDir = createTempRepo(tmpDir);
      const store = new TaskStore(':memory:');
      const wm = new WorkspaceManager(repoDir);
      const sandbox = new SandboxExecutor();
      const verifier = new AuthoritativeVerifier(sandbox);
      const coordinator = new RepairCoordinator(store, wm, verifier);

      // 1. Verify SandboxExecutor streams stdout chunks before process exit
      const wt = wm.createWorktree('stream-probe', 'dupond/stream-probe', 'HEAD');
      const streamedChunks: string[] = [];
      const sbRes = await sandbox.execute({
        worktreePath: wt.worktreePath,
        command: `node -e "console.log('line-one'); setTimeout(() => console.log('line-two'), 80);"`,
        timeoutMs: 5000,
        onOutput: (stream, chunk) => {
          if (stream === 'stdout') streamedChunks.push(chunk);
        },
      });
      wm.cleanupWorktree(wt.worktreePath, wt.branch);
      assert.strictEqual(sbRes.exitCode, 0);
      assert.ok(streamedChunks.join('').includes('line-one'));
      assert.ok(streamedChunks.join('').includes('line-two'));

      // 2. Verify RepairCoordinator flushes logs while attempt is still running and keeps them on failure
      const task = store.createTask({
        key: 'LOG-101',
        title: 'Live log streaming test',
        description: 'Verify incremental logs during running attempt',
        status: 'todo',
        priority: 'medium',
        targetRepo: 'disposable-test/repo',
        targetRepoPath: repoDir,
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

      const runId = `run-logs-${Date.now()}`;
      let logsWhileRunning = '';

      const run = await coordinator.executeTaskRun({
        task,
        runId,
        worker: {
          name: 'streaming_mock_worker',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          async isAvailable() { return { available: true }; },
          async execute(ctx) {
            ctx.onLog?.('[Mock] Step 1: Reading repository');
            await new Promise((r) => setTimeout(r, 450));
            ctx.onLog?.('[Mock] Step 2: Writing code');
            await new Promise((r) => setTimeout(r, 50));
            const liveAttempt = store.listAttempts(runId)[0];
            logsWhileRunning = liveAttempt?.logs || '';
            throw new Error('Simulated mid-run failure');
          },
        },
        store,
        workspaceManager: wm,
        verifier,
      });

      assert.ok(
        logsWhileRunning.includes('[Mock] Step 1: Reading repository'),
        `Expected streamed logs while attempt was still running, got: ${logsWhileRunning}`,
      );
      assert.strictEqual(run.status, 'failed');
      const finalAttempt = store.listAttempts(runId)[0];
      assert.strictEqual(finalAttempt.status, 'failed');
      assert.ok(
        finalAttempt.logs?.includes('[Mock] Step 2: Writing code'),
        'Expected streamed logs to be preserved after worker exception',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
