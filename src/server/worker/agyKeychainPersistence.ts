import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { decryptSecret, encryptSecret } from '../projects/secretCrypto.js';
import {
  ensureIsolatedProfileKeychain,
  profileKeychainPath,
  readSyntheticKeychainItem,
  runBoundedSecurity,
  withProfileKeychainLock,
  writeSyntheticKeychainItem,
} from './agyKeychainPrototype.js';

export const AGY_KEYCHAIN_SERVICE = 'gemini';
export const AGY_KEYCHAIN_ACCOUNT = 'antigravity';

const META_FILENAME = '.dupond-agy-meta.json';
const ACTIVE_RUN_FILENAME = '.dupond-agy-active-run.json';
const RECOVERY_BUNDLE_FILENAME = '.dupond-agy-recovery.json.enc';
const KEYCHAIN_FILENAME = 'dupond-agy.keychain-db';
const KEYCHAIN_SECRET_FILENAME = '.dupond-keychain-secret.enc';

export const AGY_CREDENTIAL_USER_SCOPE_REL = 'Library/Application Support/antigravity/credential-user-scope';

export const AGY_SYNCED_AUTH_REL_PATHS = [
  AGY_CREDENTIAL_USER_SCOPE_REL,
  '.gemini/antigravity-cli/jetski_state.pbtxt',
  '.gemini/antigravity-cli/installation_id',
  '.gemini/antigravity-cli/cache/default_project_id.txt',
  '.gemini/antigravity-cli/cache/onboarding.json',
] as const;

export const AGY_MINIMAL_SANDBOX_CONFIG = {
  targetRelToHome: '.gemini/config/config.json',
  content: '{}\n',
  mode: 0o600,
};

export interface AgyProfileMeta {
  version: 1;
  generation: number;
  authEpoch: string;
  boundEmail?: string;
  boundUserScope?: string;
  updatedAt: string;
}

export interface AgyActiveRunRecord {
  version: 1;
  runId: string;
  sandboxHomeDir: string;
  expectedGeneration: number;
  targetGeneration: number;
  authEpoch: string;
  boundEmail?: string;
  boundUserScope?: string;
  hostPid: number;
  startedAt: string;
}

export interface AgyRecoveryBundle {
  version: 1;
  runId: string;
  expectedGeneration: number;
  targetGeneration: number;
  authEpoch: string;
  boundEmail?: string;
  boundUserScope?: string;
  keychainPayloadB64: string;
  authFiles: Record<string, string>;
  stagedAt: string;
}

export interface ValidatedAgyCredential {
  rawPayloadB64: string;
  idTokenEmail: string;
  refreshTokenDigest: string;
  expiry: string;
}

export type FaultInjectionStage =
  | 'before_stage'
  | 'after_stage_before_keychain'
  | 'after_keychain_before_files'
  | 'after_files_before_meta'
  | 'after_meta_before_cleanup';

export interface PersistenceOptions {
  timeoutMs?: number;
  onFault?: (stage: FaultInjectionStage) => void | Promise<void>;
  confirmProcessesStopped?: (sandboxHomeDir: string, hostPid?: number) => Promise<{ stopped: boolean; reason?: string }>;
}

function metaPath(profileDir: string): string {
  return path.join(path.resolve(profileDir), META_FILENAME);
}

function activeRunPath(profileDir: string): string {
  return path.join(path.resolve(profileDir), ACTIVE_RUN_FILENAME);
}

function recoveryBundlePath(profileDir: string): string {
  return path.join(path.resolve(profileDir), RECOVERY_BUNDLE_FILENAME);
}

function profileSecretPath(profileDir: string): string {
  return path.join(path.resolve(profileDir), KEYCHAIN_SECRET_FILENAME);
}

export function atomicWriteFileSync(targetPath: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tmpPath, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmpPath, mode);
  fs.renameSync(tmpPath, targetPath);
}

