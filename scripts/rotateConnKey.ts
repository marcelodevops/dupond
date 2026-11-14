/**
 * Rotates the project connection key (data/.dupond_conn_key) that encrypts
 * server-held secrets in the SQLite store (currently jira_connections.api_token_enc).
 *
 * The key was committed to git history by accident (commits aec1ded / 78eb943),
 * so the on-disk key must be replaced and all encrypted rows re-encrypted with
 * the new key. Existing secrets are preserved by decrypting with the old key
 * first; rows that are not v1-encrypted (legacy plaintext) are encrypted now.
 *
 * Usage: npx tsx scripts/rotateConnKey.ts
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONN_KEY_FILE = process.env.DUPOND_CONN_KEY_PATH
  ? path.resolve(process.env.DUPOND_CONN_KEY_PATH)
  : path.join(DATA_DIR, '.dupond_conn_key');
const DB_PATH = process.env.DUPOND_DB_PATH
  ? path.resolve(process.env.DUPOND_DB_PATH)
  : path.join(DATA_DIR, 'dupond.db');

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${enc.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

function decrypt(stored: string, key: Buffer): string {
  if (!stored.startsWith('v1:')) return stored;
  const [, ivHex, dataHex, tagHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf-8');
}

function oldKey(): Buffer | null {
  if (!fs.existsSync(CONN_KEY_FILE)) return null;
  const raw = fs.readFileSync(CONN_KEY_FILE, 'utf-8').trim();
  return raw ? Buffer.from(raw, 'hex') : null;
}

const previous = oldKey();
if (previous) {
  console.log(`Rotating connection key from ${CONN_KEY_FILE} (old key leaked to git history).`);
} else {
  console.log(`No existing connection key at ${CONN_KEY_FILE}; generating a fresh key.`);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}; nothing to re-encrypt. Aborting without writing a new key.`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const tableExists = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jira_connections'",
).get() as { name: string } | undefined;

const rows = tableExists
  ? db.prepare('SELECT id, api_token_enc FROM jira_connections').all() as Array<{ id: string; api_token_enc: string }>
  : [];
console.log(`Found ${rows.length} encrypted connection rows to re-encrypt.`);

const plaintexts: Array<{ id: string; token: string }> = [];
for (const row of rows) {
  if (!previous) {
    console.error(`Cannot decrypt row ${row.id}: no old key available. Aborting without changes.`);
    process.exit(1);
  }
  try {
    plaintexts.push({ id: row.id, token: decrypt(row.api_token_enc, previous) });
  } catch {
    console.error(`Failed to decrypt row ${row.id} with the old key. Aborting without changes.`);
    process.exit(1);
  }
}

const nextKey = crypto.randomBytes(32);
fs.mkdirSync(path.dirname(CONN_KEY_FILE), { recursive: true });
fs.writeFileSync(CONN_KEY_FILE, nextKey.toString('hex'), { encoding: 'utf-8', mode: 0o600 });

const update = db.prepare('UPDATE jira_connections SET api_token_enc = ?, updated_at = ? WHERE id = ?');
const now = new Date().toISOString();
for (const { id, token } of plaintexts) {
  update.run(encrypt(token, nextKey), now, id);
}
console.log(`Re-encrypted ${plaintexts.length} row(s) with the new key.`);
console.log('Rotation complete. Ensure the new key file is untracked (git check-ignore data/.dupond_conn_key).');
