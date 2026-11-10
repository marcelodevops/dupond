# Dupond Acceptance Evidence & Approval Contract

This document defines the authoritative acceptance, verification, approval, and delivery contract implemented in Dupond Orchestrator. It serves as the operational specification for maintainers, operators, and review auditors.

---

## 🏛️ 1. Core Philosophy: Zero-Trust Server Authoritativeness

Dupond rejects all forms of worker self-attestation. An autonomous coding worker (whether powered by Google Gemini or OpenAI) cannot mark acceptance criteria as passed, declare a task complete, or approve a pull request:
1. **External Verification**: All acceptance criteria are verified independently by Dupond executing operator-configured test commands inside an isolated OS sandbox (macOS Apple Seatbelt or Linux rootless container).
2. **Cryptographic Revision & Specification Binding**: Verification evidence is bound directly to an exact Git commit SHA (`revisionSha`), its Git tree SHA (`revisionTreeSha`), a requirements fingerprint (`requirementsFingerprint`), a verification configuration fingerprint (`verificationConfigFingerprint`), and a protocol version (`evidenceBindingVersion`). It is never bound to abstract task keys or branch names.
3. **Protected Path Integrity**: Modifying tests, build manifests, or CI workflows (`protectedPaths`) fails verification immediately, regardless of test results.
4. **Separation of Approval & Execution**: Only an authorized human operator can authorize code delivery. Any change to the candidate commit (including automated base merges) or to the task requirements immediately invalidates prior operator approval.

---

## ⚙️ 2. The Implemented Acceptance & Approval Lifecycle

The authoritative lifecycle moves through three distinct, server-enforced phases mediated by `LifecycleService` ([src/server/lifecycle/lifecycleService.ts](../src/server/lifecycle/lifecycleService.ts)):

```
┌────────────────────────────────────────────────────────┐
│                   Phase 1: Verification                │
│  - Ephemeral Git Worktree pinned to baseCommit         │
│  - Worker implements changes in worktree               │
│  - Protected paths diff check (git diff baseCommit)    │
│  - Authoritative test execution in OS sandbox          │
│  - Compute requirements & config fingerprints          │
│  - Record VerificationRecord in SQLite                 │
│  - Pin commit under refs/dupond/verified/<runId>       │
│  - Transition to Review via LifecycleService (CAS)     │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│               Phase 2: Operator Approval Gate          │
│  - Operator inspects verified diff & check output      │
│  - Operator submits explicit approval (isApproved: true│
│    plus approvedBy identity) for the exact commit      │
│  - Delivery rejected if isApproved !== true (HTTP 403) │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│               Phase 3: Delivery & Drift Check          │
│  - Fetch latest remote base commit                     │
│  - If base advanced: merge, re-verify, invalidate app. │
│  - Verify HEAD matches verified commit & tree          │
│  - If commit unchanged & approved: push & open PR      │
│  - Store DeliveryRecord in SQLite                      │
│  - Transition to Done via LifecycleService (CAS)       │
└────────────────────────────────────────────────────────┘
```

### 2.1 Verification Evidence Schema
When `AuthoritativeVerifier` completes execution in a worktree, it persists a `VerificationRecord` into SQLite ([src/server/db/schema.ts](../src/server/db/schema.ts)):

```typescript
export interface VerificationRecord {
  id: string;                          // e.g., "ver-uuid" or "ver-drift-timestamp"
  runId: string;                       // References the specific TaskRunRecord
  attemptId: string;                   // References the RunAttemptRecord
  revisionSha: string;                 // 40-character commit SHA verified in the worktree
  revisionTreeSha?: string;            // Exact git tree SHA (HEAD^{tree}) representing committed tree
  requirementsFingerprint?: string;    // SHA-256 of canonical JSON of acceptance criteria
  verificationConfigFingerprint?: string; // SHA-256 of canonical JSON of { commands, protectedPaths }
  evidenceBindingVersion?: string;     // Protocol version (e.g., 'dupond-evidence-v1')
  passed: boolean;                     // Authoritative verdict: all commands succeeded & criteria met
  checks: Array<{                      // Raw execution capture per verification command
    command: string;                   // Exact command string executed
    exitCode: number;                  // Process exit code (0 required for pass)
    stdout: string;                    // Standard output
    stderr: string;                    // Standard error output
    passed: boolean;                   // true if exitCode === 0
    durationMs: number;                // Execution duration
  }>;
  criteriaVerified: string[];          // List of acceptance criteria IDs authoritatively verified
  failureReason?: string;              // Explanatory error if any check or criterion failed
  verifiedAt: string;                  // ISO 8601 timestamp
}
```

