import crypto from 'node:crypto';
import OpenAI from 'openai';
import {
  AppCredentialStore,
  defaultAppCredentialStore,
  type CredentialTestOutcome,
} from './projects/appCredentialStore.js';
import type {
  CredentialSource,
  OpenAICredentialStatus,
  OpenAITestFailureReason,
  OpenAITestResult,
} from '../types/projectContract.js';

export const SUPPORTED_OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o3-mini',
  'gpt-4.5-preview',
] as const;

export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
export const OPENAI_TEST_DEFAULT_TIMEOUT_MS = 60_000;
export const OPENAI_TEST_MIN_TIMEOUT_MS = 5_000;
export const OPENAI_TEST_MAX_TIMEOUT_MS = 120_000;

export function resolveOpenAITestTimeoutMs(overrideMs?: number): number {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) {
    return Math.floor(overrideMs);
  }

  const rawMs = process.env.DUPOND_OPENAI_TEST_TIMEOUT_MS?.trim();
  const rawSeconds = process.env.DUPOND_OPENAI_TEST_TIMEOUT_SECONDS?.trim();

  let parsedMs: number | null = null;
  if (rawMs) {
    const n = Number(rawMs);
    if (Number.isFinite(n) && n > 0) parsedMs = Math.floor(n);
  } else if (rawSeconds) {
    const s = Number(rawSeconds);
    if (Number.isFinite(s) && s > 0) parsedMs = Math.floor(s * 1000);
  }

  if (parsedMs === null) return OPENAI_TEST_DEFAULT_TIMEOUT_MS;
  return Math.min(OPENAI_TEST_MAX_TIMEOUT_MS, Math.max(OPENAI_TEST_MIN_TIMEOUT_MS, parsedMs));
}

interface ResolvedCredential {
  apiKey: string | null;
  source: CredentialSource;
  version: string | null;
  fingerprint: string | null;
}

interface EnvTestState {
  fingerprint: string;
  model: string;
  seq: number;
  testedAt: string;
  outcome: CredentialTestOutcome;
  error: string | null;
}

export const OPENAI_MODEL_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidOpenAIModelId(model: string): boolean {
  return OPENAI_MODEL_ID_REGEX.test(model);
}

const cachedClients = new Map<string, { fingerprint: string; client: OpenAI }>();
const latestCompletedTestSeqByVersion = new Map<string, number>();
let testClientOverride: any = null;
let envTestState: EnvTestState | null = null;
let nextTestSeq = 0;

function allocateTestSeq(store: AppCredentialStore): number {
  const dbMax = store.getMaxTestSeq();
  const envMax = envTestState?.seq ?? 0;
  nextTestSeq = Math.max(nextTestSeq, dbMax, envMax) + 1;
  return nextTestSeq;
}

function fingerprintSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function activeModelName(): string {
  return process.env.OPENAI_MODEL?.trim() || OPENAI_MODEL;
}

/**
 * Only allow overriding the OpenAI API base URL when running in an explicit
 * test mode (`NODE_ENV === 'test'` or `DUPOND_ALLOW_TEST_OPENAI_ENDPOINT === '1'`).
 * Never settable from HTTP requests or UI preferences.
 */
function resolveTestBaseUrl(): string | undefined {
  const isTestMode =
    process.env.NODE_ENV === 'test' ||
    process.env.DUPOND_ALLOW_TEST_OPENAI_ENDPOINT === '1';
  if (!isTestMode) return undefined;
  const raw = process.env.DUPOND_OPENAI_TEST_BASE_URL?.trim();
  return raw ? raw : undefined;
}

export function sanitizeOpenAIError(rawMessage: string | undefined | null, activeKey?: string | null): string {
  let msg = (rawMessage || 'OpenAI request failed.').toString();
  if (activeKey && activeKey.trim()) {
    msg = msg.split(activeKey.trim()).join('[REDACTED]');
  }
  msg = msg.replace(/sk-(?:proj-|svcacct-)?[0-9A-Za-z_-]{10,}/g, '[REDACTED]');
  msg = msg.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  return msg;
}

export function resolveOpenAICredential(store: AppCredentialStore = defaultAppCredentialStore): ResolvedCredential {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    const fp = fingerprintSecret(envKey);
    return {
      apiKey: envKey,
      source: 'environment',
      version: `env:${fp}`,
      fingerprint: fp,
    };
  }
  const saved = store.getOpenAIKeySnapshot();
  if (saved && saved.apiKey.trim()) {
    return {
      apiKey: saved.apiKey.trim(),
      source: 'saved',
      version: saved.credentialVersion,
      fingerprint: saved.keyFingerprint,
    };
  }
  return { apiKey: null, source: 'none', version: null, fingerprint: null };
}

