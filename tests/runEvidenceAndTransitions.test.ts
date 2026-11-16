import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { TaskStore } from '../src/server/db/database.js';
import { ProjectStore } from '../src/server/projects/projectStore.js';
import { buildSanitizedRunEvidence, MAX_DIFF_CHARS, MAX_LOG_CHARS, MAX_CHECK_OUTPUT_CHARS } from '../src/server/runs/runEvidence.js';
import { computeEvidenceBinding } from '../src/server/verification/evidenceBinding.js';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

describe('Authoritative task transitions & read-only run evidence', () => {
  let tmpDir: string;
  let dbPath: string;
  let statePath: string;
  let keyPath: string;
  let serverProc: ChildProcess | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-run-ev-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    statePath = path.join(tmpDir, 'state.json');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  });

  afterEach(async () => {
    if (serverProc) {
      const p = serverProc;
      serverProc = null;
      try {
        process.kill(-p.pid!, 'SIGTERM');
      } catch {}
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        p.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bounds and sanitizes large/hostile logs and diffs, binds immutable git diff, and reports missing snapshots explicitly', () => {
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const v = 1;\n', 'utf-8');
    execFileSync('git', ['init', '--template=', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();

    // Create candidate commit modifying existing file AND adding a new file
    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const v = 2;\n', 'utf-8');
    fs.writeFileSync(path.join(repoDir, 'src', 'newFile.ts'), 'export const added = true;\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'candidate'], { cwd: repoDir });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
    const candidateTreeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoDir, encoding: 'utf-8' }).trim();

    // Mutate working tree and add untracked file AFTER candidate commit — immutable evidence must NOT include them
    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const v = 999_MUTABLE;\n', 'utf-8');
    fs.writeFileSync(path.join(repoDir, 'src', 'dirtyUntracked.ts'), 'export const dirty = true;\n', 'utf-8');

    const store = new TaskStore(dbPath);
    const task = store.createTask({
      id: 'task-ev-1',
      projectId: 'proj-a',
      key: 'EV-1',
      title: 'Evidence test',
      description: 'desc',
      status: 'review',
      priority: 'high',
      targetRepo: 'org/repo',
      targetRepoPath: repoDir,
      baseCommit: baseSha,
      allowedPaths: ['src/**'],
      protectedPaths: ['.env*'],
      verificationCommands: ['npm test'],
      acceptanceCriteria: [{ id: 'ac-1', title: 'passes', completed: true }],
      workerConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
    });

    const run = store.createRun({
      taskId: task.id,
      projectId: 'proj-a',
      status: 'completed',
      targetRepo: 'org/repo',
      baseCommit: baseSha,
      targetBranch: 'dupond/ev-1',
      worktreePath: repoDir,
      currentAttempt: 1,
      durationMs: 100,
    });

    const attempt = store.createAttempt({
      runId: run.id,
      attemptNumber: 1,
      status: 'succeeded',
      workerType: 'gemini:gemini-3.8-flash',
      prompt: 'SECRET_PROMPT_SHOULD_NOT_BE_EXPOSED',
      filesModified: ['src/app.ts'],
      durationMs: 90,
      startedAt: new Date().toISOString(),
    });
    const hugeLogs = `Bearer secret_bearer_token_12345 AIzaSyFakeKey1234567890 <script>alert(1)</script>\n${'X'.repeat(MAX_LOG_CHARS + 500)}`;
    store.updateAttempt(attempt.id, {
      status: 'succeeded',
      logs: hugeLogs,
      filesModified: ['src/app.ts'],
    });

    const binding = computeEvidenceBinding(task);
    const verification = store.recordVerification({
      runId: run.id,
      attemptId: attempt.id,
      revisionSha: candidateSha,
      revisionTreeSha: candidateTreeSha,
      requirementsFingerprint: binding.requirementsFingerprint,
      verificationConfigFingerprint: binding.verificationConfigFingerprint,
      evidenceBindingVersion: binding.evidenceBindingVersion,
      passed: true,
      checks: [
        {
          command: 'npm test',
          exitCode: 0,
          stdout: `AIzaSyFakeStdoutKey12345\n${'Y'.repeat(MAX_CHECK_OUTPUT_CHARS + 200)}`,
          stderr: '',
          passed: true,
          durationMs: 10,
        },
      ],
      criteriaVerified: ['ac-1'],
    });

    // 1. Immutable base-to-candidate commit diff includes BOTH modified & added files, ignores dirty/untracked worktree,
    //    and preserves historical run provider/model even if task.workerConfig is later changed.
    const attempts = store.listAttempts(run.id, 'proj-a');
    const mutatedTask = { ...task, workerConfig: { provider: 'openai', model: 'gpt-4o' } };
    const built = buildSanitizedRunEvidence({
      run,
      task: mutatedTask,
      attempts,
      verification,
      delivery: null,
      projectRepoLocalPath: repoDir,
    });

    assert.strictEqual(built.evidence.provenance, 'immutable_git_commit');
    assert.strictEqual(built.evidence.candidateDiffStatus, 'available');
    assert.deepStrictEqual(built.evidence.changedFiles, ['src/app.ts', 'src/newFile.ts']);
    assert.ok(built.evidence.candidateDiff?.includes('export const v = 2;'));
    assert.ok(built.evidence.candidateDiff?.includes('export const added = true;'));
    assert.ok(!built.evidence.candidateDiff?.includes('999_MUTABLE'));
    assert.ok(!built.evidence.candidateDiff?.includes('dirtyUntracked'));
    assert.strictEqual(built.evidence.provider, 'gemini');
    assert.strictEqual(built.evidence.model, 'gemini-3.8-flash');
    assert.strictEqual((built.attempts[0] as any).prompt, undefined);
    assert.strictEqual(built.attempts[0].logsTruncated, true);
    assert.ok(!built.attempts[0].logs?.includes('secret_bearer_token_12345'));
    assert.ok(!built.attempts[0].logs?.includes('AIzaSyFakeKey1234567890'));
    assert.strictEqual(built.verification?.checks[0].stdoutTruncated, true);
    assert.ok(!built.verification?.checks[0].stdout.includes('AIzaSyFakeStdoutKey12345'));

    // 2. Missing workerType on attempt -> provider/model reported as null (never inherited from task.workerConfig)
    const noWorkerBuilt = buildSanitizedRunEvidence({
      run,
      task: mutatedTask,
      attempts: [{ ...attempts[0], workerType: '' }],
      verification,
      delivery: null,
      projectRepoLocalPath: repoDir,
    });
    assert.strictEqual(noWorkerBuilt.evidence.provider, null);
    assert.strictEqual(noWorkerBuilt.evidence.model, null);

    // 3. Missing verification-bound attempt with another unrelated attempt present -> MUST NOT substitute unrelated attempt
    const missingBoundAttempt = buildSanitizedRunEvidence({
      run,
      task,
      attempts: [{ ...attempts[0], id: 'unrelated-attempt', diff: '--- a/unrelated.ts\n+++ b/unrelated.ts\n+unrelated\n' }],
      verification: { ...verification, attemptId: 'missing-verified-attempt' },
      delivery: null,
      projectRepoLocalPath: repoDir,
    });
    assert.strictEqual(missingBoundAttempt.evidence.candidateDiffStatus, 'unavailable');
    assert.strictEqual(missingBoundAttempt.evidence.provenance, 'unavailable');
    assert.strictEqual(missingBoundAttempt.evidence.candidateDiff, null);
    assert.strictEqual(missingBoundAttempt.evidence.candidateRevision, null);
    assert.deepStrictEqual(missingBoundAttempt.evidence.changedFiles, []);
    assert.ok(missingBoundAttempt.evidence.candidateDiffUnavailableReason?.includes('missing-verified-attempt'));

    // 4. Mismatched run/verification and run/attempt bindings -> unavailable with precise reason
    const mismatchedVerifRun = buildSanitizedRunEvidence({
      run,
      task,
      attempts,
      verification: { ...verification, runId: 'other-run-id' },
      delivery: null,
      projectRepoLocalPath: repoDir,
    });
    assert.strictEqual(mismatchedVerifRun.evidence.candidateDiffStatus, 'unavailable');
    assert.ok(mismatchedVerifRun.evidence.candidateDiffUnavailableReason?.includes('other-run-id'));

    const mismatchedAttemptRun = buildSanitizedRunEvidence({
      run,
      task,
      attempts: [{ ...attempts[0], runId: 'other-run-id' }],
      verification,
      delivery: null,
      projectRepoLocalPath: repoDir,
    });
    assert.strictEqual(mismatchedAttemptRun.evidence.candidateDiffStatus, 'unavailable');
    assert.ok(mismatchedAttemptRun.evidence.candidateDiffUnavailableReason?.includes('other-run-id'));

    // 5. Large immutable commit diff is bounded & marked truncated
    fs.writeFileSync(
      path.join(repoDir, 'src', 'large.ts'),
      `${'// large candidate line for truncation check\n'.repeat(Math.ceil((MAX_DIFF_CHARS + 2048) / 40))}`,
      'utf-8',
    );
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'large candidate'], { cwd: repoDir });
    const largeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
    const largeTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoDir, encoding: 'utf-8' }).trim();

    const builtLarge = buildSanitizedRunEvidence({
      run,
      task,
      attempts,
      verification: { ...verification, revisionSha: largeSha, revisionTreeSha: largeTree },
      delivery: null,
      projectRepoLocalPath: repoDir,
    });
    assert.strictEqual(builtLarge.evidence.provenance, 'immutable_git_commit');
    assert.strictEqual(builtLarge.evidence.candidateDiffTruncated, true);

    // 6. Missing Git objects produce honest unavailable state even if attempt.diff was stored pre-commit
    const missingBuilt = buildSanitizedRunEvidence({
      run: { ...run, baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
      task: { ...task, targetRepoPath: path.join(tmpDir, 'nonexistent-repo') },
      attempts: [{ ...attempts[0], diff: '--- a/src/app.ts\n+++ b/src/app.ts\n+partial precommit diff\n' }],
      verification: { ...verification, revisionSha: '1234567890abcdef1234567890abcdef12345678' },
      delivery: null,
      projectRepoLocalPath: null,
    });
    assert.strictEqual(missingBuilt.evidence.candidateDiffStatus, 'unavailable');
    assert.strictEqual(missingBuilt.evidence.provenance, 'unavailable');
    assert.strictEqual(missingBuilt.evidence.candidateDiff, null);
    assert.ok(missingBuilt.evidence.candidateDiffUnavailableReason);

    store.getRawDb().close();
  });

  it('rejects foreign project/task/run references and preserves authoritative status on refused transitions', async () => {
    const store = new TaskStore(dbPath);
    const projectStore = new ProjectStore(store);
    const projA = projectStore.createProject({ name: 'Project Alpha', actor: 'test-actor' });
    const projB = projectStore.createProject({ name: 'Project Beta', actor: 'test-actor' });

    const taskA = store.createTask({
      id: 'task-alpha-1',
      projectId: projA.id,
      key: 'ALP-1',
      title: 'Alpha task',
      description: 'desc',
      status: 'review',
      priority: 'high',
      targetRepo: 'org/alpha',
      baseCommit: 'HEAD',
      allowedPaths: ['src/**'],
      protectedPaths: ['.env*'],
      verificationCommands: ['npm test'],
      acceptanceCriteria: [{ id: 'ac-1', title: 'ok', completed: true }],
      workerConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
    });

    const runA = store.createRun({
      taskId: taskA.id,
      projectId: projA.id,
      status: 'completed',
      targetRepo: 'org/alpha',
      baseCommit: 'HEAD',
      targetBranch: 'dupond/alp-1',
      currentAttempt: 1,
      durationMs: 50,
    });
    const attA = store.createAttempt({
      runId: runA.id,
      attemptNumber: 1,
      status: 'succeeded',
      workerType: 'gemini:gemini-3.8-flash',
      filesModified: ['src/index.ts'],
      durationMs: 40,
      startedAt: new Date().toISOString(),
    });
    store.updateAttempt(attA.id, { diff: '--- a/src/index.ts\n+++ b/src/index.ts\n+export const x = 1;\n' });
    const binding = computeEvidenceBinding(taskA);
    store.recordVerification({
      runId: runA.id,
      attemptId: attA.id,
      revisionSha: 'abcdef1234567890abcdef1234567890abcdef12',
      revisionTreeSha: 'tree1',
      requirementsFingerprint: binding.requirementsFingerprint,
      verificationConfigFingerprint: binding.verificationConfigFingerprint,
      evidenceBindingVersion: binding.evidenceBindingVersion,
      passed: true,
      checks: [{ command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, durationMs: 5 }],
      criteriaVerified: ['ac-1'],
    });
    const projAState = projectStore.getProjectState<Record<string, any>>(projA.id, {});
    projectStore.saveProjectState(projA.id, {
      ...projAState,
      tasks: [
        {
          id: taskA.id,
          key: taskA.key,
          title: taskA.title,
          description: taskA.description,
          status: 'review',
          priority: 'high',
          epicId: 'EPIC-1',
          assignedAgentId: 'agent-dev',
          estimatedHours: 2,
          spentHours: 1,
          subtasks: [],
          acceptanceCriteria: taskA.acceptanceCriteria,
          deliverables: [],
          dependencies: [],
          tags: [],
          lastUpdated: 'Just now',
        },
      ],
    });
    store.getRawDb().close();

    const port = await getFreePort();
    const authToken = 'test-auth-token-run-ev';
    const approvalToken = 'test-approval-token-run-ev';
    serverProc = spawn('npx', ['tsx', 'server.ts'], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        DUPOND_AUTH_TOKEN: authToken,
        DUPOND_APPROVAL_TOKEN: approvalToken,
        DUPOND_DB_PATH: dbPath,
        DUPOND_STATE_FILE: statePath,
        DUPOND_CONN_KEY_PATH: keyPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/api/health`);
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }

    const authHeaders = (pid?: string): Record<string, string> => ({
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      ...(pid ? { 'x-dupond-project-id': pid } : {}),
    });

    // 1. Transition to Done without delivery -> 422, structured reason, authoritative status remains review
    const transRes = await fetch(`${baseUrl}/api/orchestrate/tasks/${taskA.id}/transition`, {
      method: 'POST',
      headers: authHeaders(projA.id),
      body: JSON.stringify({ status: 'done' }),
    });
    assert.strictEqual(transRes.status, 422);
    const transJson = (await transRes.json()) as any;
    assert.strictEqual(transJson.success, false);
    assert.strictEqual(transJson.reason, 'delivery-pending');
    assert.strictEqual(transJson.task.status, 'review');

    // 2. Raw board-state write cannot grant Done
    const stateRes = await fetch(`${baseUrl}/api/orchestrate/state`, {
      method: 'POST',
      headers: authHeaders(projA.id),
      body: JSON.stringify({ tasks: [{ ...taskA, status: 'done' }] }),
    });
    const stateJson = (await stateRes.json()) as any;
    const projectedTask = (stateJson.state?.tasks || []).find((t: any) => t.id === taskA.id);
    if (projectedTask) {
      assert.strictEqual(projectedTask.status, 'review');
    }

    // 3. Foreign project run lookup -> 403
    const foreignRun = await fetch(`${baseUrl}/api/tasks/${taskA.id}/runs?runId=${runA.id}`, {
      headers: authHeaders(projB.id),
    });
    assert.strictEqual(foreignRun.status, 403);

    // 4. Scoped task run lookup -> 200 with sanitized evidence & runs list
    const okRuns = await fetch(`${baseUrl}/api/tasks/${taskA.id}/runs`, {
      headers: authHeaders(projA.id),
    });
    assert.strictEqual(okRuns.status, 200);
    const okJson = (await okRuns.json()) as any;
    assert.strictEqual(okJson.run.id, runA.id);
    assert.strictEqual(okJson.runs.length, 1);
    assert.strictEqual(okJson.evidence.candidateDiffStatus, 'unavailable');
    assert.ok(okJson.evidence.candidateDiffUnavailableReason);

    // 5. Non-AEG key (TR-1) metadata update via POST /api/orchestrate/state succeeds without 422
    const metaUpdateRes = await fetch(`${baseUrl}/api/orchestrate/state`, {
      method: 'POST',
      headers: authHeaders(projA.id),
      body: JSON.stringify({
        tasks: [
          {
            id: taskA.id,
            key: taskA.key,
            title: taskA.title,
            description: taskA.description,
            epicId: 'EPIC-1',
            status: 'review',
            priority: 'high',
            assignedAgentId: 'agent-dev',
          },
        ],
      }),
    });
    assert.strictEqual(metaUpdateRes.status, 200);
    const metaJson = (await metaUpdateRes.json()) as any;
    assert.strictEqual(metaJson.success, true);

    // 6. POST /api/tasks/:id/review enforces candidate binding, project isolation, approval token, and revocation
    const candidateBinding = {
      runId: okJson.run.id,
      verificationId: okJson.verification.id,
      revisionSha: okJson.evidence.candidateRevision,
      requirementsFingerprint: okJson.verification.requirementsFingerprint,
      verificationConfigFingerprint: okJson.verification.verificationConfigFingerprint,
      evidenceBindingVersion: okJson.verification.evidenceBindingVersion,
    };

    const foreignReview = await fetch(`${baseUrl}/api/tasks/${taskA.id}/review`, {
      method: 'POST',
      headers: authHeaders(projB.id),
      body: JSON.stringify({ decision: 'request_changes', comment: 'nope', ...candidateBinding }),
    });
    assert.strictEqual(foreignReview.status, 403);

    const missingApprovalRes = await fetch(`${baseUrl}/api/tasks/${taskA.id}/review`, {
      method: 'POST',
      headers: authHeaders(projA.id),
      body: JSON.stringify({ decision: 'approve', ...candidateBinding }),
    });
    assert.strictEqual(missingApprovalRes.status, 403);

    // Stale candidate binding (e.g. candidate changed between modal open and submit) -> 409 Conflict without recording approval
    const staleRevRes = await fetch(`${baseUrl}/api/tasks/${taskA.id}/review`, {
      method: 'POST',
      headers: { ...authHeaders(projA.id), 'X-Dupond-Approval-Token': approvalToken },
      body: JSON.stringify({
        decision: 'approve',
        ...candidateBinding,
        revisionSha: '0000000000000000000000000000000000000000',
      }),
    });
    assert.strictEqual(staleRevRes.status, 409);
    const staleRevJson = (await staleRevRes.json()) as any;
    assert.strictEqual(staleRevJson.code, 'STALE_CANDIDATE_REVIEW');

    const staleReqRes = await fetch(`${baseUrl}/api/tasks/${taskA.id}/review`, {
      method: 'POST',
      headers: { ...authHeaders(projA.id), 'X-Dupond-Approval-Token': approvalToken },
      body: JSON.stringify({
        decision: 'approve',
        ...candidateBinding,
        requirementsFingerprint: 'stale-fingerprint',
      }),
    });
    assert.strictEqual(staleReqRes.status, 409);

    const approveRes = await fetch(`${baseUrl}/api/tasks/${taskA.id}/review`, {
      method: 'POST',
      headers: { ...authHeaders(projA.id), 'X-Dupond-Approval-Token': approvalToken },
      body: JSON.stringify({ decision: 'approve', comment: 'Looks good', ...candidateBinding }),
    });
    assert.strictEqual(approveRes.status, 200);
    const approveJson = (await approveRes.json()) as any;
    assert.strictEqual(approveJson.decision, 'approve');
    assert.strictEqual(approveJson.approval.revisionSha, okJson.evidence.candidateRevision);

    // Request Changes revokes eligibility of the rejected candidate & prior approval while preserving historical evidence
    const requestChangesRes = await fetch(`${baseUrl}/api/tasks/${taskA.id}/review`, {
      method: 'POST',
      headers: authHeaders(projA.id),
      body: JSON.stringify({ decision: 'request_changes', comment: 'Add edge-case test', ...candidateBinding }),
    });
    assert.strictEqual(requestChangesRes.status, 200);
    const rcJson = (await requestChangesRes.json()) as any;
    assert.strictEqual(rcJson.decision, 'request_changes');
    assert.strictEqual(rcJson.authoritativeStatus, 'todo');

    // Rejected evidence cannot restore Review
    const retryReviewRes = await fetch(`${baseUrl}/api/orchestrate/tasks/${taskA.id}/transition`, {
      method: 'POST',
      headers: authHeaders(projA.id),
      body: JSON.stringify({ status: 'review' }),
    });
    assert.strictEqual(retryReviewRes.status, 422);
    const retryReviewJson = (await retryReviewRes.json()) as any;
    assert.strictEqual(retryReviewJson.reason, 'changes-requested');

    // Rejected candidate cannot be delivered
    const deliverRejectedRes = await fetch(`${baseUrl}/api/delivery/dispatch`, {
      method: 'POST',
      headers: { ...authHeaders(projA.id), 'X-Dupond-Approval-Token': approvalToken },
      body: JSON.stringify({ isApproved: true, ...candidateBinding }),
    });
    assert.strictEqual(deliverRejectedRes.status, 409);

    // Historical verification & unresolved feedback survive in store and remain project-scoped
    const afterRunsRes = await fetch(`${baseUrl}/api/tasks/${taskA.id}/runs`, {
      headers: authHeaders(projA.id),
    });
    assert.strictEqual(afterRunsRes.status, 200);
    const afterRunsJson = (await afterRunsRes.json()) as any;
    assert.strictEqual(afterRunsJson.verification.passed, true);
    assert.ok(afterRunsJson.verification.revokedAt);
    assert.strictEqual(afterRunsJson.unresolvedReviewFeedback.length, 1);
    assert.strictEqual(afterRunsJson.unresolvedReviewFeedback[0].comment, 'Add edge-case test');
    assert.strictEqual(afterRunsJson.reviewDecisions.length, 2);

    const freshStore = new TaskStore(dbPath);
    assert.strictEqual(freshStore.getUnresolvedReviewFeedback(taskA.id, projA.id).length, 1);
    assert.strictEqual(freshStore.getUnresolvedReviewFeedback(taskA.id, projB.id).length, 0);
    freshStore.getRawDb().close();
  }, 25000);
});
