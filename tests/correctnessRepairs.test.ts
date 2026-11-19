import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'vitest';
import { TaskStore } from '../src/server/db/database';
import { ProjectStore, ProjectApiError } from '../src/server/projects/projectStore';

const TOKEN = 'correctness-repairs-test-token';
const MAX_LOG_BYTES = 8 * 1024;
const STARTUP_DEADLINE_MS = 15_000;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const SIGTERM_GRACE_MS = 1_500;
const SIGKILL_GRACE_MS = 1_500;

interface ManagedChildServer {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ManagedChildServer[] = [];
const tempDirs: string[] = [];

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + (typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
  if (next.length <= MAX_LOG_BYTES) return next;
  return next.slice(next.length - MAX_LOG_BYTES);
}

function sanitizeDiagnosticOutput(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(API_KEY|TOKEN|SECRET|PASSWORD)=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/sk-[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to allocate free port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function spawnManagedProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): ManagedChildServer {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry: ManagedChildServer = {
    child,
    stdout: '',
    stderr: '',
    spawnError: null,
    exitInfo: null,
    exitPromise: Promise.resolve({ code: null, signal: null }),
  };

  // Register exit & error listeners immediately at spawn time so early exits are never missed
  entry.exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      entry.exitInfo = { code, signal };
      resolve({ code, signal });
    });
    child.once('error', (err) => {
      entry.spawnError = err;
      if (!entry.exitInfo) {
        entry.exitInfo = { code: child.exitCode, signal: child.signalCode };
      }
      resolve(entry.exitInfo);
    });
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    entry.stdout = appendBounded(entry.stdout, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    entry.stderr = appendBounded(entry.stderr, chunk);
  });

  children.push(entry);
  return entry;
}

function formatServerFailure(
  reason: string,
  port: number,
  managed: ManagedChildServer,
  lastHealthStatus: string,
  attempts: number,
  elapsedMs: number
): string {
  const stdout = sanitizeDiagnosticOutput(managed.stdout.trim()) || '(empty)';
  const stderr = sanitizeDiagnosticOutput(managed.stderr.trim()) || '(empty)';
  const exitSummary = managed.exitInfo
    ? `code=${managed.exitInfo.code ?? 'null'}, signal=${managed.exitInfo.signal ?? 'null'}`
    : 'still running';
  const spawnErr = managed.spawnError ? managed.spawnError.message : 'none';
  return [
    `${reason} (port=${port}, elapsedMs=${elapsedMs}, attempts=${attempts}, lastHealth=${lastHealthStatus}, exit=[${exitSummary}], spawnError=${spawnErr})`,
    `--- child stdout (tail) ---\n${stdout}`,
    `--- child stderr (tail) ---\n${stderr}`,
  ].join('\n');
}

async function waitForServer(
  managed: ManagedChildServer,
  port: number,
  deadlineMs: number = STARTUP_DEADLINE_MS
): Promise<void> {
  const start = Date.now();
  const deadline = start + deadlineMs;
  let attempts = 0;
  let lastHealthStatus = 'not-attempted';

  while (Date.now() < deadline) {
    if (managed.spawnError) {
      throw new Error(
        formatServerFailure(
          'Dupond server failed to spawn',
          port,
          managed,
          lastHealthStatus,
          attempts,
          Date.now() - start
        )
      );
    }
    if (managed.exitInfo || managed.child.exitCode !== null || managed.child.signalCode !== null) {
      throw new Error(
        formatServerFailure(
          'Dupond server exited before becoming ready',
          port,
          managed,
          lastHealthStatus,
          attempts,
          Date.now() - start
        )
      );
    }

    attempts += 1;
    try {
      const remainingMs = Math.max(100, deadline - Date.now());
      const reqTimeoutMs = Math.min(HEALTH_REQUEST_TIMEOUT_MS, remainingMs);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(reqTimeoutMs),
      });
      lastHealthStatus = `HTTP ${response.status}`;
      if (response.ok) return;
    } catch (err: any) {
      lastHealthStatus = err?.message ? String(err.message) : 'fetch-error';
    }

    if (managed.spawnError || managed.exitInfo || managed.child.exitCode !== null || managed.child.signalCode !== null) {
      throw new Error(
        formatServerFailure(
          managed.spawnError ? 'Dupond server failed to spawn' : 'Dupond server exited before becoming ready',
          port,
          managed,
          lastHealthStatus,
          attempts,
          Date.now() - start
        )
      );
    }

    const waitMs = Math.min(50, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) {
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
        managed.exitPromise.then(() => undefined),
      ]);
    }
  }

  throw new Error(
    formatServerFailure(
      `Timed out waiting for Dupond server on port ${port} after ${deadlineMs}ms`,
      port,
      managed,
      lastHealthStatus,
      attempts,
      Date.now() - start
    )
  );
}

