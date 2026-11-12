import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, it } from 'vitest';
import { TaskStore } from '../src/server/db/database';
import { ProjectStore } from '../src/server/projects/projectStore';
import { JiraProvisioner } from '../src/server/projects/jiraProvisioner';

const TOKEN = 'project-backend-test-token';
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
    cwd: process.cwd(),
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

function headers(projectId?: string): HeadersInit {
  return {
    Authorization: `Bearer ${TOKEN}`,
    ...(projectId ? { 'X-Dupond-Project-Id': projectId } : {}),
  };
}

describe('multi-project backend', () => {
  afterEach(async () => {
    await stopChildServers();
  });

  it('returns JSON 404 for unknown API routes and preserves auth', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-project-http-'));
    tempDirs.push(dir);
    await startServer(path.join(dir, 'dupond.db'), path.join(dir, 'state.json'), 3205);
    const unauthenticated = await fetch('http://127.0.0.1:3205/api/projects');
    assert.equal(unauthenticated.status, 401);
    const unknownApi = await fetch('http://127.0.0.1:3205/api/not-real', { headers: headers() });
    assert.equal(unknownApi.status, 404);
    assert.equal(unknownApi.headers.get('content-type')?.includes('application/json'), true);
  });

  it('creates projects, isolates state, persists after restart, and rejects cross-project resources', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-project-isolation-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'dupond.db');
    const statePath = path.join(dir, 'state.json');
    const store = new TaskStore(dbPath);
    const projects = new ProjectStore(store);
    projects.createProject({ id: 'project-a', name: 'Project A', actor: 'test' });
    projects.createProject({ id: 'project-b', name: 'Project B', actor: 'test' });

    const task = store.createTask({
      projectId: 'project-a',
      id: 'task-project-a',
      key: 'AEG-901',
      title: 'Project A task',
      description: '',
      status: 'todo',
      priority: 'medium',
      targetRepo: 'owner/repo-a',
      baseCommit: 'HEAD',
      allowedPaths: [],
      protectedPaths: [],
      verificationCommands: ['npm test'],
      acceptanceCriteria: [],
      workerConfig: { provider: 'gemini', model: 'gemini-3.5-flash' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
    });
    const run = store.createRun({
      projectId: task.projectId,
      taskId: task.id,
      status: 'pending',
      targetRepo: task.targetRepo,
      baseCommit: task.baseCommit,
      targetBranch: 'dupond/project-a',
      currentAttempt: 0,
      durationMs: 0,
    });

    await startServer(dbPath, statePath, 3202);
    const base = 'http://127.0.0.1:3202';
    const create = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'project-c',
        name: 'Project C',
        repository: { repoUrl: 'https://github.com/example/c', defaultBranch: 'main' },
        agentPreferences: { defaultProvider: 'gemini' },
      }),
    });
    assert.equal(create.status, 201);

    const stateA = await fetch(`${base}/api/orchestrate/state`, {
      method: 'POST',
      headers: { ...headers('project-a'), 'content-type': 'application/json' },
      body: JSON.stringify({ cycleCount: 17 }),
    });
    assert.equal(stateA.status, 200);

    const stateB = await fetch(`${base}/api/orchestrate/state`, { headers: headers('project-b') });
    assert.equal(stateB.status, 200);
    assert.equal((await stateB.json()).cycleCount, 0);

    const crossProject = await fetch(`${base}/api/runs/${run.id}`, { headers: headers('project-b') });
    assert.equal(crossProject.status, 403);
    assert.equal((await crossProject.json()).code, 'PROJECT_CONTEXT_MISMATCH');

    const missingContext = await fetch(`${base}/api/orchestrate/state`, { headers: headers() });
    assert.equal(missingContext.status, 400);
    assert.equal((await missingContext.json()).code, 'PROJECT_CONTEXT_REQUIRED');

    const unknownApi = await fetch(`${base}/api/unknown-route`, { headers: headers() });
    assert.equal(unknownApi.status, 404);
    assert.equal(unknownApi.headers.get('content-type')?.includes('application/json'), true);
    assert.equal((await unknownApi.json()).code, 'API_NOT_FOUND');

    await stopChildServers();
    await startServer(dbPath, statePath, 3203);
    const persisted = await fetch(`${'http://127.0.0.1:3203'}/api/orchestrate/state`, { headers: headers('project-a') });
    assert.equal(persisted.status, 200);
    assert.equal((await persisted.json()).cycleCount, 17);
  });

  it('blocks archive and reset while a project has active work', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-project-blockers-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'dupond.db');
    const statePath = path.join(dir, 'state.json');
    const store = new TaskStore(dbPath);
    const projects = new ProjectStore(store);
    const project = projects.createProject({ id: 'project-active', name: 'Active Project', actor: 'test' });
    const task = store.createTask({
      projectId: project.id,
      key: 'AEG-902',
      title: 'Active task',
      description: '',
      status: 'in_progress',
      priority: 'high',
      targetRepo: 'owner/repo',
      baseCommit: 'HEAD',
      allowedPaths: [],
      protectedPaths: [],
      verificationCommands: [],
      acceptanceCriteria: [],
      workerConfig: { provider: 'gemini', model: 'gemini-3.5-flash' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
      claimedBy: 'test-run',
    });
    store.createRun({
      projectId: project.id,
      taskId: task.id,
      status: 'pending',
      targetRepo: task.targetRepo,
      baseCommit: task.baseCommit,
      targetBranch: 'dupond/active',
      currentAttempt: 1,
      durationMs: 0,
    });

    await startServer(dbPath, statePath, 3204);
    const base = 'http://127.0.0.1:3204';
    const response = await fetch(`${base}/api/projects/${project.id}/archive`, {
      method: 'POST',
      headers: headers(project.id),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'ACTIVE_RUNS_PRESENT');
  });

  it('validates Jira links, persists retry identity, and never uses real network transport', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-project-jira-'));
    tempDirs.push(dir);
    const store = new TaskStore(path.join(dir, 'dupond.db'));
    const projects = new ProjectStore(store);
    const project = projects.createProject({ id: 'project-jira', name: 'Jira Project', actor: 'test' });
    const calls: string[] = [];
    const provisioner = new JiraProvisioner(projects, {
      async request(spec) {
        calls.push(`${spec.method} ${spec.path}`);
        return {
          status: 200,
          body: {
            key: 'DUP',
            id: '10001',
            fields: { issuetype: { name: 'Epic' } },
          },
        };
      },
    });

    const request = {
      mode: 'link_existing' as const,
      projectKey: 'DUP',
      operationId: 'jira-op-1',
      connection: {
        hostUrl: 'https://example.atlassian.net',
        userEmail: 'operator@example.com',
        apiToken: 'server-held-test-token',
      },
    };
    const first = await provisioner.provision({ projectId: project.id, request, actor: 'test' });
    assert.equal(first.result.status, 'succeeded');
    assert.deepEqual(calls, ['GET /rest/api/3/project/DUP']);
    assert.equal(JSON.stringify(projects.getProject(project.id)).includes('server-held-test-token'), false);

    const replay = await provisioner.provision({ projectId: project.id, request, actor: 'test' });
    assert.equal(replay.result.status, 'replayed');
    assert.equal(calls.length, 1);
  });
});
