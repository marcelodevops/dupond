import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { decryptSecret, encryptSecret } from '../projects/secretCrypto.js';

const KEYCHAIN_FILENAME = 'dupond-agy.keychain-db';
const KEYCHAIN_SECRET_FILENAME = '.dupond-keychain-secret.enc';
const KEYCHAIN_LOCK_FILENAME = '.dupond-keychain.lock';
const SECURITY_BIN = '/usr/bin/security';
const DEFAULT_SECURITY_TIMEOUT_MS = 3_000;

const profileLocks = new Map<string, Promise<void>>();

export interface SecurityCallResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface EphemeralSandboxKeychain {
  sandboxKeychainPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Runs /usr/bin/security with an isolated HOME/TMPDIR and a strict deadline,
 * terminating the child with SIGKILL if it blocks on any interactive prompt.
 */
export function runBoundedSecurity(
  args: string[],
  homeDir: string,
  timeoutMs: number = DEFAULT_SECURITY_TIMEOUT_MS,
): Promise<SecurityCallResult> {
  return new Promise((resolve) => {
    const child = spawn(SECURITY_BIN, args, {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: homeDir,
        TMPDIR: homeDir,
      },
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
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });
  });
}

async function runSecurityOrThrow(
  args: string[],
  homeDir: string,
  actionLabel: string,
  timeoutMs: number = DEFAULT_SECURITY_TIMEOUT_MS,
): Promise<string> {
  const res = await runBoundedSecurity(args, homeDir, timeoutMs);
  if (res.timedOut) {
    throw new Error(`Keychain operation "${actionLabel}" timed out after ${timeoutMs}ms.`);
  }
  if (res.code !== 0) {
    throw new Error(`Keychain operation "${actionLabel}" failed (exit ${res.code}): ${res.stderr || 'unknown error'}`);
  }
  return res.stdout;
}

/**
 * Serializes all Keychain provisioning, unlocking, and copy operations per
 * profile directory using both an in-process queue and a filesystem lockfile.
 */
