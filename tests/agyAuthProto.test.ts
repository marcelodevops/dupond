import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  AgyAuthError,
  AgyAuthSessionManager,
  probeAgyProfileModels,
  resolveAgyProfileDir,
  validateSubmittedAuthCode,
  verifyAgySandboxPortability,
} from '../src/server/worker/agyAuthManager.js';

function createFakeAgyBin(dir: string): string {
  const binPath = path.join(dir, 'fake-agy');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE || 'success';
const homeDir = process.env.HOME;
const tokenFile = path.join(homeDir, '.gemini', 'jetski-standalone-oauth-token');

if (args.includes('--version')) {
  console.log('1.5.11');
  process.exit(0);
}

if (args[0] === 'models') {
  if (fs.existsSync(tokenFile)) {
    console.log('gemini-4-neon-high              Gemini 4 Neon (High)');
    console.log('gemini-3.8-flash-medium         Gemini 3.8 Flash (Medium)');
    process.exit(0);
  }
  console.error('Error: Please sign in to view available models.');
  process.exit(1);
}

// Login-only no-args TUI simulation
if (args.length === 0) {
  if (mode === 'startup_fail') {
    console.error('RAW_PTY_SECRET_STARTUP_FAILURE');
    process.exit(1);
  }
  process.stdout.write('Welcome to Antigravity CLI\\nSelect login method:\\n> 1. Google OAuth\\n');
  let step = 'method';
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    if (step === 'method' && (buf.includes('\\r') || buf.includes('\\n'))) {
      buf = '';
      step = 'code';
      process.stdout.write(
        'https://accounts.google.com/o/oauth2/auth?client_id=test-client&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=abc123\\n' +
        'If you are not automatically redirected, paste the authorization code below:\\n'
      );
      return;
    }
    if (step === 'code' && (buf.includes('\\r') || buf.includes('\\n'))) {
      const code = buf.trim();
      // Deliberately echo submitted code to PTY to prove Dupond never leaks PTY echo
      process.stdout.write('ECHO_SECRET_CODE:' + code + '\\n');
      if (mode === 'bad_code' || code === 'BAD_CODE') {
        process.stdout.write('Got an error: token exchange failed: oauth2: "invalid_grant" "Bad Request"\\n');
        return;
      }
      if (mode === 'slow_exchange') {
        setTimeout(() => {
          fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
          fs.writeFileSync(tokenFile, JSON.stringify({ token: 'synth-oauth-token', auth_method: 'oauth' }), { mode: 0o600 });
        }, 400);
        return;
      }
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({ token: 'synth-oauth-token', auth_method: 'oauth' }), { mode: 0o600 });
    }
  });
}
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return binPath;
}

