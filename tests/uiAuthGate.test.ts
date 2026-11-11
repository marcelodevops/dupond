/**
 * Renders the board's entry point against a stubbed API to prove the failure
 * mode operators actually saw — a 401 leaving seeded demo tasks on screen with
 * no signal — is replaced by an explicit authentication gate.
 */

import assert from 'assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';

test('UI auth gate render suite', async () => {
console.log('=== RUNNING UI AUTH GATE RENDER SUITE ===\n');

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};

let stateResponseStatus = 401;
(globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
  if (String(url).includes('/api/orchestrate/state')) {
    const headers = new Headers(init.headers);
    const authorized = headers.get('Authorization') === 'Bearer dp_operator_token';
    return new Response(
      authorized
        ? JSON.stringify({ tasks: [], agents: [], epics: [], communications: [] })
        : JSON.stringify({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }),
      { status: authorized ? 200 : stateResponseStatus },
    );
  }
  return new Response('{}', { status: 200 });
};

const api = await import('../src/lib/api.js');
const { default: App } = await import('../src/App.js');

// Test 1: an unauthenticated sync renders the gate instead of a silent board
stateResponseStatus = 401;
await api.apiFetch('/api/orchestrate/state');
assert.strictEqual(api.isAuthRequired(), true, 'sync attempt recorded the rejection');

const lockedHtml = renderToStaticMarkup(createElement(App));
assert.ok(lockedHtml.includes('Authentication required'), 'gate is rendered on 401');
assert.ok(lockedHtml.includes('no edits are being'), 'gate states that writes are not persisted');
assert.ok(lockedHtml.includes('type="password"'), 'operator can supply the token');
assert.ok(!api.getApiToken(), 'no token assumed on the operator\'s behalf');

// Test 2: once the token is stored the gate lifts and the board is server-backed
api.setApiToken('dp_operator_token');
stateResponseStatus = 200;
await api.apiFetch('/api/orchestrate/state');
assert.strictEqual(api.isAuthRequired(), false, 'authorized sync clears the gate');

const openHtml = renderToStaticMarkup(createElement(App));
assert.ok(!openHtml.includes('Authentication required'), 'gate disappears when authenticated');

console.log('✔ [PASS] 401 renders an authentication gate; an authorized sync renders the board');

console.log('\n=== UI AUTH GATE RENDER SUITE PASSED ===');
});
