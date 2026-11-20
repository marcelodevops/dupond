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
  GeminiCliCodingWorkerAdapter,
  probeGeminiCliReadiness,
} from '../src/server/worker/geminiCliWorkerAdapter.js';
import { resolveCodingWorker, validateWorkerConfig } from '../src/server/worker/workerRegistry.js';

function createFakeGeminiCliBin(dir: string): string {
  const binPath = path.join(dir, 'fake-gemini');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const mode = process.env.FAKE_GCLI_MODE || 'success';

if (args.includes('--version')) {
  if (mode === 'old_version') {
    console.log('0.50.0');
  } else {
    console.log('0.64.0');
  }
  process.exit(0);
}

if (process.env.FAKE_GCLI_EMIT_ENV === '1') {
  const settingsPath = path.join(process.env.HOME || '', '.gemini', 'settings.json');
  const oauthPath = path.join(process.env.HOME || '', '.gemini', 'oauth_creds.json');
  let settings = null;
  let hasOauth = false;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
  try { hasOauth = fs.existsSync(oauthPath); } catch {}
  console.error('ENV_DIAG:' + JSON.stringify({
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasDupondAuth: Boolean(process.env.DUPOND_AUTH_TOKEN),
    hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
    pwd: process.env.PWD || '',
    cwd: process.cwd(),
    home: process.env.HOME || '',
    noRelaunch: process.env.GEMINI_CLI_NO_RELAUNCH || '',
    settings,
    hasOauth,
    args,
  }));
}

if (mode === 'auth_fail') {
  console.error('FatalAuthenticationError: Manual authorization is required');
  process.exit(41);
}
if (mode === 'quota_fail') {
  console.log(JSON.stringify({ type: 'error', error: { message: '429 RESOURCE_EXHAUSTED quota exceeded' } }));
  process.exit(1);
}
if (mode === 'malformed') {
  console.log('not valid stream-json');
  process.exit(0);
}
if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_GCLI_PID_OUT) {
    try { fs.writeFileSync(process.env.FAKE_GCLI_PID_OUT, String(child.pid)); } catch {}
  }
  setInterval(() => {}, 1000);
  return;
}
if (mode === 'attempt_read_outside') {
  try {
    const data = fs.readFileSync(process.env.FAKE_GCLI_SENTINEL_READ, 'utf-8');
    console.error('READ_UNEXPECTED:' + data);
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ type: 'error', error: { message: 'Blocked read: ' + (err.code || err.message) } }));
    process.exit(1);
  }
}
if (mode === 'attempt_write_outside') {
  try {
    fs.writeFileSync(process.env.FAKE_GCLI_OUTSIDE_WRITE, 'pwned');
    console.error('WRITE_OUTSIDE_UNEXPECTED');
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ type: 'error', error: { message: 'Blocked write: ' + (err.code || err.message) } }));
    process.exit(1);
  }
}
if (mode === 'attempt_write_git') {
  try {
    fs.writeFileSync(path.join(process.cwd(), '.git', 'evil-ref'), 'deadbeef');
    console.error('WRITE_GIT_UNEXPECTED');
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ type: 'error', error: { message: 'Blocked git write: ' + (err.code || err.message) } }));
    process.exit(1);
  }
}
if (mode === 'attempt_bypass_protected_patterns') {
  const targets = [
    'secrets/prod.key',
    'secrets/new.key',
    '.github/workflows/ci.yml',
    '.github/new-workflow.yml',
    'tests/existing.test.mjs',
    'tests/new.test.mjs',
    '.env',
    '.env.local',
    '.env.evil',
  ];
  const results = {};
  for (const rel of targets) {
    const full = path.join(process.cwd(), rel);
    try { fs.mkdirSync(path.dirname(full), { recursive: true }); } catch {}
    try {
      fs.writeFileSync(full, 'PWNED\\n');
      results[rel] = 'WRITTEN';
    } catch (err) {
      results[rel] = 'BLOCKED:' + (err.code || err.message);
    }
  }
  console.error('BYPASS_RESULTS:' + JSON.stringify(results));
  console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'done' }));
  process.exit(0);
}
if (mode === 'ignored_violation') {
  fs.writeFileSync(path.join(process.cwd(), 'ignored.secret'), 'leaked\\n');
  console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'wrote ignored' }));
  process.exit(0);
}
if (mode === 'symlink_violation') {
  fs.symlinkSync('/etc/passwd', path.join(process.cwd(), 'bad-link'));
  console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'created symlink' }));
  process.exit(0);
}
if (mode === 'allowed_path_violation') {
  fs.writeFileSync(path.join(process.cwd(), 'outside-allowed.mjs'), 'export const bad = true;\\n');
  console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'wrote outside allowed' }));
  process.exit(0);
}
if (mode === 'verify_fail') {
  fs.writeFileSync(path.join(process.cwd(), 'impl.mjs'), 'export const ok = false;\\n');
  console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'wrote broken impl' }));
  process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), 'impl.mjs'), 'export const ok = true;\\n');
