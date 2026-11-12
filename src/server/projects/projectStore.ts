import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, taskStore } from '../db/database.js';
import {
  Project,
  ProjectPreferences,
  ProjectRepositoryConfig,
  ProjectResetScope,
  ProjectResetResult,
  DEFAULT_PROJECT_ID,
} from '../../types/projectContract.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONN_KEY_FILE = path.resolve(DATA_DIR, '.dupond_conn_key');

export class ProjectApiError extends Error {
  code: string;
  httpStatus: number;
  details?: unknown;
  constructor(httpStatus: number, code: string, message: string, details?: unknown) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
    this.details = details;
  }
}

function connectionKeyPath(): string {
  return process.env.DUPOND_CONN_KEY_PATH
    ? path.resolve(process.env.DUPOND_CONN_KEY_PATH)
    : CONN_KEY_FILE;
}

function getConnectionKey(): Buffer {
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

function encryptSecret(plaintext: string): string {
  const key = getConnectionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${enc.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

function decryptSecret(stored: string): string {
  if (!stored.startsWith('v1:')) {
    // Pre-encryption rows (should not exist) are returned as-is.
    return stored;
  }
  const [, ivHex, dataHex, tagHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getConnectionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf-8');
}

export interface ActiveRunBlockers {
  runningRunIds: string[];
  claimedTaskIds: string[];
}

export class ProjectStore {
  private db: DatabaseSync;
  private store: TaskStore;

  constructor(store: TaskStore = taskStore, db?: DatabaseSync) {
    this.store = store;
    this.db = db || store.getRawDb();
  }

  private txn<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }

  // --- Project CRUD ---

  public listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    const where = opts.includeArchived ? '' : "WHERE status = 'active'";
    const rows = this.db.prepare(`SELECT * FROM projects ${where} ORDER BY created_at ASC`).all() as any[];
    return rows.map((row) => this.toView(row));
  }

  public getProject(projectId: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    return row ? this.toView(row) : null;
  }

  public getProjectState<T>(projectId: string, fallback: T): T {
    const row = this.db.prepare('SELECT state_json FROM projects WHERE id = ?').get(projectId) as any;
    if (!row) throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`);
    try {
      const parsed = JSON.parse(row.state_json || '{}');
      return Object.keys(parsed).length > 0 ? parsed as T : fallback;
    } catch {
      return fallback;
    }
  }

  public saveProjectState(projectId: string, state: unknown): void {
    const project = this.getProject(projectId);
    if (!project) throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`);
    this.db.prepare('UPDATE projects SET state_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), new Date().toISOString(), projectId);
  }

  public createProject(input: {
    id?: string;
    name: string;
    description?: string;
    repository?: ProjectRepositoryConfig;
    preferences?: ProjectPreferences;
    actor: string;
  }): Project {
    const name = (input.name || '').trim();
    if (!name || name.length > 120) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'Project name is required and must be at most 120 characters.');
    }
    const clash = this.db
      .prepare("SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND status = 'active'")
      .get(name) as any;
    if (clash) {
      throw new ProjectApiError(409, 'PROJECT_NAME_CONFLICT', `An active project named "${name}" already exists (${clash.id}).`);
    }
    const id = input.id?.trim() || `proj-${crypto.randomUUID()}`;
    if (!/^[a-z0-9][a-z0-9-_-]{1,119}$/i.test(id)) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'Project id must contain only letters, numbers, underscores, and hyphens.');
    }
    if (this.getProject(id)) {
      throw new ProjectApiError(409, 'PROJECT_NAME_CONFLICT', `Project id "${id}" already exists.`);
    }
    const now = new Date().toISOString();
    return this.txn(() => {
      this.db
        .prepare(
          `INSERT INTO projects (
            id, name, description, status, repository_config,
            jira_provisioning_state, preferences, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, 'unconfigured', ?, ?, ?)`,
        )
        .run(
          id,
          name,
          (input.description || '').trim(),
          JSON.stringify(input.repository || {}),
          JSON.stringify(input.preferences || {}),
          now,
          now,
        );
      this.store.recordAudit({
        projectId: id,
        eventType: 'PROJECT_CREATED',
        actor: input.actor,
        details: { name },
      });
      return this.getProject(id)!;
    });
  }

  public updateProject(
    projectId: string,
    patch: {
      name?: string;
      description?: string;
      repository?: ProjectRepositoryConfig;
      jira?: { connectionId?: string | null; projectKey?: string | null; epicKey?: string | null };
      preferences?: ProjectPreferences;
    },
    actor: string,
  ): Project {
    return this.txn(() => {
      const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
      if (!row) throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`);
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (!name || name.length > 120) {
          throw new ProjectApiError(400, 'INVALID_REQUEST', 'Project name must be 1..120 characters.');
        }
        const clash = this.db
          .prepare("SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND status = 'active' AND id != ?")
          .get(name, projectId) as any;
        if (clash) {
          throw new ProjectApiError(409, 'PROJECT_NAME_CONFLICT', `An active project named "${name}" already exists (${clash.id}).`);
        }
        row.name = name;
      }
      if (patch.description !== undefined) row.description = patch.description.trim();
      if (patch.repository !== undefined) row.repository_config = JSON.stringify(patch.repository);
      if (patch.preferences !== undefined) row.preferences = JSON.stringify(patch.preferences);
      if (patch.jira) {
        if (patch.jira.connectionId !== undefined) {
          if (patch.jira.connectionId !== null) {
            const conn = this.db
              .prepare('SELECT id FROM jira_connections WHERE id = ? AND project_id = ?')
              .get(patch.jira.connectionId, projectId) as any;
            if (!conn) {
              throw new ProjectApiError(400, 'CONNECTION_NOT_FOUND', `Connection ${patch.jira.connectionId} is not a connection of project ${projectId}.`);
            }
          }
          row.jira_connection_id = patch.jira.connectionId;
        }
        if (patch.jira.projectKey !== undefined) row.jira_project_key = patch.jira.projectKey;
        if (patch.jira.epicKey !== undefined) row.jira_epic_key = patch.jira.epicKey;
        row.jira_provisioning_state = row.jira_project_key ? (row.jira_connection_id ? 'linked' : row.jira_provisioning_state) : 'unconfigured';
      }
      row.updated_at = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE projects SET name = ?, description = ?, repository_config = ?, preferences = ?,
             jira_connection_id = ?, jira_project_key = ?, jira_epic_key = ?, jira_provisioning_state = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          row.name,
          row.description,
          row.repository_config,
          row.preferences,
          row.jira_connection_id,
          row.jira_project_key,
          row.jira_epic_key,
          row.jira_provisioning_state,
          row.updated_at,
          projectId,
        );
      this.store.recordAudit({
        projectId,
        eventType: 'PROJECT_UPDATED',
        actor,
        details: { fields: Object.keys(patch).filter((k) => k !== 'actor') },
      });
      return this.toView(row);
    });
  }

  // --- Archive ---

  public archiveProject(projectId: string, actor: string): Project {
    const blockers = this.getActiveRunBlockers(projectId);
    if (blockers.runningRunIds.length > 0 || blockers.claimedTaskIds.length > 0) {
      throw new ProjectApiError(
        409,
        'ACTIVE_RUNS_PRESENT',
        'Archive refused: active runs or claimed tasks are still executing for this project. Cancel them first.',
        blockers,
      );
    }
    return this.txn(() => {
      const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
      if (!row) throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`);
      if (row.status === 'archived') return this.toView(row);
      const now = new Date().toISOString();
      this.db.prepare("UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, projectId);
      this.store.recordAudit({
        projectId,
        eventType: 'PROJECT_ARCHIVED',
        actor,
        details: { archivedAt: now, historyPreserved: true },
      });
      return this.toView({ ...row, status: 'archived', archived_at: now, updated_at: now });
    });
  }

  /** Execution gate: fail closed when the project is missing or archived. */
  public assertProjectExecutable(projectId: string): Project {
    const project = this.getProject(projectId);
    if (!project) {
      throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`);
    }
    if (project.status === 'archived') {
      throw new ProjectApiError(403, 'PROJECT_ARCHIVED', `Project ${projectId} is archived; no new execution or delivery is allowed. History remains readable.`);
    }
    return project;
  }

  public getActiveRunBlockers(projectId: string): ActiveRunBlockers {
    const runs = this.db
      .prepare("SELECT id FROM task_runs WHERE project_id = ? AND status IN ('pending', 'running')")
      .all(projectId) as any[];
    const tasks = this.db
      .prepare("SELECT id FROM tasks WHERE project_id = ? AND status = 'in_progress' AND claimed_by IS NOT NULL")
      .all(projectId) as any[];
    return {
      runningRunIds: runs.map((r) => r.id),
      claimedTaskIds: tasks.map((t) => t.id),
    };
  }

  // --- Narrow reset ---

  public resetProject(projectId: string, scopes: ProjectResetScope[], actor: string): ProjectResetResult {
    const valid: ProjectResetScope[] = ['tasks', 'cycles', 'runs', 'evidence', 'deliveries', 'worktrees', 'artifacts'];
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'reset requires at least one scope.');
    }
    const unknown = scopes.filter((s) => !valid.includes(s));
    if (unknown.length > 0) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', `Unknown reset scope(s): ${unknown.join(', ')}`);
    }

    const blockers = this.getActiveRunBlockers(projectId);
    if (blockers.runningRunIds.length > 0 || blockers.claimedTaskIds.length > 0) {
      throw new ProjectApiError(
        409,
        'ACTIVE_RUNS_PRESENT',
        'Reset refused: the project has runs in flight. Cancel or wait for them; resetting mid-run would destroy live execution evidence.',
        blockers,
      );
    }

    const cleared: Record<ProjectResetScope, number> = {
      tasks: 0,
      cycles: 0,
      runs: 0,
      evidence: 0,
      deliveries: 0,
      worktrees: 0,
      artifacts: 0,
    };
    const skipped: Array<{ scope: ProjectResetScope; reason: string }> = [];

    const result = this.txn(() => {
      const runRows = this.db
        .prepare('SELECT id, target_branch, worktree_path FROM task_runs WHERE project_id = ?')
        .all(projectId) as any[];
      const runIds = runRows.map((r) => r.id);
      const taskRows = this.db.prepare('SELECT id, key FROM tasks WHERE project_id = ?').all(projectId) as any[];

      if (scopes.includes('cycles')) {
        const stateRow = this.db.prepare('SELECT state_json FROM projects WHERE id = ?').get(projectId) as any;
        try {
          const state = JSON.parse(stateRow?.state_json || '{}');
          cleared.cycles = Number.isFinite(state.cycleCount) ? Number(state.cycleCount) : 0;
          state.cycleCount = 0;
          this.db.prepare('UPDATE projects SET state_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(state), new Date().toISOString(), projectId);
        } catch {
          cleared.cycles = 0;
        }
      }

      if (scopes.includes('deliveries')) {
        cleared.deliveries = this.deleteWhereIn('delivery_records', 'run_id', runIds);
      }
      if (scopes.includes('evidence')) {
        cleared.evidence = this.deleteWhereIn('verification_records', 'run_id', runIds);
      }
      if (scopes.includes('runs')) {
        // Child rows must be deleted before attempts/runs to satisfy foreign keys.
        if (!scopes.includes('deliveries')) this.deleteWhereIn('delivery_records', 'run_id', runIds);
        if (!scopes.includes('evidence')) this.deleteWhereIn('verification_records', 'run_id', runIds);
        this.deleteWhereIn('run_attempts', 'run_id', runIds);
        cleared.runs = this.deleteWhereIn('task_runs', 'id', runIds);
        for (const t of taskRows) {
          this.db
            .prepare("UPDATE tasks SET status = 'todo', claimed_by = NULL, claimed_at = NULL, blocked_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('in_progress','review','done','blocked')")
            .run(new Date().toISOString(), t.id);
        }

        if (scopes.includes('tasks')) {
          const taskIds = taskRows.map((task) => task.id);
          if (taskIds.length > 0) {
            this.deleteWhereIn('run_attempts', 'run_id', runIds);
            this.deleteWhereIn('verification_records', 'run_id', runIds);
            this.deleteWhereIn('delivery_records', 'run_id', runIds);
            this.deleteWhereIn('task_runs', 'id', runIds);
            cleared.tasks = this.deleteWhereIn('tasks', 'id', taskIds);
          }
          const stateRow = this.db.prepare('SELECT state_json FROM projects WHERE id = ?').get(projectId) as any;
          try {
            const state = JSON.parse(stateRow?.state_json || '{}');
            state.tasks = [];
            state.communications = [];
            this.db.prepare('UPDATE projects SET state_json = ?, updated_at = ? WHERE id = ?')
              .run(JSON.stringify(state), new Date().toISOString(), projectId);
          } catch {
            // Local rows remain the authoritative reset target.
          }
        }
        const stateRow = this.db.prepare('SELECT state_json FROM projects WHERE id = ?').get(projectId) as any;
        try {
          const state = JSON.parse(stateRow?.state_json || '{}');
          if (Array.isArray(state.tasks)) state.tasks = [];
          if (Array.isArray(state.communications)) state.communications = [];
          state.cycleCount = 0;
          this.db.prepare('UPDATE projects SET state_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(state), new Date().toISOString(), projectId);
        } catch {
          // A malformed state blob is not allowed to block local row cleanup.
        }
      }

      if (scopes.includes('worktrees')) {
        let removed = 0;
        for (const run of runRows) {
          if (!run.worktree_path) continue;
          try {
            if (fs.existsSync(run.worktree_path)) {
              fs.rmSync(run.worktree_path, { recursive: true, force: true });
            }
            removed += 1;
          } catch (err: any) {
            skipped.push({ scope: 'worktrees', reason: `worktree ${run.worktree_path}: ${err.message}` });
          }
        }
        cleared.worktrees = removed;
        if (runRows.length > 0 && skipped.length === 0) {
          this.pruneProjectWorktreesAndRefs(projectId, runRows);
        }
      }

      if (scopes.includes('artifacts')) {
        const artifactsDir = path.resolve(DATA_DIR, 'artifacts');
        if (fs.existsSync(artifactsDir)) {
          const keys = new Set(taskRows.map((t: any) => String(t.key || t.id).replace(/[^A-Za-z0-9_-]/g, '_')));
          let removed = 0;
          for (const entry of fs.readdirSync(artifactsDir)) {
            const owner = entry.split('__')[0];
            if (keys.has(owner)) {
              try {
                fs.rmSync(path.join(artifactsDir, entry), { recursive: true, force: true });
                removed += 1;
              } catch (err: any) {
                skipped.push({ scope: 'artifacts', reason: `${entry}: ${err.message}` });
              }
            }
          }
          cleared.artifacts = removed;
        } else {
          skipped.push({ scope: 'artifacts', reason: 'no artifacts directory present' });
        }
      }

      const auditId = `aud-${crypto.randomUUID()}`;
      this.store.recordAudit({
        projectId,
        eventType: 'PROJECT_RESET',
        actor,
        details: { scopes, cleared, skipped: skipped.length, remoteResourcesTouched: false },
      });
      return { projectId, cleared, skipped, auditEventId: auditId };
    });

    return result;
  }

  private deleteWhereIn(table: string, column: string, values: string[]): number {
    if (values.length === 0) return 0;
    const placeholders = values.map(() => '?').join(',');
    const res = this.db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...values) as any;
    return res.changes;
  }

  /**
   * Worktree scope cleanup: prune admin entries and delete this project's
   * verified refs and run branches. Shared git objects and other projects'
   * worktrees/refs are untouched; failures are surfaced as skips, never fatal.
   */
  private pruneProjectWorktreesAndRefs(projectId: string, runRows: any[]): void {
    const repoPaths = new Set<string>();
    const cfg = this.db.prepare('SELECT repository_config FROM projects WHERE id = ?').get(projectId) as any;
    try {
      const parsed = JSON.parse(cfg?.repository_config || '{}');
      if (parsed.path) repoPaths.add(String(parsed.path));
    } catch {
      // fall through to per-task discovery
    }
    const taskRepos = this.db
      .prepare('SELECT DISTINCT target_repo_path FROM tasks WHERE project_id = ? AND target_repo_path IS NOT NULL')
      .all(projectId) as any[];
    for (const r of taskRepos) if (r.target_repo_path) repoPaths.add(String(r.target_repo_path));

    for (const repoPath of repoPaths) {
      try {
        for (const run of runRows) {
          if (run.target_branch) {
            try {
              execFileSync('git', ['-C', repoPath, 'branch', '-D', run.target_branch], { stdio: 'ignore' });
            } catch {
              // branch already gone or not in this repo
            }
          }
          if (run.id) {
            try {
              execFileSync('git', ['-C', repoPath, 'update-ref', '-d', `refs/dupond/verified/${run.id}`], { stdio: 'ignore' });
            } catch {
              // ref not present here
            }
          }
        }
        execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: 'ignore' });
      } catch (err: any) {
        // Pruning is best-effort; the removed worktree dirs are the actual data.
      }
    }
  }

  // --- Jira connections (server-held secrets) ---

  public saveJiraConnection(
    projectId: string,
    input: { hostUrl: string; userEmail: string; apiToken?: string; existingConnectionId?: string },
    actor: string,
  ): string {
    if (!this.getProject(projectId)) {
      throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found.`);
    }
    const host = (input.hostUrl || '').trim();
    if (!/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/i.test(host.replace(/\/$/, ''))) {
      throw new ProjectApiError(400, 'INVALID_REQUEST', 'Jira hostUrl must be an https://<site>.atlassian.net site.');
    }
    const email = (input.userEmail || '').trim();
    if (!email) throw new ProjectApiError(400, 'INVALID_REQUEST', 'Jira connection requires userEmail.');

    return this.txn(() => {
      const now = new Date().toISOString();
      if (input.existingConnectionId) {
        const row = this.db
          .prepare('SELECT id, api_token_enc FROM jira_connections WHERE id = ? AND project_id = ?')
          .get(input.existingConnectionId, projectId) as any;
        if (!row) {
          throw new ProjectApiError(400, 'CONNECTION_NOT_FOUND', `Connection ${input.existingConnectionId} does not belong to project ${projectId}.`);
        }
        if (input.apiToken && input.apiToken.trim()) {
          this.db
            .prepare('UPDATE jira_connections SET host_url = ?, user_email = ?, api_token_enc = ?, updated_at = ? WHERE id = ?')
            .run(host, email, encryptSecret(input.apiToken.trim()), now, row.id);
        } else {
          this.db
            .prepare('UPDATE jira_connections SET host_url = ?, user_email = ?, updated_at = ? WHERE id = ?')
            .run(host, email, now, row.id);
        }
        return row.id;
      }
      if (!input.apiToken || !input.apiToken.trim()) {
        throw new ProjectApiError(400, 'INVALID_REQUEST', 'A new Jira connection requires apiToken.');
      }
      const id = `jconn-${crypto.randomUUID()}`;
      this.db
        .prepare(
          'INSERT INTO jira_connections (id, project_id, host_url, user_email, api_token_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, projectId, host, email, encryptSecret(input.apiToken.trim()), now, now);
      this.store.recordAudit({
        projectId,
        eventType: 'JIRA_CONNECTION_SAVED',
        actor,
        details: { connectionId: id, hostUrl: host },
      });
      return id;
    });
  }

  /** Server-internal secret read. Never exposed by any HTTP surface. */
  public getJiraConnectionSecret(connectionId: string, projectId: string): { hostUrl: string; userEmail: string; apiToken: string } | null {
    const row = this.db
      .prepare('SELECT host_url, user_email, api_token_enc FROM jira_connections WHERE id = ? AND project_id = ?')
      .get(connectionId, projectId) as any;
    if (!row) return null;
    return { hostUrl: row.host_url, userEmail: row.user_email, apiToken: decryptSecret(row.api_token_enc) };
  }

  public markJiraProvisioningState(projectId: string, state: 'linked' | 'provisioned' | 'failed'): void {
    this.db
      .prepare("UPDATE projects SET jira_provisioning_state = ?, updated_at = ? WHERE id = ?")
      .run(state, new Date().toISOString(), projectId);
  }

  /** Shared transaction with the task store, for cross-record atomicity. */
  public transact<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }

  public audit(event: Parameters<TaskStore['recordAudit']>[0]): void {
    this.store.recordAudit(event);
  }

  /** Persist a validated/created remote link. connectionId must belong to the project. */
  public applyJiraLink(
    projectId: string,
    link: { connectionId?: string | null; projectKey?: string | null; epicKey?: string | null; state: 'linked' | 'provisioned' },
  ): void {
    let connection = link.connectionId ?? null;
    if (connection) {
      const owned = this.db.prepare('SELECT id FROM jira_connections WHERE id = ? AND project_id = ?').get(connection, projectId) as any;
      if (!owned) connection = null;
    }
    this.db
      .prepare(
        `UPDATE projects SET jira_connection_id = ?, jira_project_key = ?, jira_epic_key = ?, jira_provisioning_state = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        connection,
        link.projectKey ?? null,
        link.epicKey ?? null,
        link.state,
        new Date().toISOString(),
        projectId,
      );
  }

  public clearJiraLink(projectId: string): void {
    this.db
      .prepare(
        "UPDATE projects SET jira_connection_id = NULL, jira_project_key = NULL, jira_epic_key = NULL, jira_provisioning_state = 'unconfigured', updated_at = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), projectId);
  }

  // --- Provisioning operation identity ---

  public beginOperation(args: {
    projectId: string;
    operationId: string;
    mode: string;
    requestFingerprint: string;
  }): { kind: 'new' } | { kind: 'replay'; record: any } | { kind: 'retry'; record: any } | { kind: 'conflict' } {
    const existing = this.db.prepare('SELECT * FROM jira_operations WHERE id = ?').get(args.operationId) as any;
    if (!existing) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO jira_operations (id, project_id, mode, request_fingerprint, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'started', ?, ?)`,
        )
        .run(args.operationId, args.projectId, args.mode, args.requestFingerprint, now, now);
      return { kind: 'new' };
    }
    if (existing.project_id !== args.projectId || existing.request_fingerprint !== args.requestFingerprint) {
      return { kind: 'conflict' };
    }
    if (existing.status === 'failed') {
      // A previous attempt failed; retries are allowed but must reconcile
      // against the remote before creating anything again.
      return { kind: 'retry', record: existing };
    }
    if (existing.status === 'started') {
      // Previous attempt never finished (crash / lost response): reconcile.
      return { kind: 'replay', record: existing };
    }
    return { kind: 'replay', record: existing };
  }

  public finishOperation(
    operationId: string,
    patch: {
      status: 'succeeded' | 'failed' | 'reconciled' | 'no_change';
      resultJson?: string | null;
      remoteId?: string | null;
      remoteKey?: string | null;
      errorJson?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE jira_operations SET status = ?, result_json = COALESCE(?, result_json), remote_id = COALESCE(?, remote_id),
           remote_key = COALESCE(?, remote_key), error_json = COALESCE(?, error_json), updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.resultJson ?? null,
        patch.remoteId ?? null,
        patch.remoteKey ?? null,
        patch.errorJson ?? null,
        new Date().toISOString(),
        operationId,
      );
  }

  public getOperation(operationId: string): any {
    return this.db.prepare('SELECT * FROM jira_operations WHERE id = ?').get(operationId) as any;
  }

  // --- Mapping (credential-free views) ---

  private toView(row: any): Project {
    let repository: ProjectRepositoryConfig = {};
    let preferences: ProjectPreferences = {};
    try {
      repository = JSON.parse(row.repository_config || '{}');
    } catch {
      repository = {};
    }
    try {
      preferences = JSON.parse(row.preferences || '{}');
    } catch {
      preferences = {};
    }
    let hostUrl: string | null = null;
    if (row.jira_connection_id) {
      const conn = this.db.prepare('SELECT host_url FROM jira_connections WHERE id = ?').get(row.jira_connection_id) as any;
      hostUrl = conn ? conn.host_url : null;
    }
    const taskCount = (this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?').get(row.id) as any)?.count || 0;
    const activeRunsCount = (this.db.prepare("SELECT COUNT(*) AS count FROM task_runs WHERE project_id = ? AND status IN ('pending', 'running')").get(row.id) as any)?.count || 0;
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      status: row.status,
      repository,
      jira: {
        connectionId: row.jira_connection_id || null,
        hostUrl,
        projectKey: row.jira_project_key || null,
        epicKey: row.jira_epic_key || null,
        provisioningState: row.jira_provisioning_state || 'unconfigured',
      },
      preferences,
      agentPreferences: preferences,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at ?? null,
      taskCount,
      activeRunsCount,
      capabilities: {
        jira: {
          linkExisting: true,
          createProject: false,
          createEpic: false,
          reason: 'Jira remote creation is disabled until a supported server-held capability is configured.',
        },
      },
    };
  }
}

export const defaultProjectStore = new ProjectStore();
export { DEFAULT_PROJECT_ID };