export function readAgyProfileMeta(profileDir: string): AgyProfileMeta {
  const file = metaPath(profileDir);
  if (!fs.existsSync(file)) {
    const initial: AgyProfileMeta = {
      version: 1,
      generation: 0,
      authEpoch: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(file, `${JSON.stringify(initial, null, 2)}\n`, 0o600);
    return initial;
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AgyProfileMeta>;
  return {
    version: 1,
    generation: typeof parsed.generation === 'number' && Number.isInteger(parsed.generation) ? parsed.generation : 0,
    authEpoch: typeof parsed.authEpoch === 'string' && parsed.authEpoch ? parsed.authEpoch : crypto.randomUUID(),
    ...(typeof parsed.boundEmail === 'string' && parsed.boundEmail ? { boundEmail: parsed.boundEmail } : {}),
    ...(typeof parsed.boundUserScope === 'string' && parsed.boundUserScope ? { boundUserScope: parsed.boundUserScope } : {}),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

export function writeAgyProfileMeta(profileDir: string, meta: AgyProfileMeta): void {
  atomicWriteFileSync(metaPath(profileDir), `${JSON.stringify(meta, null, 2)}\n`, 0o600);
}

export function rotateAgyProfileAuthEpoch(profileDir: string): AgyProfileMeta {
  const prev = readAgyProfileMeta(profileDir);
  const next: AgyProfileMeta = {
    version: 1,
    generation: prev.generation + 1,
    authEpoch: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  writeAgyProfileMeta(profileDir, next);
  return next;
}

/**
 * Validates the unprefixed base64-encoded JSON Keychain payload written by agy.
 * Note: matching id_token_email/credential-user-scope detects cross-account
 * conflicts; worker-editable metadata is not cryptographic proof of identity.
 */
export function validateAgyKeychainPayload(rawPayloadB64: string): ValidatedAgyCredential {
  const trimmed = rawPayloadB64.trim();
  if (!trimmed) {
    throw new Error('Antigravity Keychain payload is empty.');
  }
  const candidate = trimmed.startsWith('go-keyring-base64:')
    ? trimmed.slice('go-keyring-base64:'.length)
    : trimmed;

  let decodedObj: any;
  try {
    const utf8 = Buffer.from(candidate, 'base64').toString('utf-8');
    decodedObj = JSON.parse(utf8);
  } catch {
    throw new Error('Antigravity Keychain payload is not valid base64-encoded JSON.');
  }

  if (!decodedObj || typeof decodedObj !== 'object' || Array.isArray(decodedObj)) {
    throw new Error('Antigravity Keychain payload must decode to a JSON object.');
  }
  const token = decodedObj.token;
  if (!token || typeof token !== 'object' || Array.isArray(token)) {
    throw new Error('Antigravity Keychain payload missing token object.');
  }
  for (const field of ['access_token', 'token_type', 'refresh_token', 'expiry'] as const) {
    if (typeof token[field] !== 'string' || token[field].trim().length === 0) {
      throw new Error(`Antigravity Keychain payload missing valid token.${field}.`);
    }
  }
  if (Number.isNaN(Date.parse(token.expiry))) {
    throw new Error('Antigravity Keychain payload has invalid token.expiry timestamp.');
  }
  if (typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in)) {
    throw new Error('Antigravity Keychain payload missing finite token.expires_in.');
  }
  if (typeof decodedObj.auth_method !== 'string' || !decodedObj.auth_method.trim()) {
    throw new Error('Antigravity Keychain payload missing auth_method.');
  }
  if (typeof decodedObj.id_token_email !== 'string' || !decodedObj.id_token_email.includes('@')) {
    throw new Error('Antigravity Keychain payload missing valid id_token_email.');
  }

  const refreshTokenDigest = crypto
    .createHash('sha256')
    .update(token.refresh_token)
    .digest('hex')
    .slice(0, 16);

  return {
    rawPayloadB64: trimmed,
    idTokenEmail: decodedObj.id_token_email.trim().toLowerCase(),
    refreshTokenDigest,
    expiry: token.expiry,
  };
}

export function validateAllowlistedAuthFile(relPath: string, content: Buffer): string {
  if (relPath === AGY_CREDENTIAL_USER_SCOPE_REL) {
    const text = content.toString('utf-8').trim();
    if (!/^u[0-9a-f]{16}$/.test(text) || content.byteLength > 64) {
      throw new Error(`Invalid credential-user-scope format.`);
    }
    return text;
  }
  if (relPath === '.gemini/antigravity-cli/installation_id') {
    const text = content.toString('utf-8').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
      throw new Error('Invalid installation_id UUID format.');
    }
    return text;
  }
  if (relPath === '.gemini/antigravity-cli/cache/default_project_id.txt') {
    const text = content.toString('utf-8').trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(text)) {
      throw new Error('Invalid default_project_id.txt format.');
    }
    return text;
  }
  if (relPath === '.gemini/antigravity-cli/cache/onboarding.json') {
    if (content.byteLength > 2048) {
      throw new Error('onboarding.json exceeds size limit.');
    }
    const parsed = JSON.parse(content.toString('utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('onboarding.json must be a JSON object.');
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'boolean') {
        throw new Error(`onboarding.json field "${k}" must be boolean.`);
      }
    }
    return content.toString('utf-8');
  }
  if (relPath === '.gemini/antigravity-cli/jetski_state.pbtxt') {
    if (content.byteLength > 8192) {
      throw new Error('jetski_state.pbtxt exceeds size limit.');
    }
    const text = content.toString('utf-8');
    if (text.includes('\u0000')) {
      throw new Error('jetski_state.pbtxt contains invalid null bytes.');
    }
    return text;
  }
  throw new Error(`Path "${relPath}" is not in the allowlisted Antigravity auth/state file list.`);
}

/**
 * Inspects Keychain metadata without decrypting secret values (-d omitted).
 * Rejects duplicate/conflicting entries for service="gemini", account="antigravity".
 */
export async function countAgyKeychainItems(
  kcPath: string,
  homeDir: string,
  timeoutMs = 3_000,
): Promise<number> {
  const res = await runBoundedSecurity(['dump-keychain', kcPath], homeDir, timeoutMs);
  if (res.timedOut) {
    throw new Error(`Keychain metadata inspection timed out after ${timeoutMs}ms.`);
  }
  if (res.code !== 0) {
    throw new Error(`Keychain metadata inspection failed (exit ${res.code}): ${res.stderr || 'unknown error'}`);
  }
  const blocks = res.stdout.split(/\nclass:\s*"/);
  let matches = 0;
  for (const block of blocks) {
    const hasGenp = block.startsWith('genp"') || block.includes('class: "genp"');
    if (!hasGenp) continue;
    const hasService = new RegExp(`"svce"<blob>="${AGY_KEYCHAIN_SERVICE}"`).test(block);
    const hasAccount = new RegExp(`"acct"<blob>="${AGY_KEYCHAIN_ACCOUNT}"`).test(block);
    if (hasService && hasAccount) {
      matches += 1;
    }
  }
  return matches;
}

export async function defaultConfirmProcessesStopped(
  sandboxHomeDir: string,
  hostPid?: number,
): Promise<{ stopped: boolean; reason?: string }> {
  if (hostPid && hostPid !== process.pid) {
    try {
      process.kill(hostPid, 0);
      return { stopped: false, reason: `Host process ${hostPid} is still alive.` };
    } catch (err: any) {
      if (err?.code !== 'ESRCH') {
        return { stopped: false, reason: `Unable to confirm host process ${hostPid} stopped: ${err?.code || err}` };
      }
    }
  }

  return new Promise((resolve) => {
    const child = spawn('/bin/ps', ['-eo', 'pid=,command='], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d.toString('utf-8')));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    }, 3_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        resolve({ stopped: false, reason: 'Failed to verify descendant process termination via ps.' });
        return;
      }
      const resolvedSandbox = path.resolve(sandboxHomeDir);
      const activeLine = stdout
        .split(/\r?\n/)
        .find((line) => line.includes(resolvedSandbox) && !line.includes('/bin/ps -eo'));
      if (activeLine) {
        resolve({ stopped: false, reason: `Process referencing ${resolvedSandbox} is still running.` });
        return;
      }
      resolve({ stopped: true });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stopped: false, reason: 'Failed to execute ps for descendant verification.' });
    });
  });
}