async function startServer(
  dbPath: string,
  statePath: string,
  port: number,
  keyPath: string = path.join(path.dirname(dbPath), '.dupond_conn_key')
): Promise<ManagedChildServer> {
  const managed = spawnManagedProcess(process.execPath, ['--import', 'tsx/esm', 'server.ts'], {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    DUPOND_API_KEY: TOKEN,
    DUPOND_DB_PATH: dbPath,
    DUPOND_STATE_FILE: statePath,
    DUPOND_CONN_KEY_PATH: keyPath,
  });
  await waitForServer(managed, port);
  return managed;
}

function isChildTerminated(managed: ManagedChildServer): boolean {
  return (
    managed.exitInfo !== null ||
    managed.child.exitCode !== null ||
    managed.child.signalCode !== null
  );
}

async function stopChildServers(options?: {
  sigtermGraceMs?: number;
  sigkillGraceMs?: number;
}): Promise<void> {
  const sigtermGraceMs = options?.sigtermGraceMs ?? SIGTERM_GRACE_MS;
  const sigkillGraceMs = options?.sigkillGraceMs ?? SIGKILL_GRACE_MS;
  const failures: string[] = [];

  for (const managed of [...children]) {
    const { child, exitPromise } = managed;
    if (isChildTerminated(managed)) {
      const idx = children.indexOf(managed);
      if (idx !== -1) children.splice(idx, 1);
      continue;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // Child may have exited concurrently
    }

    await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), sigtermGraceMs)),
    ]);

    if (!isChildTerminated(managed)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore if already exited
      }
      await Promise.race([
        exitPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), sigkillGraceMs)),
      ]);
    }

    if (isChildTerminated(managed)) {
      const idx = children.indexOf(managed);
      if (idx !== -1) children.splice(idx, 1);
    } else {
      // Retain tracking info in `children` when termination cannot be confirmed
      const stdout = sanitizeDiagnosticOutput(managed.stdout.trim()) || '(empty)';
      const stderr = sanitizeDiagnosticOutput(managed.stderr.trim()) || '(empty)';
      failures.push(
        `Failed to confirm termination of child pid=${child.pid ?? 'unknown'} after SIGTERM (${sigtermGraceMs}ms) and SIGKILL (${sigkillGraceMs}ms).\n--- child stdout (tail) ---\n${stdout}\n--- child stderr (tail) ---\n${stderr}`
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join('\n\n'));
  }
}

