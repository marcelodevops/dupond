/**
 * Safely rotates the project connection key (data/.dupond_conn_key) that encrypts
 * server-held secrets in the SQLite store (jira_connections.api_token_enc).
 *
 * Protocol:
 *   1. Preflight & Lock: Acquire exclusive .lock (O_CREAT|O_EXCL, 0o600), verify no
 *      unrecovered state exists, validate DB/table, validate existing key & 0o600
 *      permissions, and decrypt/validate all rows in memory.
 *   2. Stage: Write .prev (old key), .next (new key), and .state.json (stage="staged")
 *      with 0o600 permissions and fsync. Neither DB nor active key is modified yet.
 *   3. DB Commit: Pre-encrypt & round-trip verify all rows, then update jira_connections
 *      inside BEGIN IMMEDIATE ... COMMIT. Update .state.json (stage="db_committed").
 *   4. Key Replace: Atomically replace active key file via temp+fsync+rename.
 *      Update .state.json (stage="key_replaced").
 *   5. Verify & Cleanup: Re-read active key and decrypt every DB row from disk.
 *      Only after verification passes, remove staging/recovery files (unless
 *      --keep-backup is passed, in which case .prev is preserved).
 *
 * Usage:
 *   npx tsx scripts/rotateConnKey.ts [--recover] [--verify] [--keep-backup]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  connectionKeyMaintenancePaths,
  drainApplicationLeases,
  isPidAlive,
} from '../src/server/projects/connectionKeyLock.js';

export type RotationStage = 'staged' | 'db_committed' | 'key_replaced' | 'verified';

export interface RotationState {
  version: 1;
  stage: RotationStage;
  dbPath: string;
  keyPath: string;
  oldKeyFingerprint: string;
  newKeyFingerprint: string;
  rowCount: number;
  startedAt: string;
  updatedAt: string;
}

export interface RotateOptions {
  keyPath?: string;
  dbPath?: string;
  recover?: boolean;
  verifyOnly?: boolean;
  keepBackup?: boolean;
  drainTimeoutMs?: number;
  /** Internal test hook for fault injection */
  onStage?: (stage: string) => void;
  /** Internal logger override */
  log?: (msg: string) => void;
}

export interface RotateResult {
  status: 'rotated' | 'recovered_forward' | 'recovered_rollback' | 'verified';
  rowCount: number;
  keyFingerprint: string;
}

interface LockPayload {
  pid: number;
  startedAt: string;
}

function keyFingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function parseHexKey(raw: string, label: string): Buffer {
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(`${label} is invalid: expected 64 hexadecimal characters (32 bytes).`);
  }
  return Buffer.from(trimmed, 'hex');
}

