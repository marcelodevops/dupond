import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { describe, it } from 'vitest';

const isolatedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-kc-proto-env-')));
process.env.DUPOND_DB_PATH = path.join(isolatedDir, 'dupond.db');
process.env.DUPOND_STATE_FILE = path.join(isolatedDir, 'dupond_state.json');
process.env.DUPOND_CONN_KEY_PATH = path.join(isolatedDir, '.dupond_conn_key');

function runSeatbelt(
  profile: string,
  cmd: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs = 3000,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, cmd, ...args], {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf-8')));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
    });
  });
}

describe('Dedicated Antigravity macOS Keychain prototype', () => {
  it('keeps production macOS Antigravity gate disabled', async () => {
    const { isAgyOnboardingSupported } = await import('../src/server/worker/agyAuthManager.js');
    assert.strictEqual(isAgyOnboardingSupported('darwin'), false);
    assert.strictEqual(isAgyOnboardingSupported('linux'), true);
  });

  it.skipIf(process.platform !== 'darwin')(
    'provisions isolated Keychain, enforces explicit copy unlock, supports create/read/update in Seatbelt, serializes concurrency, cleans up, and leaves personal Keychains unchanged',
    async () => {
      const {
        ensureIsolatedProfileKeychain,
        prepareSandboxKeychainCopy,
        profileKeychainPath,
        readSyntheticKeychainItem,
        runBoundedSecurity,
        withProfileKeychainLock,
        writeSyntheticKeychainItem,
      } = await import('../src/server/worker/agyKeychainPrototype.js');

      const realDefaultBefore = execFileSync('/usr/bin/security', ['default-keychain'], { encoding: 'utf-8' }).trim();
      const realListBefore = execFileSync('/usr/bin/security', ['list-keychains'], { encoding: 'utf-8' }).trim();

      const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-kc-proto-')));
      const profileDir = path.join(tmpBase, 'agy-profile');
      const sandboxHome = path.join(tmpBase, 'sandbox-home');
      const worktree = path.join(tmpBase, 'worktree');
      const uninitProfileDir = path.join(tmpBase, 'uninit-profile');
      fs.mkdirSync(sandboxHome, { recursive: true, mode: 0o700 });
      fs.mkdirSync(worktree, { recursive: true });

      try {
        // 1. Initialization failure: orphan .keychain-db without .enc secret fails closed
        const orphanKc = profileKeychainPath(uninitProfileDir);
        fs.mkdirSync(path.dirname(orphanKc), { recursive: true, mode: 0o700 });
        fs.writeFileSync(orphanKc, 'corrupt-orphan');
        await assert.rejects(
          () => ensureIsolatedProfileKeychain(uninitProfileDir),
          /without its encrypted password file/,
        );

        // Initialization timeout cleans up freshly created artifacts
        const failInitDir = path.join(tmpBase, 'fail-init-profile');
        await assert.rejects(
          () => ensureIsolatedProfileKeychain(failInitDir, { timeoutMs: 1 }),
          /timed out/i,
        );
        assert.strictEqual(fs.existsSync(profileKeychainPath(failInitDir)), false);
        assert.strictEqual(fs.existsSync(path.join(failInitDir, '.dupond-keychain-secret.enc')), false);

        // 2. Provision dedicated profile Keychain & verify synthetic create/read/update
        const kcPath = await ensureIsolatedProfileKeychain(profileDir);
        assert.ok(fs.existsSync(kcPath));

        const svc = 'dupond-synth-agy-svc';
        const acct = 'dupond-synth-agy-acct';
        const val1 = `synth-tok-1-${crypto.randomBytes(6).toString('hex')}`;
        const val2 = `synth-tok-2-${crypto.randomBytes(6).toString('hex')}`;
        const val3 = `synth-tok-3-${crypto.randomBytes(6).toString('hex')}`;

        await writeSyntheticKeychainItem(profileDir, svc, acct, val1);
        assert.strictEqual(await readSyntheticKeychainItem(profileDir, svc, acct), val1);
        await writeSyntheticKeychainItem(profileDir, svc, acct, val2);
        assert.strictEqual(await readSyntheticKeychainItem(profileDir, svc, acct), val2);

        // 3. Copied Keychain WITHOUT unlock must fail/timeout (unlocking original does not unlock copy)
        const lockedCopyHome = path.join(tmpBase, 'locked-copy-home');
        const lockedCopyKc = path.join(lockedCopyHome, 'Library', 'Keychains', 'dupond-agy.keychain-db');
        fs.mkdirSync(path.dirname(lockedCopyKc), { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(lockedCopyHome, 'Library', 'Preferences'), { recursive: true, mode: 0o700 });
        fs.copyFileSync(kcPath, lockedCopyKc);
        await runBoundedSecurity(['list-keychains', '-d', 'user', '-s', lockedCopyKc], lockedCopyHome, 3000);
        await runBoundedSecurity(['default-keychain', '-d', 'user', '-s', lockedCopyKc], lockedCopyHome, 3000);
        const lockedRead = await runBoundedSecurity(
          ['find-generic-password', '-s', svc, '-a', acct, '-w'],
          lockedCopyHome,
          2000,
        );
        assert.ok(lockedRead.timedOut || lockedRead.code !== 0, 'Locked copy must not be readable without explicit unlock');

        // 4. prepareSandboxKeychainCopy explicitly unlocks copy on host & supports Seatbelt create/read/update
        const ephemeral = await prepareSandboxKeychainCopy(profileDir, sandboxHome);
        assert.ok(fs.existsSync(ephemeral.sandboxKeychainPath));

        const realUserHome = os.homedir();
        const seatbeltProfile = `(version 1)
(allow default)
(deny file-write*)
(allow file-read-metadata)
(deny file-read-data (subpath "${realUserHome}"))
(allow file-read-data (subpath "${worktree}"))
(allow file-read-data (subpath "${sandboxHome}"))
(allow file-write* (subpath "${worktree}"))
(allow file-write* (subpath "${sandboxHome}"))
(allow file-write* (subpath "/dev/null"))
(allow network*)
`;
        const sbEnv = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: sandboxHome, TMPDIR: sandboxHome };

        const sbRead = await runSeatbelt(
          seatbeltProfile,
          '/usr/bin/security',
          ['find-generic-password', '-s', svc, '-a', acct, '-w'],
          sbEnv,
          worktree,
        );
        assert.strictEqual(sbRead.code, 0);
        assert.strictEqual(sbRead.stdout, val2);

        const sbUpdate = await runSeatbelt(
          seatbeltProfile,
          '/usr/bin/security',
          ['add-generic-password', '-U', '-s', svc, '-a', acct, '-w', val3],
          sbEnv,
          worktree,
        );
        assert.strictEqual(sbUpdate.code, 0);

        const sbCreate = await runSeatbelt(
          seatbeltProfile,
          '/usr/bin/security',
          ['add-generic-password', '-U', '-s', `${svc}-2`, '-a', acct, '-w', val1],
          sbEnv,
          worktree,
        );
        assert.strictEqual(sbCreate.code, 0);

        const sbReadAfter = await runSeatbelt(
          seatbeltProfile,
          '/usr/bin/security',
          ['find-generic-password', '-s', svc, '-a', acct, '-w'],
          sbEnv,
          worktree,
        );
        assert.strictEqual(sbReadAfter.code, 0);
        assert.strictEqual(sbReadAfter.stdout, val3);

        // Preserve existing sandbox protections: personal Keychains remain unreadable
        const sbPersonal = await runSeatbelt(
          seatbeltProfile,
          '/bin/ls',
          [path.join(realUserHome, 'Library', 'Keychains')],
          sbEnv,
          worktree,
        );
        assert.notStrictEqual(sbPersonal.code, 0);

        // 5. Cleanup removes ephemeral copy
        await ephemeral.cleanup();
        assert.strictEqual(fs.existsSync(ephemeral.sandboxKeychainPath), false);

        // 6. Concurrent access serializes cleanly per profile
        const order: number[] = [];
        await Promise.all([
          withProfileKeychainLock(profileDir, async () => {
            await new Promise((r) => setTimeout(r, 40));
            order.push(1);
          }),
          withProfileKeychainLock(profileDir, async () => {
            order.push(2);
          }),
        ]);
        assert.deepStrictEqual(order, [1, 2]);

        // 7. Personal Keychain defaults & search lists remain untouched
        const realDefaultAfter = execFileSync('/usr/bin/security', ['default-keychain'], { encoding: 'utf-8' }).trim();
        const realListAfter = execFileSync('/usr/bin/security', ['list-keychains'], { encoding: 'utf-8' }).trim();
        assert.strictEqual(realDefaultAfter, realDefaultBefore);
        assert.strictEqual(realListAfter, realListBefore);
      } finally {
        fs.rmSync(tmpBase, { recursive: true, force: true });
        fs.rmSync(isolatedDir, { recursive: true, force: true });
      }
    },
  );
});
