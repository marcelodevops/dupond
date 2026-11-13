# Multi-Project Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement durable, authenticated, isolated multi-project APIs and connect them to the existing project-aware frontend without weakening Dupond’s execution safeguards.

**Architecture:** SQLite remains authoritative for projects, project ownership, task/run records, Jira connection references, provisioning operations, and per-project state. A project router is mounted after auth and before the SPA fallback; legacy resource endpoints use resource ownership plus `X-Dupond-Project-Id` validation. The existing worker, verifier, lifecycle, sandbox, and GitHub delivery paths are extended with immutable project context rather than replaced.

**Tech Stack:** Node.js 22+, TypeScript ESM, Express, `node:sqlite`, Zod, React 19, Vite, Vitest, Git worktrees, macOS Seatbelt/Linux Podman or Docker, Jira Cloud REST.

**Spec:** `docs/superpowers/specs/2026-11-11-multi-project-backend-design.md`

## Global Constraints

- Never introduce a server-global active project.
- Never return credentials in project records or API responses.
- Preserve existing protected-path, sandbox, evidence-binding, approval, drift-reconciliation, and delivery safeguards.
- Project reset preserves remote GitHub/Jira resources and all other projects.
- Jira tests use an injected fake transport and never create real remote resources.
- Unknown `/api/*` requests return JSON 404 before the frontend fallback.
- Do not merge or release.

## File map

- Create `src/server/projects/projectStore.ts`: project CRUD, migration-facing project state access, ownership checks, reset/archive blockers, and server-held Jira connection/operation persistence.
- Create `src/server/projects/projectApi.ts`: authenticated project router, request validation, context validation, and error envelopes.
- Create `src/server/projects/jiraProvisioner.ts`: read-only link validation, confirmed remote creation, retry identity, reconciliation, and injected transport.
- Modify `src/types/projectContract.ts`: align the shared contract with actual frontend requests and structured backend responses.
- Modify `src/server/db/schema.ts` and `src/server/db/database.ts`: project tables, per-project state, foreign-key-safe ownership columns, migrations, and scoped accessors.
- Modify `src/server/coordinator.ts`: load/save/project state projection and context-aware state mutation.
- Modify `src/server/coordinator/repairCoordinator.ts`, `src/server/lifecycle/lifecycleService.ts`, `src/server/delivery/githubDelivery.ts`, and `server.ts`: propagate and validate immutable project context.
- Modify `src/lib/projectApi.ts`, `src/context/ProjectContext.tsx`, `src/App.tsx`, and `src/components/ProjectWizardModal.tsx`: contract alignment, capability/error states, and reset/Jira behavior.
- Create `tests/projectBackend.test.ts`: disposable authenticated HTTP integration coverage.
- Modify `tests/projectManagement.test.ts` only where the corrected public contract changes existing expectations.

### Task 1: Add failing backend integration coverage and test harness

**Files:**
- Create: `tests/projectBackend.test.ts`
- Modify: `tests/fixtures/projectFixtures.ts` only if shared fixture types need the corrected contract.

**Interfaces:**
- Consumes: current `server.ts` application behavior, `DUPOND_DB_PATH`, `DUPOND_STATE_FILE`, and the existing auth token mechanism.
- Produces: named failing tests that define the HTTP, migration, isolation, restart, 404, archive/reset, and Jira transport requirements for later tasks.

- [ ] **Step 1: Build disposable server/storage helpers**

Create helpers that:

```ts
const dbPath = path.join(tempDir, 'dupond.db');
const statePath = path.join(tempDir, 'dupond_state.json');
process.env.DUPOND_DB_PATH = dbPath;
process.env.DUPOND_STATE_FILE = statePath;
```

Start an authenticated HTTP server on an ephemeral port, send `Authorization: Bearer <token>`, and close it plus all temporary resources in `afterEach`.

- [ ] **Step 2: Add tests for the required behaviors**

Add test names with these assertions:

```ts
it('returns JSON 404 for an unknown API route');
it('creates and lists projects with durable repository and preference data');
it('migrates existing single-project rows into the default project');
it('keeps project A and project B tasks and state isolated');
it('persists projects and scoped tasks after a fresh server/store instance');
it('rejects a project B resource ID under project A context');
it('blocks archive and reset while a project has active work');
it('resets only local project data and preserves Jira/Git mappings');
it('uses fake Jira transport for link, confirmed create, replay, and failure');
```

