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

const SYNTH_AUTH_TOKEN = 'dp_e2e_opencode_auth_token_12345';

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

describe('OpenCode CLI coding worker browser E2E', () => {
  let tmpDir: string;
  let dbPath: string;
  let statePath: string;
  let keyPath: string;
  let repoDir: string;
  let fakeBin: string;
  let serverProc: ChildProcess | null = null;
  let serverPort: number;
  let serverUrl: string;
  let serverLogs = '';
  let browser: Browser;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-e2e-opencode-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    statePath = path.join(tmpDir, 'state.json');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    repoDir = path.join(tmpDir, 'repo');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

    fakeBin = path.join(tmpDir, 'fake-opencode');
    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('opencode v2.3.0'); process.exit(0); }
if (args[0] === 'models') {
  console.log('github-copilot/gpt-5.3-codex');
  console.log('github-copilot/claude-sonnet-4.6');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  console.log('GitHub Copilot  GITHUB_TOKEN  environment');
  process.exit(0);
}
if (args[0] === 'run') {
  fs.writeFileSync(path.join(process.cwd(), 'src/feature.mjs'), 'export const featureReady = true;\\n');
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 8, output: 4, total: 12 } } }));
  console.log(JSON.stringify({ type: 'text', part: { text: 'Updated feature.mjs cleanly.' } }));
  process.exit(0);
}
process.exit(1);
`,
      { mode: 0o755 },
    );

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'src/feature.mjs'), 'export const featureReady = false;\n');
    fs.writeFileSync(
      path.join(repoDir, 'src/feature.test.mjs'),
      "import assert from 'node:assert'; import { featureReady } from './feature.mjs'; assert.strictEqual(featureReady, true);\n",
    );
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    serverPort = await getFreePort();
    serverUrl = `http://127.0.0.1:${serverPort}`;
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
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
      DUPOND_CONN_KEY_PATH: keyPath,
      DUPOND_OPENCODE_BIN: fakeBin,
    };
    delete env.GEMINI_API_KEY;
    delete env.OPENAI_API_KEY;

    serverProc = spawn(tsxBin, ['server.ts'], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (d) => (serverLogs += d.toString()));
    serverProc.stderr?.on('data', (d) => (serverLogs += d.toString()));
    await waitForHealthy(serverUrl, serverProc, () => serverLogs);
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    try {
      await browser?.close();
    } catch {}
    if (serverProc?.pid) {
      try {
        process.kill(-serverProc.pid, 'SIGTERM');
      } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('selects OpenCode CLI worker in Task Details, executes without GEMINI_API_KEY or OPENAI_API_KEY, and records opencode provenance', async () => {
    const headers = (projectId?: string) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SYNTH_AUTH_TOKEN}`,
      ...(projectId ? { 'X-Dupond-Project-Id': projectId } : {}),
    });

    const projRes = await fetch(`${serverUrl}/api/projects`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        name: 'OpenCode Project',
        description: 'E2E OpenCode worker project',
        repository: { repoUrl: 'org/opencode-repo', localPath: repoDir, defaultBranch: 'main' },
      }),
    });
    assert.strictEqual(projRes.status, 201);
    const proj = (await projRes.json()) as any;

    // Seed an existing task directly (no plan decomposition needed)
    const seedRes = await fetch(`${serverUrl}/api/orchestrate/state`, {
      method: 'POST',
      headers: headers(proj.id),
      body: JSON.stringify({
        tasks: [
          {
            id: 'OPC-101',
            key: 'OPC-101',
            epicId: 'EPIC-1',
            title: 'Implement feature via OpenCode',
            description: 'Set featureReady = true',
            status: 'todo',
            priority: 'high',
            assignedAgentId: 'agent-dev',
            acceptanceCriteria: [
              { id: 'ac-1', title: 'featureReady test passes', completed: false, checkCommand: 'node src/feature.test.mjs' },
            ],
            verificationCommands: [{ command: 'node src/feature.test.mjs', criteriaIds: ['ac-1'] }],
            subtasks: [{ id: 'sub-1', title: 'featureReady test passes', completed: false, checkCommand: 'node src/feature.test.mjs' }],
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
            model: 'github-copilot/gpt-5.3-codex',
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

    const regRes = await fetch(`${serverUrl}/api/orchestrate/tasks/OPC-101/register`, {
      method: 'POST',
      headers: headers(proj.id),
    });
    assert.strictEqual(regRes.status, 200);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((token) => {
      window.localStorage.setItem('dupond_api_token', token);
    }, SYNTH_AUTH_TOKEN);
    const page: Page = await context.newPage();

    try {
      await page.goto(serverUrl, { waitUntil: 'networkidle' });
      const switcherBtn = page.getByRole('button', { name: 'Switch Dupond Project' });
      await switcherBtn.click();
      await page.getByRole('button', { name: /OpenCode Project/i }).click();

      await page.getByTestId('kanban-card-OPC-101').click();
      await page.getByTestId('task-worker-provider-select').selectOption('opencode');
      await pwExpect(page.getByTestId('task-worker-model-select')).toContainText('github-copilot/claude-sonnet-4.6');
      await page.getByTestId('task-worker-model-select').selectOption('github-copilot/claude-sonnet-4.6');

      await page.getByRole('button', { name: /Execute Agent Step on This Task/i }).click();
      if (process.platform === 'darwin') {
        await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Last Agent Step Recorded', { timeout: 30000 });
        await pwExpect(page.getByTestId('task-detail-status-select')).toHaveValue('review');
        await pwExpect(page.getByTestId('run-attempts-list')).toContainText('opencode:github-copilot/claude-sonnet-4.6');
        await pwExpect(page.getByTestId('run-verification-checks')).toContainText('Verification Passed');
      } else {
        await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Last Agent Step Blocked / Failed', { timeout: 30000 });
        await pwExpect(page.getByTestId('task-execution-status-banner')).toContainText('Sandbox cannot enforce protected');
        await pwExpect(page.getByTestId('run-attempts-list')).toContainText('opencode:github-copilot/claude-sonnet-4.6');
      }
    } finally {
      await context.close();
    }
  }, 120000);
});
