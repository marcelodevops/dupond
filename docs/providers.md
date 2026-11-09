# Provider-Independent Coding Workers

Dupond features a **provider-independent coding worker architecture**. An operator can select Google Gemini or OpenAI (with an explicit model) on a per-task basis. Both providers share the exact same controlled workspace tools, execution sandbox, protected-path boundaries, authoritative verification, human approval gate, and delivery pipeline.

---

## 🏛️ Architecture Overview

The coding worker architecture decouples model communication from execution guarantees:

```
┌────────────────────────────────────────────────────────┐
│               Task Creation / Configuration            │
│       workerConfig: { provider, model }                │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
              ┌───────────────────────────┐
              │    Worker Registry        │
              │  resolveCodingWorker()    │
              └─────────────┬─────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────┐       ┌───────────────────────┐
│ GeminiProviderAdapter │       │ OpenAIProviderAdapter │
│ (GoogleGenAI SDK)     │       │ (Official OpenAI SDK) │
│ - Tools format        │       │ - Responses API       │
│ - Rate limit backoff  │       │ - function_call items │
│ - Usage metadata      │       │ - Fail-closed quota   │
└───────────┬───────────┘       └───────────┬───────────┘
            │                               │
            └───────────────┬───────────────┘
                            ▼
      ┌───────────────────────────────────────────┐
      │         Shared Coding Worker Loop         │
      │  runCodingWorkerLoop()                    │
      │  - Multi-turn conversation progression    │
      │  - Wall-clock timeout enforcement         │
      │  - AbortSignal cancellation support       │
      │  - Non-repetition of completed mutations  │
      │  - Independent Git diff/status collation  │
      └─────────────────────┬─────────────────────┘
                            ▼
      ┌───────────────────────────────────────────┐
      │          Shared Workspace Tools           │
      │  - list_files, read_file, write_file      │
      │  - run_permitted_command (OS Sandbox)     │
      │  - Strict resolveSafePath (no symlinks)   │
      │  - Protected paths rollback guardrail     │
      └─────────────────────┬─────────────────────┘
                            ▼
      ┌───────────────────────────────────────────┐
      │    Authoritative Verifier & Delivery      │
      │  - Sandbox execution of test checks       │
      │  - Human approval gate                    │
      │  - GitHub PR delivery via gh CLI          │
      └───────────────────────────────────────────┘
```

---

## ⚙️ Supported Providers & Models

### 1. Google Gemini
- **Environment Variable**: `GEMINI_API_KEY` (in environment or `.env`)
- **Default Model Identifier**: `gemini-3.5-flash`
- **Supported Models**:
  - `gemini-3.5-flash` (recommended for general coding tasks)
  - `gemini-3.8-flash` (latest flash reasoning model)
- **SDK**: `@google/genai`
- **Rate Limit & Quota Semantics**:
  - Automatically parses `retryDelay` or `retry in Xs` on transient 429 / `RESOURCE_EXHAUSTED` responses and backs off up to 4 attempts if delay is $\le 60\text{s}$.
  - Fails closed immediately if daily quota is exhausted (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) or if delay exceeds 60 seconds, preventing 10+ hour hanging sleep cycles.

### 2. OpenAI
- **Environment Variable**: `OPENAI_API_KEY` (in environment or `.env`)
- **Default Model Identifier**: `gpt-4o-mini`
- **Supported Models**:
  - `gpt-4o-mini` (recommended for lightweight coding tasks)
  - `gpt-4o` (high-capacity multimodal flagship model)
  - `o1` (advanced reasoning model; temperature omitted automatically)
  - `o3-mini` (efficient reasoning model; temperature omitted automatically)
  - `gpt-4.5-preview` (frontier preview model)
- **SDK**: Official `openai` Node SDK (`v4.x` / `v7.x` Responses API)
- **Rate Limit & Quota Semantics**:
  - Non-retryable errors (HTTP 400, 401, 403, 404) fail closed immediately.
  - Quota errors (`credit_balance_exhausted` / `insufficient_quota`) fail closed immediately on the first attempt without burning execution budget.

> [!IMPORTANT]
> **OpenAI Developer API Billing vs Consumer ChatGPT Subscriptions**
> OpenAI API access requires paid developer platform credits purchased directly at **[platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing/)**.
> A consumer ChatGPT subscription (ChatGPT Plus, Team, or Pro) **does NOT grant API access or API credits**. If an API key is used without deposited credits, the OpenAI API rejects calls with HTTP 429 `insufficient_quota` (`credit_balance_exhausted`).

