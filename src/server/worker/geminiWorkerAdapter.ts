import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { GoogleGenAI } from '@google/genai';
import {
  CodingWorkerAdapter,
  WorkerExecutionContext,
  WorkerExecutionResult,
} from './types.js';
import { SandboxExecutor, defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';

export class GeminiCodingWorkerAdapter implements CodingWorkerAdapter {
  readonly name = 'gemini_coding_worker';
  private sandbox: SandboxExecutor;

  constructor(sandbox: SandboxExecutor = defaultSandboxExecutor) {
    this.sandbox = sandbox;
  }

  public async isAvailable(): Promise<{ available: boolean; error?: string }> {
    const key = process.env.GEMINI_API_KEY;
    if (!key || !key.trim()) {
      return {
        available: false,
        error: 'Prerequisite missing: GEMINI_API_KEY is not set in environment or .env. A valid Gemini API key is required for the coding worker.',
      };
    }
    const sandboxAvail = this.sandbox.isAvailable();
    if (!sandboxAvail.available) {
      return {
        available: false,
        error: `Prerequisite missing: Execution sandbox unavailable: ${sandboxAvail.error}`,
      };
    }
    return { available: true };
  }

  public async execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    const avail = await this.isAvailable();
    if (!avail.available) {
      throw new Error(`Worker execution blocked: ${avail.error}`);
    }

    const startTime = Date.now();
    const logs: string[] = [];
    const log = (msg: string) => {
      logs.push(`[${new Date().toISOString()}] ${msg}`);
    };

    log(`Starting coding worker execution for task ${context.taskKey} (Attempt ${context.attemptNumber})`);

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY!.trim(),
      httpOptions: {
        headers: {
          'User-Agent': 'dupond-coding-worker',
        },
      },
    });

    const realWorktree = fs.realpathSync(context.worktreePath);

    // Helper: validate and resolve safe paths
    const resolveSafePath = (relPath: string): { fullPath: string; isSafe: boolean; isProtected: boolean; isAllowed: boolean } => {
      const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.resolve(realWorktree, normalized);
      const isContained = fullPath.startsWith(realWorktree);

      // Check protected paths
      const relToWorktree = path.relative(realWorktree, fullPath);
      const isProtected = (context.protectedPaths || []).some((pattern) => {
        const clean = pattern.replace(/\*\*?$/, '');
        return relToWorktree.startsWith(clean) || relToWorktree === clean;
      }) || relToWorktree.startsWith('.git') || relToWorktree === '.git';

      // Check allowed paths
      const isAllowed = (!context.allowedPaths || context.allowedPaths.length === 0) ||
        context.allowedPaths.some((pattern) => {
          if (pattern === '*' || pattern === '**') return true;
          const clean = pattern.replace(/\*\*?$/, '');
          return relToWorktree.startsWith(clean) || relToWorktree === clean;
        });

      return {
        fullPath,
        isSafe: isContained,
        isProtected,
        isAllowed,
      };
    };

    // Tool Implementations
    const handleToolCall = async (name: string, args: Record<string, any>): Promise<any> => {
      log(`Tool call invoked: ${name}(${JSON.stringify(args)})`);

      if (name === 'list_files') {
        const targetDir = args.directory ? resolveSafePath(args.directory).fullPath : realWorktree;
        if (!targetDir.startsWith(realWorktree) || !fs.existsSync(targetDir)) {
          return { error: `Directory not found or escapes workspace: ${args.directory}` };
        }
        const entries = fs.readdirSync(targetDir, { withFileTypes: true })
          .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
          .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        return { directory: path.relative(realWorktree, targetDir) || '.', entries };
      }

      if (name === 'read_file') {
        const { fullPath, isSafe } = resolveSafePath(args.filePath);
        if (!isSafe || !fs.existsSync(fullPath)) {
          return { error: `File not found or outside workspace: ${args.filePath}` };
        }
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          return { filePath: args.filePath, content };
        } catch (err: any) {
          return { error: `Failed to read file: ${err.message}` };
        }
      }

      if (name === 'write_file') {
        const { fullPath, isSafe, isProtected, isAllowed } = resolveSafePath(args.filePath);
        if (!isSafe) {
          return { error: `Path traversal rejected: ${args.filePath}` };
        }
        if (isProtected) {
          return { error: `Write rejected: ${args.filePath} is a protected path (e.g. test criteria or git metadata) and cannot be modified by the worker.` };
        }
        if (!isAllowed) {
          return { error: `Write rejected: ${args.filePath} is outside the allowed change scope for this task.` };
        }
        try {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, args.content, 'utf-8');
          log(`File written successfully: ${args.filePath} (${Buffer.byteLength(args.content, 'utf-8')} bytes)`);
          return { filePath: args.filePath, written: true, bytes: Buffer.byteLength(args.content, 'utf-8') };
        } catch (err: any) {
          return { error: `Failed to write file: ${err.message}` };
        }
      }

      if (name === 'run_permitted_command') {
        const cmd = args.command;
        // Permitted commands: testing, compilation, linting, git diff
        const allowedBinaries = ['npm', 'npx', 'git', 'node', 'tsc', 'echo', 'ls', 'cat'];
        const firstToken = cmd.trim().split(/\s+/)[0];
        if (!allowedBinaries.includes(firstToken)) {
          return { error: `Command "${firstToken}" is not in the permitted sandbox command allowlist (${allowedBinaries.join(', ')}).` };
        }

        const res = await this.sandbox.execute({
          worktreePath: realWorktree,
          command: cmd,
          timeoutMs: args.timeoutMs || 30000,
        });

        log(`Command "${cmd}" finished with exit code ${res.exitCode}`);
        return {
          command: cmd,
          exitCode: res.exitCode,
          stdout: res.stdout.slice(0, 4000), // bounded size
          stderr: res.stderr.slice(0, 4000),
          durationMs: res.durationMs,
        };
      }

      return { error: `Unknown tool: ${name}` };
    };

    // Tool declarations for Gemini
    const toolDeclarations = [
      {
        name: 'list_files',
        description: 'List files in a repository directory relative to workspace root.',
        parameters: {
          type: 'OBJECT',
          properties: {
            directory: { type: 'STRING', description: 'Relative directory path to list. Omit or pass "" for root.' },
          },
        },
      },
      {
        name: 'read_file',
        description: 'Read the text content of a file in the workspace.',
        parameters: {
          type: 'OBJECT',
          properties: {
            filePath: { type: 'STRING', description: 'Path to file relative to repository root.' },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'write_file',
        description: 'Write or overwrite text content to a file in the workspace.',
        parameters: {
          type: 'OBJECT',
          properties: {
            filePath: { type: 'STRING', description: 'Relative path to file.' },
            content: { type: 'STRING', description: 'Full UTF-8 text content to write.' },
          },
          required: ['filePath', 'content'],
        },
      },
      {
        name: 'run_permitted_command',
        description: 'Run a permitted build or test command in the isolated workspace (e.g., npm test, git status, npx tsx ...).',
        parameters: {
          type: 'OBJECT',
          properties: {
            command: { type: 'STRING', description: 'Command line string to execute.' },
          },
          required: ['command'],
        },
      },
    ];

    // Build the initial prompt
    let prompt = `You are an expert autonomous software engineer working on task ${context.taskKey}.
Task Title: ${context.taskTitle}
Description:
${context.taskDescription}

Explicit Acceptance Criteria:
${context.acceptanceCriteria.map((c) => `- [${c.id}] ${c.title}`).join('\n')}

Allowed change scope: ${context.allowedPaths.join(', ') || 'Any non-protected repository file'}
Protected paths (DO NOT MODIFY): ${context.protectedPaths.join(', ')}

Your instructions:
1. First, inspect the repository files to understand existing structure.
2. Modify or implement the necessary code files to fulfill all acceptance criteria.
3. Run permitted build/test commands to verify your implementation before completing.
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

    const conversationContents: any[] = [
      { role: 'user', parts: [{ text: prompt }] },
    ];

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let iterations = 0;
    const maxIterations = 12;

    try {
      while (iterations < maxIterations) {
        iterations++;
        log(`Worker iteration ${iterations}/${maxIterations}`);

        const response: any = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: conversationContents,
          config: {
            tools: [{ functionDeclarations: toolDeclarations as any }],
            temperature: 0.2,
          },
        });

        if (response.usageMetadata) {
          totalPromptTokens += response.usageMetadata.promptTokenCount || 0;
          totalCompletionTokens += response.usageMetadata.candidatesTokenCount || 0;
        }

        const candidate = response.candidates?.[0];
        if (!candidate || !candidate.content) {
          log('Empty response from model candidate');
          break;
        }

        conversationContents.push(candidate.content);

        // Check for function calls
        const functionCalls = candidate.content.parts?.filter((p: any) => p.functionCall);
        if (!functionCalls || functionCalls.length === 0) {
          // Model completed its thoughts and finished
          log('Model completed tool calls');
          break;
        }

        // Execute function calls
        const functionResponseParts: any[] = [];
        for (const part of functionCalls) {
          const call = part.functionCall;
          const result = await handleToolCall(call.name, call.args || {});
          functionResponseParts.push({
            functionResponse: {
              name: call.name,
              response: { result },
            },
          });
        }

        conversationContents.push({
          role: 'user',
          parts: functionResponseParts,
        });
      }
    } catch (err: any) {
      log(`Worker model call failed: ${err.message}`);
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

    // Inspect git status in worktree to gather modified files and unified diff
    let diff = '';
    let filesModified: string[] = [];
    try {
      const statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd: realWorktree,
        encoding: 'utf-8',
      }).trim();

      if (statusOutput) {
        filesModified = statusOutput
          .split('\n')
          .map((line) => line.slice(3).trim())
          .filter(Boolean);

        diff = execFileSync('git', ['diff', 'HEAD'], {
          cwd: realWorktree,
          encoding: 'utf-8',
        });
      }
    } catch (err: any) {
      log(`Failed to gather git diff: ${err.message}`);
    }

    const durationMs = Date.now() - startTime;
    log(`Worker execution finished in ${durationMs}ms with ${filesModified.length} files modified`);

    return {
      success: filesModified.length > 0 || iterations > 0,
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
}

export const defaultCodingWorker = new GeminiCodingWorkerAdapter();
