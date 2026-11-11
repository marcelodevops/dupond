const TOKEN_STORAGE_KEY = 'dupond_api_token';

type AuthListener = (authRequired: boolean) => void;

function readStoredToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

let apiToken: string | null = readStoredToken();
let authRequired = false;
const listeners = new Set<AuthListener>();

let projectHeaderProvider: (() => string | null) | null = null;
let apiBaseUrl = '';

export function registerProjectHeaderProvider(provider: () => string | null): void {
  projectHeaderProvider = provider;
}

export function setApiBaseUrl(url: string): void {
  apiBaseUrl = url.replace(/\/$/, '');
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

function setAuthRequired(next: boolean) {
  if (authRequired === next) return;
  authRequired = next;
  for (const listener of listeners) listener(next);
}

export function isAuthRequired(): boolean {
  return authRequired;
}

export function getApiToken(): string | null {
  return apiToken;
}

export function onAuthStateChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setApiToken(token: string | null): void {
  const trimmed = token?.trim();
  apiToken = trimmed ? trimmed : null;
  try {
    if (apiToken) globalThis.localStorage?.setItem(TOKEN_STORAGE_KEY, apiToken);
    else globalThis.localStorage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode): keep the token for this session only.
  }
  // Saving a token is a retry attempt; the next response decides whether it worked.
  setAuthRequired(false);
}

/**
 * fetch() with the operator token attached. A 401 flips the app into the
 * authentication-required state instead of leaving callers to render
 * locally-seeded data as if it were server truth.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (apiToken && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${apiToken}`);

  if (projectHeaderProvider && !headers.has('X-Dupond-Project-Id')) {
    const currentProjectId = projectHeaderProvider();
    if (currentProjectId) {
      headers.set('X-Dupond-Project-Id', currentProjectId);
    }
  }

  const targetUrl = apiBaseUrl && input.startsWith('/')
    ? `${apiBaseUrl}${input}`
    : input;

  const response = await fetch(targetUrl, { ...init, headers });
  setAuthRequired(response.status === 401);
  return response;
}
