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
    verifiedRefForRun,
    EVIDENCE_BINDING_VERSION,
  } = await import('../src/server/verification/evidenceBinding.ts');
  const { coordinator } = await import('../src/server/coordinator.ts');
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
    assert.strictEqual(store.getTask(task5.id)!.status, 'review');
    const casAudits = store.listAuditEvents(task5.id).filter((a) => a.eventType === 'TASK_LIFECYCLE_TRANSITION');
    assert.strictEqual(casAudits.length, 1, 'only the winning transition is audited');
    otherConnection.getRawDb().close();
    console.log('✔ [PASS] Concurrent transitions are serialized by compare-and-swap with transactional audit');

    // ------------------------------------------------------------------
    // Part 7: restart persistence — a reopened store keeps bound evidence
    // and statuses; reconcile does not rewrite verified history.
    // ------------------------------------------------------------------
    store.getRawDb().close();
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
    assert.strictEqual(reopened.getTask(task2.id)!.status, 'review', 'lifecycle status survives restart');
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

main().catch((err) => {
  console.error('Acceptance evidence test failed:', err);
  process.exit(1);
});
