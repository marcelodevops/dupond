import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { expect as pwExpect } from 'playwright/test';
import { rotateConnectionKey } from '../../scripts/rotateConnKey.js';
import { connectionKeyMaintenancePaths } from '../../src/server/projects/connectionKeyLock.js';

const SYNTH_BAD_KEY = 'AIzaSyFakeInvalidKey000000000001';
const SYNTH_GOOD_KEY_1 = 'AIzaSyFakeValidKey1111111111112';
const SYNTH_GOOD_KEY_2 = 'AIzaSyFakeValidKey2222222222223';
const SYNTH_ENV_KEY = 'AIzaSyFakeEnvMasterKey999999999';
const SYNTH_OPERATOR_TOKEN = 'dp_e2e_synthetic_operator_token_12345';
const ALL_GEMINI_SECRETS = [SYNTH_BAD_KEY, SYNTH_GOOD_KEY_1, SYNTH_GOOD_KEY_2, SYNTH_ENV_KEY];
const ALL_DIAGNOSTIC_SECRETS = [...ALL_GEMINI_SECRETS, SYNTH_OPERATOR_TOKEN];

interface MockGeminiState {
  requests: Array<{ apiKey: string | undefined; path: string; body: string }>;
}

function assertNoSecretLeak(label: string, text: string, secrets: string[] = ALL_GEMINI_SECRETS): void {
  for (const secret of secrets) {
    assert.ok(
      !text.includes(secret),
      `Security violation: synthetic secret leaked in ${label}`,
    );
  }
}

function redactSecrets(text: string): string {
  let out = text;
  for (const secret of ALL_DIAGNOSTIC_SECRETS) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function assertNoSecretArtifactsOnDisk(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNoSecretArtifactsOnDisk(fullPath);
      continue;
    }
    assert.ok(
      !/\.(zip|har|webm)$/i.test(entry.name),
      `Security violation: secret-bearing diagnostic archive retained on disk (${fullPath})`,
    );
    const content = fs.readFileSync(fullPath).toString('latin1');
    assertNoSecretLeak(`diagnostic artifact ${fullPath}`, content, ALL_DIAGNOSTIC_SECRETS);
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

async function waitForHealthy(
  baseUrl: string,
  proc: ChildProcess,
  getLogs: () => string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `App server exited before becoming healthy (code=${proc.exitCode}, signal=${proc.signalCode}):\n${getLogs()}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // Retry until ready
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health\n${getLogs()}`);
}

