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
    console.log('✔ [PASS] getTaskScoped strictly isolates tasks by project ID');

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

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
