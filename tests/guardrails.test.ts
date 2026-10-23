/**
 * Aegis Orchestrator - Guardrails & Delivery Fail-Closed Regression Suite
 * 
 * Tests the ACTUAL application delivery and coordinator handlers using
 * isolated temporary disk directories (fs.mkdtempSync).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { coordinator } from '../src/server/coordinator.js';
import { handleRepositoryDispatch, isPathContained } from '../src/server/deliveryHandler.js';
import { calculateAgentLoad } from '../src/services/workloadBalancer.js';

console.log('=== RUNNING AEGIS GUARDRAILS & LIVE DELIVERY REGRESSION SUITE ===\n');

let passedTests = 0;
let totalTests = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      await result;
    }
    passedTests++;
    console.log(`✔ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`✘ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function executeSuite() {
  // Temporary directory fixture for live tests
  const testBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-guardrails-'));

  const aeg104Task = {
    id: 'task-104',
    key: 'AEG-104',
    title: 'Implement AI-Driven Workload Balancing',
    status: 'done' as const,
    subtasks: [
      { id: 'st-10', title: 'Load percentage calculation', completed: true },
      { id: 'st-11', title: 'Gemini optimizer prompt', completed: true },
      { id: 'st-12', title: 'Algorithmic rebalancing', completed: true },
    ],
    dependencies: [],
    deliverables: ['deliverable artifact'],
  };

  // Ensure task exists in coordinator state for delivery verification
  const existingIndex = coordinator.getState().tasks.findIndex((t) => t.key === 'AEG-104');
  if (existingIndex >= 0) {
    coordinator.getState().tasks[existingIndex] = { ...aeg104Task } as any;
  } else {
    coordinator.getState().tasks.push({ ...aeg104Task } as any);
  }

  // --- 1. EVIDENCE MAPPING TESTS ---
  await runTest('Worker execution maps criteria strictly to passing test assertions (rejects unverified subtasks)', async () => {
    const testTask = {
      id: 'task-104',
      key: 'AEG-104',
      title: 'Implement AI-Driven Workload Balancing',
      status: 'in_progress',
      subtasks: [
        { id: 'st-10', title: 'Load calculation', completed: false },
        { id: 'st-11', title: 'Optimizer prompt', completed: false },
        { id: 'st-12', title: 'Rebalancing algorithm', completed: false },
        { id: 'st-fake', title: 'Unverified fictitious criterion', completed: false },
      ],
    };
    const agent = { id: 'agent-arch', name: 'Nexus-7', role: 'Architect' };
    const res = await coordinator.executeWorkerStep(testTask as any, agent as any);

    assert.ok(res.subtasksCompleted.includes('st-10'), 'st-10 must be verified');
    assert.ok(res.subtasksCompleted.includes('st-11'), 'st-11 must be verified');
    assert.ok(res.subtasksCompleted.includes('st-12'), 'st-12 must be verified');
    assert.strictEqual(
      res.subtasksCompleted.includes('st-fake'),
      false,
      'st-fake must NOT be completed without verified evidence'
    );
  });

  await runTest('Unimplemented tasks fail-closed with blocked: true', async () => {
    const unimplTask = {
      id: 'task-999',
      key: 'AEG-999',
      title: 'Unimplemented task',
      status: 'todo',
      subtasks: [],
    };
    const agent = { id: 'agent-be', name: 'Kaelen Dev', role: 'Backend' };

    let blocked = false;
    try {
      await coordinator.executeWorkerStep(unimplTask as any, agent as any);
    } catch (err: any) {
      blocked = err.message.includes('Execution blocked: No capable worker connected');
    }
    assert.strictEqual(blocked, true, 'Unimplemented task must fail closed');
  });

  // --- 2. QUALITY GATE PREREQUISITE TESTS ---
  await runTest('Quality gate rejects Done transition if upstream dependencies are not done', () => {
    const blockedTask = {
      id: 'task-dep-check',
      key: 'AEG-DEP-CHECK',
      title: 'Blocked task',
      status: 'review' as const,
      dependencies: ['task-unmet-upstream'],
      subtasks: [{ id: 's1', title: 'Subtask', completed: true }],
      deliverables: ['artifact'],
    };

    coordinator.getState().tasks.push({
      id: 'task-unmet-upstream',
      key: 'AEG-UPSTREAM',
      title: 'Upstream task',
      status: 'in_progress',
      dependencies: [],
      subtasks: [],
    } as any);

    const verification = coordinator.verifyTaskQualityGates(blockedTask as any);
    assert.strictEqual(verification.passed, false, 'Must fail when dependency is in_progress');
  });

  // --- 3. ACTUAL DELIVERY HANDLER TESTS (LIVE DISPATCH & TEMP DIRS) ---
  await runTest('Actual delivery handler rejects Git branch delivery fail-closed (HTTP 403, blocked: true)', async () => {
    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        localWriteMode: 'git_branch',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 403, 'Must return HTTP 403 for disabled git_branch');
    assert.strictEqual(res.body.blocked, true, 'Must return blocked: true');
    assert.ok(res.body.error.includes('Git branch delivery is currently disabled'));
  });

  await runTest('Actual delivery handler rejects remote Git PR delivery fail-closed (HTTP 403, blocked: true)', async () => {
    const res = await handleRepositoryDispatch({
      action: 'create_pr',
      repoConfig: {
        type: 'remote_git',
        repoUrl: 'https://github.com/acme/app',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 403, 'Must return HTTP 403 for disabled remote Git delivery');
    assert.strictEqual(res.body.blocked, true, 'Must return blocked: true');
    assert.ok(res.body.error.includes('Remote Git delivery is currently disabled'));
  });

  await runTest('Actual delivery handler blocks prefix-based path traversal (/tmp/project-other prefix attack)', async () => {
    // Sibling directory trap: target starts with base path prefix, but is outside base directory
    const siblingDir = testBaseDir + '-other';

    // Verify helper calculation
    assert.strictEqual(isPathContained(testBaseDir, siblingDir), false, 'Prefix match must not count as contained');

    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        targetDirectory: '../' + path.basename(testBaseDir) + '-other',
        localWriteMode: 'patch_export',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 400, 'Must return HTTP 400 for path traversal');
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('Path traversal outside destination directory is forbidden'));
    assert.strictEqual(fs.existsSync(siblingDir), false, 'Must not create or write into sibling directory');
  });

  await runTest('Actual delivery handler blocks symlink path traversal escaping destination directory', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-outside-'));
    const symlinkPath = path.join(testBaseDir, 'escape_link');

    try {
      fs.symlinkSync(outsideDir, symlinkPath, 'dir');
    } catch {}

    if (fs.existsSync(symlinkPath)) {
      assert.strictEqual(isPathContained(testBaseDir, path.join(symlinkPath, 'target_file')), false, 'Symlink outside must not be contained');

      const res = await handleRepositoryDispatch({
        action: 'deliver',
        repoConfig: {
          type: 'local_directory',
          localPath: testBaseDir,
          targetDirectory: 'escape_link/sub',
          localWriteMode: 'patch_export',
        },
        task: aeg104Task,
      });

      assert.strictEqual(res.status, 400, 'Must reject symlink traversal with HTTP 400');
      assert.strictEqual(res.body.blocked, true);
    }
  });

  await runTest('Actual delivery handler protects existing destination files from direct overwrite (HTTP 409, blocked: true)', async () => {
    const directDestDir = path.join(testBaseDir, 'existing_protect');
    fs.mkdirSync(directDestDir, { recursive: true });
    const targetFile = path.join(directDestDir, 'AEG-104_Service.js');
    const originalContent = '// DO NOT OVERWRITE - PREVIOUS CODEBASE IMPLEMENTATION';
    fs.writeFileSync(targetFile, originalContent, 'utf-8');

    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        targetDirectory: 'existing_protect',
        localWriteMode: 'direct_write',
      },
      task: aeg104Task,
      allowOverwrite: false,
    });

    assert.strictEqual(res.status, 409, 'Must return HTTP 409 conflict when file already exists');
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('already exists'));

    // Assert file was NOT overwritten
    const contentAfter = fs.readFileSync(targetFile, 'utf-8');
    assert.strictEqual(contentAfter, originalContent, 'Existing file content must remain unchanged');
  });

  await runTest('Actual delivery handler rejects unknown delivery modes fail-closed without fallthrough (HTTP 400)', async () => {
    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        targetDirectory: 'safe_dest',
        localWriteMode: 'arbitrary_mode_unsupported',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 400, 'Must return HTTP 400 for unknown delivery mode');
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('Unknown or unsupported delivery mode'));
    assert.strictEqual(fs.existsSync(path.join(testBaseDir, 'safe_dest/AEG-104_Service.js')), false, 'Must not fall through to direct write');
  });

  await runTest('Actual delivery handler executes safe patch export and creates valid physical patch on disk', async () => {
    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        targetDirectory: 'patches_output',
        localWriteMode: 'patch_export',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 200, 'Must return HTTP 200 for successful patch export');
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.targetFilePath, 'Must return targetFilePath');

    // Verify physical file on disk
    const diskPath = res.body.targetFilePath;
    assert.ok(fs.existsSync(diskPath), `Physical patch file must exist at ${diskPath}`);

    const patchText = fs.readFileSync(diskPath, 'utf-8');
    assert.ok(patchText.startsWith('--- a/patches_output/AEG-104_Service.js'), 'Must contain unified diff source header');
    assert.ok(patchText.includes('+++ b/patches_output/AEG-104_Service.js'), 'Must contain unified diff dest header');
    assert.ok(patchText.includes('@@ -0,0 +1,'), 'Must contain hunk line header');
    assert.ok(patchText.includes('+function calculateAgentLoad'), 'Must contain delivered implementation lines');
  });

  await runTest('Actual delivery handler fails closed when target task is missing from sprint state', async () => {
    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        localWriteMode: 'patch_export',
      },
      task: { key: 'AEG-NONEXISTENT' },
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('not found in sprint state'));
  });

  await runTest('Actual delivery handler fails closed when task quality gates have not passed', async () => {
    const unaccepted = {
      id: 'task-unaccepted-deliv',
      key: 'AEG-UNACC',
      title: 'Unaccepted task',
      status: 'todo' as const,
      dependencies: [],
      subtasks: [{ id: 'u1', title: 'Incomplete subtask', completed: false }],
      deliverables: [],
    };
    coordinator.getState().tasks.push(unaccepted as any);

    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        localWriteMode: 'patch_export',
      },
      task: unaccepted,
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('failed quality gate acceptance'));
  });

  // Clean up fixture
  try {
    fs.rmSync(testBaseDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n=== REGRESSION SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED CLEANLY ===`);
}

executeSuite().catch((e) => {
  console.error(e);
  process.exit(1);
});