async function waitForPortClosed(baseUrl: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Previous app server still listening on ${baseUrl} after stop`);
}

describe('Gemini credential onboarding browser E2E (scenarios A-L)', () => {
  let tmpDir: string;
  let dbPath: string;
  let statePath: string;
  let keyPath: string;
  let serverPort: number;
  let serverUrl: string;
  let mockGeminiPort: number;
  let mockGeminiServer: http.Server;
  let mockState: MockGeminiState;
  let serverProc: ChildProcess | null = null;
  let serverLogs = '';
  let browser: Browser;

  async function startAppServer(extraEnv: Record<string, string | undefined> = {}): Promise<void> {
    if (serverProc) {
      await stopAppServer();
    }
    serverLogs = '';
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(serverPort),
      DUPOND_BIND_HOST: '127.0.0.1',
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
      DUPOND_CONN_KEY_PATH: keyPath,
      DUPOND_ALLOW_TEST_GEMINI_ENDPOINT: '1',
      DUPOND_GEMINI_TEST_BASE_URL: `http://127.0.0.1:${mockGeminiPort}`,
      DUPOND_AUTH_TOKEN: SYNTH_OPERATOR_TOKEN,
      NODE_ENV: 'production',
    };
    delete env.GEMINI_API_KEY;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }

    const tsxBin = path.resolve(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
    );
    const proc = spawn(tsxBin, ['server.ts'], {
      cwd: process.cwd(),
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc = proc;
    proc.stdout?.on('data', (chunk) => {
      serverLogs += chunk.toString('utf-8');
    });
    proc.stderr?.on('data', (chunk) => {
      serverLogs += chunk.toString('utf-8');
    });

    await waitForHealthy(serverUrl, proc, () => serverLogs);
  }

  async function stopAppServer(): Promise<void> {
    if (!serverProc) return;
    const proc = serverProc;
    serverProc = null;
    const killTarget = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && proc.pid) {
          process.kill(-proc.pid, sig);
        } else {
          proc.kill(sig);
        }
      } catch {
        // ignore if already exited
      }
    };
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      proc.once('exit', () => resolve());
      killTarget('SIGTERM');
      setTimeout(() => {
        killTarget('SIGKILL');
        resolve();
      }, 3000);
    });
    await waitForPortClosed(serverUrl);
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-e2e-gemini-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    statePath = path.join(tmpDir, 'state.json');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

    mockState = { requests: [] };
    mockGeminiServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        const apiKey = typeof req.headers['x-goog-api-key'] === 'string'
          ? req.headers['x-goog-api-key']
          : undefined;
        mockState.requests.push({ apiKey, path: req.url || '/', body });

        if (!apiKey || apiKey === SYNTH_BAD_KEY) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 401,
                message: `API key not valid: ${apiKey || 'missing'}`,
                status: 'UNAUTHENTICATED',
              },
            }),
          );
          return;
        }

        const isPlanParse = body.includes('plan') || body.includes('epics');
        const textPayload = isPlanParse
          ? JSON.stringify({
              summary: 'Controlled E2E Decomposed Plan',
              suggestedTimelineWeeks: 2,
              epics: [
                { id: 'EPIC-E2E', title: 'Gemini Onboarding E2E', description: 'E2E epic', color: '#6366F1' },
              ],
              tasks: [
                {
                  id: 't-e2e-101',
                  key: 'E2E-101',
                  title: 'Verify credential onboarding flow',
                  description: 'Created from controlled mock Gemini breakdown',
                  status: 'backlog',
                  priority: 'high',
                  epicId: 'EPIC-E2E',
                  estimatedHours: 4,
                  dependencies: [],
                  tags: ['e2e'],
                  acceptanceCriteria: ['Flow works end-to-end'],
                },
              ],
            })
          : 'OK';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: textPayload }], role: 'model' } }],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => mockGeminiServer.listen(0, '127.0.0.1', resolve));
    mockGeminiPort = (mockGeminiServer.address() as { port: number }).port;
    serverPort = await getFreePort();
    serverUrl = `http://127.0.0.1:${serverPort}`;

    await startAppServer();
    browser = await chromium.launch({ headless: true });
  }, 45000);

  afterAll(async () => {
    if (browser) await browser.close();
    await stopAppServer();
    if (mockGeminiServer) await new Promise<void>((resolve) => mockGeminiServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exercises scenarios A-L end-to-end in Chromium without secret leaks', async () => {
    const outDir = path.join(process.cwd(), 'test-results', 'e2e');
    // Capture policy: do NOT enable Playwright tracing/HAR/video during secret-bearing
    // credential or operator-token flows, because action arguments and snapshots retain raw inputs.
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();

    const apiBodies: string[] = [];
    const readinessResponses: Array<{ url: string; status: number; body: string }> = [];
    const consoleLogs: string[] = [];
    page.on('console', (msg) => consoleLogs.push(msg.text()));
    page.on('response', async (res) => {
      if (res.url().includes('/api/')) {
        try {
          const text = await res.text();
          apiBodies.push(text);
          if (res.url().includes('/api/planning/readiness') || res.url().includes('/api/credentials/gemini')) {
            readinessResponses.push({
              url: res.url(),
              status: res.status(),
              body: redactSecrets(text),
            });
          }
        } catch {
          // ignore streaming/empty
        }
      }
    });

    try {
      // --- Scenario A: Initial unconfigured state (and verify auth gate blocks unauthenticated API calls) ---
      const unauthCredRes = await page.request.get(`${serverUrl}/api/credentials/gemini`);
      assert.strictEqual(unauthCredRes.status(), 401);

      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      const operatorInput = page.getByPlaceholder('Operator token');
      await operatorInput.waitFor({ state: 'visible' });
      await operatorInput.fill(SYNTH_OPERATOR_TOKEN);
      await operatorInput.press('Enter');
      await operatorInput.waitFor({ state: 'hidden' });

      await page.getByRole('button', { name: /Ingest Plan/i }).click();
      await page.getByTestId('configure-gemini-btn').waitFor({ state: 'visible' });
      const decomposeBtn = page.getByRole('button', { name: /Decompose & Orchestrate Plan with AI/i });
      assert.strictEqual(await decomposeBtn.isDisabled(), true);

      // --- Scenario B: Enter custom plan text -> Configure Gemini -> close preserves text ---
      const customPlan = '# Custom Onboarding Plan\n1. Configure encrypted Gemini key\n2. Decompose plan';
      const textarea = page.locator('textarea');
      await textarea.fill(customPlan);
      await page.getByTestId('configure-gemini-btn').click();
      await page.getByTestId('gemini-credential-section').waitFor({ state: 'visible' });
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Not Configured');

      // --- Scenario C: Blank rejection & invalid key test failure ---
      await page.getByTestId('gemini-api-key-input').fill('   ');
      await page.getByTestId('save-gemini-key-btn').click();
      await page.getByTestId('gemini-error-banner').waitFor({ state: 'visible' });

      await page.getByTestId('gemini-api-key-input').fill(SYNTH_BAD_KEY);
      await page.getByTestId('save-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Saved');
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Unverified');

      await page.getByTestId('test-gemini-key-btn').click();
      await page.getByTestId('gemini-error-banner').waitFor({ state: 'visible' });
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Verification Failed');
      assertNoSecretLeak('DOM error banner after invalid key test', await page.locator('body').innerHTML());

      // --- Scenario D: Save valid key -> Test Connection -> return & verify plan text preserved ---
      await page.getByTestId('gemini-api-key-input').fill(SYNTH_GOOD_KEY_1);
      await page.getByTestId('save-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Unverified');

      await page.getByTestId('test-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Verified');

      // Close settings -> back on Plan Ingestion; plan text preserved; no auto-ingest happened
      await page.getByTestId('close-app-settings-btn').click();
      assert.strictEqual(await textarea.inputValue(), customPlan);
      assert.strictEqual(await decomposeBtn.isEnabled(), true);

      // --- Scenario E: Explicit retry/decompose & adopt plan ---
      const reqCountBeforeDecompose = mockState.requests.length;
      await decomposeBtn.click();
      await page.getByRole('button', { name: /Adopt Plan to Kanban Board/i }).waitFor({ state: 'visible' });
      assert.strictEqual(mockState.requests.length, reqCountBeforeDecompose + 1);
      assert.strictEqual(mockState.requests[mockState.requests.length - 1].apiKey, SYNTH_GOOD_KEY_1);

      await page.getByRole('button', { name: /Adopt Plan to Kanban Board/i }).click();
      await page.getByText('Verify credential onboarding flow').waitFor({ state: 'visible' });

      // --- Scenario F: Reload & server restart persistence ---
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('Verify credential onboarding flow').waitFor({ state: 'visible' });

      await stopAppServer();
      await startAppServer();
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Saved');
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Verified');

      // --- Scenario G: Replace saved key -> clears verification & invalidates client cache ---
      await page.getByTestId('gemini-api-key-input').fill(SYNTH_GOOD_KEY_2);
      await page.getByTestId('save-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Unverified');

      await page.getByTestId('test-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      assert.strictEqual(mockState.requests[mockState.requests.length - 1].apiKey, SYNTH_GOOD_KEY_2);

      // --- Scenario K: Key rotation maintenance lock blocks saves/tests, then rotation succeeds ---
      const { lockPath } = connectionKeyMaintenancePaths(keyPath);
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      try {
        await page.getByTestId('test-gemini-key-btn').click();
        await page.getByTestId('gemini-error-banner').waitFor({ state: 'visible' });
        const errText = await page.getByTestId('gemini-error-banner').textContent();
        assert.ok(errText && errText.toLowerCase().includes('maintenance'));
      } finally {
        fs.unlinkSync(lockPath);
      }

      // Perform real rotation while server is stopped, then restart and verify key still works
      await stopAppServer();
      const rotRes = rotateConnectionKey({ keyPath, dbPath });
      assert.strictEqual(rotRes.status, 'rotated');
      await startAppServer();

      await page.reload({ waitUntil: 'networkidle' });
      await page.getByTestId('open-app-settings-btn').click();
      await page.getByTestId('test-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });

      // --- Scenario J: Second project shares application-scoped saved key ---
      const secondProjRes = await page.request.post(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${SYNTH_OPERATOR_TOKEN}` },
        data: { name: 'Secondary E2E Project' },
      });
      assert.strictEqual(secondProjRes.status(), 201);
      const secondProj = await secondProjRes.json();
      const readinessSecond = await page.request.get(`${serverUrl}/api/planning/readiness`, {
        headers: {
          Authorization: `Bearer ${SYNTH_OPERATOR_TOKEN}`,
          'x-dupond-project-id': secondProj.id,
        },
      });
      const readinessSecondJson = await readinessSecond.json();
      assert.strictEqual(readinessSecondJson.ready, true);
      assert.strictEqual(readinessSecondJson.source, 'saved');

      // --- Scenario H: Remove saved key returns UI to Not Configured ---
      await page.getByTestId('delete-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Not Configured');
      await page.getByTestId('close-app-settings-btn').click();
      await page.getByRole('button', { name: /Ingest Plan/i }).click();
      await page.getByTestId('configure-gemini-btn').waitFor({ state: 'visible' });

      // --- Scenario I: Environment GEMINI_API_KEY takes precedence over saved key ---
      await stopAppServer();
      await startAppServer({ GEMINI_API_KEY: SYNTH_ENV_KEY });
      await page.reload({ waitUntil: 'networkidle' });

      // Test delayed readiness response: UI must show Loading..., NEVER Not Configured, before settling on Env Active
      let releaseDelayedCred!: () => void;
      const delayedCredGate = new Promise<void>((resolve) => {
        releaseDelayedCred = resolve;
      });
      let markRouteHandled!: () => void;
      const routeHandled = new Promise<void>((resolve) => {
        markRouteHandled = resolve;
      });
      const delayedRouteHandler = async (route: any) => {
        await delayedCredGate;
        await route.continue().catch(() => {});
        markRouteHandled();
      };
      await page.route('**/api/credentials/gemini', delayedRouteHandler);

      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Loading...');
      releaseDelayedCred();
      await routeHandled;
      await page.unroute('**/api/credentials/gemini', delayedRouteHandler);

      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Env Active');
      await pwExpect(page.getByTestId('gemini-env-precedence-notice')).toBeVisible();

      // Reopen Settings modal and verify Env Active persists cleanly
      await page.getByTestId('close-app-settings-btn').click();
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Env Active');

      // Saving a key in UI while env key is set does NOT override env key
      await page.getByTestId('gemini-api-key-input').fill(SYNTH_GOOD_KEY_1);
      await page.getByTestId('save-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      await page.getByTestId('test-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      assert.strictEqual(mockState.requests[mockState.requests.length - 1].apiKey, SYNTH_ENV_KEY);

      // Test failed readiness response: UI must show explicit error, NEVER Not Configured
      await page.getByTestId('close-app-settings-btn').click();
      await page.route('**/api/credentials/gemini', async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Injected readiness failure', code: 'INTERNAL' }),
        });
      });
      await page.getByTestId('open-app-settings-btn').click();
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Status Unavailable');
      await pwExpect(page.getByTestId('gemini-error-banner')).toBeVisible();
      await page.unroute('**/api/credentials/gemini');

      // --- Scenario L: Security invariants across DOM, storage, API responses, console, server logs ---
      const domHtml = await page.locator('body').innerHTML();
      const storageDump = await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      );
      assertNoSecretLeak('DOM HTML', domHtml, ALL_DIAGNOSTIC_SECRETS);
      assertNoSecretLeak('browser storage', storageDump, ALL_GEMINI_SECRETS);
      assertNoSecretLeak('API responses', apiBodies.join('\n'), ALL_DIAGNOSTIC_SECRETS);
      assertNoSecretLeak('browser console logs', consoleLogs.join('\n'), ALL_DIAGNOSTIC_SECRETS);
      assertNoSecretLeak('server stdout/stderr logs', serverLogs, ALL_DIAGNOSTIC_SECRETS);
      assertNoSecretArtifactsOnDisk(outDir);
    } catch (err: any) {
      fs.mkdirSync(outDir, { recursive: true });
      const sanitizedReport = redactSecrets(
        [
          `Failure: ${err?.stack || err?.message || String(err)}`,
          `URL: ${page.url()}`,
          `Readiness Responses: ${JSON.stringify(readinessResponses.slice(-5))}`,
          `Console: ${consoleLogs.join('\n')}`,
          `Server Logs: ${serverLogs}`,
        ].join('\n\n'),
      );
      fs.writeFileSync(path.join(outDir, 'gemini-onboarding-failure.txt'), sanitizedReport, 'utf-8');
      assertNoSecretArtifactsOnDisk(outDir);
      throw err;
    } finally {
      await context.close();
    }
  }, 120000);
});
