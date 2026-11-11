# Dupond Multi-Project Backend Design

## Goal

Turn the existing frontend project client into a real, durable, isolated multi-project backend without weakening the existing task-to-PR acceptance, sandbox, approval, or delivery safeguards.

## Reuse boundary

The dirty Qoder worktree at `.qoder/worktrees/feat-multi-project-backend` contains reusable ideas and partial implementations for project persistence, project routing, project IDs on task/run records, Jira connection storage, and idempotent Jira operations. It is not merged directly because it diverges from the current frontend contract, has incompatible response shapes, treats missing context as a shared default, and does not isolate all coordinator state.

## Data model and migration

SQLite remains authoritative. Initialization adds idempotent migrations for:

- A canonical `default` project seeded from the existing single-project installation.
- `project_id` on tasks, runs, and audit records, backfilled to `default` without changing existing IDs or history.
- Durable project metadata: name, description, status, repository configuration, Jira public mapping, agent preferences, timestamps, and archive time.
- Per-project coordinator state so tasks, agents, epics, communications, cycle state, and integration configuration cannot leak between projects.
- Server-held Jira connections and persisted provisioning operations. Project responses expose only opaque connection references and public mappings; credentials never leave the server.

Existing JSON state is imported into the default project on first migration. It remains readable for compatibility, but new project-scoped reads and writes use the durable per-project state representation.

## HTTP routing and contract

After authentication, mount the project router before Vite/static middleware. Implement:

- `GET/POST /api/projects`
- `GET/PATCH /api/projects/:projectId`
- `POST /api/projects/:projectId/archive`
- `POST /api/projects/:projectId/reset`
- `POST /api/projects/:projectId/jira/provision`
- `GET /api/integrations/jira/metadata`

Responses must match the current `src/types/projectContract.ts` and `src/lib/projectApi.ts` shapes. Unknown `/api/*` requests receive a JSON 404 before the frontend fallback; they must never receive `index.html`.

Project-scoped paths validate the project ID and `X-Dupond-Project-Id`. Existing resource endpoints derive ownership from the resource ID when possible and reject explicit header mismatches. No server-global active project is introduced. Board state endpoints require project context once project loading is available; project listing and creation remain context-free.

## Isolation rules

- Every task, run, verification, approval, delivery, audit event, coordinator state mutation, and integration operation is scoped to one project.
- Resource IDs are checked server-side before reads or mutations. A valid ID belonging to another project is a project-context error, not an opportunity to fall back.
- Runs capture project ID and repository identity at creation and never follow later UI/project configuration changes.
- Archived projects remain readable but cannot start execution, mutate the board, provision Jira, or deliver work.
- Archive and reset reject active/pending/running runs and claimed work. Reset deletes only selected local project data, restores affected local tasks to a safe non-acceptance state, and never deletes remote GitHub/Jira resources or other projects.
- Existing worktree containment, protected-path checks, evidence fingerprints, approval binding, drift reconciliation, and sandbox behavior remain unchanged except for project ownership checks around them.

## Jira behavior

Jira provisioning uses an injected transport in tests and the existing SSRF-safe egress path in production.

- `link_existing` performs read-only validation of the Jira project and optional epic before persisting the mapping.
- `create_project` and `create_epic` require explicit remote-creation confirmation.
- A server-held connection reference is required; credentials submitted during setup are stored server-side and never echoed.
- An operation ID and request fingerprint are persisted. Retrying the same operation returns the recorded outcome or reconciles an already-created remote resource instead of pretending success.
- Partial failure preserves the local Dupond project and returns structured error data for retry.
- Unsupported credentials, templates, permissions, or capabilities return structured errors/unsupported metadata; no fake Jira success is returned.
- Development and tests use fake Jira transport and never create real remote resources.

## Frontend integration

Keep the existing honest API client behavior. Update only contract mismatches needed for the real backend, including explicit remote-creation confirmation and server capability/unsupported states. Preserve project-switch abort/epoch guards, clear stale board data immediately on switch, reload after reset, and distinguish loading, empty, unsupported, and API-error states.

## Verification

Add focused server-backed tests with disposable SQLite and JSON/state paths covering:

1. Authenticated project list/create/get/update/archive/reset HTTP behavior.
2. Default-project migration and restart persistence.
3. Distinct project A/B tasks and configuration with no cross-project reads or writes.
4. Cross-project task/run/evidence/approval/delivery ID rejection.
5. Active-run archive/reset blockers and preservation of remote mappings/other projects.
6. Unknown API JSON 404 behavior before the SPA fallback.
7. Delayed project switching and stale-response protection.
8. Jira link/create/retry/partial-failure behavior using a fake transport and zero real network calls.

Run the existing full Vitest suite, TypeScript check, Vite build, and release consistency check. Do not merge or release.
