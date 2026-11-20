import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgyCodingWorkerAdapter } from '../src/server/worker/agyWorkerAdapter.js';
import { resolveCodingWorker, validateWorkerConfig } from '../src/server/worker/workerRegistry.js';
import { SandboxExecutor } from '../src/server/sandbox/sandboxExecutor.js';

function createFakeAgyWorkerBin(dir: string): string {
  const binPath = path.join(dir, 'fake-agy');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const homeDir = process.env.HOME;
const tokenFile = path.join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

if (args.includes('--version')) {
  console.log('1.5.13');
  process.exit(0);
}

if (args[0] === 'models') {
  if (fs.existsSync(tokenFile)) {
    console.log('gemini-3.8-flash-medium         Gemini 3.8 Flash (Medium)');
    console.log('gemini-4-neon-high              Gemini 4 Neon (High)');
    process.exit(0);
  }
  console.error('Error: Please sign in to view available models.');
  process.exit(1);
}

const capturedEnv = {
  argv: args,
  cwd: process.cwd(),
  pwd: process.env.PWD || '',
  oldpwd: process.env.OLDPWD || null,
  home: process.env.HOME || '',
  hasDupondKey: Object.keys(process.env).some((k) => k.startsWith('DUPOND_')),
  hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
  hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
  hasTokenSeed: fs.existsSync(tokenFile),
};

const scenario = process.env.FAKE_AGY_SCENARIO || 'success';

if (scenario === 'hang') {
  setInterval(() => {}, 1000);
} else if (scenario === 'protected_violation') {
  fs.mkdirSync(path.join(process.cwd(), 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'secrets', 'leak.txt'), 'nope\\n');
  console.log(JSON.stringify({ type: 'result', session_id: 'sess-prot', num_turns: 1, result: 'Done', captured: capturedEnv }));
  process.exit(0);
} else if (scenario === 'json_error_secret') {
  console.log(JSON.stringify({
    type: 'result',
    is_error: true,
    errors: [
      'Upstream error Bearer SYNTH_SECRET_BEARER_999 ya29.SYNTH_OAUTH_SECRET_888 AIzaSySYNTH_GEMINI_SECRET_777'
    ]
  }));
  process.exit(0);
} else if (scenario === 'empty_exit0') {
  process.exit(0);
} else if (scenario === 'malformed_exit0') {
  console.log('not valid json {{{');
  process.exit(0);
} else if (scenario === 'missing_completion_exit0') {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
} else if (scenario === 'bad_code_exit0') {
  fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'src', 'feature.ts'), 'export const value = 999;\\n');
  console.log(JSON.stringify({ type: 'result', session_id: 'sess-bad', num_turns: 1, result: 'Done', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, captured: capturedEnv }));
  process.exit(0);
} else {
  fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'src', 'feature.ts'), 'export const value = 42;\\n');
  console.log(JSON.stringify({ type: 'result', session_id: 'sess-ok', num_turns: 1, result: 'Done', usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }, captured: capturedEnv }));
  process.exit(0);
}
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

function initGitRepo(tmpDir: string): string {
  const repoDir = path.join(tmpDir, 'repo');
  const bareDir = path.join(tmpDir, 'remote.git');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'feature.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'secrets', 'token.txt'), 'protected\n');
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'test-repo', version: '1.0.0', type: 'module' }, null, 2),
  );
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
  execFileSync('git', ['init', '--bare', bareDir]);
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });
  return repoDir;
}

