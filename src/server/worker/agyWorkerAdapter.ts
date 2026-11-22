import fs from 'node:fs';
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
  collectExtraReadPaths,
  inspectAndVerifyRepoChanges,
  sanitizeWorkerOutput,
} from './opencodeWorkerAdapter.js';
import {
  classifyAgyKeychainError,
  collectAgySandboxSeedFiles,
  hasAgyAuthTokenSeed,
  probeAgyProfileModels,
  resolveAgyExecutable,
  resolveAgyProfileDir,
} from './agyAuthManager.js';

export const DEFAULT_AGY_MODEL =
  process.env.DUPOND_AGY_MODEL?.trim() || 'gemini-3.8-flash-medium';
export const AGY_MODEL_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export function isValidAgyModelId(model: string): boolean {
  const trimmed = model.trim();
  return trimmed.length > 0 && trimmed.length <= 160 && AGY_MODEL_ID_REGEX.test(trimmed);
}

function buildAgySandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && k.startsWith('FAKE_AGY_')) {
      env[k] = v;
    }
  }
  env.ANTIGRAVITY_DISABLE_EMBEDDED_RIPGREP = 'true';
  env.TERM = 'dumb';
  env.CI = '1';
  return env;
}

function buildAgyPrompt(context: WorkerExecutionContext): string {
  const criteriaList =
    context.acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c.title} (id: ${c.id})`).join('\n') ||
    'Satisfy the task requirements cleanly.';

  const parts = [
    `Implement task ${context.taskKey}: ${context.taskTitle}`,
    `Description: ${context.taskDescription}`,
    `Acceptance criteria:\n${criteriaList}`,
    `Allowed paths: ${context.allowedPaths.length ? context.allowedPaths.join(', ') : 'repository workspace'}`,
    `Protected paths (DO NOT modify): ${context.protectedPaths.length ? context.protectedPaths.join(', ') : 'none'}`,
    'Rules:',
    '- Modify only the files needed for this task.',
    '- Do NOT create commits, branches, tags, or symlinks, and do NOT modify .git metadata.',
    '- Do NOT read or modify .env files, secrets, or protected paths.',
  ];

  if (context.repairFeedback) {
    parts.push(
      `Previous attempt (#${context.attemptNumber - 1}) failed:`,
      context.repairFeedback.failingCommand ? `Command: ${context.repairFeedback.failingCommand}` : '',
      context.repairFeedback.stderr ? `Stderr:\n${context.repairFeedback.stderr.slice(0, 2000)}` : '',
      context.repairFeedback.stdout ? `Stdout:\n${context.repairFeedback.stdout.slice(0, 2000)}` : '',
    );
  }

  if (context.operatorReviewFeedback?.length) {
    const fb = context.operatorReviewFeedback
      .map((f) => `- [${f.actor}] ${f.comment}`)
      .join('\n');
    parts.push(`Operator review feedback:\n${fb}`);
  }

  return parts.filter(Boolean).join('\n\n');
}

interface AgyJsonInfo {
  parsed?: any;
  tokenUsage?: WorkerExecutionResult['tokenUsage'];
  errorText?: string;
  empty?: boolean;
  malformed?: boolean;
  validCompletion: boolean;
  invalidReason?: string;
}