function cleanupTempDirs(): void {
  if (children.length > 0) {
    throw new Error(
      `Refusing to delete ${tempDirs.length} temporary directory(s): ${children.length} child server(s) still have unconfirmed termination.`
    );
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function headers(projectId?: string): HeadersInit {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...(projectId ? { 'X-Dupond-Project-Id': projectId } : {}),
  };
}

afterEach(async () => {
  await stopChildServers();
  cleanupTempDirs();
});

describe('Dupond correctness repairs regression suite', () => {
  it('Area 1: task reset scope works independently, handles dependent runs safely, and matches UI payload', async () => {
    const dir = makeTempDir('dupond-reset-scope-');
    const dbPath = path.join(dir, 'dupond.db');
    const statePath = path.join(dir, 'state.json');
    const taskStore = new TaskStore(dbPath);
    const projectStore = new ProjectStore(taskStore);

    const alpha = projectStore.createProject({ name: 'Alpha', actor: 'test' });
    const beta = projectStore.createProject({ name: 'Beta', actor: 'test' });

    // Seed Alpha with tasks and cycleCount = 4 (no runs yet)
    projectStore.adoptPlan({
      projectId: alpha.id,
      summary: 'Alpha Plan',
      epics: [{ id: 'ep-a', title: 'Alpha Epic' }],
      tasks: [
        { id: 'a1', key: 'ALP-1', title: 'Alpha 1', description: 'D1', epicId: 'ep-a' },
        { id: 'a2', key: 'ALP-2', title: 'Alpha 2', description: 'D2', epicId: 'ep-a' },
      ],
    });
    const alphaState = projectStore.getProjectState<any>(alpha.id, {});
    alphaState.cycleCount = 4;
    projectStore.saveProjectState(alpha.id, alphaState);

    // Seed Beta with tasks to verify isolation
    projectStore.adoptPlan({
      projectId: beta.id,
      summary: 'Beta Plan',
      epics: [{ id: 'ep-b', title: 'Beta Epic' }],
      tasks: [{ id: 'b1', key: 'BET-1', title: 'Beta 1', description: 'B1', epicId: 'ep-b' }],
    });

    // 1. Task-only reset without dependent runs succeeds and preserves cycleCount
    const taskOnlyRes = projectStore.resetProject(alpha.id, ['tasks'], 'test');
    assert.strictEqual(taskOnlyRes.cleared.tasks, 2);
    assert.strictEqual(taskOnlyRes.cleared.cycles, 0);
    assert.strictEqual(taskStore.listTasks(undefined, alpha.id).length, 0);
    assert.strictEqual(projectStore.getProjectState<any>(alpha.id, {}).cycleCount, 4);
    assert.strictEqual(projectStore.getProjectState<any>(alpha.id, {}).tasks.length, 0);
    assert.strictEqual(taskStore.listTasks(undefined, beta.id).length, 1);

    // 2. Re-seed Alpha + add a dependent completed run -> task-only reset MUST reject with 409
    projectStore.adoptPlan({
      projectId: alpha.id,
      summary: 'Alpha Plan 2',
      epics: [{ id: 'ep-a', title: 'Alpha Epic' }],
      tasks: [{ id: 'a3', key: 'ALP-3', title: 'Alpha 3', description: 'D3', epicId: 'ep-a' }],
    });
    const alp3 = taskStore.getTaskScoped('ALP-3', alpha.id)!;
    const run = taskStore.createRun({
      id: `run-${alpha.id}-1`,
      taskId: alp3.id,
      projectId: alpha.id,
      status: 'running',
      currentAttempt: 1,
      durationMs: 0,
      targetBranch: 'dupond/alp-3',
      worktreePath: path.join(dir, 'nonexistent-wt'),
      baseCommit: 'HEAD',
    });
    taskStore.updateRun(run.id, { status: 'completed', durationMs: 100 }, alpha.id);
    taskStore.updateTaskStatus(alp3.id, 'done', undefined, alpha.id);

    assert.throws(
      () => projectStore.resetProject(alpha.id, ['tasks'], 'test'),
      (err: any) => err instanceof ProjectApiError && err.httpStatus === 409 && err.code === 'DEPENDENT_RUNS_PRESENT',
    );
    assert.strictEqual(taskStore.listTasks(undefined, alpha.id).length, 1);

    // 3. Runs-only reset clears runs and resets task status to 'todo' without wiping tasks or cycleCount
    const runsOnly = projectStore.resetProject(alpha.id, ['runs'], 'test');
    assert.strictEqual(runsOnly.cleared.runs, 1);
    assert.strictEqual(runsOnly.cleared.tasks, 0);
    const alp3AfterRuns = taskStore.getTaskScoped('ALP-3', alpha.id)!;
    assert.strictEqual(alp3AfterRuns.status, 'todo');
    const alphaStateAfterRuns = projectStore.getProjectState<any>(alpha.id, {});
    assert.strictEqual(alphaStateAfterRuns.tasks.length, 1);
    assert.strictEqual(alphaStateAfterRuns.tasks[0].status, 'todo');
    assert.strictEqual(alphaStateAfterRuns.cycleCount, 4);

    // 4. Test exact UI reset payload via HTTP API + restart persistence
    taskStore.createRun({
      id: `run-${alpha.id}-2`,
      taskId: alp3.id,
      projectId: alpha.id,
      status: 'running',
      currentAttempt: 1,
      durationMs: 0,
      targetBranch: 'dupond/alp-3-b',
      worktreePath: path.join(dir, 'missing-wt'),
      baseCommit: 'HEAD',
    });
    taskStore.updateRun(`run-${alpha.id}-2`, { status: 'failed', durationMs: 50 }, alpha.id);

    const port = await getFreePort();
    const keyPath = path.join(dir, '.dupond_conn_key');
    await startServer(dbPath, statePath, port, keyPath);
    const uiResetResp = await fetch(`http://127.0.0.1:${port}/api/projects/${alpha.id}/reset`, {
      method: 'POST',
      headers: headers(alpha.id),
      body: JSON.stringify({
        confirmProjectName: 'Alpha',
        scope: {
          wipeTasks: true,
          wipeCycles: true,
          wipeWorktrees: true,
          preserveRemoteGit: true,
          preserveRemoteJira: true,
        },
      }),
    });
    assert.strictEqual(uiResetResp.status, 200);
    const uiResetJson = await uiResetResp.json() as any;
    assert.strictEqual(uiResetJson.clearedTasksCount, 1);
    assert.strictEqual(uiResetJson.clearedCyclesCount, 4);
    assert.strictEqual(uiResetJson.clearedWorktreesCount, 0); // worktree path didn't exist on disk
    assert.strictEqual(uiResetJson.details.cleared.runs, 1);

    // Restart server and verify Alpha stays cleared while Beta is untouched
    await stopChildServers();
    const port2 = await getFreePort();
    await startServer(dbPath, statePath, port2);

    const alphaStateResp = await fetch(`http://127.0.0.1:${port2}/api/orchestrate/state`, {
      headers: headers(alpha.id),
    });
    const alphaStateJson = await alphaStateResp.json() as any;
    assert.strictEqual(alphaStateJson.tasks.length, 0);
    assert.strictEqual(alphaStateJson.cycleCount, 0);

    const betaStateResp = await fetch(`http://127.0.0.1:${port2}/api/orchestrate/state`, {
      headers: headers(beta.id),
    });
    const betaStateJson = await betaStateResp.json() as any;
    assert.strictEqual(betaStateJson.tasks.length, 1);
  });

  it('Area 2: adopting multiple distinct plans preserves dependencies/tags/epics across restarts and rejects duplicates/conflicts', async () => {
    const dir = makeTempDir('dupond-multi-plan-');
    const dbPath = path.join(dir, 'dupond.db');
    const statePath = path.join(dir, 'state.json');
    const taskStore = new TaskStore(dbPath);
    const projectStore = new ProjectStore(taskStore);

    const proj = projectStore.createProject({ name: 'Naviera', actor: 'test' });
    const planA = projectStore.saveSourcePlan({
      projectId: proj.id,
      sourceText: 'Plan A',
      status: 'parsed',
    });
    const planB = projectStore.saveSourcePlan({
      projectId: proj.id,
      sourceText: 'Plan B',
      status: 'parsed',
    });

    // Adopt Plan A with dependent tasks, tags, recommendedRole, epic A
    const resA = projectStore.adoptPlan({
      projectId: proj.id,
      sourcePlanId: planA.id,
      planRevision: planA.revision,
      summary: 'Plan A Summary',
      epics: [{ id: 'ep-a', title: 'Epic A' }],
      tasks: [
        {
          id: 'pa-1',
          key: 'NAV-1',
          title: 'Schema',
          description: 'DB schema',
          epicId: 'ep-a',
          tags: ['db', 'core'],
          recommendedRole: 'Architect',
        },
        {
          id: 'pa-2',
          key: 'NAV-2',
          title: 'API',
          description: 'API routes',
          epicId: 'ep-a',
          dependencies: ['NAV-1'],
          tags: ['api'],
        },
      ],
    });
    assert.strictEqual(resA.adoptedCount, 2);

    // Repeated adoption of Plan A must reject with 409 PLAN_ALREADY_ADOPTED
    assert.throws(
      () => projectStore.adoptPlan({
        projectId: proj.id,
        sourcePlanId: planA.id,
        planRevision: planA.revision,
        summary: 'Plan A Again',
        epics: [{ id: 'ep-a', title: 'Epic A' }],
        tasks: [{ id: 'pa-3', key: 'NAV-99', title: 'Dup', description: 'Dup', epicId: 'ep-a' }],
      }),
      (err: any) => err instanceof ProjectApiError && err.httpStatus === 409 && err.code === 'PLAN_ALREADY_ADOPTED',
    );

    // Adopt distinct Plan B into the same project
    const resB = projectStore.adoptPlan({
      projectId: proj.id,
      sourcePlanId: planB.id,
      planRevision: planB.revision,
      summary: 'Plan B Summary',
      epics: [{ id: 'ep-b', title: 'Epic B' }],
      tasks: [
        { id: 'pb-1', key: 'NAV-3', title: 'UI', description: 'UI board', epicId: 'ep-b', tags: ['ui'] },
        { id: 'pb-2', key: 'NAV-4', title: 'Tests', description: 'E2E', epicId: 'ep-b', dependencies: ['NAV-3'] },
      ],
    });
    assert.strictEqual(resB.adoptedCount, 2);

    // Failed adoption (colliding key NAV-1) must roll back completely without inserting NAV-5
    assert.throws(
      () => projectStore.adoptPlan({
        projectId: proj.id,
        summary: 'Bad Plan C',
        epics: [{ id: 'ep-c', title: 'Epic C' }],
        tasks: [
          { id: 'pc-1', key: 'NAV-5', title: 'New', description: 'New', epicId: 'ep-c' },
          { id: 'pc-2', key: 'NAV-1', title: 'Collide', description: 'Collide', epicId: 'ep-c' },
        ],
      }),
      (err: any) => err instanceof ProjectApiError && err.httpStatus === 409 && err.code === 'TASK_KEY_CONFLICT',
    );
    assert.strictEqual(taskStore.getTaskScoped('NAV-5', proj.id), null);

    // Verify via HTTP server across restart
    const port = await getFreePort();
    const keyPath = path.join(dir, '.dupond_conn_key');
    await startServer(dbPath, statePath, port, keyPath);
    const stateResp = await fetch(`http://127.0.0.1:${port}/api/orchestrate/state`, {
      headers: headers(proj.id),
    });
    assert.strictEqual(stateResp.status, 200);
    const stateJson = await stateResp.json() as any;

    assert.strictEqual(stateJson.tasks.length, 4);
    assert.strictEqual(stateJson.epics.length, 2);
    const nav2 = stateJson.tasks.find((t: any) => t.key === 'NAV-2');
    assert.deepStrictEqual(nav2.dependencies, ['NAV-1']);
    assert.deepStrictEqual(nav2.tags, ['api']);
    assert.strictEqual(nav2.epicId, 'ep-a');
    const nav1 = stateJson.tasks.find((t: any) => t.key === 'NAV-1');
    assert.strictEqual(nav1.recommendedRole, 'Architect');
    const nav4 = stateJson.tasks.find((t: any) => t.key === 'NAV-4');
    assert.deepStrictEqual(nav4.dependencies, ['NAV-3']);
    assert.strictEqual(nav4.epicId, 'ep-b');
  });

  it('Area 3: project ownership enforcement prevents cross-project lookups on colliding keys and run/task endpoints', async () => {
    const dir = makeTempDir('dupond-ownership-');
    const dbPath = path.join(dir, 'dupond.db');
    const statePath = path.join(dir, 'state.json');
    const taskStore = new TaskStore(dbPath);
    const projectStore = new ProjectStore(taskStore);

    const alpha = projectStore.createProject({ name: 'Alpha', actor: 'test' });
    const beta = projectStore.createProject({ name: 'Beta', actor: 'test' });

    projectStore.adoptPlan({
      projectId: alpha.id,
      summary: 'A',
      epics: [{ id: 'e1', title: 'E1' }],
      tasks: [{ id: 't1', key: 'TASK-1', title: 'Alpha Task 1', description: 'A', epicId: 'e1' }],
    });
    projectStore.adoptPlan({
      projectId: beta.id,
      summary: 'B',
      epics: [{ id: 'e1', title: 'E1' }],
      tasks: [{ id: 't1', key: 'TASK-1', title: 'Beta Task 1', description: 'B', epicId: 'e1' }],
    });

    const alphaTask = taskStore.getTaskScoped('TASK-1', alpha.id)!;
    const betaTask = taskStore.getTaskScoped('TASK-1', beta.id)!;
    const alphaRun = taskStore.createRun({
      id: `run-${alpha.id}-1`,
      taskId: alphaTask.id,
      projectId: alpha.id,
      status: 'running',
      currentAttempt: 1,
      durationMs: 0,
      targetBranch: 'b-alpha',
      worktreePath: '/tmp/wt-a',
      baseCommit: 'HEAD',
    });
    const betaRun = taskStore.createRun({
      id: `run-${beta.id}-1`,
      taskId: betaTask.id,
      projectId: beta.id,
      status: 'running',
      currentAttempt: 1,
      durationMs: 0,
      targetBranch: 'b-beta',
      worktreePath: '/tmp/wt-b',
      baseCommit: 'HEAD',
    });

    const port = await getFreePort();
    const keyPath = path.join(dir, '.dupond_conn_key');
    await startServer(dbPath, statePath, port, keyPath);

    // 1. Missing X-Dupond-Project-Id rejected with 400
    const missingCtx = await fetch(`http://127.0.0.1:${port}/api/runs/${alphaRun.id}`, {
      headers: headers(),
    });
    assert.strictEqual(missingCtx.status, 400);

    // 2. Cross-project run lookup rejected with 403
    const crossRun = await fetch(`http://127.0.0.1:${port}/api/runs/${alphaRun.id}`, {
      headers: headers(beta.id),
    });
    assert.strictEqual(crossRun.status, 403);

    // 3. Colliding task key returns ONLY the scoped project's run
    const betaTaskRuns = await fetch(`http://127.0.0.1:${port}/api/tasks/TASK-1/runs`, {
      headers: headers(beta.id),
    });
    assert.strictEqual(betaTaskRuns.status, 200);
    const betaRunJson = await betaTaskRuns.json() as any;
    assert.strictEqual(betaRunJson.run.id, betaRun.id);
    assert.strictEqual(betaRunJson.run.projectId, beta.id);

    // 4. Slack dispatch without project header rejects with 400
    const slackMissing = await fetch(`http://127.0.0.1:${port}/api/integrations/slack/dispatch`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ eventType: 'info', message: 'hi' }),
    });
    assert.strictEqual(slackMissing.status, 400);
  });

  it('Area 4: coordinator transitionTaskStatus isolates secondary project state from default project state', async () => {
    const dir = makeTempDir('dupond-coordinator-isolation-');
    const dbPath = path.join(dir, 'dupond.db');
    const statePath = path.join(dir, 'state.json');
    const taskStore = new TaskStore(dbPath);
    const projectStore = new ProjectStore(taskStore);

    const alpha = projectStore.createProject({ name: 'Alpha', actor: 'test' });
    const alphaState = projectStore.getProjectState<any>(alpha.id, { tasks: [], epics: [] });
    alphaState.tasks = [
      {
        id: 'alpha-state-1',
        key: 'ALP-STATE-1',
        title: 'State-only alpha task',
        description: 'Test',
        epicId: 'ep-1',
        status: 'todo',
        priority: 'medium',
        estimatedHours: 2,
        spentHours: 0,
        assignedAgentId: '',
        dependencies: [],
        tags: [],
        subtasks: [],
        lastUpdated: 'Just now',
      },
    ];
    projectStore.saveProjectState(alpha.id, alphaState);

    const port = await getFreePort();
    const keyPath = path.join(dir, '.dupond_conn_key');
    await startServer(dbPath, statePath, port, keyPath);

    const transResp = await fetch(`http://127.0.0.1:${port}/api/orchestrate/tasks/alpha-state-1/transition`, {
      method: 'POST',
      headers: headers(alpha.id),
      body: JSON.stringify({ status: 'in_progress' }),
    });
    assert.strictEqual(transResp.status, 200);
    const transJson = await transResp.json() as any;
    assert.strictEqual(transJson.success, true);
    assert.strictEqual(transJson.task.status, 'in_progress');

    // Verify Alpha's state persisted and Default's state was NOT polluted
    const alphaAfter = await (await fetch(`http://127.0.0.1:${port}/api/orchestrate/state`, {
      headers: headers(alpha.id),
    })).json() as any;
    assert.strictEqual(alphaAfter.tasks[0].status, 'in_progress');

    const defaultAfter = await (await fetch(`http://127.0.0.1:${port}/api/orchestrate/state`, {
      headers: headers('default'),
    })).json() as any;
    assert.strictEqual(
      defaultAfter.tasks.some((t: any) => t.id === 'alpha-state-1'),
      false,
      'Default project state must not receive Alpha task',
    );
  });

  it('Area 5: legacy database migration preserves tasks, runs, attempts, verification, deliveries, audit, and FK integrity', () => {
    const dir = makeTempDir('dupond-legacy-migration-');
    const legacyDbPath = path.join(dir, 'legacy.db');
    const legacyDb = new DatabaseSync(legacyDbPath);

    // Representative pre-isolation schema (global UNIQUE on tasks.key, no project_id columns)
    legacyDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        target_repo TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        allowed_paths TEXT NOT NULL,
        protected_paths TEXT NOT NULL,
        verification_commands TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        worker_config TEXT NOT NULL,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        timeout_seconds INTEGER NOT NULL DEFAULT 600,
        require_approval INTEGER NOT NULL DEFAULT 1,
        blocked_reason TEXT,
        claimed_by TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        target_repo TEXT,
        base_commit TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        worktree_path TEXT,
        current_attempt INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER,
        failure_type TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE TABLE run_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL,
        commit_sha TEXT,
        files_changed TEXT NOT NULL,
        diff_stat TEXT NOT NULL,
        error_message TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (run_id) REFERENCES task_runs(id)
      );
      CREATE TABLE verification_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        revision_sha TEXT NOT NULL,
        passed INTEGER NOT NULL,
        checks TEXT NOT NULL,
        criteria_verified TEXT NOT NULL,
        failure_reason TEXT,
        verified_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES task_runs(id),
        FOREIGN KEY (attempt_id) REFERENCES run_attempts(id)
      );
      CREATE TABLE delivery_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        delivered_commit TEXT NOT NULL,
        branch TEXT NOT NULL,
        pr_number INTEGER,
        pr_url TEXT,
        ci_status TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES task_runs(id)
      );
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        run_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        details TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      INSERT INTO tasks (
        id, key, title, description, status, priority,
        target_repo, base_commit, allowed_paths, protected_paths,
        verification_commands, acceptance_criteria, worker_config,
        created_at, updated_at
      ) VALUES (
        'task-legacy-1', 'LEG-1', 'Legacy Task', 'Desc', 'done', 'high',
        'repo', 'HEAD', '["src/**"]', '[]', '[]', '[]', '{}',
        datetime('now'), datetime('now')
      );
      INSERT INTO task_runs (
        id, task_id, status, target_repo, base_commit, target_branch, worktree_path, current_attempt, created_at, updated_at
      ) VALUES (
        'run-legacy-1', 'task-legacy-1', 'completed', 'repo', 'HEAD', 'dupond/leg-1', '/tmp/wt-leg', 1, datetime('now'), datetime('now')
      );
      INSERT INTO run_attempts (
        id, run_id, attempt_number, worker_id, status, files_changed, diff_stat, started_at
      ) VALUES (
        'att-legacy-1', 'run-legacy-1', 1, 'worker-legacy', 'completed', '[]', '0 files', datetime('now')
      );
      INSERT INTO verification_records (
        id, run_id, attempt_id, revision_sha, passed, checks, criteria_verified, verified_at
      ) VALUES (
        'ver-legacy-1', 'run-legacy-1', 'att-legacy-1', 'abc123', 1, '[]', '[]', datetime('now')
      );
      INSERT INTO delivery_records (
        id, run_id, provider, repo_url, base_commit, delivered_commit, branch, ci_status, approval_status, delivered_at
      ) VALUES (
        'del-legacy-1', 'run-legacy-1', 'github', 'https://github.com/org/repo', 'HEAD', 'abc123', 'dupond/leg-1', 'passed', 'approved', datetime('now')
      );
      INSERT INTO audit_events (
        id, task_id, run_id, event_type, actor, details, timestamp
      ) VALUES (
        'aud-legacy-1', 'task-legacy-1', 'run-legacy-1', 'TASK_CREATED', 'legacy', '{}', datetime('now')
      );
    `);
    legacyDb.close();

    // First migration run
    const migratedStore = new TaskStore(legacyDbPath);
    const fkRow = (migratedStore as any).db.prepare('PRAGMA foreign_keys').get() as any;
    assert.strictEqual(fkRow.foreign_keys, 1);
    const fkCheck = (migratedStore as any).db.prepare('PRAGMA foreign_key_check').all();
    assert.deepStrictEqual(fkCheck, [], 'PRAGMA foreign_key_check must return empty');

    const legacyTask = migratedStore.getTaskScoped('LEG-1', 'default');
    assert.ok(legacyTask);
    assert.strictEqual(legacyTask.projectId, 'default');
    const legacyRun = migratedStore.getRunScoped('run-legacy-1', 'default');
    assert.ok(legacyRun);
    assert.strictEqual(migratedStore.listAttempts('run-legacy-1', 'default').length, 1);
    assert.ok(migratedStore.getLatestVerification('run-legacy-1', 'default'));
    assert.ok(migratedStore.getDeliveryForRun('run-legacy-1', 'default'));
    assert.strictEqual(migratedStore.listAuditEvents('task-legacy-1', 'default').length, 1);

    // Duplicate key across projects must succeed after migration
    const secondTask = migratedStore.createTask({
      id: 'task-proj2-leg1',
      key: 'LEG-1',
      title: 'Project 2 LEG-1',
      description: 'Scoped duplicate key',
      status: 'todo',
      priority: 'medium',
      projectId: 'proj-2',
    });
    assert.strictEqual(secondTask.key, 'LEG-1');
    assert.strictEqual(secondTask.projectId, 'proj-2');

    // Re-running migration on already-migrated DB must be idempotent
    const secondBoot = new TaskStore(legacyDbPath);
    assert.deepStrictEqual((secondBoot as any).db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.ok(secondBoot.getTaskScoped('LEG-1', 'default'));
    assert.ok(secondBoot.getTaskScoped('LEG-1', 'proj-2'));
  });

  it('Server harness: detects early child exit and spawn errors immediately with sanitized diagnostics', async () => {
    const port = await getFreePort();
    const earlyChild = spawnManagedProcess(
      process.execPath,
      [
        '-e',
        'console.log("starting up"); console.error("fatal crash TOKEN=super_secret_value"); process.exit(42);',
      ],
      process.env
    );

    const t0 = Date.now();
    await assert.rejects(
      () => waitForServer(earlyChild, port, 10_000),
      (err: Error) => {
        assert.ok(err.message.includes('exited before becoming ready'), err.message);
        assert.ok(err.message.includes('code=42'), err.message);
        assert.ok(err.message.includes('starting up'), err.message);
        assert.ok(err.message.includes('TOKEN=[REDACTED]'), err.message);
        assert.ok(!err.message.includes('super_secret_value'), 'Secret must be redacted');
        return true;
      }
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3_000, `Expected immediate failure on early exit, took ${elapsed}ms`);

    // Already-exited child must not hang stopChildServers()
    const stopStart = Date.now();
    await stopChildServers();
    assert.ok(Date.now() - stopStart < 500, 'Teardown of already-exited child should be immediate');

    // Non-existent executable triggers immediate spawn error diagnostics
    const badSpawn = spawnManagedProcess('/nonexistent/dupond-missing-binary', [], process.env);
    await assert.rejects(
      () => waitForServer(badSpawn, port, 10_000),
      /failed to spawn/i
    );
    await stopChildServers();
  });

  it('Server harness: escalates SIGTERM to SIGKILL on unresponsive child before cleaning temp storage', async () => {
    const dir = makeTempDir('dupond-teardown-escalation-');
    const markerFile = path.join(dir, 'alive.txt');
    const stubbornChild = spawnManagedProcess(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], "up"); setInterval(() => {}, 1000);',
        markerFile,
      ],
      process.env
    );

    // Wait briefly until child has written markerFile and installed SIGTERM handler
    for (let i = 0; i < 40 && !fs.existsSync(markerFile); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.existsSync(markerFile), 'Stubborn child should start and write marker');

    const t0 = Date.now();
    await stopChildServers();
    const teardownMs = Date.now() - t0;
    assert.ok(
      stubbornChild.exitInfo !== null || stubbornChild.child.exitCode !== null || stubbornChild.child.signalCode !== null,
      'Stubborn child must be terminated after SIGKILL escalation'
    );
    assert.ok(teardownMs < 4_000, `Expected bounded teardown, took ${teardownMs}ms`);

    // Temp dir cleanup succeeds after child termination
    cleanupTempDirs();
    assert.strictEqual(fs.existsSync(dir), false);
  });

  it('Server harness: refuses temp cleanup, retains tracking, and fails with sanitized diagnostics on unconfirmed termination', async () => {
    const dir = makeTempDir('dupond-unconfirmed-exit-');
    const keepFile = path.join(dir, 'keep.txt');
    fs.writeFileSync(keepFile, 'preserve-me');

    const stubChild = {
      pid: 999991,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    } as unknown as ChildProcess;

    const tracked: ManagedChildServer = {
      child: stubChild,
      stdout: 'server log line\n',
      stderr: 'stuck cleanup TOKEN=top_secret_abc\n',
      spawnError: null,
      exitInfo: null,
      exitPromise: new Promise(() => {}),
    };
    children.push(tracked);

    try {
      await assert.rejects(
        () => stopChildServers({ sigtermGraceMs: 20, sigkillGraceMs: 20 }),
        (err: Error) => {
          assert.ok(err.message.includes('Failed to confirm termination of child pid=999991'), err.message);
          assert.ok(err.message.includes('TOKEN=[REDACTED]'), err.message);
          assert.ok(!err.message.includes('top_secret_abc'), 'Secret must be redacted');
          return true;
        }
      );

      // Child tracking information is retained
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0], tracked);

      // Temporary storage cleanup is refused while child termination is unconfirmed
      assert.throws(() => cleanupTempDirs(), /Refusing to delete .* unconfirmed termination/i);
      assert.strictEqual(fs.existsSync(dir), true);
      assert.strictEqual(fs.readFileSync(keepFile, 'utf-8'), 'preserve-me');
    } finally {
      // Release synthetic stub entry so afterEach can clean up the test's temp dir
      const idx = children.indexOf(tracked);
      if (idx !== -1) children.splice(idx, 1);
    }
  });
});