describe('Antigravity CLI (agy) coding-worker integration & Gemini CLI removal', () => {
  let tmpDir: string;
  let profileDir: string;
  let fakeBin: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-agy-worker-'));
    profileDir = path.join(tmpDir, 'agy-profile');
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    fakeBin = createFakeAgyWorkerBin(tmpDir);

    origEnv = {
      DUPOND_AGY_BIN: process.env.DUPOND_AGY_BIN,
      DUPOND_AGY_PROFILE_DIR: process.env.DUPOND_AGY_PROFILE_DIR,
      DUPOND_DB_PATH: process.env.DUPOND_DB_PATH,
      DUPOND_STATE_FILE: process.env.DUPOND_STATE_FILE,
      DUPOND_CONN_KEY_PATH: process.env.DUPOND_CONN_KEY_PATH,
      DUPOND_TARGET_REPO: process.env.DUPOND_TARGET_REPO,
      FAKE_AGY_SCENARIO: process.env.FAKE_AGY_SCENARIO,
      FAKE_AGY_ENV_OUT: process.env.FAKE_AGY_ENV_OUT,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    process.env.DUPOND_AGY_BIN = fakeBin;
    process.env.DUPOND_AGY_PROFILE_DIR = profileDir;
    delete process.env.FAKE_AGY_SCENARIO;
    delete process.env.FAKE_AGY_ENV_OUT;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProfileToken() {
    const tokenPath = path.join(profileDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ token: 'synth-token' }), { mode: 0o600 });
  }

  it('rejects removed gemini-cli cleanly without silent substitution and checks agy readiness without auto-login', async () => {
    const removedValidation = validateWorkerConfig({ provider: 'gemini-cli', model: 'gemini-2.5-flash' });
    assert.strictEqual(removedValidation.valid, false);
    assert.ok(removedValidation.error?.includes('Provider removed—select another provider.'));
    assert.throws(
      () => resolveCodingWorker({ provider: 'gemini-cli', model: 'gemini-2.5-flash' }),
      /Provider removed—select another provider/,
    );

    const agyValidation = validateWorkerConfig({ provider: 'agy', model: 'gemini-3.8-flash-medium' });
    assert.strictEqual(agyValidation.valid, true);
    assert.strictEqual(agyValidation.provider, 'agy');
    assert.strictEqual(agyValidation.model, 'gemini-3.8-flash-medium');

    const worker = new AgyCodingWorkerAdapter('gemini-3.8-flash-medium', new SandboxExecutor());
    const unauthAvail = await worker.isAvailable();
    assert.strictEqual(unauthAvail.available, false);
    assert.ok(unauthAvail.error?.includes('Application Settings'));

    writeProfileToken();
    const authAvail = await worker.isAvailable();
    assert.strictEqual(authAvail.available, true, `Expected available=true, got error: ${authAvail.error}`);
  });

  it('executes agy in OS sandbox with isolated HOME/args/protected paths and enforces independent verification & historical recovery', async () => {
    writeProfileToken();
    const repoDir = initGitRepo(tmpDir);
    const envOutFile = path.join(tmpDir, 'agy-env.json');
    process.env.FAKE_AGY_ENV_OUT = envOutFile;
    process.env.GEMINI_API_KEY = 'secret-gemini-key';
    process.env.OPENAI_API_KEY = 'secret-openai-key';
    process.env.DUPOND_DB_PATH = path.join(tmpDir, 'dupond.db');
    process.env.DUPOND_STATE_FILE = path.join(tmpDir, 'state.json');
    process.env.DUPOND_CONN_KEY_PATH = path.join(tmpDir, 'conn.key');
    process.env.DUPOND_TARGET_REPO = repoDir;

    const { TaskStore } = await import('../src/server/db/database.js');
    const { ProjectStore } = await import('../src/server/projects/projectStore.js');
    const { RepairCoordinator } = await import('../src/server/coordinator/repairCoordinator.js');
    const { WorkspaceManager } = await import('../src/server/workspace/workspaceManager.js');
    const { AuthoritativeVerifier } = await import('../src/server/verification/authoritativeVerifier.js');

    const taskStore = new TaskStore(path.join(tmpDir, 'dupond.db'));
    const projectStore = new ProjectStore(taskStore);
    const project = projectStore.createProject({
      id: 'proj-agy',
      name: 'Agy Test Project',
      repository: { localPath: repoDir, defaultBranch: 'main', targetDirectory: '.' },
      actor: 'test-operator',
    });

    const sandbox = new SandboxExecutor();
    const verifier = new AuthoritativeVerifier(sandbox);
    const workspaceManager = new WorkspaceManager(repoDir);
    const repairCoordinator = new RepairCoordinator(taskStore, workspaceManager, verifier);

    // Inspect captured sandbox env/argv directly from adapter.execute() logs
    process.env.FAKE_AGY_SCENARIO = 'bad_code_exit0';
    const adapter = new AgyCodingWorkerAdapter('gemini-3.8-flash-medium', sandbox);
    const probeExec = await adapter.execute({
      taskId: 't-env',
      taskKey: 'AEG-200',
      taskTitle: 'Env check',
      taskDescription: 'Verify sandbox env and argv',
      acceptanceCriteria: [],
      worktreePath: repoDir,
      allowedPaths: ['src'],
      protectedPaths: ['secrets'],
      attemptNumber: 1,
    });
    assert.strictEqual(probeExec.success, true);
    const jsonLogLine = probeExec.logs
      .flatMap((l) => l.split(/\r?\n/))
      .find((l) => l.trim().startsWith('{'))!;
    const captured = JSON.parse(jsonLogLine).captured;
    assert.strictEqual(captured.hasDupondKey, false);
    assert.strictEqual(captured.hasGeminiKey, false);
    assert.strictEqual(captured.hasOpenAIKey, false);
    assert.strictEqual(captured.hasTokenSeed, true);
    assert.strictEqual(captured.oldpwd, null);
    assert.notStrictEqual(captured.home, os.homedir());
    assert.ok(captured.argv.includes('--print'));
    assert.ok(captured.argv.includes('--output-format'));
    assert.ok(captured.argv.includes('json'));
    assert.ok(captured.argv.includes('--disable-slash-commands'));
    assert.ok(captured.argv.includes('--settings'));

    // Reset repoDir before RepairCoordinator run
    execFileSync('git', ['checkout', '--', 'src/feature.ts'], { cwd: repoDir });

    // 1. CLI exits 0 but independent verification fails -> must NOT complete, provenance agy:gemini-3.8-flash-medium recorded
    process.env.FAKE_AGY_SCENARIO = 'bad_code_exit0';
    const failTask = taskStore.createTask({
      id: 'task-fail-verif',
      projectId: project.id,
      key: 'AEG-201',
      title: 'Failing verification check',
      description: 'Must fail independent verification even when agy exits 0.',
      status: 'in_progress',
      priority: 'medium',
      epicId: 'e1',
      estimatedHours: 1,
      tags: [],
      targetRepoPath: repoDir,
      allowedPaths: ['src'],
      protectedPaths: ['secrets'],
      verificationCommands: ['node -e "const fs=require(\'fs\'); if(!fs.readFileSync(\'src/feature.ts\',\'utf8\').includes(\'42\')) process.exit(1)"'],
      acceptanceCriteria: [{ id: 'ac1', title: 'Export value 42', completed: false }],
      workerConfig: { provider: 'agy', model: 'gemini-3.8-flash-medium' },
      dependencies: [],
    });

    const resFail = await repairCoordinator.executeTaskRun({
      task: failTask,
      worker: new AgyCodingWorkerAdapter('gemini-3.8-flash-medium', sandbox),
    });
    assert.strictEqual(resFail.status, 'failed');
    const failAttempts = taskStore.listAttempts(resFail.id, project.id);
    assert.ok(
      failAttempts.length >= 1,
      `Expected >= 1 attempt, got 0. Run info: ${JSON.stringify({ id: resFail.id, reason: resFail.failureReason, baseCommit: resFail.baseCommit })}`,
    );
    assert.strictEqual(failAttempts[0].workerType, 'agy:gemini-3.8-flash-medium');

    // 2. Protected path violation rolled back cleanly
    process.env.FAKE_AGY_SCENARIO = 'protected_violation';
    const protRes = await adapter.execute({
      taskId: 't-prot',
      taskKey: 'AEG-202',
      taskTitle: 'Protected',
      taskDescription: 'Try protected write',
      acceptanceCriteria: [],
      worktreePath: repoDir,
      allowedPaths: ['src'],
      protectedPaths: ['secrets'],
      attemptNumber: 1,
    });
    assert.strictEqual(protRes.success, false);
    assert.ok(
      protRes.errorMessage &&
        /violated repository boundaries|EPERM|operation not permitted|failed \(exit/i.test(protRes.errorMessage),
      `Unexpected protected-path errorMessage: ${protRes.errorMessage}`,
    );
    assert.strictEqual(fs.existsSync(path.join(repoDir, 'secrets', 'leak.txt')), false);

    // 3. Cancellation kills subprocess cleanly
    process.env.FAKE_AGY_SCENARIO = 'hang';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    const cancelRes = await adapter.execute({
      taskId: 't-cancel',
      taskKey: 'AEG-203',
      taskTitle: 'Cancel',
      taskDescription: 'Hang and cancel',
      acceptanceCriteria: [],
      worktreePath: repoDir,
      allowedPaths: ['src'],
      protectedPaths: ['secrets'],
      attemptNumber: 1,
      abortSignal: ac.signal,
      timeoutMs: 10_000,
    });
    assert.strictEqual(cancelRes.success, false);
    assert.strictEqual(cancelRes.nonRetryable, true);

    // 4. Historical gemini-cli task & provenance preserved, execution rejected explicitly, project isolated
    const legacyTask = taskStore.createTask({
      id: 'task-legacy-gcli',
      projectId: project.id,
      key: 'AEG-204',
      title: 'Legacy Gemini CLI task',
      description: 'Preserve run history and block execution until replaced.',
      status: 'todo',
      priority: 'medium',
      epicId: 'e1',
      estimatedHours: 1,
      tags: [],
      targetRepoPath: repoDir,
      allowedPaths: ['src'],
      protectedPaths: ['secrets'],
      verificationCommands: ['node -e "process.exit(0)"'],
      acceptanceCriteria: [{ id: 'ac1', title: 'Done', completed: false, checkCommand: 'node -e "process.exit(0)"' }],
      workerConfig: { provider: 'gemini-cli', model: 'gemini-2.5-flash' },
      dependencies: [],
    });
    const histRun = taskStore.createRun({
      taskId: legacyTask.id,
      projectId: project.id,
      status: 'failed',
      baseCommit: '0000000',
      targetBranch: 'main',
      currentAttempt: 1,
      durationMs: 100,
      worktreePath: repoDir,
    });
    taskStore.createAttempt({
      runId: histRun.id,
      attemptNumber: 1,
      workerType: 'gemini-cli:gemini-2.5-flash',
      status: 'failed',
      startedAt: new Date().toISOString(),
      durationMs: 100,
      filesModified: [],
      diff: '',
      errorMessage: 'IneligibleTierError',
    });

    const blockedLegacyRun = await repairCoordinator.executeTaskRun({ task: legacyTask });
    assert.strictEqual(blockedLegacyRun.status, 'failed');
    assert.strictEqual(blockedLegacyRun.currentAttempt, 0);
    assert.ok(blockedLegacyRun.failureReason?.includes('Provider removed—select another provider'));
    assert.strictEqual(taskStore.listAttempts(histRun.id, project.id)[0].workerType, 'gemini-cli:gemini-2.5-flash');
    assert.strictEqual(taskStore.listAttempts(histRun.id, 'other-project').length, 0);

    // 5. Replacing provider with agy and executing succeeds with agy:gemini-3.8-flash-medium provenance
    process.env.FAKE_AGY_SCENARIO = 'success';
    const okRes = await repairCoordinator.executeTaskRun({
      runId: 'run-legacy-recovery',
      task: { ...legacyTask, workerConfig: { provider: 'agy', model: 'gemini-3.8-flash-medium' } },
      worker: new AgyCodingWorkerAdapter('gemini-3.8-flash-medium', sandbox),
    });
    assert.strictEqual(okRes.status, 'completed', `Expected completed, got ${okRes.status}: ${okRes.failureReason}`);
    assert.strictEqual(taskStore.listAttempts(okRes.id, project.id)[0].workerType, 'agy:gemini-3.8-flash-medium');
    assert.strictEqual(taskStore.listAttempts(histRun.id, project.id)[0].workerType, 'gemini-cli:gemini-2.5-flash');
  });

  it('sanitizes structured JSON errors and fails closed on empty, malformed, error-envelope, or unverified exit-0 output', async () => {
    writeProfileToken();
    const repoDir = initGitRepo(tmpDir);
    const sandbox = new SandboxExecutor();
    const adapter = new AgyCodingWorkerAdapter('gemini-3.8-flash-medium', sandbox);
    const baseCtx = {
      taskId: 't-contract',
      taskKey: 'AEG-205',
      taskTitle: 'Output contract check',
      taskDescription: 'Verify fail-closed JSON contract and secret sanitization',
      acceptanceCriteria: [],
      worktreePath: repoDir,
      allowedPaths: ['src'],
      protectedPaths: ['secrets'],
      attemptNumber: 1,
    };

    // 1. Structured JSON error with embedded synthetic secrets is sanitized in both errorMessage and logs
    process.env.FAKE_AGY_SCENARIO = 'json_error_secret';
    const errSecretRes = await adapter.execute(baseCtx);
    assert.strictEqual(errSecretRes.success, false);
    const serialized = JSON.stringify({ err: errSecretRes.errorMessage, logs: errSecretRes.logs });
    assert.ok(!serialized.includes('SYNTH_SECRET_BEARER_999'), 'Bearer secret must be sanitized');
    assert.ok(!serialized.includes('SYNTH_OAUTH_SECRET_888'), 'OAuth token must be sanitized');
    assert.ok(!serialized.includes('SYNTH_GEMINI_SECRET_777'), 'API key must be sanitized');
    assert.ok(errSecretRes.errorMessage?.includes('[REDACTED]'));

    // 2. Empty stdout with exit 0 fails closed
    process.env.FAKE_AGY_SCENARIO = 'empty_exit0';
    const emptyRes = await adapter.execute(baseCtx);
    assert.strictEqual(emptyRes.success, false);
    assert.ok(/empty output/i.test(emptyRes.errorMessage || ''));

    // 3. Malformed JSON stdout with exit 0 fails closed
    process.env.FAKE_AGY_SCENARIO = 'malformed_exit0';
    const malformedRes = await adapter.execute(baseCtx);
    assert.strictEqual(malformedRes.success, false);
    assert.ok(/malformed JSON/i.test(malformedRes.errorMessage || ''));

    // 4. Arbitrary JSON missing steps.JSONOutput completion envelope fails closed even on exit 0
    process.env.FAKE_AGY_SCENARIO = 'missing_completion_exit0';
    const missingRes = await adapter.execute(baseCtx);
    assert.strictEqual(missingRes.success, false);
    assert.ok(/completion/i.test(missingRes.errorMessage || ''));

    // 5. Valid steps.JSONOutput completion envelope succeeds cleanly
    process.env.FAKE_AGY_SCENARIO = 'success';
    const validRes = await adapter.execute(baseCtx);
    assert.strictEqual(validRes.success, true);
    assert.strictEqual(validRes.tokenUsage?.totalTokens, 20);
  });
});
