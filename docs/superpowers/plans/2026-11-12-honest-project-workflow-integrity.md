# Honest Project Workflow & Multi-Project Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair Dupond's existing multi-project lifecycle so that project creation, repository configuration, real plan ingestion, authoritative task adoption, explicit error handling, and unsupported execution reporting are honest, isolated, and reliable without expanding automation capabilities.

**Architecture:**
- **Planner Pipeline**: Eliminate fabricated fallbacks from `parsePlan`. Enforce structured errors (`PLANNER_UNAVAILABLE`, `PLAN_PARSING_FAILED`) when Gemini credentials or calls fail. Persist submitted plan source text, revision history, and ingestion outcomes in SQLite `project_source_plans` table.
- **Authoritative Storage & Isolation**: Enforce `projectId` scoping across all `TaskStore` read/write operations (`getTask`, `listTasks`, `updateTaskRequirements`, `createTask`, `deleteTask`). Atomic backend plan adoption route (`POST /api/projects/:projectId/plan/adopt`) that validates DAG dependencies, creates authoritative `tasks` rows, links plan revisions, and projects board state within an immediate SQLite transaction.
- **Context & Error Propagation**: Require `X-Dupond-Project-Id` on all project-sensitive endpoints; reject missing or mismatched context with HTTP 400/403/404 without defaulting to `default`. Retain explicit HTTP 501 for non-default engine automation and render clear, persistent capability limits in the UI rather than misleading informational toasts.
- **Project Settings & Readiness**: Provide a dedicated `ProjectSettingsModal` that reads and updates project metadata, repository configuration, and provider preferences via `PATCH /api/projects/:projectId`. Implement server-side repository and branch verification (`POST /api/projects/:projectId/repository/verify`) checking real `.git` repositories/worktrees without executing remote operations.

**Tech Stack:**
- TypeScript, Node.js (v24/26, `node:sqlite`), Express
- React 18, TailwindCSS, Lucide React, Vitest

**Spec Reference:**
- `dupond_naviera_investigation_report.md`
- `dupond_naviera_investigation_addendum.md`

## Global Constraints
- **Zero Fabricated Tasks**: Canned sprint tasks (`AEG-101`..`105`) must never be generated, adopted, or displayed in normal project workflows.
- **Strict Project Isolation**: No task, requirement, audit event, run, verification, or state projection may resolve or modify data across project boundaries.
- **Atomic Operations**: Plan adoption and settings updates must execute in single write transactions; partial failures trigger complete rollbacks.
- **Preserved Input & Re-entrance**: User input must survive failures. Stale plan breakdowns cannot be adopted if input text changes or if the active project switches.
- **Unsupported Capabilities Remain Disabled**: Non-default engine automation must remain explicitly unsupported (HTTP 501) with persistent UI explanations.
- **No Production Database Modifications**: Do not run migrations or resets against `/Users/mac/ops/repos/dupond-agent/data/dupond.db`. All tests use disposable SQLite databases in `os.tmpdir()`.

---

## File Structure & Ownership Map

### Backend (Server & Database)
- `src/server/planning/planBreakdown.ts`: Strip `generateFallbackPlanBreakdown`. Add structured Gemini error handling and validation.
- `src/server/db/schema.ts`: Add `project_source_plans` DDL. Add constraints ensuring task uniqueness per project.
- `src/server/db/database.ts`: Update `TaskStore` methods (`getTask`, `getTaskScoped`, `listTasks`, `updateTaskRequirements`, `createTask`) to require `projectId`. Implement source plan storage and atomic plan adoption transactions.
- `src/server/coordinator.ts`: Refactor `updateStateInternal` and `projectAuthoritativeStatusesInternal` to strictly isolate by project. Remove cross-project fallbacks.
- `src/server/projects/projectApi.ts`: Add plan source ingestion, adoption endpoint, and repository verification endpoint.
- `src/server/projects/projectStore.ts`: Support source plans, plan revisions, and repository verification.
- `server.ts`: Mount new project plan and verification routes. Enforce project context checking on all orchestrator routes.

