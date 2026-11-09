import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config();

// Ensure gh uses keyring if ambient GITHUB_TOKEN is invalid
if (process.env.GITHUB_TOKEN && !process.env.GITHUB_TOKEN.startsWith('gho_') && !process.env.GITHUB_TOKEN.startsWith('ghp_')) {
  delete process.env.GITHUB_TOKEN;
}
delete process.env.GH_TOKEN;

import { TaskStore } from '../src/server/db/database.js';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.js';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.js';
import { RepairCoordinator } from '../src/server/coordinator/repairCoordinator.js';
import { resolveCodingWorker } from '../src/server/worker/workerRegistry.js';
import { GitHubDeliveryService } from '../src/server/delivery/githubDelivery.js';

async function runLiveParityDemo() {
  console.log('===============================================================');
  console.log('=== DUPOND PROVIDER PARITY DEMONSTRATION (GEMINI & OPENAI) ===');
  console.log('===============================================================\n');

  const demoRepoDir = '/Users/mac/ops/repos/dupond-live-demo';
  if (!fs.existsSync(demoRepoDir)) {
    console.error(`Demo repository not found at ${demoRepoDir}`);
    process.exit(1);
  }

  const baseCommit = execFileSync('git', ['rev-parse', 'main'], { cwd: demoRepoDir, encoding: 'utf-8' }).trim();
  console.log(`[Target Repository] marcelodevops/dupond-live-demo`);
  console.log(`[Local Path] ${demoRepoDir}`);
  console.log(`[Base Revision] ${baseCommit}\n`);

  const store = new TaskStore(':memory:');
  const wsManager = new WorkspaceManager(demoRepoDir);
  const verifier = new AuthoritativeVerifier();
  const coordinator = new RepairCoordinator(store, wsManager, verifier);

  // --------------------------------------------------------------------------
  // Run 1: OpenAI Coding Worker (Live Attempt)
  // --------------------------------------------------------------------------
  console.log('---------------------------------------------------------------');
  console.log('=== RUN 1: OPENAI CODING WORKER (gpt-4o-mini) ===');
  console.log('---------------------------------------------------------------');

  const openAiTaskId = `task-live-openai-${Date.now()}`;
  const openAiTask = store.createTask({
    id: openAiTaskId,
    key: 'AEG-701-OPENAI',
    title: 'Implement percentageOf calculation utility',
    description: 'Implement percentageOf(value, percentage) in src/math.js to pass acceptance tests in test/percentageOf.test.js without altering protected files.',
    status: 'todo',
    priority: 'high',
    targetRepo: 'marcelodevops/dupond-live-demo',
    targetRepoPath: demoRepoDir,
    baseCommit,
    allowedPaths: ['src/**'],
    protectedPaths: ['test/**', 'package.json', '.github/**'],
    verificationCommands: [
      { command: 'node --test test/math.test.js', criteriaIds: ['c1'] },
      { command: 'node --test test/percentageOf.test.js', criteriaIds: ['c2'] },
    ],
    acceptanceCriteria: [
      { id: 'c1', title: 'Existing clamp tests pass', completed: false },
      { id: 'c2', title: 'percentageOf passes all acceptance assertions', completed: false },
    ],
    workerConfig: {
      provider: 'openai',
      model: 'gpt-4o-mini',
    },
    maxAttempts: 2,
    timeoutSeconds: 300,
    requireApproval: true,
  });

  const openAiWorker = resolveCodingWorker(openAiTask.workerConfig, verifier.getSandbox());
  console.log(`Resolved worker: ${openAiWorker.name} [provider: ${openAiWorker.provider}, model: ${openAiWorker.model}]`);

  const openAiRun = await coordinator.executeTaskRun({
    task: openAiTask,
    worker: openAiWorker,
    workspaceManager: wsManager,
  });

  console.log(`[OpenAI Run ID] ${openAiRun.id}`);
  console.log(`[OpenAI Status] ${openAiRun.status}`);
  console.log(`[OpenAI Current Attempt] ${openAiRun.currentAttempt}`);
  console.log(`[OpenAI Failure Reason] ${openAiRun.failureReason || 'None'}`);

  const openAiAttempts = store.listAttempts(openAiRun.id);
  console.log(`[OpenAI Attempt Count] ${openAiAttempts.length}`);
  if (openAiAttempts.length > 0) {
    const a = openAiAttempts[0];
    console.log(`  - Attempt 1: ${a.workerType} | Status: ${a.status} | Duration: ${a.durationMs}ms`);
    console.log(`  - Error: ${a.errorMessage}`);
  }

  // --------------------------------------------------------------------------
  // Run 2: Gemini Coding Worker (Live Attempt)
  // --------------------------------------------------------------------------
  console.log('\n---------------------------------------------------------------');
  console.log('=== RUN 2: GOOGLE GEMINI CODING WORKER (gemini-3.5-flash) ===');
  console.log('---------------------------------------------------------------');

  const geminiTaskId = `task-live-gemini-${Date.now()}`;
  const geminiTask = store.createTask({
    id: geminiTaskId,
    key: 'AEG-702-GEMINI',
    title: 'Implement percentageOf calculation utility',
    description: 'Implement percentageOf(value, percentage) in src/math.js to pass acceptance tests in test/percentageOf.test.js without altering protected files.',
    status: 'todo',
    priority: 'high',
    targetRepo: 'marcelodevops/dupond-live-demo',
    targetRepoPath: demoRepoDir,
    baseCommit,
    allowedPaths: ['src/**'],
    protectedPaths: ['test/**', 'package.json', '.github/**'],
    verificationCommands: [
      { command: 'node --test test/math.test.js', criteriaIds: ['c1'] },
      { command: 'node --test test/percentageOf.test.js', criteriaIds: ['c2'] },
    ],
    acceptanceCriteria: [
      { id: 'c1', title: 'Existing clamp tests pass', completed: false },
      { id: 'c2', title: 'percentageOf passes all acceptance assertions', completed: false },
    ],
    workerConfig: {
      provider: 'gemini',
      model: 'gemini-3.5-flash',
    },
    maxAttempts: 2,
    timeoutSeconds: 300,
    requireApproval: true,
  });

  const geminiWorker = resolveCodingWorker(geminiTask.workerConfig, verifier.getSandbox());
  console.log(`Resolved worker: ${geminiWorker.name} [provider: ${geminiWorker.provider}, model: ${geminiWorker.model}]`);

  const geminiRun = await coordinator.executeTaskRun({
    task: geminiTask,
    worker: geminiWorker,
    workspaceManager: wsManager,
  });

  console.log(`[Gemini Run ID] ${geminiRun.id}`);
  console.log(`[Gemini Status] ${geminiRun.status}`);
  console.log(`[Gemini Current Attempt] ${geminiRun.currentAttempt}`);
  console.log(`[Gemini Target Branch] ${geminiRun.targetBranch}`);
  console.log(`[Gemini Failure Reason] ${geminiRun.failureReason || 'None'}`);

  const geminiAttempts = store.listAttempts(geminiRun.id);
  console.log(`[Gemini Attempt Count] ${geminiAttempts.length}`);
  for (const a of geminiAttempts) {
    console.log(`  - Attempt ${a.attemptNumber}: ${a.workerType} | Status: ${a.status} | Duration: ${a.durationMs}ms`);
    console.log(`  - Tokens: prompt=${a.tokenUsage?.promptTokens}, completion=${a.tokenUsage?.completionTokens}`);
    console.log(`  - Files Modified: ${a.filesModified.join(', ')}`);
  }

  const v = store.getLatestVerification(geminiRun.id);
  if (v) {
    console.log(`[Gemini Verification Passed] ${v.passed}`);
    console.log(`[Gemini Verified Revision] ${v.revisionSha}`);
    console.log(`[Gemini Criteria Verified] ${v.criteriaVerified.join(', ')}`);
  }

  // Live GitHub Delivery
  console.log('\n--- Delivering Verified Pull Request to marcelodevops/dupond-live-demo ---');
  const deliveryService = new GitHubDeliveryService(store, verifier);
  const deliveryResult = await deliveryService.dispatchDelivery({
    runId: geminiRun.id,
    isApproved: true,
    approvedBy: 'marcelodevops-operator',
    repoUrl: 'marcelodevops/dupond-live-demo',
  });
  console.log(`[Delivery Success] ${deliveryResult.success}`);
  console.log(`[Pull Request URL] ${deliveryResult.prUrl || deliveryResult.deliveryRecord?.prUrl}`);
  console.log(`[Delivered Branch] ${deliveryResult.branch || deliveryResult.deliveryRecord?.branch}`);
  console.log(`[Delivered SHA] ${deliveryResult.deliveredCommit || deliveryResult.deliveryRecord?.deliveredCommit}`);

  console.log('\n===============================================================');
  console.log('=== DEMONSTRATION COMPLETE ===');
  console.log('===============================================================');
}

runLiveParityDemo().catch((err) => {
  console.error('Demonstration runner encountered error:', err);
});
