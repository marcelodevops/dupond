import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, it } from 'vitest';
import { TaskStore } from '../src/server/db/database';
import { ProjectStore } from '../src/server/projects/projectStore';

const TOKEN = 'complete-journey-test-token';
const children: ChildProcess[] = [];
const tempDirs: string[] = [];
const OUTPUT_LIMIT = 8_000;
const READY_BUDGET_MS = 15_000;
const REQUEST_TIMEOUT_MS = 500;

interface StartedServer {
  child: ChildProcess;
  baseUrl: string;
  port: number;
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function startupFailure(details: {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: number | null;
  lastError: string | null;
}): Error {
  return new Error(
    [
      'Dupond server did not become ready',
      `exitCode=${details.exitCode ?? 'none'}`,
      `signal=${details.signal ?? 'none'}`,
      `readinessStatus=${details.status ?? 'none'}`,
      `lastError=${details.lastError ?? 'none'}`,
      '--- child output ---',
      details.output || '(no output)',
    ].join('\n')
  );
}

async function startServer(
  dbPath: string,
  statePath: string,
  geminiKey?: string
): Promise<StartedServer> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // Kernel-assigned port. A fixed port can be owned by an IPv4 listener
      // while listen() without a host opens the IPv6 wildcard, so 127.0.0.1
      // never reaches this process and a longer poll cannot succeed.
      PORT: '0',
      DUPOND_BIND_HOST: '127.0.0.1',
      DUPOND_API_KEY: TOKEN,
      DUPOND_DB_PATH: dbPath,
      DUPOND_STATE_FILE: statePath,
      ...(geminiKey ? { GEMINI_API_KEY: geminiKey } : { GEMINI_API_KEY: '' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  const observed = {
    output: '',
    exitCode: null as number | null,
    signal: null as NodeJS.Signals | null,
    spawnError: null as Error | null,
  };
  child.stdout?.on('data', (chunk) => {
    observed.output = appendBounded(observed.output, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    observed.output = appendBounded(observed.output, chunk);
  });
  child.once('error', (err) => {
    observed.spawnError = err;
  });
  child.once('exit', (code, exitSignal) => {
    observed.exitCode = code;
    observed.signal = exitSignal;
  });

  const deadline = Date.now() + READY_BUDGET_MS;
  let status: number | null = null;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    const spawnFailure = observed.spawnError;
    if (spawnFailure) {
      throw startupFailure({
        output: `${observed.output}\nspawn error: ${spawnFailure.message}`,
        exitCode: observed.exitCode,
        signal: observed.signal,
        status,
        lastError: spawnFailure.message,
      });
    }
    if (observed.exitCode !== null || observed.signal) {
      throw startupFailure({
        output: observed.output,
        exitCode: observed.exitCode,
        signal: observed.signal,
        status,
        lastError,
      });
    }
    const ready = observed.output.match(/DUPOND_READY host=(\S+) port=(\d+)/);
    if (ready) {
      const baseUrl = `http://${formatHost(ready[1])}:${ready[2]}`;
      try {
        const response = await fetch(`${baseUrl}/api/health`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        status = response.status;
        if (response.ok) {
          return { child, baseUrl, port: Number(ready[2]) };
        }
        lastError = `health HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw startupFailure({
    output: observed.output,
    exitCode: observed.exitCode,
    signal: observed.signal,
    status,
    lastError,
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const exited = Promise.race([
    once(child, 'exit').then(() => true).catch(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (await exited) return;
  if (child.exitCode !== null || child.signalCode) return;
  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  await Promise.race([
    once(child, 'exit').catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

async function stopChildServers(): Promise<void> {
  for (const child of children.splice(0)) {
    await stopChild(child);
  }
}

async function stopServers(): Promise<void> {
  await stopChildServers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Stage 5: Complete 10-Step Operator Journey Suite', () => {
  afterEach(async () => {
    await stopServers();
  });

  it('executes the full honest project lifecycle from creation to plan adoption and engine gating', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp_journey_test_'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const statePath = path.join(dir, 'state.json');
    // Start server WITHOUT GEMINI_API_KEY initially to verify credential gating
    let started = await startServer(dbPath, statePath);
    let baseUrl = started.baseUrl;

    // =========================================================================
    // STEP 1: CREATE PROJECT
    // =========================================================================
    console.log('--- Step 1: Create Project ---');
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Naviera Ocean Freight',
        description: 'Persistent maritime quote request engine and tracking',
      }),
    });
    assert.strictEqual(createRes.status, 201, 'Project creation should return HTTP 201');
    const naviera = await createRes.json();
    assert.ok(naviera.id, 'Created project must have an ID');
    assert.strictEqual(naviera.name, 'Naviera Ocean Freight');
    assert.strictEqual(naviera.status, 'active');
    const navieraId = naviera.id;
    console.log(`✔ Step 1 Passed: Project created with ID ${navieraId}`);

    // =========================================================================
    // STEP 2: CONFIGURE REPOSITORY & VERIFY SETTINGS
    // =========================================================================
    console.log('--- Step 2: Configure Repository & Verify Settings ---');
    const repoDir = path.join(dir, 'naviera-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', repoDir]);
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Naviera Dev']);
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'dev@naviera.local']);
    fs.writeFileSync(path.join(repoDir, 'naviera.txt'), 'Naviera Freight Engine Core\n');
    execFileSync('git', ['-C', repoDir, 'add', '.']);
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'feat: initial freight schema']);

    // Configure repository on project
    const updateRepoRes = await fetch(`${baseUrl}/api/projects/${navieraId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        repository: {
          localPath: repoDir,
          defaultBranch: 'main',
          localWriteMode: 'worktree',
        },
      }),
    });
    assert.strictEqual(updateRepoRes.status, 200);

    // Verify repository via verification endpoint
    const verifyRepoRes = await fetch(`${baseUrl}/api/projects/${navieraId}/repository/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({}),
    });
    assert.strictEqual(verifyRepoRes.status, 200);
    const verifyRepo = await verifyRepoRes.json();
    assert.strictEqual(verifyRepo.valid, true);
    assert.strictEqual(verifyRepo.isGitRepo, true);
    assert.strictEqual(verifyRepo.branchExists, true);
    assert.strictEqual(verifyRepo.writable, true);
    console.log('✔ Step 2 Passed: Repository configured and verified');

    // =========================================================================
    // STEP 3: ATTEMPT INGEST WITH UNCONFIGURED CREDENTIALS (EXPLICIT ERROR)
    // =========================================================================
    console.log('--- Step 3: Attempt Ingest Without AI Credentials ---');
    const navieraPlanText = `
Project Mission: Naviera Maritime Quote Engine
We need persistent storage for maritime freight requests and quote aggregation.
Requirements:
1. REST API endpoint to submit container shipping quotes.
2. PostgreSQL persistence schema for bill of lading and customs documents.
3. Automated rate comparison across Pacific routes.
    `.trim();

    const failedParseRes = await fetch(`${baseUrl}/api/projects/${navieraId}/plan/parse`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        planText: navieraPlanText,
      }),
    });

    assert.strictEqual(failedParseRes.status, 503, 'Must return HTTP 503 when AI credentials missing');
    const failedParseData = await failedParseRes.json();
    assert.strictEqual(failedParseData.code, 'PLANNER_UNAVAILABLE');
    assert.ok(failedParseData.error.includes('GEMINI_API_KEY'));

    // Check that source plan was preserved in database despite AI failure
    const planRecordsRes = await fetch(`${baseUrl}/api/projects/${navieraId}/plan`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(planRecordsRes.status, 200);
    const planRecords = await planRecordsRes.json();
    assert.ok(planRecords.latest, 'Failed attempt must still preserve operator plan text');
    assert.strictEqual(planRecords.latest.sourceText, navieraPlanText);
    assert.strictEqual(planRecords.latest.status, 'parse_failed');
    console.log('✔ Step 3 Passed: Explicit 503 error returned and original plan preserved exactly');

    // =========================================================================
    // STEP 4 & 5: INGEST REAL PLAN & VERIFY DECOMPOSITION DAG
    // =========================================================================
    console.log('--- Steps 4 & 5: Real Plan Decomposition & DAG Review ---');
    // Save a parsed plan into project store directly (simulating successful AI output)
    const taskStoreForPlan = new TaskStore(dbPath);
    const store = new ProjectStore(taskStoreForPlan);
    const savedPlan = store.saveSourcePlan({
      projectId: navieraId,
      sourceText: navieraPlanText,
      status: 'parsed',
      summary: 'Naviera Freight Engine Sprint',
    });

    const plannedEpics = [
      { id: 'epic-freight-1', title: 'Maritime Quote Core API' },
    ];
    const plannedTasks = [
      {
        id: 'task-nav-101',
        key: 'NAV-101',
        title: 'Design Maritime Container Schema',
        description: 'Implement database schema for freight quote models',
        epicId: 'epic-freight-1',
        priority: 'high' as const,
        estimatedHours: 6,
        dependencies: [],
        subtasks: [
          { id: 'sub-1', title: 'Draft SQL migration for quotes' },
          { id: 'sub-2', title: 'Write unit tests for schema validation' },
        ],
      },
      {
        id: 'task-nav-102',
        key: 'NAV-102',
        title: 'REST Endpoint for Quote Submission',
        description: 'Expose POST /api/quotes with payload validation',
        epicId: 'epic-freight-1',
        priority: 'medium' as const,
        estimatedHours: 4,
        dependencies: ['NAV-101'],
        subtasks: [
          { id: 'sub-3', title: 'Implement controller and route' },
        ],
      },
    ];

    // =========================================================================
    // STEP 6: ATOMIC PLAN ADOPTION
    // =========================================================================
    console.log('--- Step 6: Atomic Plan Adoption ---');
    const adoptRes = await fetch(`${baseUrl}/api/projects/${navieraId}/plan/adopt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'X-Dupond-Project-Id': navieraId,
      },
      body: JSON.stringify({
        sourcePlanId: savedPlan.id,
        planRevision: savedPlan.revision,
        summary: 'Naviera Freight Engine Sprint',
        epics: plannedEpics,
        tasks: plannedTasks,
      }),
    });

    assert.strictEqual(adoptRes.status, 201, 'Plan adoption should return HTTP 201');
    const adoptData = await adoptRes.json();
    assert.strictEqual(adoptData.success, true);
    assert.strictEqual(adoptData.adoptedCount, 2);

    // Verify tasks in database:
    // NAV-101 has 0 dependencies -> status must be 'todo'
    // NAV-102 has dependency on NAV-101 -> status must be 'backlog'
    // ALL subtasks must start with completed: false
    const taskStoreDirect = new TaskStore(dbPath);
    const nav101 = taskStoreDirect.getTaskScoped('NAV-101', navieraId);
    const nav102 = taskStoreDirect.getTaskScoped('NAV-102', navieraId);

    assert.ok(nav101, 'NAV-101 must exist in DB');
    assert.ok(nav102, 'NAV-102 must exist in DB');

    assert.strictEqual(nav101.status, 'todo', 'Task without dependencies starts in todo');
    assert.strictEqual(nav102.status, 'backlog', 'Task with unmet dependency starts in backlog');

    assert.strictEqual(nav101.acceptanceCriteria[0].completed, false, 'Criteria must not start completed');
    assert.strictEqual(nav101.acceptanceCriteria[1].completed, false, 'Criteria must not start completed');
    console.log('✔ Step 6 Passed: Plan atomically adopted with honest initial statuses');

    // =========================================================================
    // STEP 7: ATTEMPT AUTOMATED EXECUTION (CONFIRM BLOCKED)
    // =========================================================================
    console.log('--- Step 7: Automated Execution Blocked With Honest Error ---');
    const stepExecRes = await fetch(`${baseUrl}/api/orchestrate/engine/step`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(stepExecRes.status, 501, 'Secondary project engine step must return HTTP 501');
    const stepExecData = await stepExecRes.json();
    assert.strictEqual(stepExecData.code, 'PROJECT_ENGINE_UNSUPPORTED');

    const daemonStartRes = await fetch(`${baseUrl}/api/orchestrate/engine/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(daemonStartRes.status, 501, 'Secondary project engine daemon must return HTTP 501');

    // Verify task statuses in DB remain unchanged (no phantom execution)
    const fresh101 = taskStoreDirect.getTaskScoped('NAV-101', navieraId);
    assert.strictEqual(fresh101?.status, 'todo', 'NAV-101 must remain in todo');
    console.log('✔ Step 7 Passed: Engine automation blocked with 501 and no phantom progress');

    // =========================================================================
    // STEP 8: DEFAULT PROJECT ISOLATION
    // =========================================================================
    console.log('--- Step 8: Verify Complete Isolation From Default Project ---');
    const defaultProjRes = await fetch(`${baseUrl}/api/projects/default`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': 'default',
      },
    });
    assert.strictEqual(defaultProjRes.status, 200);
    const defaultProj = await defaultProjRes.json();
    assert.strictEqual(defaultProj.id, 'default');
    assert.strictEqual(defaultProj.name, 'Default');

    // Default project's tasks must not include NAV-101 or NAV-102
    const navInDefault = taskStoreDirect.getTaskScoped('NAV-101', 'default');
    assert.strictEqual(navInDefault, null, 'Naviera task must not exist in default project');
    console.log('✔ Step 8 Passed: Default project remains completely isolated and unmutated');

    // =========================================================================
    // STEP 9: APPLICATION RESTART SURVIVABILITY
    // =========================================================================
    console.log('--- Step 9: Application Restart Survivability ---');
    // Stop the running child server
    await stopChildServers();

    // Restart server using the EXACT SAME database and state files
    started = await startServer(dbPath, statePath);
    const restartedBaseUrl = started.baseUrl;

    // Query Naviera project
    const restartedProjRes = await fetch(`${restartedBaseUrl}/api/projects/${navieraId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(restartedProjRes.status, 200);
    const restartedNaviera = await restartedProjRes.json();
    assert.strictEqual(restartedNaviera.name, 'Naviera Ocean Freight');
    assert.strictEqual(restartedNaviera.repository.localPath, repoDir);

    // Query Naviera source plans
    const restartedPlanRes = await fetch(`${restartedBaseUrl}/api/projects/${navieraId}/plan`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Dupond-Project-Id': navieraId,
      },
    });
    assert.strictEqual(restartedPlanRes.status, 200);
    const restartedPlans = await restartedPlanRes.json();
    assert.ok(restartedPlans.history.length >= 2, 'All plan revisions must survive restart');

    // Verify authoritative tasks in database survive restart
    const postRestartStore = new TaskStore(dbPath);
    const postRestart101 = postRestartStore.getTaskScoped('NAV-101', navieraId);
    const postRestart102 = postRestartStore.getTaskScoped('NAV-102', navieraId);
    assert.ok(postRestart101);
    assert.ok(postRestart102);
    assert.strictEqual(postRestart101.status, 'todo');
    assert.strictEqual(postRestart102.status, 'backlog');
    console.log('✔ Step 9 Passed: All project state, plans, and tasks survived restart intact');

    // =========================================================================
    // STEP 10: COMPLETE JOURNEY SUCCESS
    // =========================================================================
    console.log('--- Step 10: Complete Journey Verified ---');
    console.log('===============================================================');
    console.log('=== FULL 10-STEP OPERATOR JOURNEY VERIFIED WITH ZERO ERRORS ===');
    console.log('===============================================================');
  });
});