function extractAgyJsonPayload(stdout: string): AgyJsonInfo {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      empty: true,
      validCompletion: false,
      invalidReason: 'Antigravity CLI returned empty output instead of structured JSON.',
    };
  }
  try {
    const obj = JSON.parse(trimmed);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return {
        malformed: true,
        validCompletion: false,
        invalidReason: 'Antigravity CLI returned non-object JSON output.',
      };
    }

    const usage = obj.usage || obj.tokenUsage || obj.stats?.models;
    let tokenUsage: WorkerExecutionResult['tokenUsage'];
    if (usage && typeof usage === 'object') {
      const promptTokens = Number(usage.input_tokens ?? usage.promptTokens ?? usage.input ?? 0);
      const completionTokens = Number(usage.output_tokens ?? usage.completionTokens ?? usage.output ?? 0);
      const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens);
      if (Number.isFinite(totalTokens) && totalTokens > 0) {
        tokenUsage = { promptTokens, completionTokens, totalTokens };
      }
    }

    const rawErrorFromField =
      typeof obj.error === 'string'
        ? obj.error
        : typeof obj.error?.message === 'string'
          ? obj.error.message
          : Array.isArray(obj.errors) && obj.errors.length > 0
            ? obj.errors.map((e: any) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ')
            : undefined;

    const rawStatus = typeof obj.status === 'string' ? obj.status : undefined;
    const isErrorStatus =
      rawStatus !== undefined && rawStatus !== 'SUCCESS';

    const isErrorEnvelope =
      Boolean(rawErrorFromField) ||
      isErrorStatus ||
      obj.is_error === true ||
      obj.type === 'error' ||
      (typeof obj.subtype === 'string' && obj.subtype !== 'success');

    let errorText: string | undefined;
    if (isErrorEnvelope) {
      const rawErr =
        rawErrorFromField ||
        (typeof obj.response === 'string' && obj.response.trim() ? obj.response : undefined) ||
        (typeof obj.result === 'string' && obj.result.trim() ? obj.result : undefined) ||
        (typeof obj.message === 'string' && obj.message.trim() ? obj.message : undefined) ||
        `Antigravity CLI reported an error envelope (${rawStatus || obj.subtype || obj.type || 'is_error'}).`;
      errorText = sanitizeWorkerOutput(rawErr);
    }

    // Verified agy v1.5.13 --output-format=json completion contract:
    // { conversation_id, status: "SUCCESS", response, duration_seconds, num_turns, usage }
    const hasConversation =
      typeof obj.conversation_id === 'string' && obj.conversation_id.length > 0;
    const hasResponseOrTurns =
      typeof obj.response === 'string' ||
      (typeof obj.num_turns === 'number' && obj.num_turns >= 1);

    const validCompletion =
      !isErrorEnvelope &&
      rawStatus === 'SUCCESS' &&
      hasConversation &&
      hasResponseOrTurns;

    return {
      parsed: obj,
      tokenUsage,
      errorText,
      validCompletion,
      ...(validCompletion
        ? {}
        : {
            invalidReason:
              errorText ||
              'Antigravity CLI JSON output did not match a valid completion result envelope.',
          }),
    };
  } catch {
    return {
      malformed: true,
      validCompletion: false,
      invalidReason: 'Antigravity CLI returned malformed JSON output.',
    };
  }
}

function isNonRetryableAgyError(text: string): boolean {
  return /Please sign in|invalid_grant|OAuth|UNSUPPORTED_CLIENT|IneligibleTierError|unauthorized|401|403|model not found|unknown model|invalid model/i.test(
    text,
  );
}

/**
 * Antigravity CLI (agy) Coding Worker Adapter.
 * Executes inside Dupond's OS-enforced SandboxExecutor using ONLY the authenticated
 * dedicated 0700 profile tokens, never triggering automatic browser login or broad host HOME access.
 */
const AGY_SANDBOX_SETTINGS_JSON = JSON.stringify({
  disableSlashCommands: true,
  trustedWorkspaces: [],
});

const AGY_SANDBOX_SEED_CONTENTS = [
  {
    targetRelToHome: '.gemini/antigravity-cli/settings.json',
    content: `${AGY_SANDBOX_SETTINGS_JSON}\n`,
    mode: 0o600,
    required: true,
  },
  {
    targetRelToHome: '.gemini/config/mcp_config.json',
    content: '{"mcpServers":{}}\n',
    mode: 0o600,
    required: true,
  },
  {
    targetRelToHome: '.gemini/config/hooks.json',
    content: '{}\n',
    mode: 0o600,
    required: true,
  },
  {
    targetRelToHome: '.gemini/antigravity-cli/mcp_config.json',
    content: '{"mcpServers":{}}\n',
    mode: 0o600,
    required: true,
  },
  {
    targetRelToHome: '.gemini/antigravity-cli/hooks.json',
    content: '{}\n',
    mode: 0o600,
    required: true,
  },
];

