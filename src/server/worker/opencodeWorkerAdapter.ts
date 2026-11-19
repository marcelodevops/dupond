import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (blockedEnvPatterns.some((re) => re.test(k))) continue;
    env[k] = v;
  }

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

    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      permission: {
        edit: editRules,
        bash: { '*': 'deny' },
        external_directory: 'deny',
      },
    });
  }

  return env;
}

function sanitizeWorkerOutput(raw: string): string {
  return sanitizeOpenAIError(sanitizeGeminiError(raw))
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
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

function snapshotWorktreeStatus(realWorktree: string): Map<string, string> {
  const statusOut = execFileSync('git', ['status', '--porcelain', '-uall'], {
    cwd: realWorktree,
    encoding: 'utf-8',
  });
  const files = new Map<string, string>();
  for (const line of statusOut.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const relPath = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
    if (!relPath) continue;
    const absPath = path.join(realWorktree, relPath);
    let digest = 'deleted';
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        digest = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      }
    } catch {
      digest = 'unreadable';
    }
    files.set(relPath, `${line.slice(0, 2)}:${digest}`);
  }
  return files;
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
    const beforeSnapshot = snapshotWorktreeStatus(realWorktree);
    const prompt = buildOpenCodePrompt(context);
    const timeoutMs = Math.max(1000, context.timeoutMs ?? 300_000);
    const env = buildOpenCodeEnv(context);

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

    const logs: string[] = [
      `[OpenCode] Executing ${binPath} with model ${this.model} in ${realWorktree}`,
    ];

    const execOutcome = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      cancelled: boolean;
    }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const child = spawn(binPath, args, {
        cwd: realWorktree,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const killProcessTree = () => {
        if (!child.pid) return;
        try {
          if (process.platform !== 'win32') {
            process.kill(-child.pid, 'SIGTERM');
          } else {
            child.kill('SIGTERM');
          }
        } catch {}
        setTimeout(() => {
          try {
            if (process.platform !== 'win32' && child.pid) {
              process.kill(-child.pid, 'SIGKILL');
            } else {
              child.kill('SIGKILL');
            }
          } catch {}
        }, 1200).unref();
      };

      const onAbort = () => {
        cancelled = true;
        killProcessTree();
      };

      if (context.abortSignal?.aborted) {
        onAbort();
      } else if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += chunk.toString('utf-8').slice(0, MAX_OUTPUT_BYTES - stdout.length);
        } else if (!stdoutTruncated) {
          stdoutTruncated = true;
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += chunk.toString('utf-8').slice(0, MAX_OUTPUT_BYTES - stderr.length);
        } else if (!stderrTruncated) {
          stderrTruncated = true;
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          resolve({ exitCode, signal, stdout, stderr, timedOut, cancelled });
        }
      });
    });

    if (execOutcome.cancelled) {
      throw new DomainError('OpenCode execution cancelled by user');
    }
    if (execOutcome.timedOut) {
      throw new DomainError(`OpenCode execution timed out after ${timeoutMs}ms`);
    }

    // Parse NDJSON output from `opencode run --format json`
    const parsedEvents: any[] = [];
    const malformedLines: string[] = [];
    for (const rawLine of execOutcome.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        parsedEvents.push(JSON.parse(line));
      } catch {
        malformedLines.push(line);
      }
    }

    if (execOutcome.stderr.trim()) {
      logs.push(`[OpenCode stderr] ${sanitizeWorkerOutput(execOutcome.stderr.trim())}`);
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

    if (execOutcome.exitCode !== 0 || eventErrors.length > 0) {
      const detail =
        eventErrors[0] ||
        sanitizeWorkerOutput(execOutcome.stderr.trim()) ||
        `OpenCode exited with code ${execOutcome.exitCode ?? 'null'}`;
      return {
        success: false,
        filesModified: [],
        diff: '',
        commitMessage: '',
        logs,
        tokenUsage: tokenUsage.totalTokens > 0 ? tokenUsage : undefined,
        durationMs: Date.now() - startTime,
        errorMessage: `OpenCode CLI failed: ${detail}`,
      };
    }

    if (malformedLines.length > 0 || parsedEvents.length === 0) {
      return {
        success: false,
        filesModified: [],
        diff: '',
        commitMessage: '',
        logs,
        durationMs: Date.now() - startTime,
        errorMessage:
          malformedLines.length > 0
            ? `Malformed OpenCode JSON output: ${sanitizeWorkerOutput(malformedLines[0].slice(0, 200))}`
            : 'OpenCode CLI produced no structured JSON events.',
      };
    }

    // Verify worktree changes made during OpenCode execution against Dupond's path & protected-path boundaries
    const afterSnapshot = snapshotWorktreeStatus(realWorktree);
    const modifiedFiles = Array.from(afterSnapshot.entries())
      .filter(([file, sig]) => beforeSnapshot.get(file) !== sig)
      .map(([file]) => file);

    for (const file of modifiedFiles) {
      const resolved = resolveSafePath(realWorktree, file, {
        allowedPaths: context.allowedPaths,
        protectedPaths: context.protectedPaths,
      });
      if (!resolved.isSafe || resolved.isProtected || !resolved.isAllowed) {
        throw new DomainError(
          `OpenCode boundary violation on "${file}": ${resolved.error || (resolved.isProtected ? 'protected path' : 'outside allowedPaths')}`,
        );
      }
    }

    const diff = execFileSync('git', ['diff', 'HEAD'], {
      cwd: realWorktree,
      encoding: 'utf-8',
    });

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
      filesModified: modifiedFiles,
      diff,
      commitMessage: `feat(${context.taskKey}): implement via opencode (${this.model})`,
      logs,
      tokenUsage: tokenUsage.totalTokens > 0 ? tokenUsage : undefined,
      durationMs: Date.now() - startTime,
    };
  }
}
