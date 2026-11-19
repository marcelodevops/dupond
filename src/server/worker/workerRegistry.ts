import { DomainError } from '../utils/errors';
import { CodingWorkerAdapter, WorkerConfig, WorkerProvider } from './types.js';
import { SandboxExecutor, defaultSandboxExecutor } from '../sandbox/sandboxExecutor.js';
import { GeminiCodingWorkerAdapter } from './geminiWorkerAdapter.js';
import { OpenAICodingWorkerAdapter } from './openaiWorkerAdapter.js';
import {
  DEFAULT_OPENCODE_MODEL,
  isValidOpenCodeModelId,
  OpenCodeCodingWorkerAdapter,
} from './opencodeWorkerAdapter.js';
import { SUPPORTED_GEMINI_MODELS } from './providers/geminiProvider.js';
import { SUPPORTED_OPENAI_MODELS } from './providers/openaiProvider.js';

export const SUPPORTED_PROVIDERS: readonly WorkerProvider[] = ['gemini', 'openai', 'opencode'] as const;

export const SUPPORTED_MODELS: Record<WorkerProvider, readonly string[]> = {
  gemini: SUPPORTED_GEMINI_MODELS,
  openai: SUPPORTED_OPENAI_MODELS,
  opencode: [DEFAULT_OPENCODE_MODEL],
};

export const DEFAULT_PROVIDER: WorkerProvider = 'gemini';
export const DEFAULT_MODELS: Record<WorkerProvider, string> = {
  gemini: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  openai: 'gpt-4o-mini',
  opencode: DEFAULT_OPENCODE_MODEL,
};

export interface WorkerConfigValidationResult {
  valid: boolean;
  provider: WorkerProvider;
  model: string;
  error?: string;
}

/**
 * Validates a worker configuration, applying backward-compatible defaults
 * when fields are omitted.
 */
export function validateWorkerConfig(config?: { provider?: string; model?: string }): WorkerConfigValidationResult {
  if (!config || (!config.provider && !config.model)) {
    const defaultModel = process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini;
    return {
      valid: true,
      provider: DEFAULT_PROVIDER,
      model: defaultModel,
    };
  }

  const rawProvider = (config.provider || DEFAULT_PROVIDER).toLowerCase().trim() as WorkerProvider;
  if (!SUPPORTED_PROVIDERS.includes(rawProvider)) {
    return {
      valid: false,
      provider: DEFAULT_PROVIDER,
      model: '',
      error: `Unsupported worker provider: "${config.provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    };
  }

  const defaultModel =
    rawProvider === 'gemini'
      ? (process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini)
      : rawProvider === 'opencode'
        ? (process.env.DUPOND_OPENCODE_MODEL || DEFAULT_MODELS.opencode)
        : DEFAULT_MODELS[rawProvider];
  const rawModel = (config.model || defaultModel).trim();

  if (rawProvider === 'opencode') {
    if (!isValidOpenCodeModelId(rawModel)) {
      return {
        valid: false,
        provider: rawProvider,
        model: rawModel,
        error: `Invalid model "${config.model}" for provider "opencode". Expected provider/model format (e.g. ${DEFAULT_OPENCODE_MODEL}).`,
      };
    }
    return {
      valid: true,
      provider: rawProvider,
      model: rawModel,
    };
  }

  const allowedModels = SUPPORTED_MODELS[rawProvider];
  if (!allowedModels.includes(rawModel as any)) {
    return {
      valid: false,
      provider: rawProvider,
      model: rawModel,
      error: `Unsupported model "${config.model}" for provider "${rawProvider}". Supported models for ${rawProvider}: ${allowedModels.join(', ')}.`,
    };
  }

  return {
    valid: true,
    provider: rawProvider,
    model: rawModel,
  };
}

/**
 * Resolves the authoritative coding worker instance based on task configuration.
 * Fails closed if the configuration is invalid or unsupported.
 */
export function resolveCodingWorker(
  config?: { provider?: string; model?: string },
  sandbox: SandboxExecutor = defaultSandboxExecutor
): CodingWorkerAdapter {
  const validation = validateWorkerConfig(config);
  if (!validation.valid) {
    throw new DomainError(`Worker configuration invalid: ${validation.error}`);
  }

  if (validation.provider === 'openai') {
    return new OpenAICodingWorkerAdapter(validation.model, sandbox);
  }

  if (validation.provider === 'opencode') {
    return new OpenCodeCodingWorkerAdapter(validation.model, sandbox);
  }

  return new GeminiCodingWorkerAdapter(validation.model, sandbox);
}
