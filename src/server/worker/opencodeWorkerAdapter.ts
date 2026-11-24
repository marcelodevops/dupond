import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DomainError } from '../utils/errors';
import {
  CodingWorkerAdapter,
  WorkerExecutionContext,
  WorkerExecutionResult,
  WorkerProvider,
} from './types.js';
import { SandboxExecutor, defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';
import { resolveSafePath } from './tools.js';
import { sanitizeGeminiError } from '../gemini.js';
import { sanitizeOpenAIError } from '../openai.js';

export const OPENCODE_SUPPORTED_CLI_VERSION = '2.3.0';
export const DEFAULT_OPENCODE_MODEL = process.env.DUPOND_OPENCODE_MODEL?.trim() || 'github-copilot/gpt-5.3-codex';
export const OPENCODE_MODEL_ID_REGEX = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._:-]+)+(?:#[A-Za-z0-9._-]+)?$/;
const MAX_OUTPUT_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

export interface OpenCodeReadinessStatus {
  available: boolean;
  executablePath: string | null;
  version: string | null;
  models: string[];
  configuredProviders: string[];
  error?: string;
}

export function isValidOpenCodeModelId(model: string): boolean {
  const trimmed = model.trim();
  return trimmed.length > 0 && trimmed.length <= 160 && OPENCODE_MODEL_ID_REGEX.test(trimmed);
}

export function resolveOpenCodeExecutable(): string | null {
  const override = process.env.DUPOND_OPENCODE_BIN?.trim();
  if (override) {
    return fs.existsSync(override) ? override : null;
  }

  const candidatePaths = [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(cmd, ['opencode'], {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    return found && fs.existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

function buildOpenCodeEnv(
  context?: Pick<WorkerExecutionContext, 'allowedPaths' | 'protectedPaths'>,
  options?: { sandboxed?: boolean }
): Record<string, string> {
  const env: Record<string, string> = {};
  const blockedEnvPatterns = [
    /^DUPOND_/i,
    /^GEMINI_API_KEY$/i,
    /^OPENAI_API_KEY$/i,
    /^JIRA_/i,
    /^SLACK_/i,
    /^GH_TOKEN$/i,
    /^ANTHROPIC_ADMIN/i,
    /PASSWORD|SECRET|PRIVATE_KEY/i,
  ];
  const sandboxStrippedKeys = new Set([
    'HOME',
    'TMPDIR',
    'PWD',
    'OLDPWD',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
  ]);
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (blockedEnvPatterns.some((re) => re.test(k))) continue;
    if (options?.sandboxed && sandboxStrippedKeys.has(k)) continue;
    env[k] = v;
  }

  // Always block repository-supplied OpenCode configs, plugins, and custom tools
  env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true';

  if (context) {
    const editRules: Record<string, 'allow' | 'deny'> = context.allowedPaths?.length
      ? { '*': 'deny' }
      : { '*': 'allow' };

    for (const allowed of context.allowedPaths || []) {
      const normalized = allowed.replace(/^\/+/, '').replace(/\/+$/, '');
      if (normalized) {
        editRules[normalized] = 'allow';
        editRules[`${normalized}/**`] = 'allow';
      }
    }

    const readRules: Record<string, 'allow' | 'deny'> = {
      '*': 'allow',
      '.env': 'deny',
      '.env.*': 'deny',
    };

    const alwaysProtected = ['.git/**', '.env', '.env.*', ...(context.protectedPaths || [])];
    for (const prot of alwaysProtected) {
      const normalized = prot.replace(/^\/+/, '').replace(/\/+$/, '');
      if (normalized) {
        editRules[normalized] = 'deny';
        if (!normalized.includes('*')) {
          editRules[`${normalized}/**`] = 'deny';
        }
      }
    }

    for (const prot of context.protectedPaths || []) {
      const normalized = prot.replace(/^\/+/, '').replace(/\/+$/, '');
      if (normalized) {
        readRules[normalized] = 'deny';
        if (!normalized.includes('*')) {
          readRules[`${normalized}/**`] = 'deny';
        }
      }
    }

    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: {},
      plugin: [],
      permission: {
        edit: editRules,
        read: readRules,
        bash: { '*': 'deny' },
        external_directory: 'deny',
      },
    });
  }

  return env;
}

function collectOpenCodeAuthSeedFiles(): Array<{ sourcePath: string; targetRelToHome: string }> {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  const authPath = path.join(dataHome, 'opencode', 'auth.json');
  if (fs.existsSync(authPath) && fs.statSync(authPath).isFile()) {
    return [{ sourcePath: authPath, targetRelToHome: '.local/share/opencode/auth.json' }];
  }
  return [];
}

export function collectExtraReadPaths(binPath: string): string[] {
  const candidates = new Set<string>();
  const addPathAndParent = (p: string) => {
    try {
      const resolved = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
      candidates.add(resolved);
      candidates.add(path.dirname(resolved));
    } catch {
      candidates.add(path.resolve(p));
    }
  };
  addPathAndParent(binPath);
  addPathAndParent(path.resolve(binPath));
  addPathAndParent(process.execPath);
  return Array.from(candidates);
}

export function collectDenyWritePaths(_realWorktree: string, protectedPaths?: string[]): string[] {
  const out: string[] = [];
  for (const p of protectedPaths || []) {
    const clean = p.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean) {
      out.push(clean);
    }
  }
  return out;
}

export function sanitizeWorkerOutput(raw: string): string {
  return sanitizeOpenAIError(sanitizeGeminiError(raw))
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/1\/\/[A-Za-z0-9._-]{10,}/g, '[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{10,}/g, '[REDACTED]');
}

export function probeOpenCodeReadiness(): OpenCodeReadinessStatus {
  const executablePath = resolveOpenCodeExecutable();
  if (!executablePath) {
    return {
      available: false,
      executablePath: null,
      version: null,
      models: [],
      configuredProviders: [],
      error:
        'OpenCode CLI executable not found. Install OpenCode (tested v2.3.0) or set DUPOND_OPENCODE_BIN to the executable path.',
    };
  }

  const probeEnv = buildOpenCodeEnv();
  let version: string | null = null;
  try {
    const verOut = execFileSync(executablePath, ['--version'], {
      env: probeEnv,
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const match = verOut.match(/(\d+\.\d+\.\d+[^\s]*)/);
    version = match ? match[1] : verOut || null;
  } catch (err: any) {
    return {
      available: false,
      executablePath,
      version: null,
      models: [],
      configuredProviders: [],
      error: `Failed to execute OpenCode CLI (--version): ${sanitizeWorkerOutput(err?.message || 'unknown error')}`,
    };
  }

  let models: string[] = [];
  try {
    const modelsOut = execFileSync(executablePath, ['models'], {
      env: probeEnv,
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    models = modelsOut
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && isValidOpenCodeModelId(l));
  } catch {
    models = [];
  }

  let configuredProviders: string[] = [];
  try {
    const authOut = execFileSync(executablePath, ['auth', 'list'], {
      env: probeEnv,
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    configuredProviders = authOut
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^[-=]+$/.test(l) && !/no .*credentials/i.test(l))
      .map((l) => l.split(/\s{2,}/)[0]?.trim() || '')
      .filter(Boolean);
  } catch {
    configuredProviders = [];
  }

  if (models.length === 0 && configuredProviders.length === 0) {
    return {
      available: false,
      executablePath,
      version,
      models: [],
      configuredProviders: [],
      error:
        "OpenCode CLI is installed, but no configured models or provider credentials were found. Run 'opencode auth login' to configure OpenCode.",
    };
  }

  return {
    available: true,
    executablePath,
    version,
    models,
    configuredProviders,
  };
}

interface TreeEntrySnapshot {
  kind: 'file' | 'symlink';
  value: string;
}

interface RepoBaseline {
  headSha: string;
  headRef: string;
  refs: Map<string, string>;
  gitDir: string | null;
  gitMetadata: Map<string, TreeEntrySnapshot>;
  entries: Map<string, TreeEntrySnapshot>;
}

function captureTreeEntries(rootDir: string, skipDirNames: Set<string>): Map<string, TreeEntrySnapshot> {
  const entries = new Map<string, TreeEntrySnapshot>();
  const walk = (dir: string, relPrefix: string) => {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirEntries) {
      if (skipDirNames.has(d.name)) continue;
      const absPath = path.join(dir, d.name);
      const relPath = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      try {
        const lstat = fs.lstatSync(absPath);
        if (lstat.isSymbolicLink()) {
          entries.set(relPath, { kind: 'symlink', value: fs.readlinkSync(absPath) });
        } else if (lstat.isDirectory()) {
          walk(absPath, relPath);
        } else if (lstat.isFile()) {
          const digest = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
          entries.set(relPath, { kind: 'file', value: digest });
        }
      } catch {
        entries.set(relPath, { kind: 'file', value: 'unreadable' });
      }
    }
  };
  walk(rootDir, '');
  return entries;
}

function captureGitState(realWorktree: string): {
  headSha: string;
  headRef: string;
  refs: Map<string, string>;
  gitDir: string | null;
  gitMetadata: Map<string, TreeEntrySnapshot>;
} {
  let headSha = '';
  try {
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: realWorktree, encoding: 'utf-8' }).trim();
  } catch {
    headSha = '';
  }

  let headRef = 'DETACHED';
  try {
    headRef = execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: realWorktree, encoding: 'utf-8' }).trim() || 'DETACHED';
  } catch {
    headRef = 'DETACHED';
  }

  const refs = new Map<string, string>();
  try {
    const refsOut = execFileSync('git', ['for-each-ref', '--format=%(refname)\t%(objectname)'], {
      cwd: realWorktree,
      encoding: 'utf-8',
    });
    for (const line of refsOut.split(/\r?\n/)) {
      if (!line) continue;
      const [refName, sha] = line.split('\t');
      if (refName) refs.set(refName, sha || '');
    }
  } catch {
    // ignore
  }

  let gitDir: string | null = null;
  try {
    const rawGitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: realWorktree, encoding: 'utf-8' }).trim();
    const absGitDir = path.resolve(realWorktree, rawGitDir);
    if (fs.existsSync(absGitDir)) {
      gitDir = fs.realpathSync(absGitDir);
    }
  } catch {
    gitDir = null;
  }

  const gitMetadata = gitDir ? captureTreeEntries(gitDir, new Set()) : new Map<string, TreeEntrySnapshot>();
  return { headSha, headRef, refs, gitDir, gitMetadata };
}

