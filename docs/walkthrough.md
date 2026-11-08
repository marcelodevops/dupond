# Dupond Practical Walkthrough: Authenticated HTTP API

This walkthrough demonstrates the complete operational flow of Dupond v0.1.0 using the real authenticated HTTP API endpoints.

---

## Prerequisites

1. **Node.js**: v22.5.0 or higher.
2. **Gemini API Key**: Set in environment or `.env` as `GEMINI_API_KEY`.
3. **GitHub CLI (`gh`)**: Installed and authenticated with repository and pull-request permissions (`gh auth login`).
4. **Target Repository**: A local Git clone of the repository you want Dupond to modify, with an active remote configured (e.g. `origin`).
5. **Dupond Server**: Running locally with a configured authentication token.

---

## 1. Starting the Server

Set your environment variables and start Dupond:

```bash
export DUPOND_AUTH_TOKEN="your_secure_operator_token"
export GEMINI_API_KEY="your_gemini_api_key"
export GEMINI_MODEL="gemini-3.5-flash"  # or gemini-3.8-flash
export PORT=3000

# Optional: isolate state and database for the run
export DUPOND_STATE_FILE="./data/dupond_state.json"
export DUPOND_DB_PATH="./data/dupond.db"

npm start
```

Verify that the server is healthy:

```bash
curl -s http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "healthy",
  "hasGeminiKey": true,
  "daemonRunning": false,
  "timestamp": "2026-11-08T20:18:27.526Z"
}
```

---

## 2. Configuring the Target Repository

Register the target repository in Dupond's state. Replace `/path/to/target-repo` with the absolute path to your local clone, and `owner/target-repo` with the remote repository slug.

```bash
curl -s -X POST http://localhost:3000/api/orchestrate/state \
  -H "Authorization: Bearer your_secure_operator_token" \
  -H "Content-Type: application/json" \
  -d '{
    "integrationConfig": {
      "repository": {
        "provider": "github",
        "repoUrl": "owner/target-repo",
        "localPath": "/path/to/target-repo",
        "defaultBranch": "main",
        "status": "connected"
      }
    }
  }'
```

---

## 3. Submitting a Task with Explicit Criteria

Submit a task with defined acceptance criteria, verification commands, and path guardrails:

```bash
curl -s -X POST http://localhost:3000/api/orchestrate/state \
  -H "Authorization: Bearer your_secure_operator_token" \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {
        "id": "task-demo-101",
        "key": "AEG-101",
        "title": "Add percentageOf utility function",
        "description": "Add percentageOf(value, percentage) to src/math.js. Return (value * percentage) / 100. Throw TypeError for non-numbers or non-finite inputs. Preserve existing behavior.",
        "epicId": "epic-core",
        "status": "todo",
        "priority": "high",
        "assignedAgentId": "agent-1",
        "estimatedHours": 2,
        "spentHours": 0,
        "dependencies": [],
        "targetRepo": "owner/target-repo",
        "targetRepoPath": "/path/to/target-repo",
        "baseCommit": "HEAD",
        "allowedPaths": ["src/**"],
        "protectedPaths": ["test/**", "package.json", ".github/**"],
        "verificationCommands": [
          {
            "command": "npm test",
            "criteriaIds": ["crit-1", "crit-2"]
          }
        ],
        "acceptanceCriteria": [
          {
            "id": "crit-1",
            "title": "Calculates percentageOf(200, 15) === 30"
          },
          {
            "id": "crit-2",
            "title": "Rejects non-number arguments with TypeError"
          }
        ],
        "subtasks": [
          { "id": "crit-1", "title": "Calculates percentageOf(200, 15) === 30", "completed": false },
          { "id": "crit-2", "title": "Rejects non-number arguments with TypeError", "completed": false }
        ],
        "workerConfig": {
          "provider": "gemini",
          "model": "gemini-3.5-flash"
        },
        "maxAttempts": 2,
        "timeoutSeconds": 300,
        "requireApproval": true
      }
    ]
  }'
```

---

## 4. Triggering the Coding Worker Step

Instruct the coding worker to inspect the workspace, implement the change, and run tests:

