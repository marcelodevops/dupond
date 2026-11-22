import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { expect as pwExpect } from 'playwright/test';

async function switchProjectAndWait(
  page: Page,
  switcherBtn: Locator,
  options: {
    targetProject: string;
    expectedCardKey: string;
    absentCardKey: string;
    extraAbsentTexts?: string[];
  },
): Promise<void> {
  await switcherBtn.click();
  await page.getByRole('button', { name: new RegExp(options.targetProject, 'i') }).click();
  await pwExpect(switcherBtn).toContainText(options.targetProject);
  await pwExpect(page.getByText(options.expectedCardKey).first()).toBeVisible();
  await pwExpect(page.getByText(options.absentCardKey)).toHaveCount(0);
  for (const extraText of options.extraAbsentTexts ?? []) {
    await pwExpect(page.getByText(extraText)).toHaveCount(0);
  }
}

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
  let mockWorkerMode: 'pass' | 'fail' | '503' = 'pass';
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

        if (mockWorkerMode === '503') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 503,
                message: 'This model is currently experiencing high demand. Please try again later.',
                status: 'UNAVAILABLE',
              },
            }),
          );
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
      const conflictTaskV1 = {
        ...legacyBoardTask,
        id: 'task-conflict-e2e',
        key: 'CON-404',
        title: 'Conflict Variant One',
        status: 'review',
      };
      const conflictTaskV2 = {
        ...legacyBoardTask,
        id: 'task-conflict-e2e',
        key: 'CON-404',
        title: 'Conflict Variant Two',
        status: 'in_progress',
      };
      const putBoardRes = await page.request.post(`${serverUrl}/api/orchestrate/state`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`, 'x-dupond-project-id': secondaryProjectId },
        data: {
          ...secState,
          tasks: [...(secState.tasks || []), legacyBoardTask, legacyBoardTask, conflictTaskV1, conflictTaskV2],
        },
      });
      assert.strictEqual(putBoardRes.status(), 200);

      await page.reload({ waitUntil: 'networkidle' });
      await pwExpect(switcherBtn).toContainText('Secondary');
      await pwExpect(page.getByText('LEG-404')).toHaveCount(1);
      await pwExpect(page.getByTestId('identity-conflict-badge-CON-404')).toBeVisible();

      // Resolve conflicting duplicate via modal
      await page.getByText('CON-404').first().click();
      await pwExpect(page.getByTestId('task-identity-conflict-banner')).toBeVisible();
      await pwExpect(page.getByTestId('resolve-conflict-variant-0')).toBeVisible();
      await page.getByTestId('resolve-conflict-variant-0').click();
      await pwExpect(page.getByTestId('task-identity-conflict-banner')).toBeHidden();
      await page.keyboard.press('Escape');
      await pwExpect(page.getByTestId('identity-conflict-badge-CON-404')).toBeHidden();

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
      await pwExpect(page.getByTestId('task-transition-refusal')).toContainText(
        'This task has no authoritative execution record. Registering will move it to To Do. Fresh execution and verification are required before Review.',
      );
      await pwExpect(page.getByTestId('register-authoritative-task-btn')).toHaveText('Register and Return to To Do');
      await page.getByTestId('register-authoritative-task-btn').click();

      const refusalBanner = page.getByTestId('task-transition-refusal');
      await pwExpect(refusalBanner.getByTestId('task-registration-error')).toContainText('Project Settings');
      await pwExpect(refusalBanner.getByTestId('open-project-settings-from-task-btn')).toBeVisible();
      await refusalBanner.getByTestId('open-project-settings-from-task-btn').click();

      // Configure Secondary project's repository via Project Settings, then register LEG-404
      await pwExpect(page.getByTestId('project-settings-modal')).toBeVisible();
      await pwExpect(page.getByTestId('project-local-path-input')).toBeVisible();
      await page.getByTestId('project-local-path-input').fill(targetRepoDir);
      await page.getByTestId('project-target-branch-input').fill('main');
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
      await switchProjectAndWait(page, switcherBtn, {
        targetProject: 'Naviera',
        expectedCardKey: 'NAV-101',
        absentCardKey: 'LEG-404',
      });
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
      await switchProjectAndWait(page, switcherBtn, {
        targetProject: 'Secondary',
        expectedCardKey: 'LEG-404',
        absentCardKey: 'NAV-101',
        extraAbsentTexts: ['Please verify helper export'],
      });
      await switchProjectAndWait(page, switcherBtn, {
        targetProject: 'Naviera',
        expectedCardKey: 'NAV-101',
        absentCardKey: 'LEG-404',
      });
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

  it('keeps blocked tasks visible with BLOCKED badge, handles unexpected statuses and interrupted requests, and ignores worktree file changes in Vite dev mode', async () => {
    const headers = (projectId?: string) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`,
      ...(projectId ? { 'X-Dupond-Project-Id': projectId } : {}),
    });

    // Create a dedicated project with an in_progress task (AEG-101) and an unexpected-status task (AEG-ODD)
    const projRes = await fetch(`${serverUrl}/api/projects`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        name: 'AEG-101 Visibility Project',
        description: 'Visibility regression project',
        repository: { repoUrl: remoteDir, localPath: targetRepoDir, defaultBranch: 'main' },
      }),
    });
    assert.strictEqual(projRes.status, 201);
    const proj = (await projRes.json()) as any;

    const stateSeedRes = await fetch(`${serverUrl}/api/orchestrate/state`, {
      method: 'POST',
      headers: headers(proj.id),
      body: JSON.stringify({
        tasks: [
          {
            id: 'AEG-101',
            key: 'AEG-101',
            epicId: 'EPIC-1',
            assignedAgentId: 'agent-dev',
            title: 'AEG-101 blocked visibility regression',
            description: 'Must remain visible in To Do when Gemini returns 503',
            status: 'todo',
            priority: 'high',
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
            name: 'Dev Worker',
            role: 'Developer',
            baseRole: 'Developer',
            avatar: 'D',
            model: 'gemini-3-flash-preview',
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
    assert.strictEqual(stateSeedRes.status, 200);

    // Register AEG-101 and set it in_progress in SQLite
    const regRes = await fetch(`${serverUrl}/api/orchestrate/tasks/AEG-101/register`, {
      method: 'POST',
      headers: headers(proj.id),
    });
    assert.strictEqual(regRes.status, 200);
    const toInProg = await fetch(`${serverUrl}/api/orchestrate/tasks/AEG-101/transition`, {
      method: 'POST',
      headers: headers(proj.id),
      body: JSON.stringify({ status: 'in_progress' }),
    });
    assert.strictEqual(toInProg.status, 200);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_AUTH_TOKEN);
    try {
      const page = await context.newPage();
      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      await page.route('**/api/orchestrate/state', async (route, request) => {
        if (request.method() === 'GET') {
          const resp = await route.fetch();
          const json = (await resp.json()) as any;
          if (Array.isArray(json.tasks) && json.tasks.some((t: any) => t.id === 'AEG-101')) {
            json.tasks = [
              ...json.tasks,
              {
                id: 'AEG-ODD',
                key: 'AEG-ODD',
                title: 'AEG-ODD unexpected status fallback',
                description: 'Task with unexpected status should render in To Do fallback',
                status: 'weird_status',
                priority: 'low',
                tags: [],
                subtasks: [],
                deliverables: [],
                estimatedHours: 1,
                spentHours: 0,
              },
            ];
          }
          await route.fulfill({ response: resp, json });
          return;
        }
        await route.continue();
      });
      const switcherBtn = page.getByRole('button', { name: 'Switch Dupond Project' });
      await switcherBtn.click();
      await page.getByRole('button', { name: /AEG-101 Visibility Project/i }).click();

      // Unexpected-status card is visible in To Do fallback with explicit status badge
      await pwExpect(page.getByTestId('kanban-card-AEG-ODD')).toBeVisible();
      await pwExpect(page.getByTestId('task-unexpected-status-badge-AEG-ODD')).toContainText('WEIRD_STATUS');
      await page.unroute('**/api/orchestrate/state');

      // Open AEG-101, attempt Review -> refused NO_EVIDENCE
      await page.getByTestId('kanban-card-AEG-101').click();
      await page.getByTestId('task-detail-status-select').selectOption('review');
      await pwExpect(page.getByTestId('task-transition-refusal')).toBeVisible();
      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('in_progress');

      // Execute Agent Step against 503 provider -> task stays visible once in To Do with BLOCKED badge & reason
      mockWorkerMode = '503';
      await page.getByRole('button', { name: /Execute Agent Step on This Task/i }).click();
      await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Last Agent Step Blocked / Failed', { timeout: 30000 });
      await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('503');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      if (await page.getByTestId('task-detail-status-select').isVisible().catch(() => false)) {
        await page.locator('button').filter({ has: page.locator('svg') }).first().click().catch(() => {});
      }

      await pwExpect(page.getByTestId('kanban-card-AEG-101')).toHaveCount(1);
      await pwExpect(page.getByTestId('task-blocked-badge-AEG-101')).toBeVisible();
      await pwExpect(page.getByTestId('task-blocked-reason-AEG-101')).toBeVisible();

      // Reload page & restart server -> blocked presentation persists
      await page.reload({ waitUntil: 'networkidle' });
      await switcherBtn.click();
      await page.getByRole('button', { name: /AEG-101 Visibility Project/i }).click();
      await pwExpect(page.getByTestId('kanban-card-AEG-101')).toHaveCount(1);
      await pwExpect(page.getByTestId('task-blocked-badge-AEG-101')).toBeVisible();

      // Interrupted client request during Execute Agent Step preserves task visibility
      await page.getByTestId('kanban-card-AEG-101').click();
      await page.route('**/api/orchestrate/agent-step', (route) => route.abort('failed'));
      await page.getByRole('button', { name: /Execute Agent Step on This Task/i }).click();
      await page.waitForTimeout(600);
      await page.unroute('**/api/orchestrate/agent-step');
      await page.keyboard.press('Escape');
      await pwExpect(page.getByTestId('kanban-card-AEG-101')).toHaveCount(1);
    } finally {
      await context.close();
    }

    // Verify Vite middleware dev mode ignores .dupond_worktrees/**/tsconfig.json without reloading the browser
    const devPort = await getFreePort();
    const devUrl = `http://127.0.0.1:${devPort}`;
    const tsxBin = path.resolve(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
    );
    const devLogs: string[] = [];
    const devProc = spawn(tsxBin, ['server.ts'], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: {
        ...(process.env as Record<string, string>),
        PORT: String(devPort),
        DUPOND_BIND_HOST: '127.0.0.1',
        NODE_ENV: 'development',
        DUPOND_AUTH_TOKEN: SYNTH_AUTH_TOKEN,
        DUPOND_DB_PATH: dbPath,
        DUPOND_STATE_FILE: statePath,
        DUPOND_CONN_KEY_PATH: keyPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    devProc.stdout?.on('data', (d) => devLogs.push(d.toString()));
    devProc.stderr?.on('data', (d) => devLogs.push(d.toString()));

    const wtTestDir = path.join(process.cwd(), '.dupond_worktrees', 'e2e-watch-test');
    const devCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await devCtx.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_AUTH_TOKEN);
    try {
      await waitForHealthy(devUrl, devProc, () => devLogs.join(''));
      const devPage = await devCtx.newPage();
      await devPage.goto(devUrl, { waitUntil: 'networkidle' });
      await devPage.evaluate(() => {
        (window as any).__dupondNoReloadMarker = 'alive';
      });
      let navCount = 0;
      devPage.on('framenavigated', (frame) => {
        if (frame === devPage.mainFrame()) navCount += 1;
      });

      fs.mkdirSync(wtTestDir, { recursive: true });
      fs.writeFileSync(path.join(wtTestDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
      await devPage.waitForTimeout(1500);

      const marker = await devPage.evaluate(() => (window as any).__dupondNoReloadMarker);
      assert.strictEqual(marker, 'alive', 'Worktree tsconfig.json creation must not reload Vite dev browser');
      assert.strictEqual(navCount, 0, 'Worktree tsconfig.json creation must not trigger main-frame navigation');
    } finally {
      fs.rmSync(wtTestDir, { recursive: true, force: true });
      await devCtx.close();
      try {
        if (devProc.pid) process.kill(-devProc.pid, 'SIGTERM');
      } catch {}
    }
  }, 180000);

  it('waits for a delayed project-switch response before asserting project isolation', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_AUTH_TOKEN);

    const page = await context.newPage();
    try {
      await page.goto(serverUrl, { waitUntil: 'networkidle' });

      const createAlpha = await page.request.post(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}` },
        data: { name: 'DelayAlpha', description: 'Delayed switch regression source project' },
      });
      assert.strictEqual(createAlpha.status(), 201);
      const alphaId = ((await createAlpha.json()) as { id: string }).id;

      const createBeta = await page.request.post(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}` },
        data: { name: 'DelayBeta', description: 'Delayed switch regression target project' },
      });
      assert.strictEqual(createBeta.status(), 201);
      const betaId = ((await createBeta.json()) as { id: string }).id;

      const seedState = async (projectId: string, key: string, title: string) => {
        const getRes = await page.request.get(`${serverUrl}/api/orchestrate/state`, {
          headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`, 'x-dupond-project-id': projectId },
        });
        assert.strictEqual(getRes.status(), 200);
        const state = (await getRes.json()) as { tasks?: unknown[] };
        const putRes = await page.request.post(`${serverUrl}/api/orchestrate/state`, {
          headers: {
            Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`,
            'x-dupond-project-id': projectId,
          },
          data: {
            ...state,
            tasks: [
              ...(state.tasks || []),
              {
                id: `task-${key.toLowerCase()}`,
                key,
                title,
                description: `Task for ${key}`,
                status: 'todo',
                priority: 'medium',
                epicId: 'EPIC-1',
                assignedAgentId: 'agent-dev',
                estimatedHours: 1,
                spentHours: 0,
                subtasks: [],
                deliverables: [],
                dependencies: [],
                tags: [],
                lastUpdated: 'Just now',
              },
            ],
          },
        });
        assert.strictEqual(putRes.status(), 200);
      };

      await seedState(alphaId, 'DLY-101', 'Alpha delayed switch card');
      await seedState(betaId, 'DLY-201', 'Beta delayed switch card');

      await page.reload({ waitUntil: 'networkidle' });
      const switcherBtn = page.getByRole('button', { name: 'Switch Dupond Project' });
      await switchProjectAndWait(page, switcherBtn, {
        targetProject: 'DelayAlpha',
        expectedCardKey: 'DLY-101',
        absentCardKey: 'DLY-201',
      });

      let releaseSwitch!: () => void;
      const switchGate = new Promise<void>((resolve) => {
        releaseSwitch = resolve;
      });
      let markRequestSeen!: () => void;
      const switchRequestSeen = new Promise<void>((resolve) => {
        markRequestSeen = resolve;
      });
      let gated = false;
      await page.route('**/api/**', async (route) => {
        if (!gated && route.request().method() === 'GET') {
          gated = true;
          markRequestSeen();
          await switchGate;
        }
        await route.continue();
      });

      const switchPromise = switchProjectAndWait(page, switcherBtn, {
        targetProject: 'DelayBeta',
        expectedCardKey: 'DLY-201',
        absentCardKey: 'DLY-101',
      });
      await switchRequestSeen;

      // While the project-switch GET response is still pending, the previous project remains active
      await pwExpect(switcherBtn).toContainText('DelayAlpha');
      releaseSwitch();
      await switchPromise;
      await page.unroute('**/api/**');
    } finally {
      await context.close();
    }
  }, 60000);

  it('omits placeholder repoUrl from delivery requests when a project uses localPath only', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_AUTH_TOKEN);

    const page = await context.newPage();
    try {
      await page.goto(serverUrl, { waitUntil: 'networkidle' });

      const createProj = await page.request.post(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}` },
        data: { name: 'LocalOnly', description: 'Local-path project without repoUrl' },
      });
      assert.strictEqual(createProj.status(), 201);
      const localProjId = ((await createProj.json()) as { id: string }).id;

      await page.reload({ waitUntil: 'networkidle' });
      const switcherBtn = page.getByRole('button', { name: 'Switch Dupond Project' });
      await switcherBtn.click();
      await page.getByRole('button', { name: /LocalOnly/i }).click();
      await pwExpect(switcherBtn).toContainText('LocalOnly');

      // Configure localPath and defaultBranch only, leaving repoUrl empty
      await page.getByTestId('open-project-settings-btn').click();
      await page.getByTestId('project-tab-repository').click();
      await page.getByTestId('project-local-path-input').fill(targetRepoDir);
      await page.getByTestId('project-target-branch-input').fill('main');
      await page.getByTestId('project-repo-url-input').fill('');
      await page.getByTestId('save-project-settings-btn').click();
      await pwExpect(page.getByTestId('save-project-settings-btn')).toBeDisabled();
      await page.getByTestId('cancel-project-settings-btn').click();
      await page.getByTestId('project-settings-modal').waitFor({ state: 'hidden' });

      const getStateRes = await page.request.get(`${serverUrl}/api/orchestrate/state`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`, 'x-dupond-project-id': localProjId },
      });
      assert.strictEqual(getStateRes.status(), 200);
      const state = (await getStateRes.json()) as { tasks?: unknown[] };
      const postStateRes = await page.request.post(`${serverUrl}/api/orchestrate/state`, {
        headers: { Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`, 'x-dupond-project-id': localProjId },
        data: {
          ...state,
          tasks: [
            ...(state.tasks || []),
            {
              id: 'task-loc-101',
              key: 'LOC-101',
              title: 'Local delivery payload check',
              description: 'Verify no placeholder repoUrl is sent',
              status: 'todo',
              priority: 'medium',
              epicId: 'EPIC-1',
              assignedAgentId: 'agent-dev',
              estimatedHours: 1,
              spentHours: 0,
              subtasks: [],
              deliverables: [],
              dependencies: [],
              tags: [],
              allowedPaths: ['src'],
              acceptanceCriteria: [
                { id: 'ac-loc-1', description: 'Passes quick check', command: 'node -e "process.exit(0)"' },
              ],
              lastUpdated: 'Just now',
            },
          ],
        },
      });
      assert.strictEqual(postStateRes.status(), 200);

      await page.reload({ waitUntil: 'networkidle' });
      await switchProjectAndWait(page, switcherBtn, {
        targetProject: 'LocalOnly',
        expectedCardKey: 'LOC-101',
        absentCardKey: 'NAV-101',
      });

      await page.getByText('LOC-101').first().click();
      mockWorkerMode = 'pass';
      const specialistSelect = page.getByTestId('task-detail-modal').locator('select').nth(2);
      await specialistSelect.selectOption({ index: 1 });
      await page.getByRole('button', { name: /Execute Agent Step on This Task/i }).click();
      await pwExpect(page.getByTestId('task-execution-status-banner')).toBeVisible({ timeout: 90000 });
      await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('review');

      let capturedPayload: Record<string, unknown> | null = null;
      await page.route('**/api/delivery/dispatch', async (route) => {
        capturedPayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Approval required', code: 'APPROVAL_CREDENTIAL_REQUIRED' }),
        });
      });

      await page.getByTestId('approve-deliver-pr-btn').click();
      await pwExpect(page.getByTestId('review-delivery-error')).toBeVisible();
      assert.ok(capturedPayload, 'Expected delivery dispatch request payload to be captured');
      assert.strictEqual((capturedPayload as Record<string, unknown>).repoUrl, undefined);
      assert.strictEqual(
        JSON.stringify(capturedPayload).includes('acme-corp/dupond-core-system'),
        false,
        'Delivery request must not include placeholder repoUrl',
      );
      await page.unroute('**/api/delivery/dispatch');
    } finally {
      await context.close();
    }
  }, 120000);
});
