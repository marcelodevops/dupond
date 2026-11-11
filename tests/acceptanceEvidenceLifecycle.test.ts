import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'node:child_process';

async function main() {
  console.log('=== RUNNING ACCEPTANCE EVIDENCE & LIFECYCLE CONSISTENCY TESTS ===\n');

  // Isolated fixture environment: temp base repo, bare remote, file-backed DB.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond_evidence_'));
  const baseRepo = path.join(tmpRoot, 'base-repo');
  const bareRemote = path.join(tmpRoot, 'bare-remote.git');
  const dbFile = path.join(tmpRoot, 'store.db');
  const stateFile = path.join(tmpRoot, 'state.json');

  fs.mkdirSync(baseRepo, { recursive: true });
  fs.mkdirSync(bareRemote, { recursive: true });
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  git(['init', '-b', 'main'], baseRepo);
  git(['config', 'user.email', 'fixture@dupond.local'], baseRepo);
  git(['config', 'user.name', 'Dupond Fixture'], baseRepo);
  fs.writeFileSync(path.join(baseRepo, 'README.md'), '# fixture\n');
  git(['add', '-A'], baseRepo);
  git(['commit', '-m', 'chore: fixture base'], baseRepo);
  git(['init', '--bare'], bareRemote);
  git(['push', bareRemote, 'main:refs/heads/main'], baseRepo);
  git(['remote', 'add', 'origin', bareRemote], baseRepo);

  // Production singletons (coordinator, taskStore) must bind to this sandbox,
  // so the env is set before those modules are first imported.
  process.env.DUPOND_DB_PATH = dbFile;
  process.env.DUPOND_STATE_FILE = stateFile;

  const { TaskStore } = await import('../src/server/db/database.ts');
  const { WorkspaceManager } = await import('../src/server/workspace/workspaceManager.ts');
  const { AuthoritativeVerifier } = await import('../src/server/verification/authoritativeVerifier.ts');
  const { RepairCoordinator } = await import('../src/server/coordinator/repairCoordinator.ts');
  const { GitHubDeliveryService } = await import('../src/server/delivery/githubDelivery.ts');
  const { LifecycleService } = await import('../src/server/lifecycle/lifecycleService.ts');
  const {
    computeEvidenceBinding,
    assessEvidenceValidity,
    validateApprovalExpectation,
    verifiedRefForRun,
    EVIDENCE_BINDING_VERSION,
  } = await import('../src/server/verification/evidenceBinding.ts');
  const { coordinator, CoordinatorEngine } = await import('../src/server/coordinator.ts');
  const { taskStore: prodStore } = await import('../src/server/db/database.ts');

  const store = new TaskStore(dbFile);
  const wsManager = new WorkspaceManager(baseRepo, path.join(baseRepo, '.dupond_worktrees'));
  const verifier = new AuthoritativeVerifier();
  const repair = new RepairCoordinator(store, wsManager, verifier);
  const deliveryService = new GitHubDeliveryService(store, verifier);
  const lifecycle = new LifecycleService(store);

  const CHECK = `node -e "const { add } = require('./mathModule.cjs'); if (add(2, 3) !== 5) process.exit(1);"`;
  const goodWorker = {
    name: 'evidence_test_worker',
    async isAvailable() { return { available: true as const }; },
    async execute(ctx: any) {
      fs.writeFileSync(path.resolve(ctx.worktreePath, 'mathModule.cjs'), 'module.exports = { add: (a, b) => a + b };\n');
      return {
        success: true,
        filesModified: ['mathModule.cjs'],
        diff: '+ add',
        commitMessage: `feat(${ctx.taskKey}): add implementation`,
        logs: [],
        durationMs: 10,
      };
    },
  };

  function makeTask(overrides: Record<string, unknown> = {}): any {
    return store.createTask({
      key: `EVID-${Math.random().toString(36).slice(2, 7)}`,
      title: 'Evidence-bound lifecycle task',
      description: 'Acceptance must resolve to bound evidence on an exact revision',
      status: 'todo',
      priority: 'high',
      targetRepo: 'fixture/math-service',
      targetRepoPath: baseRepo,
      baseCommit: 'HEAD',
      allowedPaths: ['*'],
      protectedPaths: [],
      verificationCommands: [CHECK],
      acceptanceCriteria: [{ id: 'c-add', title: '2+3=5', completed: false, checkCommand: CHECK }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 2,
      timeoutSeconds: 60,
      requireApproval: true,
      ...overrides,
    } as any);
  }

  async function runToReview(task: any) {
    assert.strictEqual(store.claimTask(task.id, `token-${task.key}`), true);
    const run = await repair.executeTaskRun({
      task: store.getTask(task.id)!,
      worker: goodWorker as any,
      store,
      workspaceManager: wsManager,
      verifier,
    });
    assert.strictEqual(run.status, 'completed', `Run for ${task.key} must complete`);
    return run;
  }

  try {
    // ------------------------------------------------------------------
    // Part 1: passing verification produces evidence bound to revision,
    // requirements, config, and protocol version — and Review is granted
    // only through the lifecycle service.
    // ------------------------------------------------------------------
    const task1 = makeTask({ key: 'EVID-1' });
    const run1 = await runToReview(task1);

    const ver1 = store.getLatestVerification(run1.id)!;
    const binding1 = computeEvidenceBinding(store.getTask(task1.id)!);
    assert.strictEqual(ver1.passed, true);
    assert.strictEqual(ver1.requirementsFingerprint, binding1.requirementsFingerprint, 'requirements fingerprint bound');
    assert.strictEqual(ver1.verificationConfigFingerprint, binding1.verificationConfigFingerprint, 'verification config fingerprint bound');
    assert.strictEqual(ver1.evidenceBindingVersion, EVIDENCE_BINDING_VERSION, 'protocol version bound');
    assert.match(ver1.revisionTreeSha!, /^[0-9a-f]{40}$/);
    assert.strictEqual(
      ver1.revisionTreeSha,
      git(['rev-parse', `${ver1.revisionSha}^{tree}`], baseRepo),
      'tree SHA must resolve to the exact verified content',
    );
    assert.strictEqual(store.getTask(task1.id)!.status, 'review', 'Review applied via lifecycle service');
    const audit1 = store.listAuditEvents(task1.id);
    assert.ok(audit1.some((a) => a.eventType === 'TASK_LIFECYCLE_TRANSITION' && a.details.to === 'review'),
      'Review transition audited');
    console.log('✔ [PASS] Verification evidence is bound to revision, requirements fingerprint, config fingerprint, and protocol version');

    // Delivery of the verified candidate, then durable-reference proof.
    const delivered = await deliveryService.dispatchDelivery({
      runId: run1.id,
      isApproved: true,
      approvedBy: 'evidence-operator',
      disposableRemoteDir: bareRemote,
    });
    assert.strictEqual(delivered.success, true, `Delivery should succeed: ${delivered.error}`);
    assert.strictEqual(store.getTask(task1.id)!.status, 'done', 'Done applied through the lifecycle service after delivery');

    // ------------------------------------------------------------------
    // Part 2: a requirements change invalidates prior acceptance AND
    // approval; Review is refused until a fresh verification is recorded.
    // ------------------------------------------------------------------
    const CHECK2 = `node -e "const { add } = require('./mathModule.cjs'); if (add(10, 20) !== 30) process.exit(1);"`;
    const reqUpdate = store.updateTaskRequirements(task1.id, {
      acceptanceCriteria: [
        { id: 'c-add', title: '2+3=5', completed: false, checkCommand: CHECK },
        { id: 'c-add2', title: '10+20=30', completed: false, checkCommand: CHECK2 },
      ],
    }, 'product-owner');
    assert.strictEqual(reqUpdate.bindingChanged, true);
    assert.deepStrictEqual(reqUpdate.invalidatedApprovalRunIds, [run1.id], 'approval invalidated for the delivered run');

    const deliveryAfterSpecChange = store.getDeliveryForRun(run1.id)!;
    assert.strictEqual(deliveryAfterSpecChange.approvalStatus, 'pending_approval', 'approval demoted by spec change');
    assert.strictEqual(deliveryAfterSpecChange.approvedBy, null);
    const audit1Full = store.listAuditEvents(task1.id);
    assert.ok(audit1Full.some((a) => a.eventType === 'APPROVAL_INVALIDATED'), 'invalidation audited');

    const reopen = lifecycle.transition({ taskId: task1.id, to: 'todo', actor: 'product-owner', reason: 're-scoped' });
    assert.strictEqual(reopen.ok, true, 'reopen is always allowed');
    const staleReview = lifecycle.transition({ taskId: task1.id, to: 'review', actor: 'worker' });
    assert.strictEqual(staleReview.ok, false);
    assert.strictEqual(staleReview.reason, 'stale-requirements', 'prior acceptance must not survive a requirements change');

    // The worker writes both assertions; a fresh run re-binds the evidence.
    const scopedWorker = {
      ...goodWorker,
      async execute(ctx: any) {
        fs.writeFileSync(
          path.resolve(ctx.worktreePath, 'mathModule.cjs'),
          'module.exports = { add: (a, b) => a + b };\n',
        );
        return { success: true, filesModified: ['mathModule.cjs'], diff: '+ add', commitMessage: `feat(${ctx.taskKey}): rescope`, logs: [], durationMs: 10 };
      },
    };
    assert.strictEqual(store.claimTask(task1.id, 'token-2'), true);
    const run1b = await repair.executeTaskRun({ task: store.getTask(task1.id)!, worker: scopedWorker as any, store, workspaceManager: wsManager, verifier });
    assert.strictEqual(run1b.status, 'completed');
    assert.strictEqual(store.getTask(task1.id)!.status, 'review', 'Review requires and receives fresh bound evidence');
    const bindingNow = computeEvidenceBinding(store.getTask(task1.id)!);
    assert.strictEqual(store.getLatestVerification(run1b.id)!.requirementsFingerprint, bindingNow.requirementsFingerprint);
    console.log('✔ [PASS] Stale requirements invalidate acceptance and approval; fresh verification restores Review');

    // Durable reference: verified commits stay resolvable after the ephemeral
    // worktrees and branches are gone.
    const w1 = store.getRun(run1.id)!;
    const w1b = store.getRun(run1b.id)!;
    wsManager.cleanupWorktree(w1.worktreePath!, w1.targetBranch);
    wsManager.cleanupWorktree(w1b.worktreePath!, w1b.targetBranch);
    const pinnedSha = git(['rev-parse', '--verify', verifiedRefForRun(run1.id)], baseRepo);
    assert.strictEqual(pinnedSha, ver1.revisionSha, 'verified ref pins the exact verified commit');
    git(['cat-file', '-e', `${pinnedSha}^{commit}`], baseRepo);
    git(['cat-file', '-e', `${ver1.revisionTreeSha}^{tree}`], baseRepo);
    assert.strictEqual(wsManager.resolvePinnedRevision(verifiedRefForRun(run1b.id)), store.getLatestVerification(run1b.id)!.revisionSha);
    console.log('✔ [PASS] Verified candidate remains durable in git after worktree and branch removal');

    // ------------------------------------------------------------------
    // Part 3: changed verification configuration invalidates evidence.
    // ------------------------------------------------------------------
    const task2 = makeTask({ key: 'EVID-2', requireApproval: false });
    await runToReview(task2);
    store.updateTaskRequirements(task2.id, { verificationCommands: ['echo "config rotated"'] });
    const configReview = lifecycle.transition({ taskId: task2.id, to: 'review', actor: 'worker' });
    assert.strictEqual(configReview.ok, false);
    assert.strictEqual(configReview.reason, 'changed-verification-config');
    const blocked = await deliveryService.dispatchDelivery({ runId: store.getLatestRunForTask(task2.id)!.id, disposableRemoteDir: bareRemote });
    assert.strictEqual(blocked.success, false);
    assert.strictEqual(blocked.status, 409);
    assert.ok(blocked.error?.includes('changed-verification-config'), `Got: ${blocked.error}`);
    console.log('✔ [PASS] Changed verification configuration invalidates acceptance and blocks delivery');

    // ------------------------------------------------------------------
    // Part 4: uncovered criteria never authorize Review, even if a
    // record claims passed=true with matching fingerprints.
    // ------------------------------------------------------------------
    const task3 = makeTask({ key: 'EVID-3' });
    const run3 = store.createRun({ taskId: task3.id, status: 'completed', baseCommit: 'HEAD', targetBranch: `dupond/evid3-${Date.now()}`, currentAttempt: 1, durationMs: 0 });
    const att3 = store.createAttempt({ runId: run3.id, attemptNumber: 1, status: 'succeeded', workerType: 'test', filesModified: [], durationMs: 0, startedAt: new Date().toISOString() });
    const binding3 = computeEvidenceBinding(task3);
    store.recordVerification({
      runId: run3.id,
      attemptId: att3.id,
      revisionSha: git(['rev-parse', 'HEAD'], baseRepo),
      passed: true,
      checks: [],
      criteriaVerified: [], // claims success without covering the criterion
      revisionTreeSha: git(['rev-parse', 'HEAD^{tree}'], baseRepo),
      requirementsFingerprint: binding3.requirementsFingerprint,
      verificationConfigFingerprint: binding3.verificationConfigFingerprint,
      evidenceBindingVersion: binding3.evidenceBindingVersion,
    });
    const uncovered = lifecycle.transition({ taskId: task3.id, to: 'review', actor: 'worker' });
    assert.strictEqual(uncovered.ok, false);
    assert.strictEqual(uncovered.reason, 'uncovered-criteria');
    console.log('✔ [PASS] Passing evidence that does not cover every criterion is rejected fail-closed');

    // ------------------------------------------------------------------
    // Part 5: legacy records without binding require fresh verification;
    // so do records produced under an older protocol version.
    // ------------------------------------------------------------------
    const task4 = makeTask({ key: 'EVID-4', requireApproval: false });
    const wt4 = wsManager.createWorktree(`evid4-${Date.now()}`, `dupond/evid4-${Date.now()}`, 'HEAD');
    const run4 = store.createRun({
      taskId: task4.id, status: 'completed', baseCommit: wt4.baseCommit,
      targetBranch: wt4.branch, worktreePath: wt4.worktreePath, currentAttempt: 1, durationMs: 0,
    });
    const att4 = store.createAttempt({ runId: run4.id, attemptNumber: 1, status: 'succeeded', workerType: 'test', filesModified: [], durationMs: 0, startedAt: new Date().toISOString() });
    const head4 = git(['rev-parse', 'HEAD'], wt4.worktreePath);
    store.recordVerification({
      runId: run4.id,
      attemptId: att4.id,
      revisionSha: head4,
      passed: true,
      checks: [],
      criteriaVerified: ['c-add'],
      // deliberately unbound: written before evidence binding existed
    });
    const legacyReview = lifecycle.transition({ taskId: task4.id, to: 'review', actor: 'worker' });
    assert.strictEqual(legacyReview.ok, false);
    assert.strictEqual(legacyReview.reason, 'legacy-evidence');
    const legacyDelivery = await deliveryService.dispatchDelivery({ runId: run4.id, disposableRemoteDir: bareRemote });
    assert.strictEqual(legacyDelivery.success, false);
    assert.strictEqual(legacyDelivery.status, 409);
    assert.ok(legacyDelivery.error?.includes('legacy-evidence'), `Got: ${legacyDelivery.error}`);

    // Same record, but written under a superseded protocol version.
    const binding4 = computeEvidenceBinding(store.getTask(task4.id)!);
    store.recordVerification({
      runId: run4.id,
      attemptId: att4.id,
      revisionSha: head4,
      passed: true,
      checks: [],
      criteriaVerified: ['c-add'],
      requirementsFingerprint: binding4.requirementsFingerprint,
      verificationConfigFingerprint: binding4.verificationConfigFingerprint,
      evidenceBindingVersion: 'dupond-evidence-v0',
    });
    const upgraded = assessEvidenceValidity(store.getTask(task4.id)!, store.getLatestVerification(run4.id));
    assert.strictEqual(upgraded.valid, false);
    assert.strictEqual((upgraded as any).reason, 'verifier-upgraded');
    console.log('✔ [PASS] Legacy unbound and superseded-protocol evidence require fresh verification');

    // ------------------------------------------------------------------
    // Part 6: concurrent transitions — compare-and-swap rejects the loser
    // and the losing transition writes no audit event.
    // ------------------------------------------------------------------
    const task5 = makeTask({ key: 'EVID-5' });
    const run5 = store.createRun({ taskId: task5.id, status: 'completed', baseCommit: 'HEAD', targetBranch: `dupond/evid5-${Date.now()}`, currentAttempt: 1, durationMs: 0 });
    const att5 = store.createAttempt({ runId: run5.id, attemptNumber: 1, status: 'succeeded', workerType: 'test', filesModified: [], durationMs: 0, startedAt: new Date().toISOString() });
    const binding5 = computeEvidenceBinding(task5);
    store.recordVerification({
      runId: run5.id, attemptId: att5.id, revisionSha: git(['rev-parse', 'HEAD'], baseRepo),
      passed: true, checks: [], criteriaVerified: ['c-add'],
      revisionTreeSha: git(['rev-parse', 'HEAD^{tree}'], baseRepo),
      requirementsFingerprint: binding5.requirementsFingerprint,
      verificationConfigFingerprint: binding5.verificationConfigFingerprint,
      evidenceBindingVersion: binding5.evidenceBindingVersion,
    });
    const otherConnection = new TaskStore(dbFile);
    // The authoritative service grants Review once (transaction + audit).
    const won = lifecycle.transition({ taskId: task5.id, to: 'review', actor: 'verifier' });
    assert.strictEqual(won.ok, true);
    // A worker on a second connection still believes the task is "todo".
    const staleCas = otherConnection.transitionTaskCas({
      taskId: task5.id, expectedFrom: ['todo'], to: 'in_progress', actor: 'stale-worker',
    });
    assert.strictEqual(staleCas, false, 'CAS must reject a transition built on a stale read');
    const lost = otherConnection.transitionTaskCas({
      taskId: task5.id, expectedFrom: ['todo'], to: 'done', actor: 'stale-worker',
    });
    assert.strictEqual(lost, false);
    // Fail-closed contract: an acceptance-granting CAS is refused even when
    // the status expectation matches, unless it carries a revalidating guard.
    const noGuardGrant = otherConnection.transitionTaskCas({
      taskId: task5.id, expectedFrom: ['review'], to: 'done', actor: 'stale-worker',
    });
    assert.strictEqual(noGuardGrant, false, 'guard-less Review/Done CAS must not grant acceptance');
    assert.strictEqual(store.getTask(task5.id)!.status, 'review');
    const casAudits = store.listAuditEvents(task5.id).filter((a) => a.eventType === 'TASK_LIFECYCLE_TRANSITION');
    assert.strictEqual(casAudits.length, 1, 'only the winning transition is audited');
    otherConnection.getRawDb().close();
    console.log('✔ [PASS] Concurrent transitions are serialized by compare-and-swap with transactional audit');

    // ------------------------------------------------------------------
    // Part 7: restart persistence — a second connection re-reads the same
    // file and keeps bound evidence and statuses; reconcile does not rewrite
    // verified history. (The original handle stays open for the scenarios
    // that follow; the reopened connection proves disk durability.)
    // ------------------------------------------------------------------
    const reopened = new TaskStore(dbFile);
    const persistedVer = reopened.getLatestVerification(run1.id)!;
    assert.strictEqual(persistedVer.requirementsFingerprint, ver1.requirementsFingerprint, 'binding survives restart');
    assert.strictEqual(assessEvidenceValidity(reopened.getTask(task1.id)!, persistedVer).valid, false, // still stale-requirements, not silently valid
      'post-restart assessment re-derives fingerprints from persisted spec');
    assert.strictEqual((assessEvidenceValidity(reopened.getTask(task1.id)!, persistedVer) as any).reason, 'stale-requirements');
    assert.strictEqual(
      assessEvidenceValidity(reopened.getTask(task1.id)!, reopened.getLatestVerification(run1b.id)!).valid,
      true,
      'the fresh post-change evidence is still valid after restart',
    );
    assert.strictEqual(reopened.getTask(task2.id)!.status, 'in_progress', 'revoked acceptance stays revoked across restart');
    const reconciliation = reopened.reconcileOnRestart();
    assert.ok(reconciliation.reconciledRuns >= 0 && reconciliation.unclaimedTasks >= 0);
    console.log('✔ [PASS] Evidence binding and lifecycle status survive process restart');

    // ------------------------------------------------------------------
    // Part 8: the UI/JSON projection cannot grant acceptance. A posted
    // Review/Done status for a store-backed task is clamped to the
    // persisted lifecycle outcome.
    // ------------------------------------------------------------------
    const jsonView = coordinator.getStateView();
    const seedTask = jsonView.tasks.find((t) => t.status !== 'done')!;
    const dbTwin = prodStore.createTask({
      key: seedTask.key,
      title: seedTask.title,
      description: seedTask.description || '',
      status: 'in_progress',
      priority: 'medium',
      targetRepo: 'fixture/math-service',
      baseCommit: 'HEAD',
      allowedPaths: ['*'],
      protectedPaths: [],
      verificationCommands: [CHECK],
      acceptanceCriteria: [{ id: 'c-add', title: '2+3=5', completed: false, checkCommand: CHECK }],
      workerConfig: { provider: 'test', model: 'test' },
      maxAttempts: 1,
      timeoutSeconds: 60,
      requireApproval: true,
    } as any);

    const postedTasks = jsonView.tasks.map((t) => (t.key === seedTask.key ? { ...t, status: 'review' as const } : t));
    const projection = coordinator.updateState({ tasks: postedTasks });
    assert.strictEqual(projection.success, true, 'state blob validates');
    assert.ok(projection.rejectedDoneTasks.includes(seedTask.key));
    const clamped = coordinator.getStateView().tasks.find((t) => t.key === seedTask.key)!;
    assert.strictEqual(clamped.status, 'in_progress', 'UI cannot self-grant Review for a store-backed task');

    const viaEndpoint = await coordinator.transitionTaskStatus(seedTask.key, 'review');
    assert.strictEqual(viaEndpoint.success, false, 'transition endpoint is bound by the evidence gate');
    assert.ok(viaEndpoint.error?.includes('no-evidence') || viaEndpoint.error?.includes('Review requires current passing evidence'), `Got: ${viaEndpoint.error}`);

    // Give the store-backed twin real evidence, then the same transition succeeds.
    const twinRun = prodStore.createRun({ taskId: dbTwin.id, status: 'completed', baseCommit: 'HEAD', targetBranch: `dupond/twin-${Date.now()}`, currentAttempt: 1, durationMs: 0 });
    const twinAttempt = prodStore.createAttempt({ runId: twinRun.id, attemptNumber: 1, status: 'succeeded', workerType: 'test', filesModified: [], durationMs: 0, startedAt: new Date().toISOString() });
    const twinBinding = computeEvidenceBinding(prodStore.getTask(dbTwin.id)!);
    prodStore.recordVerification({
      runId: twinRun.id, attemptId: twinAttempt.id, revisionSha: git(['rev-parse', 'HEAD'], baseRepo),
      passed: true, checks: [], criteriaVerified: ['c-add'],
      revisionTreeSha: git(['rev-parse', 'HEAD^{tree}'], baseRepo),
      requirementsFingerprint: twinBinding.requirementsFingerprint,
      verificationConfigFingerprint: twinBinding.verificationConfigFingerprint,
      evidenceBindingVersion: twinBinding.evidenceBindingVersion,
    });
    const promoted = await coordinator.transitionTaskStatus(seedTask.key, 'review');
    assert.strictEqual(promoted.success, true, `With valid evidence the shared service grants Review: ${promoted.error}`);
    assert.strictEqual(prodStore.getTask(dbTwin.id)!.status, 'review');

    const doneAttempt = await coordinator.transitionTaskStatus(seedTask.key, 'done');
    assert.strictEqual(doneAttempt.success, false, 'Done additionally requires a recorded delivery');
    assert.ok(doneAttempt.error?.includes('delivery'), `Got: ${doneAttempt.error}`);
    console.log('✔ [PASS] UI/JSON state is a projection: acceptance statuses require the authoritative lifecycle service');

    // ------------------------------------------------------------------
    // Part 9: a description-only change is an acceptance-relevant change.
    // The specification is folded into the requirements fingerprint, and an
    // edit arriving through the supported UI write path must update the
    // authoritative task and revoke the acceptance the old spec granted.
    // ------------------------------------------------------------------
    const taskD = makeTask({ key: 'EVID-9', requireApproval: false });
    const runD = await runToReview(taskD);
    const verD = store.getLatestVerification(runD.id)!;
    assert.strictEqual(store.getTask(taskD.id)!.status, 'review');

    const specChange = store.updateTaskRequirements(taskD.id, {
      description: store.getTask(taskD.id)!.description + ' — wording only, same commands and criteria',
    }, 'product-owner');
    assert.strictEqual(specChange.bindingChanged, true, 'description alone re-binds the evidence');
    assert.strictEqual(specChange.revokedAcceptanceFrom, 'review', 'granted Review is revoked by the rebind');
    assert.strictEqual(store.getTask(taskD.id)!.status, 'in_progress', 'demoted out of Review');
    const auditsD = store.listAuditEvents(taskD.id);
    assert.ok(auditsD.some((a) => a.eventType === 'TASK_ACCEPTANCE_REVOKED'), 'revocation audited');
    assert.strictEqual(store.getLatestVerification(runD.id)!.id, verD.id, 'historical evidence row preserved for audit');
    const staleAfterDesc = lifecycle.transition({ taskId: taskD.id, to: 'review', actor: 'worker' });
    assert.strictEqual(staleAfterDesc.ok, false);
    assert.strictEqual(staleAfterDesc.reason, 'stale-requirements');
    console.log('✔ [PASS] Description-only specification change re-binds evidence and revokes granted Review');

    // The UI write path (coordinator.updateState) must not be able to edit
    // acceptance-relevant fields without the authoritative store noticing.
    const twinBefore = prodStore.getTask(dbTwin.id)!;
    const bindingBefore9b = computeEvidenceBinding(twinBefore);
    const editedBlob = coordinator.getStateView().tasks.map((t) => t.key === seedTask.key
      ? {
          ...t,
          description: 'Clarified specification wording only',
          acceptanceCriteria: twinBefore.acceptanceCriteria.map((c) => ({ ...c })),
          verificationCommands: [...twinBefore.verificationCommands],
          protectedPaths: [...twinBefore.protectedPaths],
        }
      : t);
    const editResult = coordinator.updateState({ tasks: editedBlob });
    assert.strictEqual(editResult.success, true);
    const twinAfter9b = prodStore.getTask(dbTwin.id)!;
    assert.strictEqual(twinAfter9b.description, 'Clarified specification wording only', 'edit reached the authoritative task');
    const bindingAfter9b = computeEvidenceBinding(twinAfter9b);
    assert.notStrictEqual(bindingAfter9b.requirementsFingerprint, bindingBefore9b.requirementsFingerprint, 'spec change re-binds requirements');
    assert.strictEqual(bindingAfter9b.verificationConfigFingerprint, bindingBefore9b.verificationConfigFingerprint, 'config alone was not touched');
    assert.strictEqual(twinAfter9b.status, 'in_progress', 'Review on the twin was revoked through the UI edit path');
    assert.ok(editResult.rejectedDoneTasks.includes(seedTask.key), 'revocation surfaces to the caller');
    const clamped9b = coordinator.getStateView().tasks.find((t) => t.key === seedTask.key)!;
    assert.strictEqual(clamped9b.status, 'in_progress', 'UI projection shows the revoked status, not the posted one');
    console.log('✔ [PASS] Supported editing paths update the authoritative task and invalidate its evidence');

    // ------------------------------------------------------------------
    // Part 10: same-commit re-approval after revocation. A delivery for an
    // already-PR'd commit must not silently restore approval: fresh explicit
    // operator approval is required, the PR is reused without duplication,
    // and Done is applied through the lifecycle service.
    // ------------------------------------------------------------------
    const ver1b = store.getLatestVerification(run1b.id)!;
    // Recreate the run worktree at the verified revision: delivery resolves
    // the delivered commit from the run's workspace HEAD.
    wsManager.createWorktree(run1b.id, run1b.targetBranch!, ver1b.revisionSha);
    const d1 = await deliveryService.dispatchDelivery({
      runId: run1b.id, isApproved: true, approvedBy: 'op-1', disposableRemoteDir: bareRemote,
    });
    assert.strictEqual(d1.success, true, `First delivery should succeed: ${d1.error}`);
    assert.strictEqual(store.getTask(task1.id)!.status, 'done');
    const del1 = store.getDeliveryForRun(run1b.id)!;

    const refCountAfterD1 = git(['for-each-ref', '--format=%(refname)'], bareRemote).split('\n').filter(Boolean).length;

    const rebind10 = store.updateTaskRequirements(task1.id, { description: 're-approved under tightened wording' }, 'product-owner');
    assert.strictEqual(rebind10.bindingChanged, true);
    assert.strictEqual(rebind10.revokedAcceptanceFrom, 'done');
    assert.strictEqual(store.getTask(task1.id)!.status, 'in_progress');
    assert.strictEqual(store.getDeliveryForRun(run1b.id)!.approvalStatus, 'pending_approval');

    // Fresh verification of the *same* commit under the new binding.
    const att1b = store.listAttempts(run1b.id)[store.listAttempts(run1b.id).length - 1];
    const binding10 = computeEvidenceBinding(store.getTask(task1.id)!);
    store.recordVerification({
      runId: run1b.id,
      attemptId: att1b.id,
      revisionSha: del1.deliveredCommit!,
      passed: true,
      checks: [],
      criteriaVerified: ['c-add', 'c-add2'],
      revisionTreeSha: git(['rev-parse', `${del1.deliveredCommit}^{tree}`], baseRepo),
      requirementsFingerprint: binding10.requirementsFingerprint,
      verificationConfigFingerprint: binding10.verificationConfigFingerprint,
      evidenceBindingVersion: binding10.evidenceBindingVersion,
    });
    const reReview = lifecycle.transition({ taskId: task1.id, to: 'review', actor: 'verifier' });
    assert.strictEqual(reReview.ok, true, `Same commit re-verified under the new spec: ${reReview.detail}`);

    // Without explicit fresh approval the reused PR stays blocked.
    const d2 = await deliveryService.dispatchDelivery({ runId: run1b.id, isApproved: false, disposableRemoteDir: bareRemote });
    assert.strictEqual(d2.success, false, 'reused delivery must never self-restore approval');
    assert.strictEqual(d2.approvalRequired, true);
    assert.strictEqual(store.getTask(task1.id)!.status, 'review', 'still waiting for the operator');

    const d3 = await deliveryService.dispatchDelivery({
      runId: run1b.id, isApproved: true, approvedBy: 'op-2', disposableRemoteDir: bareRemote,
    });
    assert.strictEqual(d3.success, true, `Re-approval delivery: ${d3.error}`);
    assert.ok(d3.message?.includes('Existing pull request reconciled'), `Got: ${d3.message}`);
    assert.ok(d3.message?.includes('fresh operator approval'), `Got: ${d3.message}`);
    assert.strictEqual(d3.prUrl, del1.prUrl, 'existing PR reused, none duplicated');
    const refCountAfterD3 = git(['for-each-ref', '--format=%(refname)'], bareRemote).split('\n').filter(Boolean).length;
    assert.strictEqual(refCountAfterD3, refCountAfterD1, 'no new branch or PR was created by the reconcile');
    const del3 = store.getDeliveryForRun(run1b.id)!;
    assert.strictEqual(del3.id, del1.id, 'same delivery record carries the fresh approval');
    assert.strictEqual(del3.approvalStatus, 'approved');
    assert.strictEqual(del3.approvedBy, 'op-2');
    assert.strictEqual(store.getTask(task1.id)!.status, 'done', 'Done applied through the lifecycle service on re-approval');
    const audits10 = store.listAuditEvents(task1.id);
    assert.ok(audits10.some((a) => a.eventType === 'DELIVERY_REAPPROVED'), 're-approval audited');
    assert.ok(audits10.some((a) => a.eventType === 'TASK_ACCEPTANCE_REVOKED'), 'revocation audited');
    console.log('✔ [PASS] Same-commit redelivery requires explicit fresh approval, reuses the PR, and re-applies Done');

    // ------------------------------------------------------------------
    // Part 11: exact-content gates — a dirty candidate is refused before
    // any command runs, and verification commands that mutate the worktree
    // or move HEAD invalidate their own evidence.
    // ------------------------------------------------------------------
    const wt11 = wsManager.createWorktree(`evid11-${Date.now()}`, `dupond/evid11-${Date.now()}`, 'HEAD');
    // Local git tooling on some machines drops an untracked .gitignore into
    // new worktrees; the exact-content gates are the point of this part, so
    // normalize the candidate to its revision before probing.
    git(['clean', '-fdx'], wt11.worktreePath);
    const OK_CMD = 'node -e "process.exit(0)"';
    const base11 = {
      worktreePath: wt11.worktreePath,
      baseCommit: wt11.baseCommit,
      verificationCommands: [OK_CMD],
      acceptanceCriteria: [{ id: 'c-ok', title: 'ok', completed: false, checkCommand: OK_CMD }],
      protectedPaths: [] as string[],
    };
    fs.writeFileSync(path.join(wt11.worktreePath, 'draft.txt'), 'uncommitted draft');
    const dirtyRefused = await verifier.verify(base11);
    assert.strictEqual(dirtyRefused.passed, false, 'dirty worktree cannot be certified');
    assert.ok(dirtyRefused.failureReason?.includes('Candidate not deliverable'), `Got: ${dirtyRefused.failureReason}`);
    fs.rmSync(path.join(wt11.worktreePath, 'draft.txt'));

    const cleanPass = await verifier.verify(base11);
    assert.strictEqual(cleanPass.passed, true, `Clean candidate with passing checks verifies: ${cleanPass.failureReason}`);

    const MUT_CMD = `node -e "require('fs').writeFileSync('made-by-check.tmp','x')"`;
    const mutated = await verifier.verify({
      ...base11,
      verificationCommands: [MUT_CMD],
      acceptanceCriteria: [{ id: 'c-ok', title: 'ok', checkCommand: MUT_CMD }],
    });
    assert.strictEqual(mutated.passed, false, 'checks that dirty the candidate must not certify it');
    assert.ok(mutated.failureReason?.includes('altered the candidate'), `Got: ${mutated.failureReason}`);
    wsManager.cleanupWorktree(wt11.worktreePath, wt11.branch);
    console.log('✔ [PASS] Dirty candidates are refused pre-flight; verification-command mutations invalidate evidence');

    // ------------------------------------------------------------------
    // Part 12: restart projection — persisted lifecycle outcomes (including
    // "blocked", which has no board column) are projected into the UI, and
    // a freshly constructed coordinator projects before anyone reads it.
    // ------------------------------------------------------------------
    assert.strictEqual(
      prodStore.transitionTaskCas({ taskId: dbTwin.id, expectedFrom: ['in_progress'], to: 'blocked', actor: 'test' }),
      true, 'simulated blocked outcome persisted',
    );
    const projectedCount = coordinator.projectAuthoritativeStatuses();
    assert.ok(projectedCount >= 1, 'projection reports the change');
    const blockedView = coordinator.getStateView().tasks.find((t) => t.key === seedTask.key)!;
    assert.strictEqual(blockedView.status, 'todo', 'blocked projects onto the board as todo with context in the comment');
    assert.ok(blockedView.lastAgentComment?.includes('blocked'), `Got: ${blockedView.lastAgentComment}`);

    // Persist an acceptance-bearing outcome (as delivery would apply it),
    // leaving the JSON entry stale, then simulate a process restart.
    assert.strictEqual(
      prodStore.transitionTaskCas({
        taskId: dbTwin.id, expectedFrom: ['blocked'], to: 'review', actor: 'test',
        guard: () => ({ accept: true }),
      }),
      true, 'guarded CAS applies the persisted outcome',
    );
    assert.strictEqual(coordinator.getStateView().tasks.find((t) => t.key === seedTask.key)!.status, 'todo', 'running coordinator still stale');
    const restarted = new CoordinatorEngine();
    assert.strictEqual(
      restarted.getStateView().tasks.find((t) => t.key === seedTask.key)!.status,
      'review',
      'constructor projects persisted statuses into the UI on restart',
    );
    console.log('✔ [PASS] Persisted lifecycle outcomes (including blocked) are projected into the UI after restart');

    // ------------------------------------------------------------------
    // Part 13: two-connection race — requirements changes cannot interleave
    // between evidence validation and the status write, and a change that
    // commits before the next transition is seen inside that transaction.
    // ------------------------------------------------------------------
    const taskR = makeTask({ key: 'EVID-13', requireApproval: false });
    await runToReview(taskR);
    const connB = new TaskStore(dbFile);
    let racedWrite: string | null = null;
    const racedApplied = store.transitionTaskCas({
      taskId: taskR.id,
      expectedFrom: ['in_progress'],
      to: 'done',
      actor: 'racer',
      guard: (snapshot) => {
        try {
          connB.updateTaskRequirements(taskR.id, { description: 'changed mid-transaction' });
        } catch (err: any) {
          racedWrite = String(err?.message || err);
        }
        return { accept: false, reason: 'test-hold', detail: 'guard holds the lock; the outcome is asserted' };
      },
    });
    assert.strictEqual(racedApplied, false);
    assert.ok(racedWrite && /locked/i.test(racedWrite), `concurrent requirements write must serialize behind the acceptance transaction; got ${racedWrite}`);
    assert.strictEqual(store.getTask(taskR.id)!.description, taskR.description, 'racing write never interleaved');

    // The serial ordering: a committed change is re-evaluated by the next
    // transition's in-transaction validation instead of granting acceptance.
    const afterRace = connB.updateTaskRequirements(taskR.id, { verificationCommands: ['echo "post-race rotate"'] });
    assert.strictEqual(afterRace.bindingChanged, true);
    assert.strictEqual(afterRace.revokedAcceptanceFrom, 'review', 'granted Review revoked by the committed change');
    const postRaceReview = lifecycle.transition({ taskId: taskR.id, to: 'review', actor: 'worker' });
    assert.strictEqual(postRaceReview.ok, false);
    assert.strictEqual(postRaceReview.reason, 'changed-verification-config');
    connB.getRawDb().close();
    console.log('✔ [PASS] Acceptance validation and commit are atomic against a second connection; committed changes are seen');

    // ------------------------------------------------------------------
    // Part 14: acceptance edits posted by the board must reach the
    // authoritative criteria and revoke what the previous contract granted.
    // Payloads below are the shapes TaskDetailModal sends through
    // POST /api/orchestrate/state, built from the authoritative record.
    // ------------------------------------------------------------------
    const uiTaskBase = (rec: any, over: Record<string, unknown> = {}): any => ({
      id: rec.id,
      key: rec.key,
      title: rec.title,
      description: rec.description,
      epicId: 'evidence-epic',
      status: rec.status,
      priority: 'high',
      assignedAgentId: '',
      estimatedHours: 1,
      spentHours: 0,
      dependencies: [],
      tags: [],
      subtasks: (rec.acceptanceCriteria || []).map((c: any) => ({ id: c.id, title: c.title, completed: c.completed })),
      acceptanceCriteria: (rec.acceptanceCriteria || []).map((c: any) => ({
        id: c.id, title: c.title, completed: c.completed, ...(c.checkCommand ? { checkCommand: c.checkCommand } : {}),
      })),
      verificationCommands: rec.verificationCommands,
      protectedPaths: rec.protectedPaths,
      ...over,
    });

    // The SPA posts the whole board; keep the other entries untouched.
    const postUi = (edited: any[]) => coordinator.updateState({
      tasks: [...coordinator.getStateView().tasks.filter((t) => !edited.some((e) => e.key === t.key)), ...edited] as any,
    });

    const taskE = makeTask({ key: 'AEG-9141', requireApproval: false });
    await runToReview(taskE);
    assert.strictEqual(store.getTask(taskE.id)!.status, 'review', 'evidence-bound Review established');

    const recE1 = store.getTask(taskE.id)!;
    const addRes = postUi([uiTaskBase(recE1, {
      acceptanceCriteria: [
        ...recE1.acceptanceCriteria.map((c: any) => ({ ...c })),
        { id: 'c-div', title: '10 divided by 2 is 5', completed: false },
      ],
    })]);
    assert.strictEqual(addRes.success, true, 'UI payload validates');
    const recE2 = store.getTask(taskE.id)!;
    assert.deepStrictEqual(
      recE2.acceptanceCriteria.map((c: any) => c.id), ['c-add', 'c-div'],
      'the added requirement reached the authoritative criteria',
    );
    assert.notStrictEqual(
      computeEvidenceBinding(recE2).requirementsFingerprint,
      computeEvidenceBinding(recE1).requirementsFingerprint,
      'the added requirement re-binds the evidence',
    );
    assert.strictEqual(recE2.status, 'in_progress', 'Review granted under the previous contract is revoked');
    assert.ok(addRes.rejectedDoneTasks.includes(recE1.key), 'revocation is reported to the caller');
    const reviewAfterAdd = lifecycle.transition({ taskId: taskE.id, to: 'review', actor: 'worker' });
    assert.strictEqual(reviewAfterAdd.ok, false, 'old evidence cannot certify a requirement it never checked');
    assert.strictEqual(reviewAfterAdd.reason, 'stale-requirements');
    const viewE1 = coordinator.getStateView().tasks.find((t) => t.key === recE1.key)!;
    assert.strictEqual(viewE1.status, 'in_progress', 'the board projection follows the revoked outcome');
    assert.deepStrictEqual(viewE1.acceptanceCriteria?.map((c: any) => c.id), ['c-add', 'c-div'], 'the board mirrors authoritative criteria');

    // Editing a title must not rewrite identities: the untouched criterion keeps
    // its check command, and the edited one keeps both its id and its command.
    const recE3 = store.getTask(taskE.id)!;
    const editRes = postUi([uiTaskBase(recE3, {
      status: 'in_progress',
      acceptanceCriteria: recE3.acceptanceCriteria.map((c: any) => ({ id: c.id, title: c.id === 'c-div' ? '10 ÷ 2 must equal 5' : c.title, completed: c.completed })),
    })]);
    assert.strictEqual(editRes.success, true);
    const recE4 = store.getTask(taskE.id)!;
    assert.strictEqual(recE4.acceptanceCriteria.find((c: any) => c.id === 'c-add')!.checkCommand, CHECK, 'unchanged criterion kept its check command');
    assert.strictEqual(recE4.acceptanceCriteria.find((c: any) => c.id === 'c-div')!.title, '10 ÷ 2 must equal 5', 'edited title persisted');
    assert.strictEqual(recE4.acceptanceCriteria.find((c: any) => c.id === 'c-div')!.checkCommand, undefined, 'no check command invented');
    assert.deepStrictEqual(recE4.acceptanceCriteria.map((c: any) => c.id), ['c-add', 'c-div'], 'ids preserved across the edit');

    // Removing a requirement is also an acceptance-relevant change.
    const recE5 = store.getTask(taskE.id)!;
    postUi([uiTaskBase(recE5, {
      acceptanceCriteria: recE5.acceptanceCriteria.filter((c: any) => c.id !== 'c-div').map((c: any) => ({ id: c.id, title: c.title, completed: c.completed })),
    })]);
    const recE6 = store.getTask(taskE.id)!;
    assert.deepStrictEqual(recE6.acceptanceCriteria.map((c: any) => c.id), ['c-add'], 'removal reached the store');
    assert.strictEqual(recE6.acceptanceCriteria[0].checkCommand, CHECK, 'surviving criterion still carries its command');
    console.log('✔ [PASS] Acceptance add/edit/remove through the UI updates authoritative criteria and revokes granted acceptance');

    // ------------------------------------------------------------------
    // Part 15: an omitted criteria field means "not stated"; an explicitly
    // empty list means "no acceptance requirements". They cannot be the same.
    // ------------------------------------------------------------------
    const recF1 = store.getTask(taskE.id)!;
    const bindingF1 = computeEvidenceBinding(recF1);
    const omittedPayload = uiTaskBase(recF1, { status: 'in_progress' });
    delete omittedPayload.acceptanceCriteria;
    const omittedRes = postUi([omittedPayload]);
    assert.strictEqual(omittedRes.success, true);
    const recF2 = store.getTask(taskE.id)!;
    assert.deepStrictEqual(recF2.acceptanceCriteria.map((c: any) => c.id), ['c-add'], 'an omitted field leaves criteria intact');
    assert.strictEqual(computeEvidenceBinding(recF2).requirementsFingerprint, bindingF1.requirementsFingerprint, 'omission does not re-bind');
    assert.strictEqual(omittedRes.rejectedDoneTasks.includes(recF1.key), false, 'nothing was revoked because nothing changed');

    const emptyRes = postUi([uiTaskBase(recF2, { status: 'in_progress', acceptanceCriteria: [] })]);
    assert.strictEqual(emptyRes.success, true);
    const recF3 = store.getTask(taskE.id)!;
    assert.deepStrictEqual(recF3.acceptanceCriteria, [], 'an explicit empty list clears the acceptance contract');
    assert.notStrictEqual(computeEvidenceBinding(recF3).requirementsFingerprint, bindingF1.requirementsFingerprint, 'clearing re-binds the evidence');
    assert.ok(emptyRes.rejectedDoneTasks.includes(recF1.key), 'the clear is reported to the caller');
    postUi([uiTaskBase(store.getTask(taskE.id)!, {
      acceptanceCriteria: [{ id: 'c-add', title: '2+3=5', completed: false, checkCommand: CHECK }],
    })]);
    assert.strictEqual(computeEvidenceBinding(store.getTask(taskE.id)!).requirementsFingerprint, bindingF1.requirementsFingerprint, 'restoring the contract restores its identity');
    console.log('✔ [PASS] Omitted criteria are preserved while an explicitly empty list clears the contract');

    // ------------------------------------------------------------------
    // Part 16: ticking a box is not acceptance. Checklist state never enters
    // the evidence binding and a posted completion cannot grant Review.
    // ------------------------------------------------------------------
    const recG1 = store.getTask(taskE.id)!;
    const bindingG1 = computeEvidenceBinding(recG1);
    const boxedRes = postUi([uiTaskBase(recG1, {
      status: 'review',
      subtasks: recG1.acceptanceCriteria.map((c: any) => ({ id: c.id, title: c.title, completed: true })),
      acceptanceCriteria: recG1.acceptanceCriteria.map((c: any) => ({ ...c, completed: true })),
    })]);
    const recG2 = store.getTask(taskE.id)!;
    assert.strictEqual(computeEvidenceBinding(recG2).requirementsFingerprint, bindingG1.requirementsFingerprint, 'completion flags are outside the binding');
    assert.strictEqual(recG2.status, 'in_progress', 'checked boxes did not advance the authoritative status');
    assert.ok(boxedRes.rejectedDoneTasks.includes(recG1.key), 'the posted Review was refused by the lifecycle gate');
    assert.strictEqual(coordinator.getStateView().tasks.find((t) => t.key === recG1.key)!.status, 'in_progress', 'the board shows the refused outcome');

    // A requirement with no check coverage stays unverified even when the
    // evidence row is bound to the very spec that introduced it.
    const taskH = makeTask({ key: 'AEG-9143', requireApproval: false });
    const runH = await runToReview(taskH);
    const recH1 = store.getTask(taskH.id)!;
    postUi([uiTaskBase(recH1, {
      acceptanceCriteria: [...recH1.acceptanceCriteria.map((c: any) => ({ ...c })), { id: 'c-ratio', title: 'ratio helper exported', completed: false }],
    })]);
    const recH2 = store.getTask(taskH.id)!;
    const bindingH2 = computeEvidenceBinding(recH2);
    const attemptH = store.listAttempts(runH.id)[0];
    store.recordVerification({
      id: `ver-uncovered-${Date.now()}`,
      runId: runH.id,
      attemptId: attemptH.id,
      revisionSha: store.getLatestVerification(runH.id)!.revisionSha,
      passed: true,
      checks: [],
      criteriaVerified: ['c-add'],
      revisionTreeSha: store.getLatestVerification(runH.id)!.revisionTreeSha || undefined,
      requirementsFingerprint: bindingH2.requirementsFingerprint,
      verificationConfigFingerprint: bindingH2.verificationConfigFingerprint,
      evidenceBindingVersion: bindingH2.evidenceBindingVersion,
    });
    const reviewH = lifecycle.transition({ taskId: taskH.id, to: 'review', actor: 'worker' });
    assert.strictEqual(reviewH.ok, false, 'an unmapped requirement is never credited');
    assert.strictEqual(reviewH.reason, 'uncovered-criteria', `Got: ${reviewH.reason}`);
    assert.ok(reviewH.detail?.includes('c-ratio'), `Got: ${reviewH.detail}`);
    console.log('✔ [PASS] Checkbox completion grants nothing; an unmapped requirement stays unverified');

    // ------------------------------------------------------------------
    // Part 17: re-approval is bound to the contract and revision it was made
    // against. A requirements change that lands between evidence validation
    // and the approval write must not leave an approval that a later,
    // differently-bound verification can spend.
    // ------------------------------------------------------------------
    const taskJ = makeTask({ key: 'AEG-9144', requireApproval: true });
    const runJ = await runToReview(taskJ);
    const verJ = store.getLatestVerification(runJ.id)!;
    wsManager.createWorktree(runJ.id, runJ.targetBranch!, verJ.revisionSha);
    const dJ1 = await deliveryService.dispatchDelivery({ runId: runJ.id, isApproved: true, approvedBy: 'op-j1', disposableRemoteDir: bareRemote });
    assert.strictEqual(dJ1.success, true, `initial approved delivery: ${dJ1.error}`);
    const delJ = store.getDeliveryForRun(runJ.id)!;
    const prUrlJ = delJ.prUrl;
    const refsJ = git(['for-each-ref', '--format=%(refname)'], bareRemote).split('\n').filter(Boolean).length;
    assert.ok(delJ.approvalRequirementsFingerprint, 'an approved delivery records the contract it was granted under');

    // Contract B, then back to A: the evidence is current again, but approval
    // of the old contract was revoked and is never restored implicitly.
    const criteriaJ = store.getTask(taskJ.id)!.acceptanceCriteria.map((c: any) => ({ ...c }));
    store.updateTaskRequirements(taskJ.id, {
      acceptanceCriteria: [...criteriaJ, { id: 'c-edge', title: 'empty input handled', completed: false, checkCommand: CHECK }],
    }, 'product-owner');
    const backToA = store.updateTaskRequirements(taskJ.id, { acceptanceCriteria: criteriaJ }, 'product-owner');
    assert.strictEqual(backToA.bindingChanged, true);
    assert.strictEqual(store.getTask(taskJ.id)!.status, 'in_progress');
    assert.strictEqual(store.getDeliveryForRun(runJ.id)!.approvalStatus, 'pending_approval', 'approval revoked with the contract it certified');
    const reviewJ = lifecycle.transition({ taskId: taskJ.id, to: 'review', actor: 'verifier' });
    assert.strictEqual(reviewJ.ok, true, `A-era evidence is current again: ${reviewJ.detail}`);

    // The race: the operator's approval is validated against A, and B is
    // committed in the window before the approval row is written.
    const connD = new TaskStore(dbFile);
    const racingStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'approveDelivery') {
          return (...args: any[]) => {
            connD.updateTaskRequirements(taskJ.id, {
              acceptanceCriteria: [...criteriaJ, { id: 'c-race', title: 'requirement added mid-dispatch', completed: false, checkCommand: CHECK }],
            }, 'racing-editor');
            return (target as any).approveDelivery(...args);
          };
        }
        const value = (target as any)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const racingDelivery = new GitHubDeliveryService(racingStore as any, verifier);
    const dStale = await racingDelivery.dispatchDelivery({ runId: runJ.id, isApproved: true, approvedBy: 'op-stale', disposableRemoteDir: bareRemote });
    assert.strictEqual(dStale.success, false, 'a stale approval must not be recorded against a newer contract');
    assert.ok(dStale.blocked === true || dStale.approvalRequired === true, `Got: ${JSON.stringify(dStale)}`);
    const delAfterRace = store.getDeliveryForRun(runJ.id)!;
    assert.notStrictEqual(delAfterRace.approvalStatus, 'approved', 'no approval was persisted');
    assert.strictEqual(delAfterRace.approvedBy, null, 'the stale approver is not recorded');
    assert.strictEqual(store.getTask(taskJ.id)!.status, 'in_progress', 'the newer contract is not accepted');

    // Fresh verification of the same commit under the new contract, then the
    // explicit approval the operator must give for it.
    const recJ3 = store.getTask(taskJ.id)!;
    const bindingJ3 = computeEvidenceBinding(recJ3);
    store.recordVerification({
      id: `ver-race-${Date.now()}`,
      runId: runJ.id,
      attemptId: store.listAttempts(runJ.id)[0].id,
      revisionSha: delJ.deliveredCommit,
      passed: true,
      checks: [],
      criteriaVerified: recJ3.acceptanceCriteria.map((c: any) => c.id),
      revisionTreeSha: git(['rev-parse', `${delJ.deliveredCommit}^{tree}`], baseRepo),
      requirementsFingerprint: bindingJ3.requirementsFingerprint,
      verificationConfigFingerprint: bindingJ3.verificationConfigFingerprint,
      evidenceBindingVersion: bindingJ3.evidenceBindingVersion,
    });
    const reviewJ2 = lifecycle.transition({ taskId: taskJ.id, to: 'review', actor: 'verifier' });
    assert.strictEqual(reviewJ2.ok, true, `current evidence for the new contract: ${reviewJ2.detail}`);
    assert.strictEqual(store.getDeliveryForRun(runJ.id)!.approvalStatus, 'pending_approval', 'the refused approval is still outstanding');

    const dFresh = await deliveryService.dispatchDelivery({ runId: runJ.id, isApproved: true, approvedBy: 'op-j2', disposableRemoteDir: bareRemote });
    assert.strictEqual(dFresh.success, true, `explicit reapproval: ${dFresh.error}`);
    assert.ok(dFresh.message?.includes('Existing pull request reconciled'), `Got: ${dFresh.message}`);
    assert.strictEqual(dFresh.prUrl, prUrlJ, 'the PR is reused, not duplicated');
    const delJ2 = store.getDeliveryForRun(runJ.id)!;
    assert.strictEqual(delJ2.id, delJ.id, 'same delivery record carries the fresh approval');
    assert.strictEqual(delJ2.approvalStatus, 'approved');
    assert.strictEqual(delJ2.approvedBy, 'op-j2');
    assert.strictEqual(delJ2.approvalRequirementsFingerprint, bindingJ3.requirementsFingerprint, 'approval bound to the contract it certified');
    assert.strictEqual(delJ2.approvalRevisionSha, delJ.deliveredCommit, 'approval bound to the exact candidate revision');
    assert.strictEqual(store.getTask(taskJ.id)!.status, 'done', 'Done granted on the freshly bound approval');
    assert.strictEqual(
      git(['for-each-ref', '--format=%(refname)'], bareRemote).split('\n').filter(Boolean).length,
      refsJ, 'no extra refs from the refused attempt or the reconcile');
    const auditsJ = store.listAuditEvents(taskJ.id);
    assert.ok(auditsJ.some((a: any) => a.eventType === 'DELIVERY_APPROVAL_REJECTED'), 'the refused approval is audited');
    assert.ok(auditsJ.some((a: any) => a.eventType === 'DELIVERY_REAPPROVED'), 'the granted approval is audited');
    connD.getRawDb().close();
    console.log('✔ [PASS] Reapproval is atomically bound to the current contract and revision; stale approvals are refused');

    // ------------------------------------------------------------------
    // Part 17b: dispatch must never rebuild consent from re-read rows.
    // Reproduction of the approval-identity race: dispatch validates
    // contract A and evidence A; another connection lands contract B plus
    // fresh passing evidence B on the same commit strictly BEFORE the
    // approval identity is constructed (not merely before the write). The
    // expectation must still certify A, so the transactional validation
    // at the approval write refuses; pre-fix, re-reading the task and
    // evidence at identity-construction time made the original operator
    // silently approve B.
    // ------------------------------------------------------------------
    const taskK = makeTask({ key: 'AEG-9145', description: 'contract A: the spec the operator reviewed' });
    const runK = await runToReview(taskK);
    const verK = store.getLatestVerification(runK.id)!;
    wsManager.createWorktree(runK.id, runK.targetBranch!, verK.revisionSha);
    const dK1 = await deliveryService.dispatchDelivery({ runId: runK.id, isApproved: true, approvedBy: 'op-k1', disposableRemoteDir: bareRemote });
    assert.strictEqual(dK1.success, true, `baseline approved delivery: ${dK1.error}`);
    const delK = store.getDeliveryForRun(runK.id)!;
    const prUrlK = delK.prUrl;
    const revisionK = delK.deliveredCommit;
    const refsK = git(['for-each-ref', '--format=%(refname)'], bareRemote).split('\n').filter(Boolean).length;

    const connK = new TaskStore(dbFile);
    let kRaceInjected = false;
    const racingStoreK = new Proxy(store, {
      get(target, prop) {
        if (prop === 'getLatestVerification') {
          return (...args: any[]) => {
            const result = (target as any).getLatestVerification(...args);
            // Inject once, right after dispatch's opening evidence read —
            // the window before the approval identity snapshot is built.
            if (!kRaceInjected && args[0] === runK.id) {
              kRaceInjected = true;
              connK.updateTaskRequirements(taskK.id, {
                description: 'contract B: rewritten mid-dispatch',
              }, 'racing-editor');
              const recB = connK.getTask(taskK.id)!;
              const bindingB = computeEvidenceBinding(recB);
              connK.recordVerification({
                id: `ver-race-B-${Date.now()}`,
                runId: runK.id,
                attemptId: store.listAttempts(runK.id)[0].id,
                revisionSha: revisionK,
                passed: true,
                checks: [],
                criteriaVerified: recB.acceptanceCriteria.map((c: any) => c.id),
                revisionTreeSha: git(['rev-parse', `${revisionK}^{tree}`], baseRepo),
                requirementsFingerprint: bindingB.requirementsFingerprint,
                verificationConfigFingerprint: bindingB.verificationConfigFingerprint,
                evidenceBindingVersion: bindingB.evidenceBindingVersion,
              });
            }
            return result;
          };
        }
        const value = (target as any)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    assert.strictEqual(kRaceInjected, false, 'injection must not fire outside a dispatch');

    const racingDeliveryK = new GitHubDeliveryService(racingStoreK as any, verifier);
    const dStaleK = await racingDeliveryK.dispatchDelivery({ runId: runK.id, isApproved: true, approvedBy: 'op-k-stale', disposableRemoteDir: bareRemote });
    assert.strictEqual(kRaceInjected, true, 'the racing edit landed before approval identity construction');
    assert.strictEqual(dStaleK.success, false, 'consent rebuilt from newer rows must be refused, not recorded');
    assert.ok(dStaleK.blocked === true || dStaleK.approvalRequired === true, `Got: ${JSON.stringify(dStaleK)}`);
    const delStaleK = store.getDeliveryForRun(runK.id)!;
    assert.notStrictEqual(delStaleK.approvalStatus, 'approved', 'the mid-dispatch contract rewrite did not get certified by the original operator');
    assert.ok(store.listAuditEvents(taskK.id).some((a: any) => a.eventType === 'DELIVERY_APPROVAL_REJECTED' && a.actor === 'op-k-stale'), 'the refused stale approval is audited');
    assert.strictEqual(store.getTask(taskK.id)!.status, 'in_progress', 'the task is not marked Done on a refused approval');
    assert.strictEqual(store.getTask(taskK.id)!.description, 'contract B: rewritten mid-dispatch', 'the racing edit stands as the current contract');
    assert.strictEqual(
      git(['for-each-ref', '--format=%(refname)'], bareRemote).split('\n').filter(Boolean).length,
      refsK, 'the refused dispatch created no second PR');

    // A separate, fresh approval against contract B succeeds and reuses the
    // same PR — the refused request did not duplicate the delivery.
    const recK2 = store.getTask(taskK.id)!;
    const bindingK2 = computeEvidenceBinding(recK2);
    assert.strictEqual(store.getLatestVerification(runK.id)!.requirementsFingerprint, bindingK2.requirementsFingerprint, 'racing evidence is bound to contract B');
    const reviewK = lifecycle.transition({ taskId: taskK.id, to: 'review', actor: 'verifier' });
    assert.strictEqual(reviewK.ok, true, `current evidence for contract B: ${reviewK.detail}`);
    const dFreshK = await deliveryService.dispatchDelivery({ runId: runK.id, isApproved: true, approvedBy: 'op-k-fresh', disposableRemoteDir: bareRemote });
    assert.strictEqual(dFreshK.success, true, `explicit fresh approval against contract B: ${dFreshK.error}`);
    assert.strictEqual(dFreshK.prUrl, prUrlK, 'the PR is reused, not duplicated');
    const delK2 = store.getDeliveryForRun(runK.id)!;
    assert.strictEqual(delK2.id, delK.id, 'the same delivery record carries the fresh approval');
    assert.strictEqual(delK2.approvalStatus, 'approved');
    assert.strictEqual(delK2.approvedBy, 'op-k-fresh');
    assert.strictEqual(delK2.approvalRequirementsFingerprint, bindingK2.requirementsFingerprint, 'the fresh approval certifies the contract read at its own dispatch start');
    assert.strictEqual(delK2.approvalVerificationId, store.getLatestVerification(runK.id)!.id, 'the fresh approval binds the evidence it rested on');
    assert.strictEqual(delK2.approvalRevisionSha, revisionK);
    assert.strictEqual(store.getTask(taskK.id)!.status, 'done', 'Done granted only on the freshly bound approval');
    assert.strictEqual(
      git(['for-each-ref', '--format=%(refname)'], bareRemote).split('\n').filter(Boolean).length,
      refsK, 'the fresh approval reconciled the existing PR');

    // validateApprovalExpectation itself refuses evidence that attests a
    // different revision than the approval certifies, even when the id and
    // fingerprints line up.
    const forgedVer = { ...store.getLatestVerification(runK.id)!, revisionSha: 'f'.repeat(40) };
    const revRefusal = validateApprovalExpectation({
      task: store.getTask(taskK.id)!,
      verification: forgedVer,
      deliveredCommit: revisionK,
      expectation: {
        revisionSha: revisionK,
        requirementsFingerprint: bindingK2.requirementsFingerprint,
        verificationConfigFingerprint: bindingK2.verificationConfigFingerprint,
        verificationId: forgedVer.id,
        evidenceBindingVersion: bindingK2.evidenceBindingVersion,
      },
    });
    assert.strictEqual(revRefusal.accepted, false, 'evidence for a different revision never certifies this approval');
    assert.strictEqual((revRefusal as any).reason, 'evidence-revision-mismatch', `Got: ${JSON.stringify(revRefusal)}`);
    connK.getRawDb().close();
    console.log('✔ [PASS] Approval identity is captured from the original dispatch context; mid-flight contract rewrites are refused, fresh approval reuses the PR');
  } finally {
    try {
      const leftover = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: baseRepo, encoding: 'utf-8' })
        .split('\n')
        .filter((l) => l.startsWith('worktree ') && !l.endsWith(baseRepo))
        .map((l) => l.replace('worktree ', ''));
      for (const p of leftover) wsManager.cleanupWorktree(p);
    } catch { /* best effort */ }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('\n=== ALL ACCEPTANCE EVIDENCE & LIFECYCLE TESTS PASSED CLEANLY ===');
}

test('suite', main);