export async function hasAgyKeychainCredential(profileDir: string, timeoutMs = 3_000): Promise<boolean> {
  const resolved = path.resolve(profileDir);
  const kcPath = profileKeychainPath(resolved);
  if (!fs.existsSync(kcPath) || !fs.existsSync(profileSecretPath(resolved))) {
    return false;
  }
  try {
    const count = await countAgyKeychainItems(kcPath, resolved, timeoutMs);
    return count === 1;
  } catch {
    return false;
  }
}

export async function extractAndValidateFromHome(
  sourceHomeDir: string,
  expectedIdentity?: { boundEmail?: string; boundUserScope?: string },
  timeoutMs = 3_000,
): Promise<{
  credential: ValidatedAgyCredential;
  authFiles: Record<string, string>;
  userScope?: string;
}> {
  const resolvedHome = path.resolve(sourceHomeDir);
  const kcPath = profileKeychainPath(resolvedHome);
  if (!fs.existsSync(kcPath)) {
    throw new Error(`Expected Keychain database missing at ${kcPath}`);
  }

  const itemCount = await countAgyKeychainItems(kcPath, resolvedHome, timeoutMs);
  if (itemCount === 0) {
    throw new Error(`No ${AGY_KEYCHAIN_SERVICE}/${AGY_KEYCHAIN_ACCOUNT} Keychain item found in ${kcPath}`);
  }
  if (itemCount > 1) {
    throw new Error(
      `Conflicting duplicate ${AGY_KEYCHAIN_SERVICE}/${AGY_KEYCHAIN_ACCOUNT} items (${itemCount}) found in ${kcPath}`,
    );
  }

  const rawPayload = await readSyntheticKeychainItem(
    resolvedHome,
    AGY_KEYCHAIN_SERVICE,
    AGY_KEYCHAIN_ACCOUNT,
    timeoutMs,
  );
  const credential = validateAgyKeychainPayload(rawPayload);

  if (
    expectedIdentity?.boundEmail &&
    credential.idTokenEmail !== expectedIdentity.boundEmail.trim().toLowerCase()
  ) {
    throw new Error(
      'Account consistency conflict: extracted Keychain id_token_email does not match the bound profile identity.',
    );
  }

  const authFiles: Record<string, string> = {};
  let userScope: string | undefined;
  for (const rel of AGY_SYNCED_AUTH_REL_PATHS) {
    const full = path.join(resolvedHome, rel);
    if (!fs.existsSync(full)) continue;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing non-regular auth file at ${rel}`);
    }
    const buf = fs.readFileSync(full);
    const validatedText = validateAllowlistedAuthFile(rel, buf);
    if (rel === AGY_CREDENTIAL_USER_SCOPE_REL) {
      userScope = validatedText;
      if (expectedIdentity?.boundUserScope && userScope !== expectedIdentity.boundUserScope) {
        throw new Error(
          'Account consistency conflict: extracted credential-user-scope does not match the bound profile scope.',
        );
      }
    }
    authFiles[rel] = buf.toString('base64');
  }

  return { credential, authFiles, userScope };
}

async function commitRecoveryBundleLocked(
  profileDir: string,
  bundle: AgyRecoveryBundle,
  options?: PersistenceOptions,
): Promise<void> {
  const resolvedProfile = path.resolve(profileDir);
  const timeoutMs = options?.timeoutMs ?? 3_000;
  const meta = readAgyProfileMeta(resolvedProfile);

  // Fence replay against authEpoch and generation so stale recovery never overwrites newer credentials.
  if (bundle.authEpoch !== meta.authEpoch || meta.generation > bundle.targetGeneration) {
    try {
      fs.rmSync(recoveryBundlePath(resolvedProfile), { force: true });
    } catch {}
    try {
      fs.rmSync(activeRunPath(resolvedProfile), { force: true });
    } catch {}
    return;
  }

  if (meta.generation === bundle.targetGeneration) {
    // Already committed; verify Keychain item matches before cleaning up recovery state.
    const currentKc = await readSyntheticKeychainItem(
      resolvedProfile,
      AGY_KEYCHAIN_SERVICE,
      AGY_KEYCHAIN_ACCOUNT,
      timeoutMs,
    ).catch(() => '');
    if (currentKc !== bundle.keychainPayloadB64) {
      await writeSyntheticKeychainItem(
        resolvedProfile,
        AGY_KEYCHAIN_SERVICE,
        AGY_KEYCHAIN_ACCOUNT,
        bundle.keychainPayloadB64,
        timeoutMs,
      );
    }
    await options?.onFault?.('after_meta_before_cleanup');
    fs.rmSync(recoveryBundlePath(resolvedProfile), { force: true });
    fs.rmSync(activeRunPath(resolvedProfile), { force: true });
    return;
  }

  if (meta.generation !== bundle.expectedGeneration) {
    throw new Error(
      `Generation fence mismatch during recovery: expected ${bundle.expectedGeneration}, found ${meta.generation}. Recovery preserved.`,
    );
  }

  const validated = validateAgyKeychainPayload(bundle.keychainPayloadB64);

  await options?.onFault?.('after_stage_before_keychain');

  await writeSyntheticKeychainItem(
    resolvedProfile,
    AGY_KEYCHAIN_SERVICE,
    AGY_KEYCHAIN_ACCOUNT,
    bundle.keychainPayloadB64,
    timeoutMs,
  );
  const readBack = await readSyntheticKeychainItem(
    resolvedProfile,
    AGY_KEYCHAIN_SERVICE,
    AGY_KEYCHAIN_ACCOUNT,
    timeoutMs,
  );
  if (readBack !== bundle.keychainPayloadB64) {
    throw new Error('Host Keychain verification failed after write; recovery bundle preserved.');
  }

  await options?.onFault?.('after_keychain_before_files');

  for (const [rel, contentB64] of Object.entries(bundle.authFiles)) {
    const buf = Buffer.from(contentB64, 'base64');
    validateAllowlistedAuthFile(rel, buf);
    atomicWriteFileSync(path.join(resolvedProfile, rel), buf, 0o600);
  }

  await options?.onFault?.('after_files_before_meta');

  const userScopeBuf = bundle.authFiles[AGY_CREDENTIAL_USER_SCOPE_REL];
  const userScope = userScopeBuf ? Buffer.from(userScopeBuf, 'base64').toString('utf-8').trim() : meta.boundUserScope;
  writeAgyProfileMeta(resolvedProfile, {
    version: 1,
    generation: bundle.targetGeneration,
    authEpoch: bundle.authEpoch,
    boundEmail: bundle.boundEmail || validated.idTokenEmail,
    ...(userScope ? { boundUserScope: userScope } : {}),
    updatedAt: new Date().toISOString(),
  });

  await options?.onFault?.('after_meta_before_cleanup');

  fs.rmSync(recoveryBundlePath(resolvedProfile), { force: true });
  fs.rmSync(activeRunPath(resolvedProfile), { force: true });
}

async function reconcileLocked(profileDir: string, options?: PersistenceOptions): Promise<void> {
  const resolvedProfile = path.resolve(profileDir);
  const recFile = recoveryBundlePath(resolvedProfile);
  const activeFile = activeRunPath(resolvedProfile);
  const timeoutMs = options?.timeoutMs ?? 3_000;

  if (fs.existsSync(recFile)) {
    let stagedSandboxHome: string | null = null;
    if (fs.existsSync(activeFile)) {
      try {
        const active = JSON.parse(fs.readFileSync(activeFile, 'utf-8')) as Partial<AgyActiveRunRecord>;
        if (typeof active.sandboxHomeDir === 'string' && active.sandboxHomeDir) {
          stagedSandboxHome = active.sandboxHomeDir;
        }
      } catch {}
    }
    const encrypted = fs.readFileSync(recFile, 'utf-8').trim();
    const bundle = JSON.parse(decryptSecret(encrypted)) as AgyRecoveryBundle;
    await commitRecoveryBundleLocked(resolvedProfile, bundle, options);
    if (stagedSandboxHome) {
      try {
        fs.rmSync(stagedSandboxHome, { recursive: true, force: true });
      } catch {}
    }
  }

  if (fs.existsSync(activeFile)) {
    const active = JSON.parse(fs.readFileSync(activeFile, 'utf-8')) as AgyActiveRunRecord;
    const meta = readAgyProfileMeta(resolvedProfile);

    const stopCheck = await (options?.confirmProcessesStopped ?? defaultConfirmProcessesStopped)(
      active.sandboxHomeDir,
      active.hostPid,
    );
    if (!stopCheck.stopped) {
      throw new Error(
        `Cannot reconcile Antigravity profile while execution may still be active: ${stopCheck.reason || 'unknown process state'}`,
      );
    }

    if (active.authEpoch !== meta.authEpoch || active.expectedGeneration !== meta.generation) {
      // Stale active-run from an older authEpoch/generation; discard pointer and sandbox dir without overwriting newer auth.
      fs.rmSync(activeFile, { force: true });
      try {
        fs.rmSync(active.sandboxHomeDir, { recursive: true, force: true });
      } catch {}
      return;
    }

    // Attempt extraction from surviving sandbox workspace. Preserve everything on failure.
    const extracted = await extractAndValidateFromHome(
      active.sandboxHomeDir,
      {
        boundEmail: active.boundEmail ?? meta.boundEmail,
        boundUserScope: active.boundUserScope ?? meta.boundUserScope,
      },
      timeoutMs,
    );

    await options?.onFault?.('before_stage');

    const bundle: AgyRecoveryBundle = {
      version: 1,
      runId: active.runId,
      expectedGeneration: active.expectedGeneration,
      targetGeneration: active.targetGeneration,
      authEpoch: active.authEpoch,
      boundEmail: active.boundEmail ?? extracted.credential.idTokenEmail,
      boundUserScope: active.boundUserScope ?? extracted.userScope,
      keychainPayloadB64: extracted.credential.rawPayloadB64,
      authFiles: extracted.authFiles,
      stagedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(recFile, encryptSecret(JSON.stringify(bundle)), 0o600);
    await commitRecoveryBundleLocked(resolvedProfile, bundle, options);

    try {
      fs.rmSync(active.sandboxHomeDir, { recursive: true, force: true });
    } catch {}
  }
}

export async function reconcileAgyProfileRecovery(
  profileDir: string,
  options?: PersistenceOptions,
): Promise<void> {
  return withProfileKeychainLock(profileDir, () => reconcileLocked(profileDir, options));
}

async function prepareSandboxHomeLocked(
  profileDir: string,
  sandboxHomeDir: string,
  runId: string,
  meta: AgyProfileMeta,
  timeoutMs: number,
): Promise<string> {
  const resolvedProfile = path.resolve(profileDir);
  const resolvedSandbox = path.resolve(sandboxHomeDir);
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

  const runKc = async (args: string[], label: string) => {
    const res = await runBoundedSecurity(args, resolvedSandbox, timeoutMs);
    if (res.timedOut) throw new Error(`Keychain operation "${label}" timed out after ${timeoutMs}ms.`);
    if (res.code !== 0) {
      throw new Error(`Keychain operation "${label}" failed (exit ${res.code}): ${res.stderr || 'unknown error'}`);
    }
  };
  await runKc(['list-keychains', '-d', 'user', '-s', sandboxKeychainPath], 'sandbox-list-keychains');
  await runKc(['default-keychain', '-d', 'user', '-s', sandboxKeychainPath], 'sandbox-default-keychain');
  await runKc(['unlock-keychain', '-p', password, sandboxKeychainPath], 'sandbox-unlock-keychain');

  // Seed allowlisted auth/state files and minimal synthesized config (no plugins/hooks/MCP).
  for (const rel of AGY_SYNCED_AUTH_REL_PATHS) {
    const src = path.join(resolvedProfile, rel);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const dst = path.join(resolvedSandbox, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o600);
  }

  const minCfgPath = path.join(resolvedSandbox, AGY_MINIMAL_SANDBOX_CONFIG.targetRelToHome);
  atomicWriteFileSync(minCfgPath, AGY_MINIMAL_SANDBOX_CONFIG.content, AGY_MINIMAL_SANDBOX_CONFIG.mode);

  // Register durable active-run recovery pointer BEFORE launching agy.
  const activeRecord: AgyActiveRunRecord = {
    version: 1,
    runId,
    sandboxHomeDir: resolvedSandbox,
    expectedGeneration: meta.generation,
    targetGeneration: meta.generation + 1,
    authEpoch: meta.authEpoch,
    ...(meta.boundEmail ? { boundEmail: meta.boundEmail } : {}),
    ...(meta.boundUserScope ? { boundUserScope: meta.boundUserScope } : {}),
    hostPid: process.pid,
    startedAt: new Date().toISOString(),
  };
  atomicWriteFileSync(activeRunPath(resolvedProfile), JSON.stringify(activeRecord, null, 2), 0o600);
  return sandboxKeychainPath;
}

/**
 * Executes an isolated sandbox run under an end-to-end profile lock with:
 * 1. Pending recovery reconciliation
 * 2. Host Keychain provisioning & unlock
 * 3. Pre-spawn registration of the durable recovery workspace
 * 4. Post-run extraction, validation, staged recovery commit, and cleanup
 *    (even on cancellation/failure, without altering the caller's execution result).
 */
export async function runWithIsolatedAgyProfile<T>(
  profileDir: string,
  executeFn: (hooks: {
    prepareSandboxHome: (sandboxHomeDir: string) => Promise<void>;
  }) => Promise<T>,
  options?: PersistenceOptions,
): Promise<T> {
  const resolvedProfile = path.resolve(profileDir);
  const timeoutMs = options?.timeoutMs ?? 3_000;

  // Ensure Keychain is provisioned & unlocked before entering active run.
  await ensureIsolatedProfileKeychain(resolvedProfile, { timeoutMs });

  return withProfileKeychainLock(resolvedProfile, async () => {
    await reconcileLocked(resolvedProfile, options);
    const meta = readAgyProfileMeta(resolvedProfile);
    const runId = crypto.randomUUID();
    let capturedSandboxHome: string | null = null;
    let capturedSandboxKc: string | null = null;

    let result!: T;
    let execErr: unknown = null;
    try {
      result = await executeFn({
        prepareSandboxHome: async (sandboxHomeDir: string) => {
          capturedSandboxHome = path.resolve(sandboxHomeDir);
          capturedSandboxKc = await prepareSandboxHomeLocked(
            resolvedProfile,
            capturedSandboxHome,
            runId,
            meta,
            timeoutMs,
          );
        },
      });
    } catch (err) {
      execErr = err;
    }

    if (capturedSandboxHome) {
      const stopCheck = await (options?.confirmProcessesStopped ?? defaultConfirmProcessesStopped)(
        capturedSandboxHome,
        process.pid,
      );
      if (!stopCheck.stopped) {
        // Preserve active-run workspace & throw actionable error rather than discarding rotated tokens.
        throw new Error(
          `Sandbox descendants did not confirm termination (${stopCheck.reason}); recovery workspace preserved at ${capturedSandboxHome}.`,
        );
      }

      // Extract & commit any valid/rotated credentials even if execution failed or was cancelled.
      let extracted: Awaited<ReturnType<typeof extractAndValidateFromHome>> | null = null;
      let extractErr: unknown = null;
      try {
        extracted = await extractAndValidateFromHome(
          capturedSandboxHome,
          { boundEmail: meta.boundEmail, boundUserScope: meta.boundUserScope },
          timeoutMs,
        );
      } catch (err) {
        extractErr = err;
      }

      if (extracted) {
        await options?.onFault?.('before_stage');
        const bundle: AgyRecoveryBundle = {
          version: 1,
          runId,
          expectedGeneration: meta.generation,
          targetGeneration: meta.generation + 1,
          authEpoch: meta.authEpoch,
          boundEmail: meta.boundEmail ?? extracted.credential.idTokenEmail,
          boundUserScope: meta.boundUserScope ?? extracted.userScope,
          keychainPayloadB64: extracted.credential.rawPayloadB64,
          authFiles: extracted.authFiles,
          stagedAt: new Date().toISOString(),
        };
        atomicWriteFileSync(recoveryBundlePath(resolvedProfile), encryptSecret(JSON.stringify(bundle)), 0o600);
        await commitRecoveryBundleLocked(resolvedProfile, bundle, options);
      } else if (execErr === null && extractErr) {
        // Execution claimed success but credential extraction failed; preserve sandbox home for recovery.
        throw extractErr;
      }

      // Clean up sandbox home & active-run pointer only when extraction did not fail fatally.
      if (!extractErr) {
        if (capturedSandboxKc) {
          await runBoundedSecurity(['lock-keychain', capturedSandboxKc], capturedSandboxHome, 1_500).catch(() => {});
        }
        try {
          fs.rmSync(activeRunPath(resolvedProfile), { force: true });
        } catch {}
        try {
          fs.rmSync(capturedSandboxHome, { recursive: true, force: true });
        } catch {}
      }
    }

    if (execErr !== null) {
      throw execErr;
    }
    return result;
  });
}
