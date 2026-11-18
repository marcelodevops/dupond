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
import { GitHubDeliveryService } from '../src/server/delivery/githubDelivery.js';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.js';
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

  it('requires complete candidate binding on delivery and revalidates before external git side effects', async () => {
    const repoDir = path.join(tmpDir, 'repo');
    const remoteDir = path.join(tmpDir, 'remote.git');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'init\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir, stdio: 'ignore' });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const feature = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat: add feature'], { cwd: repoDir, stdio: 'ignore' });
    const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    const remoteRefsBefore = execFileSync('git', ['show-ref'], { cwd: remoteDir, encoding: 'utf8' }).trim();

    const store = new TaskStore(dbPath);
    const projectStore = new ProjectStore(store);
    const proj = projectStore.createProject({
      name: 'Delivery Binding Proj',
      actor: 'test-actor',
    });

    const task = store.createTask({
      id: 'task-deliver-1',
      projectId: proj.id,
      key: 'DEL-1',
      title: 'Deliverable Task',
      description: 'Must bind exact candidate',
      status: 'review',
      priority: 'high',
      targetRepo: 'owner/repo',
      baseCommit: baseSha,
      allowedPaths: ['**/*'],
      protectedPaths: ['.env*'],
      verificationCommands: ['npm test'],
      acceptanceCriteria: [{ id: 'ac-1', title: 'ok', completed: true }],
      workerConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
    });

    const run1 = store.createRun({
      taskId: task.id,
      projectId: proj.id,
      status: 'completed',
      targetRepo: 'owner/repo',
      baseCommit: baseSha,
      targetBranch: 'dupond/del-1',
      currentAttempt: 1,
      durationMs: 50,
    });
    const att1 = store.createAttempt({
      runId: run1.id,
      attemptNumber: 1,
      status: 'succeeded',
      workerType: 'gemini:gemini-3.8-flash',
      filesModified: ['feature.ts'],
      durationMs: 40,
      startedAt: new Date().toISOString(),
    });

    const binding1 = computeEvidenceBinding(task);
    const ver1 = store.recordVerification({
      runId: run1.id,
      attemptId: att1.id,
      revisionSha: candidateSha,
      revisionTreeSha: execFileSync('git', ['rev-parse', `${candidateSha}^{tree}`], { cwd: repoDir, encoding: 'utf8' }).trim(),
      passed: true,
      checks: [{ command: 'npm test', exitCode: 0, passed: true, durationMs: 10, stdout: 'ok', stderr: '' }],
      criteriaVerified: ['ac-1'],
      requirementsFingerprint: binding1.requirementsFingerprint,
      verificationConfigFingerprint: binding1.verificationConfigFingerprint,
      evidenceBindingVersion: binding1.evidenceBindingVersion,
    });

    const fullBinding = {
      runId: run1.id,
      verificationId: ver1.id,
      revisionSha: candidateSha,
      requirementsFingerprint: binding1.requirementsFingerprint,
      verificationConfigFingerprint: binding1.verificationConfigFingerprint,
      evidenceBindingVersion: binding1.evidenceBindingVersion,
    };

    // 1. Direct TaskStore.validateDeliveryCandidateBinding rejects omitted/empty/malformed fields
    const emptyCheck = store.validateDeliveryCandidateBinding({
      projectId: proj.id,
      runId: run1.id,
      expectedVerificationId: '',
      expectedRevisionSha: candidateSha,
      expectedRequirementsFingerprint: binding1.requirementsFingerprint,
      expectedVerificationConfigFingerprint: binding1.verificationConfigFingerprint,
      expectedEvidenceBindingVersion: binding1.evidenceBindingVersion,
    });
    assert.strictEqual(emptyCheck.ok, false);
    if (!emptyCheck.ok) {
      assert.strictEqual(emptyCheck.status, 400);
      assert.strictEqual(emptyCheck.code, 'CANDIDATE_BINDING_REQUIRED');
    }

    const malformedCheck = store.validateDeliveryCandidateBinding({
      projectId: proj.id,
      runId: run1.id,
      expectedVerificationId: ver1.id,
      expectedRevisionSha: 'not-a-sha',
      expectedRequirementsFingerprint: binding1.requirementsFingerprint,
      expectedVerificationConfigFingerprint: binding1.verificationConfigFingerprint,
      expectedEvidenceBindingVersion: binding1.evidenceBindingVersion,
    });
    assert.strictEqual(malformedCheck.ok, false);
    if (!malformedCheck.ok) {
      assert.strictEqual(malformedCheck.status, 400);
      assert.strictEqual(malformedCheck.code, 'MALFORMED_CANDIDATE_BINDING');
    }
    assert.strictEqual(
      store.validateDeliveryCandidateBinding({
        projectId: proj.id,
        runId: run1.id,
        expectedVerificationId: ver1.id,
        expectedRevisionSha: candidateSha,
        expectedRequirementsFingerprint: binding1.requirementsFingerprint,
        expectedVerificationConfigFingerprint: binding1.verificationConfigFingerprint,
        expectedEvidenceBindingVersion: binding1.evidenceBindingVersion,
      }).ok,
      true,
    );

    const authToken = 'test-auth-token';
    const approvalToken = 'test-approval-token';
    const port = await getFreePort();
    serverProc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DUPOND_DB_PATH: dbPath,
        DUPOND_STATE_FILE: statePath,
        DUPOND_CONN_KEY_PATH: keyPath,
        DUPOND_AUTH_TOKEN: authToken,
        DUPOND_APPROVAL_TOKEN: approvalToken,
      },
      detached: true,
      stdio: 'ignore',
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${baseUrl}/api/health`);
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }

    const headers = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'X-Dupond-Project-Id': proj.id,
      'X-Dupond-Approval-Token': approvalToken,
    };

    // 2. HTTP /api/delivery/dispatch rejects runId-only, omitted/empty fields, malformed SHA, and stale verification
    const invalidPayloads: Array<{ body: Record<string, unknown>; expectedStatus: number; expectedCode: string }> = [
      { body: { isApproved: true, runId: run1.id }, expectedStatus: 400, expectedCode: 'CANDIDATE_BINDING_REQUIRED' },
      { body: { isApproved: true, ...fullBinding, verificationId: '' }, expectedStatus: 400, expectedCode: 'CANDIDATE_BINDING_REQUIRED' },
      { body: { isApproved: true, ...fullBinding, revisionSha: '' }, expectedStatus: 400, expectedCode: 'CANDIDATE_BINDING_REQUIRED' },
      { body: { isApproved: true, ...fullBinding, requirementsFingerprint: undefined }, expectedStatus: 400, expectedCode: 'CANDIDATE_BINDING_REQUIRED' },
      { body: { isApproved: true, ...fullBinding, verificationConfigFingerprint: '   ' }, expectedStatus: 400, expectedCode: 'CANDIDATE_BINDING_REQUIRED' },
      { body: { isApproved: true, ...fullBinding, evidenceBindingVersion: '' }, expectedStatus: 400, expectedCode: 'CANDIDATE_BINDING_REQUIRED' },
      { body: { isApproved: true, ...fullBinding, revisionSha: 'bad-sha!' }, expectedStatus: 400, expectedCode: 'MALFORMED_CANDIDATE_BINDING' },
      { body: { isApproved: true, ...fullBinding, verificationId: 'stale-ver-id' }, expectedStatus: 409, expectedCode: 'STALE_CANDIDATE_REVIEW' },
    ];

    for (const tc of invalidPayloads) {
      const res = await fetch(`${baseUrl}/api/delivery/dispatch`, {
        method: 'POST',
        headers,
        body: JSON.stringify(tc.body),
      });
      assert.strictEqual(res.status, tc.expectedStatus, `Expected ${tc.expectedStatus} for ${JSON.stringify(tc.body)}`);
      const json = (await res.json()) as any;
      assert.strictEqual(json.code, tc.expectedCode);
    }

    assert.strictEqual(execFileSync('git', ['show-ref'], { cwd: remoteDir, encoding: 'utf8' }).trim(), remoteRefsBefore);
    assert.strictEqual(store.getDeliveryForRun(run1.id), null);

    // 3. Revalidation inside GitHubDeliveryService.dispatchDelivery blocks rejection or candidate replacement after preflight
    const verifier = new AuthoritativeVerifier();
    const deliveryService = new GitHubDeliveryService(store, verifier);

    // 3a. Candidate rejected (Request Changes) after preflight validation passes
    const preflightA = store.validateDeliveryCandidateBinding({
      projectId: proj.id,
      runId: run1.id,
      expectedVerificationId: ver1.id,
      expectedRevisionSha: candidateSha,
      expectedRequirementsFingerprint: binding1.requirementsFingerprint,
      expectedVerificationConfigFingerprint: binding1.verificationConfigFingerprint,
      expectedEvidenceBindingVersion: binding1.evidenceBindingVersion,
    });
    assert.strictEqual(preflightA.ok, true);

    const rcRes = store.submitReviewDecision({
      taskId: task.id,
      projectId: proj.id,
      decision: 'changes_requested',
      comment: 'Rejected after preflight',
      actor: 'test-actor',
      expectedRunId: run1.id,
      expectedVerificationId: ver1.id,
      expectedRevisionSha: candidateSha,
      expectedRequirementsFingerprint: binding1.requirementsFingerprint,
      expectedVerificationConfigFingerprint: binding1.verificationConfigFingerprint,
      expectedEvidenceBindingVersion: binding1.evidenceBindingVersion,
    });
    assert.strictEqual(rcRes.ok, true);

    const dispatchAfterReject = await deliveryService.dispatchDelivery({
      runId: run1.id,
      isApproved: true,
      disposableRemoteDir: remoteDir,
      candidateBinding: {
        verificationId: ver1.id,
        revisionSha: candidateSha,
        requirementsFingerprint: binding1.requirementsFingerprint,
        verificationConfigFingerprint: binding1.verificationConfigFingerprint,
        evidenceBindingVersion: binding1.evidenceBindingVersion,
      },
    });
    assert.strictEqual(dispatchAfterReject.success, false);
    assert.strictEqual(dispatchAfterReject.status, 409);
    assert.strictEqual(dispatchAfterReject.code, 'CANDIDATE_REJECTED');
    assert.strictEqual(execFileSync('git', ['show-ref'], { cwd: remoteDir, encoding: 'utf8' }).trim(), remoteRefsBefore);
    assert.strictEqual(store.getDeliveryForRun(run1.id), null);

    // 3b. Candidate replaced by a newer run after preflight validation passes
    const task2 = store.createTask({
      id: 'task-deliver-2',
      projectId: proj.id,
      key: 'DEL-2',
      title: 'Replaced Candidate Task',
      description: 'Will be superseded before dispatch',
      status: 'review',
      priority: 'high',
      targetRepo: 'owner/repo',
      baseCommit: baseSha,
      allowedPaths: ['**/*'],
      protectedPaths: ['.env*'],
      verificationCommands: ['npm test'],
      acceptanceCriteria: [{ id: 'ac-1', title: 'ok', completed: true }],
      workerConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
    });
    const run2 = store.createRun({
      taskId: task2.id,
      projectId: proj.id,
      status: 'completed',
      targetRepo: 'owner/repo',
      baseCommit: baseSha,
      targetBranch: 'dupond/del-2',
      currentAttempt: 1,
      durationMs: 50,
    });
    const att2 = store.createAttempt({
      runId: run2.id,
      attemptNumber: 1,
      status: 'succeeded',
      workerType: 'gemini:gemini-3.8-flash',
      filesModified: ['feature.ts'],
      durationMs: 40,
      startedAt: new Date().toISOString(),
    });
    const binding2 = computeEvidenceBinding(task2);
    const ver2 = store.recordVerification({
      runId: run2.id,
      attemptId: att2.id,
      revisionSha: candidateSha,
      revisionTreeSha: execFileSync('git', ['rev-parse', `${candidateSha}^{tree}`], { cwd: repoDir, encoding: 'utf8' }).trim(),
      passed: true,
      checks: [{ command: 'npm test', exitCode: 0, passed: true, durationMs: 10, stdout: 'ok', stderr: '' }],
      criteriaVerified: ['ac-1'],
      requirementsFingerprint: binding2.requirementsFingerprint,
      verificationConfigFingerprint: binding2.verificationConfigFingerprint,
      evidenceBindingVersion: binding2.evidenceBindingVersion,
    });

    const preflightB = store.validateDeliveryCandidateBinding({
      projectId: proj.id,
      runId: run2.id,
      expectedVerificationId: ver2.id,
      expectedRevisionSha: candidateSha,
      expectedRequirementsFingerprint: binding2.requirementsFingerprint,
      expectedVerificationConfigFingerprint: binding2.verificationConfigFingerprint,
      expectedEvidenceBindingVersion: binding2.evidenceBindingVersion,
    });
    assert.strictEqual(preflightB.ok, true);

    // Supersede run2 with run3 before dispatchDelivery executes
    store.createRun({
      taskId: task2.id,
      projectId: proj.id,
      status: 'running',
      targetRepo: 'owner/repo',
      baseCommit: baseSha,
      targetBranch: 'dupond/del-2b',
      currentAttempt: 1,
      durationMs: 0,
    });

    const dispatchSuperseded = await deliveryService.dispatchDelivery({
      runId: run2.id,
      isApproved: true,
      disposableRemoteDir: remoteDir,
      candidateBinding: {
        verificationId: ver2.id,
        revisionSha: candidateSha,
        requirementsFingerprint: binding2.requirementsFingerprint,
        verificationConfigFingerprint: binding2.verificationConfigFingerprint,
        evidenceBindingVersion: binding2.evidenceBindingVersion,
      },
    });
    assert.strictEqual(dispatchSuperseded.success, false);
    assert.strictEqual(dispatchSuperseded.status, 409);
    assert.strictEqual(dispatchSuperseded.code, 'STALE_CANDIDATE_REVIEW');
    assert.strictEqual(execFileSync('git', ['show-ref'], { cwd: remoteDir, encoding: 'utf8' }).trim(), remoteRefsBefore);
    assert.strictEqual(store.getDeliveryForRun(run2.id), null);

    // 4. Both HTTP delivery routes enforce candidate-binding / block legacy bypass and allow valid bound delivery
    // 4a. Legacy /api/integrations/repository/dispatch rejects deliver and create_pr (missing binding, rejected, superseded)
    for (const legacyPayload of [
      { action: 'deliver', task: { id: task.id, key: task.key }, isApproved: true, approvedBy: 'op' },
      { action: 'create_pr', runId: run1.id, isApproved: true, approvedBy: 'op' },
      {
        action: 'deliver',
        isApproved: true,
        approvedBy: 'op',
        ...fullBinding,
      },
      {
        action: 'create_pr',
        runId: run2.id,
        isApproved: true,
        approvedBy: 'op',
        verificationId: ver2.id,
        revisionSha: candidateSha,
        requirementsFingerprint: binding2.requirementsFingerprint,
        verificationConfigFingerprint: binding2.verificationConfigFingerprint,
        evidenceBindingVersion: binding2.evidenceBindingVersion,
      },
    ]) {
      const legacyRes = await fetch(`${baseUrl}/api/integrations/repository/dispatch`, {
        method: 'POST',
        headers,
        body: JSON.stringify(legacyPayload),
      });
      assert.strictEqual(legacyRes.status, 410, `Expected 410 for legacy dispatch ${JSON.stringify(legacyPayload)}`);
      const legacyJson = (await legacyRes.json()) as any;
      assert.strictEqual(legacyJson.success, false);
      assert.strictEqual(legacyJson.blocked, true);
      assert.strictEqual(legacyJson.code, 'LEGACY_DELIVERY_ROUTE_DEPRECATED');
      assert.strictEqual(legacyJson.supportedEndpoint, '/api/delivery/dispatch');
    }
    assert.strictEqual(execFileSync('git', ['show-ref'], { cwd: remoteDir, encoding: 'utf8' }).trim(), remoteRefsBefore);
    assert.strictEqual(store.getDeliveryForRun(run1.id), null);
    assert.strictEqual(store.getDeliveryForRun(run2.id), null);

    // 4b. /api/delivery/dispatch blocks rejected and superseded candidates via HTTP
    const httpRejectedRes = await fetch(`${baseUrl}/api/delivery/dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ isApproved: true, approvedBy: 'op', ...fullBinding }),
    });
    assert.strictEqual(httpRejectedRes.status, 409);
    assert.strictEqual(((await httpRejectedRes.json()) as any).code, 'CANDIDATE_REJECTED');

    const httpSupersededRes = await fetch(`${baseUrl}/api/delivery/dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        isApproved: true,
        approvedBy: 'op',
        runId: run2.id,
        verificationId: ver2.id,
        revisionSha: candidateSha,
        requirementsFingerprint: binding2.requirementsFingerprint,
        verificationConfigFingerprint: binding2.verificationConfigFingerprint,
        evidenceBindingVersion: binding2.evidenceBindingVersion,
      }),
    });
    assert.strictEqual(httpSupersededRes.status, 409);
    assert.strictEqual(((await httpSupersededRes.json()) as any).code, 'STALE_CANDIDATE_REVIEW');
    assert.strictEqual(execFileSync('git', ['show-ref'], { cwd: remoteDir, encoding: 'utf8' }).trim(), remoteRefsBefore);

    // 4c. Valid explicitly bound delivery via HTTP /api/delivery/dispatch succeeds
    const validBranch = 'dupond/del-valid';
    execFileSync('git', ['checkout', '-b', validBranch], { cwd: repoDir, stdio: 'ignore' });
    const taskValid = store.createTask({
      id: 'task-deliver-valid',
      projectId: proj.id,
      key: 'DEL-VALID',
      title: 'Valid Bound Delivery Task',
      description: 'Should deliver with complete candidate binding',
      status: 'review',
      priority: 'high',
      targetRepo: 'owner/repo',
      targetRepoPath: repoDir,
      baseCommit: baseSha,
      allowedPaths: ['**/*'],
      protectedPaths: ['.env*'],
      verificationCommands: ['true'],
      acceptanceCriteria: [{ id: 'ac-valid', title: 'ok', completed: true }],
      workerConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
    });
    const runValid = store.createRun({
      taskId: taskValid.id,
      projectId: proj.id,
      status: 'completed',
      targetRepo: 'owner/repo',
      baseCommit: baseSha,
      targetBranch: validBranch,
      worktreePath: repoDir,
      currentAttempt: 1,
      durationMs: 50,
    });
    const attValid = store.createAttempt({
      runId: runValid.id,
      attemptNumber: 1,
      status: 'succeeded',
      workerType: 'gemini:gemini-3.8-flash',
      filesModified: ['feature.ts'],
      durationMs: 40,
      startedAt: new Date().toISOString(),
    });
    const bindingValid = computeEvidenceBinding(taskValid);
    const verValid = store.recordVerification({
      runId: runValid.id,
      attemptId: attValid.id,
      revisionSha: candidateSha,
      revisionTreeSha: execFileSync('git', ['rev-parse', `${candidateSha}^{tree}`], { cwd: repoDir, encoding: 'utf8' }).trim(),
      passed: true,
      checks: [{ command: 'true', exitCode: 0, passed: true, durationMs: 5, stdout: '', stderr: '' }],
      criteriaVerified: ['ac-valid'],
      requirementsFingerprint: bindingValid.requirementsFingerprint,
      verificationConfigFingerprint: bindingValid.verificationConfigFingerprint,
      evidenceBindingVersion: bindingValid.evidenceBindingVersion,
    });

    const httpValidRes = await fetch(`${baseUrl}/api/delivery/dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        isApproved: true,
        approvedBy: 'op-valid',
        runId: runValid.id,
        verificationId: verValid.id,
        revisionSha: candidateSha,
        requirementsFingerprint: bindingValid.requirementsFingerprint,
        verificationConfigFingerprint: bindingValid.verificationConfigFingerprint,
        evidenceBindingVersion: bindingValid.evidenceBindingVersion,
      }),
    });
    assert.strictEqual(httpValidRes.status, 200);
    const httpValidJson = (await httpValidRes.json()) as any;
    assert.strictEqual(httpValidJson.success, true);
    assert.ok(execFileSync('git', ['show-ref'], { cwd: remoteDir, encoding: 'utf8' }).includes(`refs/heads/${validBranch}`));
    assert.strictEqual(store.getDeliveryForRun(runValid.id)?.approvalStatus, 'approved');

    store.getRawDb().close();
  }, 25000);

  it('blocks unregistered board tasks without legacy artifact fallback and supports safe authoritative registration', async () => {
    const store = new TaskStore(dbPath);
    const projectStore = new ProjectStore(store);
    const projA = projectStore.createProject({ name: 'Board Recovery A', actor: 'test-actor' });
    const projB = projectStore.createProject({ name: 'Board Recovery B', actor: 'test-actor' });

    const boardOnlyTask = {
      id: 'task-board-only-1',
      key: 'LEG-105',
      title: 'Legacy Board-Only Task',
      description: 'Exists only in projected board state',
      status: 'review',
      priority: 'high',
      epicId: 'EPIC-1',
      assignedAgentId: 'agent-dev',
      estimatedHours: 2,
      spentHours: 0,
      subtasks: [{ id: 'sub-1', title: 'Check export', completed: true }],
      deliverables: [],
      dependencies: [],
      tags: [],
      lastUpdated: 'Just now',
    };
    const projAState = projectStore.getProjectState<Record<string, any>>(projA.id, {});
    projectStore.saveProjectState(projA.id, { ...projAState, tasks: [boardOnlyTask] });

    const authToken = 'test-auth-token';
    const port = await getFreePort();
    serverProc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DUPOND_DB_PATH: dbPath,
        DUPOND_STATE_FILE: statePath,
        DUPOND_CONN_KEY_PATH: keyPath,
        DUPOND_AUTH_TOKEN: authToken,
      },
      detached: true,
      stdio: 'ignore',
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${baseUrl}/api/health`);
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }

    const headers = (pid: string) => ({
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'X-Dupond-Project-Id': pid,
    });

    // 1. Transitioning unregistered task to done/review fails with unregistered-task, never legacy .dupond_artifacts
    const transitionDoneRes = await fetch(`${baseUrl}/api/orchestrate/tasks/${boardOnlyTask.id}/transition`, {
      method: 'POST',
      headers: headers(projA.id),
      body: JSON.stringify({ status: 'done' }),
    });
    assert.strictEqual(transitionDoneRes.status, 422);
    const transitionDoneJson = (await transitionDoneRes.json()) as any;
    assert.strictEqual(transitionDoneJson.reason, 'unregistered-task');
    assert.strictEqual(transitionDoneJson.code, 'UNREGISTERED_TASK');
    assert.strictEqual(transitionDoneJson.nextAction, 'register_task');
    assert.ok(!String(transitionDoneJson.error || '').includes('Inspected Physical Code Artifact'));

    // 2. GET /api/tasks/:id/runs reports authoritativeTaskRegistered: false
    const runsBeforeRes = await fetch(`${baseUrl}/api/tasks/${boardOnlyTask.id}/runs`, {
      headers: headers(projA.id),
    });
    assert.strictEqual(runsBeforeRes.status, 404);
    const runsBeforeJson = (await runsBeforeRes.json()) as any;
    assert.strictEqual(runsBeforeJson.authoritativeTaskRegistered, false);

    // 3. Foreign project cannot register projA's board-only task
    const foreignRegRes = await fetch(`${baseUrl}/api/orchestrate/tasks/${boardOnlyTask.id}/register`, {
      method: 'POST',
      headers: headers(projB.id),
    });
    assert.ok(foreignRegRes.status === 403 || foreignRegRes.status === 404);

    // 4a. Without configured repository, registration is rejected (never defaults to orchestrator repo)
    const regNoRepoRes = await fetch(`${baseUrl}/api/orchestrate/tasks/${boardOnlyTask.id}/register`, {
      method: 'POST',
      headers: headers(projA.id),
    });
    assert.strictEqual(regNoRepoRes.status, 422);
    const regNoRepoJson = (await regNoRepoRes.json()) as any;
    assert.strictEqual(regNoRepoJson.success, false);
    assert.strictEqual(regNoRepoJson.code, 'REPOSITORY_CONFIGURATION_REQUIRED');
    assert.strictEqual(regNoRepoJson.nextAction, 'configure_project_repository');
    assert.strictEqual(store.getTaskScoped(boardOnlyTask.id, projA.id), null);

    // 4b. Configure project repository -> registration uses configured project repository and grants NO verification/approval
    const updateProjRes = await fetch(`${baseUrl}/api/projects/${projA.id}`, {
      method: 'PATCH',
      headers: headers(projA.id),
      body: JSON.stringify({ repository: { repoUrl: 'custom-org/custom-app', defaultBranch: 'main' } }),
    });
    assert.strictEqual(updateProjRes.status, 200);

    const regRes = await fetch(`${baseUrl}/api/orchestrate/tasks/${boardOnlyTask.id}/register`, {
      method: 'POST',
      headers: headers(projA.id),
    });
    assert.strictEqual(regRes.status, 200);
    const regJson = (await regRes.json()) as any;
    assert.strictEqual(regJson.success, true);
    assert.strictEqual(regJson.task.status, 'todo');
    assert.strictEqual(regJson.nextAction, 'execute_agent_step');

    const dbTask = store.getTaskScoped(boardOnlyTask.id, projA.id);
    assert.ok(dbTask);
    assert.strictEqual(dbTask.targetRepo, 'custom-org/custom-app');
    assert.strictEqual(dbTask.status, 'todo');
    assert.strictEqual(dbTask.acceptanceCriteria.every((c) => c.completed === false), true);
    assert.strictEqual(store.listRunsForTask(dbTask.id, projA.id).length, 0);

    // 5. After registration, moving to review/done without evidence is blocked with missing-verification
    const transitionReviewRes = await fetch(`${baseUrl}/api/orchestrate/tasks/${boardOnlyTask.id}/transition`, {
      method: 'POST',
      headers: headers(projA.id),
      body: JSON.stringify({ status: 'review' }),
    });
    assert.strictEqual(transitionReviewRes.status, 422);
    const transitionReviewJson = (await transitionReviewRes.json()) as any;
    assert.strictEqual(transitionReviewJson.reason, 'no-evidence');
    assert.strictEqual(transitionReviewJson.nextAction, 'execute_agent_step');

    store.getRawDb().close();
  }, 25000);
});
