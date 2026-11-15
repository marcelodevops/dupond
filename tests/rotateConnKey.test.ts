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
import { ProjectApiError, ProjectStore } from '../src/server/projects/projectStore';
import { withApplicationConnectionKeyLease } from '../src/server/projects/connectionKeyLock';

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
  const insert = (taskStore as any).db.prepare(`
    INSERT INTO jira_connections (id, project_id, host_url, user_email, api_token_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of secrets) {
    const stored = s.legacyPlaintext ? s.token : encryptSynthetic(s.token, initialKey);
    insert.run(s.id, proj.id, 'https://example.atlassian.net', 'bot@example.test', stored, now, now);
  }
  (taskStore as any).db.close();

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
      (taskStore as any).db.close();
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

  it('L. prevents lost updates across second SQLite connection before/after snapshot acquisition and on insert/delete', () => {
    // 1. Update BEFORE snapshot acquisition -> latest committed value preserved under new key
    const dirBefore = makeTempDir('rot-l-before-');
    const fBefore = setupFixture(dirBefore, [{ id: 'conn-1', token: 'synth-old-val' }]);
    const newerToken = 'synth-newer-before-snapshot';
    const dbBefore = new DatabaseSync(fBefore.dbPath);
    dbBefore
      .prepare('UPDATE jira_connections SET api_token_enc = ?, updated_at = ? WHERE id = ?')
      .run(encryptSynthetic(newerToken, fBefore.initialKey), new Date().toISOString(), 'conn-1');
    dbBefore.close();

    rotateConnectionKey({ keyPath: fBefore.keyPath, dbPath: fBefore.dbPath, log: () => {} });
    const keyAfterBefore = Buffer.from(fs.readFileSync(fBefore.keyPath, 'utf-8').trim(), 'hex');
    assert.strictEqual(decryptSynthetic(readDbTokens(fBefore.dbPath)[0].api_token_enc, keyAfterBefore), newerToken);

    // 2. Update AFTER snapshot acquisition (at before_db_commit) -> rejected explicitly, newer value preserved
    const dirAfter = makeTempDir('rot-l-after-');
    const fAfter = setupFixture(dirAfter, [{ id: 'conn-1', token: 'synth-initial' }]);
    const concurrentToken = 'synth-concurrent-update';
    assert.throws(
      () =>
        rotateConnectionKey({
          keyPath: fAfter.keyPath,
          dbPath: fAfter.dbPath,
          log: () => {},
          onStage: (stage) => {
            if (stage === 'before_db_commit') {
              const db2 = new DatabaseSync(fAfter.dbPath);
              try {
                db2
                  .prepare('UPDATE jira_connections SET api_token_enc = ?, updated_at = ? WHERE id = ?')
                  .run(encryptSynthetic(concurrentToken, fAfter.initialKey), new Date(Date.now() + 1000).toISOString(), 'conn-1');
              } finally {
                db2.close();
              }
            }
          },
        }),
      /Concurrent modification detected/,
    );
    assert.strictEqual(fs.readFileSync(fAfter.keyPath, 'utf-8').trim(), fAfter.initialKey.toString('hex'));
    assert.strictEqual(decryptSynthetic(readDbTokens(fAfter.dbPath)[0].api_token_enc, fAfter.initialKey), concurrentToken);
    assert.strictEqual(
      rotateConnectionKey({ keyPath: fAfter.keyPath, dbPath: fAfter.dbPath, recover: true, log: () => {} }).status,
      'recovered_rollback',
    );
    assert.strictEqual(decryptSynthetic(readDbTokens(fAfter.dbPath)[0].api_token_enc, fAfter.initialKey), concurrentToken);

    // 3. Row inserted AFTER snapshot acquisition -> rejected explicitly, inserted row preserved
    const dirInsert = makeTempDir('rot-l-insert-');
    const fInsert = setupFixture(dirInsert, [{ id: 'conn-1', token: 'synth-row-1' }]);
    const insertedToken = 'synth-inserted-row-2';
    assert.throws(
      () =>
        rotateConnectionKey({
          keyPath: fInsert.keyPath,
          dbPath: fInsert.dbPath,
          log: () => {},
          onStage: (stage) => {
            if (stage === 'before_db_commit') {
              const db2 = new DatabaseSync(fInsert.dbPath);
              try {
                const now = new Date().toISOString();
                db2
                  .prepare(
                    'INSERT INTO jira_connections (id, project_id, host_url, user_email, api_token_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                  )
                  .run('conn-2', fInsert.projectId, 'https://example.atlassian.net', 'bot@example.test', encryptSynthetic(insertedToken, fInsert.initialKey), now, now);
              } finally {
                db2.close();
              }
            }
          },
        }),
      /Concurrent modification detected/,
    );
    const rowsAfterInsert = readDbTokens(fInsert.dbPath);
    assert.strictEqual(rowsAfterInsert.length, 2);
    assert.strictEqual(decryptSynthetic(rowsAfterInsert[1].api_token_enc, fInsert.initialKey), insertedToken);

    // 4. Row deleted AFTER snapshot acquisition -> rejected explicitly
    const dirDelete = makeTempDir('rot-l-delete-');
    const fDelete = setupFixture(dirDelete, [
      { id: 'conn-1', token: 'synth-del-1' },
      { id: 'conn-2', token: 'synth-del-2' },
    ]);
    assert.throws(
      () =>
        rotateConnectionKey({
          keyPath: fDelete.keyPath,
          dbPath: fDelete.dbPath,
          log: () => {},
          onStage: (stage) => {
            if (stage === 'before_db_commit') {
              const db2 = new DatabaseSync(fDelete.dbPath);
              try {
                db2.prepare("DELETE FROM jira_connections WHERE id = 'conn-2'").run();
              } finally {
                db2.close();
              }
            }
          },
        }),
      /Concurrent modification detected/,
    );
    assert.strictEqual(readDbTokens(fDelete.dbPath).length, 1);
  });

  it('M. enforces shared application maintenance exclusion and in-flight lease draining', () => {
    const dir = makeTempDir('rot-m-app-excl-');
    const sec1 = 'synth-app-excl-secret';
    const { keyPath, dbPath, projectId } = setupFixture(dir, [{ id: 'conn-1', token: sec1 }]);

    process.env.DUPOND_CONN_KEY_PATH = keyPath;
    const taskStore = new TaskStore(dbPath);
    try {
      const projectStore = new ProjectStore(taskStore);

      // 1. During active rotation, application reads and writes fail closed with 503 KEY_ROTATION_IN_PROGRESS
      let blockedRead = false;
      let blockedWrite = false;
      rotateConnectionKey({
        keyPath,
        dbPath,
        log: () => {},
        onStage: (stage) => {
          if (stage === 'after_stage') {
            assert.throws(
              () => projectStore.getJiraConnectionSecret('conn-1', projectId),
              (err: any) => err instanceof ProjectApiError && err.httpStatus === 503 && err.code === 'KEY_ROTATION_IN_PROGRESS',
            );
            blockedRead = true;
            assert.throws(
              () =>
                projectStore.saveJiraConnection(
                  projectId,
                  {
                    hostUrl: 'https://example.atlassian.net',
                    userEmail: 'bot@example.test',
                    apiToken: 'synth-blocked-write',
                    existingConnectionId: 'conn-1',
                  },
                  'test',
                ),
              (err: any) => err instanceof ProjectApiError && err.httpStatus === 503 && err.code === 'KEY_ROTATION_IN_PROGRESS',
            );
            blockedWrite = true;
          }
        },
      });
      assert.strictEqual(blockedRead, true);
      assert.strictEqual(blockedWrite, true);

      // 2. Active in-flight application lease blocks rotation if it does not drain within drainTimeoutMs
      withApplicationConnectionKeyLease(keyPath, () => {
        assert.throws(
          () => rotateConnectionKey({ keyPath, dbPath, drainTimeoutMs: 40, log: () => {} }),
          /Timed out waiting for 1 in-flight application/,
        );
      });

      // 3. Crashed rotation (SIGKILL) blocks application reads until --recover finishes
      const killed = runCliChild(keyPath, dbPath, [], { DUPOND_ROTATE_KILL_STAGE: 'after_db_commit' });
      assert.strictEqual(killed.signal, 'SIGKILL');
      assert.throws(
        () => projectStore.getJiraConnectionSecret('conn-1', projectId),
        (err: any) => err instanceof ProjectApiError && err.httpStatus === 503 && err.code === 'KEY_ROTATION_IN_PROGRESS',
      );
      const recovered = runCliChild(keyPath, dbPath, ['--recover']);
      assert.strictEqual(recovered.status, 0, recovered.stderr);
      const readBack = projectStore.getJiraConnectionSecret('conn-1', projectId);
      assert.ok(readBack);
      assert.strictEqual(readBack.apiToken, sec1);
    } finally {
      (taskStore as any).db.close();
    }
  });

  it('N. validates recovery identity (wrong DB, mismatched key, altered candidate, bad state, zero-row, plaintext, partial staging)', () => {
    // 1. Wrong database supplied to --recover
    const dir1 = makeTempDir('rot-n-wrongdb-');
    const f1 = setupFixture(dir1, [{ id: 'conn-1', token: 'synth-n1' }]);
    const wrongDbDir = makeTempDir('rot-n-wrongdb-other-');
    const wrongFix = setupFixture(wrongDbDir, [{ id: 'conn-1', token: 'synth-other' }]);
    const killed1 = runCliChild(f1.keyPath, f1.dbPath, [], { DUPOND_ROTATE_KILL_STAGE: 'after_db_commit' });
    assert.strictEqual(killed1.signal, 'SIGKILL');
    assert.throws(
      () => rotateConnectionKey({ keyPath: f1.keyPath, dbPath: wrongFix.dbPath, recover: true, log: () => {} }),
      /database path mismatch/,
    );
    assert.ok(fs.existsSync(`${f1.keyPath}.state.json`), 'Recovery files must be preserved on mismatch');

    // 2. Mismatched key path supplied to --recover
    const otherKeyPath = path.join(wrongDbDir, '.dupond_conn_key');
    fs.copyFileSync(`${f1.keyPath}.state.json`, `${otherKeyPath}.state.json`);
    assert.throws(
      () => rotateConnectionKey({ keyPath: otherKeyPath, dbPath: f1.dbPath, recover: true, log: () => {} }),
      /key path mismatch/,
    );
    assert.ok(fs.existsSync(`${otherKeyPath}.state.json`));

    // 3. Altered candidate key (.next tampered)
    const dir3 = makeTempDir('rot-n-altered-');
    const f3 = setupFixture(dir3, [{ id: 'conn-1', token: 'synth-n3' }]);
    const killed3 = runCliChild(f3.keyPath, f3.dbPath, [], { DUPOND_ROTATE_KILL_STAGE: 'after_db_commit' });
    assert.strictEqual(killed3.signal, 'SIGKILL');
    fs.writeFileSync(`${f3.keyPath}.next`, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    assert.throws(
      () => rotateConnectionKey({ keyPath: f3.keyPath, dbPath: f3.dbPath, recover: true, log: () => {} }),
      /fingerprint does not match/,
    );
    assert.ok(fs.existsSync(`${f3.keyPath}.state.json`));

    // 4. Truncated / invalid state file
    const dir4 = makeTempDir('rot-n-badstate-');
    const f4 = setupFixture(dir4, [{ id: 'conn-1', token: 'synth-n4' }]);
    fs.writeFileSync(`${f4.keyPath}.state.json`, '{"version":1,"stage":', { mode: 0o600 });
    assert.throws(
      () => rotateConnectionKey({ keyPath: f4.keyPath, dbPath: f4.dbPath, recover: true, log: () => {} }),
      /malformed or truncated JSON/,
    );
    assert.ok(fs.existsSync(`${f4.keyPath}.state.json`));

    // 5. Zero-row database recovery
    const dir5 = makeTempDir('rot-n-zero-');
    const f5 = setupFixture(dir5, []);
    const killed5 = runCliChild(f5.keyPath, f5.dbPath, [], { DUPOND_ROTATE_KILL_STAGE: 'after_db_commit' });
    assert.strictEqual(killed5.signal, 'SIGKILL');
    const rec5 = runCliChild(f5.keyPath, f5.dbPath, ['--recover']);
    assert.strictEqual(rec5.status, 0, rec5.stderr);

    // 6. Legacy plaintext-only database recovery (killed before DB commit)
    const dir6 = makeTempDir('rot-n-plain-');
    const f6 = setupFixture(dir6, [{ id: 'conn-1', token: 'synth-legacy-plain', legacyPlaintext: true }]);
    const killed6 = runCliChild(f6.keyPath, f6.dbPath, [], { DUPOND_ROTATE_KILL_STAGE: 'before_db_commit' });
    assert.strictEqual(killed6.signal, 'SIGKILL');
    const rec6 = runCliChild(f6.keyPath, f6.dbPath, ['--recover']);
    assert.strictEqual(rec6.status, 0, rec6.stderr);
    assert.strictEqual(readDbTokens(f6.dbPath)[0].api_token_enc, 'synth-legacy-plain');

    // 7. Partial staging before .state.json creation (SIGKILL at after_prev_stage)
    const dir7 = makeTempDir('rot-n-partial-');
    const f7 = setupFixture(dir7, [{ id: 'conn-1', token: 'synth-partial' }]);
    const killed7 = runCliChild(f7.keyPath, f7.dbPath, [], { DUPOND_ROTATE_KILL_STAGE: 'after_prev_stage' });
    assert.strictEqual(killed7.signal, 'SIGKILL');
    assert.strictEqual(fs.existsSync(`${f7.keyPath}.state.json`), false);
    assert.strictEqual(fs.existsSync(`${f7.keyPath}.prev`), true);
    const rec7 = runCliChild(f7.keyPath, f7.dbPath, ['--recover']);
    assert.strictEqual(rec7.status, 0, rec7.stderr);
    assert.strictEqual(decryptSynthetic(readDbTokens(f7.dbPath)[0].api_token_enc, f7.initialKey), 'synth-partial');
  });
});
