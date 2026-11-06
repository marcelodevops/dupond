# Implementation Plan: Task-to-PR Autonomous Pipeline for Dupond

## Assessment & Hypothesis Verification Summary
All 12 findings from the previous source review of commit `c0d1c258` have been verified against the current codebase:
1. `executeWorkerStep()` merely reads existing `.dupond_artifacts/<key>/implementation.js` and `spec.test.js` files rather than invoking any coding worker.
2. `updateState()` validates tasks marked `done` via shallow `preflightQualityGates()` without running actual test verification.
3. `POST /api/orchestrate/state` directly returns `this.state` with unmasked `integrationConfig` secrets.
4. Mutation and execution endpoints in `server.ts` lack authentication and authorization middleware.
5. Verification runs under `process.execPath` on the host, lacking OS/filesystem isolation from host secrets.
6. Git branch and remote PR delivery are hardcoded to fail-closed with HTTP 403.
7. `runDaemonTick()` uses `tasks.find(t => t.status === 'in_progress')`, causing a failing task to monopolize ticks indefinitely.
8. State persistence uses a raw JSON file (`dupond_state.json`) with zero transactional guarantees or separate run/attempt records.
9. `spentHours` increments by a hardcoded `+ 4` hours per step.
10. `artifactRunnerScript.mjs` allows test code to satisfy criteria simply by calling `passCriterion(id)` with no assertions.
11. No `.github/workflows` exists in the repository.
12. README claims "Zero RCE Risk" and remote PR capabilities that exceed actual guarantees.

Additionally, in `tests/trackA.test.ts`, the test expecting `https://nonexistent-host-for-tracka.atlassian.net/x` to fail at DNS fails because `*.atlassian.net` is a wildcard DNS domain pointing to CloudFront edge servers.

---

## Target Outcomes & Architecture

### High-Level Architecture
```
User Task Submission
       │
       ▼
[Task Contract & Store (node:sqlite)] ◄── Strict Auth & Schema Validation
       │
       ▼
[Durable Coordinator Engine] ◄── Fair Multi-Task Scheduling & State Transitions
       │
       ▼
[Workspace Manager] ──► Pinned Git Worktree per Run
       │
       ▼
[Execution Sandbox] ──► macOS Seatbelt / Container Boundary (No Host Secrets, Limited Paths)
       │
       ▼
[Real Coding Worker Adapter] ──► Tool-Calling Coding Agent (Inspect, Edit, Permitted Commands)
       │
       ▼
[Authoritative Quality Gate] ──► Operator-Configured Build & Test Suite (No passCriterion loopholes)
       │
       ├── (Fail) ──► Bounded Repair Loop with Failure Evidence (Back to Worker)
       │
       └── (Pass) ──► Cryptographic Verification Attestation
                            │
                            ▼
                     [GitHub Delivery Service] ◄── Approval Policy Check
                            │
                            ▼
                     Remote Branch Push & Pull Request Reconciliation
```

---

## Detailed Task Breakdown

### Task 1: Fix Immediate Correctness Gaps & Security Leaks
- **Files Modified**:
  - `src/server/coordinator.ts`:
    - Ensure `updateState()` returns `getStateView()`, never raw internal state.
    - Ensure `updateState()` cannot mark tasks as `done` via shallow preflights; requires authoritative quality gate or rejects with review status.
    - Invalidate verification attestations if task description, criteria, or artifacts change.
  - `tests/trackA.test.ts`:
    - Fix the DNS wildcard test to use a reserved non-existent TLD (`.invalid` or `.example`) or test-controlled mock rather than relying on 3rd-party wildcard DNS.
  - `server.ts`:
    - Add authentication middleware for mutation and execution endpoints (`X-Dupond-Token` or `Authorization: Bearer <secret>`).
    - Redact all sensitive fields from error outputs and state responses.
- **Deliverables & Tests**:
  - `tests/securityFixes.test.ts`: Verify `updateState` secret redaction, reject unauthorized done transitions, test auth headers.

### Task 2: Transactional Storage Layer (`node:sqlite`)
- **Files Created**:
  - `src/server/db/schema.ts`: Database DDL for `tasks`, `runs`, `attempts`, `verifications`, `deliveries`, `audit_events`.
  - `src/server/db/database.ts`: Built-in `node:sqlite` (`DatabaseSync`) wrapper with WAL mode, transactions, and migration logic.
  - `src/server/db/repository.ts`: Typed repository methods for atomic claims, status transitions, and audit trails.
- **Deliverables & Tests**:
  - `tests/db.test.ts`: Verify atomic claims, transactions, concurrent updates, run lifecycle history, crash-restart consistency.

### Task 3: Isolated Workspace & Execution Sandbox
- **Files Created/Modified**:
  - `src/server/workspace/workspaceManager.ts`:
    - Creates isolated Git worktrees per run pinned to a specific base commit (`git worktree add <dir> <commit>`).
    - Cleans up worktrees and branches on cancellation, timeout, or completion.
  - `src/server/sandbox/sandboxExecutor.ts`:
    - Implements restricted execution environment on macOS via `sandbox-exec` with strict Seatbelt profile denying access to `$HOME`, `.ssh`, `.aws`, `.env`, only granting write access to the specific worktree.
    - Explicit process-group spawning (`detached: true`), timeout guards, and process-tree termination (`SIGKILL` to `-pgid`).