- [ ] **Step 3: Run the new file and confirm it fails for missing routes/storage**

Run:

```bash
npm test -- tests/projectBackend.test.ts
```

Expected: failures show the current missing `/api/projects` routes, missing project persistence, or missing isolation behavior rather than silently accepting fixture responses.

### Task 2: Add SQLite project schema, migration, and scoped storage

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/database.ts`
- Create: `src/server/projects/projectStore.ts`
- Test: `tests/projectBackend.test.ts`

**Interfaces:**
- Consumes: existing `TaskStore`, `TaskRecord`, `TaskRunRecord`, `AuditEventRecord`, and current project contract types.
- Produces: `ProjectStore`, `defaultProjectStore`, `ProjectApiError`, and scoped methods such as `getProject`, `listProjects`, `createProject`, `updateProject`, `archiveProject`, `resetProject`, `getProjectIdForTask`, `getProjectIdForRun`, `getProjectState`, `saveProjectState`, and Jira connection/operation methods.

- [ ] **Step 1: Extend schema types and DDL**

Add project fields to task/run/audit records and create tables for:

```sql
projects(id PRIMARY KEY, name, description, status, repository_config,
         jira_connection_ref, jira_project_key, jira_epic_key,
         jira_provision_status, preferences, state_json,
         created_at, updated_at, archived_at);
jira_connections(id PRIMARY KEY, project_id REFERENCES projects(id),
                 host_url, user_email, api_token_enc, created_at, updated_at);
jira_operations(id PRIMARY KEY, project_id REFERENCES projects(id),
                operation_id, request_fingerprint, status, result_json,
                remote_key, error_json, created_at, updated_at);
