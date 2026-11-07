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

  public resolveSafePath(
    realWorktree: string,
    relPath: string,
    context: { allowedPaths?: string[]; protectedPaths?: string[] }
  ): { fullPath: string; isSafe: boolean; isProtected: boolean; isAllowed: boolean; error?: string } {
    const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.resolve(realWorktree, normalized);
    
    // Lexical check
    if (!fullPath.startsWith(realWorktree + path.sep) && fullPath !== realWorktree) {
      return { fullPath, isSafe: false, isProtected: false, isAllowed: false, error: 'Path traversal: lexical escape' };
    }

    // Realpath ancestor verification: ensure no intermediate symlink escapes worktree
    let currentCheck = fullPath;
    while (!fs.existsSync(currentCheck) && currentCheck !== path.dirname(currentCheck)) {
      currentCheck = path.dirname(currentCheck);
    }

    if (fs.existsSync(currentCheck)) {
      try {
        const realAncestor = fs.realpathSync(currentCheck);
        if (!realAncestor.startsWith(realWorktree + path.sep) && realAncestor !== realWorktree) {
          return { fullPath, isSafe: false, isProtected: false, isAllowed: false, error: 'Symlink traversal: intermediate directory escapes workspace' };
        }
      } catch (e: any) {
        return { fullPath, isSafe: false, isProtected: false, isAllowed: false, error: `Realpath resolution failed: ${e.message}` };
      }
    }

    // If target file itself exists, check realpath
    if (fs.existsSync(fullPath)) {
      try {
        const realTarget = fs.realpathSync(fullPath);
        if (!realTarget.startsWith(realWorktree + path.sep) && realTarget !== realWorktree) {
          return { fullPath, isSafe: false, isProtected: false, isAllowed: false, error: 'Symlink escape: target file points outside workspace' };
        }
      } catch (e: any) {
        return { fullPath, isSafe: false, isProtected: false, isAllowed: false, error: `Realpath failed: ${e.message}` };
      }
    }

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
      isSafe: true,
      isProtected,
      isAllowed,
    };
  }

  public async executeTool(
    context: WorkerExecutionContext,
    name: string,
    args: Record<string, any>,
    log: (msg: string) => void = () => {}
  ): Promise<any> {
    const realWorktree = fs.realpathSync(context.worktreePath);
    log(`Tool call invoked: ${name}(${JSON.stringify(args)})`);

    if (name === 'list_files') {
      const targetDir = args.directory ? this.resolveSafePath(realWorktree, args.directory, context).fullPath : realWorktree;
      if (!targetDir.startsWith(realWorktree) || !fs.existsSync(targetDir)) {
        return { error: `Directory not found or escapes workspace: ${args.directory}` };
      }
      const entries = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
      return { directory: path.relative(realWorktree, targetDir) || '.', entries };
    }

    if (name === 'read_file') {
      const check = this.resolveSafePath(realWorktree, args.filePath, context);
      if (!check.isSafe) {
        return { error: check.error || `File access blocked: ${args.filePath}` };
      }
      if (!fs.existsSync(check.fullPath)) {
        return { error: `File not found: ${args.filePath}` };
      }
      try {
        const content = fs.readFileSync(check.fullPath, 'utf-8');
        return { filePath: args.filePath, content };
      } catch (err: any) {
        return { error: `Failed to read file: ${err.message}` };
      }
    }

    if (name === 'write_file') {
      const check = this.resolveSafePath(realWorktree, args.filePath, context);
      if (!check.isSafe) {
        return { error: check.error || `Path traversal rejected: ${args.filePath}` };
      }
      if (check.isProtected) {
        return { error: `Write rejected: ${args.filePath} is a protected path (e.g. test criteria or git metadata) and cannot be modified by the worker.` };
      }
      if (!check.isAllowed) {
        return { error: `Write rejected: ${args.filePath} is outside the allowed change scope for this task.` };
      }
      try {
        fs.mkdirSync(path.dirname(check.fullPath), { recursive: true });
        // Use O_NOFOLLOW to prevent following any symlink during file writing
        let fd: number;
        try {
          fd = fs.openSync(
            check.fullPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW
          );
        } catch (openErr: any) {
          if (openErr.code === 'ELOOP' || openErr.code === 'SYMLINK_LOOP') {
            return { error: `Write blocked: ${args.filePath} is a symlink. Writing to symlinks is forbidden.` };
          }
          throw openErr;
        }
        fs.writeFileSync(fd, args.content, 'utf-8');
        fs.closeSync(fd);
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
        runId: context.runId,
        abortSignal: context.abortSignal,
      });

      // Independent protected paths enforcement: verify command did not tamper with protected paths
      try {
        const changedFiles = execFileSync('git', ['status', '--porcelain'], {
          cwd: realWorktree,
          encoding: 'utf-8',
        })
          .split('\n')
          .map((line) => line.slice(3).trim())
          .filter(Boolean);

        for (const changed of changedFiles) {
          const isProtected = (context.protectedPaths || []).some((p) => {
            const clean = p.replace(/\*\*?$/, '');
            return changed.startsWith(clean) || changed === clean;
          }) || changed.startsWith('.git');

          if (isProtected) {
            // Rollback the protected file modification
            try {
              execFileSync('git', ['checkout', 'HEAD', '--', changed], { cwd: realWorktree, stdio: 'pipe' });
            } catch {
              // if untracked, remove
              fs.rmSync(path.resolve(realWorktree, changed), { force: true, recursive: true });
            }
            return {
              command: cmd,
              exitCode: 1,
              stdout: res.stdout,
              stderr: `Integrity violation: Command modified protected path "${changed}". Modifications were automatically rolled back.`,
              durationMs: res.durationMs,
            };
          }
        }
      } catch (gitErr: any) {
        // ignore status probe error
      }

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
    const handleToolCall = async (name: string, args: Record<string, any>) => {
      return this.executeTool(context, name, args, log);
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
