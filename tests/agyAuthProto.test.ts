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
      if (mode === 'bad_code' || code === 'BAD_CODE') {
        // Deliberately emit echoed secret code AND failure marker in ONE chunk
        process.stdout.write('ECHO_SECRET_CODE:' + code + ' Got an error: token exchange failed: oauth2: "invalid_grant" "Bad Request"\\n');
        return;
      }
      if (mode === 'never_finish') {
        process.stdout.write('ECHO_SECRET_CODE:' + code + '\\n');
        return;
      }
      process.stdout.write('ECHO_SECRET_CODE:' + code + '\\n');
      if (mode === 'slow_exchange') {
        setTimeout(() => {
          fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
          fs.writeFileSync(tokenFile, JSON.stringify({ token: 'synth-oauth-token', auth_method: 'oauth' }), { mode: 0o600 });
        }, 600);
        return;
      }
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({ token: 'synth-oauth-token', auth_method: 'oauth' }), { mode: 0o600 });
    }
  });
  if (mode === 'stubborn_descendant') {
    const { spawn } = require('child_process');
    const desc = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { stdio: 'ignore' }
    );
    if (process.env.FAKE_AGY_DESCENDANT_PID_OUT) {
      fs.writeFileSync(process.env.FAKE_AGY_DESCENDANT_PID_OUT, String(desc.pid));
    }
  }
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
      DUPOND_AGY_SUBMIT_TIMEOUT_MS: process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS,
      DUPOND_AGY_TERM_GRACE_MS: process.env.DUPOND_AGY_TERM_GRACE_MS,
      DUPOND_AGY_KILL_GRACE_MS: process.env.DUPOND_AGY_KILL_GRACE_MS,
      FAKE_AGY_MODE: process.env.FAKE_AGY_MODE,
      FAKE_AGY_DESCENDANT_PID_OUT: process.env.FAKE_AGY_DESCENDANT_PID_OUT,
    };
    process.env.DUPOND_AGY_BIN = fakeBin;
    process.env.DUPOND_AGY_PROFILE_DIR = profileDir;
    delete process.env.DUPOND_AGY_AUTH_TTL_MS;
    delete process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS;
    delete process.env.DUPOND_AGY_TERM_GRACE_MS;
    delete process.env.DUPOND_AGY_KILL_GRACE_MS;
    delete process.env.FAKE_AGY_MODE;
    delete process.env.FAKE_AGY_DESCENDANT_PID_OUT;
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

    // 4. Bad code returns failed without exposing echoed PTY secret (even when same-chunk with failure marker)
    delete process.env.DUPOND_AGY_AUTH_TTL_MS;
    process.env.FAKE_AGY_MODE = 'bad_code';
    const mgrBad = new AgyAuthSessionManager();
    const sBad = await mgrBad.startLogin(token);
    assert.ok(sBad);
    const badRes = await mgrBad.submitCode(token, sBad.loginSessionId, 'SENSITIVE_BAD_CODE_999');
    assert.strictEqual(badRes.authenticated, false);
    assert.strictEqual(badRes.state, 'failed');
    assert.ok(!JSON.stringify(badRes).includes('SENSITIVE_BAD_CODE_999'));
    assert.ok(!JSON.stringify(badRes).includes('ECHO_SECRET_CODE'));
    assert.ok(!JSON.stringify(mgrBad.getStatus(token)).includes('SENSITIVE_BAD_CODE_999'));
    assert.ok(!JSON.stringify(mgrBad.getStatus(token)).includes('ECHO_SECRET_CODE'));
  });

  it('kills stubborn SIGTERM-ignoring agy descendants and blocks profile reuse if termination is unconfirmed', async () => {
    const token = 'operator-token-descendant';
    const descPidFile = path.join(tmpDir, 'descendant.pid');
    process.env.FAKE_AGY_MODE = 'stubborn_descendant';
    process.env.FAKE_AGY_DESCENDANT_PID_OUT = descPidFile;
    process.env.DUPOND_AGY_TERM_GRACE_MS = '80';
    process.env.DUPOND_AGY_KILL_GRACE_MS = '200';

    const mgr = new AgyAuthSessionManager();
    const session = await mgr.startLogin(token);
    assert.ok(session);

    // Wait briefly until descendant PID file is written
    let descPid = 0;
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(descPidFile)) {
        const parsed = Number.parseInt(fs.readFileSync(descPidFile, 'utf8').trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          descPid = parsed;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(descPid > 0, 'Expected stubborn descendant PID to be recorded');

    await mgr.cancelLogin(token, session.loginSessionId);
    assert.strictEqual(mgr.getStatus(token).session?.state, 'cancelled');
    assert.strictEqual(mgr.getUnconfirmedProcesses().length, 0);
    assert.throws(() => process.kill(descPid, 0), 'Expected stubborn descendant process to be terminated');

    // Unconfirmed termination: retained tracking + explicit failure + profile reuse blocked (409 AGY_PROFILE_LOCKED)
    delete process.env.FAKE_AGY_MODE;
    delete process.env.FAKE_AGY_DESCENDANT_PID_OUT;
    process.env.DUPOND_AGY_TERM_GRACE_MS = '30';
    process.env.DUPOND_AGY_KILL_GRACE_MS = '30';

    const mgrUnconf = new AgyAuthSessionManager();
    await mgrUnconf.startLogin(token);
    const active = (mgrUnconf as any).activeSession;
    // Cleanly terminate the real test subprocess before swapping in an unkillable stub child
    if (active.agyPgid) {
      try { process.kill(-active.agyPgid, 'SIGKILL'); } catch { /* ignore */ }
    }
    if (active.child?.pid) {
      try { process.kill(-active.child.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    await active.exitPromise;
    active.exited = false;
    active.exitPromise = new Promise<void>(() => {});
    active.child = { pid: 999992, exitCode: null, signalCode: null, kill: () => true };
    active.agyPgid = 999993;

    await assert.rejects(
      () => mgrUnconf.cancelLogin(token),
      (err: any) => err instanceof AgyAuthError && err.code === 'AGY_PROCESS_TERMINATION_UNCONFIRMED',
    );
    assert.strictEqual(mgrUnconf.getUnconfirmedProcesses().length, 1);

    await assert.rejects(
      () => mgrUnconf.startLogin(token),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 409 && err.code === 'AGY_PROFILE_LOCKED',
    );
  });

  it('serializes concurrent starts, rejects cross-owner supersede, and prevents cancel/supersede from completing later', async () => {
    const tokenA = 'operator-A';
    const tokenB = 'operator-B';

    // 1. Concurrent startLogin calls serialize cleanly and reject cross-owner supersede
    const mgr = new AgyAuthSessionManager();
    const [resA, resB] = await Promise.allSettled([
      mgr.startLogin(tokenA),
      mgr.startLogin(tokenB),
    ]);
    const fulfilledCount = [resA, resB].filter((r) => r.status === 'fulfilled').length;
    const rejectedCrossOwner = [resA, resB].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    assert.strictEqual(fulfilledCount, 1);
    assert.ok(rejectedCrossOwner);
    assert.ok(
      rejectedCrossOwner.reason instanceof AgyAuthError
      && rejectedCrossOwner.reason.statusCode === 403
      && rejectedCrossOwner.reason.code === 'SESSION_OWNERSHIP_MISMATCH',
    );
    await mgr.cancelLogin(resA.status === 'fulfilled' ? tokenA : tokenB);

    // 2. Cancel during slow submit never turns into completed
    process.env.FAKE_AGY_MODE = 'slow_exchange';
    const mgrCancelSubmit = new AgyAuthSessionManager();
    const s1 = await mgrCancelSubmit.startLogin(tokenA);
    assert.ok(s1);
    const submitPromise = mgrCancelSubmit.submitCode(tokenA, s1.loginSessionId, 'SYNTH_CODE_CANCEL_DURING_SUBMIT');
    await new Promise((r) => setTimeout(r, 40));
    await mgrCancelSubmit.cancelLogin(tokenA, s1.loginSessionId);
    const cancelSubmitRes = await submitPromise;
    assert.strictEqual(cancelSubmitRes.state, 'cancelled');
    assert.strictEqual(cancelSubmitRes.authenticated, false);
    assert.strictEqual(mgrCancelSubmit.getStatus(tokenA).session?.state, 'cancelled');

    // 3. Same-owner supersede during slow submit never lets old session become completed
    const mgrSupersede = new AgyAuthSessionManager();
    const sOld = await mgrSupersede.startLogin(tokenA);
    assert.ok(sOld);
    const oldSubmit = mgrSupersede.submitCode(tokenA, sOld.loginSessionId, 'SYNTH_CODE_SUPERSEDED');
    await new Promise((r) => setTimeout(r, 40));
    const sNew = await mgrSupersede.startLogin(tokenA);
    assert.ok(sNew);
    assert.notStrictEqual(sNew.loginSessionId, sOld.loginSessionId);
    const oldRes = await oldSubmit;
    assert.notStrictEqual(oldRes.state, 'completed');
    assert.strictEqual(oldRes.authenticated, false);
    assert.strictEqual(mgrSupersede.getStatus(tokenA).session?.loginSessionId, sNew.loginSessionId);
    assert.strictEqual(mgrSupersede.getStatus(tokenA).session?.state, 'awaiting_code');
    await mgrSupersede.cancelLogin(tokenA, sNew.loginSessionId);

    // 4. Bounded submission deadline fails cleanly
    process.env.FAKE_AGY_MODE = 'never_finish';
    process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS = '120';
    const mgrTimeout = new AgyAuthSessionManager();
    const sTimeout = await mgrTimeout.startLogin(tokenA);
    assert.ok(sTimeout);
    const timeoutRes = await mgrTimeout.submitCode(tokenA, sTimeout.loginSessionId, 'SYNTH_CODE_TIMEOUT');
    assert.strictEqual(timeoutRes.authenticated, false);
    assert.strictEqual(timeoutRes.state, 'failed');
    assert.ok(!JSON.stringify(timeoutRes).includes('SYNTH_CODE_TIMEOUT'));
  });
});