### Frontend (Client & State)
- `src/types/projectContract.ts`: Add types for `ProjectSourcePlan`, `AdoptPlanRequest`, `AdoptPlanResponse`, and `RepositoryVerificationResult`.
- `src/lib/projectApi.ts`: Add client methods for plan ingestion, atomic adoption, settings updates, and repository verification.
- `src/lib/api.ts`: Enhance `apiFetch` error propagation with structured error payloads.
- `src/components/PlanIngestionModal.tsx`: Show real provider readiness, display persistent errors, invalidate previews on input edit, preserve textarea on failure, guard against project switching.
- `src/components/ProjectSettingsModal.tsx`: Create full settings window with save/cancel, dirty-state tracking, and live repository verification.
- `src/components/Header.tsx`: Connect Settings button, disable Auto-Pilot on non-default projects with tooltip explanation.
- `src/App.tsx`: Prevent adoption race conditions, handle persistent blocking errors, disable Next Cycle with clear messaging.

### Tests
- `tests/honestPlanning.test.ts`: Verify missing credentials, malformed output, source plan persistence, and no fabricated fallbacks.
- `tests/projectIsolationAdoption.test.ts`: Verify colliding task IDs across projects, atomic adoption rollback, zero cross-project leakage.
- `tests/errorVisibilityAndContext.test.ts`: Verify HTTP 400/403/501 handling, persistent UI error states, and unmasked network failures.
- `tests/projectSettingsReadiness.test.ts`: Verify settings save/cancel, repository verification on normal repos vs worktrees, and dirty-state handling.
- `tests/completeProjectJourney.test.ts`: End-to-end integration test of the full user journey in isolated disposable storage.

---

## Implementation Tasks

### Task 1: Stage 1 — Honest Planning & Source Plan Persistence (Backend)

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/database.ts`
- Modify: `src/server/planning/planBreakdown.ts`
- Modify: `src/server/projects/projectStore.ts`
- Modify: `src/server/projects/projectApi.ts`
- Test: `tests/honestPlanning.test.ts`

- [ ] **Step 1.1**: Write failing tests in `tests/honestPlanning.test.ts` verifying:
  - When `GEMINI_API_KEY` is missing, `parsePlan` throws/returns structured `PLANNER_UNAVAILABLE` error (no canned tasks).
  - When Gemini returns malformed JSON or schema-invalid data, throws `PLAN_PARSING_FAILED`.
  - Source plans are persisted with revision number, timestamp, raw content, and status in SQLite `project_source_plans`.
- [ ] **Step 1.2**: Update `src/server/db/schema.ts` and `src/server/db/database.ts` to create table `project_source_plans` (`id`, `project_id`, `revision`, `source_text`, `status`, `summary`, `error_message`, `created_at`).
- [ ] **Step 1.3**: In `src/server/planning/planBreakdown.ts`, remove `generateFallbackPlanBreakdown`. Throw `DomainError` with code `PLANNER_UNAVAILABLE` when key is absent, and `PLAN_PARSING_FAILED` on parse errors.
- [ ] **Step 1.4**: In `src/server/projects/projectApi.ts`, add `POST /api/projects/:projectId/plan/parse` that persists the source text to `project_source_plans` and calls `parsePlan`.
- [ ] **Step 1.5**: Run `tests/honestPlanning.test.ts` to confirm all pass.
- [ ] **Step 1.6**: Commit as `feat(planning): remove fabricated plan fallbacks and persist source plans`.

---

### Task 2: Stage 1 — Honest Planning & Preserved Input (Frontend)

**Files:**
- Modify: `src/types/projectContract.ts`
- Modify: `src/lib/projectApi.ts`
- Modify: `src/components/PlanIngestionModal.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 2.1**: Update `src/types/projectContract.ts` to define `ProjectSourcePlan`, `PlanDecompositionResult`, and error interfaces.
- [ ] **Step 2.2**: Update `PlanIngestionModal.tsx`:
  - Show planner status banner: "Planning Provider: Gemini (gemini-3.8-flash) • [Ready | Key Missing]".
  - On decompose failure, render persistent red alert banner with error message and troubleshooting advice.
  - Keep submitted plan text in the textarea; do not clear.
  - Disable "Adopt Plan" when decomposition has failed or is stale.
  - Invalidate parsed preview as soon as textarea text changes.
  - Capture current `projectId` at time of request; discard response if user switches projects while decomposing.