export function invalidateOpenAIClientCache(): void {
  cachedClients.clear();
}

function buildClientForKey(apiKey: string, userAgent: string): OpenAI {
  const baseURL = resolveTestBaseUrl();
  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: {
      'User-Agent': userAgent,
    },
  });
}

export function getOpenAIClient(options?: { userAgent?: string; store?: AppCredentialStore }): OpenAI | null {
  if (testClientOverride) return testClientOverride;

  const { apiKey } = resolveOpenAICredential(options?.store);
  if (!apiKey) {
    cachedClients.clear();
    return null;
  }

  const userAgent = options?.userAgent || 'dupond-coding-worker-openai';
  const baseUrl = resolveTestBaseUrl();
  const fp = fingerprintSecret(`${apiKey}|${userAgent}|${baseUrl || ''}`);

  const existing = cachedClients.get(userAgent);
  if (existing && existing.fingerprint === fp) {
    return existing.client;
  }

  const client = buildClientForKey(apiKey, userAgent);
  cachedClients.set(userAgent, { fingerprint: fp, client });
  return client;
}

export function setOpenAIClientForTesting(client: any): void {
  testClientOverride = client ?? null;
}

export function hasOpenAIKey(store: AppCredentialStore = defaultAppCredentialStore): boolean {
  return resolveOpenAICredential(store).apiKey !== null;
}

export function getOpenAICredentialStatus(
  store: AppCredentialStore = defaultAppCredentialStore,
  options?: { model?: string },
): OpenAICredentialStatus {
  const envKey = process.env.OPENAI_API_KEY?.trim() || '';
  const defaultModel = activeModelName();
  const requestedModel = options?.model?.trim();
  const meta = store.getOpenAIMetadata();

  if (envKey) {
    const envFp = fingerprintSecret(envKey);
    const matchesRequested = !requestedModel || (envTestState && envTestState.model === requestedModel);
    const currentEnvTest =
      envTestState && envTestState.fingerprint === envFp ? envTestState : null;
    return {
      provider: 'openai',
      model: requestedModel || currentEnvTest?.model || defaultModel,
      supportedModels: [...SUPPORTED_OPENAI_MODELS],
      source: 'environment',
      configured: true,
      ready: true,
      hasSavedKey: meta.hasSavedKey,
      environmentControlled: true,
      scope: 'application',
      lastTestedAt: matchesRequested ? (currentEnvTest?.testedAt ?? null) : null,
      lastTestOutcome: matchesRequested ? (currentEnvTest?.outcome ?? null) : null,
      lastTestError: matchesRequested ? (currentEnvTest?.error ?? null) : null,
      lastTestModel: currentEnvTest?.model ?? null,
    };
  }

  if (meta.hasSavedKey) {
    const modelMatches = !requestedModel || !meta.lastTestModel || meta.lastTestModel === requestedModel;
    return {
      provider: 'openai',
      model: requestedModel || meta.lastTestModel || defaultModel,
      supportedModels: [...SUPPORTED_OPENAI_MODELS],
      source: 'saved',
      configured: true,
      ready: true,
      hasSavedKey: true,
      environmentControlled: false,
      scope: 'application',
      lastTestedAt: modelMatches ? meta.lastTestedAt : null,
      lastTestOutcome: modelMatches ? meta.lastTestOutcome : null,
      lastTestError: modelMatches ? meta.lastTestError : null,
      lastTestModel: meta.lastTestModel ?? null,
    };
  }

  return {
    provider: 'openai',
    model: requestedModel || defaultModel,
    supportedModels: [...SUPPORTED_OPENAI_MODELS],
    source: 'none',
    configured: false,
    ready: false,
    hasSavedKey: false,
    environmentControlled: false,
    scope: 'application',
    lastTestedAt: null,
    lastTestOutcome: null,
    lastTestError: null,
    lastTestModel: null,
    error: 'No OpenAI API key is configured. Set OPENAI_API_KEY on the server or save an application key in Application Settings.',
  };
}

function runWithAbortSignal<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('OpenAI request aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('OpenAI request aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
  });
}

