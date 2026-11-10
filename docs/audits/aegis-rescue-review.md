# Architectural Audit & Comparative Review: Aegis Rescue Mechanisms vs. Dupond

**Author**: Antigravity Assistant  
**Date**: November 9, 2026 (Updated: Reconciliation Audit)  
**Status**: Reconciled Audit (*targeted against mrQ PR #25 commit `05c9cb4` and active PR #27 commit `44b9122`*)  
**Scope**: Comparative evaluation and implementation reconciliation between `marcelodevops/dupond` and `marcelodevops/aegis-orchestrator`

---

## 📌 Pinned Baselines Inspected

| Repository | Branch | Inspected Commit SHA | Role / Context |
| :--- | :--- | :--- | :--- |
| **`marcelodevops/dupond`** | `main` | [`86ba67a6b411fcff8286e3233d271e07fb959b36`](https://github.com/marcelodevops/dupond/commit/86ba67a6b411fcff8286e3233d271e07fb959b36) | Historical Baseline (`v0.3.0`) |
| **`marcelodevops/aegis-orchestrator`** | `main` | [`4b232864065256a59003ffab889fc5dee93188c6`](https://github.com/marcelodevops/aegis-orchestrator/commit/4b232864065256a59003ffab889fc5dee93188c6) | Baseline Ancestor |
| **`marcelodevops/dupond`** | `main` | [`46518be0fa47668dfe27d88d505983af41cfd581`](https://github.com/marcelodevops/dupond/commit/46518be0fa47668dfe27d88d505983af41cfd581) | Current `main` (`v0.4.0`) |
| **`marcelodevops/dupond`** | `feat/acceptance-evidence-lifecycle` | [`05c9cb401ecb4538dc6a29cbb896edcb6015ac57`](https://github.com/marcelodevops/dupond/commit/05c9cb401ecb4538dc6a29cbb896edcb6015ac57) | mrQ Merged PR #25 (Evidence Lifecycle) |
| **`marcelodevops/dupond`** | `feat/acceptance-evidence-lifecycle` | [`44b9122f55fb03968a5fbc283d2f194b5dba6c09`](https://github.com/marcelodevops/dupond/commit/44b9122f55fb03968a5fbc283d2f194b5dba6c09) | mrQ Open PR #27 (JSON Quality Path Fix) |

> **Audit Context**: `4b23286` is the direct ancestor from which Dupond was evolved. The historical baseline `86ba67a` retained vestiges of Aegis's single-file artifact model and disconnected JSON state. mrQ addressed these in PR #25 (`05c9cb4`) and PR #27 (`44b9122`). This review traces the 8 core acceptance guarantees against those implementation commits.

---

## 🔍 Section 1: Detailed Tracing & Reconciled Findings

### 1.1 Task Lifecycle & Transition to Review and Done (Focus Areas 1 & 6)

#### Traced Execution Paths
1. **Authoritative Lifecycle Service ([src/server/lifecycle/lifecycleService.ts](../src/server/lifecycle/lifecycleService.ts))**:
   - `LifecycleService.transition(request)` mediates all transitions claiming acceptance (`review` or `done`).
   - Evaluates `assessEvidenceValidity(task, verification)` before permitting entry into `review` or `done`.
   - Rejects unverified `review` requests fail-closed (`transition-not-allowed` or `no-evidence`).
   - Requires recorded delivery, matching revision SHA (`delivery.deliveredCommit === verification.revisionSha`), and approved delivery status before permitting `done`.
   - Applies state updates exclusively via compare-and-swap (`TaskStore.transitionTaskCas`) with atomic audit logging.
2. **Autonomous Coordinator Loop ([src/server/coordinator/repairCoordinator.ts:384-399](../src/server/coordinator/repairCoordinator.ts#L384-L399))**:
   - When a worker run completes and verification passes, `repairCoordinator` requests transition to `review` through `LifecycleService`.
   - If `reviewTransition.ok` is false, it unclaims the task and marks it `blocked`.
3. **API Transitions ([src/server/coordinator.ts:384-397](../src/server/coordinator.ts#L384-L397))**:
   - `transitionTaskStatus` routes store-backed tasks (`dbTask`) through `defaultLifecycleService.transition()`.
   - Fails closed if the lifecycle service refuses the transition.
4. **Legacy JSON State Path & PR #27 ([src/server/coordinator.ts:408-417, 562-570](../src/server/coordinator.ts#L408-L417))**:
   - For legacy tasks not found in SQLite, `transitionTaskStatus` calls `verifyTaskQualityGates(task)`.
   - In historical baseline `86ba67a`, `staticChecks` permitted `subtasks.every(st => st.completed)` checkboxes to satisfy acceptance.
   - **PR #27 fix (`44b9122`)**: Stripped checkbox satisfaction from `staticChecks()`. Subtask checkboxes grant and veto nothing; criterion coverage in the legacy path requires passing test assertions.

#### Assessment: PARTIALLY RESOLVED
- **Resolved**: Store-backed tasks are fully governed by `LifecycleService` using CAS and evidence-bound gates across daemon, API, and delivery.
- **Remaining Gap**: The artifact-runner JSON path remains for tasks with no SQLite record; while PR #27 strips checkbox grants, dual execution paths persist.

---

### 1.2 Dual-State Disconnect & UI Projection (Focus Area 2)

#### Traced Execution Paths
- **Write Path Projection Clamping ([src/server/coordinator.ts:281-296](../src/server/coordinator.ts#L281-L296))**:
  When clients post bulk state updates via `POST /api/orchestrate/state`, `updateState` inspects incoming tasks. For any store-backed task where the client attempts to set `status: 'review'` or `status: 'done'`, the posted status is clamped back to `dbTask.status`. The UI cannot grant acceptance.
- **Delivery State Update Disconnect ([src/server/delivery/githubDelivery.ts:522-541](../src/server/delivery/githubDelivery.ts#L522-L541))**:
  When delivery completes, `GitHubDeliveryService` invokes `lifecycle.transition({ taskId, to: 'done', viaDelivery: true })` which updates SQLite. However, it does not proactively update `coordinator.state.tasks` or save `dupond_state.json`.
- **Restart Recovery Disconnect ([src/server/db/database.ts:634-663](../src/server/db/database.ts#L634-L663))**:
  `TaskStore.reconcileOnRestart()` authoritatively rolls back running runs to `failed` and claimed tasks to `todo` in SQLite. However, it does not touch `dupond_state.json`.

#### Assessment: PARTIALLY RESOLVED
- **Resolved**: UI state is strictly treated as a projection on write paths; client cannot self-grant `review` or `done`.
- **Remaining Gap**: Delivery completion and process restart do not proactively update `dupond_state.json`. In-memory and disk JSON state remain stale until subsequent mutations force projection clamping.

---

### 1.3 Evidence Binding & Specification Fingerprinting (Focus Area 3)

#### Traced Execution Paths
- Implemented in [src/server/verification/evidenceBinding.ts:49-65](../src/server/verification/evidenceBinding.ts#L49-L65):
  - `requirementsFingerprint`: SHA-256 of `canonicalJson(criteria)` where each criterion includes `{ id, title, checkCommand }`.
  - `verificationConfigFingerprint`: SHA-256 of `canonicalJson({ commands, protectedPaths })`.
  - `evidenceBindingVersion`: `'dupond-evidence-v1'`.
  - `revisionTreeSha`: Exact git tree SHA (`git rev-parse HEAD^{tree}`) bound to `VerificationRecord`.
- **Invalidation Tracing ([src/server/db/database.ts:265-335](../src/server/db/database.ts#L265-L335))**:
  - `TaskStore.updateTaskRequirements()` detects fingerprint drift (`bindingChanged: true`).
  - Automatically demotes existing approved delivery records for the latest run to `approval_status = 'pending_approval'`, clearing `approved_by`.
  - Records an `APPROVAL_INVALIDATED` audit event.
  - `assessEvidenceValidity` fails closed on `stale-requirements`, `changed-verification-config`, `uncovered-criteria`, `legacy-evidence`, or `verifier-upgraded`.

#### Assessment: RESOLVED
Cryptographic specification hashing, config hashing, protocol versioning, tree SHA binding, and approval revocation on spec changes are fully implemented and verified by tests (`tests/acceptanceEvidenceLifecycle.test.ts`).

---

### 1.4 Fresh Approval & Re-Approval Tracing (Focus Area 4)

#### Traced Execution Paths
- **Approval Requirement at Dispatch ([src/server/delivery/githubDelivery.ts:87-96](../src/server/delivery/githubDelivery.ts#L87-L96))**:
  Every delivery request requires explicit operator authorization (`options.isApproved === true` and `options.approvedBy`). If omitted, delivery returns HTTP 403 fail-closed before any git operation.
- **Remote Base Drift Invalidation ([src/server/delivery/githubDelivery.ts:320-330](../src/server/delivery/githubDelivery.ts#L320-L330))**:
  When base branch advances and Dupond merges base into the worktree producing `mergedSha !== deliveredCommit`, prior approval is invalidated, returning HTTP 403 (`approvalRequired: true`).
- **Re-Verification of Delivered Commits**:
  Re-recording verification on an identical commit without requirements changes does not mutate existing delivery rows in SQLite; however, calling `dispatchDelivery` still enforces explicit operator approval at dispatch time.

#### Assessment: RESOLVED
Approval is strictly required at delivery time, and is invalidated upon remote base drift or requirements modification. Dupond does not support cryptographic digital signatures; it enforces server-side operator authorization.

---

### 1.5 Worktree Cleanliness & Exact Committed Contents (Focus Area 5)

#### Traced Execution Paths
- Inspected in [src/server/verification/authoritativeVerifier.ts:56-83](../src/server/verification/authoritativeVerifier.ts#L56-L83):
  - Captures `revisionSha = git rev-parse HEAD`.
  - Captures `treeSha = git rev-parse HEAD^{tree}`.
  - Checks protected paths diff: `git diff --name-only baseCommit HEAD`.
  - Executes test commands in worktree via `sandbox.execute()`.
- **🚨 Identified Vulnerability**:
  - `AuthoritativeVerifier` does **not** execute `git status --porcelain` before running verification commands.
  - If a worker leaves uncommitted or untracked changes, test commands execute against dirty files on disk while recorded evidence is bound only to `HEAD^{tree}`.
  - `AuthoritativeVerifier` does **not** execute `git status --porcelain` after test execution to ensure test runs did not dirty or alter repository files.

#### Assessment: OPEN / UNRESOLVED
Worktree cleanliness is not verified. Dirty worktrees or test-induced working tree mutations can dissociate disk execution from the committed Git tree.

---

### 1.6 Concurrency Protection & Transactional Integrity (Focus Area 6)

#### Traced Execution Paths
- Implemented in [src/server/db/database.ts:216-257](../src/server/db/database.ts#L216-L257):
  - `TaskStore.transitionTaskCas` wraps `UPDATE tasks SET status = ? ... WHERE id = ? AND status IN (...)` inside a database transaction (`this.transaction`).
  - Atomic audit logging: `recordAudit` is written inside the identical transaction.
  - A lost CAS race produces 0 rows updated, returns `false`, and records no audit entry.
  - Re-tested and verified in `tests/acceptanceEvidenceLifecycle.test.ts:310-326`.

#### Assessment: RESOLVED
Acceptance transitions are protected by SQLite compare-and-swap within ACID transactions.

---

### 1.7 Acceptance Regression Suite in CI (Focus Area 7)

#### Traced Execution Paths
- **`package.json`**: Line 14 includes `tsx tests/acceptanceEvidenceLifecycle.test.ts`.
- **`.github/workflows/ci.yml:56-87`**:
  - CI workflow does **not** execute `npm test`.
  - Instead, it lists individual `npx tsx tests/<suite>.test.ts` steps.
  - **🚨 Critical Discovery**: `.github/workflows/ci.yml` omits `tests/acceptanceEvidenceLifecycle.test.ts` entirely! It also omits `tests/securityFixes.test.ts`, `tests/remoteBaseDriftAndTargetRepo.test.ts`, and `tests/providerWorkers.test.ts`.

#### Assessment: PARTIALLY RESOLVED / WORKFLOW GAP
The regression suite exists and passes cleanly locally (exit code 0), but is not executed by GitHub Actions CI due to missing workflow entries.

---

### 1.8 Durable Candidate Retention & Worktree Recovery (Focus Area 8)

#### Traced Execution Paths
- **Durable Ref Pinning ([src/server/workspace/workspaceManager.ts:138-144](../src/server/workspace/workspaceManager.ts#L138-L144))**:
  `pinRevision` creates `refs/dupond/verified/<runId>` pointing to the verified commit SHA. Prevents git garbage collection even if the worktree branch is deleted.
- **Worktree Removal at Delivery ([src/server/delivery/githubDelivery.ts:99-106](../src/server/delivery/githubDelivery.ts#L99-L106))**:
  `githubDelivery.ts` asserts `fs.existsSync(run.worktreePath)`. If the ephemeral worktree was pruned, delivery fails closed with HTTP 400. There is no automated checkout/recovery from the pinned ref.

#### Assessment: PARTIALLY RESOLVED
Candidate commits are retained durably in Git, but delivery cannot recover if the physical worktree directory was pruned.

---

## ⚖️ Section 2: Comparative Analysis of Aegis Mechanisms

| Mechanism / Concept | Aegis Status (`4b23286`) | Dupond Status (`05c9cb4` + `44b9122`) | Recommendation | Current Assessment |
| :--- | :--- | :--- | :---: | :--- |
| **Authoritative Lifecycle & CAS** | None (in-memory state mutations) | Implemented via `LifecycleService` & `transitionTaskCas` | **ADOPTED IN DUPOND** | **RESOLVED**: Outperforms Aegis with ACID transactions and audit log. |
| **Prerequisite Dependencies Gate** | `staticChecks` in `coordinator.ts:228` (checks JSON `done`) | Implemented in `coordinator.ts:553`; missing in SQLite schema | **ADAPT** | **PARTIALLY RESOLVED**: Functional in coordinator, should be modeled on `TaskRecord`. |
| **Single-File Artifact Directory (`.aegis_artifacts/`)** | Core model (`implementation.js`, `spec.test.js`) | Legacy remnant in `coordinator.ts` bypassed for store tasks | **DEPRECATE** | **RESOLVED FOR STORE**: Store tasks bypass ghost gates; legacy JSON path needs final removal. |
| **In-Process VM Script AST Parsing (`new vm.Script`)** | `coordinator.ts:285` (in-process Node.js VM) | Replaced with isolated subprocess + OS sandbox | **SKIP** | **RESOLVED**: Dupond's Seatbelt/Docker sandboxes supersede Aegis VM. |
| **Offline Patch Export Delivery (`patch_export`)** | `deliveryHandler.ts:190` (creates unified diff `.patch`) | Present at `/api/integrations/repository/dispatch` | **ADAPT** | **OPEN**: Should be harmonized into `delivery/` service. |
| **Remote Git PR Delivery** | Disabled (returns hardcoded HTTP 403) | Fully implemented in `GitHubDeliveryService` | **SUPERIOR IN DUPOND** | **RESOLVED**: Full PR creation, drift merge, re-verification, and approval invalidation. |

---

## 📋 Section 3: Reconciled Acceptance Checklist for mrQ’s PRs (#25 & #27)

- [x] **1. Authoritative Lifecycle Service with CAS Transitions (PR #25)**:
  - `LifecycleService` mediates all `review` and `done` transitions (`src/server/lifecycle/lifecycleService.ts`).
  - Transitions enforce compare-and-swap against expected status in SQLite transaction with atomic audit trail.
- [x] **2. Requirements & Verification Configuration Fingerprinting (PR #25)**:
  - `requirementsFingerprint` and `verificationConfigFingerprint` bound to `VerificationRecord` (`src/server/verification/evidenceBinding.ts`).
  - Spec modifications invalidate prior evidence (`stale-requirements`, `changed-verification-config`) and demote delivery approval (`src/server/db/database.ts:313`).
- [x] **3. Durable Candidate Retention via Git Refs (PR #25)**:
  - Verified candidate commits pinned under `refs/dupond/verified/<runId>` (`src/server/workspace/workspaceManager.ts:138`).
- [x] **4. UI Projection Clamping on Acceptance Statuses (PR #25)**:
  - `coordinator.updateState` rejects and clamps client attempts to mark store-backed tasks `review` or `done` without database authority (`src/server/coordinator.ts:281`).
- [x] **5. Remove Checkbox-Based Acceptance Grants from JSON Path (PR #27)**:
  - Mutable subtask checkboxes no longer satisfy quality checks in `staticChecks` (`src/server/coordinator.ts:562`).
- [ ] **6. Normal CI Execution for Acceptance Lifecycle Suite (Remaining Gap)**:
  - Add `tests/acceptanceEvidenceLifecycle.test.ts` (and missing companion suites) to `.github/workflows/ci.yml`.
- [ ] **7. Worktree Cleanliness Validation (`git status --porcelain`) (Remaining Gap)**:
  - Assert worktree is clean before and after running authoritative verification checks.
- [ ] **8. Worktree Recovery from Pinned Git Ref (Remaining Gap)**:
  - Allow `GitHubDeliveryService` to re-materialize a worktree from `refs/dupond/verified/<runId>` if the ephemeral directory was deleted.
- [ ] **9. Proactive UI Projection on Delivery & Restart (Remaining Gap)**:
  - Update `coordinator.state.tasks` and `dupond_state.json` upon successful delivery dispatch and during `reconcileOnRestart()`.
