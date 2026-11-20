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
import {
  captureRepoBaseline,
  collectDenyWritePaths,
  inspectAndVerifyRepoChanges,
  sanitizeWorkerOutput,
} from './opencodeWorkerAdapter.js';

export const GEMINI_CLI_MIN_SUPPORTED_VERSION = '0.60.0';
export const GEMINI_CLI_TESTED_VERSION = '0.64.0';
export const DEFAULT_GEMINI_CLI_MODEL =
  process.env.DUPOND_GEMINI_CLI_MODEL?.trim() || 'gemini-2.5-flash';
export const SUPPORTED_GEMINI_CLI_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
] as const;
export const GEMINI_CLI_MODEL_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,120}$/;

const MAX_OUTPUT_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

export type GeminiCliAuthMethod = 'oauth-personal' | 'vertex-ai' | 'adc' | 'none';

export interface GeminiCliReadinessStatus {
  available: boolean;
  executablePath: string | null;
  version: string | null;
  supportedVersion: boolean;
  authReady: boolean;
  authMethod: GeminiCliAuthMethod;
  models: string[];
  defaultModel: string;
  error?: string;
}

export function isValidGeminiCliModelId(model: string): boolean {
  const trimmed = model.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && GEMINI_CLI_MODEL_ID_REGEX.test(trimmed);
}

export function isSupportedGeminiCliVersion(version: string | null): boolean {
  if (!version) return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 60;
}

export function resolveGeminiCliExecutable(): string | null {
  const override = process.env.DUPOND_GEMINI_CLI_BIN?.trim();
  if (override) {
    return fs.existsSync(override) ? override : null;
  }

  const candidatePaths = [
    path.join(os.homedir(), '.local', 'bin', 'gemini'),
    '/usr/local/bin/gemini',
    '/opt/homebrew/bin/gemini',
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(cmd, ['gemini'], {
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

function resolveGeminiConfigDir(): string {
  const override = process.env.DUPOND_GEMINI_CLI_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.gemini');
}

function inspectGeminiCliAuth(): {
  authReady: boolean;
  authMethod: GeminiCliAuthMethod;
  oauthCredsPath?: string;
  googleAccountsPath?: string;
  adcPath?: string;
  reason?: string;
} {
  const configDir = resolveGeminiConfigDir();
  const settingsPath = path.join(configDir, 'settings.json');
  const oauthPath = path.join(configDir, 'oauth_creds.json');
  const accountsPath = path.join(configDir, 'google_accounts.json');

  let selectedType: string | undefined;
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      selectedType = parsed?.security?.auth?.selectedType;
    } catch {
      return {
        authReady: false,
        authMethod: 'none',
        reason: 'Gemini CLI settings.json is malformed JSON.',
      };
    }
  }

  if (fs.existsSync(oauthPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(oauthPath, 'utf-8'));
      const hasToken =
        (typeof creds?.refresh_token === 'string' && creds.refresh_token.trim().length > 0) ||
        (typeof creds?.access_token === 'string' && creds.access_token.trim().length > 0);
      if (hasToken && (!selectedType || selectedType === 'oauth-personal')) {
        return {
          authReady: true,
          authMethod: 'oauth-personal',
          oauthCredsPath: oauthPath,
          googleAccountsPath: fs.existsSync(accountsPath) ? accountsPath : undefined,
        };
      }
    } catch {
      return {
        authReady: false,
        authMethod: 'none',
        reason: 'Gemini CLI oauth_creds.json is unreadable or malformed JSON.',
      };
    }
  }

  const adcEnvPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const defaultAdcPath = path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  const resolvedAdc =
    adcEnvPath && fs.existsSync(adcEnvPath)
      ? adcEnvPath
      : fs.existsSync(defaultAdcPath)
        ? defaultAdcPath
        : undefined;

  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && process.env.GOOGLE_CLOUD_PROJECT?.trim()) {
    return {
      authReady: true,
      authMethod: 'vertex-ai',
      adcPath: resolvedAdc,
    };
  }

  if (resolvedAdc && (selectedType === 'compute-default-credentials' || selectedType === 'vertex-ai')) {
    return {
      authReady: true,
      authMethod: 'adc',
      adcPath: resolvedAdc,
    };
  }

  return {
    authReady: false,
    authMethod: 'none',
    reason:
      "Gemini CLI is not authenticated. Run 'gemini' interactively to complete Google login (oauth-personal), or configure Vertex AI / Application Default Credentials. Note: Gemini CLI does not use Dupond's GEMINI_API_KEY.",
  };
}

