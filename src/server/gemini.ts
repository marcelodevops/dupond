import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { defaultAppCredentialStore, type GeminiTestOutcome } from './projects/appCredentialStore.js';
import type { GeminiCredentialSource, GeminiCredentialStatus, GeminiTestResult } from '../types/projectContract.js';

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

interface ResolvedCredential {
  apiKey: string | null;
  source: GeminiCredentialSource;
}

interface EnvTestState {
  fingerprint: string;
  testedAt: string;
  outcome: GeminiTestOutcome;
  error: string | null;
}

const cachedClients = new Map<string, { fingerprint: string; client: GoogleGenAI }>();
let testClientOverride: any = null;
let envTestState: EnvTestState | null = null;

function fingerprintSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
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

export function resolveGeminiCredential(): ResolvedCredential {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, source: 'environment' };
  }
  const savedKey = defaultAppCredentialStore.getGeminiKey()?.trim();
  if (savedKey) {
    return { apiKey: savedKey, source: 'saved' };
  }
  return { apiKey: null, source: 'none' };
}

export function invalidateGeminiClientCache(): void {
  cachedClients.clear();
}

export function getGeminiClient(options?: { userAgent?: string }): GoogleGenAI | null {
  if (testClientOverride) return testClientOverride;

  const { apiKey } = resolveGeminiCredential();
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

  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': userAgent,
      },
      ...(baseUrl ? { baseUrl } : {}),
    },
  });
  cachedClients.set(userAgent, { fingerprint: fp, client });
  return client;
}

export function setGeminiClientForTesting(client: any): void {
  testClientOverride = client ?? null;
}

export function hasGeminiKey(): boolean {
  return resolveGeminiCredential().apiKey !== null;
}

export function getGeminiCredentialStatus(): GeminiCredentialStatus {
  const envKey = process.env.GEMINI_API_KEY?.trim() || '';
  const meta = defaultAppCredentialStore.getGeminiMetadata();

  if (envKey) {
    const envFp = fingerprintSecret(envKey);
    const currentEnvTest = envTestState && envTestState.fingerprint === envFp ? envTestState : null;
    return {
      provider: 'gemini',
      model: GEMINI_MODEL,
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
    return {
      provider: 'gemini',
      model: GEMINI_MODEL,
      source: 'saved',
      configured: true,
      ready: true,
      hasSavedKey: true,
      environmentControlled: false,
      scope: 'application',
      lastTestedAt: meta.lastTestedAt,
      lastTestOutcome: meta.lastTestOutcome,
      lastTestError: meta.lastTestError,
    };
  }

  return {
    provider: 'gemini',
    model: GEMINI_MODEL,
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

export async function testGeminiConnection(): Promise<GeminiTestResult> {
  const testedAt = new Date().toISOString();
  const { apiKey, source } = resolveGeminiCredential();

  if (!apiKey || source === 'none') {
    return {
      ok: false,
      source: 'none',
      model: GEMINI_MODEL,
      testedAt,
      error: 'No Gemini API key is configured.',
    };
  }

  const client = getGeminiClient();
  if (!client) {
    return {
      ok: false,
      source,
      model: GEMINI_MODEL,
      testedAt,
      error: 'Failed to initialize Gemini client with configured credential.',
    };
  }

  try {
    await callGeminiWithTimeout(
      client.models.generateContent({
        model: GEMINI_MODEL,
        contents: 'Reply with OK.',
      }),
      15000,
    );

    if (source === 'saved') {
      defaultAppCredentialStore.recordGeminiTestResult('passed', null);
    } else {
      envTestState = {
        fingerprint: fingerprintSecret(apiKey),
        testedAt,
        outcome: 'passed',
        error: null,
      };
    }

    return {
      ok: true,
      source,
      model: GEMINI_MODEL,
      testedAt,
    };
  } catch (err: any) {
    const sanitized = sanitizeGeminiError(err?.message || String(err), apiKey);
    if (source === 'saved') {
      defaultAppCredentialStore.recordGeminiTestResult('failed', sanitized);
    } else {
      envTestState = {
        fingerprint: fingerprintSecret(apiKey),
        testedAt,
        outcome: 'failed',
        error: sanitized,
      };
    }

    return {
      ok: false,
      source,
      model: GEMINI_MODEL,
      testedAt,
      error: sanitized,
    };
  }
}

export async function callGeminiWithTimeout<T>(promise: Promise<T>, timeoutMs = 45000): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Gemini API request timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}