function readKeyFile(filePath: string, label: string, checkPerms = true): Buffer {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}.`);
  }
  if (checkPerms) {
    const stat = fs.statSync(filePath);
    if ((stat.mode & 0o077) !== 0) {
      const octal = (stat.mode & 0o777).toString(8).padStart(3, '0');
      throw new Error(
        `${label} at ${filePath} has overly broad permissions (${octal}). Run: chmod 600 ${filePath}`,
      );
    }
  }
  return parseHexKey(fs.readFileSync(filePath, 'utf-8'), label);
}

function writeSecretFileStrict(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWriteFileStrict(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  try {
    writeSecretFileStrict(tmpPath, content);
    fs.renameSync(tmpPath, targetPath);
    fsyncDirBestEffort(dir);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Preserve original error
    }
    throw err;
  }
}

function fsyncDirBestEffort(dirPath: string): void {
  try {
    const dirFd = fs.openSync(dirPath, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is not supported on all filesystems/platforms
  }
}

function encryptV1(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${enc.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

function decryptV1(stored: string, key: Buffer): { plaintext: string; wasEncrypted: boolean } {
  if (!stored.startsWith('v1:')) {
    return { plaintext: stored, wasEncrypted: false };
  }
  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new Error('Malformed v1 ciphertext envelope (expected 4 colon-separated parts).');
  }
  const [, ivHex, dataHex, tagHex] = parts;
  if (!/^[0-9a-fA-F]{24}$/.test(ivHex) || !/^[0-9a-fA-F]{32}$/.test(tagHex) || !/^[0-9a-fA-F]*$/.test(dataHex) || dataHex.length % 2 !== 0) {
    throw new Error('Malformed v1 ciphertext hex encoding or IV/tag length.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf-8');
  return { plaintext, wasEncrypted: true };
}

function acquireLock(lockPath: string, allowStaleReclaim: boolean): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(payload), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
    let existingPid: number | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<LockPayload>;
      if (typeof parsed.pid === 'number') existingPid = parsed.pid;
    } catch {
      // Unreadable lock
    }
    if (allowStaleReclaim && existingPid !== null && !isPidAlive(existingPid)) {
      fs.unlinkSync(lockPath);
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(payload), 'utf-8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return;
    }
    throw new Error(
      `Another key rotation lock exists at ${lockPath}${existingPid ? ` (PID ${existingPid})` : ''}. Wait for it to finish or run --recover if that process crashed.`,
    );
  }
}

function releaseLock(lockPath: string): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<LockPayload>;
    if (parsed.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Best-effort lock release; preserve any primary error
  }
}

function sameResolvedPath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p);
    try {
      return fs.realpathSync(resolved);
    } catch {
      const parent = path.dirname(resolved);
      try {
        return path.join(fs.realpathSync(parent), path.basename(resolved));
      } catch {
        return resolved;
      }
    }
  };
  return norm(a) === norm(b);
}

function parseAndValidateRotationState(
  raw: string,
  expectedDbPath: string,
  expectedKeyPath: string,
): RotationState {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Recovery state file is malformed or truncated JSON. Preserving recovery artifacts.');
  }
  const validStages = new Set(['staged', 'db_committed', 'key_replaced', 'verified']);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.version !== 1 ||
    !validStages.has(parsed.stage) ||
    typeof parsed.dbPath !== 'string' ||
    !parsed.dbPath ||
    typeof parsed.keyPath !== 'string' ||
    !parsed.keyPath ||
    typeof parsed.oldKeyFingerprint !== 'string' ||
    !/^[0-9a-f]{16}$/.test(parsed.oldKeyFingerprint) ||
    typeof parsed.newKeyFingerprint !== 'string' ||
    !/^[0-9a-f]{16}$/.test(parsed.newKeyFingerprint) ||
    typeof parsed.rowCount !== 'number' ||
    !Number.isInteger(parsed.rowCount) ||
    parsed.rowCount < 0 ||
    typeof parsed.startedAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.startedAt)) ||
    typeof parsed.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.updatedAt))
  ) {
    throw new Error('Recovery state file failed schema/version validation. Preserving recovery artifacts.');
  }
  if (!sameResolvedPath(parsed.dbPath, expectedDbPath)) {
    throw new Error(
      `Recovery state database path mismatch: state recorded ${parsed.dbPath}, current target is ${expectedDbPath}. Preserving recovery artifacts.`,
    );
  }
  if (!sameResolvedPath(parsed.keyPath, expectedKeyPath)) {
    throw new Error(
      `Recovery state key path mismatch: state recorded ${parsed.keyPath}, current target is ${expectedKeyPath}. Preserving recovery artifacts.`,
    );
  }
  return parsed as RotationState;
}

interface EncryptedSecretRow {
  table: 'jira_connections' | 'app_credentials';
  pkColumn: 'id' | 'provider';
  secretColumn: 'api_token_enc' | 'api_key_enc';
  pkValue: string;
  ciphertext: string;
  updatedAt: string;
}

function readSecretRows(db: DatabaseSync, hasAppCredentialsTable: boolean): EncryptedSecretRow[] {
  const jiraRows = db
    .prepare('SELECT id, api_token_enc, updated_at FROM jira_connections ORDER BY id ASC')
    .all() as Array<{ id: string; api_token_enc: string; updated_at: string }>;

  const rows: EncryptedSecretRow[] = jiraRows.map((r) => ({
    table: 'jira_connections',
    pkColumn: 'id',
    secretColumn: 'api_token_enc',
    pkValue: r.id,
    ciphertext: r.api_token_enc,
    updatedAt: r.updated_at,
  }));

  if (hasAppCredentialsTable) {
    const appRows = db
      .prepare('SELECT provider, api_key_enc, updated_at FROM app_credentials ORDER BY provider ASC')
      .all() as Array<{ provider: string; api_key_enc: string; updated_at: string }>;

    for (const r of appRows) {
      rows.push({
        table: 'app_credentials',
        pkColumn: 'provider',
        secretColumn: 'api_key_enc',
        pkValue: r.provider,
        ciphertext: r.api_key_enc,
        updatedAt: r.updated_at,
      });
    }
  }

  return rows;
}

function openConnectionsDb(dbPath: string): {
  db: DatabaseSync;
  rows: EncryptedSecretRow[];
  hasAppCredentialsTable: boolean;
} {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}; aborting without modifying key material.`);
  }
  const db = new DatabaseSync(dbPath);
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jira_connections'")
      .get() as { name: string } | undefined;
    if (!tableExists) {
      throw new Error(`Table jira_connections not found in ${dbPath}; aborting without modifying key material.`);
    }
    const appCredTableExists = Boolean(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_credentials'")
        .get(),
    );
    const rows = readSecretRows(db, appCredTableExists);
    return { db, rows, hasAppCredentialsTable: appCredTableExists };
  } catch (err) {
    try {
      db.close();
    } catch {
      // Preserve primary error
    }
    throw err;
  }
}