- [ ] **Step 2.3**: Run frontend unit tests to ensure UI modal renders cleanly.
- [ ] **Step 2.4**: Commit as `feat(ui): display honest planning readiness and preserve unparsed inputs`.

---

### Task 3: Stage 2 — Project Isolation in Database & Task Store

**Files:**
- Modify: `src/server/db/database.ts`
- Modify: `src/server/coordinator.ts`
- Test: `tests/projectIsolationAdoption.test.ts`

- [ ] **Step 3.1**: Write failing tests in `tests/projectIsolationAdoption.test.ts`:
  - Project A and Project B can have tasks with identical key `AEG-101`.
  - Calling `getTask('AEG-101', 'project-a')` returns Project A's task; `getTask('AEG-101', 'project-b')` returns Project B's task.
  - Updating requirements in Project A does NOT touch Project B or log audit events in Project B.
- [ ] **Step 3.2**: Refactor `TaskStore` in `src/server/db/database.ts`:
  - Make `getTask(idOrKey: string, projectId: string)` require `projectId`.
  - Ensure `updateTaskRequirements(taskId: string, updates: ..., actor: string, projectId: string)` validates project ownership.
  - Ensure `listTasks(statusFilter?: string, projectId?: string)` requires `projectId` unless explicit system migration.
- [ ] **Step 3.3**: Refactor `src/server/coordinator.ts`:
  - In `updateStateInternal`, only look up and update tasks belonging to the active project context.
  - In `projectAuthoritativeStatusesInternal`, query `taskStore.listTasks(undefined, this.activeProjectId)`.
- [ ] **Step 3.4**: Run `tests/projectIsolationAdoption.test.ts` to confirm pass.
- [ ] **Step 3.5**: Commit as `fix(db): enforce strict project scoping across task queries and mutations`.

---

### Task 4: Stage 2 — Atomic Plan Adoption Transaction

**Files:**
- Modify: `src/server/db/database.ts`
- Modify: `src/server/projects/projectStore.ts`
- Modify: `src/server/projects/projectApi.ts`
- Modify: `src/components/PlanIngestionModal.tsx`
- Modify: `src/App.tsx`
- Test: `tests/projectIsolationAdoption.test.ts`

- [ ] **Step 4.1**: Write failing tests for atomic adoption:
  - Adopting a plan with 5 tasks inserts 5 rows into `tasks` table with `project_id = targetProjectId`.
  - All tasks start in `backlog` (or `todo` if 0 dependencies), with `spentHours = 0`, subtasks `completed = false`.
  - Circular dependencies or references to non-existent tasks cause transaction rollback with HTTP 400 `INVALID_DEPENDENCIES`.
  - Partial insertion failure rolls back all tasks, leaving previous state intact.
- [ ] **Step 4.2**: Implement `adoptPlanTransaction` in `projectStore.ts` and route `POST /api/projects/:projectId/plan/adopt`.
- [ ] **Step 4.3**: Update `PlanIngestionModal.tsx` and `App.tsx`:
  - `handleConfirmAdopt` calls `projectApi.adoptPlan(projectId, payload)`.
  - Disable adopt button during submission (prevent double-clicks).
  - Only show success toast and close modal AFTER backend confirms adoption.
  - On error, keep modal open, retain plan and breakdown preview, and show actionable error banner.
- [ ] **Step 4.4**: Run adoption tests to confirm pass.
- [ ] **Step 4.5**: Commit as `feat(adoption): implement atomic plan adoption transaction and error resilience`.

---

### Task 5: Stage 3 — Explicit Context & Error Visibility

**Files:**
- Modify: `server.ts`
- Modify: `src/server/projects/projectApi.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/Header.tsx`
- Test: `tests/errorVisibilityAndContext.test.ts`

- [ ] **Step 5.1**: Write tests verifying:
  - Any request to `/api/orchestrate/*` without `X-Dupond-Project-Id` fails with HTTP 400 `PROJECT_CONTEXT_REQUIRED`.
  - Mismatched task / project context fails with HTTP 403 `PROJECT_CONTEXT_MISMATCH`.
  - Engine step / start on non-default project returns HTTP 501 `PROJECT_ENGINE_UNSUPPORTED`.
