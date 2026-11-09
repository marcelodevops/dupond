# Dupond Troubleshooting Guide

This guide covers common errors, causes, and solutions when configuring and running Dupond v0.1.0.

---

## 1. Authentication & Credentials

### Error: `401 Unauthorized` on API requests
- **Cause**: Dupond enforces Bearer token authentication across all API endpoints (except public `/api/health`).
- **Solution**:
  1. Ensure `DUPOND_AUTH_TOKEN` is set when starting the server:
     ```bash
     export DUPOND_AUTH_TOKEN="your_operator_secret_token"
     ```
  2. Include the header in your requests:
     ```bash
     -H "Authorization: Bearer your_operator_secret_token"
     ```
  3. If `DUPOND_AUTH_TOKEN` was not set, check the server startup log for the ephemeral token generated for that session.

### Error: `Prerequisite missing: GEMINI_API_KEY is not set`
- **Cause**: The coding worker is configured for `gemini` but lacks an API key.
- **Solution**:
  Set the key in your environment or in `.env`:
  ```bash
  export GEMINI_API_KEY="AIzaSy..."
  ```
  Check `curl http://localhost:3000/api/health` to confirm `"hasGeminiKey": true`.

### Error: `Prerequisite missing: OPENAI_API_KEY is not set`
- **Cause**: The coding worker is configured for `openai` but lacks an API key.
- **Solution**:
  Set the key in your environment or in `.env`:
  ```bash
  export OPENAI_API_KEY="sk-..."
  ```
  Confirm that your OpenAI organization has an active developer project.

### Error: `OpenAI account credit balance exhausted (429 insufficient_quota)`
- **Cause**: The configured OpenAI developer account has zero prepaid credits remaining.
- **Critical Distinction**: OpenAI developer API usage is billed separately from consumer ChatGPT web subscriptions (ChatGPT Plus, Team, or Pro). A consumer ChatGPT subscription does **not** provide API credits.
- **Solution**:
  1. Navigate to **[platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing/)**.
  2. Add credit balance ($5–$10 is sufficient for hundreds of task runs).
  3. Ensure your API key has permission for the desired model (e.g., `gpt-4o-mini`).

### Error: `GitHub authentication failed` or PR creation rejected
- **Cause**: The GitHub CLI (`gh`) lacks credentials or has insufficient OAuth/PAT permissions to push branches or create pull requests.
- **Solution**:
  1. Run `gh auth status` to check active account and scopes.
  2. Re-authenticate with `repo` scopes:
     ```bash
     gh auth login -s repo
     ```
  3. If running headless in CI, supply a personal access token via `GH_TOKEN` or `GITHUB_TOKEN`.

---

## 2. Gemini Models & Rate Limits

### Error: `HTTP 404: Model models/gemini-2.5-flash is no longer available`
- **Cause**: Google deprecated `gemini-2.5-flash` for new API accounts.
- **Solution**:
  Use `gemini-3.5-flash` (recommended) or `gemini-3.8-flash`:
  ```bash
  export GEMINI_MODEL="gemini-3.5-flash"
  ```
  You can also specify the model in the task definition under `workerConfig.model`.

### Error: `HTTP 429: RESOURCE_EXHAUSTED` / `Generate content requests per minute limit exceeded`
- **Cause**: The Gemini Free Tier limits requests to 5 requests per minute.
- **Automatic Handling**:
  Dupond's `GeminiWorkerAdapter` includes automatic backoff handling. When Google returns HTTP 429 with a `retryDelay`, Dupond pauses execution, logs the delay (`Rate limit encountered. Waiting Xs before retry...`), and retries up to 4 times automatically.
- **If Retries are Exhausted**:
  - Increase the task timeout budget (`timeoutSeconds: 600`).
  - Upgrade your Google AI Studio project to pay-as-you-go (Tier 1) to remove the 5 RPM ceiling.

---

## 3. Sandbox & Container Execution

