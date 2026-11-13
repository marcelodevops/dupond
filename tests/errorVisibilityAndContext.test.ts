import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, it } from 'vitest';

const TOKEN = 'error-visibility-test-token';
const children: ChildProcess[] = [];
const tempDirs: string[] = [];

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Dupond server');
}

async function startServer(dbPath: string, statePath: string, port: number): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DUPOND_API_KEY: TOKEN,
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
    },
    stdio: 'ignore',
  });
  children.push(child);
  await waitForServer(port);
}

async function stopChildServers(): Promise<void> {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
  }
}

async function stopServers(): Promise<void> {
  await stopChildServers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Stage 3: Explicit Context & Error Visibility Suite', () => {
  afterEach(async () => {
    await stopServers();
  });

  it('enforces project context header across all orchestrate endpoints and rejects uncontextualized execution', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp_ctx_test_'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const statePath = path.join(dir, 'state.json');
    const port = 38910;

    await startServer(dbPath, statePath, port);
    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. Engine step without header -> 400 PROJECT_CONTEXT_REQUIRED
    const stepNoHeader = await fetch(`${baseUrl}/api/orchestrate/engine/step`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(stepNoHeader.status, 400);
    const stepNoHeaderData = await stepNoHeader.json();
    assert.strictEqual(stepNoHeaderData.code, 'PROJECT_CONTEXT_REQUIRED');

    // 2. Engine start without header -> 400 PROJECT_CONTEXT_REQUIRED
    const startNoHeader = await fetch(`${baseUrl}/api/orchestrate/engine/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(startNoHeader.status, 400);
    const startNoHeaderData = await startNoHeader.json();
    assert.strictEqual(startNoHeaderData.code, 'PROJECT_CONTEXT_REQUIRED');

    // 3. Engine stop without header -> 400 PROJECT_CONTEXT_REQUIRED
    const stopNoHeader = await fetch(`${baseUrl}/api/orchestrate/engine/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(stopNoHeader.status, 400);
    const stopNoHeaderData = await stopNoHeader.json();
    assert.strictEqual(stopNoHeaderData.code, 'PROJECT_CONTEXT_REQUIRED');

    // 4. Engine status without header -> 400 PROJECT_CONTEXT_REQUIRED
    const statusNoHeader = await fetch(`${baseUrl}/api/orchestrate/engine/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(statusNoHeader.status, 400);

    // 4b. Other orchestrate endpoints without header -> 400 PROJECT_CONTEXT_REQUIRED
    const allocateNoHeader = await fetch(`${baseUrl}/api/orchestrate/allocate-resources`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [{ id: '1' }], agents: [{ id: '1' }] }),
    });
    assert.strictEqual(allocateNoHeader.status, 400);

    const reportNoHeader = await fetch(`${baseUrl}/api/orchestrate/generate-report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [] }),
    });
    assert.strictEqual(reportNoHeader.status, 400);

    const chatNoHeader = await fetch(`${baseUrl}/api/orchestrate/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.strictEqual(chatNoHeader.status, 400);

    const suggestNoHeader = await fetch(`${baseUrl}/api/orchestrate/suggest-role`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: { id: 'agent-1' } }),
    });
    assert.strictEqual(suggestNoHeader.status, 400);

    // 5. Non-existent project -> 404 PROJECT_NOT_FOUND
    const stepNonExistent = await fetch(`${baseUrl}/api/orchestrate/engine/step`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': 'non-existent-proj-999',
      },
    });
    assert.strictEqual(stepNonExistent.status, 404);
    const stepNonExistentData = await stepNonExistent.json();
    assert.strictEqual(stepNonExistentData.code, 'PROJECT_NOT_FOUND');

    // 6. Create secondary project
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Naviera Freight' }),
    });
    assert.strictEqual(createRes.status, 201);
    const createdProject = await createRes.json();
    const navieraId = createdProject.id;
    assert.ok(navieraId);

    // 7. Engine step for secondary project -> 501 PROJECT_ENGINE_UNSUPPORTED
    const stepNaviera = await fetch(`${baseUrl}/api/orchestrate/engine/step`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(stepNaviera.status, 501);
    const stepNavieraData = await stepNaviera.json();
    assert.strictEqual(stepNavieraData.code, 'PROJECT_ENGINE_UNSUPPORTED');

    // 8. Engine start for secondary project -> 501 PROJECT_ENGINE_UNSUPPORTED
    const startNaviera = await fetch(`${baseUrl}/api/orchestrate/engine/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(startNaviera.status, 501);
    const startNavieraData = await startNaviera.json();
    assert.strictEqual(startNavieraData.code, 'PROJECT_ENGINE_UNSUPPORTED');

    // 9. Engine stop for secondary project -> 501 PROJECT_ENGINE_UNSUPPORTED
    const stopNaviera = await fetch(`${baseUrl}/api/orchestrate/engine/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(stopNaviera.status, 501);

    // 10. Engine status for secondary project -> 501 PROJECT_ENGINE_UNSUPPORTED
    const statusNaviera = await fetch(`${baseUrl}/api/orchestrate/engine/status`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(statusNaviera.status, 501);

    // 11. Cross-project task access -> 403 PROJECT_CONTEXT_MISMATCH
    // Default project has AEG-101. Attempting transition under naviera context must be refused.
    const crossTransition = await fetch(`${baseUrl}/api/orchestrate/tasks/AEG-101/transition`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    assert.strictEqual(crossTransition.status, 403);
    const crossData = await crossTransition.json();
    assert.strictEqual(crossData.code, 'PROJECT_CONTEXT_MISMATCH');

    console.log('✔ [PASS] Stage 3 explicit context and error visibility fully verified against server');
  });
});