const AGY_REPO_CONFIG_DENY_READ_PATHS = [
  '.agents',
  '.agent',
  '_agents',
  '_agent',
  '.gemini',
];

export class AgyCodingWorkerAdapter implements CodingWorkerAdapter {
  readonly name: string;
  readonly provider: WorkerProvider = 'agy';
  readonly model: string;
  private readonly sandbox: SandboxExecutor;

  constructor(
    model: string = DEFAULT_AGY_MODEL,
    sandbox: SandboxExecutor = defaultSandboxExecutor,
  ) {
    this.model = (model || DEFAULT_AGY_MODEL).trim();
    this.sandbox = sandbox;
    this.name = `agy:${this.model}`;
  }

  async isAvailable(): Promise<{ available: boolean; error?: string }> {
    const exe = resolveAgyExecutable();
    if (!exe) {
      return {
        available: false,
        error: 'Antigravity CLI (agy) executable not found. Install agy or set DUPOND_AGY_BIN.',
      };
    }

    if (!isValidAgyModelId(this.model)) {
      return {
        available: false,
        error: `Invalid Antigravity model "${this.model}".`,
      };
    }

    const profileDir = resolveAgyProfileDir();
    if (!hasAgyAuthTokenSeed(profileDir)) {
      return {
        available: false,
        error:
          'Dedicated Antigravity profile is not authenticated. Open Application Settings -> Connect Antigravity CLI.',
      };
    }

    const modelsCheck = await probeAgyProfileModels(profileDir, exe);
    if (!modelsCheck.authenticated) {
      return {
        available: false,
        error:
          modelsCheck.error ||
          'Dedicated Antigravity profile authentication is invalid or expired. Reconnect in Application Settings.',
      };
    }

    return { available: true };
  }

  async execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    if (!isValidAgyModelId(this.model)) {
      return {
        success: false,
        filesModified: [],
        diff: '',
        commitMessage: '',
        logs: [`Invalid Antigravity model identifier "${this.model}".`],
        durationMs: Date.now() - startTime,
        errorMessage: `Invalid Antigravity model "${this.model}".`,
        nonRetryable: true,
      };
    }

    const exe = resolveAgyExecutable();
    if (!exe) {
      return {
        success: false,
        filesModified: [],
        diff: '',
        commitMessage: '',
        logs: ['Antigravity CLI (agy) executable not found.'],
        durationMs: Date.now() - startTime,
        errorMessage: 'Antigravity CLI (agy) executable not found.',
        nonRetryable: true,
      };
    }

    const profileDir = resolveAgyProfileDir();
    const seedHomeFiles = collectAgySandboxSeedFiles(profileDir);
    if (!hasAgyAuthTokenSeed(profileDir) || seedHomeFiles.length === 0) {
      return {
        success: false,
        filesModified: [],
        diff: '',
        commitMessage: '',
        logs: ['Dedicated Antigravity profile is not authenticated.'],
        durationMs: Date.now() - startTime,
        errorMessage:
          'Dedicated Antigravity profile is not authenticated. Open Application Settings -> Connect Antigravity CLI.',
        nonRetryable: true,
      };
    }

    if (!context.worktreePath || !fs.existsSync(context.worktreePath) || !fs.statSync(context.worktreePath).isDirectory()) {
      return {
        success: false,
        filesModified: [],
        diff: '',
        commitMessage: '',
        logs: [`Invalid worktree directory: ${context.worktreePath}`],
        durationMs: Date.now() - startTime,
        errorMessage: `Worktree directory does not exist: ${context.worktreePath}`,
        nonRetryable: true,
      };
    }

    const realWorktree = fs.realpathSync(context.worktreePath);
    const baseline = captureRepoBaseline(realWorktree);
    const prompt = buildAgyPrompt(context);
    const args = [
      `--print=${prompt}`,
      '--output-format=json',
      `--model=${this.model}`,
      '--mode=auto',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      `--settings=${AGY_SANDBOX_SETTINGS_JSON}`,
    ];

