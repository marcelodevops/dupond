import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import {
  AppCredentialStore,
  defaultAppCredentialStore,
  type GeminiTestOutcome,
} from './projects/appCredentialStore.js';
import type { GeminiCredentialSource, GeminiCredentialStatus, GeminiTestResult } from '../types/projectContract.js';

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

interface ResolvedCredential {
  apiKey: string | null;
  source: GeminiCredentialSource;
  version: string | null;
  fingerprint: string | null;
}

interface EnvTestState {
  fingerprint: string;
  model: string;
  seq: number;
  testedAt: string;
  outcome: GeminiTestOutcome;
  error: string | null;
}

const cachedClients = new Map<string, { fingerprint: string; client: GoogleGenAI }>();
const latestCompletedTestSeqByKey = new Map<string, number>();
let testClientOverride: any = null;
let envTestState: EnvTestState | null = null;
let nextTestSeq = 0;

function fingerprintSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function activeModelName(): string {
  return process.env.GEMINI_MODEL?.trim() || GEMINI_MODEL;
}

/**
 * Only allow overriding the Gemini API base URL when running in an explicit
 * test mode (`NODE_ENV === 'test'` or `DUPOND_ALLOW_TEST_GEMINI_ENDPOINT === '1'`).
 * Never settable from HTTP requests or UI preferences.
 */
function resolveTestBaseUrl(): string | undefined {
  const isTestMode =
    process.env.NODE_ENV === 'test' ||
    process.env.DUPOND_ALLOW_TEST_GEMINI_ENDPOINT === '1';
  if (!isTestMode) return undefined;
  const raw = process.env.DUPOND_GEMINI_TEST_BASE_URL?.trim();
  return raw ? raw : undefined;
}

export function sanitizeGeminiError(rawMessage: string | undefined | null, activeKey?: string | null): string {
  let msg = (rawMessage || 'Gemini request failed.').toString();
  if (activeKey && activeKey.trim()) {
    msg = msg.split(activeKey.trim()).join('[REDACTED]');
  }
  msg = msg.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED]');
  msg = msg.replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]');
  return msg;
}

export function resolveGeminiCredential(store: AppCredentialStore = defaultAppCredentialStore): ResolvedCredential {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) {
    const fp = fingerprintSecret(envKey);
    return {
      apiKey: envKey,
      source: 'environment',
      version: `env:${fp}`,
      fingerprint: fp,
    };
  }
  const saved = store.getGeminiKeySnapshot();
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

export function invalidateGeminiClientCache(): void {
  cachedClients.clear();
}

function buildClientForKey(apiKey: string, userAgent: string): GoogleGenAI {
  const baseUrl = resolveTestBaseUrl();
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': userAgent,
      },
      ...(baseUrl ? { baseUrl } : {}),
    },
  });
}