- [ ] **Step 5.2**: Update `server.ts` to enforce `projectContext` across all remaining routes.
- [ ] **Step 5.3**: Update `Header.tsx` and `App.tsx`:
  - For non-default projects, show badge "Manual Workflow Only" next to Next Cycle / Auto-Pilot.
  - Disable Auto-Pilot button with tooltip: "Automated engine daemon is not supported for secondary projects. Use manual transitions."
  - If `handleRunServerCycle` encounters HTTP 501, show persistent callout banner: "Automation Unavailable: Automated cycle execution is not supported for this project." (Never show "No eligible tasks ready").
- [ ] **Step 5.4**: Run error visibility tests to confirm pass.
- [ ] **Step 5.5**: Commit as `feat(context): enforce explicit project context and honest error visibility`.

---

### Task 6: Stage 4 — Project Settings & Server-Side Repository Verification

**Files:**
- Create: `src/components/ProjectSettingsModal.tsx`
- Modify: `src/components/Header.tsx`
- Modify: `src/types/projectContract.ts`
- Modify: `src/lib/projectApi.ts`
- Modify: `src/server/projects/projectApi.ts`
- Modify: `src/server/projects/projectStore.ts`
- Modify: `src/server/workspace/targetRepositoryResolver.ts`
- Test: `tests/projectSettingsReadiness.test.ts`

- [ ] **Step 6.1**: Write tests in `tests/projectSettingsReadiness.test.ts`:
  - `POST /api/projects/:projectId/repository/verify` checks:
    - Path exists on disk and is a valid Git repo or worktree (`git rev-parse --git-dir`).
    - Validates target branch exists locally (`git rev-parse --verify <branch>`).
    - Distinguishes non-existent path vs valid repo vs wrong branch.
    - Does not alter repo or contact remote.
- [ ] **Step 6.2**: Implement `verifyProjectRepository` in backend (`projectStore.ts` and `projectApi.ts`).
- [ ] **Step 6.3**: Build `ProjectSettingsModal.tsx`:
  - Tabs/Sections: General (Name, Mission), Repository (Local Path, URL, Branch, Write Mode), Providers & Readiness.
  - "Verify Repository" button that queries the verification endpoint and displays green/red status badge.
  - Provider Readiness section showing:
    - Planning: Gemini (`gemini-3.8-flash`) — Status: [Key Configured | Key Missing].
    - Execution Worker: [Gemini | OpenAI] — Status based on environment keys.
  - Save button with dirty-state checking and server confirmation; Cancel button with discard confirmation.
- [ ] **Step 6.4**: Integrate `ProjectSettingsModal` into `Header.tsx` with a gear icon button.
- [ ] **Step 6.5**: Run tests to confirm pass.
- [ ] **Step 6.6**: Commit as `feat(settings): introduce project settings window and server-side repo verification`.

---

### Task 7: Stage 5 — Complete Journey Verification & Regression Suite

**Files:**
- Create: `tests/completeProjectJourney.test.ts`
- Verify existing test suites: `npm test`, `npm run build`

- [ ] **Step 7.1**: Implement end-to-end integration test in `tests/completeProjectJourney.test.ts` executing all 10 journey steps in isolated disposable storage:
  1. Create two isolated projects ("alpha", "beta").
  2. Configure repository settings on both.
  3. Submit plan with key missing -> verify clean 503 error, preserved source text, zero tasks.
  4. Submit plan with mock test provider -> verify parsed tasks.
  5. Atomically adopt plan -> verify tasks in SQLite table, initial `backlog`/`todo` statuses, 0 completed subtasks.
  6. Restart isolated store -> verify tasks, plan revision, and settings survive reboot.
  7. Trigger execution on secondary project -> verify HTTP 501 rejection and UI blocker.
  8. Confirm default project and other project experienced zero modifications.
  9. Attempt adoption with cyclic dependencies -> verify transaction rollback.
  10. Inspect task details -> verify zero fake verification or execution claims.
- [ ] **Step 7.2**: Run full test suite (`npm test`) and typecheck / production build (`npm run build`).
- [ ] **Step 7.3**: Commit as `test: complete end-to-end multi-project journey verification`.

---

### Task 8: Deliver Final Report & Historical Recovery Proposal

- [ ] **Step 8.1**: Compile final delivery report with requirement-to-test acceptance matrix, browser verification evidence, and the separate operator historical data recovery proposal.