### 2.2 Evidence Binding & Fingerprinting
Implemented in [src/server/verification/evidenceBinding.ts](../src/server/verification/evidenceBinding.ts):
- **Deterministic Serialization (`canonicalJson`)**: Recursively sorts object keys while preserving array ordering.
- **`requirementsFingerprint`**: `sha256(canonicalJson(criteria))` where each criterion includes `{ id, title, checkCommand }`.
- **`verificationConfigFingerprint`**: `sha256(canonicalJson({ commands, protectedPaths }))`.
- **`evidenceBindingVersion`**: Set to `dupond-evidence-v1`. Any version discrepancy requires fresh verification.

### 2.3 The Delivery Guardrails
When `/api/delivery/dispatch` is invoked ([src/server/delivery/githubDelivery.ts](../src/server/delivery/githubDelivery.ts)), Dupond asserts the following conditions in order before executing any network action:
1. **Verification Existence**: `store.getLatestVerification(run.id)` must exist and have `passed: true`.
2. **Explicit Operator Approval**: `task.requireApproval` requires `options.isApproved === true` and `options.approvedBy`. If false or missing, returns HTTP 403 (`approvalRequired: true`).
3. **Physical Worktree Containment**: `fs.existsSync(run.worktreePath)` must be true. If the worktree was pruned or deleted, returns HTTP 400.
4. **Stale Evidence Guard**: The current commit at `worktreePath` (`git rev-parse HEAD`) must strictly equal `verification.revisionSha`. If the branch was modified after verification, returns HTTP 409.
5. **Criteria Exhaustion**: Every criterion defined in `task.acceptanceCriteria` must be present in `verification.criteriaVerified`. If any criterion is missing, returns HTTP 400.
6. **Evidence Currency & Binding Validity**: `assessEvidenceValidity(task, verification)` must return `valid: true`. Fails closed if requirements or verification config changed, if criteria remain uncovered, or if evidence predates binding (`legacy-evidence`).

---

## 🔄 3. Invalidation, Drift Reconciliation & Re-Approval

### 3.1 Requirements Change Invalidation
When task specifications are modified via `TaskStore.updateTaskRequirements` ([src/server/db/database.ts](../src/server/db/database.ts)):
1. Re-computes fingerprints before and after the modification.
2. If `requirementsFingerprint` or `verificationConfigFingerprint` changes (`bindingChanged: true`):
   - Prior passing verification records are rendered invalid (`stale-requirements` or `changed-verification-config`).
   - Any approved delivery record for the latest run is immediately demoted to `approval_status = 'pending_approval'`, clearing `approved_by`.
   - Records an `APPROVAL_INVALIDATED` audit event.
   - Any transition to `review` or `done` fails closed until a fresh run re-verifies the modified spec.

### 3.2 Legacy Evidence & Protocol Version Invalidation
- **Legacy Records**: Verification records created before evidence binding (missing fingerprints or protocol version) fail closed with `reason: 'legacy-evidence'`.
- **Superseded Protocol**: Records generated under an older `evidenceBindingVersion` fail closed with `reason: 'verifier-upgraded'`.
- Neither can authorize entry into `review` or `done`, nor satisfy delivery checks.

### 3.3 Remote Base Drift Protocol
In active repositories, the base branch (`main`) frequently advances while a worker is implementing a task. Delivery cannot assume the candidate commit can merge cleanly.

Dupond executes an automated **drift-reconciliation protocol** during delivery ([src/server/delivery/githubDelivery.ts](../src/server/delivery/githubDelivery.ts)):
1. **Remote Base Fetch**: Runs `git fetch <remoteTarget> <baseBranch>`.
2. **Drift Detection**: Compares `run.baseCommit` against `latestRemoteBaseSha`. If equal, no drift occurred.
3. **Automated Three-Way Integration**: If the base advanced, Dupond merges the updated base into the isolated worktree:
   ```bash
   git merge --no-edit <latestRemoteBaseSha>
   ```
4. **Conflict Fail-Closed**: If git conflicts occur, Dupond immediately aborts the merge (`git merge --abort`) and returns **HTTP 409 Conflict** with full stderr details. No broken merges are ever pushed.
5. **Authoritative Re-Validation**: If the merge succeeds cleanly, Dupond re-executes all configured verification commands against the combined worktree state. If any check fails, returns **HTTP 409 Conflict**.
6. **Fresh Evidence Binding**: A new `VerificationRecord` is created and bound to the resulting merge commit (`mergedSha`).
7. **🚨 Automatic Approval Invalidation**:
   ```typescript
   if (mergedSha !== deliveredCommit) {
     return {
       success: false,
       status: 403,
       blocked: true,
       approvalRequired: true,
       deliveredCommit: mergedSha,
       baseCommit: latestRemoteBaseSha,
       error: `Delivery blocked: Base branch ${baseBranch} advanced... Prior approval for ${deliveredCommit} is invalidated; operator approval is required for ${mergedSha}.`
     };
   }
   ```
   **An approval granted for commit A is never valid for commit B**. Even a clean, passing merge requires the operator to review and approve the combined revision before push.

