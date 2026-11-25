import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, describe, it } from 'vitest';
import { SandboxExecutor } from '../src/server/sandbox/sandboxExecutor.js';
import {
  AGY_CREDENTIAL_USER_SCOPE_REL,
  AGY_KEYCHAIN_ACCOUNT,
  AGY_KEYCHAIN_SERVICE,
  AGY_MINIMAL_SANDBOX_CONFIG,
  readAgyProfileMeta,
  reconcileAgyProfileRecovery,
  rotateAgyProfileAuthEpoch,
  runWithIsolatedAgyProfile,
  writeAgyProfileMeta,
} from '../src/server/worker/agyKeychainPersistence.js';
import {
  ensureIsolatedProfileKeychain,
  readSyntheticKeychainItem,
  runBoundedSecurity,
  writeSyntheticKeychainItem,
} from '../src/server/worker/agyKeychainPrototype.js';
import { AgyCodingWorkerAdapter } from '../src/server/worker/agyWorkerAdapter.js';
import { isAgyOnboardingSupported } from '../src/server/worker/agyAuthManager.js';

function makeCredentialB64(overrides?: {
  refreshToken?: string;
  accessToken?: string;
  email?: string;
}): string {
  const payload = {
    token: {
      access_token: overrides?.accessToken ?? 'ya29.test-access-token-123',
      token_type: 'Bearer',
      refresh_token: overrides?.refreshToken ?? '1//test-refresh-token-initial',
      expiry: '2026-12-31T23:59:59.000Z',
      expires_in: 3599,
    },
    auth_method: 'oauth',
    id_token_email: overrides?.email ?? 'tester@example.com',
  };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

function getPersonalKeychainState(): { defaultKc: string; listKc: string } {
  const defaultKc = execFileSync('/usr/bin/security', ['default-keychain'], { encoding: 'utf-8' }).trim();
  const listKc = execFileSync('/usr/bin/security', ['list-keychains'], { encoding: 'utf-8' }).trim();
  return { defaultKc, listKc };
}

describe('Antigravity macOS Keychain persistence, fault injection, and wiring', () => {
  const tempDirs: string[] = [];
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-agy-persist-'));
    tempDirs.push(dir);
    return dir;
  }

  it('keeps production macOS gate closed by default and separates platform capability from readiness', () => {
    delete process.env.DUPOND_AGY_MACOS_KEYCHAIN;
    assert.strictEqual(isAgyOnboardingSupported('darwin'), false);

    process.env.DUPOND_AGY_MACOS_KEYCHAIN = '1';
    assert.strictEqual(isAgyOnboardingSupported('darwin'), true);
    assert.strictEqual(isAgyOnboardingSupported('darwin', { allowDarwinKeychain: false }), false);
  });

  it.skipIf(process.platform !== 'darwin')(
    'recovers rotated credentials across every fault-injection stage and preserves recovery on uncertain descendants',
    async () => {
      process.env.DUPOND_CONN_KEY = 'test-conn-key-persistence-01';
      const personalBefore = getPersonalKeychainState();

      const root = makeTempRoot();
      const profileDir = path.join(root, 'profile');
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

      await ensureIsolatedProfileKeychain(profileDir);
      const initialCred = makeCredentialB64({ refreshToken: '1//refresh-v1' });
      await writeSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, initialCred);
      const scopeDir = path.join(profileDir, path.dirname(AGY_CREDENTIAL_USER_SCOPE_REL));
      fs.mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(profileDir, AGY_CREDENTIAL_USER_SCOPE_REL), 'u1234567890abcdef', { mode: 0o600 });

      // Write an arbitrary config.json in profileDir to prove it is NOT seeded into sandbox HOME.
      fs.mkdirSync(path.join(profileDir, '.gemini', 'config'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(profileDir, '.gemini', 'config', 'config.json'),
        JSON.stringify({ plugins: { swarm: { enabled: true } }, hooks: { pre: 'evil' } }),
      );

      const stages = [
        'before_stage',
        'after_stage_before_keychain',
        'after_keychain_before_files',
        'after_files_before_meta',
        'after_meta_before_cleanup',
      ] as const;

      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        const rotatedToken = `1//refresh-stage-${i + 2}`;
        const rotatedCred = makeCredentialB64({ refreshToken: rotatedToken });
        const sandboxHome = path.join(root, `sb-${stage}`);
        fs.mkdirSync(sandboxHome, { recursive: true, mode: 0o700 });

        await assert.rejects(
          () =>
            runWithIsolatedAgyProfile(
              profileDir,
              async ({ prepareSandboxHome, onExecutionStarted }) => {
                await prepareSandboxHome(sandboxHome);
                onExecutionStarted({
                  sandboxHomeDir: sandboxHome,
                  mode: 'process_group',
                  pid: 999999,
                  pgid: 999999,
                  startedAtMs: Date.now(),
                });
                // Verify minimal synthesized config excludes plugins/hooks.
                const cfg = fs.readFileSync(
                  path.join(sandboxHome, AGY_MINIMAL_SANDBOX_CONFIG.targetRelToHome),
                  'utf-8',
                );
                assert.strictEqual(cfg, '{}\n');
                // Simulate agy rotating the refresh token inside the sandbox Keychain.
                await writeSyntheticKeychainItem(sandboxHome, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, rotatedCred);
                return 'ok';
              },
              {
                onFault: (s) => {
                  if (s === stage) throw new Error(`INJECTED_CRASH_${stage}`);
                },
              },
            ),
          new RegExp(`INJECTED_CRASH_${stage}`),
        );

        // If crash happened before extraction/staging, uncertain descendant must preserve workspace.
        if (stage === 'before_stage') {
          await assert.rejects(
            () =>
              reconcileAgyProfileRecovery(profileDir, {
                confirmProcessesStopped: async () => ({ stopped: false, reason: 'descendant still running' }),
              }),
            /may still be active/i,
          );
          assert.strictEqual(fs.existsSync(sandboxHome), true);
        }

        // Now reconcile cleanly after descendants stop.
        await reconcileAgyProfileRecovery(profileDir, {
          confirmProcessesStopped: async () => ({ stopped: true }),
        });

        const persisted = await readSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
        assert.strictEqual(persisted, rotatedCred, `Stage ${stage} must recover rotated credential`);
        assert.strictEqual(fs.existsSync(sandboxHome), false, `Stage ${stage} must clean up sandbox home after commit`);
      }

      const personalAfter = getPersonalKeychainState();
      assert.deepStrictEqual(personalAfter, personalBefore);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'fences stale recovery across authEpoch/re-authentication and rejects cross-account conflicts',
    async () => {
      process.env.DUPOND_CONN_KEY = 'test-conn-key-persistence-02';
      const root = makeTempRoot();
      const profileDir = path.join(root, 'profile');
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

      await ensureIsolatedProfileKeychain(profileDir);
      const userACred = makeCredentialB64({ refreshToken: '1//user-a-v1', email: 'user-a@example.com' });
      const userARotated = makeCredentialB64({ refreshToken: '1//user-a-v2', email: 'user-a@example.com' });
      await writeSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, userACred);
      const initialMeta = readAgyProfileMeta(profileDir);
      writeAgyProfileMeta(profileDir, { ...initialMeta, boundEmail: 'user-a@example.com' });

      // Crash after staging recovery for user A.
      const sandboxHome = path.join(root, 'sb-stale');
      fs.mkdirSync(sandboxHome, { recursive: true, mode: 0o700 });
      await assert.rejects(
        () =>
          runWithIsolatedAgyProfile(
            profileDir,
            async ({ prepareSandboxHome, onExecutionStarted }) => {
              await prepareSandboxHome(sandboxHome);
              onExecutionStarted({
                sandboxHomeDir: sandboxHome,
                mode: 'process_group',
                pid: 999997,
                pgid: 999997,
                startedAtMs: Date.now(),
              });
              await writeSyntheticKeychainItem(sandboxHome, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, userARotated);
              return 'ok';
            },
            {
              onFault: (s) => {
                if (s === 'after_stage_before_keychain') throw new Error('CRASH_AFTER_STAGE');
              },
            },
          ),
        /CRASH_AFTER_STAGE/,
      );

      // Operator disconnects and re-authenticates as user B (rotates authEpoch).
      const userBCred = makeCredentialB64({ refreshToken: '1//user-b-v1', email: 'user-b@example.com' });
      await writeSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, userBCred);
      const epochMeta = rotateAgyProfileAuthEpoch(profileDir);
      writeAgyProfileMeta(profileDir, { ...epochMeta, boundEmail: 'user-b@example.com' });

      // Reconcile must discard user A's stale recovery bundle rather than overwriting user B.
      await reconcileAgyProfileRecovery(profileDir);
      const currentKc = await readSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
      assert.strictEqual(currentKc, userBCred);

      // Cross-account conflict during a run must fail closed without overwriting user B.
      const sbConflict = path.join(root, 'sb-conflict');
      fs.mkdirSync(sbConflict, { recursive: true, mode: 0o700 });
      await assert.rejects(
        () =>
          runWithIsolatedAgyProfile(profileDir, async ({ prepareSandboxHome, onExecutionStarted }) => {
            await prepareSandboxHome(sbConflict);
            onExecutionStarted({
              sandboxHomeDir: sbConflict,
              mode: 'process_group',
              pid: 999998,
              pgid: 999998,
              startedAtMs: Date.now(),
            });
            await writeSyntheticKeychainItem(sbConflict, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, userACred);
            return 'ok';
          }),
        /Account consistency conflict/i,
      );
      const afterConflict = await readSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
      assert.strictEqual(afterConflict, userBCred);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'persists rotated tokens on cancellation, wires AgyCodingWorkerAdapter with secret-safe streaming logs, and leaves personal Keychain untouched',
    async () => {
      process.env.DUPOND_CONN_KEY = 'test-conn-key-persistence-03';
      process.env.DUPOND_AGY_MACOS_KEYCHAIN = '1';
      const personalBefore = getPersonalKeychainState();

      const root = makeTempRoot();
      const profileDir = path.join(root, 'profile');
      const repoDir = path.join(root, 'repo');
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(repoDir, { recursive: true, mode: 0o755 });
      execFileSync('git', ['init'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

      process.env.DUPOND_AGY_PROFILE_DIR = profileDir;
      await ensureIsolatedProfileKeychain(profileDir);
      const initialCred = makeCredentialB64({ refreshToken: '1//cancel-v1' });
      const rotatedCred = makeCredentialB64({ refreshToken: '1//cancel-v2' });
      await writeSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, initialCred);
      const scopeDir = path.join(profileDir, path.dirname(AGY_CREDENTIAL_USER_SCOPE_REL));
      fs.mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(profileDir, AGY_CREDENTIAL_USER_SCOPE_REL), 'uabcdef0123456789', { mode: 0o600 });

      // Fake agy script that handles `models`, writes a rotated refresh token to Keychain, and emits a secret-bearing log before exiting non-zero.
      const fakeAgy = path.join(root, 'fake-agy.sh');
      fs.writeFileSync(
        fakeAgy,
        `#!/bin/sh
if [ "$1" = "models" ]; then
  echo "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)"
  exit 0
fi
/usr/bin/security add-generic-password -U -s "${AGY_KEYCHAIN_SERVICE}" -a "${AGY_KEYCHAIN_ACCOUNT}" -w "${rotatedCred}"
echo "Authorization: Bearer sk-secret-should-be-redacted-1234567890" >&2
exit 1
`,
        { mode: 0o755 },
      );
      process.env.DUPOND_AGY_BIN = fakeAgy;

      const adapter = new AgyCodingWorkerAdapter('gemini-3.8-flash-medium', new SandboxExecutor(), 'darwin');
      const avail = await adapter.isAvailable();
      assert.strictEqual(avail.available, true, avail.error);

      const streamedLogs: string[] = [];
      const res = await adapter.execute({
        taskId: 't-cancel-persist',
        taskKey: 'AGY-101',
        attemptNumber: 1,
        taskTitle: 'Test persistence on failure',
        taskDescription: 'Verify rotated token survives failure and logs redact secrets',
        worktreePath: repoDir,
        acceptanceCriteria: [],
        allowedPaths: ['README.md'],
        protectedPaths: [],
        onLog: (chunk) => streamedLogs.push(chunk),
      });

      assert.strictEqual(res.success, false);
      const joinedLogs = [...streamedLogs, ...res.logs].join('\n');
      assert.strictEqual(joinedLogs.includes('sk-secret-should-be-redacted-1234567890'), false);

      // Rotated refresh token MUST be persisted despite execution failure.
      const persisted = await readSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT);
      assert.strictEqual(persisted, rotatedCred);

      // Verify runBoundedSecurity didn't touch personal Keychains.
      const personalAfter = getPersonalKeychainState();
      assert.deepStrictEqual(personalAfter, personalBefore);
      await runBoundedSecurity(['default-keychain'], profileDir, 1500);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'blocks active-run and staged recovery when a tracked process-group descendant survives without sandboxHomeDir in argv',
    async () => {
      process.env.DUPOND_CONN_KEY = 'test-conn-key-persistence-04';
      const root = makeTempRoot();
      const profileDir = path.join(root, 'profile');
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

      await ensureIsolatedProfileKeychain(profileDir);
      const initialCred = makeCredentialB64({ refreshToken: '1//pgid-initial' });
      await writeSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, initialCred);

      // 1. Active-run-only recovery with a surviving descendant (`/bin/sleep 30`, no sandboxHomeDir in argv).
      const sbActive = path.join(root, 'sb-active-pgid');
      fs.mkdirSync(sbActive, { recursive: true, mode: 0o700 });
      const activeRotated = makeCredentialB64({ refreshToken: '1//pgid-active-rotated' });

      const sleeper1 = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
      const pgid1 = sleeper1.pid!;
      try {
        await assert.rejects(
          () =>
            runWithIsolatedAgyProfile(profileDir, async ({ prepareSandboxHome, onExecutionStarted }) => {
              await prepareSandboxHome(sbActive);
              onExecutionStarted({
                sandboxHomeDir: sbActive,
                mode: 'process_group',
                pid: pgid1,
                pgid: pgid1,
                startedAtMs: Date.now(),
              });
              await writeSyntheticKeychainItem(sbActive, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, activeRotated);
              return 'ok';
            }),
          /did not confirm termination/i,
        );

        // Must fail closed on reconcile while sleeper1 is alive: zero credential mutation, sandbox preserved.
        await assert.rejects(() => reconcileAgyProfileRecovery(profileDir), /still active|still running/i);
        assert.strictEqual(
          await readSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT),
          initialCred,
        );
        assert.strictEqual(fs.existsSync(sbActive), true);
      } finally {
        try {
          process.kill(-pgid1, 'SIGKILL');
        } catch {}
        await new Promise((r) => sleeper1.once('close', r));
      }

      // Once confirmed stopped, recovery commits rotated token and cleans up sandbox.
      await reconcileAgyProfileRecovery(profileDir);
      assert.strictEqual(
        await readSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT),
        activeRotated,
      );
      assert.strictEqual(fs.existsSync(sbActive), false);

      // 2. Staged recovery (.dupond-agy-recovery.json.enc) with tracked execution still alive.
      const sbStaged = path.join(root, 'sb-staged-pgid');
      fs.mkdirSync(sbStaged, { recursive: true, mode: 0o700 });
      const stagedRotated = makeCredentialB64({ refreshToken: '1//pgid-staged-rotated' });

      // Create staged recovery bundle via fault injection, then spawn a live process claiming that pgid.
      const sleeper2 = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
      const pgid2 = sleeper2.pid!;
      try {
        await assert.rejects(
          () =>
            runWithIsolatedAgyProfile(
              profileDir,
              async ({ prepareSandboxHome, onExecutionStarted }) => {
                await prepareSandboxHome(sbStaged);
                onExecutionStarted({
                  sandboxHomeDir: sbStaged,
                  mode: 'process_group',
                  pid: pgid2,
                  pgid: pgid2,
                  startedAtMs: Date.now(),
                });
                await writeSyntheticKeychainItem(sbStaged, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT, stagedRotated);
                return 'ok';
              },
              {
                // Bypass stop check only during initial run so we can stage the bundle while sleeper2 stays alive.
                confirmProcessesStopped: async () => ({ stopped: true }),
                onFault: (stage) => {
                  if (stage === 'after_stage_before_keychain') throw new Error('INJECTED_STAGED_CRASH');
                },
              },
            ),
          /INJECTED_STAGED_CRASH/,
        );

        // Real recovery check MUST block staged replay while pgid2 is alive: zero mutation, sandbox preserved.
        await assert.rejects(() => reconcileAgyProfileRecovery(profileDir), /still active|still running/i);
        assert.strictEqual(
          await readSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT),
          activeRotated,
        );
        assert.strictEqual(fs.existsSync(sbStaged), true);
        assert.strictEqual(fs.existsSync(path.join(profileDir, '.dupond-agy-recovery.json.enc')), true);
      } finally {
        try {
          process.kill(-pgid2, 'SIGKILL');
        } catch {}
        await new Promise((r) => sleeper2.once('close', r));
      }

      // Once confirmed stopped, staged replay commits stagedRotated and cleans up.
      await reconcileAgyProfileRecovery(profileDir);
      assert.strictEqual(
        await readSyntheticKeychainItem(profileDir, AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT),
        stagedRotated,
      );
      assert.strictEqual(fs.existsSync(sbStaged), false);
      assert.strictEqual(fs.existsSync(path.join(profileDir, '.dupond-agy-recovery.json.enc')), false);
    },
  );
});
