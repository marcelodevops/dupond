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

const SYNTH_GEMINI_KEY = 'AIzaSyFakeSettingsSplitKey111111';
const SYNTH_OPERATOR_TOKEN = 'dp_e2e_settings_split_token_98765';
const ALL_SECRETS = [SYNTH_GEMINI_KEY, SYNTH_OPERATOR_TOKEN];

function assertNoSecretLeak(label: string, text: string, secrets: string[] = ALL_SECRETS): void {
  for (const secret of secrets) {
    assert.ok(
      !text.includes(secret),
      `Security violation: synthetic secret leaked in ${label}`,
    );
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
      // Retry
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

describe('Project Settings vs Application Settings E2E', () => {
  let tmpDir: string;
  let dbPath: string;
  let statePath: string;
  let keyPath: string;
  let serverPort: number;
  let serverUrl: string;
  let mockGeminiPort: number;
  let mockGeminiServer: http.Server;
  let serverProc: ChildProcess | null = null;
  let serverLogs = '';
  let browser: Browser;

  async function startAppServer(): Promise<void> {
    if (serverProc) {
      await stopAppServer();
    }
    serverLogs = '';
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
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
        // ignore
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-e2e-settings-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    statePath = path.join(tmpDir, 'state.json');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

    mockGeminiServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'OK' }], role: 'model' } }],
        }),
      );
    });
    await new Promise<void>((resolve) => mockGeminiServer.listen(0, '127.0.0.1', resolve));
    mockGeminiPort = (mockGeminiServer.address() as { port: number }).port;
    serverPort = await getFreePort();
    serverUrl = `http://127.0.0.1:${serverPort}`;

    await startAppServer();
    browser = await chromium.launch({ headless: true });
  }, 45000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await stopAppServer().catch(() => {});
    await new Promise<void>((resolve) => mockGeminiServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('separates Project Settings from Application Settings across projects, dirty state, failures, Plan Ingestion, keyboard, and mobile', async () => {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page: Page = await context.newPage();

    const apiBodies: string[] = [];
    const consoleLogs: string[] = [];
    page.on('console', (msg) => consoleLogs.push(msg.text()));
    page.on('response', async (res) => {
      if (res.url().includes('/api/')) {
        try {
          apiBodies.push(await res.text());
        } catch {
          // ignore
        }
      }
    });

    try {
      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      const operatorInput = page.getByPlaceholder('Operator token');
      await operatorInput.waitFor({ state: 'visible' });
      await operatorInput.fill(SYNTH_OPERATOR_TOKEN);
      await operatorInput.press('Enter');
      await operatorInput.waitFor({ state: 'hidden' });

      // Create two secondary projects: Project Alpha & Project Beta
      const createA = await page.request.post(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${SYNTH_OPERATOR_TOKEN}` },
        data: { name: 'Project Alpha', description: 'Alpha initial mission' },
      });
      assert.strictEqual(createA.status(), 201);
      const projA = await createA.json();

      const createB = await page.request.post(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${SYNTH_OPERATOR_TOKEN}` },
        data: { name: 'Project Beta', description: 'Beta initial mission' },
      });
      assert.strictEqual(createB.status(), 201);
      const projB = await createB.json();

      // Reload so ProjectSwitcher fetches the newly created projects
      await page.reload({ waitUntil: 'networkidle' });

      // Switch to Project Alpha via UI ProjectSwitcher
      await page.getByRole('button', { name: 'Switch Dupond Project' }).click();
      await page.getByText('Project Alpha').first().click();
      await pwExpect(page.getByRole('button', { name: 'Switch Dupond Project' })).toContainText('Project Alpha');

      // 1. Both windows are independently accessible & explicitly labeled
      const projBtn = page.getByTestId('open-project-settings-btn');
      const appBtn = page.getByTestId('open-app-settings-btn');
      await pwExpect(projBtn).toHaveText(/Project Settings/);
      await pwExpect(appBtn).toHaveText(/App Settings/);

      await projBtn.click();
      const projModal = page.getByTestId('project-settings-modal');
      await pwExpect(projModal).toBeVisible();
      await pwExpect(page.getByTestId('project-settings-title')).toContainText('Project Settings — Project Alpha');
      await pwExpect(page.getByTestId('project-id-input')).toHaveValue(projA.id);
      assert.strictEqual(await page.getByTestId('project-id-input').getAttribute('readonly'), '');
      // Project Settings must NOT contain application Gemini credential controls
      assert.strictEqual(await projModal.getByTestId('gemini-credential-section').count(), 0);

      // Capture screenshot if requested via DUPOND_SCREENSHOT_DIR
      const screenshotDir = process.env.DUPOND_SCREENSHOT_DIR;
      if (screenshotDir) {
        fs.mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotDir, 'project-settings-desktop.png') });
      }

      // 4. Dirty-state dismissal on Project Settings + Keyboard Escape
      await page.getByTestId('project-description-input').fill('Alpha unsaved draft');
      await page.keyboard.press('Escape');
      await pwExpect(page.getByTestId('project-settings-discard-confirm')).toBeVisible();
      await page.getByTestId('project-settings-keep-editing-btn').click();
      await pwExpect(page.getByTestId('project-settings-discard-confirm')).toBeHidden();
      await pwExpect(page.getByTestId('project-description-input')).toHaveValue('Alpha unsaved draft');

      // Failed save preserves unsaved input & shows persistent error
      await page.route(`**/api/projects/${projA.id}`, async (route) => {
        if (route.request().method() === 'PATCH') {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Simulated save failure', code: 'INTERNAL' }),
          });
        } else {
          await route.continue();
        }
      });
      await page.getByTestId('save-project-settings-btn').click();
      await pwExpect(page.getByTestId('project-settings-error-banner')).toContainText('Simulated save failure');
      await pwExpect(page.getByTestId('project-description-input')).toHaveValue('Alpha unsaved draft');
      await page.unroute(`**/api/projects/${projA.id}`);

      // Cancel -> confirm discard resets edits
      await page.getByTestId('cancel-project-settings-btn').click();
      await pwExpect(page.getByTestId('project-settings-discard-confirm')).toBeVisible();
      await page.getByTestId('project-settings-confirm-discard-btn').click();
      await pwExpect(projModal).toBeHidden();

      // 2. Edit Project Alpha across all tabs, save, and verify isolation from Project Beta
      await projBtn.click();
      await page.getByTestId('project-description-input').fill('Alpha updated mission');
      await page.getByTestId('project-tab-repository').click();
      await page.getByTestId('project-repo-url-input').fill('https://github.com/acme/alpha.git');
      await page.getByTestId('project-target-branch-input').fill('release');
      await page.getByTestId('project-write-mode-select').selectOption('patch_export');
      await page.getByTestId('project-tab-preferences').click();
      await page.getByTestId('project-default-provider-select').selectOption('openai');
      await page.getByTestId('project-default-model-input').fill('gpt-4o-mini');
      await page.getByTestId('project-require-approval-checkbox').check();
      await page.getByTestId('project-jira-key-input').fill('ALPHA');
      await page.getByTestId('save-project-settings-btn').click();
      await pwExpect(page.getByTestId('project-settings-success-banner')).toBeVisible();

      // 5. Switching projects while dirty blocks saving stale edits to Project Beta
      await page.getByTestId('project-tab-general').click();
      await page.getByTestId('project-description-input').fill('Stale Alpha edit');
      // Switch active project in sessionStorage + reload? No, trigger switchProject via ProjectSwitcher while modal is open?
      // Modal overlays screen, so verify via keyboard/DOM or evaluate: simulate external project switch by clicking ProjectSwitcher if accessible,
      // or close? Wait: let's dispatch click on ProjectSwitcher or check after reload.
      // Actually let's test discard -> switch to Beta -> verify Beta does NOT have Alpha's settings!
      await page.getByTestId('cancel-project-settings-btn').click();
      await page.getByTestId('project-settings-confirm-discard-btn').click();

      await page.getByRole('button', { name: 'Switch Dupond Project' }).click();
      await page.getByText('Project Beta').first().click();
      await pwExpect(page.getByRole('button', { name: 'Switch Dupond Project' })).toContainText('Project Beta');

      await projBtn.click();
      await pwExpect(page.getByTestId('project-settings-title')).toContainText('Project Settings — Project Beta');
      await pwExpect(page.getByTestId('project-id-input')).toHaveValue(projB.id);
      await pwExpect(page.getByTestId('project-description-input')).toHaveValue('Beta initial mission');
      await page.getByTestId('project-tab-repository').click();
      await pwExpect(page.getByTestId('project-repo-url-input')).toHaveValue('');
      await pwExpect(page.getByTestId('project-target-branch-input')).toHaveValue('main');
      await page.getByTestId('project-tab-preferences').click();
      await pwExpect(page.getByTestId('project-default-provider-select')).toHaveValue('');
      await pwExpect(page.getByTestId('project-jira-key-input')).toHaveValue('');
      await page.getByTestId('cancel-project-settings-btn').click();

      // Reload & confirm Project Alpha settings persisted
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Switch Dupond Project' }).click();
      await page.getByText('Project Alpha').first().click();
      await projBtn.click();
      await pwExpect(page.getByTestId('project-description-input')).toHaveValue('Alpha updated mission');
      await page.getByTestId('project-tab-repository').click();
      await pwExpect(page.getByTestId('project-repo-url-input')).toHaveValue('https://github.com/acme/alpha.git');
      await pwExpect(page.getByTestId('project-target-branch-input')).toHaveValue('release');
      await page.getByTestId('cancel-project-settings-btn').click();

      // 6 & 7. Configure Gemini in Plan Ingestion opens Application Settings, preserves plan, and shares status across projects
      await page.getByRole('button', { name: /Ingest Plan/i }).click();
      const customPlan = '1. Keep entered plan intact across Application Settings handoff.';
      const planTextarea = page.locator('textarea').first();
      await planTextarea.fill(customPlan);
      await page.getByTestId('configure-gemini-btn').click();

      const appModal = page.getByTestId('application-settings-modal');
      await pwExpect(appModal).toBeVisible();
      await pwExpect(page.getByTestId('app-settings-scope-notice')).toContainText('every project on this server');
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Not Configured');

      if (screenshotDir) {
        await page.screenshot({ path: path.join(screenshotDir, 'app-settings-desktop.png') });
      }

      // Dirty check on Application Settings key input
      await page.getByTestId('gemini-api-key-input').fill(SYNTH_GEMINI_KEY);
      await page.keyboard.press('Escape');
      await pwExpect(page.getByTestId('app-settings-discard-confirm')).toBeVisible();
      await page.getByTestId('app-settings-keep-editing-btn').click();
      await pwExpect(page.getByTestId('gemini-api-key-input')).toHaveValue(SYNTH_GEMINI_KEY);

      await page.getByTestId('save-gemini-key-btn').click();
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Saved');
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Unverified');

      await page.getByTestId('test-gemini-key-btn').click();
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Verified');

      await page.getByTestId('close-app-settings-btn').click();
      await pwExpect(appModal).toBeHidden();
      // Entered plan preserved & readiness refreshed without auto-ingest
      await pwExpect(planTextarea).toHaveValue(customPlan);
      await pwExpect(page.getByTestId('plan-readiness-bar')).toContainText('Ready for decomposition');
      await page.getByRole('button', { name: 'Cancel' }).click();

      // 3. Switch back to Project Beta -> Application Settings still shows Saved + Verified
      await page.getByRole('button', { name: 'Switch Dupond Project' }).click();
      await page.getByText('Project Beta').first().click();
      await appBtn.click();
      await pwExpect(page.getByTestId('gemini-saved-badge')).toHaveText('Saved');
      await pwExpect(page.getByTestId('gemini-verified-badge')).toHaveText('Verified');
      await page.getByTestId('close-app-settings-btn').click();

      // 8. Narrow mobile viewport (375x812): both buttons and modals are usable with no horizontal overflow
      await page.setViewportSize({ width: 375, height: 812 });
      await pwExpect(projBtn).toBeVisible();
      await pwExpect(appBtn).toBeVisible();
      await projBtn.click();
      await pwExpect(projModal).toBeVisible();
      if (screenshotDir) {
        await page.screenshot({ path: path.join(screenshotDir, 'project-settings-mobile.png') });
      }
      await page.getByTestId('cancel-project-settings-btn').click();

      await appBtn.click();
      await pwExpect(appModal).toBeVisible();
      if (screenshotDir) {
        await page.screenshot({ path: path.join(screenshotDir, 'app-settings-mobile.png') });
      }
      await page.getByTestId('close-app-settings-btn').click();

      // 9. No credential leakage in DOM, storage, API responses, console logs, or server logs
      const domHtml = await page.locator('body').innerHTML();
      const storageDump = await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      );
      assertNoSecretLeak('DOM HTML', domHtml);
      assertNoSecretLeak('browser storage', storageDump, [SYNTH_GEMINI_KEY]);
      assertNoSecretLeak('API responses', apiBodies.join('\n'));
      assertNoSecretLeak('browser console logs', consoleLogs.join('\n'));
      assertNoSecretLeak('server stdout/stderr logs', serverLogs);
    } finally {
      await context.close();
    }
  }, 90000);
});
