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

const SYNTH_AUTH_TOKEN = 'dp_e2e_gemcli_auth_token_12345';

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

describe('Gemini CLI coding worker browser E2E', () => {
  let tmpDir: string;
  let dbPath: string;
  let statePath: string;
  let keyPath: string;
  let geminiHome: string;
  let repoDir: string;
  let fakeBin: string;
  let serverProc: ChildProcess | null = null;
  let serverPort: number;
  let serverUrl: string;
  let serverLogs = '';
  let browser: Browser;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-e2e-gemcli-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    statePath = path.join(tmpDir, 'state.json');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    geminiHome = path.join(tmpDir, 'gemini-home');
    repoDir = path.join(tmpDir, 'repo');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    fs.mkdirSync(geminiHome, { recursive: true });
    fs.writeFileSync(
      path.join(geminiHome, 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
    );
    fs.writeFileSync(
      path.join(geminiHome, 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'ya29.e2e_synthetic_token',
        refresh_token: '1//e2e_synthetic_refresh',
        expiry_date: Date.now() + 3600_000,
      }),
      { mode: 0o600 },
    );

    fakeBin = path.join(tmpDir, 'fake-gemini');
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.64.0');
  process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), 'src', 'feature.mjs'), 'export const value = 42;\\n');
console.log(JSON.stringify({ type: 'init', session_id: 'ses-e2e-1', model: 'gemini-2.5-flash' }));
console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'Updated feature.mjs' }));
console.log(JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 15, output_tokens: 6, total_tokens: 21 } }));
process.exit(0);
`,
      { mode: 0o755 },
    );

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'gemcli-e2e-repo', private: true, type: 'module' }),
    );
    fs.writeFileSync(path.join(repoDir, 'src', 'feature.mjs'), 'export const value = 0;\n');
    fs.writeFileSync(
      path.join(repoDir, 'src', 'feature.test.mjs'),
      "import assert from 'node:assert'; import { value } from './feature.mjs'; assert.strictEqual(value, 42);\n",
    );
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    serverPort = await getFreePort();
    serverUrl = `http://127.0.0.1:${serverPort}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(serverPort),
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
      DUPOND_CONN_KEY_PATH: keyPath,
      DUPOND_AUTH_TOKEN: SYNTH_AUTH_TOKEN,
      DUPOND_GEMINI_CLI_BIN: fakeBin,
      DUPOND_GEMINI_CLI_HOME: geminiHome,
      NODE_ENV: 'production',
    };
    delete env.GEMINI_API_KEY;
    delete env.OPENAI_API_KEY;

    serverProc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (d) => { serverLogs += d.toString(); });
    serverProc.stderr?.on('data', (d) => { serverLogs += d.toString(); });

    await waitForHealthy(serverUrl, serverProc, () => serverLogs);
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    if (serverProc?.pid) {
      try { process.kill(-serverProc.pid, 'SIGTERM'); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('selects Gemini CLI in Task Details, executes without GEMINI_API_KEY, verifies independently, and enters Review', async () => {
    const authHeaders = {
      Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    };

    const createProjRes = await fetch(`${serverUrl}/api/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'GeminiCLI Project',
        description: 'E2E Gemini CLI worker project',
        repository: { repoUrl: 'org/gemcli-repo', localPath: repoDir, defaultBranch: 'main' },
      }),
    });
    assert.strictEqual(createProjRes.status, 201);
    const project = (await createProjRes.json()) as any;

    const projHeaders = { ...authHeaders, 'X-Dupond-Project-Id': project.id };

    const seedRes = await fetch(`${serverUrl}/api/orchestrate/state`, {
      method: 'POST',
      headers: projHeaders,
      body: JSON.stringify({
        tasks: [
          {
            id: 'GCL-101',
            key: 'GCL-101',
            epicId: 'EPIC-1',
            title: 'Implement feature value 42',
            description: 'Update src/feature.mjs to export value = 42',
            status: 'todo',
            priority: 'high',
            assignedAgentId: 'agent-dev',
            acceptanceCriteria: [
              { id: 'ac-1', title: 'feature test passes', completed: false, checkCommand: 'node src/feature.test.mjs' },
            ],
            verificationCommands: [{ command: 'node src/feature.test.mjs', criteriaIds: ['ac-1'] }],
            subtasks: [{ id: 'sub-1', title: 'feature test passes', completed: false, checkCommand: 'node src/feature.test.mjs' }],
            tags: [],
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
            model: 'gemini-2.5-flash',
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
    assert.strictEqual(seedRes.status, 200);

    const regRes = await fetch(`${serverUrl}/api/orchestrate/tasks/GCL-101/register`, {
      method: 'POST',
      headers: projHeaders,
    });
    assert.strictEqual(regRes.status, 200);

    const statusRes = await fetch(`${serverUrl}/api/workers/gemini-cli/status`, {
      headers: authHeaders,
    });
    assert.strictEqual(statusRes.status, 200);
    const cliStatus = (await statusRes.json()) as any;
    assert.strictEqual(cliStatus.available, true);
    assert.strictEqual(cliStatus.authMethod, 'oauth-personal');

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_AUTH_TOKEN);
    const page: Page = await context.newPage();

    try {
      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      const switcherBtn = page.getByRole('button', { name: 'Switch Dupond Project' });
      await switcherBtn.click();
      await page.getByRole('button', { name: /GeminiCLI Project/i }).click();

      await page.getByTestId('kanban-card-GCL-101').click();
      await page.getByTestId('task-worker-provider-select').selectOption('gemini-cli');
      await pwExpect(page.getByTestId('task-worker-model-select')).toContainText('gemini-2.5-flash');
      await page.getByTestId('task-worker-model-select').selectOption('gemini-2.5-flash');

      await page.getByRole('button', { name: /Execute Agent Step on This Task/i }).click();
      if (process.platform === 'darwin') {
        await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Last Agent Step Recorded', { timeout: 30000 });
        await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('review');
        await pwExpect(page.getByTestId('run-attempts-list')).toContainText('gemini-cli:gemini-2.5-flash');
        await pwExpect(page.getByTestId('run-verification-checks')).toContainText('Verification Passed');
      } else {
        // On Linux container runtime, defaultProtectedPaths includes .env* which cannot be enforced against new-file creation -> fail closed
        await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Last Agent Step Blocked / Failed', { timeout: 30000 });
        await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Sandbox cannot enforce protected');
        await pwExpect(page.getByTestId('run-attempts-list')).toContainText('gemini-cli:gemini-2.5-flash');
      }
    } finally {
      await context.close();
    }
  }, 120000);
});