```

Use a unique `(project_id, operation_id)` constraint and indexes for every scoped resource lookup.

- [ ] **Step 2: Implement an idempotent migration**

In `TaskStore.init()`, create missing tables/columns inside one immediate transaction, seed the canonical `default` project, backfill all existing tasks/runs/audits to `default`, and import the existing JSON state only when the default project has no stored state. Preserve row IDs and historical records.

- [ ] **Step 3: Add scoped accessors and ownership probes**

Implement methods that return null or an explicit project mismatch without falling back:

```ts
getTaskScoped(idOrKey: string, projectId: string): TaskRecord | null;
getRunScoped(runId: string, projectId: string): TaskRunRecord | null;
getProjectIdForTask(idOrKey: string): string | null;
getProjectIdForRun(runId: string): string | null;
listTasks(statusFilter?: string, projectId?: string): TaskRecord[];
```

Ensure every new run inherits the task’s project and target repository snapshot.

- [ ] **Step 4: Implement project reset/archive guards**

Treat `pending`, `running`, claimed tasks, and active worktrees as blockers. Archive marks only the project archived. Reset deletes only selected local rows/paths owned by the project, restores affected tasks to `todo`, and leaves remote mappings and other projects untouched.

- [ ] **Step 5: Run focused persistence tests**

Run:

```bash
npm test -- tests/projectBackend.test.ts -t "migrates|persists|archive|reset"
```

Expected: migration, restart, blocker, and preservation tests pass.

### Task 3: Implement project HTTP routes and API 404 handling

**Files:**
- Create: `src/server/projects/projectApi.ts`
- Modify: `server.ts`
- Modify: `src/types/projectContract.ts`
- Test: `tests/projectBackend.test.ts`

**Interfaces:**
- Consumes: `ProjectStore`, current frontend payloads, `requireAuth`, and `PROJECT_HEADER`.
- Produces: `createProjectRouter()`, `parseProjectContextHeader()`, and JSON error envelopes compatible with `ProjectApiError`.

- [ ] **Step 1: Align the shared contract**

Keep the current frontend fields (`repoUrl`, `localPath`, `defaultBranch`, `targetDirectory`, `localWriteMode`, Jira modes, reset confirmation/scope) and add explicit remote-creation confirmation, opaque connection reference, operation identity, capability/unsupported fields, and structured Jira errors without adding credentials to project response types.

- [ ] **Step 2: Add route validation**

Use strict Zod schemas for project IDs, names, descriptions, repository config, preferences, reset confirmation, and Jira requests. Reject credential fields in public project payloads. Validate route project IDs against `X-Dupond-Project-Id` for mutations.

- [ ] **Step 3: Add all project routes**

Implement:

```ts
GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
POST   /api/projects/:projectId/archive
POST   /api/projects/:projectId/reset
POST   /api/projects/:projectId/jira/provision
GET    /api/integrations/jira/metadata
```

Return the raw `ProjectSummary[]` array expected by `projectApi.listProjects()`, the current archive/reset response shapes, and honest 4xx/5xx errors.

- [ ] **Step 4: Mount routes and the API JSON 404**

Mount `app.use(requireAuth)` first, then `app.use('/api', createProjectRouter())`, keep all existing API handlers before Vite/static middleware, and add:

```ts
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found', code: 'API_NOT_FOUND' });
});
```

- [ ] **Step 5: Verify routing and auth**

Run:

```bash
npm test -- tests/projectBackend.test.ts -t "JSON 404|creates and lists projects"
```

Expected: unauthenticated requests remain rejected, authenticated project requests return JSON, and unknown API paths never return HTML.

### Task 4: Scope coordinator state and execution lifecycle

**Files:**
- Modify: `src/server/coordinator.ts`
- Modify: `server.ts`
- Modify: `src/server/coordinator/repairCoordinator.ts`
- Modify: `src/server/lifecycle/lifecycleService.ts`
- Modify: `src/server/delivery/githubDelivery.ts`
- Modify: `src/server/db/database.ts`
- Test: `tests/projectBackend.test.ts`, existing lifecycle/delivery suites.

**Interfaces:**
- Consumes: `ProjectStore` ownership methods and `X-Dupond-Project-Id`.
- Produces: project-scoped state reads/writes and immutable project-aware task/run execution.

- [ ] **Step 1: Load and save per-project state**

Refactor coordinator state access so `getStateView(projectId)` and `updateState(partial, { projectId })` read/write the selected project’s state. The default migration must preserve existing board data. No request may mutate a different project’s task, agent, epic, communication, configuration, or integration state.

- [ ] **Step 2: Require context for board operations**

For `/api/orchestrate/state`, reject missing or unknown project context once the project API is active. For resource endpoints, derive ownership from the task/run ID and reject an explicit header mismatch with `PROJECT_CONTEXT_MISMATCH`.

- [ ] **Step 3: Propagate project identity through runs**

When `executeWorkerStep`, `executeTaskRun`, `createTask`, and `createRun` operate on a task, assert the project is active and copy `projectId` plus resolved repository identity into the run. Archived projects fail closed before worktree creation.

- [ ] **Step 4: Guard lifecycle, evidence, approval, and delivery**

Before transition, verification, delivery, or run lookup, compare the resource’s stored project to the request context. Preserve existing evidence and approval guards; only add ownership checks and project archive checks.

- [ ] **Step 5: Run existing lifecycle and new isolation tests**

Run:

```bash
npm test -- tests/acceptanceEvidenceLifecycle.test.ts tests/delivery.test.ts tests/remoteBaseDriftAndTargetRepo.test.ts tests/projectBackend.test.ts
```

Expected: existing acceptance/delivery behavior remains passing and cross-project resource IDs are rejected.

### Task 5: Implement Jira provisioning with safe retries

**Files:**
- Create: `src/server/projects/jiraProvisioner.ts`
- Modify: `src/server/integrations/jira.ts` only to share validated host/transport helpers where useful.
- Modify: `src/server/projects/projectApi.ts`
- Modify: `src/types/projectContract.ts`
- Modify: `src/components/ProjectWizardModal.tsx`
- Test: `tests/projectBackend.test.ts`, `tests/projectManagement.test.ts`

**Interfaces:**
- Consumes: server-held Jira configuration, `safeRequest`, `ProjectStore`, and a transport interface injectable in tests.
- Produces: `JiraProvisioner.provision()` with link/create/reconcile/failure outcomes and metadata capabilities.

- [ ] **Step 1: Define the transport and fake test implementation**

Use:

```ts
interface JiraTransport {
  request(spec: {
    hostUrl: string;
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    auth: { userEmail: string; apiToken: string };
  }): Promise<{ status: number; body: unknown }>;
}
```

The production implementation uses `safeRequest` and the `.atlassian.net` allowlist; tests inject an in-memory response map.

- [ ] **Step 2: Implement validated link and explicit creation**

Linking probes the project and optional epic read-only. Project/epic creation requires `confirmRemoteCreation === true`, validates supported templates/issue types, reconciles by remote key/summary before create, and persists the operation result.

- [ ] **Step 3: Implement server-held connection references**

Accept an opaque existing `connectionRef` or a setup credential only at the server boundary, encrypt/token-store it, and return only the connection reference and public Jira mapping. Reject credential-shaped fields in project responses.

- [ ] **Step 4: Implement partial failure and replay**

Persist `operationId` plus a request fingerprint before the remote call. Same operation and same request replays the persisted result; same operation with changed input returns conflict. Preserve the local project on Jira failure and return structured `unsupported`, `permission`, or `remote` errors.

- [ ] **Step 5: Integrate wizard capability and confirmation state**

Pass explicit confirmation and operation identity from the wizard, disable only unsupported Jira creation options, keep the local project on partial failure, and make retry reuse the persisted operation identity.

- [ ] **Step 6: Run Jira-focused tests**

Run:

```bash
npm test -- tests/projectBackend.test.ts tests/projectManagement.test.ts -t "Jira|jira|provision"
```

Expected: no live Jira host is contacted and link/create/retry/partial-failure behavior is honest.

### Task 6: Finish frontend project-state integration

**Files:**
- Modify: `src/lib/projectApi.ts`
- Modify: `src/context/ProjectContext.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/ProjectWizardModal.tsx`
- Modify: `src/components/ProjectLifecycleModal.tsx`
- Modify: `src/components/EmptyProjectView.tsx`
- Test: `tests/projectManagement.test.ts`, `tests/uiAuthClient.test.ts`, `tests/uiAuthGate.test.ts`

**Interfaces:**
- Consumes: real project route response/error envelopes and project-scoped state endpoints.
- Produces: explicit loading/empty/error/unsupported UI states and stale-response-safe switching/reset.

- [ ] **Step 1: Normalize project API response handling**

Keep `ProjectApiError` for network, 404, 409, malformed JSON, and unsupported capability responses. Do not add fixture fallback or treat an HTML response as success.

- [ ] **Step 2: Preserve context and stale-response guards**

Ensure all project-owned requests carry the active project header, switching aborts prior requests, clears the board immediately, and only the current epoch/project can apply a response.

- [ ] **Step 3: Reload after reset and handle archive**

After reset, invalidate board state, reload the project and board, and preserve the remote Jira/Git configuration in the rendered project. Archived projects render read-only controls and cannot submit mutations.

- [ ] **Step 4: Add unsupported and empty states**

Render distinct states for no projects, loading, API failure, and backend capability unsupported. Do not silently display bundled seed tasks as server-backed project data.

- [ ] **Step 5: Run frontend integration tests**

Run:

```bash
npm test -- tests/projectManagement.test.ts tests/uiAuthClient.test.ts tests/uiAuthGate.test.ts
```

Expected: transport, delayed switching, empty/error, and reset refresh behavior pass against real HTTP test servers.

### Task 7: Complete verification and migration documentation

**Files:**
- Modify: `docs/architecture-and-sandbox.md`
- Modify: `docs/walkthrough.md`
- Modify: `README.md` only for confirmed command/API behavior.
- Test: all existing tests.

**Interfaces:**
- Consumes: the implemented routes, migration behavior, and final test commands.
- Produces: accurate migration/operation documentation and verification evidence.

- [ ] **Step 1: Document migration and project context**

Document default-project migration, `X-Dupond-Project-Id`, project archive/reset guarantees, resource ownership errors, and the JSON API 404 behavior.

- [ ] **Step 2: Document Jira limitations**

Document server-held connections, explicit remote confirmation, fake transport tests, retry identity, and structured unsupported/partial-failure outcomes.

- [ ] **Step 3: Run full validation**

Run:

```bash
npm run lint
npm run build
npm test
npm run release:check
git diff --check
```

Expected: all commands pass without weakening or skipping existing tests.

- [ ] **Step 4: Review final diff and remaining limitations**

Confirm no real Jira resource was created, no merge/release command was run, project A/B disposable checks passed after restart, and any unsupported Jira capability is stated explicitly in the final handoff.
