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
  captureRepoBaseline,
  inspectAndVerifyRepoChanges,
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
  if (process.env.FAKE_OPENCODE_EMIT_ENV === '1') {
    console.error('ENV_DIAG:' + JSON.stringify({
      config: process.env.OPENCODE_CONFIG_CONTENT || '',
      disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG || '',
      pwd: process.env.PWD || '',
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
      hasDupondAuth: Boolean(process.env.DUPOND_AUTH_TOKEN),
      cwd: process.cwd(),
      args,
    }));
  }
  if (mode === 'honor_pwd') {
    const targetDir = process.env.PWD || process.cwd();
    try {
      process.chdir(targetDir);
    } catch {
      console.log(JSON.stringify({ type: 'error', error: { message: 'Failed to change directory to ' + targetDir } }));
      process.exit(1);
    }
    fs.writeFileSync(path.join(process.cwd(), 'impl.mjs'), 'export const ok = true;\\n');
    console.log(JSON.stringify({ type: 'text', part: { text: 'honored sandboxed PWD cleanly' } }));
    process.exit(0);
  }
  if (mode === 'deterministic_startup_error') {
    console.log(JSON.stringify({ type: 'error', error: { type: 'provider.no-route', message: 'Model unavailable: opencode/nonexistent-test' } }));
    process.exit(1);
  }
  if (mode === 'attempt_read_outside') {
    try {
      const data = fs.readFileSync(process.env.FAKE_OPENCODE_SENTINEL_READ, 'utf-8');
      console.error('READ_UNEXPECTED:' + data);
      process.exit(0);
    } catch (err) {
      console.log(JSON.stringify({ type: 'error', error: { message: 'Blocked read: ' + (err.code || err.message) } }));
      process.exit(1);
    }
  }
  if (mode === 'attempt_write_outside') {
    try {
      fs.writeFileSync(process.env.FAKE_OPENCODE_OUTSIDE_WRITE, 'pwned');
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
  if (mode === 'attempt_write_existing_protected') {
    try {
      fs.writeFileSync(path.join(process.cwd(), 'secrets/prod.key'), 'overwritten\\n');
      console.error('WRITE_PROTECTED_UNEXPECTED');
      process.exit(0);
    } catch (err) {
      console.log(JSON.stringify({ type: 'error', error: { message: 'Blocked protected write: ' + (err.code || err.message) } }));
      process.exit(1);
    }
  }
  if (mode === 'ignored_violation') {
    fs.writeFileSync(path.join(process.cwd(), 'ignored.secret'), 'leaked\\n');
    console.log(JSON.stringify({ type: 'text', part: { text: 'wrote ignored file' } }));
    process.exit(0);
  }
  if (mode === 'symlink_violation') {
    fs.symlinkSync('/etc/passwd', path.join(process.cwd(), 'bad-link'));
    console.log(JSON.stringify({ type: 'text', part: { text: 'created symlink' } }));
    process.exit(0);
  }
  if (mode === 'fail_with_violation') {
    fs.writeFileSync(path.join(process.cwd(), 'ignored.secret'), 'leaked-on-fail\\n');
    console.log(JSON.stringify({ type: 'error', error: { message: 'Failed after touching ignored' } }));
    process.exit(1);
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
      try { fs.writeFileSync(process.env.FAKE_OPENCODE_PID_OUT, String(child.pid)); } catch {}
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'attempt_bypass_protected_patterns') {
    // Deliberately ignore OPENCODE_CONFIG_CONTENT and try direct filesystem writes
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
      'nested/.env.injected',
    ];
    const results = {};
    for (const rel of targets) {
      const full = path.join(process.cwd(), rel);
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
      } catch {}
      try {
        fs.writeFileSync(full, 'PWNED\\n');
        results[rel] = 'WRITTEN';
      } catch (err) {
        results[rel] = 'BLOCKED:' + (err.code || err.message);
      }
    }
    console.error('BYPASS_RESULTS:' + JSON.stringify(results));
    console.log(JSON.stringify({ type: 'text', part: { text: 'bypass attempt complete' } }));
    process.exit(0);
  }
  if (mode === 'allowed_path_violation') {
    fs.writeFileSync(path.join(process.cwd(), 'outside-allowed.mjs'), 'export const bad = true;\\n');
    console.log(JSON.stringify({ type: 'text', part: { text: 'edited outside allowedPaths' } }));
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
      fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'secrets/prod.key'), 'original-secret\n');
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
      acceptanceCriteria: [{ id: 'ac-1', title: 'impl test passes', completed: false, checkCommand: 'grep -q "ok = true" impl.mjs' }],
      verificationCommands: [{ command: 'grep -q "ok = true" impl.mjs', criteriaIds: ['ac-1'] }],
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
    process.env.FAKE_OPENCODE_EMIT_ENV = '1';
    const passRun = await coordinator.executeTaskRun({
      task: taskA,
      workspaceManager: new WorkspaceManager(repoA),
      runId: 'run-opc-pass',
    });
    delete process.env.FAKE_OPENCODE_EMIT_ENV;
    assert.strictEqual(passRun.status, 'completed', `Expected completed but failed: ${passRun.failureReason}`);

    const passAttempts = store.listAttempts('run-opc-pass', projA.id);
    const logsStr = String(passAttempts[0]?.logs || '');
    const diagMatch = logsStr.match(/ENV_DIAG:(\{.*\})/);
    assert.ok(diagMatch, 'Expected ENV_DIAG log entry from sandboxed OpenCode run');
    const diagJson = JSON.parse(diagMatch[1]);
    assert.strictEqual(diagJson.hasGeminiKey, false);
    assert.strictEqual(diagJson.hasOpenAIKey, false);
    assert.strictEqual(diagJson.hasDupondAuth, false);
    assert.strictEqual(diagJson.disableProjectConfig, 'true');
    const permCfg = JSON.parse(diagJson.config);
    assert.deepStrictEqual(permCfg.mcp, {});
    assert.deepStrictEqual(permCfg.plugin, []);
    assert.strictEqual(permCfg.permission.external_directory, 'deny');
    assert.strictEqual(permCfg.permission.bash['*'], 'deny');
    assert.strictEqual(permCfg.permission.edit['secrets/**'], 'deny');
    assert.strictEqual(permCfg.permission.read['.env'], 'deny');

    assert.strictEqual(passAttempts.length, 1);
    assert.strictEqual(passAttempts[0].workerType, 'opencode:github-copilot/claude-sonnet-4.6');
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

    // Allowed-path boundary violation caught independently
    process.env.FAKE_OPENCODE_MODE = 'allowed_path_violation';
    await assert.rejects(
      () => adapter.execute({ ...baseCtx, allowedPaths: ['impl.mjs'] }),
      /boundary violation/i,
    );
    fs.rmSync(path.join(repoA, 'outside-allowed.mjs'), { force: true });

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

  it('enforces OS sandbox boundaries and catches committed, ignored, symlink, and Git-metadata violations', async () => {
    const adapter = new OpenCodeCodingWorkerAdapter('github-copilot/gpt-5.3-codex');
    fs.writeFileSync(path.join(repoA, '.gitignore'), 'ignored.secret\n');
    execFileSync('git', ['add', '.'], { cwd: repoA });
    execFileSync('git', ['commit', '-m', 'add gitignore'], { cwd: repoA });

    const homeSentinelDir = fs.mkdtempSync(path.join(os.homedir(), '.dupond-opencode-sentinel-'));
    const homeSentinelFile = path.join(homeSentinelDir, 'sentinel.secret');
    fs.writeFileSync(homeSentinelFile, 'TOP_SECRET_SENTINEL_DATA');
    const outsideWriteTarget = path.join(tmpDir, 'outside-worktree-write.txt');

    const baseCtx = {
      taskId: 't-adv',
      taskKey: 'OPC-301',
      taskTitle: 'Adversarial boundary checks',
      taskDescription: 'Desc',
      acceptanceCriteria: [],
      worktreePath: repoA,
      allowedPaths: ['impl.mjs', 'impl.test.mjs'],
      protectedPaths: ['secrets/**'],
      attemptNumber: 1,
    };

    try {
      // 1. Attempt to read sentinel secret outside boundary -> blocked at OS level
      process.env.FAKE_OPENCODE_MODE = 'attempt_read_outside';
      process.env.FAKE_OPENCODE_SENTINEL_READ = homeSentinelFile;
      const readRes = await adapter.execute(baseCtx);
      assert.strictEqual(readRes.success, false);
      assert.ok(readRes.errorMessage?.includes('Blocked read:'), `Expected OS read block, got: ${readRes.errorMessage}`);

      // 2. Attempt to write outside the worktree -> blocked at OS level
      process.env.FAKE_OPENCODE_MODE = 'attempt_write_outside';
      process.env.FAKE_OPENCODE_OUTSIDE_WRITE = outsideWriteTarget;
      const writeOutsideRes = await adapter.execute(baseCtx);
      assert.strictEqual(writeOutsideRes.success, false);
      assert.ok(writeOutsideRes.errorMessage?.includes('Blocked write:'), `Expected OS write block, got: ${writeOutsideRes.errorMessage}`);
      assert.strictEqual(fs.existsSync(outsideWriteTarget), false, 'Outside file must not be created');

      // 3. Attempt to write .git metadata -> blocked at OS level (gitReadOnly)
      process.env.FAKE_OPENCODE_MODE = 'attempt_write_git';
      const writeGitRes = await adapter.execute(baseCtx);
      assert.strictEqual(writeGitRes.success, false);
      assert.ok(writeGitRes.errorMessage?.includes('Blocked git write:'), `Expected OS .git write block, got: ${writeGitRes.errorMessage}`);
      assert.strictEqual(fs.existsSync(path.join(repoA, '.git', 'evil-ref')), false);

      // 4. Attempt to overwrite existing protected file -> blocked at OS level (denyWritePaths)
      process.env.FAKE_OPENCODE_MODE = 'attempt_write_existing_protected';
      const writeProtRes = await adapter.execute(baseCtx);
      assert.strictEqual(writeProtRes.success, false);
      assert.ok(writeProtRes.errorMessage?.includes('Blocked protected write:'), `Expected OS protected write block, got: ${writeProtRes.errorMessage}`);
      assert.strictEqual(fs.readFileSync(path.join(repoA, 'secrets/prod.key'), 'utf-8'), 'original-secret\n');

      // 5. Ignored file modification -> caught independently by Dupond baseline/post-execution check
      process.env.FAKE_OPENCODE_MODE = 'ignored_violation';
      await assert.rejects(() => adapter.execute(baseCtx), /Ignored path modified/i);
      fs.rmSync(path.join(repoA, 'ignored.secret'), { force: true });

      // 6. Symlink creation -> caught independently by Dupond baseline/post-execution check
      process.env.FAKE_OPENCODE_MODE = 'symlink_violation';
      await assert.rejects(() => adapter.execute(baseCtx), /Symlink creation/i);
      fs.rmSync(path.join(repoA, 'bad-link'), { force: true });

      // 7. Boundary violation on FAILED run -> still caught and throws DomainError
      process.env.FAKE_OPENCODE_MODE = 'fail_with_violation';
      await assert.rejects(() => adapter.execute(baseCtx), /Ignored path modified/i);
      fs.rmSync(path.join(repoA, 'ignored.secret'), { force: true });

      // 8. Independent repo accounting catches protected-file modification followed by a commit
      const baselineBeforeCommit = captureRepoBaseline(repoA);
      fs.writeFileSync(path.join(repoA, 'secrets/prod.key'), 'committed-hack\n');
      execFileSync('git', ['add', 'secrets/prod.key'], { cwd: repoA });
      execFileSync('git', ['commit', '-m', 'evil commit'], { cwd: repoA });
      const committedInspection = inspectAndVerifyRepoChanges(repoA, baselineBeforeCommit, baseCtx);
      assert.ok(committedInspection.filesModified.includes('secrets/prod.key'));
      assert.ok(committedInspection.violations.some((v) => /Unauthorized HEAD commit change/i.test(v)));
      assert.ok(committedInspection.violations.some((v) => /Boundary violation on "secrets\/prod\.key"/i.test(v)));
    } finally {
      delete process.env.FAKE_OPENCODE_SENTINEL_READ;
      delete process.env.FAKE_OPENCODE_OUTSIDE_WRITE;
      fs.rmSync(homeSentinelDir, { recursive: true, force: true });
    }
  });

  it('enforces protected-path patterns ONLY (secrets/**, .github/**, tests/**, .env*) at OS level or fails closed', async () => {
    const adapter = new OpenCodeCodingWorkerAdapter('github-copilot/gpt-5.3-codex');

    fs.mkdirSync(path.join(repoA, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repoA, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    fs.mkdirSync(path.join(repoA, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoA, 'tests', 'existing.test.mjs'), 'export const keep = true;\n');
    fs.writeFileSync(path.join(repoA, '.env'), 'SECRET=keep\n');
    fs.writeFileSync(path.join(repoA, '.env.local'), 'LOCAL=keep\n');
    execFileSync('git', ['add', '.github/workflows/ci.yml', 'tests/existing.test.mjs'], {
      cwd: repoA,
    });
    execFileSync('git', ['commit', '-m', 'seed protected pattern targets'], { cwd: repoA });

    const protectedPatternsOnly = ['secrets/**', '.github/**', 'tests/**', '.env*'];
    const ctx = {
      taskId: 't-patterns',
      taskKey: 'OPC-401',
      taskTitle: 'Pattern enforcement test',
      taskDescription: 'Desc',
      acceptanceCriteria: [],
      worktreePath: repoA,
      allowedPaths: [],
      protectedPaths: protectedPatternsOnly,
      attemptNumber: 1,
    };

    process.env.FAKE_OPENCODE_MODE = 'attempt_bypass_protected_patterns';

    if (process.platform === 'darwin') {
      // On macOS Seatbelt, all 4 patterns (subtree + .env* glob) are enforced at OS level
      // even when the fake CLI ignores OPENCODE_CONFIG_CONTENT and exits 0.
      const res = await adapter.execute(ctx);
      assert.strictEqual(res.success, true);

      const bypassLog = res.logs.find((l) => l.includes('BYPASS_RESULTS:'));
      assert.ok(bypassLog, 'Expected BYPASS_RESULTS log from fake CLI');
      const results = JSON.parse(
        bypassLog.slice(bypassLog.indexOf('BYPASS_RESULTS:') + 'BYPASS_RESULTS:'.length)
      ) as Record<string, string>;

      for (const [target, status] of Object.entries(results)) {
        assert.ok(status.startsWith('BLOCKED:'), `Expected OS block for "${target}", got ${status}`);
      }

      // Verify all existing protected bytes remained unchanged
      assert.strictEqual(fs.readFileSync(path.join(repoA, 'secrets/prod.key'), 'utf-8'), 'original-secret\n');
      assert.strictEqual(fs.readFileSync(path.join(repoA, '.github/workflows/ci.yml'), 'utf-8'), 'name: ci\n');
      assert.strictEqual(fs.readFileSync(path.join(repoA, 'tests/existing.test.mjs'), 'utf-8'), 'export const keep = true;\n');
      assert.strictEqual(fs.readFileSync(path.join(repoA, '.env'), 'utf-8'), 'SECRET=keep\n');
      assert.strictEqual(fs.readFileSync(path.join(repoA, '.env.local'), 'utf-8'), 'LOCAL=keep\n');

      // Verify no new matching protected files were created
      assert.strictEqual(fs.existsSync(path.join(repoA, 'secrets/new.key')), false);
      assert.strictEqual(fs.existsSync(path.join(repoA, '.github/new-workflow.yml')), false);
      assert.strictEqual(fs.existsSync(path.join(repoA, 'tests/new.test.mjs')), false);
      assert.strictEqual(fs.existsSync(path.join(repoA, '.env.evil')), false);
      assert.strictEqual(fs.existsSync(path.join(repoA, 'nested/.env.injected')), false);
    } else {
      // On Linux container runtime, .env* glob cannot prevent new matching file creation -> fail closed before launching
      await assert.rejects(
        () => adapter.execute(ctx),
        /cannot enforce protected-path glob "\.env\*"/i,
      );

      // Existing subtree patterns (secrets/**, .github/**, tests/**) ARE enforced via :ro bind mounts
      const res = await adapter.execute({
        ...ctx,
        protectedPaths: ['secrets/**', '.github/**', 'tests/**'],
      });
      assert.strictEqual(res.success, true);
      assert.strictEqual(fs.readFileSync(path.join(repoA, 'secrets/prod.key'), 'utf-8'), 'original-secret\n');
      assert.strictEqual(fs.readFileSync(path.join(repoA, '.github/workflows/ci.yml'), 'utf-8'), 'name: ci\n');
      assert.strictEqual(fs.readFileSync(path.join(repoA, 'tests/existing.test.mjs'), 'utf-8'), 'export const keep = true;\n');
      assert.strictEqual(fs.existsSync(path.join(repoA, 'secrets/new.key')), false);
      assert.strictEqual(fs.existsSync(path.join(repoA, '.github/new-workflow.yml')), false);
      assert.strictEqual(fs.existsSync(path.join(repoA, 'tests/new.test.mjs')), false);
    }

    // Unsupported pattern fails closed on all platforms before launching
    await assert.rejects(
      () => adapter.execute({ ...ctx, protectedPaths: ['secrets/{a,b}.key'] }),
      /Unsupported protected-path pattern/i,
    );
  });

  it('overrides inherited parent-repo PWD in sandboxed linked worktrees and validates real OpenCode CLI startup when installed', async () => {
    const homeBase = fs.mkdtempSync(path.join(os.homedir(), '.dupond-pwd-test-'));
    const origPwd = process.env.PWD;
    try {
      const parentRepo = path.join(homeBase, 'parent-repo');
      const worktreePath = path.join(parentRepo, '.dupond_worktrees', 'run-pwd-check');
      fs.mkdirSync(parentRepo, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: parentRepo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: parentRepo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: parentRepo });
      fs.writeFileSync(path.join(parentRepo, 'impl.mjs'), 'export const ok = false;\n');
      execFileSync('git', ['add', '.'], { cwd: parentRepo });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: parentRepo });
      execFileSync('git', ['worktree', 'add', '-b', 'run-pwd-check', worktreePath, 'HEAD'], { cwd: parentRepo });

      const realWorktree = fs.realpathSync(worktreePath);
      process.env.PWD = parentRepo;
      process.env.FAKE_OPENCODE_MODE = 'honor_pwd';
      process.env.FAKE_OPENCODE_EMIT_ENV = '1';

      const adapter = new OpenCodeCodingWorkerAdapter('github-copilot/gpt-5.3-codex');
      const res = await adapter.execute({
        taskId: 't-pwd',
        taskKey: 'OPC-501',
        taskTitle: 'PWD isolation check',
        taskDescription: 'Desc',
        acceptanceCriteria: [],
        worktreePath: realWorktree,
        allowedPaths: ['impl.mjs'],
        protectedPaths: [],
        attemptNumber: 1,
      });

      assert.strictEqual(res.success, true, `Expected success, got: ${res.errorMessage}`);
      const logsStr = res.logs.join('\n');
      const diagMatch = logsStr.match(/ENV_DIAG:(\{.*\})/);
      assert.ok(diagMatch, 'Expected ENV_DIAG log');
      const diag = JSON.parse(diagMatch[1]);
      assert.strictEqual(diag.pwd, realWorktree, 'PWD inside sandbox must be the worktree, not parent repo');
      assert.strictEqual(diag.cwd, realWorktree);

      // Real installed OpenCode CLI startup check (non-paid model error, zero paid calls)
      const realOpenCodeBin = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
      if (process.platform === 'darwin' && fs.existsSync(realOpenCodeBin)) {
        const { SandboxExecutor } = await import('../src/server/sandbox/sandboxExecutor.js');
        const realBin = fs.realpathSync(realOpenCodeBin);
        const sb = new SandboxExecutor();
        const realRes = await sb.execute({
          worktreePath: realWorktree,
          command: realOpenCodeBin,
          args: ['run', '--standalone', '--format', 'json', '--archived', '--auto', '--model', 'opencode/nonexistent-test', 'hello'],
          rawArgv: true,
          timeoutMs: 10_000,
          allowNetwork: true,
          gitReadOnly: true,
          extraReadPaths: [realOpenCodeBin, path.dirname(realOpenCodeBin), realBin, path.dirname(realBin), process.execPath, path.dirname(process.execPath)],
          env: {
            PWD: parentRepo, // Explicitly pass parentRepo PWD to prove SandboxExecutor overrides it
            OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
          },
        });
        assert.strictEqual(
          realRes.stdout.includes('Failed to change directory to'),
          false,
          `Real OpenCode CLI hit chdir failure: ${realRes.stdout}`,
        );
        assert.ok(
          realRes.stdout.includes('Model unavailable'),
          `Expected real OpenCode CLI to reach model validation cleanly, got stdout=${realRes.stdout} stderr=${realRes.stderr}`,
        );
      }
    } finally {
      delete process.env.FAKE_OPENCODE_EMIT_ENV;
      if (origPwd === undefined) delete process.env.PWD;
      else process.env.PWD = origPwd;
      fs.rmSync(homeBase, { recursive: true, force: true });
    }
  });

  it('fails fast in 1 attempt on deterministic startup/configuration errors without spending 3 repair attempts', async () => {
    const store = new TaskStore(dbPath);
    const projectStore = new ProjectStore(store);
    const proj = projectStore.createProject({ name: 'FailFast Proj', actor: 'test', repository: { localPath: repoA, defaultBranch: 'main' } });
    const task = store.createTask({
      id: 'task-opc-failfast',
      key: 'OPC-502',
      projectId: proj.id,
      title: 'Deterministic startup error test',
      description: 'Should not retry 3 times on deterministic startup error',
      status: 'in_progress',
      targetRepo: 'local',
      targetRepoPath: repoA,
      baseCommit: 'main',
      allowedPaths: ['impl.mjs'],
      protectedPaths: [],
      acceptanceCriteria: [{ id: 'ac-1', title: 'passes', completed: false, checkCommand: 'true' }],
      verificationCommands: [{ command: 'true', criteriaIds: ['ac-1'] }],
      workerConfig: { provider: 'opencode', model: 'github-copilot/claude-sonnet-4.6' },
      maxAttempts: 3,
    });

    const coordinator = new RepairCoordinator(store, new WorkspaceManager(repoA), new AuthoritativeVerifier());
    process.env.FAKE_OPENCODE_MODE = 'deterministic_startup_error';
    const run = await coordinator.executeTaskRun({
      task,
      workspaceManager: new WorkspaceManager(repoA),
      runId: 'run-opc-failfast',
    });

    assert.strictEqual(run.status, 'failed');
    assert.ok(run.failureReason?.includes('Model unavailable'));
    const attempts = store.listAttempts('run-opc-failfast', proj.id);
    assert.strictEqual(attempts.length, 1, 'Deterministic startup failure must stop after 1 attempt instead of 3');
    store.getRawDb().close();
  });
});