export function getGeminiClient(options?: { userAgent?: string; store?: AppCredentialStore }): GoogleGenAI | null {
  if (testClientOverride) return testClientOverride;

  const { apiKey } = resolveGeminiCredential(options?.store);
  if (!apiKey) {
    cachedClients.clear();
    return null;
  }

  const userAgent = options?.userAgent || 'aistudio-build';
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

export function setGeminiClientForTesting(client: any): void {
  testClientOverride = client ?? null;
}

export function hasGeminiKey(): boolean {
  return resolveGeminiCredential().apiKey !== null;
}

export function getGeminiCredentialStatus(store: AppCredentialStore = defaultAppCredentialStore): GeminiCredentialStatus {
  const envKey = process.env.GEMINI_API_KEY?.trim() || '';
  const model = activeModelName();
  const meta = store.getGeminiMetadata();

  if (envKey) {
    const envFp = fingerprintSecret(envKey);
    const currentEnvTest =
      envTestState && envTestState.fingerprint === envFp && envTestState.model === model
        ? envTestState
        : null;
    return {
      provider: 'gemini',
      model,
      source: 'environment',
      configured: true,
      ready: true,
      hasSavedKey: meta.hasSavedKey,
      environmentControlled: true,
      scope: 'application',
      lastTestedAt: currentEnvTest?.testedAt ?? null,
      lastTestOutcome: currentEnvTest?.outcome ?? null,
      lastTestError: currentEnvTest?.error ?? null,
    };
  }

  if (meta.hasSavedKey) {
    const modelMatches = !meta.lastTestModel || meta.lastTestModel === model;
    return {
      provider: 'gemini',
      model,
      source: 'saved',
      configured: true,
      ready: true,
      hasSavedKey: true,
      environmentControlled: false,
      scope: 'application',
      lastTestedAt: modelMatches ? meta.lastTestedAt : null,
      lastTestOutcome: modelMatches ? meta.lastTestOutcome : null,
      lastTestError: modelMatches ? meta.lastTestError : null,
    };
  }

  return {
    provider: 'gemini',
    model,
    source: 'none',
    configured: false,
    ready: false,
    hasSavedKey: false,
    environmentControlled: false,
    scope: 'application',
    lastTestedAt: null,
    lastTestOutcome: null,
    lastTestError: null,
    error: 'No Gemini API key is configured. Set GEMINI_API_KEY on the server or save an application key in Project Settings.',
  };
}

export async function testGeminiConnection(options?: { store?: AppCredentialStore }): Promise<GeminiTestResult> {
  const store = options?.store ?? defaultAppCredentialStore;
  const seq = ++nextTestSeq;
  const modelToTest = activeModelName();
  const snapshot = resolveGeminiCredential(store);

  if (!snapshot.apiKey || snapshot.source === 'none' || !snapshot.version || !snapshot.fingerprint) {
    return {
      ok: false,
      outcome: 'failed',
      source: 'none',
      model: modelToTest,
      testedAt: new Date().toISOString(),
      error: 'No Gemini API key is configured.',
    };
  }

  const client = testClientOverride || buildClientForKey(snapshot.apiKey, 'aistudio-build');
  let outcome: GeminiTestOutcome = 'passed';
  let sanitizedError: string | null = null;

  try {
    await callGeminiWithTimeout(
      client.models.generateContent({
        model: modelToTest,
        contents: 'Reply with OK.',
      }),
      15000,
    );
  } catch (err: any) {
    outcome = 'failed';
    sanitizedError = sanitizeGeminiError(err?.message || String(err), snapshot.apiKey);
  }

  const testedAt = new Date().toISOString();
  const current = resolveGeminiCredential(store);
  const currentModel = activeModelName();

  const stillCurrent =
    current.source === snapshot.source &&
    current.version === snapshot.version &&
    current.fingerprint === snapshot.fingerprint &&
    currentModel === modelToTest;

  if (!stillCurrent) {
    return {
      ok: false,
      stale: true,
      outcome: 'stale',
      source: snapshot.source,
      model: modelToTest,
      testedAt,
      error: 'Credential test result was superseded because the active Gemini credential or model changed while the test was in flight.',
    };
  }

  if (snapshot.source === 'saved') {
    const completionKey = `${snapshot.version}|${modelToTest}`;
    const prevCompletedSeq = latestCompletedTestSeqByKey.get(completionKey) ?? 0;
    if (prevCompletedSeq >= seq) {
      return {
        ok: false,
        stale: true,
        outcome: 'stale',
        source: snapshot.source,
        model: modelToTest,
        testedAt,
        error: 'Credential test result was superseded by a newer overlapping test.',
      };
    }

    const persisted = store.recordGeminiTestResultIfCurrent({
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
        source: snapshot.source,
        model: modelToTest,
        testedAt,
        error: 'Credential test result was superseded by a newer credential change or overlapping test.',
      };
    }
    latestCompletedTestSeqByKey.set(completionKey, seq);
  } else {
    if (
      envTestState &&
      envTestState.fingerprint === snapshot.fingerprint &&
      envTestState.model === modelToTest &&
      envTestState.seq >= seq
    ) {
      return {
        ok: false,
        stale: true,
        outcome: 'stale',
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
      outcome: 'failed',
      source: snapshot.source,
      model: modelToTest,
      testedAt,
      error: sanitizedError || 'Connection test failed.',
    };
  }

  return {
    ok: true,
    stale: false,
    outcome: 'passed',
    source: snapshot.source,
    model: modelToTest,
    testedAt,
  };
}

export async function callGeminiWithTimeout<T>(promise: Promise<T>, timeoutMs = 45000): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Gemini API request timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}
