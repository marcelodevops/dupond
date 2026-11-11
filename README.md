<p align="center">
  <img src="resources/dupond-banner.png" alt="Dupond — detective with a bowler hat and moustache" width="900">
</p>

# Dupond

### Autonomous project orchestration, verified delivery.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js: 22+](https://img.shields.io/badge/Node.js-22.5%2B-green.svg)](https://nodejs.org/)
[![TypeScript: 5+](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Coding Workers: Gemini & OpenAI](https://img.shields.io/badge/Workers-Gemini%20%7C%20OpenAI-4285F4.svg)](docs/providers.md)
[![Version: 0.4.5](https://img.shields.io/badge/version-0.4.5-orange.svg)](CHANGELOG.md)

Dupond (also referred to as **Dupond Orchestrator**) is an autonomous, server-authoritative **task-to-Pull-Request system**. It takes structured task specifications with explicit acceptance criteria, prepares isolated Git worktrees, dispatches provider-independent coding workers (supporting Google Gemini and OpenAI), authoritatively executes test checks inside an OS sandbox, and delivers verified changes as reviewable GitHub Pull Requests under human operator approval.

> **Supervised Execution Notice**: Dupond is designed for supervised execution on disposable or dedicated development repositories. It does not provide microVM hardware virtualization, multi-tenant RBAC, or unmonitored production automation. All delivered Pull Requests require human review before merging.

---

## 👥 Meet the Team

Dupond frames its server-authoritative pipeline through the concept of a classic detective—**Dupond**—directing a specialized crew of friendly robot specialists. Each character symbolizes a clear operational responsibility across task preparation, implementation, sandboxed verification, and delivery:

| <img src="resources/agents/coordinator.png" width="96" height="96" alt="Dupond — Bowler-hatted Detective Coordinator"><br>**Dupond**<br>*(Coordinator)* | <img src="resources/agents/planner.png" width="96" height="96" alt="Planner robot holding a parchment map"><br>**Planner**<br>*(Task & Spec Prep)* | <img src="resources/agents/coding-worker.png" width="96" height="96" alt="Coding Worker robot behind a laptop"><br>**Coding Worker**<br>*(Implementation)* |
| :---: | :---: | :---: |
| Orchestrates the sprint lifecycle, pins ephemeral worktrees to base commits, and manages state transitions. | Structures task specifications into explicit acceptance criteria, verification commands, and protected paths. | Executes multi-turn tool calling (file inspection, code edits, shell commands) in an isolated Git worktree. |
| <img src="resources/agents/verifier.png" width="96" height="96" alt="Verifier robot inspecting clues with a magnifying glass"><br>**Verifier**<br>*(Authoritative Checks)* | <img src="resources/agents/reviewer.png" width="96" height="96" alt="Reviewer robot reading a document dossier"><br>**Reviewer**<br>*(Audit & Inspection)* | <img src="resources/agents/delivery.png" width="96" height="96" alt="Delivery robot holding a slate-blue briefcase"><br>**Delivery Agent**<br>*(PR Dispatch)* |
| Authoritatively runs test commands inside OS sandboxes; strictly enforces worktree cleanliness and protected paths. | Collates verified diffs, token logs, and check results to prepare comprehensive evidence for human review. | Reconciles remote base drift, re-verifies integrated commits, and delivers pull requests via the GitHub CLI (`gh`). |

> [!NOTE]
> **Workflow Roles vs. Implemented Architecture**:
> - **Operational Responsibilities**: These characters represent pipeline stages, not six independent running LLM agents.
> - **Authoritative OS Sandboxing**: The **Verifier** represents deterministic execution in an isolated OS sandbox (Apple Seatbelt or Linux container) with command exit code checks—not an LLM self-evaluating code.
> - **Mandatory Operator Gate**: The **Reviewer** prepares evidence for human review; it does **not** replace required human operator approval. Every pull request delivery requires explicit operator sign-off.
> - **Provider Independence**: Character identity is separate from AI model providers. The **Coding Worker** operates with whichever LLM backend is configured (e.g. Google Gemini or OpenAI).
>
> For full visual guidelines, palette specifications, and UI integration rules, see the [Visual Identity Guide](docs/visual-identity.md).

---

## 🎯 What Dupond Does

```
Task Spec & Criteria
       │
       ▼
Isolated Git Worktree (pinned to baseCommit)
       │
       ▼
Coding Worker (Gemini or OpenAI: inspects repo, edits code, runs permitted commands)
       │
       ▼
Authoritative Verifier (OS sandbox, checks test pass & protected path integrity)
       │
  Fail? ──► Bounded Repair Loop (up to maxAttempts with actionable feedback)
       │
  Pass?
       ▼
Remote Base Drift Check (fetches remote base; re-verifies if base advanced)
       │
       ▼
Human Operator Approval Gate (rejects unapproved deliveries)
       │
       ▼
GitHub PR Delivery (pushes branch, opens PR via gh CLI, idempotent)
```

1. **Explicit Target Resolution**: Resolves target repository paths explicitly; refuses to execute against missing paths and never silently falls back to the orchestrator's own repository.
2. **Pinned Worktree Isolation**: Pins each task run to a recorded base commit in an ephemeral Git worktree (`git worktree add -B <branch> <path> <baseCommit>`).
3. **Real Tool-Calling Worker**: The coding worker inspects repository files, reads tests, and modifies code through strictly scoped tools with path boundaries.
4. **Authoritative Sandboxed Verification**: Independent of worker self-attestation, Dupond executes operator-configured verification commands inside an OS sandbox (macOS Seatbelt or Linux Podman/Docker).
5. **Protected Path Integrity**: Strictly forbids modifications to test suites, build manifests, or CI workflows (`protectedPaths`). Any modification fails verification immediately.
6. **Bounded Repair Loop**: If checks fail, captures stdout, stderr, and exit codes, providing actionable repair feedback to the worker for bounded subsequent attempts.
7. **Remote Base Drift Verification**: Fetches the remote base branch before delivery. If the remote base has advanced, merges the updated base, re-verifies the combined result, and invalidates any prior approval if the commit changed.
8. **Explicit Human Approval Gate**: Delivery is blocked until an operator reviews the verified diff and explicitly approves the exact commit revision.
9. **Idempotent Delivery**: Delivers branches and opens PRs using the GitHub CLI (`gh`), reconciling existing PRs without creating duplicates.

---

## 🚀 Live Demonstration

An end-to-end demonstration of Dupond v0.1.0 was executed against a disposable public GitHub repository:

- **Delivered Pull Request (PR #1)**: [https://github.com/marcelodevops/dupond-live-demo/pull/1](https://github.com/marcelodevops/dupond-live-demo/pull/1)
- **Delivered Pull Request (PR #2)**: [https://github.com/marcelodevops/dupond-live-demo/pull/2](https://github.com/marcelodevops/dupond-live-demo/pull/2)
- **Delivered Commit SHA**: `e073ee81300a37f7ddf87a15e1f516cdd5d7439f` (PR #2)
- **Base Commit SHA**: `85efa5e17524f2e5326d307091bfb8287785dc54` (`main`)
- **Remote CI Run**: [https://github.com/marcelodevops/dupond-live-demo/actions](https://github.com/marcelodevops/dupond-live-demo/actions) (`SUCCESS`)
- **Current Status**: **OPEN** (intentionally unmerged for inspection)

### What the Artifact Proves:
- The PR was delivered to a separate public GitHub repository.
- Only application code (`src/math.js`, +17 lines) was modified to implement `percentageOf(value, percentage)`.
- Protected paths (`test/**`, `package.json`, `.github/**`) were untouched.
- GitHub Actions CI ran on the delivered commit and passed 100%.

For full details on what the GitHub artifact proves versus what relies on local execution telemetry, see [`docs/live-demonstration.md`](docs/live-demonstration.md).

---

## 💻 Prerequisites & Setup

### Runtime Requirements
- **Node.js**: `v22.5.0` or higher (Node 22 LTS or Node 24 recommended; relies on Node's built-in `node:sqlite`).
- **npm**: `v9.x` or higher.
- **Git**: `v2.30+` installed and configured.
- **GitHub CLI (`gh`)**: Installed and authenticated (`gh auth login`) with `repo` scopes for PR delivery.
- **Google Gemini API Key**: Valid API key from [Google AI Studio](https://aistudio.google.com/).

### Sandbox Prerequisites
- **macOS**: Built-in Apple Seatbelt (`sandbox-exec`).
- **Linux**: Rootless `podman` (recommended) or `docker`. If on Linux, pre-pull the sandbox image:
  ```bash
  npm run prepare:sandbox
  ```

---

## ⚙️ Configuration & Environment Variables

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `DUPOND_API_KEY` | Optional* | *(none)* | Bearer token required for API access. Takes highest precedence over `DUPOND_AUTH_TOKEN`. |
| `DUPOND_AUTH_TOKEN` | Optional* | *(persisted token)* | Bearer token required for API access (used if `DUPOND_API_KEY` is unset). If neither is set, Dupond generates a random token (`dp_<hex>`) and persists it to `data/.dupond_auth_token` with `0600` permissions. |
| `GEMINI_API_KEY` | Optional* | *(none)* | Google GenAI API key for Gemini coding workers. Required if using Gemini. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash` | Default Gemini model identifier (`gemini-3.5-flash` or `gemini-3.8-flash`). |
| `OPENAI_API_KEY` | Optional* | *(none)* | OpenAI API key for OpenAI coding workers. Required if using OpenAI. |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Default OpenAI model identifier (`gpt-4o-mini`, `gpt-4o`, `o1`, `o3-mini`, `gpt-4.5-preview`). |
| `PORT` | No | `3000` | HTTP port for the application server. |
| `DUPOND_DB_PATH` | No | `./data/dupond.db` | File path for SQLite task and execution history database. |
| `DUPOND_STATE_FILE` | No | `./data/dupond_state.json` | File path for JSON sprint and UI telemetry state. |
| `DUPOND_SANDBOX_IMAGE` | No | `node:22-bookworm` | Container image used for Linux sandbox execution. |
| `DUPOND_ALLOW_PRIVATE_PROVIDER_HOSTS` | No | `false` | When true, permits custom providers targeting local/LAN hosts. |
| `GH_TOKEN` / `GITHUB_TOKEN` | No | *(system keyring)* | GitHub token for headless CI delivery. |

---

## 🏃 Quickstart & Walkthrough

### 1. Clone & Install Dependencies
```bash
git clone git@github.com:marcelodevops/dupond.git
cd dupond
npm install
```

### 2. Start the Application Server
```bash
export DUPOND_API_KEY="your_operator_secret_token"  # or export DUPOND_AUTH_TOKEN="..."
export GEMINI_API_KEY="AIzaSy..."
npm start
```
> If neither `DUPOND_API_KEY` nor `DUPOND_AUTH_TOKEN` is set, Dupond generates an instance token and stores it in `data/.dupond_auth_token` (`chmod 600`). API requests must provide it via `Authorization: Bearer <token>` or `X-Dupond-Token: <token>`.

Verify server health:
```bash
curl -s http://localhost:3000/api/health
```

### 3. Practical API Walkthrough
Dupond is controlled via authenticated HTTP API calls. A minimal execution cycle consists of:
1. **Configure Repository**: `POST /api/orchestrate/state` (registers local target repository path and remote slug).
2. **Submit Task**: `POST /api/orchestrate/state` (specifies criteria, allowed/protected paths, verification commands).
3. **Execute Worker Step**: `POST /api/orchestrate/agent-step` (worker inspects workspace, edits code, verifies in sandbox).
4. **Inspect Evidence**: `GET /api/runs/:id` (inspects diff, iteration logs, tokens, and authoritative test results).
5. **Approve Delivery**: `POST /api/delivery/dispatch` with `{ isApproved: true, approvedBy: "..." }`.

For concrete `curl` commands and JSON payload examples, see the [Practical API Walkthrough Guide](docs/walkthrough.md).

---

## 🔒 Security Architecture & Sandbox Isolation

Dupond enforces strict defensive boundaries across all operations:

- **Worktree Boundary**: All worker operations occur in an isolated Git worktree pinned to the recorded `baseCommit`.
- **Command Sandboxing**:
  - **macOS Seatbelt**: Denies file writes outside the worktree and temp directory; denies reading user home credentials (`~/.ssh`, `~/.aws`, `~/.config`, `~/.gemini`, `~/.gnupg`, and `.env*` files); strips ambient host environment variables.
  - **Linux Container**: Runs in a read-only root container with `--network none` mounting only the worktree.
- **SSRF Defense with Anti-Rebinding**: Pinned socket egress pre-resolves hostnames to verify IP ranges before connecting, blocking private, link-local, loopback, and cloud metadata addresses (`169.254.169.254`).
- **Credential Redaction**: Client-facing state endpoints mask all credentials with `••••••••`. State updates preserve real server-held secrets.

For detailed architecture diagrams, Seatbelt rules, and isolation limits, see [Architecture & Sandbox Documentation](docs/architecture-and-sandbox.md).

---

## 🧪 Testing & Verification

Dupond contains 18 automated test suites covering security guardrails, sandbox isolation, database transactions, worker tool dispatch, repair loops, delivery drift reconciliation, acceptance evidence lifecycle, release automation, and end-to-end acceptance scenarios:

```bash
# Run the complete automated test suite (18 test suites)
npm test

# Run TypeScript type check
npm run lint

# Check release metadata consistency
npm run release:check

# Pre-pull container image for Linux sandbox
npm run prepare:sandbox
```

### Test Suite Distinction:
- **Local Test Suites (`npm test`)**: Use temporary local Git repositories, mock/fixture coding workers, and local Git remotes to verify coordination logic, sandbox boundaries, and database transactions deterministically without incurring API costs or requiring live network access.
- **Live Demonstrations**: Run against actual remote GitHub repositories using the live Gemini API and real GitHub CLI authentication.

---

## 📚 Documentation Index

- [Acceptance Evidence & Approval Contract](docs/acceptance-evidence.md): Authoritative verification, evidence fingerprinting, base drift protocol, and operator approval gates.
- [Provider-Independent Coding Workers](docs/providers.md): Architecture, Gemini/OpenAI configuration, platform billing prerequisites, and live parity audit.
- [Practical API Walkthrough](docs/walkthrough.md): Step-by-step API guide with concrete `curl` requests.
- [Architecture & Sandbox Guide](docs/architecture-and-sandbox.md): Deep-dive into worktree management, Seatbelt profiles, Linux containers, and persistence schemas.
- [Troubleshooting Guide](docs/troubleshooting.md): Solutions for missing credentials, rate limits, Linux Podman timeouts, and base drift conflicts.
- [Live Demonstration Audit](docs/live-demonstration.md): Full analysis of live demonstrations in `marcelodevops/dupond-live-demo`.
- [Visual Identity Guide](docs/visual-identity.md): Character-to-role mappings, ligne claire design system, palette specifications, and UI integration rules.
- [Release Changelog](CHANGELOG.md): Notes and release history across versions.

---

## 📄 License

This project is licensed under the [Apache License 2.0](LICENSE).
