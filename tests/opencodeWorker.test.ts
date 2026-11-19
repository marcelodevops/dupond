import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/server/db/database.js';
import { ProjectStore } from '../src/server/projects/projectStore.js';
import { RepairCoordinator } from '../src/server/coordinator/repairCoordinator.js';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.js';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.js';
import {
  OpenCodeCodingWorkerAdapter,
  probeOpenCodeReadiness,
} from '../src/server/worker/opencodeWorkerAdapter.js';
import { resolveCodingWorker, validateWorkerConfig } from '../src/server/worker/workerRegistry.js';

function createFakeOpenCodeBin(dir: string): string {
  const binPath = path.join(dir, 'fake-opencode');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const mode = process.env.FAKE_OPENCODE_MODE || 'success';

if (args[0] === '--version') {
  console.log('opencode v2.3.0');
  process.exit(0);
}
if (args[0] === 'models') {
  if (mode === 'no_models') process.exit(0);
  console.log('github-copilot/gpt-5.3-codex');
  console.log('github-copilot/claude-sonnet-4.6');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  if (mode === 'no_auth') process.exit(0);
  console.log('GitHub Copilot  GITHUB_TOKEN  environment');
  process.exit(0);
}
if (args[0] === 'run') {
  if (process.env.FAKE_OPENCODE_ENV_OUT) {
    fs.writeFileSync(process.env.FAKE_OPENCODE_ENV_OUT, JSON.stringify({
      config: process.env.OPENCODE_CONFIG_CONTENT || '',
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
      hasDupondAuth: Boolean(process.env.DUPOND_AUTH_TOKEN),
      cwd: process.cwd(),
      args,
    }));
  }
  if (mode === 'fail') {
    console.log(JSON.stringify({ type: 'error', error: { message: 'Provider returned error' } }));
    process.exit(1);
  }
  if (mode === 'malformed') {
    console.log('not valid json output from cli');
    process.exit(0);
  }
  if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (process.env.FAKE_OPENCODE_PID_OUT) {
      fs.writeFileSync(process.env.FAKE_OPENCODE_PID_OUT, String(child.pid));
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'protected_violation') {
    fs.mkdirSync(path.join(process.cwd(), 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'secrets/prod.key'), 'hacked\\n');
    console.log(JSON.stringify({ type: 'text', part: { text: 'edited protected file' } }));
    process.exit(0);
  }
  if (mode === 'verify_fail') {
    fs.writeFileSync(path.join(process.cwd(), 'impl.mjs'), 'export const ok = false;\\n');
    console.log(JSON.stringify({ type: 'text', part: { text: 'wrote broken impl' } }));
    process.exit(0);
  }
  fs.writeFileSync(path.join(process.cwd(), 'impl.mjs'), 'export const ok = true;\\n');
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 5, total: 15 } } }));
  console.log(JSON.stringify({ type: 'text', part: { text: 'Implemented feature cleanly.' } }));
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

