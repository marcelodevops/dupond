import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parsePlan, getPlanningReadiness } from '../src/server/planning/planBreakdown.ts';
import { TaskStore } from '../src/server/db/database.ts';
import { ProjectStore } from '../src/server/projects/projectStore.ts';

test('Stage 1: Honest Planning & Preserved Input Suite', async () => {
  console.log('=== RUNNING HONEST PLANNING & PRESERVED INPUT TESTS ===\n');

  // Test 1: Missing credentials fails explicitly with PLANNER_UNAVAILABLE (no fabricated tasks)
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    let errorThrown: any = null;
    try {
      await parsePlan('Synthetic mission for maritime quote submission', []);
    } catch (err: any) {
      errorThrown = err;
    }

    assert.ok(errorThrown, 'parsePlan must throw when GEMINI_API_KEY is missing');
    assert.strictEqual(errorThrown.code, 'PLANNER_UNAVAILABLE');
    assert.match(errorThrown.message, /GEMINI_API_KEY/i);
    console.log('✔ [PASS] Missing GEMINI_API_KEY throws explicit PLANNER_UNAVAILABLE');
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
  }

  // Test 2: Effective values & readiness report
  const readinessWithoutKey = getPlanningReadiness();
  assert.strictEqual(readinessWithoutKey.provider, 'gemini');
  assert.strictEqual(readinessWithoutKey.model, 'gemini-3.8-flash');
  assert.strictEqual(readinessWithoutKey.ready, false);
  assert.ok(readinessWithoutKey.error?.includes('GEMINI_API_KEY'));
  console.log('✔ [PASS] Planning readiness accurately reports unconfigured state');

  // Test 3: Plan Source Text Persistence in SQLite
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-test-plan-'));
  const tmpDb = path.join(tmpDir, 'test.db');
  try {
    const store = new TaskStore(tmpDb);
    const pStore = new ProjectStore(store);

    const project = pStore.createProject({
      name: 'Maritime Project',
      description: 'Persistent quote requests',
      actor: 'test-operator',
    });

    const missionText1 = 'Naviera maritime quote request v1';
    const planRec1 = pStore.saveSourcePlan({
      projectId: project.id,
      sourceText: missionText1,
      status: 'submitted',
    });

    assert.strictEqual(planRec1.revision, 1);
    assert.strictEqual(planRec1.sourceText, missionText1);
    assert.strictEqual(planRec1.projectId, project.id);

    // Save second revision
    const missionText2 = 'Naviera maritime quote request v2 with PostgreSQL requirements';
    const planRec2 = pStore.saveSourcePlan({
      projectId: project.id,
      sourceText: missionText2,
      status: 'submitted',
    });

    assert.strictEqual(planRec2.revision, 2);
    assert.strictEqual(planRec2.sourceText, missionText2);

    // Retrieve latest source plan
    const latest = pStore.getLatestSourcePlan(project.id);
    assert.ok(latest, 'Latest source plan must exist');
    assert.strictEqual(latest.revision, 2);
    assert.strictEqual(latest.sourceText, missionText2);

    // List all plan revisions
    const history = pStore.listSourcePlans(project.id);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].revision, 2); // Ordered DESC
    assert.strictEqual(history[1].revision, 1);

    console.log('✔ [PASS] Source plan revisions persisted and retrieved with exact text');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Test 4: Switching projects during plan retrieval returns isolated data
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-test-plan-iso-'));
  const tmpDb2 = path.join(tmpDir2, 'test.db');
  try {
    const store = new TaskStore(tmpDb2);
    const pStore = new ProjectStore(store);

    const projA = pStore.createProject({ name: 'Project A', actor: 'test' });
    const projB = pStore.createProject({ name: 'Project B', actor: 'test' });

    pStore.saveSourcePlan({ projectId: projA.id, sourceText: 'Plan for Project A' });
    pStore.saveSourcePlan({ projectId: projB.id, sourceText: 'Plan for Project B' });

    const planA = pStore.getLatestSourcePlan(projA.id);
    const planB = pStore.getLatestSourcePlan(projB.id);

    assert.strictEqual(planA?.sourceText, 'Plan for Project A');
    assert.strictEqual(planB?.sourceText, 'Plan for Project B');
    assert.notStrictEqual(planA?.id, planB?.id);

    console.log('✔ [PASS] Source plans strictly isolated between projects');
  } finally {
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  }

  // Test 5: Malformed JSON output produces explicit PLAN_PARSING_FAILED (never falls back)
  process.env.GEMINI_API_KEY = 'mock-key-for-test';
  const { setGeminiClientForTesting } = await import('../src/server/gemini.ts');

  // Inject a mock generator that returns non-JSON
  setGeminiClientForTesting({
    models: {
      generateContent: async () => ({ text: 'This is not valid JSON string at all!' }),
    },
  });

  try {
    let errorThrown: any = null;
    try {
      await parsePlan('Some plan text', []);
    } catch (err: any) {
      errorThrown = err;
    }
    assert.ok(errorThrown, 'parsePlan must throw on malformed JSON');
    assert.strictEqual(errorThrown.code, 'PLAN_PARSING_FAILED');
    assert.strictEqual(errorThrown.httpStatus, 502);
    console.log('✔ [PASS] Malformed JSON from model throws 502 PLAN_PARSING_FAILED');
  } finally {
    setGeminiClientForTesting(null);
    delete process.env.GEMINI_API_KEY;
  }

  // Test 6: Schema-invalid output (e.g. missing tasks) produces explicit 422 PLAN_PARSING_FAILED
  process.env.GEMINI_API_KEY = 'mock-key-for-test';
  setGeminiClientForTesting({
    models: {
      generateContent: async () => ({
        text: JSON.stringify({ summary: 'No tasks or epics here!' }),
      }),
    },
  });

  try {
    let errorThrown: any = null;
    try {
      await parsePlan('Some plan text', []);
    } catch (err: any) {
      errorThrown = err;
    }
    assert.ok(errorThrown, 'parsePlan must throw on schema-invalid output');
    assert.strictEqual(errorThrown.code, 'PLAN_PARSING_FAILED');
    assert.strictEqual(errorThrown.httpStatus, 422);
    console.log('✔ [PASS] Schema-invalid structure from model throws 422 PLAN_PARSING_FAILED');
  } finally {
    setGeminiClientForTesting(null);
    delete process.env.GEMINI_API_KEY;
  }
});