export function captureRepoBaseline(realWorktree: string): RepoBaseline {
  const gitState = captureGitState(realWorktree);
  const entries = captureTreeEntries(realWorktree, new Set(['.git', 'node_modules']));
  return {
    ...gitState,
    entries,
  };
}

function findGitIgnoredPaths(realWorktree: string, candidatePaths: string[]): Set<string> {
  if (candidatePaths.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: realWorktree,
      input: candidatePaths.join('\0') + '\0',
      encoding: 'utf-8',
    });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    // git check-ignore exits with 1 when NO paths are ignored
    return new Set();
  }
}

export function inspectAndVerifyRepoChanges(
  realWorktree: string,
  baseline: RepoBaseline,
  context: Pick<WorkerExecutionContext, 'allowedPaths' | 'protectedPaths'>
): { filesModified: string[]; diff: string; violations: string[] } {
  const afterGit = captureGitState(realWorktree);
  const afterEntries = captureTreeEntries(realWorktree, new Set(['.git', 'node_modules']));
  const violations: string[] = [];

  if (afterGit.headSha !== baseline.headSha) {
    violations.push(`Unauthorized HEAD commit change (${baseline.headSha.slice(0, 8)} -> ${afterGit.headSha.slice(0, 8)})`);
  }
  if (afterGit.headRef !== baseline.headRef) {
    violations.push(`Unauthorized HEAD ref change (${baseline.headRef} -> ${afterGit.headRef})`);
  }

  const allRefNames = new Set([...baseline.refs.keys(), ...afterGit.refs.keys()]);
  for (const refName of allRefNames) {
    if (baseline.refs.get(refName) !== afterGit.refs.get(refName)) {
      if (baseline.headRef !== 'DETACHED' && refName === baseline.headRef) {
        violations.push(`Unauthorized Git ref modification: ${refName}`);
      } else {
        // Shared refs live in the common .git directory across all worktrees;
        // fail closed while acknowledging attribution is unknown without per-worker Git isolation.
        violations.push(
          `Shared Git ref changed concurrently with unknown attribution (worker or external process): ${refName}`
        );
      }
    }
  }

  const allGitMetaKeys = new Set([...baseline.gitMetadata.keys(), ...afterGit.gitMetadata.keys()]);
  for (const key of allGitMetaKeys) {
    const b = baseline.gitMetadata.get(key);
    const a = afterGit.gitMetadata.get(key);
    if (!b || !a || b.kind !== a.kind || b.value !== a.value) {
      violations.push(`Unauthorized Git metadata modification: .git/${key}`);
    }
  }

  const changedPaths = new Set<string>();
  const allEntryPaths = new Set([...baseline.entries.keys(), ...afterEntries.keys()]);
  for (const relPath of allEntryPaths) {
    const b = baseline.entries.get(relPath);
    const a = afterEntries.get(relPath);
    if (!b || !a || b.kind !== a.kind || b.value !== a.value) {
      changedPaths.add(relPath);
      if (a?.kind === 'symlink') {
        violations.push(`Symlink creation or modification is not permitted: "${relPath}"`);
      }
    }
  }

  if (baseline.headSha && afterGit.headSha && baseline.headSha !== afterGit.headSha) {
    try {
      const committedOut = execFileSync(
        'git',
        ['diff', '--name-only', '-z', baseline.headSha, afterGit.headSha],
        { cwd: realWorktree, encoding: 'utf-8' }
      );
      for (const relPath of committedOut.split('\0').filter(Boolean)) {
        changedPaths.add(relPath);
      }
    } catch {
      // ignore
    }
  }

  const filesModified = Array.from(changedPaths).sort();
  const ignoredPaths = findGitIgnoredPaths(realWorktree, filesModified);
  for (const ignored of ignoredPaths) {
    violations.push(`Ignored path modified or created during execution: "${ignored}"`);
  }

  for (const file of filesModified) {
    const resolved = resolveSafePath(realWorktree, file, {
      allowedPaths: context.allowedPaths,
      protectedPaths: context.protectedPaths,
    });
    if (!resolved.isSafe || resolved.isProtected || !resolved.isAllowed) {
      violations.push(
        `Boundary violation on "${file}": ${resolved.error || (resolved.isProtected ? 'protected path' : 'outside allowedPaths')}`
      );
    }
  }

  let diff = '';
  try {
    const baseRef = baseline.headSha || 'HEAD';
    diff = execFileSync('git', ['diff', baseRef], {
      cwd: realWorktree,
      encoding: 'utf-8',
    });
  } catch {
    diff = '';
  }

  return { filesModified, diff, violations };
}