### Error: `Execution sandbox unavailable: Neither podman nor docker is installed` (Linux)
- **Cause**: On Linux, Dupond strictly enforces container isolation. If neither Podman nor Docker is found in `PATH`, execution fails closed.
- **Solution**:
  Install rootless Podman (recommended):
  ```bash
  sudo apt-get install -y podman
  ```
  Ensure `podman info` runs successfully as your user.

### Error: Command timeout during first container run on Linux (Exit code 124)
- **Cause**: Podman was downloading the sandbox container image (`node:22-bookworm`) inside the execution timeout window.
- **Solution**:
  Pre-pull the image before starting runs:
  ```bash
  npm run prepare:sandbox
  ```
  Or pull manually:
  ```bash
  podman pull docker.io/library/node:22-bookworm
  ```

### Error: `Operation not permitted` during Git commands in sandbox (macOS)
- **Cause**: The macOS Seatbelt sandbox restricts reads and writes outside the worktree. If global Git config or credential helpers point to paths in `$HOME` (e.g. `/Users/<user>/.config/` or `_temp/git-credentials`), Seatbelt blocks access.
- **Solution**:
  - Configure Git author/committer via environment variables (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`) rather than relying on global files in `$HOME`.
  - When using `actions/checkout` in CI, set `with: { persist-credentials: false }` to avoid generating external credential files.

---

## 4. Target Repository Resolution

### Error: `Delivery blocked: Workspace repository delivery remote 'origin' does not match configured target repository`
- **Cause**: The local worktree's Git `origin` remote URL does not match the `targetRepo` recorded for the task.
- **Solution**:
  Verify the repository slug and remote configuration:
  ```bash
  git -C /path/to/target-repo remote get-url origin
  ```
  Ensure `targetRepo` is set to `owner/repo-name` matching the origin URL.

### Error: `Target repository configuration blocked: Path does not exist or is not a git repository`
- **Cause**: `targetRepoPath` was specified, but the path does not exist on disk or does not contain a `.git` folder.
- **Solution**:
  Provide an absolute, valid path to an existing local Git checkout of the target repository. Dupond never silently defaults to its own repository.

---

## 5. Verification & Integrity Failures

### Error: `Integrity check failed: Worker modified protected file "..."`
- **Cause**: The worker modified a file matching `protectedPaths` (such as `test/**`, `package.json`, or `.github/**`).
- **Solution**:
  Workers are strictly prohibited from modifying test criteria or CI manifests. If the worker needs different interfaces, adjust the task description or allowed path patterns.

### Error: `Verification incomplete: Acceptance criteria [...] have no passing check evidence`
- **Cause**: The operator-configured `verificationCommands` passed, but one or more required acceptance criteria IDs were not mapped to passing commands.
- **Solution**:
  Ensure every required criterion in `acceptanceCriteria` is covered by at least one command in `verificationCommands` or contains an individual `checkCommand`.

---

## 6. Pull Request Delivery & Base Drift

### Error: `HTTP 403: Backend approval policy requires explicit operator approval before delivery`
- **Cause**: The task has `requireApproval: true` (the default) and the delivery request omitted `isApproved: true`.
- **Solution**:
  Inspect the verified diff via `GET /api/runs/:id`, then submit approval:
  ```json
  {
    "runId": "<runId>",
    "isApproved": true,
    "approvedBy": "operator-name"
  }
  ```

### Error: `HTTP 409: Delivery blocked: Base branch main has advanced ... and could not be merged cleanly`
- **Cause**: Remote base branch `origin/main` advanced while the worker was executing, and merging the updated remote base resulted in Git conflicts.
- **Solution**:
  Resolve the conflict manually or re-trigger the task with the updated `baseCommit`.

### Error: `HTTP 403: Prior approval for <commitA> is invalidated; operator approval is required for <commitB>`
- **Cause**: The remote base advanced, and merging it created a new commit SHA. Because the code changed, Dupond invalidated the prior approval and re-verified the merged result.
- **Solution**:
  Review the newly merged commit revision via `GET /api/runs/:id` and dispatch delivery with approval for the new revision.
