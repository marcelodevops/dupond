import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskStore } from '../src/server/db/database.ts';
import { ProjectStore } from '../src/server/projects/projectStore.ts';
import { CoordinatorEngine } from '../src/server/coordinator.ts';

test('Stage 2: Project Isolation & Authoritative Adoption Suite', async () => {
  console.log('=== RUNNING PROJECT ISOLATION & AUTHORITATIVE ADOPTION TESTS ===\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-test-iso-adopt-'));
  const tmpDb = path.join(tmpDir, 'test.db');
  const tmpState = path.join(tmpDir, 'dupond_state.json');

  process.env.DUPOND_DB_PATH = tmpDb;
  process.env.DUPOND_STATE_FILE = tmpState;

  try {
    const taskStore = new TaskStore(tmpDb);
    const projectStore = new ProjectStore(taskStore);

    // 1. Create two separate projects
    const projA = projectStore.createProject({ name: 'Project Alpha', actor: 'test-admin' });
    const projB = projectStore.createProject({ name: 'Project Beta', actor: 'test-admin' });

    // 2. Pre-populate Task in Project A with key 'TSK-101'
    const taskA = taskStore.createTask({
      id: `task-${projA.id}-101`,
      key: 'TSK-101',
      title: 'Alpha Architecture Specification',
      description: 'Alpha task description',
      status: 'in_progress',
      priority: 'high',
      targetRepo: 'alpha-repo',
      baseCommit: 'HEAD',
      allowedPaths: ['src/**'],
      protectedPaths: [],
      verificationCommands: [],
      workerConfig: { provider: 'mock', model: 'mock-model' },
      maxAttempts: 3,
      timeoutSeconds: 600,
      requireApproval: true,
      projectId: projA.id,
      acceptanceCriteria: [{ id: 'c1', title: 'Alpha criterion', completed: true }],
    });

    assert.ok(taskA.id);
    assert.strictEqual(taskA.projectId, projA.id);

    // Verify scoped lookup
    const lookupA = taskStore.getTaskScoped('TSK-101', projA.id);
    assert.ok(lookupA);
    assert.strictEqual(lookupA.title, 'Alpha Architecture Specification');

    // Scoped lookup for Project B must return NULL even though TSK-101 exists in Project A
    const lookupB = taskStore.getTaskScoped('TSK-101', projB.id);
    assert.strictEqual(lookupB, null, 'Project B must not see Project A task');

    // Strict Unscoped Lookup Rejection:
    // Calling getTask('TSK-101') without projectId MUST return null (not an arbitrary project's task)
    assert.strictEqual(taskStore.getTask('TSK-101'), null, 'Unscoped lookup by human-readable key alone must return null');
    // But exact primary key UUID lookup succeeds:
    const lookupById = taskStore.getTask(taskA.id);
    assert.ok(lookupById, 'Lookup by unique primary key ID succeeds');
    assert.strictEqual(lookupById.id, taskA.id);
    // Lookup by primary key with wrong project scope returns null:
    assert.strictEqual(taskStore.getTask(taskA.id, projB.id), null, 'Lookup by ID with mismatched project must return null');
    console.log('✔ [PASS] getTaskScoped strictly isolates tasks by project ID and rejects unscoped key lookups');

    // 3. Adopt Plan in Project B that happens to have the SAME task key 'TSK-101'
    const planAdoptInput = {
      projectId: projB.id,
      summary: 'Beta Maritime Project Sprint',
      epics: [
        { id: 'epic-beta-1', title: 'Beta Core Services', description: 'Core work', color: '#10B981' },
      ],
      tasks: [
        {
          id: 'task-101', // submitted local id
          key: 'TSK-101', // colliding key with Project A!
          title: 'Beta Maritime Quote Storage Engine',
          description: 'Store maritime quotes in PostgreSQL',
          epicId: 'epic-beta-1',
          priority: 'critical' as const,
          estimatedHours: 8,
          dependencies: [],
          subtasks: [
            { id: 'st-b1', title: 'Setup DB schema', completed: true }, // submitted with completed: true to test stripping
          ],
        },
        {
          id: 'task-102',
          key: 'TSK-102',
          title: 'Beta Quote Validation Endpoint',
          description: 'Validate Astro form input',
          epicId: 'epic-beta-1',
          priority: 'high' as const,
          estimatedHours: 4,
          dependencies: ['TSK-101'],
          subtasks: [{ id: 'st-b2', title: 'Form handler', completed: false }],
        },
      ],
      actor: 'operator-beta',
    };

    const adoptResult = projectStore.adoptPlan(planAdoptInput);
    assert.strictEqual(adoptResult.success, true);
    assert.strictEqual(adoptResult.adoptedCount, 2);

    // 4. Inspect TaskStore in DB: Project B's TSK-101 must exist and be independent
    const freshB101 = taskStore.getTaskScoped('TSK-101', projB.id);
    assert.ok(freshB101, 'Project B must now have its own TSK-101');
    assert.strictEqual(freshB101.title, 'Beta Maritime Quote Storage Engine');
    assert.strictEqual(freshB101.projectId, projB.id);

    // Invariant: Newly adopted tasks must NEVER claim completion or in_progress without verification!
    assert.strictEqual(freshB101.status, 'todo', 'Task with 0 dependencies starts in todo');
    assert.strictEqual(freshB101.acceptanceCriteria[0].completed, false, 'Adopted criteria must have completed: false');
    const projectBState = projectStore.getProjectState<any>(projB.id, {});
    assert.strictEqual(projectBState.tasks[0].subtasks[0].completed, false, 'Projected subtasks must have completed: false');

    // 5. Invariant: Project A must be completely untouched!
    const untouchedA101 = taskStore.getTaskScoped('TSK-101', projA.id);
    assert.ok(untouchedA101);
    assert.strictEqual(untouchedA101.title, 'Alpha Architecture Specification');
    assert.strictEqual(untouchedA101.status, 'in_progress', 'Project A status unchanged');
    assert.strictEqual(untouchedA101.acceptanceCriteria[0].completed, true, 'Project A criteria untouched');

    // Verify Audit events in DB: Zero audit events recorded against Project A during Project B adoption
    const auditA = taskStore.getRawDb()
      .prepare("SELECT * FROM audit_events WHERE project_id = ? AND event_type = 'TASK_REQUIREMENTS_UPDATED'")
      .all(projA.id);
    assert.strictEqual(auditA.length, 0, 'No requirement update events may leak into Project A');
    console.log('✔ [PASS] Adopting colliding keys in Project B causes zero mutations or audit leaks in Project A');

    // 6. Test DAG dependency validation: Reject circular dependencies with complete rollback
    let circularError: any = null;
    try {
      projectStore.adoptPlan({
        projectId: projB.id,
        summary: 'Invalid Circular Plan',
        epics: [{ id: 'ep-1', title: 'Ep' }],
        tasks: [
          {
            id: 'task-c1',
            key: 'CIRC-01',
            title: 'Circular Task 1',
            description: '',
            epicId: 'ep-1',
            dependencies: ['CIRC-02'],
          },
          {
            id: 'task-c2',
            key: 'CIRC-02',
            title: 'Circular Task 2',
            description: '',
            epicId: 'ep-1',
            dependencies: ['CIRC-01'], // Cycle!
          },
        ],
      });
    } catch (err: any) {
      circularError = err;
    }

    assert.ok(circularError, 'Circular dependencies must be rejected');
    assert.strictEqual(circularError.code, 'INVALID_DEPENDENCIES');

    // Confirm rollback: CIRC-01 and CIRC-02 must NOT exist in DB
    const circTask1 = taskStore.getTaskScoped('CIRC-01', projB.id);
    const circTask2 = taskStore.getTaskScoped('CIRC-02', projB.id);
    assert.strictEqual(circTask1, null);
    assert.strictEqual(circTask2, null);
    console.log('✔ [PASS] Circular dependencies rejected and transaction rolled back completely');

    // 7. Restart test: Re-initialize stores from the same DB file and verify tasks survive
    const rebootTaskStore = new TaskStore(tmpDb);
    const rebootProjectStore = new ProjectStore(rebootTaskStore);

    const rebootTasksB = rebootTaskStore.listTasks(undefined, projB.id);
    assert.strictEqual(rebootTasksB.length, 2);
    const keysB = rebootTasksB.map((t) => t.key).sort();
    assert.deepStrictEqual(keysB, ['TSK-101', 'TSK-102']);

    const rebootTasksA = rebootTaskStore.listTasks(undefined, projA.id);
    assert.strictEqual(rebootTasksA.length, 1);
    assert.strictEqual(rebootTasksA[0].key, 'TSK-101');
    console.log('✔ [PASS] Authoritative tasks survive store restart and preserve project isolation');

    // 8. Source-Plan Ownership & Revision Verification Suite
    const sourcePlanA = rebootProjectStore.saveSourcePlan({
      projectId: projA.id,
      sourceText: 'Alpha plan text for ship quotes',
      summary: 'Alpha mission summary',
    });
    assert.ok(sourcePlanA.id);
    assert.strictEqual(sourcePlanA.revision, 1);

    // Cross-project plan adoption rejection (Project B attempting to adopt Project A's plan)
    let crossProjectErr: any = null;
    try {
      rebootProjectStore.adoptPlan({
        projectId: projB.id,
        sourcePlanId: sourcePlanA.id,
        planRevision: 1,
        summary: 'Attempted hijack',
        epics: [{ id: 'ep-cross', title: 'Cross Epic' }],
        tasks: [{ id: 't-cross', key: 'CRS-1', title: 'Cross Task', description: '', epicId: 'ep-cross' }],
      });
    } catch (err: any) {
      crossProjectErr = err;
    }
    assert.ok(crossProjectErr, 'Cross-project plan adoption must be rejected');
    assert.strictEqual(crossProjectErr.code, 'PROJECT_CONTEXT_MISMATCH');
    assert.strictEqual(crossProjectErr.httpStatus, 403);

    // Revision mismatch rejection
    let revMismatchErr: any = null;
    try {
      rebootProjectStore.adoptPlan({
        projectId: projA.id,
        sourcePlanId: sourcePlanA.id,
        planRevision: 999, // wrong revision
        summary: 'Revision mismatch',
        epics: [{ id: 'ep-rev', title: 'Rev Epic' }],
        tasks: [{ id: 't-rev', key: 'REV-1', title: 'Rev Task', description: '', epicId: 'ep-rev' }],
      });
    } catch (err: any) {
      revMismatchErr = err;
    }
    assert.ok(revMismatchErr, 'Plan adoption with revision mismatch must be rejected');
    assert.strictEqual(revMismatchErr.code, 'PLAN_REVISION_MISMATCH');
    assert.strictEqual(revMismatchErr.httpStatus, 409);

    // Non-existent source plan rejection
    let notFoundErr: any = null;
    try {
      rebootProjectStore.adoptPlan({
        projectId: projA.id,
        sourcePlanId: 'source-plan-does-not-exist',
        summary: 'Ghost plan',
        epics: [{ id: 'ep-ghost', title: 'Ghost Epic' }],
        tasks: [{ id: 't-ghost', key: 'GST-1', title: 'Ghost Task', description: '', epicId: 'ep-ghost' }],
      });
    } catch (err: any) {
      notFoundErr = err;
    }
    assert.ok(notFoundErr, 'Non-existent source plan adoption must be rejected');
    assert.strictEqual(notFoundErr.code, 'SOURCE_PLAN_NOT_FOUND');
    assert.strictEqual(notFoundErr.httpStatus, 404);
    console.log('✔ [PASS] Source-plan ownership, existence, and revision integrity strictly enforced');

    // 9. Authoritative Synchronization & Divergence Prevention
    // Project Gamma: Test unstarted task replacement and database-to-board sync
    const projGamma = rebootProjectStore.createProject({ name: 'Project Gamma', actor: 'test-admin' });
    // Add an initial unstarted task in 'todo'
    rebootTaskStore.createTask({
      id: `task-${projGamma.id}-old`,
      key: 'OLD-101',
      title: 'Old Unstarted Task',
      description: 'To be replaced',
      status: 'todo',
      priority: 'low',
      projectId: projGamma.id,
    });
    assert.strictEqual(rebootTaskStore.listTasks(undefined, projGamma.id).length, 1);

    // Adopt a real plan into Gamma
    const gammaPlan = rebootProjectStore.adoptPlan({
      projectId: projGamma.id,
      summary: 'Gamma Plan',
      epics: [{ id: 'ep-g', title: 'Gamma Epic' }],
      tasks: [
        { id: 't-g1', key: 'GAM-101', title: 'Gamma Task 1', description: 'Desc 1', epicId: 'ep-g' },
        { id: 't-g2', key: 'GAM-102', title: 'Gamma Task 2', description: 'Desc 2', epicId: 'ep-g', dependencies: ['GAM-101'] },
      ],
    });
    assert.strictEqual(gammaPlan.adoptedCount, 2);

    // Verify OLD-101 is preserved alongside the newly adopted plan tasks:
    const oldGammaTask = rebootTaskStore.getTaskScoped('OLD-101', projGamma.id);
    assert.ok(oldGammaTask, 'Previous task must be preserved when adopting a distinct plan');

    // Verify DB tasks and state_json.tasks match identically (zero divergence)
    const gammaDbTasks = rebootTaskStore.listTasks(undefined, projGamma.id);
    const gammaState = rebootProjectStore.getProjectState<any>(projGamma.id, {});
    assert.strictEqual(gammaDbTasks.length, 3);
    assert.strictEqual(gammaState.tasks.length, 3);
    assert.deepStrictEqual(
      gammaDbTasks.map((t) => t.key).sort(),
      gammaState.tasks.map((t: any) => t.key).sort(),
      'Database rows and project state_json must be 100% synchronized',
    );
    console.log('✔ [PASS] Plan adoption synchronizes authoritative DB rows with project state without divergence');

    // 10. Existing Database Migration Test: Migrating old table with global key UNIQUE constraint
    const legacyDbPath = path.join(tmpDir, 'legacy.db');
    const legacyDb = new (await import('node:sqlite')).DatabaseSync(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        target_repo TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        allowed_paths TEXT NOT NULL,
        protected_paths TEXT NOT NULL,
        verification_commands TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        worker_config TEXT NOT NULL,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        timeout_seconds INTEGER NOT NULL DEFAULT 600,
        require_approval INTEGER NOT NULL DEFAULT 1,
        blocked_reason TEXT,
        claimed_by TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks (
        id, key, title, description, status, priority,
        target_repo, base_commit, allowed_paths, protected_paths,
        verification_commands, acceptance_criteria, worker_config,
        created_at, updated_at
      ) VALUES (
        'task-legacy-1', 'LEGACY-1', 'Legacy Task', 'Desc', 'todo', 'medium',
        'repo', 'HEAD', '[]', '[]', '[]', '[]', '{}',
        datetime('now'), datetime('now')
      );
    `);
    legacyDb.close();

    // Now instantiate TaskStore on legacyDbPath to trigger migrateProjectIsolation
    const migratedStore = new TaskStore(legacyDbPath);
    const migratedProjectStore = new ProjectStore(migratedStore);

    // Verify existing legacy task is still intact in default project
    const legacyTask = migratedStore.getTask('task-legacy-1');
    assert.ok(legacyTask);
    assert.strictEqual(legacyTask.key, 'LEGACY-1');
    assert.strictEqual(legacyTask.projectId, 'default');

    // Now create a new project in the migrated DB and insert a task with the SAME key 'LEGACY-1'
    const newProj = migratedProjectStore.createProject({ name: 'Migrated Test Project', actor: 'admin' });
    const duplicateKeyTask = migratedStore.createTask({
      key: 'LEGACY-1',
      title: 'Colliding Legacy Key in New Project',
      projectId: newProj.id,
    });
    assert.ok(duplicateKeyTask.id);
    assert.strictEqual(duplicateKeyTask.key, 'LEGACY-1');
    assert.strictEqual(duplicateKeyTask.projectId, newProj.id);

    // Both tasks exist with identical keys under their respective projects
    const defaultLegacy = migratedStore.getTaskScoped('LEGACY-1', 'default');
    const projectLegacy = migratedStore.getTaskScoped('LEGACY-1', newProj.id);
    assert.ok(defaultLegacy);
    assert.ok(projectLegacy);
    assert.notStrictEqual(defaultLegacy.id, projectLegacy.id);
    console.log('✔ [PASS] Existing database migration removes global key uniqueness and enables multi-project duplicate keys');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