function buildOpenCodePrompt(context: WorkerExecutionContext): string {
  const criteriaText = context.acceptanceCriteria.map((c) => `- [${c.id}] ${c.title}`).join('\n');
  const repairText = context.repairFeedback
    ? `\nPREVIOUS ATTEMPT FAILED VERIFICATION:\nCommand: ${context.repairFeedback.failingCommand || 'N/A'}\nExit Code: ${context.repairFeedback.exitCode ?? 'N/A'}\nStderr:\n${context.repairFeedback.stderr || 'None'}\nStdout:\n${context.repairFeedback.stdout || 'None'}\nUnmet Criteria: ${context.repairFeedback.unmetCriteria?.join(', ') || 'None'}\nFix these failures now.\n`
    : '';
  const reviewFeedbackText =
    context.operatorReviewFeedback && context.operatorReviewFeedback.length > 0
      ? `\nOPERATOR REVIEW FEEDBACK (MUST ADDRESS):\n${context.operatorReviewFeedback
          .map((f) => `- [${f.createdAt}] ${f.actor} (rev ${f.revisionSha.slice(0, 8)}): ${f.comment}`)
          .join('\n')}\n`
      : '';

  return [
    `Implement task ${context.taskKey}: ${context.taskTitle}`,
    `Description: ${context.taskDescription}`,
    `Acceptance Criteria:\n${criteriaText || 'None specified'}`,
    `Allowed paths: ${context.allowedPaths?.length ? context.allowedPaths.join(', ') : 'All workspace files except protected paths'}`,
    `Protected paths (DO NOT MODIFY): ${context.protectedPaths?.length ? context.protectedPaths.join(', ') : 'None'}`,
    repairText,
    reviewFeedbackText,
    'Make the required code and test edits directly inside the current repository worktree, then summarize the changes concisely.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export class OpenCodeCodingWorkerAdapter implements CodingWorkerAdapter {
  readonly name = 'opencode_coding_worker';
  readonly provider: WorkerProvider = 'opencode';
  readonly model: string;
  private sandbox: SandboxExecutor;

  constructor(model: string = DEFAULT_OPENCODE_MODEL, sandbox: SandboxExecutor = defaultSandboxExecutor) {
    this.model = (model || DEFAULT_OPENCODE_MODEL).trim();
    this.sandbox = sandbox;
  }

  public async isAvailable(): Promise<{ available: boolean; error?: string }> {
    const readiness = probeOpenCodeReadiness();
    if (!readiness.available) {
      return { available: false, error: readiness.error };
    }
    if (!isValidOpenCodeModelId(this.model)) {
      return {
        available: false,
        error: `Invalid OpenCode model "${this.model}". Expected format provider/model (for example github-copilot/gpt-5.3-codex).`,
      };
    }
    if (readiness.models.length > 0 && !readiness.models.includes(this.model)) {
      return {
        available: false,
        error: `Selected OpenCode model "${this.model}" is not available in the installed OpenCode setup. Run 'opencode models' to view configured models.`,
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
    const startTime = Date.now();
    const avail = await this.isAvailable();
    if (!avail.available) {
      throw new DomainError(`Worker execution blocked: ${avail.error}`);
    }

    const binPath = resolveOpenCodeExecutable();
    if (!binPath) {
      throw new DomainError('Worker execution blocked: OpenCode CLI executable not found.');
    }

    const realWorktree = fs.realpathSync(context.worktreePath);
    const baseline = captureRepoBaseline(realWorktree);
    const prompt = buildOpenCodePrompt(context);
    const timeoutMs = Math.max(1000, context.timeoutMs ?? 300_000);
    const env = buildOpenCodeEnv(context, { sandboxed: true });

    const args = [
      'run',
      '--standalone',
      '--format',
      'json',
      '--archived',
      '--auto',
      '--model',
      this.model,
      prompt,
    ];

    const initialLog = `[OpenCode] Executing ${binPath} in OS sandbox with model ${this.model} in ${realWorktree}`;
    const logs: string[] = [initialLog];
    try {
      context.onLog?.(initialLog);
    } catch {}

    let stdoutBuffer = '';
    let stderrBuffer = '';
    const emitStreamLine = (rawLine: string, stream: 'stdout' | 'stderr') => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      if (stream === 'stderr') {
        const msg = `[OpenCode stderr] ${trimmed.slice(0, 200)}`;
        try {
          context.onLog?.(msg);
        } catch {}
        return;
      }
      try {
        const evt = JSON.parse(trimmed);
        const type = typeof evt?.type === 'string' ? evt.type : 'event';
        let summary = `[OpenCode] ${type}`;
        if (type === 'tool_use' || evt?.part?.type === 'tool') {
          const toolName = evt?.part?.tool || evt?.tool || 'tool';
          const status = evt?.part?.state?.status ? ` (${evt.part.state.status})` : '';
          summary = `[OpenCode] tool: ${toolName}${status}`;
        } else if (type === 'text') {
          const snippet = String(evt?.part?.text || evt?.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
          if (snippet) summary = `[OpenCode] ${snippet}`;
        } else if (type === 'step_finish' && evt?.part?.reason) {
          summary = `[OpenCode] step_finish (${evt.part.reason})`;
        } else if (type === 'error') {
          const errText = String(evt?.error?.message || evt?.message || 'error').slice(0, 160);
          summary = `[OpenCode] error: ${errText}`;
        }
        try {
          context.onLog?.(summary);
        } catch {}
      } catch {
        try {
          context.onLog?.(`[OpenCode] ${trimmed.slice(0, 160)}`);
        } catch {}
      }
    };

    const sandboxResult = await this.sandbox.execute({
      worktreePath: realWorktree,
      command: binPath,
      args,
      rawArgv: true,
      timeoutMs,
      env,
      allowNetwork: true,
      runId: context.runId,
      abortSignal: context.abortSignal,
      gitReadOnly: true,
      extraReadPaths: collectExtraReadPaths(binPath),
      denyWritePaths: collectDenyWritePaths(realWorktree, context.protectedPaths),
      seedHomeFiles: collectOpenCodeAuthSeedFiles(),
      preserveEnvKeys: ['GITHUB_TOKEN'],
      onOutput: (stream, chunk) => {
        if (stream === 'stdout') {
          stdoutBuffer += chunk;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) emitStreamLine(line, 'stdout');
        } else {
          stderrBuffer += chunk;
          const lines = stderrBuffer.split(/\r?\n/);
          stderrBuffer = lines.pop() ?? '';
          for (const line of lines) emitStreamLine(line, 'stderr');
        }
      },
    });

    // Always inspect repo baseline vs post-execution state on success, failure, timeout, and cancellation.
    const repoInspection = inspectAndVerifyRepoChanges(realWorktree, baseline, context);
    if (repoInspection.violations.length > 0) {
      throw new DomainError(`OpenCode boundary violation: ${repoInspection.violations.join('; ')}`);
    }

    if (sandboxResult.killed && context.abortSignal?.aborted) {
      throw new DomainError('OpenCode execution cancelled by user');
    }
    if (sandboxResult.timedOut) {
      throw new DomainError(`OpenCode execution timed out after ${timeoutMs}ms`);
    }
    if (sandboxResult.killed) {
      throw new DomainError('OpenCode execution cancelled by user');
    }

    const boundedStdout = sandboxResult.stdout.slice(0, MAX_OUTPUT_BYTES);
    const boundedStderr = sandboxResult.stderr.slice(0, MAX_OUTPUT_BYTES);

    // Parse NDJSON output from `opencode run --format json`
    const parsedEvents: any[] = [];
    const malformedLines: string[] = [];
    for (const rawLine of boundedStdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        parsedEvents.push(JSON.parse(line));
      } catch {
        malformedLines.push(line);
      }
    }

    if (boundedStderr.trim()) {
      logs.push(`[OpenCode stderr] ${sanitizeWorkerOutput(boundedStderr.trim())}`);
    }

    const tokenUsage = parsedEvents.reduce(
      (acc, ev) => {
        const u = ev?.usage || ev?.tokens || ev?.part?.tokens;
        if (u && typeof u === 'object') {
          acc.promptTokens += Number(u.input || u.input_tokens || u.promptTokens || 0);
          acc.completionTokens += Number(u.output || u.output_tokens || u.completionTokens || 0);
          acc.totalTokens += Number(u.total || u.total_tokens || u.totalTokens || 0);
        }
        return acc;
      },
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );

    const eventErrors = parsedEvents
      .filter((ev) => ev?.type === 'error' || ev?.error)
      .map((ev) => sanitizeWorkerOutput(String(ev?.error?.message || ev?.error || ev?.message || 'OpenCode error')));

    if (sandboxResult.exitCode !== 0 || eventErrors.length > 0) {
      const detail =
        eventErrors[0] ||
        sanitizeWorkerOutput(boundedStderr.trim()) ||
        `OpenCode exited with code ${sandboxResult.exitCode ?? 'null'}`;
      const isDeterministicStartupFailure =
        /Failed to change directory to|Model unavailable|provider\.no-route|executable not found|not authenticated|unauthorized|invalid api key|ENOENT/i.test(
          detail,
        );
      return {
        success: false,
        filesModified: repoInspection.filesModified,
        diff: repoInspection.diff,
        commitMessage: '',
        logs,
        tokenUsage: tokenUsage.totalTokens > 0 ? tokenUsage : undefined,
        durationMs: Date.now() - startTime,
        errorMessage: `OpenCode CLI failed: ${detail}`,
        nonRetryable: isDeterministicStartupFailure,
      };
    }

    if (malformedLines.length > 0 || parsedEvents.length === 0) {
      return {
        success: false,
        filesModified: repoInspection.filesModified,
        diff: repoInspection.diff,
        commitMessage: '',
        logs,
        durationMs: Date.now() - startTime,
        errorMessage:
          malformedLines.length > 0
            ? `Malformed OpenCode JSON output: ${sanitizeWorkerOutput(malformedLines[0].slice(0, 200))}`
            : 'OpenCode CLI produced no structured JSON events.',
      };
    }

    const summaryText = parsedEvents
      .map((ev) => ev?.part?.text || ev?.text || ev?.message || '')
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .join('\n')
      .trim();
    if (summaryText) {
      logs.push(`[OpenCode summary] ${sanitizeWorkerOutput(summaryText.slice(0, 1000))}`);
    }

    return {
      success: true,
      filesModified: repoInspection.filesModified,
      diff: repoInspection.diff,
      commitMessage: `feat(${context.taskKey}): implement via opencode (${this.model})`,
      logs,
      tokenUsage: tokenUsage.totalTokens > 0 ? tokenUsage : undefined,
      durationMs: Date.now() - startTime,
    };
  }
}