describe('Antigravity CLI (agy) PTY authentication prototype', () => {
  let tmpDir: string;
  let profileDir: string;
  let fakeBin: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupond-agy-auth-'));
    profileDir = path.join(tmpDir, 'agy-profile');
    fakeBin = createFakeAgyBin(tmpDir);

    origEnv = {
      DUPOND_AGY_BIN: process.env.DUPOND_AGY_BIN,
      DUPOND_AGY_PROFILE_DIR: process.env.DUPOND_AGY_PROFILE_DIR,
      DUPOND_AGY_AUTH_TTL_MS: process.env.DUPOND_AGY_AUTH_TTL_MS,
      FAKE_AGY_MODE: process.env.FAKE_AGY_MODE,
    };
    process.env.DUPOND_AGY_BIN = fakeBin;
    process.env.DUPOND_AGY_PROFILE_DIR = profileDir;
    delete process.env.DUPOND_AGY_AUTH_TTL_MS;
    delete process.env.FAKE_AGY_MODE;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a 0700 dedicated profile, enforces session binding, replay, CR/LF validation, and PTY echo secrecy', async () => {
    const mgr = new AgyAuthSessionManager();
    const tokenA = 'operator-token-A';
    const tokenB = 'operator-token-B';

    const dir = resolveAgyProfileDir();
    assert.strictEqual(dir, profileDir);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
    }

    // CR/LF and control characters rejected before PTY write
    assert.throws(() => validateSubmittedAuthCode('abc\ndef'), AgyAuthError);
    assert.throws(() => validateSubmittedAuthCode('abc\rdef'), AgyAuthError);
    assert.throws(() => validateSubmittedAuthCode('abc\x00def'), AgyAuthError);

    const session = await mgr.startLogin(tokenA);
    assert.ok(session);
    assert.strictEqual(session.state, 'awaiting_code');
    assert.ok(session.authUrl?.startsWith('https://accounts.google.com/o/oauth2/auth?'));

    // Operator B cannot view or submit Operator A's pending session
    const statusB = mgr.getStatus(tokenB);
    assert.strictEqual(statusB.session, null);
    await assert.rejects(
      () => mgr.submitCode(tokenB, session.loginSessionId, 'SYNTH_AUTH_CODE_SECRET'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 403,
    );

    // Mismatched session ID rejected (and simulates restart invalidation)
    await assert.rejects(
      () => mgr.submitCode(tokenA, 'wrong-session-id', 'SYNTH_AUTH_CODE_SECRET'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 404,
    );

    // Server restart creates a fresh AgyAuthSessionManager -> previous loginSessionId is rejected clearly
    const restartedMgr = new AgyAuthSessionManager();
    await assert.rejects(
      () => restartedMgr.submitCode(tokenA, session.loginSessionId, 'SYNTH_AUTH_CODE_SECRET'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 404 && /server restart/i.test(err.message),
    );

    // Concurrent / replay submission prevented
    process.env.FAKE_AGY_MODE = 'slow_exchange';
    const mgr2 = new AgyAuthSessionManager();
    const s2 = await mgr2.startLogin(tokenA);
    assert.ok(s2);
    const submit1 = mgr2.submitCode(tokenA, s2.loginSessionId, 'SYNTH_AUTH_CODE_SECRET_123');
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(
      () => mgr2.submitCode(tokenA, s2.loginSessionId, 'REPLAY_CODE'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 409,
    );
    const res1 = await submit1;
    assert.strictEqual(res1.authenticated, true);
    assert.strictEqual(res1.modelsCount, 2);

    // PTY echo secrecy: neither status nor response contains the submitted code or ECHO_SECRET_CODE
    const postStatus = mgr2.getStatus(tokenA);
    assert.strictEqual(postStatus.profileAuthenticated, true);
    assert.ok(!JSON.stringify(res1).includes('SYNTH_AUTH_CODE_SECRET_123'));
    assert.ok(!JSON.stringify(postStatus).includes('SYNTH_AUTH_CODE_SECRET_123'));
    assert.ok(!JSON.stringify(postStatus).includes('ECHO_SECRET_CODE'));

    // Replay after completion is rejected
    await assert.rejects(
      () => mgr2.submitCode(tokenA, s2.loginSessionId, 'REPLAY_AFTER_COMPLETE'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 409,
    );

    // Dedicated profile + SandboxExecutor portability check with fake CLI
    const modelsCheck = probeAgyProfileModels(profileDir, fakeBin);
    assert.strictEqual(modelsCheck.authenticated, true);

    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const sbCheck = await verifyAgySandboxPortability(profileDir, repoDir);
    assert.strictEqual(sbCheck.ok, true, `Expected sandbox portability check to pass, got: ${sbCheck.error}`);
    assert.strictEqual(sbCheck.modelsCount, 2);
  });

  it('handles expiry, cancellation, bad codes, and startup failures cleanly without leaking PTY output', async () => {
    const token = 'operator-token-C';

    // 1. Startup failure does not leak raw PTY output
    process.env.FAKE_AGY_MODE = 'startup_fail';
    const mgrFail = new AgyAuthSessionManager();
    await assert.rejects(
      () => mgrFail.startLogin(token),
      (err: any) => err instanceof AgyAuthError && !err.message.includes('RAW_PTY_SECRET_STARTUP_FAILURE'),
    );

    // 2. Cancellation terminates PTY process and rejects subsequent submission
    delete process.env.FAKE_AGY_MODE;
    const mgrCancel = new AgyAuthSessionManager();
    const sCancel = await mgrCancel.startLogin(token);
    assert.ok(sCancel);
    await mgrCancel.cancelLogin(token, sCancel.loginSessionId);
    assert.strictEqual(mgrCancel.getStatus(token).session?.state, 'cancelled');
    await assert.rejects(
      () => mgrCancel.submitCode(token, sCancel.loginSessionId, 'LATE_CODE'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 409,
    );

    // 3. Expiry rejects late submission with 410
    process.env.DUPOND_AGY_AUTH_TTL_MS = '600';
    const mgrExp = new AgyAuthSessionManager();
    const sExp = await mgrExp.startLogin(token);
    assert.ok(sExp);
    await new Promise((r) => setTimeout(r, 700));
    await assert.rejects(
      () => mgrExp.submitCode(token, sExp.loginSessionId, 'EXPIRED_CODE'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 410,
    );

    // 4. Bad code returns failed without exposing echoed PTY secret
    delete process.env.DUPOND_AGY_AUTH_TTL_MS;
    process.env.FAKE_AGY_MODE = 'bad_code';
    const mgrBad = new AgyAuthSessionManager();
    const sBad = await mgrBad.startLogin(token);
    assert.ok(sBad);
    const badRes = await mgrBad.submitCode(token, sBad.loginSessionId, 'SENSITIVE_BAD_CODE_999');
    assert.strictEqual(badRes.authenticated, false);
    assert.strictEqual(badRes.state, 'failed');
    assert.ok(!JSON.stringify(badRes).includes('SENSITIVE_BAD_CODE_999'));
  });
});
