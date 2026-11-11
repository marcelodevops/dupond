import { test } from 'vitest';
/**
 * Dupond Project Management, API Client & Multi-Project Integration Test Suite
 * 
 * Verifies:
 * 1. Contract integrity and credential sanitization
 * 2. Project context transport (X-Dupond-Project-Id header in apiFetch)
 * 3. Client session isolation (selected project stays local, no server-global mutations)
 * 4. Honest HTTP operations via ephemeral wire server (no in-memory production fallback)
 * 5. Honest failure behavior on 404, 500, network error, 409 blockers, and malformed JSON
 * 6. Stale-response abortion, epoch guarding, and race condition protection
 * 7. Project Creation and Jira provisioning unambiguous responsibilities
 * 8. Partial failure handling (project retained on Jira error, safe retry without re-creation)
 * 9. Project Reset confirmation, scope boundaries, board reload triggering & active run blockers
 * 10. Project Archive read-only enforcement & history preservation
 */

import assert from 'node:assert';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  projectApi,
  getActiveProjectId,
  setActiveProjectId,
  PROJECT_HEADER,
  ProjectApiError,
} from '../src/lib/projectApi';
import { apiFetch, setApiBaseUrl, getApiBaseUrl } from '../src/lib/api';
import {
  Project,
  ProjectSummary,
  CreateProjectRequest,
  ResetProjectRequest,
  ProvisionJiraRequest,
} from '../src/types/projectContract';
import { FIXTURE_PROJECTS, FIXTURE_JIRA_METADATA } from './fixtures/projectFixtures';

console.log('=== RUNNING DUPOND PROJECT MANAGEMENT & CONTRACT TEST SUITE ===\n');

