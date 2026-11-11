# Architecture, Storage & Execution Sandbox

This document outlines the architecture, persistence layers, isolation mechanisms, and security boundaries implemented in Dupond.

> [!NOTE]
> **Visual Roles in System Architecture**: In Dupond's [Visual Identity](visual-identity.md), the **Coordinator** (Dupond) orchestrates the task state and worktree lifecycles, while the **Verifier** robot executes authoritative test commands inside the OS sandbox.

---

## 1. System Architecture Overview

Dupond is designed as a task-to-PR orchestration engine. Rather than relying on simulated progress or unverified worker self-declarations, Dupond operates as an authoritative coordinator:

```
[ Operator / API Client ]
         │
         ▼  (Authenticated HTTP API with Bearer token)
[ Dupond Application Server ]
   ├── Express REST API + State Gatekeeper
   ├── Dual-Store Persistence (SQLite TaskStore + JSON Sprint State)
   │
   ├── [ Workspace Manager ]
   │      └── Creates isolated Git Worktrees pinned to baseCommit
   │
   ├── [ Gemini Worker Adapter ]
   │      ├── Model: gemini-3.5-flash / gemini-3.8-flash
   │      ├── Tool Dispatch: list_files, read_file, write_file, run_permitted_command
   │      └── Path Guards: allowedPaths / protectedPaths enforcement
   │
   ├── [ Authoritative Verifier ]
   │      ├── OS Execution Sandbox (macOS Seatbelt or Linux Container)
   │      ├── Integrity Check: Prohibits edits to protected files
   │      └── Direct Execution: Runs operator checks independently of worker
   │
   └── [ GitHub Delivery Service ]
          ├── Operator Approval Gating (isApproved required)
          ├── Remote Base Fetch & Drift Reconciliation
          └── Idempotent Branch Push & PR Creation (gh CLI)
```

---

## 2. Storage & Persistence Architecture

Dupond uses a dual-store model to cleanly separate interactive sprint telemetry from authoritative execution records:

### 2.1 SQLite Authoritative TaskStore (`node:sqlite`)
All task specifications, execution runs, worker attempts, verification results, and delivery records are stored in a transactional SQLite database using Node.js's built-in `node:sqlite` module (`DatabaseSync`).

- **Default path**: `data/dupond.db`
- **Configurable via**: `DUPOND_DB_PATH` environment variable.
- **Relational schema**:
  - `tasks`: Task definitions, target repository paths, base commits, path scopes (`allowedPaths`, `protectedPaths`), verification commands, and acceptance criteria.
  - `task_runs`: Execution run instances, status (`running`, `completed`, `failed`), target branch, worktree directory path, base commit, and failure reasons.
  - `run_attempts`: Individual worker attempts, status (`succeeded`, `failed`), worker provider, diff of modified files, full tool logs, prompt/completion token usage, and execution duration.
  - `verifications`: Authoritative verification runs, verified revision commit SHA, exit codes, stdout, stderr, and explicit criteria verified.
  - `deliveries`: Pull request number, URL, delivered commit SHA, base commit SHA, CI status, and operator approval details (`approvedBy`, `approvalStatus`).

### 2.2 JSON Sprint State (`data/dupond_state.json`)
The interactive board, DAG dependency graphs, agent profiles, and inter-agent communication messages are stored in JSON state.

- **Default path**: `data/dupond_state.json`
- **Configurable via**: `DUPOND_STATE_FILE` environment variable.
- **Credential masking**: Wire representations returned via `GET /api/orchestrate/state` mask bearer secrets with bullet characters (`••••••••`). The server preserves underlying secrets on mutation round-trips.

---

## 3. Workspace Isolation (Git Worktrees)

To avoid modifying Dupond's own repository or polluting the target repository's working tree, each execution run creates a dedicated, ephemeral Git worktree:

1. **Base Commit Pinning**: When a task run starts, `WorkspaceManager` creates an isolated worktree rooted at `<targetRepo>/.dupond_worktrees/<runId>` checking out a fresh branch `dupond/<taskKey>-feat-<timestamp>` from the recorded `baseCommit`:
   ```bash
   git worktree add -B dupond/<key>-feat-<ts> .dupond_worktrees/<runId> <baseCommit>
   ```
2. **Worktree Directory Containment**: All worker file reads, writes, and test commands are strictly confined to this directory.
3. **Clean Up & Teardown**: Completed or failed worktrees are unmounted and pruned via `git worktree remove` upon completion or cancellation.

