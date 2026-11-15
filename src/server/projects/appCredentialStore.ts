import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { taskStore, TaskStore } from '../db/database.js';
import { encryptSecret, decryptSecret, withSecretLease } from './secretCrypto.js';

export type GeminiTestOutcome = 'passed' | 'failed';

export interface GeminiCredentialMetadata {
  hasSavedKey: boolean;
  lastTestedAt: string | null;
  lastTestOutcome: GeminiTestOutcome | null;
  lastTestError: string | null;
  lastTestModel: string | null;
  credentialVersion: string | null;
  updatedAt: string | null;
}

export interface StoredGeminiKeySnapshot {
  apiKey: string;
  credentialVersion: string;
  keyFingerprint: string;
}

export class AppCredentialValidationError extends Error {
  readonly httpStatus = 400;
  readonly code = 'INVALID_REQUEST';
  constructor(message: string) {
    super(message);
    this.name = 'AppCredentialValidationError';
  }
}

const GEMINI_PROVIDER = 'gemini';

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export class AppCredentialStore {
  private db: DatabaseSync;

  constructor(store: TaskStore = taskStore, db?: DatabaseSync) {
    this.db = db || store.getRawDb();
  }

  saveGeminiKey(rawKey: string): GeminiCredentialMetadata {
    if (typeof rawKey !== 'string' || !rawKey.trim()) {
      throw new AppCredentialValidationError('Gemini API key must be a non-empty string.');
    }
    const trimmed = rawKey.trim();
    const now = new Date().toISOString();
    const credentialVersion = crypto.randomUUID();
    const keyFingerprint = sha256Hex(trimmed);

    return withSecretLease(() => {
      const encrypted = encryptSecret(trimmed);
      this.db
        .prepare(
          `INSERT INTO app_credentials (
             provider, api_key_enc, credential_version, key_fingerprint,
             last_tested_at, last_test_outcome, last_test_error, last_test_model, last_test_seq,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             api_key_enc = excluded.api_key_enc,
             credential_version = excluded.credential_version,
             key_fingerprint = excluded.key_fingerprint,
             last_tested_at = NULL,
             last_test_outcome = NULL,
             last_test_error = NULL,
             last_test_model = NULL,
             last_test_seq = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(GEMINI_PROVIDER, encrypted, credentialVersion, keyFingerprint, now, now);

      return this.getGeminiMetadata();
    });
  }

  deleteGeminiKey(): GeminiCredentialMetadata {
    return withSecretLease(() => {
      this.db.prepare('DELETE FROM app_credentials WHERE provider = ?').run(GEMINI_PROVIDER);
      return this.getGeminiMetadata();
    });
  }

  getGeminiKey(): string | null {
    return this.getGeminiKeySnapshot()?.apiKey ?? null;
  }

  getGeminiKeySnapshot(): StoredGeminiKeySnapshot | null {
    return withSecretLease(() => {
      const row = this.db
        .prepare('SELECT api_key_enc, credential_version, key_fingerprint, updated_at FROM app_credentials WHERE provider = ?')
        .get(GEMINI_PROVIDER) as
        | {
            api_key_enc: string;
            credential_version: string | null;
            key_fingerprint: string | null;
            updated_at: string;
          }
        | undefined;
      if (!row || !row.api_key_enc) return null;
      const apiKey = decryptSecret(row.api_key_enc);
      return {
        apiKey,
        credentialVersion: row.credential_version || row.updated_at,
        keyFingerprint: row.key_fingerprint || sha256Hex(apiKey),
      };
    });
  }

  getGeminiMetadata(): GeminiCredentialMetadata {
    const row = this.db
      .prepare(
        `SELECT credential_version, last_tested_at, last_test_outcome, last_test_error, last_test_model, updated_at
         FROM app_credentials WHERE provider = ?`,
      )
      .get(GEMINI_PROVIDER) as
      | {
          credential_version: string | null;
          last_tested_at: string | null;
          last_test_outcome: string | null;
          last_test_error: string | null;
          last_test_model: string | null;
          updated_at: string | null;
        }
      | undefined;

    if (!row) {
      return {
        hasSavedKey: false,
        lastTestedAt: null,
        lastTestOutcome: null,
        lastTestError: null,
        lastTestModel: null,
        credentialVersion: null,
        updatedAt: null,
      };
    }

    const outcome =
      row.last_test_outcome === 'passed' || row.last_test_outcome === 'failed'
        ? row.last_test_outcome
        : null;

    return {
      hasSavedKey: true,
      lastTestedAt: row.last_tested_at ?? null,
      lastTestOutcome: outcome,
      lastTestError: row.last_test_error ?? null,
      lastTestModel: row.last_test_model ?? null,
      credentialVersion: row.credential_version ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  recordGeminiTestResult(outcome: GeminiTestOutcome, error?: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE app_credentials
         SET last_tested_at = ?, last_test_outcome = ?, last_test_error = ?, updated_at = ?
         WHERE provider = ?`,
      )
      .run(now, outcome, error ?? null, now, GEMINI_PROVIDER);
  }

  recordGeminiTestResultIfCurrent(params: {
    expectedVersion: string;
    expectedFingerprint: string;
    expectedModel: string;
    testSeq: number;
    outcome: GeminiTestOutcome;
    error?: string | null;
    testedAt?: string;
  }): boolean {
    const now = params.testedAt || new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE app_credentials
         SET last_tested_at = ?,
             last_test_outcome = ?,
             last_test_error = ?,
             last_test_model = ?,
             last_test_seq = ?,
             updated_at = ?
         WHERE provider = ?
           AND (credential_version = ? OR (credential_version IS NULL AND updated_at = ?))
           AND (key_fingerprint IS NULL OR key_fingerprint = ?)`,
      )
      .run(
        now,
        params.outcome,
        params.error ?? null,
        params.expectedModel,
        params.testSeq,
        now,
        GEMINI_PROVIDER,
        params.expectedVersion,
        params.expectedVersion,
        params.expectedFingerprint,
      );
    return Number(result.changes) > 0;
  }
}

export const defaultAppCredentialStore = new AppCredentialStore();
