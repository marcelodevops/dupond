import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONN_KEY_FILE } from '../db/database.js';
import { withApplicationConnectionKeyLease } from './connectionKeyLock.js';

export function connectionKeyPath(): string {
  return process.env.DUPOND_CONN_KEY_PATH
    ? path.resolve(process.env.DUPOND_CONN_KEY_PATH)
    : CONN_KEY_FILE;
}

export function getConnectionKey(): Buffer {
  const file = connectionKeyPath();
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (raw) return Buffer.from(raw, 'hex');
  }
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Unwritable key storage: keep the key in memory only for this process.
  }
  return key;
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
