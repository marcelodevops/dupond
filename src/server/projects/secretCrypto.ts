import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { withApplicationConnectionKeyLease } from './connectionKeyLock.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONN_KEY_FILE = path.resolve(DATA_DIR, '.dupond_conn_key');

export function connectionKeyPath(): string {
  return process.env.DUPOND_CONN_KEY_PATH
    ? path.resolve(process.env.DUPOND_CONN_KEY_PATH)
    : CONN_KEY_FILE;
}

function readAndValidateKeyFile(file: string): Buffer {
  const raw = fs.readFileSync(file, 'utf-8').trim();
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(`Connection encryption key at ${file} is missing or malformed; refusing to overwrite.`);
  }
  return Buffer.from(raw, 'hex');
}

export function getConnectionKey(): Buffer {
  const file = connectionKeyPath();
  try {
    return readAndValidateKeyFile(file);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const key = crypto.randomBytes(32);
  const tmpFile = path.join(dir, `.dupond_conn_key.tmp-${process.pid}-${crypto.randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      tmpFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, key.toString('hex'), 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    try {
      fs.linkSync(tmpFile, file);
    } catch (linkErr: any) {
      if (linkErr?.code === 'EEXIST') {
        return readAndValidateKeyFile(file);
      }
      throw linkErr;
    }

    try {
      const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is best-effort on platforms that disallow O_RDONLY on dirs.
    }

    return key;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error on cleanup
      }
    }
    try {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    } catch {
      // Ignore temp cleanup error
    }
  }
}

export function encryptSecret(plaintext: string): string {
  const key = getConnectionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${enc.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith('v1:')) {
    // Pre-encryption rows (should not exist) are returned as-is.
    return stored;
  }
  const [, ivHex, dataHex, tagHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getConnectionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf-8');
}

export class KeyRotationInProgressError extends Error {
  readonly httpStatus = 503;
  readonly code = 'KEY_ROTATION_IN_PROGRESS';
  constructor(message = 'Connection key maintenance is in progress; retry after rotation completes.') {
    super(message);
    this.name = 'KeyRotationInProgressError';
  }
}

export function withSecretLease<T>(fn: () => T, onMaintenanceBlocked?: () => never): T {
  return withApplicationConnectionKeyLease(
    connectionKeyPath(),
    fn,
    onMaintenanceBlocked ?? (() => {
      throw new KeyRotationInProgressError();
    }),
  );
}