### 3.4 Durable Candidate Retention (`refs/dupond/verified/<runId>`)
To prevent Git garbage collection and ensure candidate revisions survive ephemeral worktree pruning:
- Upon passing verification in `RepairCoordinator`, the revision is pinned using `git update-ref refs/dupond/verified/<runId> <commitSha>` ([src/server/workspace/workspaceManager.ts](../src/server/workspace/workspaceManager.ts)).
- Upon clean drift merge during delivery, the pin is updated to `mergedSha`.
- *Current operational limitation*: While the commit object is durably retained in the Git object database, `dispatchDelivery` currently requires `run.worktreePath` to exist on disk. Automated worktree re-creation from the pinned ref is an open enhancement.

---

## ⚖️ 4. Dual-Path Architecture: Authoritative Store vs. Legacy JSON

Dupond currently retains two execution models due to its historical evolution:

| Dimension | Store-Backed Tasks (`dupond.db`) | Legacy JSON Tasks (`dupond_state.json`) |
| :--- | :--- | :--- |
| **Authoritative Engine** | `LifecycleService` with compare-and-swap | `Coordinator.verifyTaskQualityGates` |
| **Evidence Binding** | Bound to commit, tree, requirements, and config | Local file presence (`.dupond_artifacts/`) + test assertions |
| **UI State Authority** | UI is a projection; posted state is clamped to DB | Direct mutation permitted if preflight passes |
| **Criterion Satisfaction** | Proven only by bound `VerificationRecord` | Proven only by test assertions (checkboxes grant nothing; PR #27) |
| **Concurrency Protection** | SQLite CAS transaction + atomic audit log | In-memory JavaScript array mutation |
| **Approval Enforcement** | Explicit operator approval (`isApproved: true`) | No delivery gate in JSON quality path |

> [!IMPORTANT]
> **Authoritative Projection Rule**: For any task registered in `TaskStore`, posted UI state mutations to `review` or `done` are rejected and clamped back to the persisted status in SQLite ([src/server/coordinator.ts](../src/server/coordinator.ts)). The UI cannot grant acceptance on its own.

---

## 🛠️ 5. Restart Behavior & Recovery Protocol

When Dupond restarts (following a crash, host reboot, or service deployment):

### 5.1 SQLite Transactional Recovery (`reconcileOnRestart`)
The `TaskStore` constructor automatically executes `reconcileOnRestart()` inside a database transaction ([src/server/db/database.ts](../src/server/db/database.ts)):
- Any `task_runs` record left in `status = 'running'` is marked:
  - `status: 'failed'`
  - `failure_type: 'cancelled'`
  - `failure_reason: 'Interrupted: Server crashed or restarted while run was active'`
- Any `tasks` record left in `status = 'in_progress'` with an active claim is rolled back:
  - `status: 'todo'`
  - `claimed_by: NULL`
  - `claimed_at: NULL`
  - `blocked_reason: 'Interrupted by server restart, reset to todo for clean retry'`

### 5.2 Worktree Collision Prevention
When a task is retried after a restart, `WorkspaceManager.createWorktree(runId, branchName, baseCommit)` inspects `.dupond_worktrees/<runId>`. If a dangling worktree directory remains from the previous interrupted process, `cleanupWorktree` unmounts and removes the dangling worktree before creating a fresh checkout.

### 5.3 Known Restart Limitations
- `dupond_state.json` does not receive proactive updates during `reconcileOnRestart()`. If tasks were in progress when the process died, the JSON file retains them as `in_progress` until an API call or daemon sync triggers projection clamping.

---

## 🔭 6. Remaining Areas for Architectural Hardening

The following items are identified for subsequent milestones:
1. **Worktree Cleanliness Check (`git status --porcelain`)**:
   `AuthoritativeVerifier` should assert that the worktree is strictly clean before and after verification command execution, guaranteeing that tests ran against the exact committed `HEAD^{tree}` and did not leave dirty modifications.
2. **Durable Worktree Recovery at Delivery**:
   `GitHubDeliveryService` should automatically re-provision a worktree from `refs/dupond/verified/<runId>` if the ephemeral worktree was pruned prior to operator delivery dispatch.
3. **Unified Single-Store UI API**:
   Completely retire `dupond_state.json` so all UI views read reactively from SQLite `TaskStore`, eliminating the dual-state projection gap entirely.

