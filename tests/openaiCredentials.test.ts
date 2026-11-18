import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { TaskStore } from '../src/server/db/database.js';
import { AppCredentialStore, AppCredentialValidationError } from '../src/server/projects/appCredentialStore.js';
import { decryptSecret, getConnectionKey } from '../src/server/projects/secretCrypto.js';
import {
  OPENAI_TEST_DEFAULT_TIMEOUT_MS,
  OPENAI_TEST_MAX_TIMEOUT_MS,
  OPENAI_TEST_MIN_TIMEOUT_MS,
  getOpenAIClient,
  getOpenAICredentialStatus,
  invalidateOpenAIClientCache,
  resolveOpenAICredential,
  resolveOpenAITestTimeoutMs,
  sanitizeOpenAIError,
  testOpenAIConnection,
} from '../src/server/openai.js';
import { OpenAIProviderAdapter } from '../src/server/worker/providers/openaiProvider.js';
import { rotateConnectionKey } from '../scripts/rotateConnKey.js';
import { connectionKeyMaintenancePaths } from '../src/server/projects/connectionKeyLock.js';

describe('OpenAI credential storage, precedence, worker wiring, connection tests, and rotation', () => {
  let tmpDir: string;
  let dbPath: string;
  let keyPath: string;
  let origDbPath: string | undefined;
  let origKeyPath: string | undefined;
  let origOpenAIKey: string | undefined;
  let origAllowTestEndpoint: string | undefined;
  let origTestBaseUrl: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-openai-cred-test-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

    origDbPath = process.env.DUPOND_DB_PATH;
    origKeyPath = process.env.DUPOND_CONN_KEY_PATH;
    origOpenAIKey = process.env.OPENAI_API_KEY;
    origAllowTestEndpoint = process.env.DUPOND_ALLOW_TEST_OPENAI_ENDPOINT;
    origTestBaseUrl = process.env.DUPOND_OPENAI_TEST_BASE_URL;

    process.env.DUPOND_DB_PATH = dbPath;
    process.env.DUPOND_CONN_KEY_PATH = keyPath;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DUPOND_ALLOW_TEST_OPENAI_ENDPOINT;
    delete process.env.DUPOND_OPENAI_TEST_BASE_URL;
    invalidateOpenAIClientCache();
  });

  afterEach(() => {
    invalidateOpenAIClientCache();
    if (origDbPath === undefined) delete process.env.DUPOND_DB_PATH;
    else process.env.DUPOND_DB_PATH = origDbPath;
    if (origKeyPath === undefined) delete process.env.DUPOND_CONN_KEY_PATH;
    else process.env.DUPOND_CONN_KEY_PATH = origKeyPath;
    if (origOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origOpenAIKey;
    if (origAllowTestEndpoint === undefined) delete process.env.DUPOND_ALLOW_TEST_OPENAI_ENDPOINT;
    else process.env.DUPOND_ALLOW_TEST_OPENAI_ENDPOINT = origAllowTestEndpoint;
    if (origTestBaseUrl === undefined) delete process.env.DUPOND_OPENAI_TEST_BASE_URL;
    else process.env.DUPOND_OPENAI_TEST_BASE_URL = origTestBaseUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('encrypts saved OpenAI key at rest, rejects blanks, enforces env precedence, and survives restart', () => {
    const store1 = new TaskStore(dbPath);
    const cred1 = new AppCredentialStore(store1);

    assert.throws(() => cred1.saveOpenAIKey('   '), AppCredentialValidationError);

    const savedKey = 'sk-synth-openai-saved-key-1234567890';
    const meta = cred1.saveOpenAIKey(`  ${savedKey}  `);
    assert.strictEqual(meta.hasSavedKey, true);
    assert.strictEqual(meta.lastTestOutcome, null);
    assert.ok(!JSON.stringify(meta).includes(savedKey));

    const row = store1.getRawDb().prepare('SELECT api_key_enc FROM app_credentials WHERE provider = ?').get('openai') as { api_key_enc: string };
    assert.ok(row.api_key_enc);
    assert.ok(!row.api_key_enc.includes(savedKey));
    assert.strictEqual(decryptSecret(row.api_key_enc), savedKey);

    // Env takes precedence over saved key
    const envKey = 'sk-synth-openai-env-key-abcdef123456';
    process.env.OPENAI_API_KEY = envKey;
    const envResolved = resolveOpenAICredential(cred1);
    assert.strictEqual(envResolved.source, 'environment');
    assert.strictEqual(envResolved.apiKey, envKey);
    const envStatus = getOpenAICredentialStatus(cred1);
    assert.strictEqual(envStatus.source, 'environment');
    assert.strictEqual(envStatus.environmentControlled, true);
    assert.strictEqual(envStatus.hasSavedKey, true);
    assert.ok(!JSON.stringify(envStatus).includes(envKey));
    assert.ok(!JSON.stringify(envStatus).includes(savedKey));

    // Unsetting env falls back to saved key and survives restart
    delete process.env.OPENAI_API_KEY;
    store1.getRawDb().close();

    const store2 = new TaskStore(dbPath);
    const cred2 = new AppCredentialStore(store2);
    const savedResolved = resolveOpenAICredential(cred2);
    assert.strictEqual(savedResolved.source, 'saved');
    assert.strictEqual(savedResolved.apiKey, savedKey);

    cred2.deleteOpenAIKey();
    assert.strictEqual(resolveOpenAICredential(cred2).source, 'none');
    assert.strictEqual(getOpenAICredentialStatus(cred2).configured, false);
    store2.getRawDb().close();
  });

  it('invalidates cached OpenAI client and wires OpenAIProviderAdapter to active saved key without silent fallback', async () => {
    const store = new TaskStore(dbPath);
    const cred = new AppCredentialStore(store);

    const observedAuthHeaders: string[] = [];
    const server = http.createServer((req, res) => {
      observedAuthHeaders.push(String(req.headers.authorization || ''));
      let body = '';
      req.on('data', (d) => (body += d.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp_1',
            object: 'response',
            model: parsed.model,
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] }],
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      process.env.DUPOND_ALLOW_TEST_OPENAI_ENDPOINT = '1';
      process.env.DUPOND_OPENAI_TEST_BASE_URL = `http://127.0.0.1:${port}/v1`;

      // Use defaultAppCredentialStore via DUPOND_DB_PATH or pass client via resolve: test getOpenAIClient cache directly
      const key1 = 'sk-synth-worker-key-one-111111111111';
      cred.saveOpenAIKey(key1);
      const client1 = getOpenAIClient({ store: cred, userAgent: 'dupond-test-worker' });
      const client1Again = getOpenAIClient({ store: cred, userAgent: 'dupond-test-worker' });
      assert.ok(client1);
      assert.strictEqual(client1, client1Again);

      const key2 = 'sk-synth-worker-key-two-222222222222';
      cred.saveOpenAIKey(key2);
      const client2 = getOpenAIClient({ store: cred, userAgent: 'dupond-test-worker' });
      assert.ok(client2);
      assert.notStrictEqual(client2, client1);

      // Now verify OpenAIProviderAdapter with defaultAppCredentialStore (same dbPath)
      const { defaultAppCredentialStore } = await import('../src/server/projects/appCredentialStore.js');
      const adapterUnconfigured = new OpenAIProviderAdapter('o3-mini');
      defaultAppCredentialStore.deleteOpenAIKey();
      const unavail = await adapterUnconfigured.isAvailable();
      assert.strictEqual(unavail.available, false);
      assert.ok(unavail.error?.includes('Application Settings'));

      defaultAppCredentialStore.saveOpenAIKey(key1);
      invalidateOpenAIClientCache();
      const avail = await adapterUnconfigured.isAvailable();
      assert.strictEqual(avail.available, true);

      const turn1 = await adapterUnconfigured.generateTurn({
        systemPrompt: 'hello',
        conversationHistory: adapterUnconfigured.initConversation('hello'),
      });
      assert.strictEqual(turn1.textOutput, 'OK');

      defaultAppCredentialStore.saveOpenAIKey(key2);
      invalidateOpenAIClientCache();
      await adapterUnconfigured.generateTurn({
        systemPrompt: 'hello2',
        conversationHistory: adapterUnconfigured.initConversation('hello2'),
      });

      assert.deepStrictEqual(observedAuthHeaders, [`Bearer ${key1}`, `Bearer ${key2}`]);
      defaultAppCredentialStore.deleteOpenAIKey();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.getRawDb().close();
    }
  });

  it('distinguishes auth, quota, model_access, transient, timeout, cancellation, and stale outcomes while preserving history', async () => {
    const store = new TaskStore(dbPath);
    const cred = new AppCredentialStore(store);
    const key1 = 'sk-synth-test-key-alpha-111111111111';
    const key2 = 'sk-synth-test-key-beta-222222222222';

    let mode: 'ok' | 'auth' | 'quota' | 'model_access' | 'transient' | 'slow' = 'ok';
    let lastPayload: any = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d.toString()));
      req.on('end', () => {
        lastPayload = JSON.parse(body || '{}');
        if (mode === 'slow') {
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ id: 'resp_slow', object: 'response', output: [] }));
            }
          }, 500);
          return;
        }
        if (mode === 'auth') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${key1}`, type: 'invalid_request_error', code: 'invalid_api_key' } }));
          return;
        }
        if (mode === 'quota') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }));
          return;
        }
        if (mode === 'model_access') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'The model o3-mini does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } }));
          return;
        }
        if (mode === 'transient') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable', type: 'server_error' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'resp_ok', object: 'response', model: lastPayload.model, output: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      process.env.DUPOND_ALLOW_TEST_OPENAI_ENDPOINT = '1';
      process.env.DUPOND_OPENAI_TEST_BASE_URL = `http://127.0.0.1:${port}/v1`;
      cred.saveOpenAIKey(key1);

      // Passed test on o3-mini omits temperature/reasoning for model compatibility
      const passRes = await testOpenAIConnection({ store: cred, model: 'o3-mini' });
      assert.strictEqual(passRes.ok, true);
      assert.strictEqual(passRes.model, 'o3-mini');
      assert.strictEqual(lastPayload.model, 'o3-mini');
      assert.strictEqual(lastPayload.temperature, undefined);
      assert.strictEqual(lastPayload.reasoning, undefined);
      assert.strictEqual(getOpenAICredentialStatus(cred, { model: 'o3-mini' }).lastTestOutcome, 'passed');

      // Timeout preserves prior passed history
      mode = 'slow';
      const timeoutRes = await testOpenAIConnection({ store: cred, model: 'o3-mini', timeoutMs: 80 });
      assert.strictEqual(timeoutRes.ok, false);
      assert.strictEqual(timeoutRes.inconclusive, true);
      assert.strictEqual(timeoutRes.reason, 'timeout');
      assert.strictEqual(getOpenAICredentialStatus(cred, { model: 'o3-mini' }).lastTestOutcome, 'passed');

      // Cancellation preserves prior passed history
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 40);
      const cancelRes = await testOpenAIConnection({ store: cred, model: 'o3-mini', signal: ac.signal });
      assert.strictEqual(cancelRes.ok, false);
      assert.strictEqual(cancelRes.cancelled, true);
      assert.strictEqual(cancelRes.reason, 'cancelled');
      assert.strictEqual(getOpenAICredentialStatus(cred, { model: 'o3-mini' }).lastTestOutcome, 'passed');

      // Stale protection: replace key while slow request is in flight
      const inFlight = testOpenAIConnection({ store: cred, model: 'o3-mini', timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, 40));
      cred.saveOpenAIKey(key2);
      const staleRes = await inFlight;
      assert.strictEqual(staleRes.stale, true);
      assert.strictEqual(staleRes.outcome, 'stale');
      assert.strictEqual(getOpenAICredentialStatus(cred, { model: 'o3-mini' }).lastTestOutcome, null);

      // Auth, quota, model_access, transient distinctions + secret redaction
      mode = 'auth';
      const authRes = await testOpenAIConnection({ store: cred, model: 'gpt-4o-mini' });
      assert.strictEqual(authRes.reason, 'auth');
      assert.ok(!String(authRes.error).includes(key1));

      mode = 'quota';
      const quotaRes = await testOpenAIConnection({ store: cred, model: 'gpt-4o-mini' });
      assert.strictEqual(quotaRes.reason, 'quota');

      mode = 'model_access';
      const modelRes = await testOpenAIConnection({ store: cred, model: 'o3-mini' });
      assert.strictEqual(modelRes.reason, 'model_access');

      mode = 'transient';
      const transientRes = await testOpenAIConnection({ store: cred, model: 'gpt-4o-mini' });
      assert.strictEqual(transientRes.reason, 'transient');

      // Sanitizer helper + timeout bounds
      assert.ok(!sanitizeOpenAIError(`bad key ${key2} and sk-proj-abcdef1234567890`, key2).includes(key2));
      assert.ok(!sanitizeOpenAIError('Authorization: Bearer sk-proj-abcdef1234567890').includes('sk-proj-'));
      assert.strictEqual(resolveOpenAITestTimeoutMs(), OPENAI_TEST_DEFAULT_TIMEOUT_MS);
      assert.strictEqual(resolveOpenAITestTimeoutMs(1234), 1234);
      process.env.DUPOND_OPENAI_TEST_TIMEOUT_MS = '1';
      assert.strictEqual(resolveOpenAITestTimeoutMs(), OPENAI_TEST_MIN_TIMEOUT_MS);
      process.env.DUPOND_OPENAI_TEST_TIMEOUT_MS = '999999';
      assert.strictEqual(resolveOpenAITestTimeoutMs(), OPENAI_TEST_MAX_TIMEOUT_MS);
      delete process.env.DUPOND_OPENAI_TEST_TIMEOUT_MS;
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.getRawDb().close();
    }
  });

  it('rotates encryption key across both Gemini and OpenAI app_credentials and recovers cleanly', () => {
    const store = new TaskStore(dbPath);
    const cred = new AppCredentialStore(store);
    const geminiSecret = 'AIzaSyTestGeminiRotation1234567890';
    const openaiSecret = 'sk-synth-openai-rotation-1234567890';
    cred.saveGeminiKey(geminiSecret);
    cred.saveOpenAIKey(openaiSecret);
    store.getRawDb().close();

    const oldHex = getConnectionKey();
    const rotateResult = rotateConnectionKey({
      dbPath,
      keyPath,
    });
    assert.strictEqual(rotateResult.status, 'rotated');
    assert.strictEqual(rotateResult.rowCount, 2);
    const newHex = getConnectionKey();
    assert.notStrictEqual(newHex, oldHex);

    const storeAfter = new TaskStore(dbPath);
    const credAfter = new AppCredentialStore(storeAfter);
    assert.strictEqual(credAfter.getGeminiKey(), geminiSecret);
    assert.strictEqual(credAfter.getOpenAIKey(), openaiSecret);
    storeAfter.getRawDb().close();

    // Fault injection + forward recovery preserves OpenAI and Gemini credentials
    process.env.DUPOND_ROTATE_FAULT_STAGE = 'before_key_replace';
    try {
      assert.throws(() => rotateConnectionKey({ keyPath, dbPath }), /before_key_replace/);
    } finally {
      delete process.env.DUPOND_ROTATE_FAULT_STAGE;
    }

    const recovered = rotateConnectionKey({ keyPath, dbPath, recover: true });
    assert.strictEqual(recovered.status, 'recovered_forward');
    assert.strictEqual(recovered.rowCount, 2);

    const storeRecovered = new TaskStore(dbPath);
    const credRecovered = new AppCredentialStore(storeRecovered);
    assert.strictEqual(credRecovered.getGeminiKey(), geminiSecret);
    assert.strictEqual(credRecovered.getOpenAIKey(), openaiSecret);
    storeRecovered.getRawDb().close();

    // Maintenance lock paths exist without leaving stale lock
    const paths = connectionKeyMaintenancePaths(keyPath);
    assert.strictEqual(fs.existsSync(paths.lockPath), false);
  });

  it('enforces provider-level cross-model ordering atomically across restarts and supports custom model IDs', async () => {
    const store = new TaskStore(dbPath);
    const cred = new AppCredentialStore(store);
    const key = 'sk-synth-openai-ordering-1234567890';
    cred.saveOpenAIKey(key);

    let releaseModelA!: () => void;
    const modelAGate = new Promise<void>((r) => (releaseModelA = r));
    const observedModels: string[] = [];

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d.toString()));
      req.on('end', async () => {
        const parsed = JSON.parse(body || '{}');
        observedModels.push(parsed.model);
        if (parsed.model === 'gpt-4o-mini') {
          await modelAGate;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'late failure', code: 'invalid_api_key' } }));
          return;
        }
        if (parsed.model === 'unknown-custom-model') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'The model unknown-custom-model does not exist', code: 'model_not_found' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'resp_order', object: 'response', model: parsed.model, output: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      process.env.DUPOND_ALLOW_TEST_OPENAI_ENDPOINT = '1';
      process.env.DUPOND_OPENAI_TEST_BASE_URL = `http://127.0.0.1:${port}/v1`;

      // Invalid/malformed model identifiers are rejected by bounded validation
      const blankModelRes = await testOpenAIConnection({ store: cred, model: '   ' });
      assert.strictEqual(blankModelRes.ok, false);
      assert.strictEqual(blankModelRes.reason, 'model_access');
      const spaceModelRes = await testOpenAIConnection({ store: cred, model: 'gpt 4o' });
      assert.strictEqual(spaceModelRes.ok, false);
      assert.strictEqual(spaceModelRes.reason, 'model_access');
      const overlongModelRes = await testOpenAIConnection({ store: cred, model: 'm'.repeat(129) });
      assert.strictEqual(overlongModelRes.ok, false);
      assert.strictEqual(overlongModelRes.reason, 'model_access');

      // Custom model rejected by provider reports model_access and records tested model
      const providerRejectRes = await testOpenAIConnection({ store: cred, model: 'unknown-custom-model' });
      assert.strictEqual(providerRejectRes.ok, false);
      assert.strictEqual(providerRejectRes.reason, 'model_access');
      assert.strictEqual(getOpenAICredentialStatus(cred).lastTestModel, 'unknown-custom-model');

      // Cross-model ordering: Model A starts first, Model B (custom model) starts second and finishes first
      const testAPromise = testOpenAIConnection({ store: cred, model: 'gpt-4o-mini' });
      await new Promise((r) => setTimeout(r, 30));
      const testBRes = await testOpenAIConnection({ store: cred, model: 'gpt-4.1-mini' });
      assert.strictEqual(testBRes.ok, true);
      assert.strictEqual(testBRes.model, 'gpt-4.1-mini');

      // Now Model A finishes late -> must be rejected as stale and MUST NOT overwrite Model B
      releaseModelA();
      const testARes = await testAPromise;
      assert.strictEqual(testARes.stale, true);
      assert.strictEqual(testARes.outcome, 'stale');

      const statusAfterRace = getOpenAICredentialStatus(cred);
      assert.strictEqual(statusAfterRace.lastTestModel, 'gpt-4.1-mini');
      assert.strictEqual(statusAfterRace.lastTestOutcome, 'passed');

      // Simulate restart: reopen DB and verify newer custom model test allocates higher seq and succeeds
      const snap = cred.getOpenAIKeySnapshot()!;
      const staleSqlWrite = cred.recordOpenAITestResultIfCurrent({
        expectedVersion: snap.credentialVersion,
        expectedFingerprint: snap.keyFingerprint,
        expectedModel: 'gpt-4o-mini',
        testSeq: 1,
        outcome: 'failed',
        error: 'stale seq 1',
      });
      assert.strictEqual(staleSqlWrite, false);

      store.getRawDb().close();
      const storeRestarted = new TaskStore(dbPath);
      const credRestarted = new AppCredentialStore(storeRestarted);
      assert.strictEqual(getOpenAICredentialStatus(credRestarted).lastTestModel, 'gpt-4.1-mini');

      const postRestartRes = await testOpenAIConnection({ store: credRestarted, model: 'ft:gpt-4o-mini:acme:custom:1' });
      assert.strictEqual(postRestartRes.ok, true);
      assert.strictEqual(getOpenAICredentialStatus(credRestarted).lastTestModel, 'ft:gpt-4o-mini:acme:custom:1');
      assert.ok(observedModels.includes('gpt-4.1-mini'));
      assert.ok(observedModels.includes('ft:gpt-4o-mini:acme:custom:1'));
      storeRestarted.getRawDb().close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