describe('OpenCode CLI coding-worker adapter', () => {
  let tmpDir: string;
  let dbPath: string;
  let keyPath: string;
  let repoA: string;
  let repoB: string;
  let fakeBin: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-opencode-test-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    repoA = path.join(tmpDir, 'repoA');
    repoB = path.join(tmpDir, 'repoB');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    fakeBin = createFakeOpenCodeBin(tmpDir);

    for (const dir of [repoA, repoB]) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'impl.mjs'), 'export const ok = false;\n');
      fs.writeFileSync(
        path.join(dir, 'impl.test.mjs'),
        "import assert from 'node:assert'; import { ok } from './impl.mjs'; assert.strictEqual(ok, true);\n",
      );
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    }

    origEnv = {
      DUPOND_DB_PATH: process.env.DUPOND_DB_PATH,
      DUPOND_CONN_KEY_PATH: process.env.DUPOND_CONN_KEY_PATH,
      DUPOND_OPENCODE_BIN: process.env.DUPOND_OPENCODE_BIN,
      DUPOND_AUTH_TOKEN: process.env.DUPOND_AUTH_TOKEN,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      FAKE_OPENCODE_MODE: process.env.FAKE_OPENCODE_MODE,
      FAKE_OPENCODE_ENV_OUT: process.env.FAKE_OPENCODE_ENV_OUT,
      FAKE_OPENCODE_PID_OUT: process.env.FAKE_OPENCODE_PID_OUT,
    };

    process.env.DUPOND_DB_PATH = dbPath;
    process.env.DUPOND_CONN_KEY_PATH = keyPath;
    process.env.DUPOND_OPENCODE_BIN = fakeBin;
    process.env.DUPOND_AUTH_TOKEN = 'secret_dupond_token_must_not_leak';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FAKE_OPENCODE_MODE;
    delete process.env.FAKE_OPENCODE_ENV_OUT;
    delete process.env.FAKE_OPENCODE_PID_OUT;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates worker registry config, probes prerequisites, and runs cleanly without GEMINI_API_KEY or OPENAI_API_KEY', async () => {
    const valid = validateWorkerConfig({ provider: 'opencode', model: 'github-copilot/claude-sonnet-4.6' });
    assert.strictEqual(valid.valid, true);
    assert.strictEqual(valid.provider, 'opencode');

    const invalid = validateWorkerConfig({ provider: 'opencode', model: 'no-provider-slash' });
    assert.strictEqual(invalid.valid, false);

    const worker = resolveCodingWorker({ provider: 'opencode', model: 'github-copilot/gpt-5.3-codex' });
    assert.strictEqual(worker.provider, 'opencode');
    assert.deepStrictEqual(await worker.isAvailable(), { available: true });

    // Missing executable
    process.env.DUPOND_OPENCODE_BIN = path.join(tmpDir, 'does-not-exist');
    const missingAvail = await worker.isAvailable();
    assert.strictEqual(missingAvail.available, false);
    assert.ok(missingAvail.error?.includes('not found'));

    // Unauthenticated / no models
    process.env.DUPOND_OPENCODE_BIN = fakeBin;
    process.env.FAKE_OPENCODE_MODE = 'no_models';
    const noModelsReadiness = probeOpenCodeReadiness();
    assert.strictEqual(noModelsReadiness.available, true); // auth list still present
    process.env.FAKE_OPENCODE_MODE = 'no_auth';
    const noAuthWorker = new OpenCodeCodingWorkerAdapter('github-copilot/gpt-5.3-codex');
    assert.strictEqual((await noAuthWorker.isAvailable()).available, true);

    // Unavailable selected model rejected honestly
    delete process.env.FAKE_OPENCODE_MODE;
    const unknownModelWorker = new OpenCodeCodingWorkerAdapter('github-copilot/missing-model');
    const unknownAvail = await unknownModelWorker.isAvailable();
    assert.strictEqual(unknownAvail.available, false);
    assert.ok(unknownAvail.error?.includes('not available'));
  });

  it('executes in isolated worktree, strips Dupond secrets, enforces protected paths, and treats exit 0 as unverified until Dupond verifies', async () => {
    const store = new TaskStore(dbPath);
    const projectStore = new ProjectStore(store);
    const projA = projectStore.createProject({ name: 'Proj A', actor: 'test', repository: { localPath: repoA, defaultBranch: 'main' } });
    const projB = projectStore.createProject({ name: 'Proj B', actor: 'test', repository: { localPath: repoB, defaultBranch: 'main' } });

    const taskA = store.createTask({
      id: 'task-opc-a',
      key: 'OPC-101',
      projectId: projA.id,
      title: 'Implement ok=true',
      description: 'Update impl.mjs so node impl.test.mjs passes',
      status: 'in_progress',
      targetRepo: 'local',
      targetRepoPath: repoA,
      baseCommit: 'main',
      allowedPaths: ['impl.mjs', 'impl.test.mjs'],
      protectedPaths: ['secrets/**'],
      acceptanceCriteria: [{ id: 'ac-1', title: 'impl test passes', completed: false, checkCommand: `${process.execPath} impl.test.mjs` }],
      verificationCommands: [{ command: `${process.execPath} impl.test.mjs`, criteriaIds: ['ac-1'] }],
      workerConfig: { provider: 'opencode', model: 'github-copilot/claude-sonnet-4.6' },
      maxAttempts: 1,
    });
    store.createTask({
      id: 'task-opc-b',
      key: 'OPC-101',
      projectId: projB.id,
      title: 'Project B task',
      description: 'Untouched',
      status: 'todo',
      targetRepo: 'local',
      targetRepoPath: repoB,
      baseCommit: 'main',
    });

    const wsA = new WorkspaceManager(repoA);
    const coordinator = new RepairCoordinator(store, wsA, new AuthoritativeVerifier());

    // 1. CLI exit 0 without passing Dupond verification -> run FAILS (exit 0 is not acceptance)
    process.env.FAKE_OPENCODE_MODE = 'verify_fail';
    const failVerifyRun = await coordinator.executeTaskRun({
      task: taskA,
      workspaceManager: new WorkspaceManager(repoA),
      runId: 'run-opc-verify-fail',
    });
    assert.strictEqual(failVerifyRun.status, 'failed');

    // 2. CLI exit 0 + passing Dupond verification -> run succeeds with opencode provenance & secret isolation
    delete process.env.FAKE_OPENCODE_MODE;
    const envOut = path.join(tmpDir, 'captured-env.json');
    process.env.FAKE_OPENCODE_ENV_OUT = envOut;
    const passRun = await coordinator.executeTaskRun({
      task: taskA,
      workspaceManager: new WorkspaceManager(repoA),
      runId: 'run-opc-pass',
    });
    assert.strictEqual(passRun.status, 'completed', `Expected completed but failed: ${passRun.failureReason}`);

    const captured = JSON.parse(fs.readFileSync(envOut, 'utf-8'));
    assert.strictEqual(captured.hasGeminiKey, false);
    assert.strictEqual(captured.hasOpenAIKey, false);
    assert.strictEqual(captured.hasDupondAuth, false);
    const permCfg = JSON.parse(captured.config);
    assert.strictEqual(permCfg.permission.external_directory, 'deny');
    assert.strictEqual(permCfg.permission.bash['*'], 'deny');
    assert.strictEqual(permCfg.permission.edit['secrets/**'], 'deny');

    const attempts = store.listAttempts('run-opc-pass', projA.id);
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0].workerType, 'opencode:github-copilot/claude-sonnet-4.6');
    assert.strictEqual(store.getTaskScoped('task-opc-b', projB.id)?.status, 'todo');

    store.getRawDb().close();
  });

  it('handles failure, malformed JSON output, protected path violations, timeout, and cancellation process-tree termination', async () => {
    const adapter = new OpenCodeCodingWorkerAdapter('github-copilot/gpt-5.3-codex');
    const baseCtx = {
      taskId: 't-1',
      taskKey: 'OPC-201',
      taskTitle: 'Test errors',
      taskDescription: 'Desc',
      acceptanceCriteria: [],
      worktreePath: repoA,
      allowedPaths: [],
      protectedPaths: ['secrets/**'],
      attemptNumber: 1,
    };

    // Failure exit code
    process.env.FAKE_OPENCODE_MODE = 'fail';
    const failRes = await adapter.execute(baseCtx);
    assert.strictEqual(failRes.success, false);
    assert.ok(failRes.errorMessage?.includes('Provider returned error'));

    // Malformed JSON stdout
    process.env.FAKE_OPENCODE_MODE = 'malformed';
    const malRes = await adapter.execute(baseCtx);
    assert.strictEqual(malRes.success, false);
    assert.ok(malRes.errorMessage?.includes('Malformed OpenCode JSON output'));

    // Protected path violation
    process.env.FAKE_OPENCODE_MODE = 'protected_violation';
    await assert.rejects(() => adapter.execute(baseCtx), /boundary violation/i);

    // Timeout kills process tree
    const pidOut1 = path.join(tmpDir, 'pid-timeout.txt');
    process.env.FAKE_OPENCODE_MODE = 'hang';
    process.env.FAKE_OPENCODE_PID_OUT = pidOut1;
    await assert.rejects(() => adapter.execute({ ...baseCtx, timeoutMs: 1000 }), /timed out/i);
    if (fs.existsSync(pidOut1)) {
      const childPid = Number(fs.readFileSync(pidOut1, 'utf-8').trim());
      await new Promise((r) => setTimeout(r, 100));
      let alive = true;
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
      }
      assert.strictEqual(alive, false, 'Timed-out child process tree should be terminated');
    }

    // AbortSignal cancellation kills process tree
    const pidOut2 = path.join(tmpDir, 'pid-cancel.txt');
    process.env.FAKE_OPENCODE_PID_OUT = pidOut2;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(() => adapter.execute({ ...baseCtx, abortSignal: ac.signal, timeoutMs: 10000 }), /cancelled/i);
    if (fs.existsSync(pidOut2)) {
      const childPid = Number(fs.readFileSync(pidOut2, 'utf-8').trim());
      await new Promise((r) => setTimeout(r, 100));
      let alive = true;
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
      }
      assert.strictEqual(alive, false, 'Cancelled child process tree should be terminated');
    }
  });
});
