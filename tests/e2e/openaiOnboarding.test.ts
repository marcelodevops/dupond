import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { expect as pwExpect } from 'playwright/test';

const SYNTH_BAD_KEY = 'sk-synth-openai-bad-000000000001';
const SYNTH_GOOD_KEY_1 = 'sk-synth-openai-good-111111111112';
const SYNTH_GOOD_KEY_2 = 'sk-synth-openai-good-222222222223';
const SYNTH_ENV_KEY = 'sk-synth-openai-env-999999999999';
const SYNTH_OPERATOR_TOKEN = 'dp_e2e_openai_operator_token_12345';
const ALL_OPENAI_SECRETS = [SYNTH_BAD_KEY, SYNTH_GOOD_KEY_1, SYNTH_GOOD_KEY_2, SYNTH_ENV_KEY];
const ALL_DIAGNOSTIC_SECRETS = [...ALL_OPENAI_SECRETS, SYNTH_OPERATOR_TOKEN];

function assertNoSecretLeak(label: string, text: string, secrets: string[] = ALL_OPENAI_SECRETS): void {
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `Security violation: synthetic secret leaked in ${label}`);
  }
}

async function getFreePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitForHealthy(url: string, proc: ChildProcess, logs: () => string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`App server exited early (${proc.exitCode}):\n${logs()}`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}/api/health:\n${logs()}`);
}

describe('OpenAI credential onboarding browser E2E', () => {
  let tmpDir: string;
  let dbPath: string;
  let statePath: string;
  let keyPath: string;
  let repoDir: string;
  let mockOpenAIServer: http.Server;
  let mockOpenAIPort: number;
  let mockMode: 'normal' | 'hang' | 'delay-gpt-4o-mini' = 'normal';
  let releaseDelayedModel!: () => void;
  let mockAbortedCount = 0;
  let mockHangingReceivedCount = 0;
  const openMockResponses = new Set<http.ServerResponse>();
  let serverProc: ChildProcess | null = null;
  let serverPort: number;
  let serverUrl: string;
  let serverLogs = '';
  let browser: Browser;

  async function startAppServer(extraEnv: Record<string, string | undefined> = {}): Promise<void> {
    serverPort = await getFreePort();
    serverUrl = `http://127.0.0.1:${serverPort}`;
    serverLogs = '';
    const tsxBin = path.resolve(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
    );
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PORT: String(serverPort),
      DUPOND_BIND_HOST: '127.0.0.1',
      NODE_ENV: 'production',
      DUPOND_AUTH_TOKEN: SYNTH_OPERATOR_TOKEN,
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
      DUPOND_CONN_KEY_PATH: keyPath,
      DUPOND_ALLOW_TEST_OPENAI_ENDPOINT: '1',
      DUPOND_OPENAI_TEST_BASE_URL: `http://127.0.0.1:${mockOpenAIPort}/v1`,
    };
    delete env.OPENAI_API_KEY;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    serverProc = spawn(tsxBin, ['server.ts'], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (d) => (serverLogs += d.toString()));
    serverProc.stderr?.on('data', (d) => (serverLogs += d.toString()));
    await waitForHealthy(serverUrl, serverProc, () => serverLogs);
  }

  async function stopAppServer(): Promise<void> {
    if (!serverProc) return;
    const p = serverProc;
    serverProc = null;
    try {
      if (p.pid) process.kill(-p.pid, 'SIGTERM');
    } catch {}
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 4000);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-e2e-openai-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    statePath = path.join(tmpDir, 'state.json');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    repoDir = path.join(tmpDir, 'repo');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'init\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    mockOpenAIServer = http.createServer((req, res) => {
      const auth = String(req.headers.authorization || '');
      const apiKey = auth.replace(/^Bearer\s+/i, '').trim();
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        if (mockMode === 'hang') {
          mockHangingReceivedCount += 1;
          openMockResponses.add(res);
          res.on('close', () => {
            openMockResponses.delete(res);
            if (!res.writableEnded) mockAbortedCount += 1;
          });
          return;
        }
        if (apiKey === SYNTH_BAD_KEY) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Invalid API key: ${apiKey}`, code: 'invalid_api_key' } }));
          return;
        }
        const parsed = JSON.parse(body || '{}');
        if (mockMode === 'delay-gpt-4o-mini' && parsed.model === 'gpt-4o-mini') {
          new Promise<void>((r) => (releaseDelayedModel = r)).then(() => {
            if (!res.writableEnded) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'delayed failure', code: 'invalid_api_key' } }));
            }
          });
          return;
        }
        if (parsed.model === 'nonexistent-custom-model') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'The model nonexistent-custom-model does not exist', code: 'model_not_found' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp_e2e_ok',
            object: 'response',
            model: parsed.model,
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => mockOpenAIServer.listen(0, '127.0.0.1', resolve));
    mockOpenAIPort = (mockOpenAIServer.address() as any).port;

    await startAppServer();
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    try {
      await browser?.close();
    } catch {}
    await stopAppServer();
    try {
      await new Promise<void>((r) => mockOpenAIServer.close(() => r()));
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exercises OpenAI onboarding, coding-worker scoping, test outcomes, cancel/timeout, env precedence, and zero secret leaks', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_OPERATOR_TOKEN);
    const page: Page = await context.newPage();

    const apiBodies: string[] = [];
    const consoleLogs: string[] = [];
    page.on('console', (msg) => consoleLogs.push(msg.text()));
    page.on('response', async (res) => {
      if (res.url().includes('/api/credentials/openai')) {
        try {
          apiBodies.push(await res.text());
        } catch {}
      }
    });

    try {
      // Seed a secondary project with an OpenAI task so we verify project preservation & task link
      const projRes = await fetch(`${serverUrl}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYNTH_OPERATOR_TOKEN}`,
        },
        body: JSON.stringify({
          name: 'OpenAI Worker Project',
          description: 'E2E project for OpenAI worker onboarding',
          repository: { repoUrl: 'org/openai-worker-repo', localPath: repoDir, defaultBranch: 'main' },
        }),
      });
      assert.strictEqual(projRes.status, 201);
      const proj = (await projRes.json()) as any;

      const seedStateRes = await fetch(`${serverUrl}/api/orchestrate/state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYNTH_OPERATOR_TOKEN}`,
          'X-Dupond-Project-Id': proj.id,
        },
        body: JSON.stringify({
          tasks: [
            {
              id: 'OAI-101',
              key: 'OAI-101',
              epicId: 'EPIC-1',
              title: 'OpenAI worker task',
              description: 'Verify OpenAI missing credential link',
              status: 'todo',
              priority: 'high',
              assignedAgentId: 'agent-dev',
              workerConfig: { provider: 'openai', model: 'o3-mini' },
              tags: [],
              subtasks: [],
              deliverables: [],
              estimatedHours: 2,
              spentHours: 0,
            },
          ],
          agents: [
            {
              id: 'agent-dev',
              name: 'Dev',
              role: 'Developer',
              baseRole: 'Developer',
              avatar: 'D',
              model: 'o3-mini',
              status: 'idle',
              completedTasksCount: 0,
              velocity: 1,
              skills: ['ts'],
              communicationCount: 0,
              providerType: 'gemini',
            },
          ],
          epics: [],
          communications: [],
        }),
      });
      assert.strictEqual(seedStateRes.status, 200);

      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      const switcherBtn = page.getByRole('button', { name: 'Switch Dupond Project' });
      await switcherBtn.click();
      await page.getByRole('button', { name: /OpenAI Worker Project/i }).click();

      // OpenAI task lacking credentials exposes configuration link -> opens Application Settings
      await page.getByTestId('kanban-card-OAI-101').click();
      await pwExpect(page.getByTestId('openai-worker-credential-warning')).toBeVisible();
      await page.getByTestId('open-app-settings-from-task-btn').click();

      await pwExpect(page.getByTestId('application-settings-modal')).toBeVisible();
      await pwExpect(page.getByTestId('openai-credential-section')).toBeVisible();
      await pwExpect(page.getByTestId('openai-saved-badge')).toHaveText('Not Configured');
      await pwExpect(page.getByTestId('openai-worker-scope-notice')).toContainText('planning still uses Gemini');
      await pwExpect(page.getByTestId('openai-credential-section')).toContainText('may incur API usage');

      // Save bad key -> test fails with Verification Failed and redacted error
      await page.getByTestId('openai-api-key-input').fill(SYNTH_BAD_KEY);
      await page.getByTestId('save-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-saved-badge')).toHaveText('Saved');
      await pwExpect(page.getByTestId('openai-verified-badge')).toHaveText('Unverified');

      await page.getByTestId('test-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-error-banner')).toBeVisible();
      await pwExpect(page.getByTestId('openai-verified-badge')).toContainText('Verification Failed');

      // Replace with valid key + select explicit model o3-mini -> Verified (o3-mini)
      await page.getByTestId('openai-api-key-input').fill(SYNTH_GOOD_KEY_1);
      await page.getByTestId('save-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-verified-badge')).toHaveText('Unverified');
      await page.getByTestId('openai-test-model-select').selectOption('o3-mini');
      await page.getByTestId('test-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-success-banner')).toContainText('model o3-mini');
      await pwExpect(page.getByTestId('openai-verified-badge')).toContainText('Verified (o3-mini)');

      // Custom model rejection by provider + custom model verification
      await page.getByTestId('openai-test-model-select').selectOption('__custom__');
      await page.getByTestId('openai-custom-model-input').fill('nonexistent-custom-model');
      await page.getByTestId('test-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-error-banner')).toBeVisible();
      await pwExpect(page.getByTestId('openai-verified-badge')).toContainText('Verification Failed (nonexistent-custom-model)');

      await page.getByTestId('openai-custom-model-input').fill('gpt-4.1-mini');
      await page.getByTestId('test-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-success-banner')).toContainText('model gpt-4.1-mini');
      await pwExpect(page.getByTestId('openai-verified-badge')).toContainText('Verified (gpt-4.1-mini)');

      // Changing selected model during a pending test never shows the newly selected model as verified
      mockMode = 'delay-gpt-4o-mini';
      releaseDelayedModel = undefined as any;
      await page.getByTestId('openai-test-model-select').selectOption('gpt-4o-mini');
      await page.getByTestId('test-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-test-pending')).toBeVisible();
      await page.getByTestId('openai-test-model-select').selectOption('gpt-4o');
      for (let i = 0; i < 40 && typeof releaseDelayedModel !== 'function'; i++) {
        await page.waitForTimeout(50);
      }
      assert.strictEqual(typeof releaseDelayedModel, 'function');
      releaseDelayedModel();
      await pwExpect(page.getByTestId('openai-test-pending')).toBeHidden({ timeout: 10000 });
      await pwExpect(page.getByTestId('openai-verified-badge')).toHaveText('Unverified');
      await pwExpect(page.getByTestId('openai-different-model-verified-note')).toContainText('gpt-4o-mini');
      mockMode = 'normal';

      // Cross-model API ordering race: Model A (gpt-4o-mini) starts first, Model B (gpt-4.1-mini) finishes first, then A completes -> B retained across restart
      mockMode = 'delay-gpt-4o-mini';
      releaseDelayedModel = undefined as any;
      const reqAPromise = fetch(`${serverUrl}/api/credentials/openai/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYNTH_OPERATOR_TOKEN}`,
        },
        body: JSON.stringify({ model: 'gpt-4o-mini' }),
      });
      for (let i = 0; i < 40 && typeof releaseDelayedModel !== 'function'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(typeof releaseDelayedModel, 'function');
      const reqBRes = await fetch(`${serverUrl}/api/credentials/openai/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYNTH_OPERATOR_TOKEN}`,
        },
        body: JSON.stringify({ model: 'gpt-4.1-mini' }),
      });
      assert.strictEqual(reqBRes.status, 200);
      assert.strictEqual(((await reqBRes.json()) as any).ok, true);
      releaseDelayedModel();
      const reqARes = await reqAPromise;
      const reqAJson = (await reqARes.json()) as any;
      assert.strictEqual(reqAJson.stale, true);
      mockMode = 'normal';

      // Unsaved edit discard guard preserves key when Keep Editing clicked
      await page.getByTestId('openai-api-key-input').fill(SYNTH_GOOD_KEY_2);
      await page.getByTestId('close-app-settings-btn').click();
      await pwExpect(page.getByTestId('app-settings-discard-confirm')).toBeVisible();
      await page.getByTestId('app-settings-keep-editing-btn').click();
      await pwExpect(page.getByTestId('openai-api-key-input')).toHaveValue(SYNTH_GOOD_KEY_2);
      await page.getByTestId('close-app-settings-btn').click();
      await page.getByTestId('app-settings-confirm-discard-btn').click();
      await pwExpect(switcherBtn).toContainText('OpenAI Worker Project');

      // Restart persistence: Verified (gpt-4.1-mini) + Saved survive server restart
      await stopAppServer();
      await startAppServer();
      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('openai-saved-badge')).toHaveText('Saved');
      await pwExpect(page.getByTestId('openai-verified-badge')).toContainText('Verified (gpt-4.1-mini)');

      // Cancel during hanging provider preserves Verified
      mockMode = 'hang';
      const receivedBeforeCancel = mockHangingReceivedCount;
      const abortedBeforeCancel = mockAbortedCount;
      await page.getByTestId('test-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-test-pending')).toBeVisible();
      for (let i = 0; i < 40 && mockHangingReceivedCount === receivedBeforeCancel; i++) {
        await page.waitForTimeout(50);
      }
      assert.ok(mockHangingReceivedCount > receivedBeforeCancel, 'Expected mock OpenAI server to receive hanging request');
      await page.getByTestId('cancel-openai-test-btn').click();
      await pwExpect(page.getByTestId('openai-inconclusive-banner')).toContainText('cancelled');
      await pwExpect(page.getByTestId('openai-verified-badge')).toContainText('Verified (gpt-4.1-mini)');
      for (let i = 0; i < 40 && mockAbortedCount === abortedBeforeCancel; i++) {
        await page.waitForTimeout(50);
      }
      assert.ok(mockAbortedCount > abortedBeforeCancel);

      // Clean up open mock responses and delete saved key -> Not Configured
      mockMode = 'normal';
      for (const r of openMockResponses) {
        try {
          r.destroy();
        } catch {}
      }
      await page.getByTestId('delete-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-saved-badge')).toHaveText('Not Configured');
      await page.getByTestId('close-app-settings-btn').click();

      // Loading and Status Unavailable states
      let releaseDelayed!: () => void;
      const delayedGate = new Promise<void>((r) => (releaseDelayed = r));
      await page.route('**/api/credentials/openai', async (route) => {
        await delayedGate;
        await route.continue();
      });
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('openai-saved-badge')).toContainText('Loading...');
      releaseDelayed();
      await pwExpect(page.getByTestId('openai-saved-badge')).toHaveText('Not Configured');
      await page.unroute('**/api/credentials/openai');
      await page.getByTestId('close-app-settings-btn').click();

      await page.route('**/api/credentials/openai', async (route) => {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'DB down' }) });
      });
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('openai-saved-badge')).toHaveText('Status Unavailable');
      await page.unroute('**/api/credentials/openai');
      await page.getByTestId('close-app-settings-btn').click();

      // Env precedence + 5s timeout inconclusive state
      await stopAppServer();
      await startAppServer({
        OPENAI_API_KEY: SYNTH_ENV_KEY,
        DUPOND_OPENAI_TEST_TIMEOUT_MS: '5000',
      });
      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('openai-saved-badge')).toHaveText('Env Active');
      await pwExpect(page.getByTestId('openai-env-precedence-notice')).toBeVisible();
      await page.getByTestId('test-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-verified-badge')).toContainText('Verified');

      mockMode = 'hang';
      await page.getByTestId('test-openai-key-btn').click();
      await pwExpect(page.getByTestId('openai-inconclusive-banner')).toContainText('timed out', { timeout: 10000 });
      await pwExpect(page.getByTestId('openai-verified-badge')).toContainText('Verified');
      mockMode = 'normal';
      for (const r of openMockResponses) {
        try {
          r.destroy();
        } catch {}
      }

      // Security invariants
      const domHtml = await page.locator('body').innerHTML();
      const storageDump = await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      );
      assertNoSecretLeak('DOM HTML', domHtml, ALL_DIAGNOSTIC_SECRETS);
      assertNoSecretLeak('browser storage', storageDump, ALL_OPENAI_SECRETS);
      assertNoSecretLeak('API responses', apiBodies.join('\n'), ALL_DIAGNOSTIC_SECRETS);
      assertNoSecretLeak('browser console logs', consoleLogs.join('\n'), ALL_DIAGNOSTIC_SECRETS);
      assertNoSecretLeak('server logs', serverLogs, ALL_DIAGNOSTIC_SECRETS);
    } finally {
      await context.close();
    }
  }, 180000);
});
