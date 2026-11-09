# Architectural Audit & Comparative Review: Aegis Rescue Mechanisms vs. Dupond

**Author**: Antigravity Assistant  
**Date**: November 9, 2026  
**Status**: Baseline Audit (*mrQ backend implementation PR pending reconciliation*)  
**Scope**: Comparative evaluation of mechanisms between `marcelodevops/dupond` and `marcelodevops/aegis-orchestrator`  

---

## 📌 Pinned Baselines Inspected

| Repository | Branch | Inspected Commit SHA | Tag / Release Baseline |
| :--- | :--- | :--- | :--- |
| **`marcelodevops/dupond`** | `main` | [`86ba67a6b411fcff8286e3233d271e07fb959b36`](https://github.com/marcelodevops/dupond/commit/86ba67a6b411fcff8286e3233d271e07fb959b36) | `v0.3.0` |
| **`marcelodevops/aegis-orchestrator`** | `main` | [`4b232864065256a59003ffab889fc5dee93188c6`](https://github.com/marcelodevops/aegis-orchestrator/commit/4b232864065256a59003ffab889fc5dee93188c6) | Baseline Ancestor |

> **Audit Context**: `4b23286` is the direct ancestor from which Dupond was evolved. Dupond introduced an isolated Git worktree engine, sandboxed authoritative verification (Seatbelt/Container), transactional SQLite persistence, and real GitHub PR delivery. However, vestiges of the legacy Aegis single-file artifact model and sprint state JSON remain inside Dupond, creating architectural disconnects.

---

## 🔍 Section 1: Detailed Tracing & Confirmed Architectural Findings

### 1.1 Task Lifecycle & Transition to Review and Done

#### Traced Execution Paths
1. **Manual / UI Status Transition**:
   - Client sends `POST /api/orchestrate/tasks/:id/transition` (`server.ts:102`).
   - Invokes `Coordinator.transitionTaskStatus(taskId, targetStatus)` in [`src/server/coordinator.ts:352`](file:///Users/mac/ops/repos/dupond-audit/src/server/coordinator.ts#L352).
   - If `targetStatus === 'done'`, it executes `verifyTaskQualityGates(task)` (`coordinator.ts:364`).
   - If `targetStatus === 'review'`, no verification is executed; the task transition is accepted unconditionally.
2. **Bulk State Synchronization**:
   - Client sends `POST /api/orchestrate/state` (`server.ts:88`).
   - Enforces `Coordinator.preflightQualityGates(task)` (`coordinator.ts:400`) on any task requested with `status === 'done'`.
   - Rejects unauthorized transitions to Done if preflight checks fail.
3. **Autonomous Execution Tick**:
   - Daemon runs `Coordinator.runDaemonTick()` (`coordinator.ts:822`).
   - **Step 1 (`in_progress` $\rightarrow$ `review`)**: Calls `executeWorkerStep(inProgressTask, agent)` (`coordinator.ts:833`), which invokes `defaultRepairCoordinator.executeTaskRun(...)` (`coordinator.ts:761`). This provisions a real Git worktree (`WorkspaceManager`), dispatches a coding worker (`gemini` or `openai`), runs sandboxed acceptance tests (`AuthoritativeVerifier`), and writes records to SQLite `taskStore`. If successful, the task is marked `status: 'review'` in `dupond_state.json`.
   - **Step 2 (`review` $\rightarrow$ `done`)**: Looks for any task with `status === 'review'` and executes `verifyTaskQualityGates(reviewTask)` (`coordinator.ts:872`).

#### 🚨 Confirmed Defect: The "Ghost Gate" Artifact Disconnect
- **Source Paths**: [`src/server/coordinator.ts:429-473`](file:///Users/mac/ops/repos/dupond-audit/src/server/coordinator.ts#L429-L473), [`src/server/coordinator.ts:539-575`](file:///Users/mac/ops/repos/dupond-audit/src/server/coordinator.ts#L539-L575).
- **Finding**: While `executeWorkerStep` executes a real worker in an isolated worktree and authoritatively verifies repository code into SQLite `dupond.db`, `verifyTaskQualityGates` in `coordinator.ts` was **never upgraded to read SQLite or inspect the Git worktree**.
- **Root Cause**: `verifyTaskQualityGates` calls `this.locateArtifact(task.key)` (`coordinator.ts:539`), which searches strictly for `.dupond_artifacts/${task.key}/implementation.js` or `.dupond_artifacts/${task.key}_deliverable.md` on the coordinator's local disk.
- **Consequences**:
  1. **False-Positive Blocking**: A real coding worker can successfully implement a multi-file task in a target repository (e.g. `src/math.js`) with 100% passing tests verified in SQLite, but `verifyTaskQualityGates` will fail with `No physical code artifact found on disk in .dupond_artifacts/${task.key}/`. The daemon immediately reverts the task back to `in_progress` (`action: 'quality_gate_blocked'`).
  2. **Bypass Risk**: An operator or external caller can deposit a synthetic `implementation.js` in `.dupond_artifacts/` and transition the task to `done`, even if zero code was committed to the target repository and no worktree verification ever occurred.

---

### 1.2 Dual-State Disconnect (UI/JSON vs. SQLite Database)

#### Traced Execution Paths
- **JSON State**: [`data/dupond_state.json`](file:///Users/mac/ops/repos/dupond-audit/data/dupond_state.json) via `Coordinator` (`src/server/coordinator.ts`). Contains sprint boards, columns, agent allocations, and task subtask checklists.
- **SQLite Database**: [`data/dupond.db`](file:///Users/mac/ops/repos/dupond-audit/data/dupond.db) via `TaskStore` ([`src/server/db/database.ts`](file:///Users/mac/ops/repos/dupond-audit/src/server/db/database.ts)). Contains relational `tasks`, `task_runs`, `run_attempts`, `verification_records`, `delivery_records`, and `audit_events`.

#### 🚨 Confirmed Defect: Split-Brain State & Inconsistent Restarts
- **Source Paths**: [`src/server/coordinator.ts:750-792`](file:///Users/mac/ops/repos/dupond-audit/src/server/coordinator.ts#L750-L792), [`src/server/db/database.ts:488-517`](file:///Users/mac/ops/repos/dupond-audit/src/server/db/database.ts#L488-L517), [`src/App.tsx:95-155`](file:///Users/mac/ops/repos/dupond-audit/src/App.tsx#L95-L155).
- **Finding**: The UI state and SQLite state operate on independent lifecycles without transactional two-way synchronization.
- **Concrete Disagreement Modes**:
  1. **Independent Task Creation**: Creating a task via the UI writes only to `dupond_state.json`. Creating a task via `POST /api/tasks` or `TaskStore.createTask()` writes only to SQLite. The Kanban board is completely blind to SQLite-native tasks.
  2. **Delivery State Desynchronization**: When a pull request is authoritatively verified and delivered to GitHub via `/api/delivery/dispatch` (`src/server/delivery/githubDelivery.ts`), a `delivery_record` is stored in SQLite. However, `dupond_state.json` is never updated. The UI Kanban board continues to display the task as `review` or `in_progress`.
  3. **Restart Recovery Divergence**: `TaskStore.reconcileOnRestart()` (`database.ts:488`) authoritatively rolls back interrupted in-flight runs in SQLite (`status: 'running'` $\rightarrow$ `status: 'failed'`) and resets claimed tasks to `todo`. However, `dupond_state.json` has no restart reconciliation hook. Following a server crash or process restart, `dupond_state.json` retains stale `in_progress` or `review` states with obsolete agent comments.

---

### 1.3 Evidence Binding & Cryptographic Guarantees

#### Traced Execution Paths
- [`src/server/verification/authoritativeVerifier.ts:39-220`](file:///Users/mac/ops/repos/dupond-audit/src/server/verification/authoritativeVerifier.ts#L39-L220)
- [`src/server/delivery/githubDelivery.ts:90-130`](file:///Users/mac/ops/repos/dupond-audit/src/server/delivery/githubDelivery.ts#L90-L130)
- [`src/server/db/schema.ts:68-82`](file:///Users/mac/ops/repos/dupond-audit/src/server/db/schema.ts#L68-L82)

#### Current Implemented Guarantees
1. **Candidate Content Binding**: The authoritative verifier executes `git rev-parse HEAD` in the real worktree to extract `revisionSha`. Delivery strictly asserts:
   ```ts
   if (verification.revisionSha !== deliveredCommit) {
     return { status: 409, blocked: true, error: "Stale verification evidence..." };
   }
   ```
   Delivery is impossible if the candidate revision has diverged from the verified revision.
2. **Acceptance Criteria Binding**: `VerificationRecord` records `criteriaVerified: string[]`. `githubDelivery.ts:114` checks that every criterion defined in `task.acceptanceCriteria` is present in `verification.criteriaVerified`. Missing criteria block delivery fail-closed with HTTP 400.
3. **Protected Paths Integrity**: `authoritativeVerifier.ts:58-94` computes `git diff --name-only baseCommit HEAD`. If any file matching `protectedPaths` (`test/**`, `package.json`, `.github/**`) was touched, verification fails immediately.

#### 💡 Design Improvement: Missing Specification & Verifier Environment Hashes
- **Finding**: While `VerificationRecord` binds to `revisionSha` and `criteriaVerified`, it does **not** record:
  - A cryptographic hash of the requirements specification or test file contents.
  - The verifier configuration (sandbox executor profile, container image digest, environment variables).
  - An audit link proving whether the tests were run under macOS Seatbelt or Linux Docker.
- **Risk**: If an operator modifies the verification command or acceptance criteria definition after a run completes, the stored `criteriaVerified` array (`['c1', 'c2']`) does not detect semantic changes to criterion definitions unless a re-verification is explicitly forced.

---

### 1.4 Evolutionary Invalidation Traces

#### 1. What happens when requirements change?
- **In SQLite / Delivery**: `task.acceptanceCriteria` on `TaskRecord` is currently immutable via the API. If a new task version is created with modified criteria IDs, previous runs cannot be credited toward it. However, if criterion titles are modified in place, no hash invalidation triggers unless new IDs are used.
- **In JSON State**: Modifying subtasks in `dupond_state.json` causes `preflightQualityGates` to reject Done transitions, but does not invalidate existing SQLite records.

#### 2. What happens when the base branch advances?
- **In Dupond Delivery Pipeline ([`src/server/delivery/githubDelivery.ts:219-286`](file:///Users/mac/ops/repos/dupond-audit/src/server/delivery/githubDelivery.ts#L219-L286))**:
  - Automatically fetches the remote base (`git fetch <remote> <baseBranch>`).
  - Detects drift (`latestRemoteBaseSha !== run.baseCommit`).
  - Merges the updated remote base into the isolated worktree (`git merge --no-edit`).
  - If merge conflict arises: executes `git merge --abort` and blocks delivery with HTTP 409.
  - If merge succeeds: re-verifies all acceptance checks against the combined result. If any test fails, blocks with HTTP 409.
  - If re-verification passes: binds fresh verification evidence to `mergedSha`.
  - **Approval Invalidation**: Checks `if (mergedSha !== deliveredCommit)`. Because integration produced a new commit SHA, **prior operator approval is automatically invalidated**! The delivery service blocks with HTTP 403 (`approvalRequired: true`) requiring fresh approval for the combined commit.
- **In Aegis**: Completely unsupported. Git branch and remote PR delivery return hardcoded HTTP 403.

#### 3. What happens when execution restarts?
- **In Dupond SQLite**: `TaskStore.reconcileOnRestart()` runs in a single transaction. `status: 'running'` runs are marked `failed` (`failure_type: 'cancelled'`), and claimed `in_progress` tasks are reset to `todo`.
- **In Dupond JSON**: No reconciliation occurs; stale task statuses persist in `dupond_state.json`.
- **In Aegis**: No database exists; JSON state persists stale claims indefinitely.

#### 4. What happens when a worktree is removed?
- **In Dupond**: `githubDelivery.ts:96` checks `fs.existsSync(run.worktreePath)`. If removed or pruned, delivery immediately blocks fail-closed with HTTP 400 (`Worktree for run ... does not exist`). Code cannot be delivered from a phantom or deleted worktree.

---

## ⚖️ Section 2: Comparative Analysis of Aegis Mechanisms

We assessed the key mechanisms from `marcelodevops/aegis-orchestrator` (`4b23286`) to determine which are worth adopting, adapting, or skipping in Dupond:

| Mechanism / Concept | Aegis Status (`4b23286`) | Dupond Status (`86ba67a`) | Recommendation | Rationale |
| :--- | :--- | :--- | :---: | :--- |
| **Prerequisite Dependencies Gate** | `staticChecks` in `coordinator.ts:228` (verifies upstream tasks in JSON are `done`) | Present in `coordinator.ts:391`, missing in SQLite schema | **ADAPT** | Adapt dependency validation into SQLite `TaskRecord` (`dependencies: string[]`). Reject claiming or running a task if upstream task runs are not verified. |
| **Single-File Artifact Directory (`.aegis_artifacts/`)** | Core model (`implementation.js`, `spec.test.js`) | Legacy remnant in `coordinator.ts` causing Ghost Gate defect | **SKIP / DEPRECATE** | Real software engineering requires repository worktrees, not isolated single-file toys. Deprecate `.dupond_artifacts/` entirely in favor of worktree evidence. |
| **In-Process VM Script AST Parsing (`new vm.Script`)** | `coordinator.ts:285` (in-process Node.js VM) | Replaced in Track A with isolated subprocess (`artifactRunner.ts`) | **SKIP** | In-process VM compilation is vulnerable to prototype pollution and process crashes. Dupond's OS Seatbelt and container sandboxes are vastly superior. |
| **Offline Patch Export Delivery (`patch_export`)** | `deliveryHandler.ts:190` (creates unified diff `.patch`) | Present at `/api/integrations/repository/dispatch` | **ADAPT** | Useful fallback for air-gapped or headless deployments without GitHub CLI. Should be integrated into `delivery/` alongside `GitHubDeliveryService`, rather than existing as a separate handler. |
| **Path Containment (`isPathContained`)** | `deliveryHandler.ts:20` (lexical + realpath check) | Strengthened in `src/server/worker/tools.ts:resolveSafePath` | **ALREADY ADOPTED** | Dupond already adopted and expanded this with symlink ancestor checks and protected paths rollback. Retain existing Dupond implementation. |
| **Workload Balancing & Capacity Matrix** | `workloadBalancer.ts` (AEG-104 thresholds: 85% / 40%) | Cleaned & deduplicated in `src/services/workloadBalancer.ts` | **KEEP** | Already cleanly adopted and tested in Dupond (`tests/release.test.ts` & `AEG-104`). |
| **Remote Git PR Delivery** | Disabled (returns hardcoded HTTP 403) | Fully implemented in `GitHubDeliveryService` | **SKIP AEGIS (KEEP DUPOND)** | Dupond's delivery pipeline (with base-drift merge, re-verification, and approval invalidation) is far more mature than Aegis's stub. |

---

## 📋 Section 3: Concise Acceptance Checklist for mrQ’s PR

When inspecting mrQ’s forthcoming backend implementation PR, verify compliance against this checklist:

- [ ] **1. Eliminate the "Ghost Gate" Artifact Disconnect**:
  - `Coordinator.verifyTaskQualityGates` must consult SQLite `taskStore` (checking `getLatestVerification(runId)` or task-level verification) instead of demanding `.dupond_artifacts/${task.key}/implementation.js`.
  - Passing verification in an isolated Git worktree must allow a task to cleanly advance to `done`.
- [ ] **2. Unify Dual-State Storage (JSON $\leftrightarrow$ SQLite)**:
  - Updates to `TaskStore` must synchronously or reactively project into the state read by the UI.
  - Marking a task `done` via `/api/orchestrate/state` or `/api/orchestrate/tasks/:id/transition` must fail closed unless backed by an authoritative passing `VerificationRecord` in SQLite.
- [ ] **3. Unify Delivery Endpoints**:
  - Deprecate or harmonize the legacy `/api/integrations/repository/dispatch` handler with `GitHubDeliveryService`.
  - The UI delivery actions in `IntegrationsView.tsx` must route to authoritative delivery with operator approval checks.
- [ ] **4. Adapt Task Dependency Checking into SQLite**:
  - Store prerequisite dependencies on `TaskRecord`.
  - Block `RepairCoordinator.executeTaskRun` if upstream dependencies lack verified deliveries.
- [ ] **5. Restart Reconciliation Synchronization**:
  - Ensure `TaskStore.reconcileOnRestart()` also reconciles `dupond_state.json`, eliminating phantom `in_progress` tasks in the UI after a crash.
- [ ] **6. Strict Evidence Immutability**:
  - Ensure modifying acceptance criteria definitions explicitly invalidates prior verification records for that task.