```bash
curl -s -X POST http://localhost:3000/api/orchestrate/agent-step \
  -H "Authorization: Bearer your_secure_operator_token" \
  -H "Content-Type: application/json" \
  -d '{
    "task": {
      "id": "task-demo-101",
      "key": "AEG-101",
      "title": "Add percentageOf utility function",
      "description": "Add percentageOf(value, percentage) to src/math.js. Return (value * percentage) / 100. Throw TypeError for non-numbers or non-finite inputs. Preserve existing behavior.",
      "epicId": "epic-core",
      "status": "todo",
      "priority": "high",
      "assignedAgentId": "agent-1",
      "targetRepo": "owner/target-repo",
      "targetRepoPath": "/path/to/target-repo",
      "baseCommit": "HEAD",
      "allowedPaths": ["src/**"],
      "protectedPaths": ["test/**", "package.json", ".github/**"],
      "verificationCommands": [
        {
          "command": "npm test",
          "criteriaIds": ["crit-1", "crit-2"]
        }
      ],
      "acceptanceCriteria": [
        { "id": "crit-1", "title": "Calculates percentageOf(200, 15) === 30" },
        { "id": "crit-2", "title": "Rejects non-number arguments with TypeError" }
      ],
      "maxAttempts": 2,
      "timeoutSeconds": 300,
      "requireApproval": true
    },
    "agent": {
      "id": "agent-1",
      "name": "Kaelen Dev",
      "role": "Senior Full-Stack Engineer"
    }
  }'
```

Response includes the execution result, verified revision SHA, and persistent `runId`:
```json
{
  "success": true,
  "runId": "run-aeg-101-1794169446721",
  "roleAssumed": "Senior Full-Stack Engineer (Assumed for AEG-101)",
  "reasoning": "Inspected workspace and executed verified test suite for AEG-101...",
  "actionTaken": "Executed real coding worker in isolated worktree for AEG-101 (Revision: a1b2c3d4e5)",
  "nextStatus": "in_progress",
  "subtasksCompleted": ["crit-1", "crit-2"]
}
```

---

## 5. Inspecting Run Evidence and Diff

Fetch the persistent run details, attempt diffs, tool execution logs, and authoritative verification records:

```bash
curl -s -H "Authorization: Bearer your_secure_operator_token" \
  http://localhost:3000/api/runs/run-aeg-101-1794169446721
```

Or query by task identifier:
```bash
curl -s -H "Authorization: Bearer your_secure_operator_token" \
  http://localhost:3000/api/tasks/task-demo-101/runs
```

The response returns:
- `run`: Target branch, worktree path, base commit, execution status.
- `attempts`: Diff of files modified, full tool call iteration log, token usage, and durations.
- `verification`: Authoritative test execution logs (stdout/stderr), exit codes, passing criteria IDs, and verified commit revision SHA.
- `delivery`: Delivery records once dispatched.

---

## 6. Reviewing and Approving Delivery

### Testing Approval Enforcement
Attempting to deliver without explicit approval (`isApproved: false`) is rejected by the server:

```bash
curl -s -X POST http://localhost:3000/api/delivery/dispatch \
  -H "Authorization: Bearer your_secure_operator_token" \
  -H "Content-Type: application/json" \
  -d '{
    "runId": "run-aeg-101-1794169446721",
    "isApproved": false,
    "repoUrl": "owner/target-repo",
    "targetBaseBranch": "main"
  }'
```

Response:
```json
{
  "success": false,
  "status": 403,
  "blocked": true,
  "approvalRequired": true,
  "error": "Delivery blocked: Backend approval policy requires explicit operator approval before delivery."
}
```

### Approved Delivery Dispatch
Once the operator has reviewed the diff and verified check results, dispatch delivery with explicit approval:

```bash
curl -s -X POST http://localhost:3000/api/delivery/dispatch \
  -H "Authorization: Bearer your_secure_operator_token" \
  -H "Content-Type: application/json" \
  -d '{
    "runId": "run-aeg-101-1794169446721",
    "isApproved": true,
    "approvedBy": "operator-username",
    "repoUrl": "owner/target-repo",
    "targetBaseBranch": "main"
  }'
```

Expected response:
```json
{
  "success": true,
  "status": 200,
  "deliveryRecord": {
    "runId": "run-aeg-101-1794169446721",
    "provider": "github",
    "repoUrl": "owner/target-repo",
    "baseCommit": "2b85fad2dc5bd849b1b05898db78dfc876761b0e",
    "deliveredCommit": "e62c2e9ed11d1349efacb2344e08d2a8a9edeafb",
    "branch": "dupond/AEG-101-feat-1794169446721",
    "prNumber": 42,
    "prUrl": "https://github.com/owner/target-repo/pull/42",
    "ciStatus": "pending",
    "approvalStatus": "approved",
    "approvedBy": "operator-username"
  },
  "prUrl": "https://github.com/owner/target-repo/pull/42",
  "branch": "dupond/AEG-101-feat-1794169446721",
  "deliveredCommit": "e62c2e9ed11d1349efacb2344e08d2a8a9edeafb",
  "baseCommit": "2b85fad2dc5bd849b1b05898db78dfc876761b0e",
  "message": "Pull request successfully delivered: https://github.com/owner/target-repo/pull/42"
}
```

The pull request is now delivered on GitHub, linked to the verified commit, and ready for review by your team. Dupond does not automatically merge pull requests.
