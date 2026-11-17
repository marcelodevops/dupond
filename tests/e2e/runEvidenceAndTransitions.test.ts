import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { expect as pwExpect } from 'playwright/test';

const SYNTH_AUTH_TOKEN = 'e2e_run_evidence_auth_token_01';
const SYNTH_GEMINI_KEY = 'AIzaSyE2ERunEvidenceSynthetic001';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

async function waitForHealthy(baseUrl: string, proc: ChildProcess, getLogs: () => string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Server exited early:\n${getLogs()}`);
    }
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for server health:\n${getLogs()}`);
}

describe('Authoritative task transitions & read-only run evidence browser E2E (scenarios A-I)', () => {
  let tmpDir: string;
  let dbPath: string;
  let statePath: string;
  let keyPath: string;
  let targetRepoDir: string;
  let remoteDir: string;
  let serverPort: number;
  let serverUrl: string;
  let mockGeminiPort: number;
  let mockGeminiServer: http.Server;
  let mockWorkerMode: 'pass' | 'fail' = 'pass';
  let lastWorkerPrompt = '';
  let serverProc: ChildProcess | null = null;
  let serverLogs = '';
  let browser: Browser;

  async function startAppServer(): Promise<void> {
    if (serverProc) await stopAppServer();
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
      DUPOND_AUTH_TOKEN: SYNTH_AUTH_TOKEN,
      DUPOND_APPROVAL_TOKEN: 'e2e_approval_token_01',
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
      DUPOND_CONN_KEY_PATH: keyPath,
      DUPOND_ALLOW_TEST_GEMINI_ENDPOINT: '1',
      DUPOND_GEMINI_TEST_BASE_URL: `http://127.0.0.1:${mockGeminiPort}`,
    };
    delete env.GEMINI_API_KEY;
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-e2e-run-ev-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    statePath = path.join(tmpDir, 'state.json');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    remoteDir = path.join(tmpDir, 'remote.git');
    targetRepoDir = path.join(tmpDir, 'synthetic-service');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

    fs.mkdirSync(remoteDir, { recursive: true });
    execFileSync('git', ['init', '--bare', remoteDir]);

    fs.mkdirSync(path.join(targetRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(targetRepoDir, 'package.json'),
      JSON.stringify({ name: 'synthetic-service', version: '1.0.0', type: 'module', scripts: { test: 'node --test src/quote.test.mjs' } }, null, 2),
    );
    fs.writeFileSync(path.join(targetRepoDir, 'src/quote.mjs'), 'export const valid = true;\n');
    fs.writeFileSync(
      path.join(targetRepoDir, 'src/quote.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { valid } from './quote.mjs';\ntest('ok', () => assert.equal(valid, true));\n",
    );
    execFileSync('git', ['init', '-b', 'main'], { cwd: targetRepoDir });
    execFileSync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: targetRepoDir });
    execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: targetRepoDir });
    execFileSync('git', ['add', '.'], { cwd: targetRepoDir });
    execFileSync('git', ['commit', '-m', 'chore: init synthetic service'], { cwd: targetRepoDir });
    execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: targetRepoDir });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: targetRepoDir });

    mockGeminiServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c.toString('utf-8')));
      req.on('end', () => {
        const isPlan = body.includes('suggestedTimelineWeeks') || body.includes('epics');
        if (isPlan) {
          const textPayload = JSON.stringify({
            summary: 'Synthetic Naviera Plan',
            suggestedTimelineWeeks: 1,
            epics: [{ id: 'EPIC-NAV', title: 'Quote API', description: 'Quote API', color: '#6366F1' }],
            tasks: [
              {
                id: 't-nav-101',
                key: 'NAV-101',
                title: 'Add validated quote-request endpoint',
                description: 'Implement validated quote-request handler.',
                status: 'todo',
                epicId: 'EPIC-NAV',
                assignedAgentId: 'agent-dev',
                priority: 'high',
                estimatedHours: 4,
                dependencies: [],
                subtasks: [{ id: 'NAV-101-1', title: 'Validate quote', completed: false, checkCommand: 'node --test src/quote.test.mjs' }],
                acceptanceCriteria: [{ id: 'NAV-101-AC1', title: 'node test passes', completed: false, checkCommand: 'node --test src/quote.test.mjs' }],
              },
              {
                id: 't-nav-102',
                key: 'NAV-102',
                title: 'Failing task for error inspection',
                description: 'Task that fails verification.',
                status: 'todo',
                epicId: 'EPIC-NAV',
                assignedAgentId: 'agent-dev',
                priority: 'medium',
                estimatedHours: 2,
                dependencies: [],
                subtasks: [{ id: 'NAV-102-1', title: 'Fails check', completed: false, checkCommand: 'node --test src/quote.test.mjs' }],
                acceptanceCriteria: [{ id: 'NAV-102-AC1', title: 'node test passes', completed: false, checkCommand: 'node --test src/quote.test.mjs' }],
              },
            ],
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: textPayload }], role: 'model' } }] }));
          return;
        }

        // Coding worker turn 1: emit write_file tool calls; turn 2 (after functionResponse): emit final text
        if (!body.includes('functionResponse')) {
          lastWorkerPrompt = body;
          const parts =
            mockWorkerMode === 'fail'
              ? [
                  {
                    functionCall: {
                      name: 'write_file',
                      args: { filePath: 'src/quote.mjs', content: 'export const valid = false;\n' },
                    },
                  },
                ]
              : [
                  {
                    functionCall: {
                      name: 'write_file',
                      args: {
                        filePath: 'src/quote.mjs',
                        content: 'export const valid = true;\nexport const quoteEndpointReady = true;\n',
                      },
                    },
                  },
                  {
                    functionCall: {
                      name: 'write_file',
                      args: {
                        filePath: 'src/addedQuoteStore.mjs',
                        content: 'export const persistedQuotes = [];\n',
                      },
                    },
                  },
                ];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ candidates: [{ content: { parts, role: 'model' } }] }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Completed implementation.' }], role: 'model' } }] }));
      });
    });

    await new Promise<void>((r) => mockGeminiServer.listen(0, '127.0.0.1', r));
    mockGeminiPort = (mockGeminiServer.address() as { port: number }).port;
    serverPort = await getFreePort();
    serverUrl = `http://127.0.0.1:${serverPort}`;

    await startAppServer();
    browser = await chromium.launch({ headless: true });
  }, 45000);

  afterAll(async () => {
    if (browser) await browser.close();
    await stopAppServer();
    if (mockGeminiServer) mockGeminiServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exercises authoritative transitions, read-only run/evidence inspection, failure states, restart, switch races, keyboard, and mobile', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_AUTH_TOKEN);

    const page = await context.newPage();
    const apiUrls: string[] = [];
    const stateMutationFailures: number[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/')) {
        apiUrls.push(`${req.method()} ${new URL(req.url()).pathname}`);
      }
    });
    page.on('response', (res) => {
      if (res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/orchestrate/state' && res.status() >= 400) {
        stateMutationFailures.push(res.status());
      }
    });

    try {
      await page.goto(serverUrl, { waitUntil: 'networkidle' });

      // A. Create non-default project "Naviera" and a second project "Secondary" for switch-race test
      const createSecondary = await page.request.post(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}` },
        data: { name: 'Secondary', description: 'Secondary isolation project' },
      });
      assert.strictEqual(createSecondary.status(), 201);
      const secondaryProjectId = ((await createSecondary.json()) as { id: string }).id;

      const createNaviera = await page.request.post(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}` },
        data: { name: 'Naviera', description: 'Naviera logistics project' },
      });
      assert.strictEqual(createNaviera.status(), 201);

      await page.reload({ waitUntil: 'networkidle' });
      const switcherBtn = page.getByRole('button', { name: 'Switch Dupond Project' });
      await switcherBtn.click();
      await page.getByRole('button', { name: /Naviera/i }).click();
      await pwExpect(switcherBtn).toContainText('Naviera');

      // Configure Naviera repo + Gemini key
      await page.getByTestId('open-project-settings-btn').click();
      await page.getByTestId('project-tab-repository').click();
      await page.getByTestId('project-local-path-input').fill(targetRepoDir);
      await page.getByTestId('project-target-branch-input').fill('main');
      await page.getByTestId('project-repo-url-input').fill(remoteDir);
      await page.getByTestId('verify-repo-btn').click();
      await page.getByTestId('repo-verification-result').waitFor({ state: 'visible' });
      await page.getByTestId('save-project-settings-btn').click();
      await pwExpect(page.getByTestId('save-project-settings-btn')).toBeDisabled();
      await page.getByTestId('cancel-project-settings-btn').click();
      await page.getByTestId('project-settings-modal').waitFor({ state: 'hidden' });

      await page.getByTestId('open-app-settings-btn').click();
      await page.getByTestId('gemini-api-key-input').fill(SYNTH_GEMINI_KEY);
      await page.getByTestId('save-gemini-key-btn').click();
      await page.getByTestId('gemini-success-banner').waitFor({ state: 'visible' });
      await page.getByTestId('close-app-settings-btn').click();

      // Adopt synthetic Naviera plan
      await page.getByRole('button', { name: /Ingest Plan/i }).click();
      await page.locator('textarea').first().fill('Add a validated quote-request endpoint.');
      await page.getByRole('button', { name: /Decompose & Orchestrate Plan with AI/i }).click();
      await page.getByRole('button', { name: /Adopt Plan to Kanban Board/i }).waitFor({ state: 'visible', timeout: 15000 });
      await page.getByRole('button', { name: /Adopt Plan to Kanban Board/i }).click();
      await page.getByText('NAV-101').first().waitFor({ state: 'visible' });

      // H (part 1): Before execution, TaskDetailModal shows explicit no-runs state
      await page.getByText('NAV-101').first().click();
      await pwExpect(page.getByTestId('task-no-runs-state')).toBeVisible();

      // B & C: Execute manually and inspect recorded run, attempts, diff, commands, and verification
      mockWorkerMode = 'pass';
      const specialistSelect = page.getByTestId('task-detail-modal').locator('select').nth(2);
      await specialistSelect.selectOption({ index: 1 });
      await page.getByRole('button', { name: /Execute Agent Step on This Task/i }).click();
      await pwExpect(page.getByTestId('task-execution-status-banner')).toBeVisible({ timeout: 90000 });
      await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Last Agent Step Recorded');
      await pwExpect(page.getByTestId('task-execution-run-id')).toContainText('Run: run-');
      await pwExpect(page.getByTestId('run-id-value')).toContainText('run-');
      await pwExpect(page.getByTestId('run-status-value')).toHaveText('completed');
      await pwExpect(page.getByTestId('run-attempts-list')).toContainText('Attempt #1');
      await pwExpect(page.getByTestId('run-verification-checks')).toContainText('Verification Passed');
      await pwExpect(page.getByTestId('run-verification-checks')).toContainText('node --test src/quote.test.mjs');
      await pwExpect(page.getByTestId('run-changed-files')).toContainText('src/quote.mjs');
      await pwExpect(page.getByTestId('run-changed-files')).toContainText('src/addedQuoteStore.mjs');
      await pwExpect(page.getByTestId('run-candidate-diff')).toContainText('quoteEndpointReady');
      await pwExpect(page.getByTestId('run-candidate-diff')).toContainText('persistedQuotes');
      await pwExpect(page.getByTestId('task-review-honest-notice')).toContainText('separate steps');

      const shotDir = process.env.DUPOND_E2E_SCREENSHOT_DIR;
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: path.join(shotDir, 'run-evidence-desktop.png'), fullPage: false });
      }

      // D & E: Attempt Done via Task Details selector -> uses /transition (never /verify-task), refuses with delivery-pending, keeps review
      await page.getByTestId('task-detail-status-select').selectOption('done');
      await pwExpect(page.getByTestId('task-transition-refusal')).toBeVisible();
      if (shotDir) {
        await page.screenshot({ path: path.join(shotDir, 'transition-refusal-desktop.png'), fullPage: false });
      }
      await pwExpect(page.getByTestId('task-transition-refusal')).toContainText('delivery-pending');
      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('review');
      assert.ok(!apiUrls.some((u) => u.includes('/api/orchestrate/verify-task')), 'Legacy /verify-task must never be called');
      assert.ok(apiUrls.some((u) => u.includes('/transition')), 'Authoritative /transition must be called');

      // I (part 1): Escape closes TaskDetailModal
      await page.keyboard.press('Escape');
      await pwExpect(page.getByTestId('task-detail-modal')).toBeHidden();

      // E (part 2): Card forward arrow in Review & QA exercises the same rejected Done transition
      await page.getByTestId('card-move-next-NAV-101').click();
      await pwExpect(page.getByText(/Quality Gate Blocked/i)).toBeVisible();

      // H (part 2): Execute NAV-102 with failing verification and inspect failed-run state
      mockWorkerMode = 'fail';
      await page.getByText('NAV-102').first().click();
      await page.getByTestId('task-detail-modal').locator('select').nth(2).selectOption({ index: 1 });
      await page.getByRole('button', { name: /Execute Agent Step on This Task/i }).click();
      await pwExpect(page.getByTestId('task-execution-status-banner')).toBeVisible({ timeout: 90000 });
      await pwExpect(page.getByTestId('run-status-value')).toHaveText('failed');
      await pwExpect(page.getByTestId('run-failure-reason')).toBeVisible();
      await page.keyboard.press('Escape');

      // F: Restart server and recover run history
      await stopAppServer();
      await startAppServer();
      await page.reload({ waitUntil: 'networkidle' });
      await pwExpect(switcherBtn).toContainText('Naviera');
      await page.getByText('NAV-101').first().click();
      await pwExpect(page.getByTestId('run-id-value')).toContainText('run-');
      await pwExpect(page.getByTestId('run-verification-checks')).toContainText('Verification Passed');

      // G: Switch projects during delayed transition response -> stale response ignored, Secondary project stays active
      let releaseDelayedTransition!: () => void;
      const delayedTransitionGate = new Promise<void>((r) => (releaseDelayedTransition = r));
      let markTransitionSettled!: () => void;
      const transitionSettled = new Promise<void>((r) => (markTransitionSettled = r));
      const delayedHandler = async (route: any) => {
        await delayedTransitionGate;
        await route.continue().catch(() => {});
        markTransitionSettled();
      };
      await page.route('**/api/orchestrate/tasks/*/transition', delayedHandler);
      await page.getByTestId('task-detail-status-select').selectOption('done');
      await page.keyboard.press('Escape');

      await switcherBtn.click();
      await page.getByRole('button', { name: /Secondary/i }).click();
      await pwExpect(switcherBtn).toContainText('Secondary');

      releaseDelayedTransition();
      await transitionSettled;
      await page.unroute('**/api/orchestrate/tasks/*/transition', delayedHandler);
      await pwExpect(switcherBtn).toContainText('Secondary');

      // K: Board-only unregistered task -> Kanban forward arrow blocked with actionable banner -> safe registration -> registered task without evidence
      const secStateRes = await page.request.get(`${serverUrl}/api/orchestrate/state`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`, 'x-dupond-project-id': secondaryProjectId },
      });
      assert.strictEqual(secStateRes.status(), 200);
      const secState = (await secStateRes.json()) as any;
      const legacyBoardTask = {
        id: 'task-board-only-e2e',
        key: 'LEG-404',
        title: 'Legacy Board-Only Task',
        description: 'Unregistered task projected on board',
        status: 'review',
        priority: 'high',
        epicId: 'EPIC-1',
        assignedAgentId: 'agent-dev',
        estimatedHours: 2,
        spentHours: 0,
        subtasks: [{ id: 'sub-leg-1', title: 'Export check', completed: true }],
        deliverables: [],
        dependencies: [],
        tags: [],
        lastUpdated: 'Just now',
      };
      const putBoardRes = await page.request.post(`${serverUrl}/api/orchestrate/state`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`, 'x-dupond-project-id': secondaryProjectId },
        data: { ...secState, tasks: [...(secState.tasks || []), legacyBoardTask] },
      });
      assert.strictEqual(putBoardRes.status(), 200);

      await page.reload({ waitUntil: 'networkidle' });
      await pwExpect(switcherBtn).toContainText('Secondary');
      await pwExpect(page.getByText('LEG-404').first()).toBeVisible();

      // Click Kanban forward arrow on LEG-404 (attempting review -> done)
      const legCard = page.locator('div.group', { hasText: 'LEG-404' }).first();
      await legCard.getByTitle(/Request authoritative transition to done/i).click();

      await pwExpect(page.getByTestId('kanban-transition-blocked-banner')).toBeVisible();
      await pwExpect(page.getByTestId('kanban-transition-blocked-banner')).toContainText('unregistered-task');
      assert.strictEqual(
        await page.evaluate(() => document.body.innerText.includes('Inspected Physical Code Artifact on Disk')),
        false,
        'Legacy .dupond_artifacts message must never appear',
      );
      if (shotDir) {
        await page.screenshot({ path: path.join(shotDir, 'board-only-blocked.png'), fullPage: false });
      }

      // Inspect & Resolve -> Register before repository is configured must fail with REPOSITORY_CONFIGURATION_REQUIRED and expose Project Settings action
      await page.getByTestId('inspect-blocked-task-btn').click();
      await pwExpect(page.getByTestId('task-transition-refusal')).toContainText('unregistered-task');
      await pwExpect(page.getByTestId('register-authoritative-task-btn')).toBeVisible();
      await page.getByTestId('register-authoritative-task-btn').click();

      await pwExpect(page.getByTestId('task-registration-error')).toContainText('Project Settings');
      await pwExpect(page.getByTestId('open-project-settings-from-task-btn')).toBeVisible();
      await page.getByTestId('open-project-settings-from-task-btn').click();

      // Configure Secondary project's repository via Project Settings, then register LEG-404
      await pwExpect(page.getByTestId('project-settings-modal')).toBeVisible();
      await pwExpect(page.getByTestId('project-repo-url-input')).toBeVisible();
      await page.getByTestId('project-repo-url-input').fill(remoteDir);
      await page.getByTestId('verify-repo-btn').click();
      await page.getByTestId('repo-verification-result').waitFor({ state: 'visible' });
      await page.getByTestId('save-project-settings-btn').click();
      await pwExpect(page.getByTestId('save-project-settings-btn')).toBeDisabled();
      await page.getByTestId('cancel-project-settings-btn').click();
      await page.getByTestId('project-settings-modal').waitFor({ state: 'hidden' });

      await page.getByText('LEG-404').first().click();
      await pwExpect(page.getByTestId('unregistered-task-state')).toBeVisible();
      await page.getByTestId('runs-register-authoritative-task-btn').click();

      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('todo');
      await pwExpect(page.getByTestId('task-no-runs-state')).toBeVisible();
      await pwExpect(page.getByTestId('task-no-runs-state')).toContainText('Execute Agent Step on This Task');
      if (shotDir) {
        await page.screenshot({ path: path.join(shotDir, 'registered-no-evidence.png'), fullPage: false });
      }

      // Registered task without evidence cannot enter Review
      await page.getByTestId('task-detail-status-select').selectOption('review');
      await pwExpect(page.getByTestId('task-transition-refusal')).toContainText('no-evidence');
      await pwExpect(page.getByTestId('task-transition-refusal')).toContainText('Execute Agent Step on This Task');
      await page.keyboard.press('Escape');

      // Restart server & verify registered LEG-404 persists in Secondary as todo without runs and stays isolated from Naviera
      await stopAppServer();
      await startAppServer();
      await page.reload({ waitUntil: 'networkidle' });
      await pwExpect(switcherBtn).toContainText('Secondary');
      await page.getByText('LEG-404').first().click();
      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('todo');
      await pwExpect(page.getByTestId('task-no-runs-state')).toBeVisible();
      await page.keyboard.press('Escape');

      // Switch back to Naviera for Review Decision -> Delivery -> Done + mobile viewport check
      await switcherBtn.click();
      await page.getByRole('button', { name: /Naviera/i }).click();
      assert.strictEqual(await page.evaluate(() => document.body.innerText.includes('LEG-404')), false);
      await page.getByText('NAV-101').first().click();
      await pwExpect(page.getByTestId('run-candidate-diff')).toBeVisible();

      // J: Request Changes -> To Do (feedback persists across restart & project switch) -> rejected evidence cannot restore Review -> Re-execute receives feedback -> Approve & Deliver PR -> Done
      await pwExpect(page.getByTestId('request-changes-btn')).toBeVisible();
      await page.getByTestId('review-feedback-input').fill('Please verify helper export');
      await page.getByTestId('request-changes-btn').click();
      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('todo');
      await pwExpect(page.getByTestId('task-unresolved-review-feedback')).toContainText('Please verify helper export');

      // Restart server & switch projects to confirm feedback durability and scoping
      await stopAppServer();
      await startAppServer();
      await page.reload({ waitUntil: 'networkidle' });
      await switcherBtn.click();
      await page.getByRole('button', { name: /Secondary/i }).click();
      await pwExpect(switcherBtn).toContainText('Secondary');
      assert.strictEqual(await page.evaluate(() => document.body.innerText.includes('Please verify helper export')), false);
      await switcherBtn.click();
      await page.getByRole('button', { name: /Naviera/i }).click();
      await page.getByText('NAV-101').first().click();
      await pwExpect(page.getByTestId('task-unresolved-review-feedback')).toContainText('Please verify helper export');

      // Rejected evidence cannot restore Review without fresh work
      await page.getByTestId('task-detail-status-select').selectOption('review');
      await pwExpect(page.getByTestId('task-transition-refusal')).toBeVisible();
      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('todo');

      // Re-execute: next worker receives unresolved operator feedback in prompt
      lastWorkerPrompt = '';
      mockWorkerMode = 'pass';
      await page.getByRole('button', { name: /Execute Agent Step on This Task/i }).click();
      await pwExpect(page.getByTestId('task-execution-status-banner')).toBeVisible({ timeout: 90000 });
      await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Last Agent Step Recorded');
      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('review');
      assert.ok(lastWorkerPrompt.includes('Please verify helper export'), 'Next worker prompt must include unresolved operator review feedback');

      // Missing approval token -> 403 reveals token input
      await page.getByTestId('approve-deliver-pr-btn').click();
      await pwExpect(page.getByTestId('review-delivery-error')).toBeVisible();
      await pwExpect(page.getByTestId('review-approval-token-input')).toBeVisible();

      // Provide approval token -> Separate Approve Review -> Push & Create PR -> Done
      await page.getByTestId('review-approval-token-input').fill('e2e_approval_token_01');
      await page.getByTestId('approve-review-btn').click();
      await pwExpect(page.getByTestId('deliver-pr-btn')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('deliver-pr-btn').click();
      await pwExpect(page.getByTestId('run-delivery-status')).toBeVisible({ timeout: 20000 });
      await pwExpect(page.getByTestId('run-delivery-status')).toContainText('PR:');
      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('done');
      if (shotDir) {
        await page.screenshot({ path: path.join(shotDir, 'review-approve-deliver-pr.png'), fullPage: false });
      }
      assert.strictEqual(stateMutationFailures.length, 0, 'Secondary project metadata edits must not trigger POST /api/orchestrate/state 422');

      // I (part 2): Narrow mobile viewport check
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      assert.strictEqual(overflow, false, 'Mobile viewport should not overflow horizontally');
      if (shotDir) {
        await page.screenshot({ path: path.join(shotDir, 'run-evidence-mobile.png'), fullPage: false });
      }
    } finally {
      await context.close();
    }
  }, 240000);
});
