import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';
import { expect as pwExpect } from 'playwright/test';

async function getFreePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function createFakeAgyBin(dir: string): string {
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

console.log(JSON.stringify({ type: 'result', session_id: 'sess-e2e', num_turns: 1, result: 'Done' }));
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

describe('Antigravity CLI worker & removed-provider UI E2E', () => {
  let tmpDir: string;
  let profileDir: string;
  let dbPath: string;
  let serverProc: ChildProcess;
  let serverUrl = '';
  const apiKey = 'agy-e2e-operator-key';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-agy-e2e-'));
    profileDir = path.join(tmpDir, 'agy-profile');
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    dbPath = path.join(tmpDir, 'dupond.db');

    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    // Seed isolated DB & project via dynamic import with DUPOND_DB_PATH
    const prevDb = process.env.DUPOND_DB_PATH;
    const prevState = process.env.DUPOND_STATE_FILE;
    const prevConn = process.env.DUPOND_CONN_KEY_PATH;
    process.env.DUPOND_DB_PATH = dbPath;
    process.env.DUPOND_STATE_FILE = path.join(tmpDir, 'state.json');
    process.env.DUPOND_CONN_KEY_PATH = path.join(tmpDir, 'conn.key');

    const { TaskStore } = await import('../../src/server/db/database.js');
    const { ProjectStore } = await import('../../src/server/projects/projectStore.js');

    const store = new TaskStore(dbPath);
    const pStore = new ProjectStore(store);
    const legacyTask = store.createTask({
      id: 'task-legacy-ui',
      projectId: 'default',
      key: 'AEG-901',
      title: 'Legacy Gemini CLI UI Task',
      description: 'Must display removed provider banner and preserve run history.',
      status: 'todo',
      priority: 'medium',
      epicId: 'epic-core',
      estimatedHours: 2,
      tags: [],
      allowedPaths: ['.'],
      protectedPaths: ['secrets'],
      verificationCommands: ['node -e "process.exit(0)"'],
      acceptanceCriteria: [{ id: 'ac1', title: 'Verify UI', completed: false }],
      workerConfig: { provider: 'gemini-cli', model: 'gemini-2.5-flash' },
      dependencies: [],
    });
    const histRun = store.createRun({
      taskId: legacyTask.id,
      projectId: 'default',
      status: 'failed',
      baseCommit: '0000000',
      targetBranch: 'main',
      currentAttempt: 1,
      durationMs: 120,
      worktreePath: repoDir,
    });
    store.createAttempt({
      runId: histRun.id,
      attemptNumber: 1,
      workerType: 'gemini-cli:gemini-2.5-flash',
      status: 'failed',
      startedAt: new Date().toISOString(),
      durationMs: 120,
      filesModified: [],
      diff: '',
      errorMessage: 'Historical gemini-cli failure',
    });
    pStore.saveProjectState('default', {
      tasks: [
        {
          id: legacyTask.id,
          key: legacyTask.key,
          title: legacyTask.title,
          description: legacyTask.description,
          status: 'todo',
          priority: 'medium',
          epicId: 'epic-core',
          assignedAgentId: 'agent-arch',
          estimatedHours: 2,
          tags: [],
          acceptanceCriteria: legacyTask.acceptanceCriteria,
          workerConfig: { provider: 'gemini-cli', model: 'gemini-2.5-flash' },
          dependencies: [],
        },
      ],
      agents: [
        {
          id: 'agent-arch',
          name: 'Architect',
          role: 'Coding Worker',
          baseRole: 'Developer',
          avatar: 'A',
          model: 'gemini-3.8-flash',
          status: 'idle',
          completedTasksCount: 0,
          velocity: 1,
          skills: ['ts'],
          communicationCount: 0,
          providerType: 'gemini',
        },
      ],
      epics: [{ id: 'epic-core', title: 'Core Architecture', description: 'Core', color: 'indigo', progress: 0 }],
      communications: [],
    });
    store.getRawDb().close();

    if (prevDb === undefined) delete process.env.DUPOND_DB_PATH;
    else process.env.DUPOND_DB_PATH = prevDb;
    if (prevState === undefined) delete process.env.DUPOND_STATE_FILE;
    else process.env.DUPOND_STATE_FILE = prevState;
    if (prevConn === undefined) delete process.env.DUPOND_CONN_KEY_PATH;
    else process.env.DUPOND_CONN_KEY_PATH = prevConn;

    const port = await getFreePort();
    const fakeBin = createFakeAgyBin(tmpDir);
    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
    serverProc = spawn(tsxBin, ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DUPOND_BIND_HOST: '127.0.0.1',
        DUPOND_DB_PATH: dbPath,
        DUPOND_STATE_FILE: path.join(tmpDir, 'state.json'),
        DUPOND_CONN_KEY_PATH: path.join(tmpDir, 'conn.key'),
        DUPOND_API_KEY: apiKey,
        DUPOND_AGY_BIN: fakeBin,
        DUPOND_AGY_PROFILE_DIR: profileDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for server')), 25_000);
      let out = '';
      const onData = (chunk: Buffer) => {
        out += chunk.toString('utf-8');
        const m = out.match(/DUPOND_READY\s+host=\S+\s+port=(\d+)/);
        if (m) {
          clearTimeout(timer);
          serverUrl = `http://127.0.0.1:${m[1]}`;
          resolve();
        }
      };
      serverProc.stdout?.on('data', onData);
      serverProc.stderr?.on('data', onData);
    });

    const stateRes = await fetch(`${serverUrl}/api/orchestrate/state`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Dupond-Project-Id': 'default',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tasks: [
          {
            id: 'task-legacy-ui',
            key: 'AEG-901',
            title: 'Legacy Gemini CLI UI Task',
            description: 'Must display removed provider banner and preserve run history.',
            status: 'todo',
            priority: 'medium',
            epicId: 'epic-core',
            assignedAgentId: 'agent-arch',
            estimatedHours: 2,
            tags: [],
            acceptanceCriteria: [{ id: 'ac1', title: 'Verify UI', completed: false }],
            workerConfig: { provider: 'gemini-cli', model: 'gemini-2.5-flash' },
            dependencies: [],
          },
        ],
        agents: [
          {
            id: 'agent-arch',
            name: 'Architect',
            role: 'Coding Worker',
            baseRole: 'Developer',
            avatar: 'A',
            model: 'gemini-3.8-flash',
            status: 'idle',
            completedTasksCount: 0,
            velocity: 1,
            skills: ['ts'],
            communicationCount: 0,
            providerType: 'gemini',
          },
        ],
        epics: [{ id: 'epic-core', title: 'Core Architecture', description: 'Core', color: 'indigo', progress: 0 }],
        communications: [],
      }),
    });
    assert.strictEqual(stateRes.status, 200);
  }, 35_000);

  afterAll(() => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGKILL');
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles removed gemini-cli recovery without history loss and unauthenticated vs authenticated agy selection', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript((token: string) => {
        window.localStorage.setItem('dupond_api_token', token);
      }, apiKey);
      const page = await context.newPage();

      await page.goto(serverUrl, { waitUntil: 'networkidle' });

      // Open the legacy gemini-cli task
      await pwExpect(page.getByTestId('kanban-card-AEG-901')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('kanban-card-AEG-901').click();

      // 1. Removed provider warning & disabled execution, historical run preserved
      await pwExpect(page.getByTestId('removed-provider-warning')).toContainText(
        'Provider removed—select another provider.',
      );
      await pwExpect(page.getByTestId('execute-agent-step-btn')).toBeDisabled();
      await pwExpect(page.getByTestId('run-attempts-list')).toContainText('gemini-cli:gemini-2.5-flash');

      // Verify /api/workers/gemini-cli/status is gone (404)
      const removedRouteRes = await page.evaluate(async (tok: string) => {
        const r = await fetch('/api/workers/gemini-cli/status', {
          headers: { Authorization: `Bearer ${tok}` },
        });
        return r.status;
      }, apiKey);
      assert.strictEqual(removedRouteRes, 404);

      // 2. Replace with unauthenticated 'agy' -> readiness warning + Application Settings link + disabled Execute button
      await page.getByTestId('task-worker-provider-select').selectOption('agy');
      await pwExpect(page.getByTestId('agy-prerequisite-warning')).toBeVisible({ timeout: 10_000 });
      await pwExpect(page.getByTestId('open-app-settings-from-task-agy-btn')).toBeVisible();
      await pwExpect(page.getByTestId('execute-agent-step-btn')).toBeDisabled();

      // Historical gemini-cli attempt is still preserved
      await pwExpect(page.getByTestId('run-attempts-list')).toContainText('gemini-cli:gemini-2.5-flash');

      // 3. Authenticate dedicated profile and reopen task -> agy ready, model list populated, Execute enabled
      const tokenPath = path.join(profileDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, JSON.stringify({ token: 'synth-token' }), { mode: 0o600 });

      await page.keyboard.press('Escape');
      await page.getByTestId('kanban-card-AEG-901').click();
      await pwExpect(page.getByTestId('agy-readiness-ready')).toContainText('2 models available', {
        timeout: 10_000,
      });
      await pwExpect(page.getByTestId('task-worker-model-select')).toContainText('gemini-4-neon-high');
      await pwExpect(page.getByTestId('execute-agent-step-btn')).toBeEnabled();
    } finally {
      await browser.close();
    }
  }, 45_000);
});
