# Connection Key Rotation & Recovery Guide

Dupond encrypts server-held Jira API tokens (`jira_connections.api_token_enc`) in SQLite using AES-256-GCM (`v1:<iv>:<ciphertext>:<tag>`) with the 32-byte hex key stored in `data/.dupond_conn_key` (or `DUPOND_CONN_KEY_PATH`).

> **Important:** Rotating `data/.dupond_conn_key` only re-encrypts the local database rows under a new local encryption key. It **does not** revoke upstream Jira, Slack, GitHub, or AI provider credentials, and it **does not** erase copies of keys or tokens from Git history. If an upstream token or historical key was exposed, revoke and regenerate those credentials at the upstream provider as well.

---

## 1. Enforced Maintenance Exclusion & Prerequisites

1. **Shared application & rotation exclusion (enforced automatically across processes):**
   - **How maintenance begins and ends:** `scripts/rotateConnKey.ts` (both normal rotation and `--recover`) acquires `${CONN_KEY_FILE}.lock` via `O_CREAT | O_EXCL` (`0o600`), drains any active application leases in `${CONN_KEY_FILE}.leases/`, executes rotation/recovery, and removes `.lock` only after post-rotation verification succeeds (or on handled abort).
   - **How in-flight operations drain and new requests are excluded:** `ProjectStore.saveJiraConnection` and `ProjectStore.getJiraConnectionSecret` register an exclusive lease file in `${CONN_KEY_FILE}.leases/` *before* checking for `.lock` or `.state.json`. Once `.lock` is created, rotation waits up to `drainTimeoutMs` (default `2000ms`) for live-PID leases to finish (and reclaims dead-PID leases) before modifying the DB or key file. Any new or overlapping application secret read/write that observes `.lock` or `.state.json` fails closed with `503 KEY_ROTATION_IN_PROGRESS`.
   - **Exact DB snapshot validation:** Rotation re-checks `(id, api_token_enc, updated_at)` of every `jira_connections` row inside `BEGIN IMMEDIATE` and aborts with `ROLLBACK` if any external SQLite writer modified, inserted, or deleted a row after preflight snapshot acquisition.
   - **Crashed maintenance:** If rotation crashes (`SIGKILL`), `.lock` and/or `.state.json` remain on disk, keeping application secret operations blocked (`503 KEY_ROTATION_IN_PROGRESS`) until `npx tsx scripts/rotateConnKey.ts --recover` verifies/reconciles DB & key consistency and clears the maintenance artifacts.
   - **Operational recommendation:** Stopping the Dupond server before rotation is still recommended so callers do not see transient `503` errors during the maintenance window.
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

Recovery validates the `.state.json` schema (`version === 1`), verifies that the current `dbPath` and `keyPath` match the recorded paths, and verifies that candidate keys match the recorded `oldKeyFingerprint`/`newKeyFingerprint` before touching the active key. It then probes the database (read-only) against `.prev` and `.next`:
- **Partial early staging before `.next` and `.state.json` creation:** If interrupted when only `.prev` exists (no `.next`, no `.state.json`), automatic rollback is permitted **only** if the active key is intact, matches `.prev`, and decrypts every row in `jira_connections`.
- **Missing `.state.json` when `.next` exists:** `--recover` **refuses** to modify the active key or delete any recovery files (even if the supplied DB has zero encrypted rows or decrypts with a candidate key), because database identity and commit stage cannot be verified without `.state.json`. **Manual recovery procedure:** confirm which database was being rotated, check which candidate key (`.prev` vs `.next`) decrypts its `jira_connections` rows, and atomically restore that key (`0600`) to `data/.dupond_conn_key` before cleaning up `.prev`/`.next`/`.lock`.
- **DB did not commit** (with valid `.state.json`, rows decrypt with `.prev`): restores `.prev` atomically to `data/.dupond_conn_key` if needed, verifies all rows decrypt, and cleans up staging files.
- **DB already committed** (with valid `.state.json`, rows decrypt with `.next`): atomically replaces `data/.dupond_conn_key` with `.next`, verifies all rows decrypt, and cleans up staging files.
- **Ambiguous/corrupt/mismatched state** (path mismatch, fingerprint mismatch, malformed state file, or neither key decrypts all rows): aborts with a non-zero exit code and preserves all recovery files for manual inspection.

**When recovery material can safely be removed:** Only after `npx tsx scripts/rotateConnKey.ts --verify` (or `--recover`) exits `0` and confirms the active key decrypts every row in `jira_connections`. Never delete `.prev`, `.next`, or `.state.json` manually prior to verification.

---

## 5. Protected & Untracked Files

Ensure all key and recovery files remain owner-only (`chmod 600`) and ignored by Git:

```bash
git check-ignore -v data/.dupond_conn_key data/.dupond_conn_key.prev data/.dupond_conn_key.next data/.dupond_conn_key.state.json data/.dupond_conn_key.lock
```