function formatDurationLabel(ms: number): string {
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function classifyOpenAIFailure(err: any, sanitizedError: string): OpenAITestFailureReason {
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const code = String(err?.error?.code || err?.code || '');
  const type = String(err?.error?.type || '');

  if (
    type === 'insufficient_quota' ||
    code === 'insufficient_quota' ||
    code === 'credit_balance_exhausted' ||
    /insufficient_quota|credit_balance_exhausted|quota|billing/i.test(sanitizedError)
  ) {
    return 'quota';
  }

  if (
    status === 401 ||
    status === 403 ||
    code === 'invalid_api_key' ||
    /(401|403|invalid_api_key|api[ _-]?key.*invalid|invalid.*api[ _-]?key|unauthenticated|permission_denied|unauthorized)/i.test(
      sanitizedError,
    )
  ) {
    return 'auth';
  }

  if (
    status === 404 ||
    code === 'model_not_found' ||
    (status === 400 && /model|unsupported|does not exist/i.test(sanitizedError)) ||
    /model_not_found|does not exist|not have access to.*model|unsupported.*model/i.test(sanitizedError)
  ) {
    return 'model_access';
  }

  if (
    status === 429 ||
    (status !== undefined && status >= 500) ||
    err?.name === 'APIConnectionError' ||
    err?.name === 'APIConnectionTimeoutError' ||
    /(429|500|502|503|504|rate.?limit|overloaded|service_unavailable|connection error|econnrefused|econnreset)/i.test(
      sanitizedError,
    )
  ) {
    return 'transient';
  }

  return 'error';
}

export async function testOpenAIConnection(options?: {
  store?: AppCredentialStore;
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
}): Promise<OpenAITestResult> {
  const store = options?.store ?? defaultAppCredentialStore;
  const requestedModel = options?.model?.trim();
  const modelToTest = requestedModel || activeModelName();
  const timeoutMs = resolveOpenAITestTimeoutMs(options?.timeoutMs);

  if (requestedModel !== undefined && (!requestedModel || !isValidOpenAIModelId(requestedModel))) {
    return {
      ok: false,
      outcome: 'failed',
      reason: 'model_access',
      timeoutMs,
      source: resolveOpenAICredential(store).source,
      model: requestedModel || activeModelName(),
      testedAt: new Date().toISOString(),
      error: 'Invalid OpenAI model identifier. Use 1-128 characters matching [A-Za-z0-9._:-].',
    };
  }

  const seq = allocateTestSeq(store);
  const snapshot = resolveOpenAICredential(store);
  if (!snapshot.apiKey || snapshot.source === 'none' || !snapshot.version || !snapshot.fingerprint) {
    return {
      ok: false,
      outcome: 'failed',
      reason: 'error',
      source: 'none',
      model: modelToTest,
      testedAt: new Date().toISOString(),
      error: 'No OpenAI API key is configured.',
    };
  }

  const client = testClientOverride || buildClientForKey(snapshot.apiKey, 'dupond-coding-worker-openai');
  const controller = new AbortController();
  let abortReason: 'timeout' | 'cancelled' | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => {
    if (!abortReason) abortReason = 'cancelled';
    controller.abort(new Error('OpenAI connection test cancelled by user.'));
  };

  if (options?.signal?.aborted) {
    onExternalAbort();
  } else if (options?.signal) {
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  if (!controller.signal.aborted) {
    timeoutId = setTimeout(() => {
      if (!abortReason) abortReason = 'timeout';
      controller.abort(new Error(`OpenAI connection test timed out after ${formatDurationLabel(timeoutMs)}`));
    }, timeoutMs);
  }

  let testStatus: 'passed' | 'failed' | 'timeout' | 'cancelled' = 'passed';
  let sanitizedError: string | null = null;
  let failureReason: OpenAITestFailureReason = 'error';

  try {
    await runWithAbortSignal(
      () =>
        client.responses.create(
          {
            model: modelToTest,
            input: 'Reply with OK.',
            max_output_tokens: 16,
          },
          {
            signal: controller.signal,
            maxRetries: 0,
          },
        ),
      controller.signal,
    );
  } catch (err: any) {
    if (abortReason === 'cancelled') {
      testStatus = 'cancelled';
    } else if (abortReason === 'timeout') {
      testStatus = 'timeout';
    } else {
      testStatus = 'failed';
      sanitizedError = sanitizeOpenAIError(err?.message || String(err), snapshot.apiKey);
      failureReason = classifyOpenAIFailure(err, sanitizedError);
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }

  const testedAt = new Date().toISOString();
  const current = resolveOpenAICredential(store);

  const stillCurrent =
    current.source === snapshot.source &&
    current.version === snapshot.version &&
    current.fingerprint === snapshot.fingerprint;

  if (!stillCurrent) {
    return {
      ok: false,
      stale: true,
      outcome: 'stale',
      reason: 'stale',
      timeoutMs,
      source: snapshot.source,
      model: modelToTest,
      testedAt,
      error: 'Credential test result was superseded because the active OpenAI credential changed while the test was in flight.',
    };
  }

  if (testStatus === 'timeout' || testStatus === 'cancelled') {
    if (snapshot.source === 'saved') {
      const prevCompletedSeq = latestCompletedTestSeqByVersion.get(snapshot.version) ?? 0;
      if (prevCompletedSeq >= seq) {
        return {
          ok: false,
          stale: true,
          outcome: 'stale',
          reason: 'stale',
          timeoutMs,
          source: snapshot.source,
          model: modelToTest,
          testedAt,
          error: 'Credential test result was superseded by a newer overlapping test.',
        };
      }
    } else if (
      envTestState &&
      envTestState.fingerprint === snapshot.fingerprint &&
      envTestState.seq >= seq
    ) {
      return {
        ok: false,
        stale: true,
        outcome: 'stale',
        reason: 'stale',
        timeoutMs,
        source: snapshot.source,
        model: modelToTest,
        testedAt,
        error: 'Credential test result was superseded by a newer overlapping test.',
      };
    }

    if (testStatus === 'cancelled') {
      return {
        ok: false,
        inconclusive: true,
        cancelled: true,
        outcome: 'cancelled',
        reason: 'cancelled',
        timeoutMs,
        source: snapshot.source,
        model: modelToTest,
        testedAt,
        error:
          'Connection test was cancelled. Previous verification history was preserved, and cancelling cannot guarantee the provider incurred no usage.',
      };
    }

    return {
      ok: false,
      inconclusive: true,
      outcome: 'inconclusive',
      reason: 'timeout',
      timeoutMs,
      source: snapshot.source,
      model: modelToTest,
      testedAt,
      error: `Connection test timed out after ${formatDurationLabel(timeoutMs)} before OpenAI responded. This does not mean the credential is invalid; previous verification history was preserved.`,
    };
  }

  const outcome: CredentialTestOutcome = testStatus === 'passed' ? 'passed' : 'failed';

  if (snapshot.source === 'saved') {
    const prevCompletedSeq = latestCompletedTestSeqByVersion.get(snapshot.version) ?? 0;
    if (prevCompletedSeq >= seq) {
      return {
        ok: false,
        stale: true,
        outcome: 'stale',
        reason: 'stale',
        timeoutMs,
        source: snapshot.source,
        model: modelToTest,
        testedAt,
        error: 'Credential test result was superseded by a newer overlapping test.',
      };
    }

    const persisted = store.recordOpenAITestResultIfCurrent({
      expectedVersion: snapshot.version,
      expectedFingerprint: snapshot.fingerprint,
      expectedModel: modelToTest,
      testSeq: seq,
      outcome,
      error: sanitizedError,
      testedAt,
    });
    if (!persisted) {
      return {
        ok: false,
        stale: true,
        outcome: 'stale',
        reason: 'stale',
        timeoutMs,
        source: snapshot.source,
        model: modelToTest,
        testedAt,
        error: 'Credential test result was superseded by a newer credential change or overlapping test.',
      };
    }
    latestCompletedTestSeqByVersion.set(snapshot.version, seq);
  } else {
    if (
      envTestState &&
      envTestState.fingerprint === snapshot.fingerprint &&
      envTestState.seq >= seq
    ) {
      return {
        ok: false,
        stale: true,
        outcome: 'stale',
        reason: 'stale',
        timeoutMs,
        source: snapshot.source,
        model: modelToTest,
        testedAt,
        error: 'Credential test result was superseded by a newer overlapping test.',
      };
    }
    envTestState = {
      fingerprint: snapshot.fingerprint,
      model: modelToTest,
      seq,
      testedAt,
      outcome,
      error: sanitizedError,
    };
  }

  if (outcome === 'failed') {
    return {
      ok: false,
      stale: false,
      inconclusive: false,
      outcome: 'failed',
      reason: failureReason,
      timeoutMs,
      source: snapshot.source,
      model: modelToTest,
      testedAt,
      error: sanitizedError || 'Connection test failed.',
    };
  }

  return {
    ok: true,
    stale: false,
    inconclusive: false,
    outcome: 'passed',
    reason: null,
    timeoutMs,
    source: snapshot.source,
    model: modelToTest,
    testedAt,
  };
}