function canDecryptAll(
  rows: Array<{ ciphertext: string }>,
  key: Buffer,
  requireV1 = false,
): boolean {
  for (const row of rows) {
    if (requireV1 && !row.ciphertext.startsWith('v1:')) {
      return false;
    }
    try {
      decryptV1(row.ciphertext, key);
    } catch {
      return false;
    }
  }
  return true;
}

function emitFaultHook(stage: string, onStage?: (stage: string) => void): void {
  onStage?.(stage);
  const faultStage = process.env.DUPOND_ROTATE_FAULT_STAGE;
  if (faultStage === stage) {
    throw new Error(`Injected rotation fault at stage: ${stage}`);
  }
  const killStage = process.env.DUPOND_ROTATE_KILL_STAGE;
  if (killStage === stage) {
    process.kill(process.pid, 'SIGKILL');
  }
}

function cleanupRecoveryArtifacts(
  paths: { nextPath: string; prevPath: string; statePath: string },
  keepBackup: boolean,
): void {
  if (fs.existsSync(paths.nextPath)) fs.unlinkSync(paths.nextPath);
  if (fs.existsSync(paths.statePath)) fs.unlinkSync(paths.statePath);
  if (!keepBackup && fs.existsSync(paths.prevPath)) fs.unlinkSync(paths.prevPath);
}

let activeSignalCleanup: (() => void) | null = null;