console.log(JSON.stringify({ type: 'init', session_id: 'ses-fake-1', model: 'gemini-2.5-flash' }));
console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'Implemented feature.' }));
console.log(JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } }));
process.exit(0);
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

describe('Gemini CLI coding-worker adapter', () => {
  let tmpDir: string;
  let dbPath: string;
  let keyPath: string;
  let geminiHome: string;
  let repoA: string;
  let repoB: string;
  let fakeBin: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-gemcli-test-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    geminiHome = path.join(tmpDir, 'gemini-home');
    repoA = path.join(tmpDir, 'repoA');
    repoB = path.join(tmpDir, 'repoB');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    fs.mkdirSync(geminiHome, { recursive: true });
    fs.writeFileSync(
      path.join(geminiHome, 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
    );
    fs.writeFileSync(
      path.join(geminiHome, 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'ya29.synthetic_test_access_token_xyz',
        refresh_token: '1//synthetic_test_refresh_token_xyz',
        expiry_date: Date.now() + 3600_000,
      }),
      { mode: 0o600 },
    );
    fakeBin = createFakeGeminiCliBin(tmpDir);

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
      fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'secrets/prod.key'), 'original-secret\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    }

    origEnv = {
      DUPOND_DB_PATH: process.env.DUPOND_DB_PATH,
      DUPOND_CONN_KEY_PATH: process.env.DUPOND_CONN_KEY_PATH,
      DUPOND_GEMINI_CLI_BIN: process.env.DUPOND_GEMINI_CLI_BIN,
      DUPOND_GEMINI_CLI_HOME: process.env.DUPOND_GEMINI_CLI_HOME,
      DUPOND_AUTH_TOKEN: process.env.DUPOND_AUTH_TOKEN,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      FAKE_GCLI_MODE: process.env.FAKE_GCLI_MODE,
      FAKE_GCLI_EMIT_ENV: process.env.FAKE_GCLI_EMIT_ENV,
      FAKE_GCLI_PID_OUT: process.env.FAKE_GCLI_PID_OUT,
    };

    process.env.DUPOND_DB_PATH = dbPath;
    process.env.DUPOND_CONN_KEY_PATH = keyPath;
    process.env.DUPOND_GEMINI_CLI_BIN = fakeBin;
    process.env.DUPOND_GEMINI_CLI_HOME = geminiHome;
    process.env.DUPOND_AUTH_TOKEN = 'secret_dupond_token_must_not_leak';
    process.env.GITHUB_TOKEN = 'ghp_must_not_leak_to_gemini_cli_123456';
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FAKE_GCLI_MODE;
    delete process.env.FAKE_GCLI_EMIT_ENV;
    delete process.env.FAKE_GCLI_PID_OUT;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates worker registry config, probes binary/version/auth readiness without secrets, and keeps binary-only unauthenticated', async () => {
    const valid = validateWorkerConfig({ provider: 'gemini-cli', model: 'gemini-2.5-pro' });
    assert.strictEqual(valid.valid, true);
    assert.strictEqual(valid.provider, 'gemini-cli');

    const invalid = validateWorkerConfig({ provider: 'gemini-cli', model: 'bad model with spaces!' });
    assert.strictEqual(invalid.valid, false);

    const worker = resolveCodingWorker({ provider: 'gemini-cli', model: 'gemini-2.5-flash' });
    assert.strictEqual(worker.provider, 'gemini-cli');
    assert.deepStrictEqual(await worker.isAvailable(), { available: true });

    const ready = probeGeminiCliReadiness();
    assert.strictEqual(ready.available, true);
    assert.strictEqual(ready.version, '0.64.0');
    assert.strictEqual(ready.supportedVersion, true);
    assert.strictEqual(ready.authReady, true);
    assert.strictEqual(ready.authMethod, 'oauth-personal');
    assert.ok(!JSON.stringify(ready).includes('ya29.synthetic_test_access_token_xyz'));

    // Missing executable
    process.env.DUPOND_GEMINI_CLI_BIN = path.join(tmpDir, 'missing-gemini');
    assert.strictEqual(probeGeminiCliReadiness().available, false);

    // Unsupported old version
    process.env.DUPOND_GEMINI_CLI_BIN = fakeBin;
    process.env.FAKE_GCLI_MODE = 'old_version';
    const oldStatus = probeGeminiCliReadiness();
    assert.strictEqual(oldStatus.available, false);
    assert.strictEqual(oldStatus.supportedVersion, false);

    // Binary present but unauthenticated -> NOT Ready
    delete process.env.FAKE_GCLI_MODE;
    fs.rmSync(path.join(geminiHome, 'oauth_creds.json'));
    const noAuth = probeGeminiCliReadiness();
    assert.strictEqual(noAuth.available, false);
    assert.strictEqual(noAuth.authReady, false);
    assert.ok(noAuth.error?.includes('not authenticated'));
  });

  it('executes in isolated worktree without API keys, hardens settings, and persists gemini-cli provenance only after Dupond verification', async () => {
    const store = new TaskStore(dbPath);
    const projectStore = new ProjectStore(store);
    const projA = projectStore.createProject({ name: 'GemCLI A', actor: 'test', repository: { localPath: repoA, defaultBranch: 'main' } });
    const projB = projectStore.createProject({ name: 'GemCLI B', actor: 'test', repository: { localPath: repoB, defaultBranch: 'main' } });

    const taskA = store.createTask({
      id: 'task-gcli-a',
      key: 'GCL-101',
      projectId: projA.id,
      title: 'Implement ok=true',
      description: 'Update impl.mjs so verification passes',
      status: 'in_progress',
      targetRepo: 'local',
      targetRepoPath: repoA,
      baseCommit: 'main',
      allowedPaths: ['impl.mjs', 'impl.test.mjs'],
      protectedPaths: ['secrets/**'],
      acceptanceCriteria: [{ id: 'ac-1', title: 'impl test passes', completed: false, checkCommand: 'grep -q "ok = true" impl.mjs' }],
      verificationCommands: [{ command: 'grep -q "ok = true" impl.mjs', criteriaIds: ['ac-1'] }],
      workerConfig: { provider: 'gemini-cli', model: 'gemini-2.5-flash' },
      maxAttempts: 1,
    });
    store.createTask({
      id: 'task-gcli-b',
      key: 'GCL-101',
      projectId: projB.id,
      title: 'Project B task',
      description: 'Untouched',
      status: 'todo',
      targetRepo: 'local',
      targetRepoPath: repoB,
      baseCommit: 'main',
    });

    const coordinator = new RepairCoordinator(store, new WorkspaceManager(repoA), new AuthoritativeVerifier());

    // 1. CLI exit 0 without passing Dupond verification -> run FAILS
    process.env.FAKE_GCLI_MODE = 'verify_fail';
    const failRun = await coordinator.executeTaskRun({
      task: taskA,
      workspaceManager: new WorkspaceManager(repoA),
      runId: 'run-gcli-verify-fail',
    });
    assert.strictEqual(failRun.status, 'failed');

    // 2. CLI exit 0 + passing Dupond verification -> succeeds, strips secrets, seeds hardened settings, records provenance
    delete process.env.FAKE_GCLI_MODE;
    process.env.FAKE_GCLI_EMIT_ENV = '1';
    const passRun = await coordinator.executeTaskRun({
      task: taskA,
      workspaceManager: new WorkspaceManager(repoA),
      runId: 'run-gcli-pass',
    });
    assert.strictEqual(passRun.status, 'completed', `Expected completed, got ${passRun.failureReason}`);

    const attempts = store.listAttempts('run-gcli-pass', projA.id);
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0].workerType, 'gemini-cli:gemini-2.5-flash');
    assert.strictEqual(store.getTaskScoped('task-gcli-b', projB.id)?.status, 'todo');

    const logsStr = String(attempts[0]?.logs || '');
    const diagMatch = logsStr.match(/ENV_DIAG:(\{.*\})/);
    assert.ok(diagMatch, 'Expected ENV_DIAG log entry');
    const diag = JSON.parse(diagMatch[1]);
    assert.strictEqual(diag.hasGeminiKey, false);
    assert.strictEqual(diag.hasOpenAIKey, false);
    assert.strictEqual(diag.hasDupondAuth, false);
    assert.strictEqual(diag.hasGithubToken, false);
    assert.strictEqual(diag.noRelaunch, 'true');
    assert.strictEqual(diag.hasOauth, true);
    assert.notStrictEqual(diag.pwd, repoA, 'PWD inside sandbox must be the linked worktree, not parent repo');
    assert.strictEqual(diag.pwd, diag.cwd);
    assert.deepStrictEqual(diag.settings.mcpServers, {});
    assert.deepStrictEqual(diag.settings.hooks, {});
    assert.deepStrictEqual(diag.settings.tools?.exclude, ['run_shell_command']);
    assert.strictEqual(diag.settings.admin?.extensions?.enabled, false);
    assert.ok(diag.args.includes('-e') && diag.args.includes('none'));

    store.getRawDb().close();
  });

  it('enforces OS boundaries, protected patterns, PWD isolation, timeout/cancel cleanup, and 1-attempt fail-fast on deterministic auth/startup errors', async () => {
    const adapter = new GeminiCliCodingWorkerAdapter('gemini-2.5-flash');
    fs.writeFileSync(path.join(repoA, '.gitignore'), 'ignored.secret\n');
    fs.mkdirSync(path.join(repoA, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repoA, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    fs.mkdirSync(path.join(repoA, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoA, 'tests', 'existing.test.mjs'), 'export const keep = true;\n');
    fs.writeFileSync(path.join(repoA, '.env'), 'SECRET=keep\n');
    fs.writeFileSync(path.join(repoA, '.env.local'), 'LOCAL=keep\n');
    execFileSync('git', ['add', '.gitignore', '.github/workflows/ci.yml', 'tests/existing.test.mjs'], { cwd: repoA });
    execFileSync('git', ['commit', '-m', 'seed boundary targets'], { cwd: repoA });

    const homeSentinelDir = fs.mkdtempSync(path.join(os.homedir(), '.dupond-gemcli-sentinel-'));
    const homeSentinelFile = path.join(homeSentinelDir, 'sentinel.secret');
    fs.writeFileSync(homeSentinelFile, 'TOP_SECRET');
    const outsideWrite = path.join(tmpDir, 'outside.txt');

    const baseCtx = {
      taskId: 't-adv',
      taskKey: 'GCL-201',
      taskTitle: 'Boundary checks',
      taskDescription: 'Desc',
      acceptanceCriteria: [],
      worktreePath: repoA,
      allowedPaths: ['impl.mjs', 'impl.test.mjs'],
      protectedPaths: ['secrets/**'],
      attemptNumber: 1,
    };

    try {
      // Read outside boundary
      process.env.FAKE_GCLI_MODE = 'attempt_read_outside';
      process.env.FAKE_GCLI_SENTINEL_READ = homeSentinelFile;
      const readRes = await adapter.execute(baseCtx);
      assert.strictEqual(readRes.success, false);
      assert.ok(readRes.errorMessage?.includes('Blocked read:'));

      // Write outside worktree
      process.env.FAKE_GCLI_MODE = 'attempt_write_outside';
      process.env.FAKE_GCLI_OUTSIDE_WRITE = outsideWrite;
      const writeRes = await adapter.execute(baseCtx);
      assert.strictEqual(writeRes.success, false);
      assert.strictEqual(fs.existsSync(outsideWrite), false);

      // Git metadata write blocked
      process.env.FAKE_GCLI_MODE = 'attempt_write_git';
      const gitRes = await adapter.execute(baseCtx);
      assert.strictEqual(gitRes.success, false);
      assert.strictEqual(fs.existsSync(path.join(repoA, '.git', 'evil-ref')), false);

      // Ignored & symlink & allowedPath checks
      process.env.FAKE_GCLI_MODE = 'ignored_violation';
      await assert.rejects(() => adapter.execute(baseCtx), /Ignored path modified/i);
      fs.rmSync(path.join(repoA, 'ignored.secret'), { force: true });

      process.env.FAKE_GCLI_MODE = 'symlink_violation';
      await assert.rejects(() => adapter.execute(baseCtx), /Symlink creation/i);
      fs.rmSync(path.join(repoA, 'bad-link'), { force: true });

      process.env.FAKE_GCLI_MODE = 'allowed_path_violation';
      await assert.rejects(() => adapter.execute(baseCtx), /boundary violation/i);
      fs.rmSync(path.join(repoA, 'outside-allowed.mjs'), { force: true });

      // Protected patterns ONLY
      process.env.FAKE_GCLI_MODE = 'attempt_bypass_protected_patterns';
      const patCtx = { ...baseCtx, protectedPaths: ['secrets/**', '.github/**', 'tests/**', '.env*'] };
      if (process.platform === 'darwin') {
        const patRes = await adapter.execute(patCtx);
        assert.strictEqual(patRes.success, true);
        assert.strictEqual(fs.readFileSync(path.join(repoA, 'secrets/prod.key'), 'utf-8'), 'original-secret\n');
        assert.strictEqual(fs.readFileSync(path.join(repoA, '.env'), 'utf-8'), 'SECRET=keep\n');
        assert.strictEqual(fs.existsSync(path.join(repoA, '.env.evil')), false);
        assert.strictEqual(fs.existsSync(path.join(repoA, 'secrets/new.key')), false);
      } else {
        await assert.rejects(() => adapter.execute(patCtx), /cannot enforce protected-path glob/i);
      }

      // Timeout & cancellation kill subprocess tree
      process.env.FAKE_GCLI_MODE = 'hang';
      await assert.rejects(() => adapter.execute({ ...baseCtx, timeoutMs: 1000 }), /timed out/i);

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      await assert.rejects(() => adapter.execute({ ...baseCtx, abortSignal: ac.signal, timeoutMs: 10000 }), /cancelled/i);
    } finally {
      delete process.env.FAKE_GCLI_SENTINEL_READ;
      delete process.env.FAKE_GCLI_OUTSIDE_WRITE;
      fs.rmSync(homeSentinelDir, { recursive: true, force: true });
    }

    // Quota error vs deterministic auth failure in RepairCoordinator
    const store = new TaskStore(dbPath);
    const projectStore = new ProjectStore(store);
    const proj = projectStore.createProject({ name: 'FailFast', actor: 'test', repository: { localPath: repoA, defaultBranch: 'main' } });
    const task = store.createTask({
      id: 'task-gcli-ff',
      key: 'GCL-301',
      projectId: proj.id,
      title: 'Auth fail fast',
      description: 'Desc',
      status: 'in_progress',
      targetRepo: 'local',
      targetRepoPath: repoA,
      baseCommit: 'main',
      allowedPaths: ['impl.mjs'],
      protectedPaths: [],
      acceptanceCriteria: [{ id: 'ac-1', title: 'ok', completed: false, checkCommand: 'true' }],
      verificationCommands: [{ command: 'true', criteriaIds: ['ac-1'] }],
      workerConfig: { provider: 'gemini-cli', model: 'gemini-2.5-flash' },
      maxAttempts: 3,
    });

    const coordinator = new RepairCoordinator(store, new WorkspaceManager(repoA), new AuthoritativeVerifier());
    process.env.FAKE_GCLI_MODE = 'auth_fail';
    const authRun = await coordinator.executeTaskRun({
      task,
      workspaceManager: new WorkspaceManager(repoA),
      runId: 'run-gcli-auth-fail',
    });
    assert.strictEqual(authRun.status, 'failed');
    assert.strictEqual(store.listAttempts('run-gcli-auth-fail', proj.id).length, 1);

    process.env.FAKE_GCLI_MODE = 'quota_fail';
    const quotaRes = await adapter.execute(baseCtx);
    assert.strictEqual(quotaRes.success, false);
    assert.strictEqual(quotaRes.nonRetryable, false);
    assert.ok(quotaRes.errorMessage?.includes('provider/quota error'));

    // Real installed Gemini CLI startup validation (when installed on macOS, synthetic creds, zero paid calls)
    const realGeminiBin = path.join(os.homedir(), '.local', 'bin', 'gemini');
    if (process.platform === 'darwin' && fs.existsSync(realGeminiBin)) {
      process.env.DUPOND_GEMINI_CLI_BIN = realGeminiBin;
      const realAdapter = new GeminiCliCodingWorkerAdapter('gemini-2.5-flash');
      const realRes = await realAdapter.execute(baseCtx);
      assert.strictEqual(realRes.success, false);
      assert.strictEqual(realRes.nonRetryable, true);
      assert.ok(
        /FatalAuthenticationError|Manual authorization|auth/i.test(realRes.errorMessage || ''),
        `Expected deterministic auth failure from real CLI with synthetic creds, got: ${realRes.errorMessage}`,
      );
    }

    store.getRawDb().close();
  });
});
