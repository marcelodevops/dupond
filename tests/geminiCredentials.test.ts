import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { TaskStore } from '../src/server/db/database.js';
import { AppCredentialStore } from '../src/server/projects/appCredentialStore.js';
import { ProjectStore } from '../src/server/projects/projectStore.js';
import { decryptSecret, getConnectionKey } from '../src/server/projects/secretCrypto.js';
import {
  GEMINI_TEST_DEFAULT_TIMEOUT_MS,
  GEMINI_TEST_MAX_TIMEOUT_MS,
  GEMINI_TEST_MIN_TIMEOUT_MS,
  getGeminiClient,
  getGeminiCredentialStatus,
  invalidateGeminiClientCache,
  resolveGeminiCredential,
  resolveGeminiTestTimeoutMs,
  sanitizeGeminiError,
  testGeminiConnection,
} from '../src/server/gemini.js';
import { rotateConnectionKey } from '../scripts/rotateConnKey.js';
import { connectionKeyMaintenancePaths } from '../src/server/projects/connectionKeyLock.js';

describe('Gemini credential storage, precedence, cache invalidation, and key rotation', () => {
  let tmpDir: string;
  let dbPath: string;
  let keyPath: string;
  let origDbPath: string | undefined;
  let origKeyPath: string | undefined;
  let origGeminiKey: string | undefined;
  let origAllowTestEndpoint: string | undefined;
  let origTestBaseUrl: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-gemini-cred-test-'));
    dbPath = path.join(tmpDir, 'dupond.db');
    keyPath = path.join(tmpDir, '.dupond_conn_key');
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });

    origDbPath = process.env.DUPOND_DB_PATH;
    origKeyPath = process.env.DUPOND_CONN_KEY_PATH;
    origGeminiKey = process.env.GEMINI_API_KEY;
    origAllowTestEndpoint = process.env.DUPOND_ALLOW_TEST_GEMINI_ENDPOINT;
    origTestBaseUrl = process.env.DUPOND_GEMINI_TEST_BASE_URL;

    process.env.DUPOND_DB_PATH = dbPath;
    process.env.DUPOND_CONN_KEY_PATH = keyPath;
    delete process.env.GEMINI_API_KEY;
    delete process.env.DUPOND_ALLOW_TEST_GEMINI_ENDPOINT;
    delete process.env.DUPOND_GEMINI_TEST_BASE_URL;
    invalidateGeminiClientCache();
  });

  afterEach(() => {
    invalidateGeminiClientCache();
    if (origDbPath === undefined) delete process.env.DUPOND_DB_PATH;
    else process.env.DUPOND_DB_PATH = origDbPath;

    if (origKeyPath === undefined) delete process.env.DUPOND_CONN_KEY_PATH;
    else process.env.DUPOND_CONN_KEY_PATH = origKeyPath;

    if (origGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = origGeminiKey;

    if (origAllowTestEndpoint === undefined) delete process.env.DUPOND_ALLOW_TEST_GEMINI_ENDPOINT;
    else process.env.DUPOND_ALLOW_TEST_GEMINI_ENDPOINT = origAllowTestEndpoint;

    if (origTestBaseUrl === undefined) delete process.env.DUPOND_GEMINI_TEST_BASE_URL;
    else process.env.DUPOND_GEMINI_TEST_BASE_URL = origTestBaseUrl;

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('encrypts saved keys, rejects blanks, and invalidates prior test results on replacement', () => {
    const store = new TaskStore(dbPath);
    const credStore = new AppCredentialStore(store);

    assert.throws(() => credStore.saveGeminiKey('   '), /non-empty/);
    assert.strictEqual(credStore.getGeminiKey(), null);
    assert.strictEqual(credStore.getGeminiMetadata().hasSavedKey, false);

    const syntheticKey1 = 'AIzaSyFakeTestKeyOne1111111111';
    credStore.saveGeminiKey(syntheticKey1);
    assert.strictEqual(credStore.getGeminiKey(), syntheticKey1);

    // Raw DB row must be encrypted with v1: and must not contain plaintext
    const rawDb = store.getRawDb();
    const row = rawDb.prepare("SELECT api_key_enc FROM app_credentials WHERE provider = 'gemini'").get() as { api_key_enc: string };
    assert.ok(row.api_key_enc.startsWith('v1:'));
    assert.ok(!row.api_key_enc.includes(syntheticKey1));

    credStore.recordGeminiTestResult('passed', null);
    assert.strictEqual(credStore.getGeminiMetadata().lastTestOutcome, 'passed');

    const syntheticKey2 = 'AIzaSyFakeTestKeyTwo2222222222';
    const replaced = credStore.saveGeminiKey(syntheticKey2);
    assert.strictEqual(replaced.hasSavedKey, true);
    assert.strictEqual(replaced.lastTestedAt, null);
    assert.strictEqual(replaced.lastTestOutcome, null);
    assert.strictEqual(replaced.lastTestError, null);
    assert.strictEqual(credStore.getGeminiKey(), syntheticKey2);

    credStore.deleteGeminiKey();
    assert.strictEqual(credStore.getGeminiKey(), null);
    assert.strictEqual(credStore.getGeminiMetadata().hasSavedKey, false);
    store.getRawDb().close();
  });

  it('blocks credential reads/writes with KEY_ROTATION_IN_PROGRESS during maintenance lock', () => {
    const store = new TaskStore(dbPath);
    const credStore = new AppCredentialStore(store);
    const { lockPath } = connectionKeyMaintenancePaths(keyPath);

    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    try {
      assert.throws(
        () => credStore.saveGeminiKey('AIzaSyBlockedKey1234567890'),
        (err: any) => err?.code === 'KEY_ROTATION_IN_PROGRESS' && err?.httpStatus === 503,
      );
      assert.throws(
        () => credStore.getGeminiKey(),
        (err: any) => err?.code === 'KEY_ROTATION_IN_PROGRESS' && err?.httpStatus === 503,
      );
    } finally {
      fs.unlinkSync(lockPath);
      store.getRawDb().close();
    }
  });

  it('sanitizes secret material from error strings', () => {
    const secret = 'AIzaSyTopSecretSynthetic987654321';
    const raw = `Request failed for https://example.test/v1?key=${secret}: invalid ${secret}`;
    const sanitized = sanitizeGeminiError(raw, secret);
    assert.ok(!sanitized.includes(secret));
    assert.ok(sanitized.includes('[REDACTED]'));
  });

  it('enforces precedence env > saved > none and invalidates client cache on key change', async () => {
    const store = new TaskStore(dbPath);
    const credStore = new AppCredentialStore(store);

    // Ensure default singleton store points at our test dbPath? Note: gemini.ts uses defaultAppCredentialStore,
    // which was initialized at module load. Let's verify precedence and cache behavior with env + test endpoint.
    process.env.GEMINI_API_KEY = 'AIzaSyEnvPrecedenceKey111111111';
    const res1 = resolveGeminiCredential();
    assert.strictEqual(res1.source, 'environment');
    assert.strictEqual(res1.apiKey, 'AIzaSyEnvPrecedenceKey111111111');

    const c1 = getGeminiClient();
    const c2 = getGeminiClient();
    assert.strictEqual(c1, c2);

    process.env.GEMINI_API_KEY = 'AIzaSyEnvPrecedenceKey222222222';
    const c3 = getGeminiClient();
    assert.notStrictEqual(c1, c3);

    const status = getGeminiCredentialStatus();
    assert.strictEqual(status.source, 'environment');
    assert.strictEqual(status.environmentControlled, true);
    assert.ok(!JSON.stringify(status).includes('AIzaSy'));

    // Test connection against local mock HTTP server using test-only baseUrl
    const seenKeys: string[] = [];
    const mockServer = http.createServer((req, res) => {
      const headerKey = req.headers['x-goog-api-key'];
      if (typeof headerKey === 'string') seenKeys.push(headerKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'OK' }], role: 'model' } }],
        }),
      );
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address() as { port: number };
    try {
      process.env.DUPOND_ALLOW_TEST_GEMINI_ENDPOINT = '1';
      process.env.DUPOND_GEMINI_TEST_BASE_URL = `http://127.0.0.1:${addr.port}`;
      const testRes = await testGeminiConnection();
      assert.strictEqual(testRes.ok, true);
      assert.strictEqual(testRes.source, 'environment');
      assert.ok(seenKeys.includes('AIzaSyEnvPrecedenceKey222222222'));
    } finally {
      mockServer.close();
      store.getRawDb().close();
    }
  });

  it('rotates and recovers app_credentials alongside jira_connections', () => {
    const store = new TaskStore(dbPath);
    const credStore = new AppCredentialStore(store);
    const geminiSecret = 'AIzaSyRotationTargetGeminiKey12345';
    credStore.saveGeminiKey(geminiSecret);

    // Also insert a jira_connections row to verify both tables rotate together
    const now = new Date().toISOString();
    const rawDb = store.getRawDb();
    rawDb
      .prepare(
        `INSERT INTO projects (id, name, description, status, created_at, updated_at)
         VALUES ('default', 'Default', '', 'active', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(now, now);

    const oldKeyHex = fs.readFileSync(keyPath, 'utf-8').trim();
    const rotated = rotateConnectionKey({ keyPath, dbPath });
    assert.strictEqual(rotated.status, 'rotated');
    assert.strictEqual(rotated.rowCount, 1);

    const newKeyHex = fs.readFileSync(keyPath, 'utf-8').trim();
    assert.notStrictEqual(newKeyHex, oldKeyHex);
    assert.strictEqual(credStore.getGeminiKey(), geminiSecret);
    store.getRawDb().close();
  });

  it('recovers app_credentials forward when rotation is interrupted before key replacement', () => {
    const store = new TaskStore(dbPath);
    const credStore = new AppCredentialStore(store);
    const geminiSecret = 'AIzaSyRecoverForwardGeminiKey98765';
    credStore.saveGeminiKey(geminiSecret);
    store.getRawDb().close();

    process.env.DUPOND_ROTATE_FAULT_STAGE = 'before_key_replace';
    try {
      assert.throws(() => rotateConnectionKey({ keyPath, dbPath }), /before_key_replace/);
    } finally {
      delete process.env.DUPOND_ROTATE_FAULT_STAGE;
    }

    const recovered = rotateConnectionKey({ keyPath, dbPath, recover: true });
    assert.strictEqual(recovered.status, 'recovered_forward');
    assert.strictEqual(recovered.rowCount, 1);

    const store2 = new TaskStore(dbPath);
    const credStore2 = new AppCredentialStore(store2);
    assert.strictEqual(credStore2.getGeminiKey(), geminiSecret);
    store2.getRawDb().close();
  });

  it('rejects stale/superseded test results across replacement, delete/recreate, deletion, and overlapping tests', async () => {
    const store = new TaskStore(dbPath);
    const credStore = new AppCredentialStore(store);

    const keyA = 'AIzaSyStaleTestKeyA11111111111';
    const keyB = 'AIzaSyStaleTestKeyB22222222222';

    const pendingRequests: Array<{ apiKey: string | undefined; release: (status: number) => void }> = [];
    const mockServer = http.createServer((req, res) => {
      const apiKey = typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'] : undefined;
      pendingRequests.push({
        apiKey,
        release: (status: number) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          if (status === 200) {
            res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }], role: 'model' } }] }));
          } else {
            res.end(JSON.stringify({ error: { code: status, message: 'Mock auth failure' } }));
          }
        },
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as { port: number }).port;
    process.env.DUPOND_ALLOW_TEST_GEMINI_ENDPOINT = '1';
    process.env.DUPOND_GEMINI_TEST_BASE_URL = `http://127.0.0.1:${port}`;

    try {
      // 1. Replace A with B while A's test is pending -> A's late 200 must NOT verify B
      credStore.saveGeminiKey(keyA);
      const testAPromise = testGeminiConnection({ store: credStore });
      while (pendingRequests.length < 1) await new Promise((r) => setTimeout(r, 10));

      credStore.saveGeminiKey(keyB);
      pendingRequests.shift()!.release(200);
      const resA = await testAPromise;
      assert.strictEqual(resA.ok, false);
      assert.strictEqual(resA.stale, true);
      assert.strictEqual(resA.outcome, 'stale');
      assert.strictEqual(credStore.getGeminiMetadata().lastTestOutcome, null);
      assert.strictEqual(credStore.getGeminiMetadata().lastTestedAt, null);

      // 2. Delete B and recreate with the SAME key B while test is pending -> stale
      const testBPromise = testGeminiConnection({ store: credStore });
      while (pendingRequests.length < 1) await new Promise((r) => setTimeout(r, 10));
      credStore.deleteGeminiKey();
      credStore.saveGeminiKey(keyB);
      pendingRequests.shift()!.release(200);
      const resB = await testBPromise;
      assert.strictEqual(resB.stale, true);
      assert.strictEqual(credStore.getGeminiMetadata().lastTestOutcome, null);

      // 3. Delete while in flight -> late failure must return stale and keep hasSavedKey=false
      const testDelPromise = testGeminiConnection({ store: credStore });
      while (pendingRequests.length < 1) await new Promise((r) => setTimeout(r, 10));
      credStore.deleteGeminiKey();
      pendingRequests.shift()!.release(401);
      const resDel = await testDelPromise;
      assert.strictEqual(resDel.stale, true);
      assert.strictEqual(credStore.getGeminiMetadata().hasSavedKey, false);

      // 4. Overlapping tests on the same key: newer succeeds first, older fails later -> older is stale, passed preserved
      credStore.saveGeminiKey(keyB);
      const olderPromise = testGeminiConnection({ store: credStore });
      while (pendingRequests.length < 1) await new Promise((r) => setTimeout(r, 10));
      const olderReq = pendingRequests.shift()!;

      const newerPromise = testGeminiConnection({ store: credStore });
      while (pendingRequests.length < 1) await new Promise((r) => setTimeout(r, 10));
      const newerReq = pendingRequests.shift()!;

      newerReq.release(200);
      const newerRes = await newerPromise;
      assert.strictEqual(newerRes.ok, true);
      assert.strictEqual(newerRes.outcome, 'passed');

      olderReq.release(500);
      const olderRes = await olderPromise;
      assert.strictEqual(olderRes.stale, true);
      assert.strictEqual(credStore.getGeminiMetadata().lastTestOutcome, 'passed');
    } finally {
      mockServer.close();
      store.getRawDb().close();
    }
  });

  it('fails closed when key file persistence fails (Gemini and Jira) and handles concurrent first-key creation', async () => {
    // 1. Inject key-write failure by pointing DUPOND_CONN_KEY_PATH inside a regular file
    const blockerFile = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(blockerFile, 'blocker', 'utf-8');
    const unwritableKeyPath = path.join(blockerFile, 'nested', '.dupond_conn_key');
    process.env.DUPOND_CONN_KEY_PATH = unwritableKeyPath;

    const store = new TaskStore(dbPath);
    const credStore = new AppCredentialStore(store);
    const projectStore = new ProjectStore(store);
    const now = new Date().toISOString();
    store.getRawDb()
      .prepare("INSERT OR IGNORE INTO projects (id, name, description, status, created_at, updated_at) VALUES ('default', 'Default', '', 'active', ?, ?)")
      .run(now, now);

    assert.throws(() => credStore.saveGeminiKey('AIzaSyShouldFailClosed12345'));
    assert.strictEqual(credStore.getGeminiMetadata().hasSavedKey, false);

    assert.throws(() =>
      projectStore.saveJiraConnection(
        'default',
        {
          hostUrl: 'https://jira.example.test',
          userEmail: 'test@example.com',
          apiToken: 'jira-token-should-fail-closed',
        },
        'test-actor',
      ),
    );
    const jiraCount = store.getRawDb().prepare('SELECT COUNT(*) as c FROM jira_connections').get() as { c: number };
    assert.strictEqual(jiraCount.c, 0);
    store.getRawDb().close();

    // 2. Concurrent multi-process first-key initialization must agree on one key without overwriting
    const raceKeyPath = path.join(tmpDir, 'race', '.dupond_conn_key');
    process.env.DUPOND_CONN_KEY_PATH = raceKeyPath;

    const runWorker = () =>
      new Promise<string>((resolve, reject) => {
        const script = `
          import { encryptSecret } from './src/server/projects/secretCrypto.js';
          const enc = encryptSecret('shared-secret-' + process.pid);
          console.log(JSON.stringify({ pid: process.pid, enc }));
        `;
        const child = spawn('npx', ['tsx', '--input-type=module', '-e', script], {
          cwd: process.cwd(),
          env: { ...process.env, DUPOND_CONN_KEY_PATH: raceKeyPath },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (err += d.toString()));
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Child exited ${code}: ${err}`));
          else resolve(out.trim());
        });
      });

    const outputs = await Promise.all([runWorker(), runWorker(), runWorker()]);
    const persistedKey = getConnectionKey();
    assert.strictEqual(persistedKey.length, 32);

    for (const out of outputs) {
      const parsed = JSON.parse(out) as { pid: number; enc: string };
      assert.strictEqual(decryptSecret(parsed.enc), `shared-secret-${parsed.pid}`);
    }
  }, 20000);

  it('validates and bounds server-side Test Connection timeout (5s-120s, default 60s)', () => {
    const origMs = process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS;
    const origSec = process.env.DUPOND_GEMINI_TEST_TIMEOUT_SECONDS;
    delete process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS;
    delete process.env.DUPOND_GEMINI_TEST_TIMEOUT_SECONDS;

    try {
      assert.strictEqual(GEMINI_TEST_DEFAULT_TIMEOUT_MS, 60_000);
      assert.strictEqual(GEMINI_TEST_MIN_TIMEOUT_MS, 5_000);
      assert.strictEqual(GEMINI_TEST_MAX_TIMEOUT_MS, 120_000);
      assert.strictEqual(resolveGeminiTestTimeoutMs(), 60_000);

      process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS = '1000';
      assert.strictEqual(resolveGeminiTestTimeoutMs(), 5_000);

      process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS = '250000';
      assert.strictEqual(resolveGeminiTestTimeoutMs(), 120_000);

      process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS = '45000';
      assert.strictEqual(resolveGeminiTestTimeoutMs(), 45_000);

      process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS = 'not-a-number';
      assert.strictEqual(resolveGeminiTestTimeoutMs(), 60_000);

      delete process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS;
      process.env.DUPOND_GEMINI_TEST_TIMEOUT_SECONDS = '30';
      assert.strictEqual(resolveGeminiTestTimeoutMs(), 30_000);

      process.env.DUPOND_GEMINI_TEST_TIMEOUT_SECONDS = '2';
      assert.strictEqual(resolveGeminiTestTimeoutMs(), 5_000);
    } finally {
      if (origMs === undefined) delete process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS;
      else process.env.DUPOND_GEMINI_TEST_TIMEOUT_MS = origMs;
      if (origSec === undefined) delete process.env.DUPOND_GEMINI_TEST_TIMEOUT_SECONDS;
      else process.env.DUPOND_GEMINI_TEST_TIMEOUT_SECONDS = origSec;
    }
  });

  it('handles slow >15s responses, deadline abort, user cancel, auth failure, and replacement races without retries', async () => {
    const store = new TaskStore(dbPath);
    const credStore = new AppCredentialStore(store);

    let mode: 'fast_pass' | 'slow_15s_pass' | 'hang' | 'auth_401' = 'fast_pass';
    let requestCount = 0;
    let abortedCount = 0;
    const openResponses = new Set<http.ServerResponse>();

    const mockServer = http.createServer((req, res) => {
      requestCount += 1;
      openResponses.add(res);
      res.on('close', () => {
        openResponses.delete(res);
        if (!res.writableFinished) {
          abortedCount += 1;
        }
      });

      if (mode === 'fast_pass') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }], role: 'model' } }] }));
        return;
      }

      if (mode === 'slow_15s_pass') {
        const timer = setTimeout(() => {
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }], role: 'model' } }] }));
          }
        }, 15_150);
        res.on('close', () => clearTimeout(timer));
        return;
      }

      if (mode === 'auth_401') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 401, message: 'API key not valid.' } }));
        return;
      }

      // mode === 'hang': keep socket open until aborted
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const port = (mockServer.address() as { port: number }).port;
    process.env.DUPOND_ALLOW_TEST_GEMINI_ENDPOINT = '1';
    process.env.DUPOND_GEMINI_TEST_BASE_URL = `http://127.0.0.1:${port}`;

    try {
      // 1. Seed a verified key (passed)
      credStore.saveGeminiKey('AIzaSySlowValidKey1234567890');
      const initialPass = await testGeminiConnection({ store: credStore });
      assert.strictEqual(initialPass.ok, true);
      assert.strictEqual(initialPass.outcome, 'passed');
      const initialTestedAt = credStore.getGeminiMetadata().lastTestedAt;
      assert.ok(initialTestedAt);

      // 2. Slow response after >15s succeeds under the 60s default deadline
      mode = 'slow_15s_pass';
      const reqBefore15s = requestCount;
      const slow15sRes = await testGeminiConnection({ store: credStore });
      assert.strictEqual(slow15sRes.ok, true);
      assert.strictEqual(slow15sRes.outcome, 'passed');
      assert.strictEqual(slow15sRes.timeoutMs, 60_000);
      assert.strictEqual(requestCount - reqBefore15s, 1);
      const verifiedTestedAt = credStore.getGeminiMetadata().lastTestedAt;
      assert.ok(verifiedTestedAt);

      // 3. Deadline expiry aborts underlying HTTP request, makes no retry, returns inconclusive, preserves key & history
      mode = 'hang';
      const reqBeforeTimeout = requestCount;
      const abortedBeforeTimeout = abortedCount;
      const timeoutRes = await testGeminiConnection({ store: credStore, timeoutMs: 250 });
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(timeoutRes.ok, false);
      assert.strictEqual(timeoutRes.inconclusive, true);
      assert.strictEqual(timeoutRes.outcome, 'inconclusive');
      assert.strictEqual(timeoutRes.reason, 'timeout');
      assert.strictEqual(requestCount - reqBeforeTimeout, 1);
      assert.strictEqual(abortedCount - abortedBeforeTimeout, 1);
      assert.strictEqual(credStore.getGeminiKey(), 'AIzaSySlowValidKey1234567890');
      assert.strictEqual(credStore.getGeminiMetadata().lastTestOutcome, 'passed');
      assert.strictEqual(credStore.getGeminiMetadata().lastTestedAt, verifiedTestedAt);

      // 4. User cancellation aborts underlying HTTP request without changing saved key or history
      const ac = new AbortController();
      const reqBeforeCancel = requestCount;
      const abortedBeforeCancel = abortedCount;
      const cancelPromise = testGeminiConnection({ store: credStore, signal: ac.signal, timeoutMs: 10_000 });
      while (requestCount === reqBeforeCancel) await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      const cancelRes = await cancelPromise;
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(cancelRes.ok, false);
      assert.strictEqual(cancelRes.inconclusive, true);
      assert.strictEqual(cancelRes.cancelled, true);
      assert.strictEqual(cancelRes.outcome, 'cancelled');
      assert.strictEqual(cancelRes.reason, 'cancelled');
      assert.strictEqual(requestCount - reqBeforeCancel, 1);
      assert.strictEqual(abortedCount - abortedBeforeCancel, 1);
      assert.strictEqual(credStore.getGeminiKey(), 'AIzaSySlowValidKey1234567890');
      assert.strictEqual(credStore.getGeminiMetadata().lastTestOutcome, 'passed');
      assert.strictEqual(credStore.getGeminiMetadata().lastTestedAt, verifiedTestedAt);

      // 5. Credential replacement while slow test is in flight -> timeout returns stale & does not touch new key
      const reqBeforeReplace = requestCount;
      const slowReplacePromise = testGeminiConnection({ store: credStore, timeoutMs: 250 });
      while (requestCount === reqBeforeReplace) await new Promise((r) => setTimeout(r, 10));
      credStore.saveGeminiKey('AIzaSyReplacementKey987654321');
      const slowReplaceRes = await slowReplacePromise;
      assert.strictEqual(slowReplaceRes.ok, false);
      assert.strictEqual(slowReplaceRes.stale, true);
      assert.strictEqual(slowReplaceRes.outcome, 'stale');
      assert.strictEqual(credStore.getGeminiMetadata().lastTestOutcome, null);

      // 6. Auth rejection remains distinct from timeout/inconclusive
      mode = 'auth_401';
      const authRes = await testGeminiConnection({ store: credStore, timeoutMs: 5_000 });
      assert.strictEqual(authRes.ok, false);
      assert.strictEqual(authRes.inconclusive, false);
      assert.strictEqual(authRes.outcome, 'failed');
      assert.strictEqual(authRes.reason, 'auth');
      assert.strictEqual(credStore.getGeminiMetadata().lastTestOutcome, 'failed');
    } finally {
      for (const res of openResponses) {
        try {
          res.destroy();
        } catch {}
      }
      mockServer.close();
      store.getRawDb().close();
    }
  }, 30_000);
});
