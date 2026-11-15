# Connection Key Rotation & Recovery Guide

Dupond encrypts server-held Jira API tokens (`jira_connections.api_token_enc`) in SQLite using AES-256-GCM (`v1:<iv>:<ciphertext>:<tag>`) with the 32-byte hex key stored in `data/.dupond_conn_key` (or `DUPOND_CONN_KEY_PATH`).

> **Important:** Rotating `data/.dupond_conn_key` only re-encrypts the local database rows under a new local encryption key. It **does not** revoke upstream Jira, Slack, GitHub, or AI provider credentials, and it **does not** erase copies of keys or tokens from Git history. If an upstream token or historical key was exposed, revoke and regenerate those credentials at the upstream provider as well.

---

## 1. Maintenance Prerequisites

1. **Stop the Dupond server** before starting rotation.
   - *What is enforced automatically:* `scripts/rotateConnKey.ts` acquires an exclusive `.lock` file (`O_CREAT | O_EXCL`, mode `0o600`) to block concurrent rotation processes, and uses `BEGIN IMMEDIATE` in SQLite to block concurrent database writes during re-encryption.
   - *Remaining operational prerequisite:* Because the running server reads `data/.dupond_conn_key` per request without holding a filesystem lock across the DB-commit-to-key-rename window, a live server could observe new ciphertext alongside the old key (or vice versa) during that brief transition. Stop the server for the maintenance window.
2. **Verify permissions:** `data/.dupond_conn_key` must be owner-only (`0600`). Rotation refuses to run if group or world permission bits are set.
3. **Take a pre-maintenance backup** (recommended before any production maintenance):
   - Copy `data/dupond.db` (plus `-wal`/`-shm` if present) and `data/.dupond_conn_key` to a secure, `0600`-protected offline backup location.

---

## 2. Commands

```bash
# 1. Verify current active key & DB consistency (read-only)
npx tsx scripts/rotateConnKey.ts --verify

# 2. Rotate the connection key safely
npx tsx scripts/rotateConnKey.ts

# Optional: retain .dupond_conn_key.prev after verified rotation
npx tsx scripts/rotateConnKey.ts --keep-backup

# 3. Recover from an interrupted or failed rotation
npx tsx scripts/rotateConnKey.ts --recover
```

Custom paths are respected via `DUPOND_CONN_KEY_PATH` and `DUPOND_DB_PATH`.

---

## 3. Identifying an Incomplete Rotation (Without Exposing Secrets)

During rotation, temporary artifacts are created alongside the active key file with `0600` permissions:

- `data/.dupond_conn_key.lock` — PID and timestamp of the active rotation process.
- `data/.dupond_conn_key.prev` — Backup of the previous key.
- `data/.dupond_conn_key.next` — Staged new key.
- `data/.dupond_conn_key.state.json` — Journal containing `stage` (`staged` | `db_committed` | `key_replaced` | `verified`), `rowCount`, timestamps, and 16-char SHA-256 key fingerprints (`oldKeyFingerprint`, `newKeyFingerprint`). **No plaintext keys, tokens, or ciphertexts are stored in `.state.json`.**

To check for an incomplete rotation without printing secrets:

```bash
ls -la data/.dupond_conn_key*
cat data/.dupond_conn_key.state.json   # contains fingerprints and stage only
```

If any `.state.json`, `.prev`, `.next`, or `.lock` file is present, normal rotation refuses to start so recovery material is never overwritten or silently discarded.

---

## 4. Recovery & Safe Cleanup

Run:

```bash
npx tsx scripts/rotateConnKey.ts --recover
```

Recovery probes the database (read-only) against the previous and staged keys:
- **DB did not commit** (rows still decrypt with `.prev`): restores `.prev` atomically to `data/.dupond_conn_key` if needed, verifies all rows decrypt, and cleans up staging files.
- **DB already committed** (rows decrypt with `.next`): atomically replaces `data/.dupond_conn_key` with `.next`, verifies all rows decrypt, and cleans up staging files.
- **Ambiguous/corrupt state** (neither key decrypts all rows): aborts with a non-zero exit code and preserves all recovery files for manual inspection.

**When recovery material can safely be removed:** Only after `npx tsx scripts/rotateConnKey.ts --verify` (or `--recover`) exits `0` and confirms the active key decrypts every row in `jira_connections`. Never delete `.prev`, `.next`, or `.state.json` manually prior to verification.

---

## 5. Protected & Untracked Files

Ensure all key and recovery files remain owner-only (`chmod 600`) and ignored by Git:

```bash
git check-ignore -v data/.dupond_conn_key data/.dupond_conn_key.prev data/.dupond_conn_key.next data/.dupond_conn_key.state.json data/.dupond_conn_key.lock
```
