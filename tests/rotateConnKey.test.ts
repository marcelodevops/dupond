import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'vitest';
import { rotateConnectionKey } from '../scripts/rotateConnKey';
import { TaskStore } from '../src/server/db/database';
import { ProjectStore } from '../src/server/projects/projectStore';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.DUPOND_CONN_KEY_PATH;
  delete process.env.DUPOND_DB_PATH;
  delete process.env.DUPOND_ROTATE_FAULT_STAGE;
  delete process.env.DUPOND_ROTATE_KILL_STAGE;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function encryptSynthetic(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${enc.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

function decryptSynthetic(stored: string, key: Buffer): string {
  if (!stored.startsWith('v1:')) return stored;
  const [, ivHex, dataHex, tagHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf-8');
}

function setupFixture(dir: string, secrets: Array<{ id: string; token: string; legacyPlaintext?: boolean }>) {
  const keyPath = path.join(dir, '.dupond_conn_key');
  const dbPath = path.join(dir, 'dupond.db');
  const initialKey = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, initialKey.toString('hex'), { encoding: 'utf-8', mode: 0o600 });

  const taskStore = new TaskStore(dbPath);
  const projectStore = new ProjectStore(taskStore);
  const proj = projectStore.createProject({ name: 'Synthetic Project', actor: 'test' });

  const now = new Date().toISOString();
  const insert = taskStore.db.prepare(`
    INSERT INTO jira_connections (id, project_id, host_url, user_email, api_token_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of secrets) {
    const stored = s.legacyPlaintext ? s.token : encryptSynthetic(s.token, initialKey);
    insert.run(s.id, proj.id, 'https://example.atlassian.net', 'bot@example.test', stored, now, now);
  }
  taskStore.db.close();

  return { keyPath, dbPath, initialKey, projectId: proj.id };
}

function readDbTokens(dbPath: string): Array<{ id: string; api_token_enc: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT id, api_token_enc FROM jira_connections ORDER BY id ASC').all() as any[];
  } finally {
    db.close();
  }
}

function runCliChild(
  keyPath: string,
  dbPath: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', 'scripts/rotateConnKey.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DUPOND_CONN_KEY_PATH: keyPath,
      DUPOND_DB_PATH: dbPath,
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
}

describe('scripts/rotateConnKey.ts safe rotation & recovery', () => {
  it('A. rotates multiple encrypted rows, legacy plaintext rows, and zero-row DBs cleanly', () => {
    const dir = makeTempDir('rot-a-');
    const sec1 = 'synth-token-alpha-111';
    const sec2 = 'synth-legacy-plain-222';
    const { keyPath, dbPath, initialKey } = setupFixture(dir, [
      { id: 'conn-1', token: sec1 },
      { id: 'conn-2', token: sec2, legacyPlaintext: true },
    ]);

    const logs: string[] = [];
    const res = rotateConnectionKey({ keyPath, dbPath, log: (m) => logs.push(m) });
    assert.strictEqual(res.status, 'rotated');
    assert.strictEqual(res.rowCount, 2);

    const newKeyHex = fs.readFileSync(keyPath, 'utf-8').trim();
    assert.notStrictEqual(newKeyHex, initialKey.toString('hex'));
    assert.strictEqual(fs.statSync(keyPath).mode & 0o077, 0);

    const newKey = Buffer.from(newKeyHex, 'hex');
    const rows = readDbTokens(dbPath);
    assert.ok(rows[0].api_token_enc.startsWith('v1:'));
    assert.ok(rows[1].api_token_enc.startsWith('v1:'));
    assert.strictEqual(decryptSynthetic(rows[0].api_token_enc, newKey), sec1);
    assert.strictEqual(decryptSynthetic(rows[1].api_token_enc, newKey), sec2);

    // Zero secrets or key material in logs
    const joinedLogs = logs.join('\n');
    assert.strictEqual(joinedLogs.includes(sec1), false);
    assert.strictEqual(joinedLogs.includes(sec2), false);
    assert.strictEqual(joinedLogs.includes(newKeyHex), false);

    // Zero encrypted records also rotates cleanly
    const dirZero = makeTempDir('rot-zero-');
    const zeroFix = setupFixture(dirZero, []);
    const zeroRes = rotateConnectionKey({ keyPath: zeroFix.keyPath, dbPath: zeroFix.dbPath, log: () => {} });
    assert.strictEqual(zeroRes.status, 'rotated');
    assert.strictEqual(zeroRes.rowCount, 0);
  });

  it('B. database failure before any update leaves key untouched and recovers cleanly', () => {
    const dir = makeTempDir('rot-b-');
    const sec1 = 'synth-secret-b';
    const { keyPath, dbPath, initialKey } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TRIGGER reject_all_updates BEFORE UPDATE ON jira_connections
      BEGIN
        SELECT RAISE(ABORT, 'simulated db write failure');
      END;
    `);
    db.close();

    assert.throws(() => rotateConnectionKey({ keyPath, dbPath, log: () => {} }), /simulated db write failure/);

    // Active key must NOT have been overwritten
    assert.strictEqual(fs.readFileSync(keyPath, 'utf-8').trim(), initialKey.toString('hex'));
    const rows = readDbTokens(dbPath);
    assert.strictEqual(decryptSynthetic(rows[0].api_token_enc, initialKey), sec1);

    // Subsequent --recover rolls back staging files cleanly
    const rec = rotateConnectionKey({ keyPath, dbPath, recover: true, log: () => {} });
    assert.strictEqual(rec.status, 'recovered_rollback');
    assert.strictEqual(fs.existsSync(`${keyPath}.state.json`), false);
    assert.strictEqual(fs.existsSync(`${keyPath}.next`), false);
    assert.strictEqual(fs.existsSync(`${keyPath}.prev`), false);
  });

  it('C. failure after one of multiple updates rolls back entire DB transaction atomically', () => {
    const dir = makeTempDir('rot-c-');
    const sec1 = 'synth-secret-c1';
    const sec2 = 'synth-secret-c2';
    const { keyPath, dbPath, initialKey } = setupFixture(dir, [
      { id: 'conn-1', token: sec1 },
      { id: 'conn-2', token: sec2 },
    ]);

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TRIGGER reject_second_row BEFORE UPDATE ON jira_connections
      WHEN NEW.id = 'conn-2'
      BEGIN
        SELECT RAISE(ABORT, 'fail on second row');
      END;
    `);
    db.close();

    assert.throws(() => rotateConnectionKey({ keyPath, dbPath, log: () => {} }), /fail on second row/);

    // Neither row 1 nor row 2 changed, and active key is untouched
    assert.strictEqual(fs.readFileSync(keyPath, 'utf-8').trim(), initialKey.toString('hex'));
    const rows = readDbTokens(dbPath);
    assert.strictEqual(decryptSynthetic(rows[0].api_token_enc, initialKey), sec1);
    assert.strictEqual(decryptSynthetic(rows[1].api_token_enc, initialKey), sec2);

    const rec = rotateConnectionKey({ keyPath, dbPath, recover: true, log: () => {} });
    assert.strictEqual(rec.status, 'recovered_rollback');
  });

  it('D. new-key staging failure leaves DB and active key untouched and recovers cleanly', () => {
    const dir = makeTempDir('rot-d-');
    const sec1 = 'synth-secret-d';
    const { keyPath, dbPath, initialKey } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

    assert.throws(
      () =>
        rotateConnectionKey({
          keyPath,
          dbPath,
          log: () => {},
          onStage: (stage) => {
            if (stage === 'after_prev_stage') throw new Error('simulated staging disk error');
          },
        }),
      /simulated staging disk error/,
    );

    assert.strictEqual(fs.readFileSync(keyPath, 'utf-8').trim(), initialKey.toString('hex'));
    assert.strictEqual(decryptSynthetic(readDbTokens(dbPath)[0].api_token_enc, initialKey), sec1);

    const rec = rotateConnectionKey({ keyPath, dbPath, recover: true, log: () => {} });
    assert.strictEqual(rec.status, 'recovered_rollback');
  });

  it('E. active-key replacement failure preserves DB + staged key and recovers forward', () => {
    const dir = makeTempDir('rot-e-');
    const sec1 = 'synth-secret-e';
    const { keyPath, dbPath, initialKey } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

    assert.throws(
      () =>
        rotateConnectionKey({
          keyPath,
          dbPath,
          log: () => {},
          onStage: (stage) => {
            if (stage === 'before_key_replace') throw new Error('simulated key replace failure');
          },
        }),
      /simulated key replace failure/,
    );

    // Active key still holds initialKey while DB holds new ciphertext
    assert.strictEqual(fs.readFileSync(keyPath, 'utf-8').trim(), initialKey.toString('hex'));

    const rec = rotateConnectionKey({ keyPath, dbPath, recover: true, log: () => {} });
    assert.strictEqual(rec.status, 'recovered_forward');
    const rotatedKey = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'hex');
    assert.strictEqual(decryptSynthetic(readDbTokens(dbPath)[0].api_token_enc, rotatedKey), sec1);
  });

  it('F. child-process SIGKILL immediately before and after DB commit recovers consistently', () => {
    for (const killStage of ['before_db_commit', 'after_db_commit'] as const) {
      const dir = makeTempDir(`rot-f-${killStage}-`);
      const sec1 = `synth-secret-${killStage}`;
      const { keyPath, dbPath } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

      const killed = runCliChild(keyPath, dbPath, [], { DUPOND_ROTATE_KILL_STAGE: killStage });
      assert.strictEqual(killed.signal, 'SIGKILL');
      assert.ok(fs.existsSync(`${keyPath}.lock`), 'SIGKILL leaves stale lock file');

      // Normal rotation without --recover must refuse
      const refused = runCliChild(keyPath, dbPath);
      assert.notStrictEqual(refused.status, 0);

      // --recover reclaims stale lock and converges to consistent state
      const recovered = runCliChild(keyPath, dbPath, ['--recover']);
      assert.strictEqual(recovered.status, 0, recovered.stderr);

      const finalKey = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'hex');
      assert.strictEqual(decryptSynthetic(readDbTokens(dbPath)[0].api_token_enc, finalKey), sec1);
    }
  });

  it('G. child-process SIGKILL immediately before and after active-key replacement recovers forward', () => {
    for (const killStage of ['before_key_replace', 'after_key_replace'] as const) {
      const dir = makeTempDir(`rot-g-${killStage}-`);
      const sec1 = `synth-secret-${killStage}`;
      const { keyPath, dbPath } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

      const killed = runCliChild(keyPath, dbPath, [], { DUPOND_ROTATE_KILL_STAGE: killStage });
      assert.strictEqual(killed.signal, 'SIGKILL');

      const recovered = runCliChild(keyPath, dbPath, ['--recover']);
      assert.strictEqual(recovered.status, 0, recovered.stderr);

      const finalKey = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'hex');
      assert.strictEqual(decryptSynthetic(readDbTokens(dbPath)[0].api_token_enc, finalKey), sec1);
    }
  });

  it('H. recovery followed by application ProjectStore.getJiraConnectionSecret read succeeds', () => {
    const dir = makeTempDir('rot-h-');
    const sec1 = 'synth-app-read-secret';
    const { keyPath, dbPath, projectId } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

    const killed = runCliChild(keyPath, dbPath, [], { DUPOND_ROTATE_KILL_STAGE: 'after_db_commit' });
    assert.strictEqual(killed.signal, 'SIGKILL');

    const recovered = runCliChild(keyPath, dbPath, ['--recover']);
    assert.strictEqual(recovered.status, 0, recovered.stderr);

    process.env.DUPOND_CONN_KEY_PATH = keyPath;
    const taskStore = new TaskStore(dbPath);
    try {
      const projectStore = new ProjectStore(taskStore);
      const readBack = projectStore.getJiraConnectionSecret('conn-1', projectId);
      assert.ok(readBack);
      assert.strictEqual(readBack.apiToken, sec1);
    } finally {
      taskStore.db.close();
    }
  });

  it('I. repeated invocation works cleanly and concurrent invocation is rejected', () => {
    const dir = makeTempDir('rot-i-');
    const sec1 = 'synth-repeat-secret';
    const { keyPath, dbPath } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

    // Repeated sequential rotations succeed
    const r1 = rotateConnectionKey({ keyPath, dbPath, log: () => {} });
    const r2 = rotateConnectionKey({ keyPath, dbPath, log: () => {} });
    assert.strictEqual(r1.status, 'rotated');
    assert.strictEqual(r2.status, 'rotated');
    assert.notStrictEqual(r1.keyFingerprint, r2.keyFingerprint);

    // Concurrent invocation while lock is held by a live PID is rejected
    let concurrentThrew = false;
    rotateConnectionKey({
      keyPath,
      dbPath,
      log: () => {},
      onStage: (stage) => {
        if (stage === 'after_stage') {
          assert.throws(
            () => rotateConnectionKey({ keyPath, dbPath, log: () => {} }),
            /lock exists/,
          );
          concurrentThrew = true;
        }
      },
    });
    assert.strictEqual(concurrentThrew, true);
  });

  it('J. existing key file with overly broad permissions is refused without mutation', () => {
    const dir = makeTempDir('rot-j-');
    const sec1 = 'synth-perm-secret';
    const { keyPath, dbPath, initialKey } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

    fs.chmodSync(keyPath, 0o644);
    assert.throws(() => rotateConnectionKey({ keyPath, dbPath, log: () => {} }), /overly broad permissions/);
    assert.strictEqual(fs.readFileSync(keyPath, 'utf-8').trim(), initialKey.toString('hex'));
    assert.strictEqual(decryptSynthetic(readDbTokens(dbPath)[0].api_token_enc, initialKey), sec1);
  });

  it('K. invalid key or corrupt ciphertext causes no destructive mutation', () => {
    const dir1 = makeTempDir('rot-k-key-');
    const f1 = setupFixture(dir1, [{ id: 'conn-1', token: 'synth-k1' }]);
    fs.writeFileSync(f1.keyPath, 'not-valid-hex', { encoding: 'utf-8', mode: 0o600 });
    assert.throws(() => rotateConnectionKey({ keyPath: f1.keyPath, dbPath: f1.dbPath, log: () => {} }), /expected 64 hexadecimal/);
    assert.strictEqual(fs.readFileSync(f1.keyPath, 'utf-8'), 'not-valid-hex');

    const dir2 = makeTempDir('rot-k-cipher-');
    const f2 = setupFixture(dir2, [{ id: 'conn-1', token: 'synth-k2' }]);
    const db = new DatabaseSync(f2.dbPath);
    db.prepare("UPDATE jira_connections SET api_token_enc = 'v1:00112233445566778899aabb:deadbeef:00000000000000000000000000000000' WHERE id = 'conn-1'").run();
    db.close();
    assert.throws(() => rotateConnectionKey({ keyPath: f2.keyPath, dbPath: f2.dbPath, log: () => {} }), /Failed to decrypt row/);
    assert.strictEqual(fs.readFileSync(f2.keyPath, 'utf-8').trim(), f2.initialKey.toString('hex'));
  });
});
