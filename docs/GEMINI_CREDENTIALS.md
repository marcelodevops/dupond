# Gemini Credential Onboarding & Security Model

## 1. Credential Precedence

Dupond resolves the active Gemini API key through a single unified resolver (`src/server/gemini.ts`) used by planning readiness, plan decomposition, worker adapters, connection tests, and `/api/health`:

1. **Server `GEMINI_API_KEY` environment variable** (when non-empty).
2. **Application-saved encrypted Gemini key** in SQLite (`app_credentials` table).
3. **Explicitly unavailable** (no fallback to stale or older keys after auth failures).

## 2. Scope & Authorization Model

- **Application-scoped**: Saved Gemini credentials apply to all projects using the same Dupond server instance.
- **Single-tenant / server-auth boundary**: `GET /api/credentials/gemini`, `PUT /api/credentials/gemini`, `DELETE /api/credentials/gemini`, and `POST /api/credentials/gemini/test` are mounted under Express's `requireAuth` middleware (`src/server/auth.ts`). Any caller authenticated to the server can inspect metadata or manage the application Gemini key.
- **Environment immutability**: The browser UI can never read, modify, or unset `process.env.GEMINI_API_KEY`. When `GEMINI_API_KEY` is set on the server, the UI explicitly indicates that the environment controls the active credential.

## 3. Encrypted Storage & Key Rotation

- Saved keys are encrypted at rest with **AES-256-GCM** using the connection key file (`DUPOND_CONN_KEY_PATH` or `data/.dupond_conn_key`).
- Reads and writes acquire `withApplicationConnectionKeyLease` (`src/server/projects/secretCrypto.ts`) and return `503 KEY_ROTATION_IN_PROGRESS` while `scripts/rotateConnKey.ts` is rotating or recovering keys.
- `scripts/rotateConnKey.ts` (normal rotation, `--verify`, and `--recover`) re-encrypts and validates `app_credentials` atomically alongside `jira_connections` in the same `BEGIN IMMEDIATE ... COMMIT` SQLite transaction.

## 4. Controlled vs. Live Verification

- **Automated CI / Browser Tests (`tests/e2e/geminiOnboarding.test.ts`)**: Runs the real Vite-built frontend and Express backend against isolated temporary storage (`DUPOND_DB_PATH`, `DUPOND_STATE_FILE`, `DUPOND_CONN_KEY_PATH`) and a local mock Gemini HTTP server gated strictly by `DUPOND_ALLOW_TEST_GEMINI_ENDPOINT=1` + `DUPOND_GEMINI_TEST_BASE_URL` (never exposed to HTTP or UI).
- **Opt-In Live Smoke Test (`scripts/smokeGemini.ts`)**: Disabled in CI. Operators with an authorized key can run:
  ```bash
  DUPOND_ALLOW_LIVE_GEMINI_SMOKE=1 GEMINI_API_KEY="AIza..." npx tsx scripts/smokeGemini.ts
  ```