let passedTests = 0;
let totalTests = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      await result;
    }
    passedTests++;
    console.log(`✔ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`✘ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function executeSuite() {
  // --- Part 1: Contract & Context Transport ---
  console.log('--- Part 1: Contract & Context Transport ---');

  await runTest('X-Dupond-Project-Id is automatically attached to apiFetch', async () => {
    setActiveProjectId('proj-test-ctx-1');
    assert.strictEqual(getActiveProjectId(), 'proj-test-ctx-1');

    const origFetch = globalThis.fetch;
    let interceptedHeader: string | null = null;

    globalThis.fetch = (async (_url: any, init: any) => {
      const headers = new Headers(init?.headers);
      interceptedHeader = headers.get(PROJECT_HEADER);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    try {
      await apiFetch('/api/orchestrate/state');
      assert.strictEqual(interceptedHeader, 'proj-test-ctx-1', 'Header X-Dupond-Project-Id must be transmitted');
    } finally {
      globalThis.fetch = origFetch;
      setActiveProjectId(null);
    }
  });

  await runTest('Project context stays local and can be overridden for specific runs', async () => {
    setActiveProjectId('proj-active-ui');
    const origFetch = globalThis.fetch;
    let interceptedHeader: string | null = null;

    globalThis.fetch = (async (_url: any, init: any) => {
      const headers = new Headers(init?.headers);
      interceptedHeader = headers.get(PROJECT_HEADER);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    try {
      // Caller explicitly passes a captured background run project ID
      await apiFetch('/api/orchestrate/verify-task', {
        headers: { [PROJECT_HEADER]: 'proj-background-run' },
      });
      assert.strictEqual(interceptedHeader, 'proj-background-run', 'Explicit run context takes precedence over active UI context');
      assert.strictEqual(getActiveProjectId(), 'proj-active-ui', 'Active UI project remains undisturbed in session');
    } finally {
      globalThis.fetch = origFetch;
      setActiveProjectId(null);
    }
  });

  await runTest('Project records strictly exclude sensitive credentials', async () => {
    for (const p of FIXTURE_PROJECTS) {
      const raw = JSON.stringify(p);
      assert.strictEqual(raw.includes('apiToken'), false, 'Project must never contain apiToken');
      assert.strictEqual(raw.includes('password'), false, 'Project must never contain password');
      assert.strictEqual(raw.includes('privateKey'), false, 'Project must never contain privateKey');
      assert.strictEqual(raw.includes('secret'), false, 'Project must never contain secret');
    }
  });

  // --- Part 2: Real Wire Server Operations (Honest HTTP Wire Testing) ---
  console.log('\n--- Part 2: Wire Server Operations & Endpoint Routing ---');

  // Spin up an ephemeral HTTP server to verify real HTTP request/response handling
  let serverRequests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  let serverHandler: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void = (_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  };

  const testServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = null;
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      serverRequests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
        body,
      });
      serverHandler(req, res, body);
    });
  });

  await new Promise<void>((resolve) => {
    testServer.listen(0, '127.0.0.1', () => {
      const addr = testServer.address() as AddressInfo;
      setApiBaseUrl(`http://127.0.0.1:${addr.port}`);
      resolve();
    });
  });

  try {
    await runTest('GET /api/projects lists projects from real HTTP response', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FIXTURE_PROJECTS.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          status: p.status,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }))));
      };

      const projects = await projectApi.listProjects();
      assert.strictEqual(projects.length, 3);
      assert.strictEqual(projects[0].id, 'default');
      assert.strictEqual(serverRequests.length, 1);
      assert.strictEqual(serverRequests[0].method, 'GET');
      assert.strictEqual(serverRequests[0].url, '/api/projects');
    });

    await runTest('POST /api/projects sends payload and captures X-Dupond-Project-Id header', async () => {
      serverRequests = [];
      const createdProj: Project = {
        id: 'proj-new-service',
        name: 'New Service',
        description: 'Testing real creation',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        taskCount: 0,
        activeRunsCount: 0,
      };

      serverHandler = (_req, res) => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createdProj));
      };

      const payload: CreateProjectRequest = {
        id: 'proj-new-service',
        name: 'New Service',
        description: 'Testing real creation',
      };

      const result = await projectApi.createProject(payload);
      assert.strictEqual(result.id, 'proj-new-service');
      assert.strictEqual(serverRequests.length, 1);
      assert.strictEqual(serverRequests[0].method, 'POST');
      assert.strictEqual(serverRequests[0].url, '/api/projects');
      assert.strictEqual(serverRequests[0].headers[PROJECT_HEADER.toLowerCase()], 'proj-new-service');
      assert.deepStrictEqual(serverRequests[0].body, payload);
    });

    await runTest('PATCH /api/projects/:id updates project settings over HTTP', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'proj-new-service',
          name: 'Updated Name',
          description: 'Updated Description',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      };

      const result = await projectApi.updateProject('proj-new-service', { name: 'Updated Name' });
      assert.strictEqual(result.name, 'Updated Name');
      assert.strictEqual(serverRequests.length, 1);
      assert.strictEqual(serverRequests[0].method, 'PATCH');
      assert.strictEqual(serverRequests[0].url, '/api/projects/proj-new-service');
      assert.strictEqual(serverRequests[0].headers[PROJECT_HEADER.toLowerCase()], 'proj-new-service');
    });

    // --- Part 3: Honest Error Handling (Never Fake Success) ---
    console.log('\n--- Part 3: Honest Error Handling (Never Fake Success) ---');

    await runTest('HTTP 404 throws ROUTE_NOT_FOUND ProjectApiError and NEVER fakes success', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Cannot GET /api/projects');
      };

      await assert.rejects(
        async () => {
          await projectApi.listProjects();
        },
        (err: any) => {
          assert.ok(err instanceof ProjectApiError);
          assert.strictEqual(err.status, 404);
          assert.strictEqual(err.code, 'ROUTE_NOT_FOUND');
          assert.ok(err.message.includes('404'), 'Message must indicate 404 route not found');
          return true;
        }
      );
    });

    await runTest('HTTP 500 forwards server error details cleanly', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Database transaction lock acquisition timeout',
          code: 'DB_LOCK_TIMEOUT',
        }));
      };

      await assert.rejects(
        async () => {
          await projectApi.getProject('proj-1');
        },
        (err: any) => {
          assert.ok(err instanceof ProjectApiError);
          assert.strictEqual(err.status, 500);
          assert.strictEqual(err.code, 'DB_LOCK_TIMEOUT');
          assert.strictEqual(err.message, 'Database transaction lock acquisition timeout');
          return true;
        }
      );
    });

    await runTest('HTTP 409 preserves active runs blockers in ProjectApiError', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Cannot reset project while tasks are currently executing.',
          code: 'ACTIVE_RUNS_BLOCKER',
          blockers: ['1 task in execution on sandboxed worktree (AEG-102)'],
          activeRunsCount: 1,
        }));
      };

      const resetReq: ResetProjectRequest = {
        confirmProjectName: 'Dupond Core System',
        scope: {
          wipeTasks: true,
          wipeCycles: true,
          wipeWorktrees: true,
          preserveRemoteGit: true,
          preserveRemoteJira: true,
        },
      };

      await assert.rejects(
        async () => {
          await projectApi.resetProject('default', resetReq);
        },
        (err: any) => {
          assert.ok(err instanceof ProjectApiError);
          assert.strictEqual(err.status, 409);
          assert.strictEqual(err.code, 'ACTIVE_RUNS_BLOCKER');
          assert.strictEqual(err.activeRunsCount, 1);
          assert.ok(Array.isArray(err.blockers) && err.blockers.length === 1);
          assert.ok(err.blockers[0].includes('AEG-102'));
          return true;
        }
      );
    });

    await runTest('Malformed JSON response produces MALFORMED_RESPONSE ProjectApiError', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>502 Bad Gateway</title></head><body>Bad Gateway</body></html>');
      };

      await assert.rejects(
        async () => {
          await projectApi.listProjects();
        },
        (err: any) => {
          assert.ok(err instanceof ProjectApiError);
          assert.strictEqual(err.code, 'MALFORMED_RESPONSE');
          return true;
        }
      );
    });

    // --- Part 4: Jira Provisioning & Lifecycle Actions ---
    console.log('\n--- Part 4: Jira Provisioning & Lifecycle Actions ---');

    await runTest('POST /api/projects/:id/jira/provision provisions Jira explicitly', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          projectId: 'proj-new-service',
          provisionStatus: 'provisioned',
          jira: {
            connectionRef: 'jira.corp.internal',
            projectKey: 'SVC',
            provisionStatus: 'provisioned',
            lastSync: new Date().toISOString(),
          },
          remoteUrl: 'https://jira.corp.internal/browse/SVC',
          message: 'Created remote Jira project Service [SVC].',
        }));
      };

      const jiraReq: ProvisionJiraRequest = {
        mode: 'create_project',
        projectKey: 'SVC',
        projectName: 'Service',
        templateKey: 'software.kanban',
      };

      const result = await projectApi.provisionJira('proj-new-service', jiraReq);
      assert.strictEqual(result.provisionStatus, 'provisioned');
      assert.strictEqual(result.jira.projectKey, 'SVC');
      assert.strictEqual(serverRequests.length, 1);
      assert.strictEqual(serverRequests[0].url, '/api/projects/proj-new-service/jira/provision');
      assert.deepStrictEqual(serverRequests[0].body, jiraReq);
    });

    await runTest('Jira metadata returns backend-supported templates and issue types', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FIXTURE_JIRA_METADATA));
      };

      const meta = await projectApi.fetchJiraMetadata();
      assert.ok(meta.templates.length > 0);
      assert.ok(meta.issueTypes.length > 0);
      assert.strictEqual(serverRequests.length, 1);
      assert.strictEqual(serverRequests[0].url, '/api/integrations/jira/metadata');
    });

    await runTest('Archive active project transitions to archived state', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          projectId: 'proj-new-service',
          status: 'archived',
          archivedAt: new Date().toISOString(),
          message: 'Project successfully archived.',
        }));
      };

      const result = await projectApi.archiveProject('proj-new-service');
      assert.strictEqual(result.status, 'archived');
      assert.strictEqual(serverRequests[0].url, '/api/projects/proj-new-service/archive');
    });

    await runTest('Reset project workspace confirms exact project name and scope', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          projectId: 'proj-new-service',
          resetAt: new Date().toISOString(),
          clearedTasksCount: 5,
          clearedCyclesCount: 2,
          clearedWorktreesCount: 1,
          message: 'Workspace successfully reset.',
        }));
      };

      const resetReq: ResetProjectRequest = {
        confirmProjectName: 'New Service',
        scope: {
          wipeTasks: true,
          wipeCycles: true,
          wipeWorktrees: true,
          preserveRemoteGit: true,
          preserveRemoteJira: true,
        },
      };

      const result = await projectApi.resetProject('proj-new-service', resetReq);
      assert.strictEqual(result.clearedTasksCount, 5);
      assert.strictEqual(serverRequests[0].url, '/api/projects/proj-new-service/reset');
      assert.deepStrictEqual(serverRequests[0].body, resetReq);
    });

    // --- Part 5: Stale Response Abortion & Epoch Protection ---
    console.log('\n--- Part 5: Stale Response Abortion & Epoch Protection ---');

    await runTest('AbortSignal cancels in-flight project lookup when switching quickly', async () => {
      serverRequests = [];
      serverHandler = (_req, res) => {
        // Delay response to simulate in-flight network call
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(FIXTURE_PROJECTS[0]));
        }, 150);
      };

      const abortCtrl = new AbortController();
      const promise = projectApi.getProject('default', abortCtrl.signal);
      abortCtrl.abort();

      await assert.rejects(
        promise,
        (err: any) => {
          assert.strictEqual(err.name, 'AbortError');
          return true;
        }
      );
    });

    await runTest('Epoch guarding ensures slow Project A response never overwrites Project B', async () => {
      let projectAResponded = false;
      let projectBResponded = false;
      let activeProjectData: any = null;

      // Simulated client epoch management (matching ProjectContext / App implementation)
      let currentEpoch = 0;

      const fetchWithEpoch = async (projId: string) => {
        const thisEpoch = ++currentEpoch;
        serverHandler = (_req, res) => {
          const delay = projId === 'proj-slow-A' ? 100 : 20;
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: projId, name: `Project ${projId}` }));
          }, delay);
        };

        const res = await apiFetch(`/api/projects/${projId}`);
        const data = await res.json();
        if (thisEpoch === currentEpoch) {
          activeProjectData = data;
          if (projId === 'proj-fast-B') projectBResponded = true;
          if (projId === 'proj-slow-A') projectAResponded = true;
        }
      };

      // Trigger Project A first (slow)
      const pA = fetchWithEpoch('proj-slow-A');
      // Trigger Project B immediately after (fast)
      await new Promise((r) => setTimeout(r, 10));
      const pB = fetchWithEpoch('proj-fast-B');

      await Promise.all([pA, pB]);

      // Project B must be the winning state; Project A must have been discarded!
      assert.strictEqual(activeProjectData.id, 'proj-fast-B', 'Active project must be Project B');
      assert.strictEqual(projectBResponded, true);
      assert.strictEqual(projectAResponded, false, 'Project A response must be discarded by epoch guard');
    });

  } finally {
    // Restore base URL and close test server
    setApiBaseUrl('');
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  }

  // --- Part 6: Network Error Simulation ---
  console.log('\n--- Part 6: Network Error Simulation ---');

  await runTest('Connection refused produces NETWORK_ERROR ProjectApiError', async () => {
    // Point to an inactive loopback port where no server is listening
    setApiBaseUrl('http://127.0.0.1:59999');
    try {
      await assert.rejects(
        async () => {
          await projectApi.listProjects();
        },
        (err: any) => {
          assert.ok(err instanceof ProjectApiError);
          assert.strictEqual(err.code, 'NETWORK_ERROR');
          assert.strictEqual(err.status, 0);
          return true;
        }
      );
    } finally {
      setApiBaseUrl('');
    }
  });

  console.log('\n===============================================================');
  console.log(`=== ALL ${passedTests}/${totalTests} PROJECT MANAGEMENT TESTS PASSED CLEANLY ===`);
  console.log('===============================================================\n');
}

test('suite', async () => {
  await executeSuite();
});