export async function withProfileKeychainLock<T>(
  profileDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const resolved = path.resolve(profileDir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const lockPath = path.join(resolved, KEYCHAIN_LOCK_FILENAME);

  const prev = profileLocks.get(resolved) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  profileLocks.set(resolved, prev.then(() => current));

  await prev;

  let lockFd: number | null = null;
  const deadline = Date.now() + 10_000;
  try {
    while (lockFd === null) {
      try {
        lockFd = fs.openSync(lockPath, 'wx', 0o600);
      } catch (err: any) {
        if (err?.code !== 'EEXIST' || Date.now() >= deadline) {
          throw new Error(`Timed out waiting for profile Keychain lock at ${lockPath}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    return await fn();
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {}
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
    releaseQueue();
    if (profileLocks.get(resolved) === current) {
      profileLocks.delete(resolved);
    }
  }
}

export function profileKeychainPath(profileDir: string): string {
  return path.join(path.resolve(profileDir), 'Library', 'Keychains', KEYCHAIN_FILENAME);
}

function profileSecretPath(profileDir: string): string {
  return path.join(path.resolve(profileDir), KEYCHAIN_SECRET_FILENAME);
}

/**
 * Provisions a dedicated, password-encrypted Keychain under `profileDir` and
 * configures Keychain preferences strictly under `HOME=profileDir`.
 * Never modifies the logged-in user's personal Keychain defaults/search list.
 */
export async function ensureIsolatedProfileKeychain(
  profileDir: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  const resolved = path.resolve(profileDir);
  const kcPath = profileKeychainPath(resolved);
  const secretPath = profileSecretPath(resolved);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SECURITY_TIMEOUT_MS;

  return withProfileKeychainLock(resolved, async () => {
    const kcDir = path.dirname(kcPath);
    const prefDir = path.join(resolved, 'Library', 'Preferences');
    fs.mkdirSync(kcDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(prefDir, { recursive: true, mode: 0o700 });

    const createdFresh = !fs.existsSync(kcPath);
    let password: string;

    if (fs.existsSync(secretPath)) {
      const encrypted = fs.readFileSync(secretPath, 'utf-8').trim();
      password = decryptSecret(encrypted);
    } else {
      if (!createdFresh) {
        throw new Error(`Profile Keychain exists at ${kcPath} without its encrypted password file.`);
      }
      password = crypto.randomBytes(24).toString('hex');
      const encrypted = encryptSecret(password);
      fs.writeFileSync(secretPath, encrypted, { mode: 0o600 });
      fs.chmodSync(secretPath, 0o600);
    }

    try {
      if (createdFresh) {
        await runSecurityOrThrow(['create-keychain', '-p', password, kcPath], resolved, 'create-keychain', timeoutMs);
        await runSecurityOrThrow(['set-keychain-settings', kcPath], resolved, 'set-keychain-settings', timeoutMs);
      }
      await runSecurityOrThrow(['list-keychains', '-d', 'user', '-s', kcPath], resolved, 'list-keychains', timeoutMs);
      await runSecurityOrThrow(['default-keychain', '-d', 'user', '-s', kcPath], resolved, 'default-keychain', timeoutMs);
      await runSecurityOrThrow(['unlock-keychain', '-p', password, kcPath], resolved, 'unlock-keychain', timeoutMs);
      return kcPath;
    } catch (err) {
      if (createdFresh) {
        try {
          if (fs.existsSync(kcPath)) fs.rmSync(kcPath, { force: true });
        } catch {}
        try {
          if (fs.existsSync(secretPath)) fs.rmSync(secretPath, { force: true });
        } catch {}
      }
      throw err;
    }
  });
}

/**
 * Copies the profile Keychain into an ephemeral sandbox HOME, configures only
 * that sandbox HOME's Keychain preferences, and unlocks the copy on the host
 * without exposing the Keychain password to the sandboxed worker.
 */
export async function prepareSandboxKeychainCopy(
  profileDir: string,
  sandboxHomeDir: string,
  options?: { timeoutMs?: number },
): Promise<EphemeralSandboxKeychain> {
  const resolvedProfile = path.resolve(profileDir);
  const resolvedSandbox = path.resolve(sandboxHomeDir);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SECURITY_TIMEOUT_MS;

  return withProfileKeychainLock(resolvedProfile, async () => {
    const srcKcPath = profileKeychainPath(resolvedProfile);
    const secretPath = profileSecretPath(resolvedProfile);
    if (!fs.existsSync(srcKcPath) || !fs.existsSync(secretPath)) {
      throw new Error(`Dedicated profile Keychain is not initialized under ${resolvedProfile}`);
    }

    const password = decryptSecret(fs.readFileSync(secretPath, 'utf-8').trim());
    const dstKcDir = path.join(resolvedSandbox, 'Library', 'Keychains');
    const dstPrefDir = path.join(resolvedSandbox, 'Library', 'Preferences');
    fs.mkdirSync(dstKcDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dstPrefDir, { recursive: true, mode: 0o700 });

    const sandboxKeychainPath = path.join(dstKcDir, KEYCHAIN_FILENAME);
    fs.copyFileSync(srcKcPath, sandboxKeychainPath);
    fs.chmodSync(sandboxKeychainPath, 0o600);

    await runSecurityOrThrow(['list-keychains', '-d', 'user', '-s', sandboxKeychainPath], resolvedSandbox, 'sandbox-list-keychains', timeoutMs);
    await runSecurityOrThrow(['default-keychain', '-d', 'user', '-s', sandboxKeychainPath], resolvedSandbox, 'sandbox-default-keychain', timeoutMs);
    await runSecurityOrThrow(['unlock-keychain', '-p', password, sandboxKeychainPath], resolvedSandbox, 'sandbox-unlock-keychain', timeoutMs);

    return {
      sandboxKeychainPath,
      cleanup: async () => {
        try {
          await runBoundedSecurity(['lock-keychain', sandboxKeychainPath], resolvedSandbox, 1500);
        } catch {}
        try {
          if (fs.existsSync(sandboxKeychainPath)) fs.rmSync(sandboxKeychainPath, { force: true });
        } catch {}
      },
    };
  });
}

/**
 * Writes a Keychain item using agy/go-keyring's exact invocation (no -T or -A).
 */
export async function writeSyntheticKeychainItem(
  homeDir: string,
  service: string,
  account: string,
  value: string,
  timeoutMs: number = DEFAULT_SECURITY_TIMEOUT_MS,
): Promise<void> {
  await runSecurityOrThrow(
    ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value],
    homeDir,
    'add-generic-password',
    timeoutMs,
  );
}

/**
 * Reads a Keychain item using agy/go-keyring's exact lookup flags.
 */
export async function readSyntheticKeychainItem(
  homeDir: string,
  service: string,
  account: string,
  timeoutMs: number = DEFAULT_SECURITY_TIMEOUT_MS,
): Promise<string> {
  return runSecurityOrThrow(
    ['find-generic-password', '-s', service, '-a', account, '-w'],
    homeDir,
    'find-generic-password',
    timeoutMs,
  );
}
