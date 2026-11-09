# Dupond Acceptance Evidence & Approval Contract

This document defines the authoritative acceptance, verification, approval, and delivery contract implemented in Dupond Orchestrator. It serves as the operational specification for maintainers, operators, and review auditors.

---

## 🏛️ 1. Core Philosophy: Zero-Trust Server Authoritativeness

Dupond rejects all forms of worker self-attestation. An autonomous coding worker (whether powered by Google Gemini or OpenAI) cannot mark acceptance criteria as passed, declare a task complete, or approve a pull request:
1. **External Verification**: All acceptance criteria are verified independently by Dupond executing operator-configured test commands inside an isolated OS sandbox (macOS Apple Seatbelt or Linux rootless container).
2. **Cryptographic Revision Binding**: Verification evidence is bound directly to an exact Git commit SHA (`revisionSha`), never to abstract task keys or branch names.
3. **Protected Path Integrity**: Modifying tests, build manifests, or CI workflows (`protectedPaths`) fails verification immediately, regardless of test results.
4. **Separation of Approval & Execution**: Only a human operator can authorize code delivery. Any change to the candidate commit (including automated base merges) immediately invalidates prior operator approval.

---

## ⚙️ 2. The Implemented Acceptance & Approval Lifecycle

The lifecycle moves through three distinct, server-enforced phases:

```
┌────────────────────────────────────────────────────────┐
│                   Phase 1: Verification                │
│  - Ephemeral Git Worktree pinned to baseCommit         │
│  - Worker implements changes in worktree               │
│  - Protected paths diff check (git diff baseCommit)    │
│  - Authoritative test execution in OS sandbox          │
│  - Record VerificationRecord (revisionSha, checks)     │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│               Phase 2: Operator Approval Gate          │
│  - Operator inspects verified diff & check output      │
│  - Operator issues signed approval for exact commit    │
│  - Rejects delivery if isApproved !== true (HTTP 403)  │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│               Phase 3: Delivery & Drift Check          │
│  - Fetch latest remote base commit                     │
│  - If base advanced: merge, re-verify, invalidate app. │
│  - If commit unchanged & approved: push & open PR      │
│  - Store DeliveryRecord in SQLite                      │
└────────────────────────────────────────────────────────┘
```

### 2.1 Verification Evidence Schema
When `AuthoritativeVerifier` completes execution in a worktree, it persists a `VerificationRecord` into SQLite (`src/server/db/schema.ts`):

```typescript
export interface VerificationRecord {
  id: string;               // e.g., "ver-uuid" or "ver-drift-timestamp"
  runId: string;            // References the specific TaskRunRecord
  attemptId: string;        // References the RunAttemptRecord
  revisionSha: string;      // 40-character commit SHA verified in the worktree
  passed: boolean;          // Authoritative verdict: all commands succeeded & criteria met
  checks: Array<{           // Raw execution capture per verification command
    command: string;        // Exact command string executed
    exitCode: number;       // Process exit code (0 required for pass)
    stdout: string;         // Standard output
    stderr: string;         // Standard error output
    passed: boolean;        // true if exitCode === 0
    durationMs: number;     // Execution duration
  }>;
  criteriaVerified: string[]; // List of acceptance criteria IDs authoritatively verified
  failureReason?: string;   // Explanatory error if any check or criterion failed
  verifiedAt: string;       // ISO 8601 timestamp
}
```

