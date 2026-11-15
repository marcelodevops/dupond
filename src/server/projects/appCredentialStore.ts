import type { DatabaseSync } from 'node:sqlite';
import { taskStore, TaskStore } from '../db/database.js';
import { encryptSecret, decryptSecret, withSecretLease } from './secretCrypto.js';

export type GeminiTestOutcome = 'passed' | 'failed';

export interface GeminiCredentialMetadata {
  hasSavedKey: boolean;
  lastTestedAt: string | null;
  lastTestOutcome: GeminiTestOutcome | null;
  lastTestError: string | null;
  updatedAt: string | null;
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

    return withSecretLease(() => {
      const encrypted = encryptSecret(trimmed);
      this.db
        .prepare(
          `INSERT INTO app_credentials (
             provider, api_key_enc, last_tested_at, last_test_outcome, last_test_error, created_at, updated_at
           ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             api_key_enc = excluded.api_key_enc,
             last_tested_at = NULL,
             last_test_outcome = NULL,
             last_test_error = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(GEMINI_PROVIDER, encrypted, now, now);

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
    return withSecretLease(() => {
      const row = this.db
        .prepare('SELECT api_key_enc FROM app_credentials WHERE provider = ?')
        .get(GEMINI_PROVIDER) as { api_key_enc: string } | undefined;
      if (!row || !row.api_key_enc) return null;
      return decryptSecret(row.api_key_enc);
    });
  }

  getGeminiMetadata(): GeminiCredentialMetadata {
    const row = this.db
      .prepare(
        'SELECT last_tested_at, last_test_outcome, last_test_error, updated_at FROM app_credentials WHERE provider = ?',
      )
      .get(GEMINI_PROVIDER) as
      | {
          last_tested_at: string | null;
          last_test_outcome: string | null;
          last_test_error: string | null;
          updated_at: string | null;
        }
      | undefined;

    if (!row) {
      return {
        hasSavedKey: false,
        lastTestedAt: null,
        lastTestOutcome: null,
        lastTestError: null,
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
}

export const defaultAppCredentialStore = new AppCredentialStore();
