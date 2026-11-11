/**
 * Client auth regression: an unauthenticated API response must surface as an
 * authentication gate, not as a board full of locally seeded data.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { test } from 'vitest';

test('UI auth client regression suite', async () => {
console.log('=== RUNNING UI AUTH CLIENT REGRESSION SUITE ===\n');

const SEED_TOKEN = 'dp_seed_token';
const storage = new Map<string, string>([['dupond_api_token', SEED_TOKEN]]);

(globalThis as any).localStorage = {
  getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};

let nextStatus = 200;
let lastHeaders: Headers | null = null;

(globalThis as any).fetch = async (_url: string, init: RequestInit = {}) => {
  lastHeaders = new Headers(init.headers);
  return new Response(JSON.stringify({ ok: true }), {
    status: nextStatus,
    headers: { 'Content-Type': 'application/json' },
  });
};

const api = await import('../src/lib/api.js');

const authEvents: boolean[] = [];
const unsubscribe = api.onAuthStateChange((needsAuth: boolean) => authEvents.push(needsAuth));

// Test 1: token restored from client storage is attached to every request
nextStatus = 200;
await api.apiFetch('/api/orchestrate/state');
assert.strictEqual(lastHeaders!.get('Authorization'), `Bearer ${SEED_TOKEN}`, 'stored token must be sent');
assert.strictEqual(api.isAuthRequired(), false, 'a passing request is not an auth failure');

// Test 2: a 401 flips the app into the authentication-required state
nextStatus = 401;
await api.apiFetch('/api/orchestrate/state');
assert.strictEqual(api.isAuthRequired(), true, '401 must be reported, not swallowed');
assert.deepStrictEqual(authEvents, [true], 'listener notified once on state change');

// Test 3: pasting a new token clears the gate and is persisted trimmed
api.setApiToken('  dp_pasted_token  ');
assert.strictEqual(api.getApiToken(), 'dp_pasted_token', 'token trimmed before use');
assert.strictEqual(storage.get('dupond_api_token'), 'dp_pasted_token', 'token persisted for restarts');
assert.strictEqual(api.isAuthRequired(), false, 'storing a token is a retry attempt');

nextStatus = 200;
await api.apiFetch('/api/orchestrate/state');
assert.strictEqual(lastHeaders!.get('Authorization'), 'Bearer dp_pasted_token', 'new token attached');
assert.deepStrictEqual(authEvents, [true, false], 'listener notified when the gate lifts');

// Test 4: callers that set their own credential are not overwritten
nextStatus = 200;
await api.apiFetch('/api/custom-providers/ping', { headers: { Authorization: 'Bearer caller_supplied' } });
assert.strictEqual(lastHeaders!.get('Authorization'), 'Bearer caller_supplied', 'explicit header wins');

// Test 5: clearing the token removes it from storage and from requests
api.setApiToken(null);
assert.strictEqual(api.getApiToken(), null, 'token cleared');
assert.strictEqual(storage.has('dupond_api_token'), false, 'cleared token removed from storage');
nextStatus = 401;
await api.apiFetch('/api/orchestrate/state');
assert.ok(!lastHeaders!.has('Authorization'), 'no Authorization header once cleared');
assert.strictEqual(api.isAuthRequired(), true, 'still reporting the gate on 401');

unsubscribe();
const eventsBeforeUnsubscribe = authEvents.length;
nextStatus = 401;
await api.apiFetch('/api/orchestrate/state');
assert.strictEqual(authEvents.length, eventsBeforeUnsubscribe, 'unsubscribed listener is not called');

// Test 6: no client code may call fetch() directly against /api again — that is
// how the silent seed-data fallback was introduced.
const clientDir = path.resolve(process.cwd(), 'src');
const clientFiles = [
  path.join(clientDir, 'App.tsx'),
  ...fs.readdirSync(path.join(clientDir, 'components')).map((f) => path.join(clientDir, 'components', f)),
];
const rawCall = /(?<!api)fetch\(\s*[`'"]\/api/;
for (const file of clientFiles) {
  if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
  assert.ok(!rawCall.test(fs.readFileSync(file, 'utf-8')), `${path.basename(file)} must route API calls through apiFetch`);
}
console.log(`✔ [PASS] ${clientFiles.length - 1} client modules keep API calls authenticated`);

console.log('\n=== UI AUTH CLIENT REGRESSION SUITE PASSED ===');
});