---

## 📋 Task Configuration & Selection

### Via Authenticated API (`POST /api/tasks` or `/api/orchestrate/state`)

Specify the provider and model explicitly in `workerConfig`:

```json
{
  "key": "TASK-101",
  "title": "Implement feature utility",
  "description": "Implement utility function in src/util.js",
  "targetRepo": "owner/repo",
  "targetRepoPath": "/path/to/local/checkout",
  "baseCommit": "commit-sha",
  "allowedPaths": ["src/**"],
  "protectedPaths": ["test/**", "package.json", ".github/**"],
  "verificationCommands": [
    { "command": "npm test", "criteriaIds": ["c1"] }
  ],
  "acceptanceCriteria": [
    { "id": "c1", "title": "Unit tests pass" }
  ],
  "workerConfig": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "maxAttempts": 2,
  "timeoutSeconds": 300,
  "requireApproval": true
}
```

### Via Web UI
The Add Task modal and Task Details modal provide dropdown selectors for:
- **Coding Worker Provider**: Google Gemini (`gemini`) or OpenAI (`openai`).
- **Model Identifier**: Dropdown populated with supported models for the chosen provider, or a custom model text override.

---

## 🔒 Shared Security & Isolation Guardrails

Provider adapters are strictly prohibited from implementing custom or relaxed security policies. Regardless of the chosen model:
1. **Workspace Boundary**: The worker operates strictly inside an isolated worktree pinned to the run's `baseCommit`.
2. **Safe Path Resolution (`resolveSafePath`)**:
   - Lexical path normalization prevents directory traversal (`../`).
   - Realpath checks on intermediate directory ancestors prevent symlink breakout.
   - Symlinks pointing outside the workspace are rejected.
3. **Protected Path Rollback**:
   - Any attempt to modify protected files (`test/**`, `package.json`, `.github/**`, `.git/**`) is blocked.
   - If a tool call touches a protected path, all mutations from that call are automatically rolled back (`git checkout -- <file>`) and the call is rejected with an error.
4. **Command Execution Sandbox**:
   - Permitted build and test commands run inside the OS sandbox (Apple Seatbelt on macOS, rootless container on Linux).
   - Reading host secrets (`~/.ssh`, `~/.aws`, `~/.gemini`, `.env*`) is strictly blocked.
5. **Authoritative Verification**:
   - Acceptance criteria are verified independently by Dupond running operator commands in the sandbox. Worker self-attestation is ignored.
6. **Execution Budget & Cancellation**:
   - Every run is bound by wall-clock timeout (`timeoutSeconds`) and turn limit (`maxTurns: 12`).
   - AbortController cancellation immediately halts the execution loop.

---

## 📊 Live Demonstration Audit

A live parity demonstration was executed against the disposable public repository [`marcelodevops/dupond-live-demo`](https://github.com/marcelodevops/dupond-live-demo):

### 1. Google Gemini Success Path
- **Provider & Model**: `gemini:gemini-3.5-flash`
- **Target Repository**: `marcelodevops/dupond-live-demo`
- **Base Commit**: `85efa5e17524f2e5326d307091bfb8287785dc54`
- **Delivered Commit**: `e073ee81300a37f7ddf87a15e1f516cdd5d7439f`
- **Delivered Branch**: `dupond/AEG-702-GEMINI-feat-1794259596877`
- **Delivered Pull Request**: [PR #2: Implement percentageOf calculation utility](https://github.com/marcelodevops/dupond-live-demo/pull/2)
- **Authoritative Checks**:
  - `node --test test/math.test.js` (`PASSED`)
  - `node --test test/percentageOf.test.js` (`PASSED`)
- **Delivered Scope**: `+10 -0` lines in `src/math.js`. Zero protected path modifications.

### 2. OpenAI Fail-Closed Mode (Credit Balance Exhausted)
- **Provider & Model**: `openai:gpt-4o-mini`
- **Run ID**: `run-aeg-701-openai-1794260315469`
- **Status**: `failed` (Attempt 2 reached, fail-closed)
- **Duration**: `18229ms`
- **Failure Reason**:
  ```
  Model execution failed: OpenAI account credit balance exhausted (429 insufficient_quota): 
  429 You have no credits remaining. Add credits to continue using the API at 
  https://platform.openai.com/settings/organization/billing/.
  ```
- **Observed Behavior**: Detected `insufficient_quota` and immediately failed closed without retrying or looping.
- **Unblocking Requirement**: Deposit prepaid API credits at `https://platform.openai.com/settings/organization/billing/`.