---

## 4. Execution Sandbox

Dupond provides platform-specific command sandboxing to execute test suites and worker commands with limited host access:

### 4.1 macOS: Seatbelt (`sandbox-exec`)
On macOS, Dupond uses Apple's Seatbelt mechanism to restrict process execution:

- **Write confinement**: File writes are denied everywhere except:
  - The isolated worktree directory (`(allow file-write* (subpath "<worktree>"))`).
  - An isolated temporary directory (`realTmp`).
  - Git worktree metadata directories (`gitDir`).
  - `/dev/null`, `/dev/zero`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`.
- **Read restriction**: Explicitly denies reading sensitive user directories:
  - Denies access to `$HOME` outside the worktree (`(deny file-read-data (subpath "${home}"))`).
  - Denies reading `.env*` files (`(deny file-read* (regex #"/\\.env.*$"))`).
- **Environment sanitization**: Host environment variables are stripped. Only essential system keys (`PATH`, `LANG`, `LC_ALL`, `TERM`, `SHELL`, `SYSTEMROOT`) and sanitized `GIT_*` author/committer identities are passed.
- **Process group isolation**: Commands launch in detached process groups with timeouts. If a command exceeds its timeout, a `SIGKILL` is issued to the entire process group.

### 4.2 Linux: Rootless Container Isolation (Podman / Docker)
On Linux, Dupond requires containerization:

- **Runtime selection**: Automatically detects `podman` (preferred) or `docker`. If neither is installed, command execution fails closed.
- **Container parameters**:
  - Root filesystem mounted read-only (`--read-only`).
  - Worktree directory mounted read-write (`-v <worktree>:<worktree>`).
  - Network disabled by default (`--network none`).
  - Running as current user (`--user <uid>:<gid>`).
- **Image preparation**: Uses `node:22-bookworm` by default (overridable via `DUPOND_SANDBOX_IMAGE`). Image pulling is decoupled from command execution timeouts (`npm run prepare:sandbox`).

### 4.3 Sandbox Scope and Real-World Limitations
Dupond's sandboxing provides meaningful defense against accidental host modifications, runaway scripts, and ambient credential leakage. However:
- **No "Zero RCE" guarantee**: Seatbelt is an OS-level facility, not a hardware hypervisor.
- **Shared Kernel**: Containers share the host Linux kernel and do not offer microVM (e.g. Firecracker) hardware virtualization.
- **Git Global Configurations**: If a target project's build tool tries to write to `$HOME` or read credentials outside the worktree, the sandbox will block the operation with `Operation not permitted`.
- **Target Risk Scope**: Dupond v0.1.0 is intended for supervised execution on disposable or dedicated development repositories.

---

## 5. Guardrails & Integrity Verification

### 5.1 Allowed Paths vs. Protected Paths
Every task specifies path boundaries:
- **`allowedPaths`** (e.g. `['src/**']`): The worker can only modify files matching these patterns. Writes to any other path are rejected immediately by the worker adapter.
- **`protectedPaths`** (e.g. `['test/**', 'package.json', '.github/**']`): Protected paths cannot be modified by the worker. Any attempt by the worker tool to write to these files returns an immediate error.

### 5.2 Post-Run Integrity Check
Before running verification checks, the `AuthoritativeVerifier` computes:
```bash
git diff --name-only <baseCommit> HEAD
```
If any file matching `protectedPaths` was modified (even through indirect commands), verification fails immediately with an integrity check violation.

### 5.3 Authoritative Verification
Verification is not an attestation by the LLM. The `AuthoritativeVerifier` independently launches the operator-configured `verificationCommands` inside the sandbox, captures exit codes and stdout/stderr, and maps passing tests to required acceptance criteria IDs.

### 5.4 Remote Base Drift Reconciliation
Before delivering a pull request, Dupond fetches the target remote base:
```bash
git fetch origin main
```
1. If `FETCH_HEAD` matches the run's `baseCommit`, delivery proceeds.
2. If `origin/main` has advanced:
   - Dupond merges `FETCH_HEAD` into the worktree.
   - If merge conflicts occur, delivery blocks with HTTP 409 Conflict.
   - If merge succeeds, Dupond re-runs authoritative verification on the combined result.
   - **Re-approval requirement**: If integration produced a new commit SHA, prior operator approval is invalidated. The operator must explicitly review and approve the new merged commit SHA before delivery can proceed.