    logs.push(`[agy] Executing non-interactive coding run with model "${this.model}" in isolated sandbox`);

    const sbRes = await this.sandbox.execute({
      worktreePath: realWorktree,
      command: exe,
      args,
      rawArgv: true,
      timeoutMs: context.timeoutMs || 180_000,
      allowNetwork: true,
      gitReadOnly: true,
      denyWritePaths: collectDenyWritePaths(realWorktree, context.protectedPaths),
      denyReadPaths: AGY_REPO_CONFIG_DENY_READ_PATHS,
      extraReadPaths: collectExtraReadPaths(exe),
      seedHomeFiles,
      seedHomeContents: AGY_SANDBOX_SEED_CONTENTS,
      env: buildAgySandboxEnv(),
      abortSignal: context.abortSignal,
    });

    const jsonInfo = extractAgyJsonPayload(sbRes.stdout);
    const combinedRawOutput = [sbRes.stdout, sbRes.stderr, jsonInfo.errorText || '']
      .filter(Boolean)
      .join('\n');
    const sanitizedOutput = sanitizeWorkerOutput(combinedRawOutput);
    if (sanitizedOutput.trim()) {
      logs.push(sanitizedOutput.trim().slice(0, 4000));
    }

    const inspection = inspectAndVerifyRepoChanges(realWorktree, baseline, context);
    if (inspection.violations.length > 0) {
      logs.push(...inspection.violations.map((v) => `[POLICY_VIOLATION] ${v}`));
      return {
        success: false,
        filesModified: inspection.filesModified,
        diff: inspection.diff,
        commitMessage: '',
        logs,
        tokenUsage: jsonInfo.tokenUsage,
        durationMs: Date.now() - startTime,
        errorMessage: `Antigravity CLI violated repository boundaries: ${inspection.violations.join('; ')}`,
      };
    }

    if (context.abortSignal?.aborted) {
      return {
        success: false,
        filesModified: inspection.filesModified,
        diff: inspection.diff,
        commitMessage: '',
        logs,
        tokenUsage: jsonInfo.tokenUsage,
        durationMs: Date.now() - startTime,
        errorMessage: 'Antigravity CLI execution was cancelled.',
        nonRetryable: true,
      };
    }

    if (sbRes.timedOut) {
      return {
        success: false,
        filesModified: inspection.filesModified,
        diff: inspection.diff,
        commitMessage: '',
        logs,
        tokenUsage: jsonInfo.tokenUsage,
        durationMs: Date.now() - startTime,
        errorMessage: `Antigravity CLI timed out after ${context.timeoutMs || 180_000}ms.`,
      };
    }

    if (sbRes.exitCode !== 0 || jsonInfo.errorText || !jsonInfo.validCompletion) {
      const detail = sanitizeWorkerOutput(
        jsonInfo.errorText || sbRes.stderr || sbRes.stdout || '',
      ).trim();
      const keychainErr = classifyAgyKeychainError(combinedRawOutput);
      const nonRetryable = Boolean(keychainErr) || isNonRetryableAgyError(detail);
      const errorMessage = keychainErr
        ? keychainErr.message
        : sbRes.exitCode !== 0 || jsonInfo.errorText
          ? `Antigravity CLI failed (exit ${sbRes.exitCode})${detail ? `: ${detail.slice(0, 400)}` : '.'}`
          : jsonInfo.invalidReason || 'Antigravity CLI exited 0 without a verified JSON completion envelope.';
      return {
        success: false,
        filesModified: inspection.filesModified,
        diff: inspection.diff,
        commitMessage: '',
        logs,
        tokenUsage: jsonInfo.tokenUsage,
        durationMs: Date.now() - startTime,
        errorMessage,
        ...(nonRetryable ? { nonRetryable: true } : {}),
      };
    }

    return {
      success: true,
      filesModified: inspection.filesModified,
      diff: inspection.diff,
      commitMessage: `feat(${context.taskKey}): implement via agy (${this.model})`,
      logs,
      tokenUsage: jsonInfo.tokenUsage,
      durationMs: Date.now() - startTime,
    };
  }
}