- **Deliverables & Tests**:
  - `tests/sandbox.test.ts`: Verify process cannot read `$HOME/.ssh` or `$HOME/.env`, cannot escape worktree, and times out cleanly with process tree termination.

### Task 4: Real Coding Worker Adapter Interface & Implementation
- **Files Created**:
  - `src/server/worker/types.ts`: `CodingWorkerAdapter`, `WorkerExecutionContext`, `WorkerExecutionResult`, tool interfaces.
  - `src/server/worker/geminiWorkerAdapter.ts`:
    - Tool-calling agent using `@google/genai` (or configured provider).
    - Tools exposed: `read_file`, `write_file`, `edit_file`, `list_files`, `run_permitted_command` (routed strictly through `SandboxExecutor` in the isolated worktree).
    - Returns structured outcome: modified files, commit message, logs, tokens/usage data.
    - Fails clearly when provider/key is missing or unconfigured.
- **Deliverables & Tests**:
  - `tests/workerAdapter.test.ts`: Verify tool dispatch, file edits in worktree, error handling, token accounting.

### Task 5: Authoritative Verification & Bounded Repair Loop
- **Files Created/Modified**:
  - `src/server/verification/authoritativeVerifier.ts`:
    - Runs trusted project verification commands (`npm test`, build, and task acceptance checks).
    - Validates against protected path rules (ensures worker did not modify test specs or cheat criteria).
    - Computes git diff hash, commit SHA, stdout/stderr logs.
  - `src/server/coordinator/repairCoordinator.ts`:
    - Manages bounded repair loop (e.g. up to 3 attempts).
    - Feeds verification failures back into subsequent worker attempts.
    - If attempts exhausted, marks run as `failed` and task as `blocked` with complete diagnostic logs.
- **Deliverables & Tests**:
  - `tests/repairLoop.test.ts`: Verify failed test triggers repair attempt; verify repeated failure exhausts budget and leaves task blocked.

### Task 6: Fair Scheduling & State Reconciliation
- **Files Modified**:
  - `src/server/coordinator.ts`:
    - Refactor `runDaemonTick()` from greedy `find(status === 'in_progress')` to fair priority/FIFO queue over ready tasks.
    - Support cancellation tokens per active task run.
    - On coordinator startup, perform reconciliation: identify orphaned/in-progress runs from previous crashes, mark them appropriately, and resume.
    - Replace hardcoded `+ 4` hours with real elapsed wall-clock duration and reported token usage.
- **Deliverables & Tests**:
  - `tests/fairScheduler.test.ts`: Verify blocked task does not starve other tasks; verify startup reconciliation cleans up dangling runs.

### Task 7: GitHub Delivery & PR Reconciliation
- **Files Created/Modified**:
  - `src/server/delivery/githubDelivery.ts`:
    - Enforces backend approval policy (`requireApproval`).
    - Pushes verified branch to configured Git remote.
    - Reconciles existing PRs (`gh pr list` / API lookup) to update existing PR instead of creating duplicates.
    - Verifies base branch has not drifted; re-verifies if needed before PR declaration.
    - Records PR URL, delivered SHA, base SHA, and CI status.
    - Never auto-merges.
- **Deliverables & Tests**:
  - `tests/delivery.test.ts`: Test idempotent delivery, duplicate PR prevention, approval policy enforcement.

### Task 8: Operational Baseline (CI, Structured Logging & Documentation)
- **Files Created/Modified**:
  - `.github/workflows/ci.yml`: GitHub Actions workflow running lint, typecheck, guardrail tests, security tests, and unit tests.
  - `src/server/utils/logger.ts`: Structured JSON logging with `taskId`, `runId`, `attemptId`.
  - `README.md`: Update security and architecture sections to accurately reflect real isolation guarantees, remove false claims ("Zero RCE Risk"), and document the Task-to-PR pipeline.

### Task 9: End-to-End Acceptance Verification
- **Files Created**:
  - `tests/e2ePipeline.test.ts`: Automated test suite covering all 13 required acceptance scenarios.
  - Disposable repo demonstration validating a real task -> isolated worktree -> worker changes -> verification -> commit & PR.

---

## Execution Order
1. Task 1: Security & correctness fixes (leaks, auth, DNS test).
2. Task 2: SQLite database & schema.
3. Task 3: Worktree manager & execution sandbox.
4. Task 4: Real coding worker adapter.
5. Task 5: Authoritative verification & repair loop.
6. Task 6: Fair scheduling & coordinator reconciliation.
7. Task 7: GitHub delivery & PR reconciliation.
8. Task 8: CI workflow, structured logs, and documentation updates.
9. Task 9: Acceptance scenario suite and end-to-end verification.
