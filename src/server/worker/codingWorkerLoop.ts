import fs from 'fs';
import { execFileSync } from 'node:child_process';
import {
  ModelProviderAdapter,
  WorkerExecutionContext,
  WorkerExecutionResult,
} from './types.js';
import { executeWorkspaceTool } from './tools.js';
import { SandboxExecutor } from '../sandbox/sandboxExecutor.js';

export interface CodingWorkerLoopOptions {
  maxTurns?: number;
}

/**
 * Shared coding worker conversation and tool execution loop.
 * Orchestrates multi-turn model communication, tool dispatch, execution budgets,
 * timeout deadlines, cancellation, and git diff collation in a provider-agnostic manner.
 */
export async function runCodingWorkerLoop(
  provider: ModelProviderAdapter,
  context: WorkerExecutionContext,
  sandbox: SandboxExecutor,
  options: CodingWorkerLoopOptions = {}
): Promise<WorkerExecutionResult> {
  const startTime = Date.now();
  const maxTurns = options.maxTurns || 12;
  const timeoutMs = context.timeoutMs || 300000;
  const deadline = startTime + timeoutMs;

  const logs: string[] = [];
  const log = (msg: string) => {
    logs.push(`[${new Date().toISOString()}] ${msg}`);
  };

  log(`Starting coding worker loop [provider: ${provider.provider}, model: ${provider.model}] for task ${context.taskKey} (Attempt ${context.attemptNumber})`);

  if (context.abortSignal?.aborted) {
    return {
      success: false,
      filesModified: [],
      diff: '',
      commitMessage: '',
      logs,
      durationMs: Date.now() - startTime,
      errorMessage: 'Worker execution cancelled by user',
    };
  }

  const realWorktree = fs.realpathSync(context.worktreePath);

  // 1. Construct system prompt with explicit criteria, boundaries, and repair feedback
  let prompt = `You are an expert autonomous software engineer working on task ${context.taskKey}.
Task Title: ${context.taskTitle}
Description:
${context.taskDescription}

Explicit Acceptance Criteria:
${context.acceptanceCriteria.map((c) => `- [${c.id}] ${c.title}`).join('\n')}

Allowed change scope: ${context.allowedPaths.join(', ') || 'Any non-protected repository file'}
Protected paths (DO NOT MODIFY): ${context.protectedPaths.join(', ')}

Your instructions:
1. First, inspect the repository files using list_files or read_file to understand existing structure.
2. Modify or implement the necessary code files using write_file to fulfill all acceptance criteria.
3. Run permitted build/test commands via run_permitted_command to authoritatively verify your implementation before completing.
4. When done, output a summary of changes and a concise commit message.
`;

  if (context.repairFeedback) {
    prompt += `\nATTENTION: A PREVIOUS ATTEMPT FAILED VERIFICATION. Please review this feedback and repair the code:
Failing Command: ${context.repairFeedback.failingCommand || 'Verification command'}
Exit Code: ${context.repairFeedback.exitCode ?? 'N/A'}
Error Output / Stderr:
${context.repairFeedback.stderr || 'No stderr'}
Standard Output:
${context.repairFeedback.stdout || 'No stdout'}
${context.repairFeedback.unmetCriteria?.length ? `Unmet Criteria: ${context.repairFeedback.unmetCriteria.join(', ')}` : ''}
Address the failure directly and verify your fix.
`;
  }

  const conversationHistory = provider.initConversation(prompt);

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let turns = 0;

  try {
    while (turns < maxTurns) {
      if (Date.now() >= deadline) {
        throw new Error(`Worker execution wall-clock deadline exceeded (${timeoutMs}ms)`);
      }
      if (context.abortSignal?.aborted) {
        throw new Error('Worker execution cancelled by user');
      }

      turns++;
      log(`Worker turn ${turns}/${maxTurns}`);

      const turnResult = await provider.generateTurn({
        systemPrompt: prompt,
        conversationHistory,
        abortSignal: context.abortSignal,
      });

      if (turnResult.tokenUsage) {
        totalPromptTokens += turnResult.tokenUsage.promptTokens || 0;
        totalCompletionTokens += turnResult.tokenUsage.completionTokens || 0;
      }

      provider.appendModelResponse(conversationHistory, turnResult);

      const toolCalls = turnResult.toolCalls;
      if (!toolCalls || toolCalls.length === 0) {
        log('Model completed tool calls');
        break;
      }

      // Execute all tool calls for this turn
      const toolResults: Array<{ callId?: string; toolName: string; result: any }> = [];
      for (const call of toolCalls) {
        if (context.abortSignal?.aborted) {
          throw new Error('Worker execution cancelled by user');
        }
        if (Date.now() >= deadline) {
          throw new Error(`Worker execution wall-clock deadline exceeded (${timeoutMs}ms)`);
        }

        const result = await executeWorkspaceTool(context, call.name, call.arguments, sandbox, log);
        toolResults.push({
          callId: call.id,
          toolName: call.name,
          result,
        });
      }

      // Append completed tool results to conversation history
      provider.appendToolResults(conversationHistory, toolResults);
    }
  } catch (err: any) {
    log(`Worker loop terminated with error: ${err.message}`);
    return {
      success: false,
      filesModified: [],
      diff: '',
      commitMessage: '',
      logs,
      durationMs: Date.now() - startTime,
      errorMessage: `Model execution failed: ${err.message}`,
    };
  }

  // Authoritatively inspect git status and diff from workspace
  let diff = '';
  let filesModified: string[] = [];
  try {
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: realWorktree,
      encoding: 'utf-8',
    });

    if (statusOutput.trim()) {
      filesModified = statusOutput
        .split('\n')
        .map((line) => {
          const match = line.match(/^..\s+(.*)$/);
          return match ? match[1].trim() : '';
        })
        .filter(Boolean);

      diff = execFileSync('git', ['diff', 'HEAD'], {
        cwd: realWorktree,
        encoding: 'utf-8',
      });
    }
  } catch (err: any) {
    log(`Failed to gather git status/diff: ${err.message}`);
  }

  const durationMs = Date.now() - startTime;
  log(`Worker loop finished in ${durationMs}ms with ${filesModified.length} files modified`);

  return {
    success: filesModified.length > 0 || turns > 0,
    filesModified,
    diff,
    commitMessage: `feat(${context.taskKey}): implement ${context.taskTitle}`,
    logs,
    tokenUsage: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
    },
    durationMs,
  };
}