### 2.2 The Delivery Guardrails
When `/api/delivery/dispatch` is invoked ([`src/server/delivery/githubDelivery.ts`](file:///Users/mac/ops/repos/dupond-audit/src/server/delivery/githubDelivery.ts)), Dupond asserts the following conditions in order before executing any network action:
1. **Verification Existence**: `store.getLatestVerification(run.id)` must exist and have `passed: true`.
2. **Explicit Operator Approval**: `options.isApproved === true` must be supplied. If false or missing, returns HTTP 403 (`approvalRequired: true`).
3. **Physical Worktree Containment**: `fs.existsSync(run.worktreePath)` must be true. If the worktree was pruned or deleted, returns HTTP 400.
4. **Stale Evidence Guard**: The current commit at `worktreePath` (`git rev-parse HEAD`) must strictly equal `verification.revisionSha`. If the branch was modified after verification, returns HTTP 409.
5. **Criteria Exhaustion**: Every criterion defined in `task.acceptanceCriteria` must be present in `verification.criteriaVerified`. If any criterion is missing, returns HTTP 400.

---

## 🔄 3. Invalidation, Drift Reconciliation & Re-Approval

### 3.1 Remote Base Drift Protocol
In modern CI/CD pipelines, the base branch (`main`) frequently advances while a worker is implementing a task. Delivery cannot assume the candidate commit can be merged cleanly into the remote repository.

Dupond executes an automated **drift-reconciliation protocol** during delivery (`src/server/delivery/githubDelivery.ts:219`):
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

---

## ⚠️ 4. Legacy Evidence vs. Modern Worktree Evidence

Dupond currently retains two distinct evaluation engines due to its historical evolution from Aegis:

| Dimension | Legacy Engine (`dupond_state.json`) | Modern Engine (`dupond.db`) |
| :--- | :--- | :--- |
| **Storage** | Single JSON file (`data/dupond_state.json`) | Relational SQLite (`data/dupond.db`) |
| **Artifact Scope** | Synthetic single file (`.dupond_artifacts/${taskKey}/implementation.js`) | Real Git worktree (`.dupond_worktrees/<runId>/`) |
| **Verification** | In-process or subprocess syntax parse (`artifactRunner.ts`) | Sandboxed test execution (`AuthoritativeVerifier` + Seatbelt/Docker) |
| **Git Awareness** | Zero Git knowledge (no commits, no branches) | Full Git provenance (`revisionSha`, `baseCommit`, `targetBranch`) |
| **Approval** | No approval gate | Strict human operator gate (`GitHubDeliveryService`) |
| **Delivery** | Unified patch file export (`patch_export`) | Real GitHub Pull Request delivery via `gh` CLI |

> [!WARNING]
> **Operator Note**: Do not rely on the legacy Kanban "Done" status in the UI as proof of delivery. A task marked "Done" on the Kanban board may only reflect a synthetic file in `.dupond_artifacts/`. Authoritative acceptance is proven exclusively by a passing `VerificationRecord` and a successful `DeliveryRecord` in `data/dupond.db`.

---

## 🛠️ 5. Restart Behavior & Recovery Protocol

When Dupond restarts (following a crash, host reboot, or service deployment):

### 5.1 SQLite Transactional Recovery (`reconcileOnRestart`)
The `TaskStore` constructor automatically executes `reconcileOnRestart()` inside a database transaction ([`src/server/db/database.ts:488`](file:///Users/mac/ops/repos/dupond-audit/src/server/db/database.ts#L488)):
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
When a task is retried after a restart, `WorkspaceManager.createWorktree(runId, branchName, baseCommit)` inspects `.dupond_worktrees/<runId>`. If a dangling worktree directory remains from the previous interrupted process, `cleanupWorktree` is called first to unmount and remove the dangling worktree before creating a fresh checkout.

---

## 🔮 6. Proposed Enhancements (Future State)

The following capabilities are recommended for subsequent milestones:
1. **Cryptographic Specification Hashing (`specHash`)**:
   Hash the task description, criteria titles, and test commands (`SHA-256`) and store on `TaskRecord`. Bind `VerificationRecord` to `specHash` to detect semantic requirement changes.
2. **Environment Provenance Hashing (`envHash`)**:
   Hash the sandbox profile, container image ID, and Node.js version, storing it in `VerificationRecord` to guarantee reproducibility across heterogeneous test hosts.
3. **Unified Reactive State**:
   Deprecate `dupond_state.json` entirely. Expose the SQLite database directly over a unified reactive API (`/api/tasks`, `/api/runs`, `/api/verifications`), ensuring the web UI always reflects authoritative database records.