function buildGeminiCliEnv(options?: { sandboxed?: boolean }): Record<string, string> {
  const env: Record<string, string> = {};
  const blockedEnvPatterns = [
    /^DUPOND_/i,
    /^GEMINI_API_KEY$/i,
    /^OPENAI_API_KEY$/i,
    /^JIRA_/i,
    /^SLACK_/i,
    /^GH_TOKEN$/i,
    /^GITHUB_TOKEN$/i,
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
  env.GEMINI_CLI_NO_RELAUNCH = 'true';
  return env;
}

export function probeGeminiCliReadiness(): GeminiCliReadinessStatus {
  const executablePath = resolveGeminiCliExecutable();
  if (!executablePath) {
    return {
      available: false,
      executablePath: null,
      version: null,
      supportedVersion: false,
      authReady: false,
      authMethod: 'none',
      models: [...SUPPORTED_GEMINI_CLI_MODELS],
      defaultModel: DEFAULT_GEMINI_CLI_MODEL,
      error:
        'Gemini CLI executable not found. Install @google/gemini-cli (>= 0.60.0) or set DUPOND_GEMINI_CLI_BIN.',
    };
  }

  let version: string | null = null;
  try {
    const verOut = execFileSync(executablePath, ['--version'], {
      env: buildGeminiCliEnv(),
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const match = verOut.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/);
    version = match ? match[1] : verOut || null;
  } catch (err: any) {
    return {
      available: false,
      executablePath,
      version: null,
      supportedVersion: false,
      authReady: false,
      authMethod: 'none',
      models: [...SUPPORTED_GEMINI_CLI_MODELS],
      defaultModel: DEFAULT_GEMINI_CLI_MODEL,
      error: `Failed to execute Gemini CLI (--version): ${sanitizeWorkerOutput(err?.message || 'unknown error')}`,
    };
  }

  const supportedVersion = isSupportedGeminiCliVersion(version);
  if (!supportedVersion) {
    return {
      available: false,
      executablePath,
      version,
      supportedVersion: false,
      authReady: false,
      authMethod: 'none',
      models: [...SUPPORTED_GEMINI_CLI_MODELS],
      defaultModel: DEFAULT_GEMINI_CLI_MODEL,
      error: `Detected Gemini CLI v${version || 'unknown'}, which is below minimum supported version ${GEMINI_CLI_MIN_SUPPORTED_VERSION}.`,
    };
  }

  const auth = inspectGeminiCliAuth();
  if (!auth.authReady) {
    return {
      available: false,
      executablePath,
      version,
      supportedVersion: true,
      authReady: false,
      authMethod: 'none',
      models: [...SUPPORTED_GEMINI_CLI_MODELS],
      defaultModel: DEFAULT_GEMINI_CLI_MODEL,
      error: auth.reason,
    };
  }

  return {
    available: true,
    executablePath,
    version,
    supportedVersion: true,
    authReady: true,
    authMethod: auth.authMethod,
    models: [...SUPPORTED_GEMINI_CLI_MODELS],
    defaultModel: DEFAULT_GEMINI_CLI_MODEL,
  };
}

function collectGeminiCliExtraReadPaths(binPath: string): string[] {
  const candidates = new Set<string>();
  const addPathAndParent = (p: string) => {
    try {
      const resolved = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
      candidates.add(resolved);
      candidates.add(path.dirname(resolved));
      // For bundle/gemini.js inside @google/gemini-cli, include package root so bundle chunks & node_modules load
      const pkgParent = path.dirname(path.dirname(resolved));
      if (pkgParent && pkgParent !== '/' && fs.existsSync(path.join(pkgParent, 'package.json'))) {
        candidates.add(pkgParent);
      }
    } catch {
      candidates.add(path.resolve(p));
    }
  };
  addPathAndParent(binPath);
  addPathAndParent(path.resolve(binPath));
  addPathAndParent(process.execPath);
  return Array.from(candidates);
}

function buildGeminiCliPrompt(context: WorkerExecutionContext): string {
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

export class GeminiCliCodingWorkerAdapter implements CodingWorkerAdapter {
  readonly name = 'gemini_cli_coding_worker';
  readonly provider: WorkerProvider = 'gemini-cli';
  readonly model: string;
  private sandbox: SandboxExecutor;

  constructor(
    model: string = DEFAULT_GEMINI_CLI_MODEL,
    sandbox: SandboxExecutor = defaultSandboxExecutor,
  ) {
    this.model = (model || DEFAULT_GEMINI_CLI_MODEL).trim();
    this.sandbox = sandbox;
  }

  public async isAvailable(): Promise<{ available: boolean; error?: string }> {
    const readiness = probeGeminiCliReadiness();
    if (!readiness.available) {
      return { available: false, error: readiness.error };
    }
    if (!isValidGeminiCliModelId(this.model)) {
      return {
        available: false,
        error: `Invalid Gemini CLI model "${this.model}". Expected a model identifier such as ${DEFAULT_GEMINI_CLI_MODEL}.`,
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

    const binPath = resolveGeminiCliExecutable();
    if (!binPath) {
      throw new DomainError('Worker execution blocked: Gemini CLI executable not found.');
    }

    const auth = inspectGeminiCliAuth();
    if (!auth.authReady) {
      throw new DomainError(`Worker execution blocked: ${auth.reason || 'Gemini CLI authentication missing.'}`);
    }

    const realWorktree = fs.realpathSync(context.worktreePath);
    const baseline = captureRepoBaseline(realWorktree);
    const prompt = buildGeminiCliPrompt(context);
    const timeoutMs = Math.max(1000, context.timeoutMs ?? 300_000);

    const seedHomeFiles: Array<{ sourcePath: string; targetRelToHome: string }> = [];
    if (auth.oauthCredsPath) {
      seedHomeFiles.push({
        sourcePath: auth.oauthCredsPath,
        targetRelToHome: '.gemini/oauth_creds.json',
      });
    }
    if (auth.googleAccountsPath) {
      seedHomeFiles.push({
        sourcePath: auth.googleAccountsPath,
        targetRelToHome: '.gemini/google_accounts.json',
      });
    }
    if (auth.adcPath) {
      seedHomeFiles.push({
        sourcePath: auth.adcPath,
        targetRelToHome: '.config/gcloud/application_default_credentials.json',
      });
    }

    const hardenedSettings = {
      security: {
        auth: {
          selectedType:
            auth.authMethod === 'oauth-personal'
              ? 'oauth-personal'
              : auth.authMethod === 'vertex-ai'
                ? 'vertex-ai'
                : 'compute-default-credentials',
        },
        folderTrust: { enabled: false },
      },
      mcpServers: {},
      hooks: {},
      tools: { exclude: ['run_shell_command'] },
      admin: { mcp: { enabled: false }, extensions: { enabled: false } },
    };

    const env = buildGeminiCliEnv({ sandboxed: true });
    if (auth.authMethod === 'vertex-ai') {
      env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
      if (process.env.GOOGLE_CLOUD_PROJECT) env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
      if (process.env.GOOGLE_CLOUD_LOCATION) env.GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION;
    }

    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--approval-mode',
      'auto_edit',
      '--skip-trust',
      '--model',
      this.model,
      '-e',
      'none',
    ];

    const logs: string[] = [
      `[GeminiCLI] Executing ${binPath} in OS sandbox with model ${this.model} in ${realWorktree}`,
    ];

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
      extraReadPaths: collectGeminiCliExtraReadPaths(binPath),
      denyWritePaths: collectDenyWritePaths(realWorktree, context.protectedPaths),
      seedHomeFiles,
      seedHomeContents: [
        {
          content: JSON.stringify(hardenedSettings, null, 2),
          targetRelToHome: '.gemini/settings.json',
          mode: 0o600,
        },
      ],
      preserveEnvKeys: ['GEMINI_CLI_NO_RELAUNCH'],
    });

    // Always inspect repo baseline vs post-execution state on success, failure, timeout, and cancellation.
    const repoInspection = inspectAndVerifyRepoChanges(realWorktree, baseline, context);
    if (repoInspection.violations.length > 0) {
      throw new DomainError(`Gemini CLI boundary violation: ${repoInspection.violations.join('; ')}`);
    }

    if (sandboxResult.killed && context.abortSignal?.aborted) {
      throw new DomainError('Gemini CLI execution cancelled by user');
    }
    if (sandboxResult.timedOut) {
      throw new DomainError(`Gemini CLI execution timed out after ${timeoutMs}ms`);
    }
    if (sandboxResult.killed) {
      throw new DomainError('Gemini CLI execution cancelled by user');
    }

    const boundedStdout = sandboxResult.stdout.slice(0, MAX_OUTPUT_BYTES);
    const boundedStderr = sandboxResult.stderr.slice(0, MAX_OUTPUT_BYTES);

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
      logs.push(`[GeminiCLI stderr] ${sanitizeWorkerOutput(boundedStderr.trim())}`);
    }

    const tokenUsage = parsedEvents.reduce(
      (acc, ev) => {
        const u = ev?.stats || ev?.usage || ev?.tokens;
        if (u && typeof u === 'object') {
          acc.promptTokens += Number(u.input_tokens || u.input || u.promptTokens || 0);
          acc.completionTokens += Number(u.output_tokens || u.output || u.completionTokens || 0);
          acc.totalTokens += Number(u.total_tokens || u.total || u.totalTokens || 0);
        }
        return acc;
      },
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );

    const eventErrors = parsedEvents
      .filter((ev) => ev?.type === 'error' || ev?.status === 'error' || ev?.error)
      .map((ev) =>
        sanitizeWorkerOutput(String(ev?.error?.message || ev?.error || ev?.message || 'Gemini CLI error')),
      );

    if (sandboxResult.exitCode !== 0 || eventErrors.length > 0) {
      const detail =
        eventErrors[0] ||
        sanitizeWorkerOutput(boundedStderr.trim()) ||
        `Gemini CLI exited with code ${sandboxResult.exitCode ?? 'null'}`;
      const isDeterministicStartupFailure =
        sandboxResult.exitCode === 41 ||
        /FatalAuthenticationError|Please set an Auth method|Manual authorization is required|Model not found|Model unavailable|not authenticated|unauthorized|invalid api key|Failed to change directory|executable not found|ENOENT|401|403/i.test(
          detail,
        );
      const isQuotaOrOutage =
        !isDeterministicStartupFailure &&
        /429|RESOURCE_EXHAUSTED|quota|rate limit|503|UNAVAILABLE|ECONNREFUSED|ETIMEDOUT|network/i.test(
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
        errorMessage: isQuotaOrOutage
          ? `Gemini CLI provider/quota error: ${detail}`
          : `Gemini CLI failed: ${detail}`,
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
            ? `Malformed Gemini CLI stream-json output: ${sanitizeWorkerOutput(malformedLines[0].slice(0, 200))}`
            : 'Gemini CLI produced no structured stream-json events.',
      };
    }

    const summaryText = parsedEvents
      .filter((ev) => ev?.type === 'message' && ev?.role === 'assistant')
      .map((ev) => ev?.content || ev?.text || '')
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .join('\n')
      .trim();
    if (summaryText) {
      logs.push(`[GeminiCLI summary] ${sanitizeWorkerOutput(summaryText.slice(0, 1000))}`);
    }

    return {
      success: true,
      filesModified: repoInspection.filesModified,
      diff: repoInspection.diff,
      commitMessage: `feat(${context.taskKey}): implement via gemini-cli (${this.model})`,
      logs,
      tokenUsage: tokenUsage.totalTokens > 0 ? tokenUsage : undefined,
      durationMs: Date.now() - startTime,
    };
  }
}