export function rotateConnectionKey(options: RotateOptions = {}): RotateResult {
  const dataDir = path.resolve(process.cwd(), 'data');
  const keyPath = options.keyPath
    ? path.resolve(options.keyPath)
    : process.env.DUPOND_CONN_KEY_PATH
      ? path.resolve(process.env.DUPOND_CONN_KEY_PATH)
      : path.join(dataDir, '.dupond_conn_key');
  const dbPath = options.dbPath
    ? path.resolve(options.dbPath)
    : process.env.DUPOND_DB_PATH
      ? path.resolve(process.env.DUPOND_DB_PATH)
      : path.join(dataDir, 'dupond.db');

  const { lockPath, nextPath, prevPath, statePath } = connectionKeyMaintenancePaths(keyPath);
  const log = options.log ?? ((msg: string) => console.log(msg));

  if (options.verifyOnly) {
    const activeKey = readKeyFile(keyPath, 'Active connection key', true);
    const recoveryPresent = [nextPath, prevPath, statePath].filter((p) => fs.existsSync(p));
    if (recoveryPresent.length > 0) {
      throw new Error(
        `Incomplete rotation artifacts present (${recoveryPresent.map((p) => path.basename(p)).join(', ')}). Run with --recover first.`,
      );
    }
    const { db, rows } = openConnectionsDb(dbPath);
    try {
      if (!canDecryptAll(rows, activeKey, true)) {
        throw new Error('Verification failed: one or more jira_connections rows cannot be decrypted with the active key or are unencrypted.');
      }
      return { status: 'verified', rowCount: rows.length, keyFingerprint: keyFingerprint(activeKey) };
    } finally {
      db.close();
    }
  }

  acquireLock(lockPath, Boolean(options.recover));
  let db: DatabaseSync | null = null;
  activeSignalCleanup = () => {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore
      }
      db = null;
    }
    releaseLock(lockPath);
  };

  try {
    drainApplicationLeases(keyPath, options.drainTimeoutMs ?? 2000);
    const recoveryFiles = [statePath, nextPath, prevPath].filter((p) => fs.existsSync(p));

    if (options.recover) {
      const opened = openConnectionsDb(dbPath);
      db = opened.db;
      const { rows } = opened;

      let state: RotationState | null = null;
      if (fs.existsSync(statePath)) {
        state = parseAndValidateRotationState(fs.readFileSync(statePath, 'utf-8'), dbPath, keyPath);
      }

      const activeKey = fs.existsSync(keyPath) ? readKeyFile(keyPath, 'Active connection key', false) : null;
      const prevKey = fs.existsSync(prevPath) ? readKeyFile(prevPath, 'Previous backup key', false) : null;
      const nextKey = fs.existsSync(nextPath) ? readKeyFile(nextPath, 'Staged next key', false) : null;

      if (state) {
        if (prevKey && keyFingerprint(prevKey) !== state.oldKeyFingerprint) {
          throw new Error('Previous backup key fingerprint does not match recovery state. Preserving recovery artifacts.');
        }
        if (nextKey && keyFingerprint(nextKey) !== state.newKeyFingerprint) {
          throw new Error('Staged next key fingerprint does not match recovery state. Preserving recovery artifacts.');
        }
        if (
          activeKey &&
          keyFingerprint(activeKey) !== state.oldKeyFingerprint &&
          keyFingerprint(activeKey) !== state.newKeyFingerprint
        ) {
          throw new Error('Active key fingerprint matches neither old nor new recovery state key. Preserving recovery artifacts.');
        }
      }

      if (recoveryFiles.length === 0) {
        if (!activeKey) {
          throw new Error(`No recovery files and no active key at ${keyPath}.`);
        }
        if (!canDecryptAll(rows, activeKey, false)) {
          throw new Error('Active key cannot decrypt all rows and no recovery material exists.');
        }
        return { status: 'verified', rowCount: rows.length, keyFingerprint: keyFingerprint(activeKey) };
      }

      if (!state) {
        // Missing .state.json: cannot establish recorded dbPath, keyPath, or commit stage.
        // Only permit automatic rollback when ONLY .prev exists (partial early staging before .next
        // was written) AND activeKey is intact and identical to .prev AND all DB rows decrypt.
        if (nextKey || fs.existsSync(nextPath)) {
          throw new Error(
            'Ambiguous recovery state: .state.json is missing while .next exists, so database identity and commit stage cannot be verified. ' +
              'Refusing to modify the active key or delete recovery files. ' +
              'Manual recovery: verify which database was being rotated, check which candidate key (.prev vs .next) decrypts its jira_connections rows, and atomically restore that key to the active key path.',
          );
        }
        if (
          prevKey &&
          activeKey &&
          keyFingerprint(activeKey) === keyFingerprint(prevKey) &&
          canDecryptAll(rows, activeKey, false)
        ) {
          cleanupRecoveryArtifacts({ nextPath, prevPath, statePath }, Boolean(options.keepBackup));
          log(`Recovered rollback from partial early staging (${rows.length} row(s), fp=${keyFingerprint(activeKey)}).`);
          return { status: 'recovered_rollback', rowCount: rows.length, keyFingerprint: keyFingerprint(activeKey) };
        }
        throw new Error(
          'Ambiguous recovery state: .state.json is missing and partial-staging safety invariants are not met. ' +
            'Refusing to modify the active key or delete recovery files. ' +
            'Manual recovery: verify the target database and compare candidate keys before replacing the active key.',
        );
      }

      const encryptedRows = rows.filter((r) => r.ciphertext.startsWith('v1:'));

      // Determine whether DB rows are encrypted under newKey or oldKey
      const oldCandidate = prevKey || activeKey;
      const newCandidate = nextKey || (state && activeKey && keyFingerprint(activeKey) === state.newKeyFingerprint ? activeKey : null);

      const newDecryptsAll = newCandidate !== null && encryptedRows.length > 0 && canDecryptAll(encryptedRows, newCandidate, true);
      const oldDecryptsAll = oldCandidate !== null && encryptedRows.length > 0 && canDecryptAll(encryptedRows, oldCandidate, true);

      if (encryptedRows.length > 0 && newDecryptsAll && !oldDecryptsAll) {
        // Forward recovery: DB committed with newKey; ensure active key matches newKey
        if (!activeKey || keyFingerprint(activeKey) !== keyFingerprint(newCandidate!)) {
          atomicWriteFileStrict(keyPath, newCandidate!.toString('hex'));
        }
        const verifiedKey = readKeyFile(keyPath, 'Active connection key', true);
        if (!canDecryptAll(rows, verifiedKey, true)) {
          throw new Error('Post-recovery verification failed under new key; preserving recovery files.');
        }
        cleanupRecoveryArtifacts({ nextPath, prevPath, statePath }, Boolean(options.keepBackup));
        log(`Recovered forward: database and active key verified (${rows.length} row(s), fp=${keyFingerprint(verifiedKey)}).`);
        return { status: 'recovered_forward', rowCount: rows.length, keyFingerprint: keyFingerprint(verifiedKey) };
      }

      if (encryptedRows.length > 0 && oldDecryptsAll && !newDecryptsAll) {
        // Rollback recovery: DB still encrypted under oldKey; ensure active key matches oldKey
        if (!activeKey || keyFingerprint(activeKey) !== keyFingerprint(oldCandidate!)) {
          atomicWriteFileStrict(keyPath, oldCandidate!.toString('hex'));
        }
        const verifiedKey = readKeyFile(keyPath, 'Active connection key', true);
        if (!canDecryptAll(rows, verifiedKey, false)) {
          throw new Error('Post-rollback verification failed under previous key; preserving recovery files.');
        }
        cleanupRecoveryArtifacts({ nextPath, prevPath, statePath }, Boolean(options.keepBackup));
        log(`Recovered rollback: restored previous active key (${rows.length} row(s), fp=${keyFingerprint(verifiedKey)}).`);
        return { status: 'recovered_rollback', rowCount: rows.length, keyFingerprint: keyFingerprint(verifiedKey) };
      }

      if (encryptedRows.length === 0) {
        // Zero encrypted rows or legacy plaintext-only DB
        if (state && (state.stage === 'key_replaced' || state.stage === 'verified') && newCandidate) {
          if (!activeKey || keyFingerprint(activeKey) !== keyFingerprint(newCandidate)) {
            atomicWriteFileStrict(keyPath, newCandidate.toString('hex'));
          }
          const verifiedKey = readKeyFile(keyPath, 'Active connection key', true);
          cleanupRecoveryArtifacts({ nextPath, prevPath, statePath }, Boolean(options.keepBackup));
          return { status: 'recovered_forward', rowCount: rows.length, keyFingerprint: keyFingerprint(verifiedKey) };
        }
        if (oldCandidate) {
          if (!activeKey || keyFingerprint(activeKey) !== keyFingerprint(oldCandidate)) {
            atomicWriteFileStrict(keyPath, oldCandidate.toString('hex'));
          }
          const verifiedKey = readKeyFile(keyPath, 'Active connection key', true);
          cleanupRecoveryArtifacts({ nextPath, prevPath, statePath }, Boolean(options.keepBackup));
          return { status: 'recovered_rollback', rowCount: rows.length, keyFingerprint: keyFingerprint(verifiedKey) };
        }
      }

      throw new Error(
        'Ambiguous or undecryptable recovery state: neither candidate key decrypts all encrypted rows. Preserving recovery files without generating a new key.',
      );
    }

    // Normal rotation mode: refuse if any recovery files exist
    if (recoveryFiles.length > 0) {
      throw new Error(
        `Existing recovery artifacts detected (${recoveryFiles.map((p) => path.basename(p)).join(', ')}). Refusing to start a new rotation; run with --recover to inspect and resolve first.`,
      );
    }

    const oldKey = readKeyFile(keyPath, 'Existing connection key', true);
    const opened = openConnectionsDb(dbPath);
    db = opened.db;
    const { rows, hasAppCredentialsTable } = opened;

    log(`Found ${rows.length} encrypted secret row(s) to re-encrypt.`);

    // Decrypt and validate every row before any filesystem or DB mutation
    const plaintexts: Array<{ row: EncryptedSecretRow; secret: string }> = [];
    for (const row of rows) {
      try {
        const { plaintext } = decryptV1(row.ciphertext, oldKey);
        plaintexts.push({ row, secret: plaintext });
      } catch (err: any) {
        throw new Error(
          `Failed to decrypt row ${row.table}.${row.pkValue} with existing key (${err?.message || 'decrypt error'}). Aborting without changes.`,
        );
      }
    }

    const nextKey = crypto.randomBytes(32);
    const now = new Date().toISOString();

    // Pre-encrypt and round-trip verify under nextKey before touching DB or staging
    const reencrypted = plaintexts.map(({ row, secret }) => {
      const ciphertext = encryptV1(secret, nextKey);
      const check = decryptV1(ciphertext, nextKey);
      if (check.plaintext !== secret) {
        throw new Error(`Round-trip verification failed for ${row.table}.${row.pkValue} prior to staging.`);
      }
      return { row, ciphertext };
    });

    // Stage 1: Durable staging of .prev, .next, and .state.json (active key & DB untouched)
    emitFaultHook('before_stage', options.onStage);
    writeSecretFileStrict(prevPath, oldKey.toString('hex'));
    emitFaultHook('after_prev_stage', options.onStage);
    writeSecretFileStrict(nextPath, nextKey.toString('hex'));

    const state: RotationState = {
      version: 1,
      stage: 'staged',
      dbPath,
      keyPath,
      oldKeyFingerprint: keyFingerprint(oldKey),
      newKeyFingerprint: keyFingerprint(nextKey),
      rowCount: rows.length,
      startedAt: now,
      updatedAt: now,
    };
    atomicWriteFileStrict(statePath, JSON.stringify(state, null, 2));
    emitFaultHook('after_stage', options.onStage);

    // Stage 2: Transactional DB update (BEGIN IMMEDIATE ... COMMIT) with exact snapshot validation
    emitFaultHook('before_db_commit', options.onStage);
    db.exec('BEGIN IMMEDIATE');
    try {
      const currentRows = readSecretRows(db, hasAppCredentialsTable);
      if (currentRows.length !== rows.length) {
        throw new Error(`Concurrent modification detected: expected ${rows.length} row(s), found ${currentRows.length}.`);
      }
      for (let i = 0; i < rows.length; i += 1) {
        if (
          currentRows[i].table !== rows[i].table ||
          currentRows[i].pkValue !== rows[i].pkValue ||
          currentRows[i].ciphertext !== rows[i].ciphertext ||
          currentRows[i].updatedAt !== rows[i].updatedAt
        ) {
          throw new Error(
            `Concurrent modification detected on ${rows[i].table}.${rows[i].pkValue}: database state changed after snapshot acquisition.`,
          );
        }
      }
      const updateJira = db.prepare('UPDATE jira_connections SET api_token_enc = ?, updated_at = ? WHERE id = ?');
      const updateAppCred = hasAppCredentialsTable
        ? db.prepare('UPDATE app_credentials SET api_key_enc = ?, updated_at = ? WHERE provider = ?')
        : null;

      for (const item of reencrypted) {
        if (item.row.table === 'jira_connections') {
          updateJira.run(item.ciphertext, now, item.row.pkValue);
        } else if (updateAppCred) {
          updateAppCred.run(item.ciphertext, now, item.row.pkValue);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve original DB failure
      }
      throw err;
    }
    emitFaultHook('after_db_commit', options.onStage);

    state.stage = 'db_committed';
    state.updatedAt = new Date().toISOString();
    atomicWriteFileStrict(statePath, JSON.stringify(state, null, 2));

    // Stage 3: Atomic active key replacement
    emitFaultHook('before_key_replace', options.onStage);
    atomicWriteFileStrict(keyPath, nextKey.toString('hex'));
    emitFaultHook('after_key_replace', options.onStage);

    state.stage = 'key_replaced';
    state.updatedAt = new Date().toISOString();
    atomicWriteFileStrict(statePath, JSON.stringify(state, null, 2));

    // Stage 4: Post-rotation consistency verification
    const activeAfter = readKeyFile(keyPath, 'Rotated connection key', true);
    if (keyFingerprint(activeAfter) !== state.newKeyFingerprint) {
      throw new Error('Post-rotation verification failed: active key fingerprint mismatch.');
    }
    const verifyRows = readSecretRows(db, hasAppCredentialsTable);
    if (!canDecryptAll(verifyRows, activeAfter, true)) {
      throw new Error('Post-rotation verification failed: one or more rows failed decryption under the new key.');
    }

    state.stage = 'verified';
    state.updatedAt = new Date().toISOString();
    atomicWriteFileStrict(statePath, JSON.stringify(state, null, 2));

    cleanupRecoveryArtifacts({ nextPath, prevPath, statePath }, Boolean(options.keepBackup));
    log(`Rotated connection key safely (${verifyRows.length} row(s), fp=${state.newKeyFingerprint}).`);
    return { status: 'rotated', rowCount: verifyRows.length, keyFingerprint: state.newKeyFingerprint };
  } finally {
    activeSignalCleanup = null;
    if (db) {
      try {
        db.close();
      } catch {
        // Preserve primary error
      }
    }
    releaseLock(lockPath);
  }
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const args = new Set(process.argv.slice(2));
  const recover = args.has('--recover');
  const verifyOnly = args.has('--verify');
  const keepBackup = args.has('--keep-backup');

  const cleanupOnSignal = (signal: NodeJS.Signals) => {
    activeSignalCleanup?.();
    console.error(`Received ${signal}; aborting rotation.`);
    process.exit(130);
  };
  process.on('SIGINT', cleanupOnSignal);
  process.on('SIGTERM', cleanupOnSignal);

  try {
    rotateConnectionKey({ recover, verifyOnly, keepBackup });
  } catch (err: any) {
    console.error(`Connection key rotation failed: ${err?.message || String(err)}`);
    process.exit(1);
  }
}
