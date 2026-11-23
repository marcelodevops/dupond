import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  AgyAuthError,
  AgyAuthSessionManager,
  extractValidatedOAuthUrl,
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
  if (process.env.FAKE_AGY_MODELS_PID_OUT) {
    fs.writeFileSync(process.env.FAKE_AGY_MODELS_PID_OUT, String(process.pid));
  }
  const finishModels = () => {
    if (mode === 'models_keychain_cancelled') {
      console.error('Failed keyring SaveToken: exit status 154 Bearer SYNTH_KC_SECRET_111');
      process.exit(1);
    }
    if (mode === 'models_keychain_missing_default') {
      console.error('security: SecKeychainCopyDefault: A default keychain could not be found.');
      process.exit(1);
    }
    if (mode === 'models_keyring_timeout') {
      console.error('Keyring SaveToken timed out after 5s');
      process.exit(1);
    }
    if (fs.existsSync(tokenFile)) {
      console.log('gemini-4-neon-high              Gemini 4 Neon (High)');
      console.log('gemini-3.8-flash-medium         Gemini 3.8 Flash (Medium)');
      process.exit(0);
    }
    console.error('Error: Please sign in to view available models.');
    process.exit(1);
  };
  const hangMs = Number(process.env.FAKE_AGY_MODELS_HANG_MS || 0);
  if (hangMs > 0) {
    setTimeout(finishModels, hangMs);
  } else {
    finishModels();
  }
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
      if (mode === 'wrapped_url') {
        const longUrl =
          'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-testclient.apps.googleusercontent.com' +
          '&code_challenge=SYNTH_PKCE_CHALLENGE_43_CHARS_LONG_ABCDEFG&code_challenge_method=S256&prompt=consent' +
          '&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code' +
          '&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+openid' +
          '&state=SYNTH_WRAP_STATE_987';
        const c1 = longUrl.slice(0, 120);
        const c2 = longUrl.slice(120, 240);
        const c3 = longUrl.slice(240);
        process.stdout.write('\\x1b[34;4m' + c1 + '\\n');
        setTimeout(() => {
          process.stdout.write(c2 + '\\n');
        }, 40);
        setTimeout(() => {
          process.stdout.write(c3 + '\\x1b[m\\n\\nIf you are not automatically redirected, paste the authorization code below:\\n');
        }, 80);
        return;
      }
      process.stdout.write(
        'https://accounts.google.com/o/oauth2/auth?client_id=test-client&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=abc123\\n' +
        'If you are not automatically redirected, paste the authorization code below:\\n'
      );
      return;
    }
    if (step === 'code' && (buf.includes('\\r') || buf.includes('\\n'))) {
      const code = buf.trim();
      if (mode === 'keychain_cancelled') {
        process.stdout.write('Failed keyring SaveToken: exit status 154 Bearer SYNTH_LOGIN_SECRET_222\\n');
        return;
      }
      if (mode === 'keychain_missing_default') {
        process.stdout.write('security: SecKeychainCopyDefault: A default keychain could not be found.\\n');
        return;
      }
      if (mode === 'keyring_timeout') {
        process.stdout.write('Keyring SaveToken timed out after 5s\\n');
        return;
      }
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
      FAKE_AGY_MODELS_HANG_MS: process.env.FAKE_AGY_MODELS_HANG_MS,
      FAKE_AGY_MODELS_PID_OUT: process.env.FAKE_AGY_MODELS_PID_OUT,
    };
    process.env.DUPOND_AGY_BIN = fakeBin;
    process.env.DUPOND_AGY_PROFILE_DIR = profileDir;
    delete process.env.DUPOND_AGY_AUTH_TTL_MS;
    delete process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS;
    delete process.env.DUPOND_AGY_TERM_GRACE_MS;
    delete process.env.DUPOND_AGY_KILL_GRACE_MS;
    delete process.env.FAKE_AGY_MODE;
    delete process.env.FAKE_AGY_DESCENDANT_PID_OUT;
    delete process.env.FAKE_AGY_MODELS_HANG_MS;
    delete process.env.FAKE_AGY_MODELS_PID_OUT;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a 0700 dedicated profile, enforces session binding, replay, CR/LF validation, and PTY echo secrecy', async () => {
    const mgr = new AgyAuthSessionManager({ platform: 'linux' });
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
    const statusB = await mgr.getStatus(tokenB);
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
    const restartedMgr = new AgyAuthSessionManager({ platform: 'linux' });
    await assert.rejects(
      () => restartedMgr.submitCode(tokenA, session.loginSessionId, 'SYNTH_AUTH_CODE_SECRET'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 404 && /server restart/i.test(err.message),
    );

    // Concurrent / replay submission prevented
    process.env.FAKE_AGY_MODE = 'slow_exchange';
    const mgr2 = new AgyAuthSessionManager({ platform: 'linux' });
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
    const postStatus = await mgr2.getStatus(tokenA);
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
    const modelsCheck = await probeAgyProfileModels(profileDir, fakeBin, { platform: 'linux' });
    assert.strictEqual(modelsCheck.authenticated, true);

    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    const sbCheck = await verifyAgySandboxPortability(profileDir, repoDir, undefined, { platform: 'linux' });
    assert.strictEqual(sbCheck.ok, true, `Expected sandbox portability check to pass, got: ${sbCheck.error}`);
    assert.strictEqual(sbCheck.modelsCount, 2);
  });

  it('handles expiry, cancellation, bad codes, and startup failures cleanly without leaking PTY output', async () => {
    const token = 'operator-token-C';

    // 1. Startup failure does not leak raw PTY output
    process.env.FAKE_AGY_MODE = 'startup_fail';
    const mgrFail = new AgyAuthSessionManager({ platform: 'linux' });
    await assert.rejects(
      () => mgrFail.startLogin(token),
      (err: any) => err instanceof AgyAuthError && !err.message.includes('RAW_PTY_SECRET_STARTUP_FAILURE'),
    );

    // 2. Cancellation terminates PTY process and rejects subsequent submission
    delete process.env.FAKE_AGY_MODE;
    const mgrCancel = new AgyAuthSessionManager({ platform: 'linux' });
    const sCancel = await mgrCancel.startLogin(token);
    assert.ok(sCancel);
    await mgrCancel.cancelLogin(token, sCancel.loginSessionId);
    assert.strictEqual((await mgrCancel.getStatus(token)).session?.state, 'cancelled');
    await assert.rejects(
      () => mgrCancel.submitCode(token, sCancel.loginSessionId, 'LATE_CODE'),
      (err: any) => err instanceof AgyAuthError && err.statusCode === 409,
    );

    // 3. Expiry rejects late submission with 410
    process.env.DUPOND_AGY_AUTH_TTL_MS = '600';
    const mgrExp = new AgyAuthSessionManager({ platform: 'linux' });
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
    const mgrBad = new AgyAuthSessionManager({ platform: 'linux' });
    const sBad = await mgrBad.startLogin(token);
    assert.ok(sBad);
    const badRes = await mgrBad.submitCode(token, sBad.loginSessionId, 'SENSITIVE_BAD_CODE_999');
    assert.strictEqual(badRes.authenticated, false);
    assert.strictEqual(badRes.state, 'failed');
    assert.ok(!JSON.stringify(badRes).includes('SENSITIVE_BAD_CODE_999'));
    assert.ok(!JSON.stringify(badRes).includes('ECHO_SECRET_CODE'));
    assert.ok(!JSON.stringify(await mgrBad.getStatus(token)).includes('SENSITIVE_BAD_CODE_999'));
    assert.ok(!JSON.stringify(await mgrBad.getStatus(token)).includes('ECHO_SECRET_CODE'));
  });

  it('kills stubborn SIGTERM-ignoring agy descendants and blocks profile reuse if termination is unconfirmed', async () => {
    const token = 'operator-token-descendant';
    const descPidFile = path.join(tmpDir, 'descendant.pid');
    process.env.FAKE_AGY_MODE = 'stubborn_descendant';
    process.env.FAKE_AGY_DESCENDANT_PID_OUT = descPidFile;
    process.env.DUPOND_AGY_TERM_GRACE_MS = '80';
    process.env.DUPOND_AGY_KILL_GRACE_MS = '200';

    const mgr = new AgyAuthSessionManager({ platform: 'linux' });
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
    assert.strictEqual((await mgr.getStatus(token)).session?.state, 'cancelled');
    assert.strictEqual(mgr.getUnconfirmedProcesses().length, 0);
    assert.throws(() => process.kill(descPid, 0), 'Expected stubborn descendant process to be terminated');

    // Unconfirmed termination: retained tracking + explicit failure + profile reuse blocked (409 AGY_PROFILE_LOCKED)
    delete process.env.FAKE_AGY_MODE;
    delete process.env.FAKE_AGY_DESCENDANT_PID_OUT;
    process.env.DUPOND_AGY_TERM_GRACE_MS = '30';
    process.env.DUPOND_AGY_KILL_GRACE_MS = '30';

    const mgrUnconf = new AgyAuthSessionManager({ platform: 'linux' });
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
    const mgr = new AgyAuthSessionManager({ platform: 'linux' });
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
    const mgrCancelSubmit = new AgyAuthSessionManager({ platform: 'linux' });
    const s1 = await mgrCancelSubmit.startLogin(tokenA);
    assert.ok(s1);
    const submitPromise = mgrCancelSubmit.submitCode(tokenA, s1.loginSessionId, 'SYNTH_CODE_CANCEL_DURING_SUBMIT');
    await new Promise((r) => setTimeout(r, 40));
    await mgrCancelSubmit.cancelLogin(tokenA, s1.loginSessionId);
    const cancelSubmitRes = await submitPromise;
    assert.strictEqual(cancelSubmitRes.state, 'cancelled');
    assert.strictEqual(cancelSubmitRes.authenticated, false);
    assert.strictEqual((await mgrCancelSubmit.getStatus(tokenA)).session?.state, 'cancelled');

    // 3. Same-owner supersede during slow submit never lets old session become completed
    const mgrSupersede = new AgyAuthSessionManager({ platform: 'linux' });
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
    assert.strictEqual((await mgrSupersede.getStatus(tokenA)).session?.loginSessionId, sNew.loginSessionId);
    assert.strictEqual((await mgrSupersede.getStatus(tokenA)).session?.state, 'awaiting_code');
    await mgrSupersede.cancelLogin(tokenA, sNew.loginSessionId);

    // 4. Bounded submission deadline fails cleanly
    process.env.FAKE_AGY_MODE = 'never_finish';
    process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS = '120';
    const mgrTimeout = new AgyAuthSessionManager({ platform: 'linux' });
    const sTimeout = await mgrTimeout.startLogin(tokenA);
    assert.ok(sTimeout);
    const timeoutRes = await mgrTimeout.submitCode(tokenA, sTimeout.loginSessionId, 'SYNTH_CODE_TIMEOUT');
    assert.strictEqual(timeoutRes.authenticated, false);
    assert.strictEqual(timeoutRes.state, 'failed');
    assert.ok(!JSON.stringify(timeoutRes).includes('SYNTH_CODE_TIMEOUT'));
  });

  it('yields via real timer when bridge exited with surviving descendant, and interrupts/bounds async probes on cancel, deadline, or expiry', async () => {
    const token = 'operator-async-probe';

    // 1. Bridge already exited (exitPromise already resolved) while a descendant remains alive:
    // waitForProcessTermination must yield through real timers so an event-loop heartbeat is never starved.
    process.env.DUPOND_AGY_TERM_GRACE_MS = '220';
    process.env.DUPOND_AGY_KILL_GRACE_MS = '220';
    const mgrHeartbeat = new AgyAuthSessionManager({ platform: 'linux' });
    const sHeartbeat = await mgrHeartbeat.startLogin(token);
    assert.ok(sHeartbeat);
    const activeHb = (mgrHeartbeat as any).activeSession;
    if (activeHb.agyPgid) {
      try { process.kill(-activeHb.agyPgid, 'SIGKILL'); } catch { /* ignore */ }
    }
    if (activeHb.child?.pid) {
      try { process.kill(-activeHb.child.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    await activeHb.exitPromise;

    // Spawn a SIGTERM-ignoring surviving descendant in its own process group while bridge is already exited
    const hbReadyFile = path.join(tmpDir, 'hb-ready');
    const survivingDesc = spawn(
      process.execPath,
      [
        '-e',
        'const fs=require("fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], "1"); setInterval(() => {}, 1000);',
        hbReadyFile,
      ],
      { detached: true, stdio: 'ignore' },
    );
    assert.ok(survivingDesc.pid);
    for (let i = 0; i < 40 && !fs.existsSync(hbReadyFile); i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(fs.existsSync(hbReadyFile), 'Expected surviving descendant to arm SIGTERM handler');
    activeHb.exited = true;
    activeHb.exitPromise = Promise.resolve();
    activeHb.agyPgid = survivingDesc.pid;

    let heartbeats = 0;
    const heartbeatTimer = setInterval(() => {
      heartbeats += 1;
    }, 20);
    try {
      await mgrHeartbeat.cancelLogin(token, sHeartbeat.loginSessionId);
    } finally {
      clearInterval(heartbeatTimer);
    }
    assert.ok(heartbeats >= 4, `Expected event-loop heartbeat >= 4 ticks during termination wait, got ${heartbeats}`);
    assert.throws(() => process.kill(survivingDesc.pid!, 0), 'Expected surviving descendant to be killed');

    // Helper to wait for probe PID file
    const waitForPidFile = async (file: string): Promise<number> => {
      for (let i = 0; i < 60; i++) {
        if (fs.existsSync(file)) {
          const parsed = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return 0;
    };

    // 2. Cancellation interrupts a hanging model probe promptly and reaps the probe process
    const probePidFileCancel = path.join(tmpDir, 'probe-cancel.pid');
    process.env.FAKE_AGY_MODELS_HANG_MS = '10000';
    process.env.FAKE_AGY_MODELS_PID_OUT = probePidFileCancel;
    delete process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS;
    const mgrCancelProbe = new AgyAuthSessionManager({ platform: 'linux' });
    const sCancelProbe = await mgrCancelProbe.startLogin(token);
    assert.ok(sCancelProbe);
    const submitCancelP = mgrCancelProbe.submitCode(token, sCancelProbe.loginSessionId, 'SYNTH_PROBE_CANCEL');
    const cancelProbePid = await waitForPidFile(probePidFileCancel);
    assert.ok(cancelProbePid > 0, 'Expected hanging probe PID to be recorded');

    const tCancelStart = Date.now();
    await mgrCancelProbe.cancelLogin(token, sCancelProbe.loginSessionId);
    const cancelProbeRes = await submitCancelP;
    const cancelElapsedMs = Date.now() - tCancelStart;
    assert.ok(cancelElapsedMs < 2000, `Expected cancellation to interrupt hanging probe promptly, took ${cancelElapsedMs}ms`);
    assert.strictEqual(cancelProbeRes.state, 'cancelled');
    assert.strictEqual(cancelProbeRes.authenticated, false);
    assert.throws(() => process.kill(cancelProbePid, 0), 'Expected cancelled probe process to be terminated');
    delete process.env.FAKE_AGY_MODELS_HANG_MS;
    assert.strictEqual((await mgrCancelProbe.getStatus(token)).session?.state, 'cancelled');

    // 3. Short submission deadline bounds the entire verification operation (including hanging probe)
    const probePidFileDeadline = path.join(tmpDir, 'probe-deadline.pid');
    process.env.FAKE_AGY_MODELS_HANG_MS = '10000';
    process.env.FAKE_AGY_MODELS_PID_OUT = probePidFileDeadline;
    process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS = '180';
    const mgrDeadline = new AgyAuthSessionManager({ platform: 'linux' });
    const sDeadline = await mgrDeadline.startLogin(token);
    assert.ok(sDeadline);
    const tDeadlineStart = Date.now();
    const deadlineRes = await mgrDeadline.submitCode(token, sDeadline.loginSessionId, 'SYNTH_PROBE_DEADLINE');
    const deadlineElapsedMs = Date.now() - tDeadlineStart;
    const deadlineProbePid = await waitForPidFile(probePidFileDeadline);
    assert.ok(deadlineElapsedMs < 2000, `Expected short submission deadline to bound verification, took ${deadlineElapsedMs}ms`);
    assert.strictEqual(deadlineRes.state, 'failed');
    assert.strictEqual(deadlineRes.authenticated, false);
    assert.ok(deadlineProbePid > 0);
    assert.throws(() => process.kill(deadlineProbePid, 0), 'Expected timed-out probe process to be terminated');

    // 4. Expired session during in-flight probe never becomes completed even if probe would otherwise succeed
    delete process.env.DUPOND_AGY_SUBMIT_TIMEOUT_MS;
    delete process.env.FAKE_AGY_MODELS_PID_OUT;
    process.env.FAKE_AGY_MODELS_HANG_MS = '600';
    process.env.DUPOND_AGY_AUTH_TTL_MS = '350';
    const mgrExpireProbe = new AgyAuthSessionManager({ platform: 'linux' });
    const sExpireProbe = await mgrExpireProbe.startLogin(token);
    assert.ok(sExpireProbe);
    const expireRes = await mgrExpireProbe.submitCode(token, sExpireProbe.loginSessionId, 'SYNTH_PROBE_EXPIRE');
    assert.strictEqual(expireRes.state, 'expired');
    assert.strictEqual(expireRes.authenticated, false);
    delete process.env.FAKE_AGY_MODELS_HANG_MS;
    assert.strictEqual((await mgrExpireProbe.getStatus(token)).session?.state, 'expired');
  });

  it('reconstructs long ANSI-wrapped and multi-chunk PTY OAuth URLs without losing query or PKCE parameters', async () => {
    const fullUrl =
      'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-testclient.apps.googleusercontent.com' +
      '&code_challenge=SYNTH_PKCE_CHALLENGE_43_CHARS_LONG_ABCDEFG&code_challenge_method=S256&prompt=consent' +
      '&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code' +
      '&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+openid' +
      '&state=SYNTH_WRAP_STATE_987';

    // 1. Truncated prefix without required params is rejected
    assert.strictEqual(extractValidatedOAuthUrl(fullUrl.slice(0, 120)), null);

    // 2. Wrapped ANSI lines without OSC 8 reconstruct exact URL and do not pull in surrounding prose
    const wrappedPlain = [
      'Open this URL in your browser:',
      '\x1b[34;4m' + fullUrl.slice(0, 138),
      fullUrl.slice(138, 276),
      fullUrl.slice(276) + '\x1b[m',
      '',
      'If you are not automatically redirected, paste the authorization code below:',
    ].join('\r\n');
    assert.strictEqual(extractValidatedOAuthUrl(wrappedPlain), fullUrl);

    // 3. OSC 8 hyperlink extraction preserves exact query string even alongside wrapped visible text
    const osc8Output =
      `\x1b]8;id=abc123;${fullUrl}\x07${fullUrl.slice(0, 100)}\n${fullUrl.slice(100)}\x1b]8;;\x07\n`;
    assert.strictEqual(extractValidatedOAuthUrl(osc8Output), fullUrl);

    // 4. Full PTY chunked flow preserves client_id, redirect_uri, response_type, state, scope, and PKCE params
    process.env.FAKE_AGY_MODE = 'wrapped_url';
    const mgr = new AgyAuthSessionManager({ platform: 'linux' });
    const session = await mgr.startLogin('operator-wrapped-url');
    assert.ok(session?.authUrl);
    assert.strictEqual(session.authUrl, fullUrl);
    const parsed = new URL(session.authUrl);
    assert.strictEqual(parsed.searchParams.get('client_id'), '1071006060591-testclient.apps.googleusercontent.com');
    assert.strictEqual(parsed.searchParams.get('redirect_uri'), 'https://antigravity.google/oauth-callback');
    assert.strictEqual(parsed.searchParams.get('response_type'), 'code');
    assert.strictEqual(parsed.searchParams.get('state'), 'SYNTH_WRAP_STATE_987');
    assert.strictEqual(parsed.searchParams.get('code_challenge'), 'SYNTH_PKCE_CHALLENGE_43_CHARS_LONG_ABCDEFG');
    assert.strictEqual(parsed.searchParams.get('code_challenge_method'), 'S256');
    await mgr.cancelLogin('operator-wrapped-url', session.loginSessionId);
  });

  it('prevents macOS Keychain prompts by disabling onboarding on darwin and surfaces sanitized Keychain failure categories without retrying', async () => {
    // 1. On darwin, onboardingSupported is false and startLogin refuses before spawning agy
    const darwinMgr = new AgyAuthSessionManager({ platform: 'darwin' });
    const initialStatus = await darwinMgr.getStatus('op-darwin');
    assert.strictEqual(initialStatus.onboardingSupported, false);
    assert.ok(initialStatus.onboardingUnavailableReason?.includes('Keychain'));
    assert.strictEqual(initialStatus.credentialsPresent, false);
    assert.strictEqual(initialStatus.profileAuthVerified, false);
    assert.strictEqual(initialStatus.sandboxAuthVerified, false);
    assert.strictEqual(initialStatus.executionVerified, false);

    await assert.rejects(
      () => darwinMgr.startLogin('op-darwin'),
      (err: any) =>
        err instanceof AgyAuthError &&
        err.code === 'AGY_ONBOARDING_UNAVAILABLE_MACOS' &&
        err.message.includes('Keychain'),
    );
    assert.strictEqual((await darwinMgr.getStatus('op-darwin')).session, null);

    // 2. Token file presence alone never implies profile/sandbox/execution verification,
    //    and darwin gates probes & portability checks before spawning agy (0 subprocesses launched).
    const profileDir = resolveAgyProfileDir();
    fs.mkdirSync(path.join(profileDir, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'synth-token');
    const darwinPidSentinel = path.join(tmpDir, 'darwin-probe-pid.txt');
    process.env.FAKE_AGY_MODELS_PID_OUT = darwinPidSentinel;
    process.env.FAKE_AGY_MODE = 'success';

    const gatedStatus = await darwinMgr.getStatus('op-darwin');
    assert.strictEqual(gatedStatus.credentialsPresent, true);
    assert.strictEqual(gatedStatus.profileAuthVerified, false);
    assert.strictEqual(gatedStatus.sandboxAuthVerified, false);
    assert.strictEqual(gatedStatus.executionVerified, false);
    assert.ok(gatedStatus.error?.includes('Keychain'));
    assert.strictEqual(fs.existsSync(darwinPidSentinel), false, 'darwin getStatus must launch zero agy probe processes');

    const gatedSandbox = await verifyAgySandboxPortability(profileDir, tmpDir, undefined, { platform: 'darwin' });
    assert.strictEqual(gatedSandbox.ok, false);
    assert.ok(gatedSandbox.error?.includes('Keychain'));
    assert.strictEqual(fs.existsSync(darwinPidSentinel), false, 'darwin portability check must launch zero agy processes');
    delete process.env.FAKE_AGY_MODELS_PID_OUT;

    // 3. Probe recognizes keychain cancellation, missing default keychain & keyring timeout cleanly when platform permits probing
    process.env.FAKE_AGY_MODE = 'models_keychain_cancelled';
    const cancelledProbe = await probeAgyProfileModels(profileDir, fakeBin, { platform: 'linux' });
    assert.strictEqual(cancelledProbe.authenticated, false);
    assert.ok(cancelledProbe.error?.includes('cancelled'));
    assert.ok(!cancelledProbe.error?.includes('SYNTH_KC_SECRET_111'));

    process.env.FAKE_AGY_MODE = 'models_keychain_missing_default';
    const missingDefaultProbe = await probeAgyProfileModels(profileDir, fakeBin, { platform: 'linux' });
    assert.strictEqual(missingDefaultProbe.authenticated, false);
    assert.ok(missingDefaultProbe.error?.includes('default macOS Keychain'));

    process.env.FAKE_AGY_MODE = 'models_keyring_timeout';
    const timeoutProbe = await probeAgyProfileModels(profileDir, fakeBin, { platform: 'linux' });
    assert.strictEqual(timeoutProbe.authenticated, false);
    assert.ok(timeoutProbe.error?.includes('timed out waiting for macOS Keychain'));

    // 4. Onboarding code submission recognizes Keychain failure categories without retrying or leaking secrets
    const linuxMgr = new AgyAuthSessionManager({ platform: 'linux' });
    for (const [mode, expectedSubstr] of [
      ['keychain_cancelled', 'cancelled'],
      ['keychain_missing_default', 'default macOS Keychain'],
      ['keyring_timeout', 'timed out waiting for macOS Keychain'],
    ] as const) {
      process.env.FAKE_AGY_MODE = mode;
      const sess = await linuxMgr.startLogin('op-kc');
      assert.ok(sess?.loginSessionId);
      const submitRes = await linuxMgr.submitCode('op-kc', sess.loginSessionId, '4/0ASynthCode');
      assert.strictEqual(submitRes.state, 'failed');
      assert.strictEqual(submitRes.authenticated, false);
      assert.ok(submitRes.error?.includes(expectedSubstr), `Expected ${expectedSubstr}, got: ${submitRes.error}`);
      assert.ok(!submitRes.error?.includes('SYNTH_LOGIN_SECRET_222'));
    }
  });
});
