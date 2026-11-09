import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  TaskRecord,
  TaskRunRecord,
  RunAttemptRecord,
  VerificationRecord,
  DeliveryRecord,
  AuditEventRecord,
  DDL_SCHEMA,
} from './schema.js';
import { computeEvidenceBinding } from '../verification/evidenceBinding.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DEFAULT_DB_PATH = process.env.DUPOND_DB_PATH
  ? path.resolve(process.env.DUPOND_DB_PATH)
  : path.resolve(DATA_DIR, 'dupond.db');

export class TaskStore {
  private db: DatabaseSync;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(DDL_SCHEMA);
    try {
      this.db.exec('ALTER TABLE tasks ADD COLUMN target_repo_path TEXT;');
    } catch {
      // Column already exists
    }
    try {
      this.db.exec('ALTER TABLE task_runs ADD COLUMN target_repo TEXT;');
    } catch {
      // Column already exists
    }
    for (const column of [
      'ALTER TABLE verification_records ADD COLUMN revision_tree_sha TEXT;',
      'ALTER TABLE verification_records ADD COLUMN requirements_fingerprint TEXT;',
      'ALTER TABLE verification_records ADD COLUMN verification_config_fingerprint TEXT;',
      'ALTER TABLE verification_records ADD COLUMN evidence_binding_version TEXT;',
    ]) {
      try {
        this.db.exec(column);
      } catch {
        // Column already exists
      }
    }
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  // --- Transactions ---
  public transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // --- Task Methods ---
  public createTask(task: Omit<TaskRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): TaskRecord {
    const id = task.id || `task-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const record: TaskRecord = {
      ...task,
      id,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, key, title, description, status, priority, target_repo, target_repo_path, base_commit,
        allowed_paths, protected_paths, verification_commands, acceptance_criteria,
        worker_config, max_attempts, timeout_seconds, require_approval,
        blocked_reason, claimed_by, claimed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.key,
      record.title,
      record.description || '',
      record.status || 'todo',
      record.priority || 'medium',
      record.targetRepo || '',
      record.targetRepoPath || null,
      record.baseCommit || 'HEAD',
      JSON.stringify(record.allowedPaths || []),
      JSON.stringify(record.protectedPaths || []),
      JSON.stringify(record.verificationCommands || []),
      JSON.stringify(record.acceptanceCriteria || []),
      JSON.stringify(record.workerConfig || {}),
      record.maxAttempts || 3,
      record.timeoutSeconds || 600,
      record.requireApproval ? 1 : 0,
      record.blockedReason || null,
      record.claimedBy || null,
      record.claimedAt || null,
      record.createdAt,
      record.updatedAt,
    );

    this.recordAudit({
      taskId: id,
      eventType: 'TASK_CREATED',
      actor: 'system',
      details: { key: record.key, title: record.title },
    });

    return record;
  }

  public getTask(idOrKey: string): TaskRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE id = ? OR key = ?
    `);
    const row = stmt.get(idOrKey, idOrKey) as any;
    if (!row) return null;
    return this.mapTaskRow(row);
  }

  public listTasks(statusFilter?: string): TaskRecord[] {
    let stmt;
    if (statusFilter) {
      stmt = this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC');
      return (stmt.all(statusFilter) as any[]).map(this.mapTaskRow);
    }
    stmt = this.db.prepare('SELECT * FROM tasks ORDER BY created_at ASC');
    return (stmt.all() as any[]).map(this.mapTaskRow);
  }

  /**
   * Atomic task claim: claims the next available ready task.
   * Prevents double-scheduling or race conditions across concurrent workers.
   */
  public claimTask(taskId: string, claimToken: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'in_progress', claimed_by = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('todo', 'backlog') AND claimed_by IS NULL
    `);
    const res = stmt.run(claimToken, now, now, taskId) as any;
    const claimed = res.changes > 0;
    if (claimed) {
      this.recordAudit({
        taskId,
        eventType: 'TASK_CLAIMED',
        actor: claimToken,
        details: { claimToken, claimedAt: now },
      });
    }
    return claimed;
  }

  public unclaimTask(taskId: string, status: 'todo' | 'blocked' = 'todo', blockedReason?: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = ?, claimed_by = NULL, claimed_at = NULL, blocked_reason = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, blockedReason || null, now, taskId);
    this.recordAudit({
      taskId,
      eventType: 'TASK_UNCLAIMED',
      actor: 'system',
      details: { status, blockedReason },
    });
  }

  public updateTaskStatus(taskId: string, status: TaskRecord['status'], blockedReason?: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = ?, blocked_reason = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, blockedReason || null, now, taskId);
    this.recordAudit({
      taskId,
      eventType: 'TASK_STATUS_UPDATED',
      actor: 'system',
      details: { status, blockedReason },
    });
  }

  /**
   * Compare-and-swap status change: the update only applies if the task still
   * has one of the expected statuses. Status write and audit event share one
   * transaction, so an applied transition is never recorded without its audit
   * trail and a lost race leaves both untouched.
   */
  public transitionTaskCas(params: {
    taskId: string;
    expectedFrom: TaskRecord['status'][];
    to: TaskRecord['status'];
    actor: string;
    clearClaim?: boolean;
    blockedReason?: string;
    details?: Record<string, any>;
  }): boolean {
    if (params.expectedFrom.length === 0) return false;
    return this.transaction(() => {
      const now = new Date().toISOString();
      const placeholders = params.expectedFrom.map(() => '?').join(', ');
      const clearClaim = params.clearClaim ? 1 : 0;
      const stmt = this.db.prepare(`
        UPDATE tasks
        SET status = ?,
            blocked_reason = ?,
            claimed_by = CASE WHEN ? = 1 THEN NULL ELSE claimed_by END,
            claimed_at = CASE WHEN ? = 1 THEN NULL ELSE claimed_at END,
            updated_at = ?
        WHERE id = ? AND status IN (${placeholders})
      `);
      const res = stmt.run(
        params.to,
        params.blockedReason || null,
        clearClaim,
        clearClaim,
        now,
        params.taskId,
        ...params.expectedFrom,
      ) as any;
      if (res.changes === 0) return false;
      this.recordAudit({
        taskId: params.taskId,
        eventType: 'TASK_LIFECYCLE_TRANSITION',
        actor: params.actor,
        details: { ...(params.details || {}), applied: true, casExpected: params.expectedFrom },
      });
      return true;
    });
  }

  /**
   * Applies a requirements/config change to a task and, when the evidence
   * binding changes, records the invalidation and demotes any approved
   * delivery of the latest run back to pending approval. Prior acceptance and
   * approval can no longer authorize the new spec.
   */
  public updateTaskRequirements(
    taskId: string,
    updates: Partial<Pick<TaskRecord, 'acceptanceCriteria' | 'verificationCommands' | 'protectedPaths' | 'description'>>,
    actor: string = 'system',
  ): { updated: boolean; bindingChanged: boolean; invalidatedApprovalRunIds: string[] } {
    return this.transaction(() => {
      const current = this.getTask(taskId);
      if (!current) return { updated: false, bindingChanged: false, invalidatedApprovalRunIds: [] };

      const before = computeEvidenceBinding(current);
      const merged: TaskRecord = { ...current, ...updates };
      const after = computeEvidenceBinding(merged);
      const bindingChanged =
        before.requirementsFingerprint !== after.requirementsFingerprint ||
        before.verificationConfigFingerprint !== after.verificationConfigFingerprint;

      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        UPDATE tasks
        SET description = ?, acceptance_criteria = ?, verification_commands = ?, protected_paths = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(
        merged.description || '',
        JSON.stringify(merged.acceptanceCriteria || []),
        JSON.stringify(merged.verificationCommands || []),
        JSON.stringify(merged.protectedPaths || []),
        now,
        taskId,
      );

      this.recordAudit({
        taskId,
        eventType: 'TASK_REQUIREMENTS_UPDATED',
        actor,
        details: {
          bindingChanged,
          requirementsFingerprint: after.requirementsFingerprint,
          verificationConfigFingerprint: after.verificationConfigFingerprint,
        },
      });

      const invalidatedApprovalRunIds: string[] = [];
      if (bindingChanged) {
        const latestRun = this.getLatestRunForTask(taskId);
        if (latestRun) {
          const delivery = this.getDeliveryForRun(latestRun.id);
          if (delivery && delivery.approvalStatus === 'approved') {
            this.db
              .prepare(`UPDATE delivery_records SET approval_status = 'pending_approval', approved_by = NULL WHERE id = ?`)
              .run(delivery.id);
            invalidatedApprovalRunIds.push(latestRun.id);
            this.recordAudit({
              taskId,
              runId: latestRun.id,
              eventType: 'APPROVAL_INVALIDATED',
              actor,
              details: {
                reason: bindingChanged
                  ? 'Acceptance requirements or verification configuration changed; prior approval no longer applies to the new spec.'
                  : 'unchanged',
                deliveredCommit: delivery.deliveredCommit,
              },
            });
          }
        }
      }

      return { updated: true, bindingChanged, invalidatedApprovalRunIds };
    });
  }

  // --- Run Methods ---
  public createRun(run: Omit<TaskRunRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): TaskRunRecord {
    const id = run.id || `run-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const record: TaskRunRecord = {
      ...run,
      id,
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO task_runs (
        id, task_id, status, target_repo, base_commit, target_branch, worktree_path,
        current_attempt, duration_ms, failure_type, failure_reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.taskId,
      record.status,
      record.targetRepo || null,
      record.baseCommit,
      record.targetBranch,
      record.worktreePath || null,
      record.currentAttempt,
      record.durationMs,
      record.failureType || null,
      record.failureReason || null,
      record.createdAt,
      record.updatedAt,
    );

    this.recordAudit({
      taskId: record.taskId,
      runId: id,
      eventType: 'RUN_CREATED',
      actor: 'coordinator',
      details: { targetBranch: record.targetBranch, baseCommit: record.baseCommit },
    });

    return record;
  }

  public getRun(id: string): TaskRunRecord | null {
    const stmt = this.db.prepare('SELECT * FROM task_runs WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.mapRunRow(row);
  }

  public getLatestRunForTask(taskId: string): TaskRunRecord | null {
    const stmt = this.db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1');
    const row = stmt.get(taskId) as any;
    if (!row) return null;
    return this.mapRunRow(row);
  }

  public updateRun(id: string, updates: Partial<TaskRunRecord>): void {
    const current = this.getRun(id);
    if (!current) throw new Error(`Run ${id} not found`);

    const now = new Date().toISOString();
    const updated: TaskRunRecord = {
      ...current,
      ...updates,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      UPDATE task_runs
      SET status = ?, base_commit = ?, target_repo = ?, worktree_path = ?, current_attempt = ?, duration_ms = ?,
          failure_type = ?, failure_reason = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updated.status,
      updated.baseCommit,
      updated.targetRepo || null,
      updated.worktreePath || null,
      updated.currentAttempt,
      updated.durationMs,
      updated.failureType || null,
      updated.failureReason || null,
      updated.updatedAt,
      id,
    );

    this.recordAudit({
      taskId: updated.taskId,
      runId: id,
      eventType: 'RUN_UPDATED',
      actor: 'coordinator',
      details: { status: updated.status, failureReason: updated.failureReason },
    });
  }

  // --- Attempt Methods ---
  public createAttempt(attempt: Omit<RunAttemptRecord, 'id'> & { id?: string }): RunAttemptRecord {
    const id = attempt.id || `att-${crypto.randomUUID()}`;
    const record: RunAttemptRecord = {
      ...attempt,
      id,
    };

    const stmt = this.db.prepare(`
      INSERT INTO run_attempts (
        id, run_id, attempt_number, status, worker_type, prompt, diff,
        files_modified, logs, token_usage, duration_ms, error_message,
        started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.runId,
      record.attemptNumber,
      record.status,
      record.workerType,
      record.prompt || null,
      record.diff || null,
      JSON.stringify(record.filesModified || []),
      record.logs || null,
      record.tokenUsage ? JSON.stringify(record.tokenUsage) : null,
      record.durationMs,
      record.errorMessage || null,
      record.startedAt,
      record.completedAt || null,
    );

    return record;
  }

  public updateAttempt(id: string, updates: Partial<RunAttemptRecord>): void {
    const stmt = this.db.prepare(`
      UPDATE run_attempts
      SET status = COALESCE(?, status),
          diff = COALESCE(?, diff),
          files_modified = COALESCE(?, files_modified),
          logs = COALESCE(?, logs),
          token_usage = COALESCE(?, token_usage),
          duration_ms = COALESCE(?, duration_ms),
          error_message = COALESCE(?, error_message),
          completed_at = COALESCE(?, completed_at)
      WHERE id = ?
    `);

    stmt.run(
      updates.status || null,
      updates.diff || null,
      updates.filesModified ? JSON.stringify(updates.filesModified) : null,
      updates.logs || null,
      updates.tokenUsage ? JSON.stringify(updates.tokenUsage) : null,
      updates.durationMs !== undefined ? updates.durationMs : null,
      updates.errorMessage || null,
      updates.completedAt || null,
      id,
    );
  }

  public listAttempts(runId: string): RunAttemptRecord[] {
    const stmt = this.db.prepare('SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt_number ASC');
    return (stmt.all(runId) as any[]).map(this.mapAttemptRow);
  }

  // --- Verification Records ---
  public recordVerification(verification: Omit<VerificationRecord, 'id' | 'verifiedAt'> & { id?: string }): VerificationRecord {
    const id = verification.id || `ver-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const record: VerificationRecord = {
      ...verification,
      id,
      verifiedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO verification_records (
        id, run_id, attempt_id, revision_sha, passed, checks, criteria_verified,
        failure_reason, verified_at,
        revision_tree_sha, requirements_fingerprint, verification_config_fingerprint,
        evidence_binding_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.runId,
      record.attemptId,
      record.revisionSha,
      record.passed ? 1 : 0,
      JSON.stringify(record.checks || []),
      JSON.stringify(record.criteriaVerified || []),
      record.failureReason || null,
      record.verifiedAt,
      record.revisionTreeSha || null,
      record.requirementsFingerprint || null,
      record.verificationConfigFingerprint || null,
      record.evidenceBindingVersion || null,
    );

    return record;
  }

  public getLatestVerification(runId: string): VerificationRecord | null {
    const stmt = this.db.prepare('SELECT * FROM verification_records WHERE run_id = ? ORDER BY verified_at DESC LIMIT 1');
    const row = stmt.get(runId) as any;
    if (!row) return null;
    return this.mapVerificationRow(row);
  }

  // --- Delivery Records ---
  public recordDelivery(delivery: Omit<DeliveryRecord, 'id' | 'deliveredAt'> & { id?: string }): DeliveryRecord {
    const id = delivery.id || `del-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const record: DeliveryRecord = {
      ...delivery,
      id,
      deliveredAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO delivery_records (
        id, run_id, provider, repo_url, base_commit, delivered_commit,
        branch, pr_number, pr_url, ci_status, approval_status, approved_by, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.runId,
      record.provider,
      record.repoUrl,
      record.baseCommit,
      record.deliveredCommit,
      record.branch,
      record.prNumber || null,
      record.prUrl || null,
      record.ciStatus,
      record.approvalStatus,
      record.approvedBy || null,
      record.deliveredAt,
    );

    return record;
  }

  public getDeliveryForRun(runId: string): DeliveryRecord | null {
    const stmt = this.db.prepare('SELECT * FROM delivery_records WHERE run_id = ?');
    const row = stmt.get(runId) as any;
    if (!row) return null;
    return this.mapDeliveryRow(row);
  }

  public getDeliveryByBranch(branch: string): DeliveryRecord | null {
    const stmt = this.db.prepare('SELECT * FROM delivery_records WHERE branch = ? ORDER BY delivered_at DESC LIMIT 1');
    const row = stmt.get(branch) as any;
    if (!row) return null;
    return this.mapDeliveryRow(row);
  }

  // --- Audit Events ---
  public recordAudit(event: Omit<AuditEventRecord, 'id' | 'timestamp'>): void {
    const id = `aud-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO audit_events (id, task_id, run_id, event_type, actor, details, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      event.taskId || null,
      event.runId || null,
      event.eventType,
      event.actor,
      JSON.stringify(event.details || {}),
      now,
    );
  }

  public listAuditEvents(taskId?: string): AuditEventRecord[] {
    let stmt;
    if (taskId) {
      stmt = this.db.prepare('SELECT * FROM audit_events WHERE task_id = ? ORDER BY timestamp ASC');
      return (stmt.all(taskId) as any[]).map(this.mapAuditRow);
    }
    stmt = this.db.prepare('SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT 100');
    return (stmt.all() as any[]).map(this.mapAuditRow);
  }

  /**
   * Restart reconciliation:
   * Called on coordinator boot. Identifies interrupted runs, marks them failed honestly,
   * unclaims orphaned tasks so they can be re-scheduled or inspected, and prevents duplicate delivery.
   */
  public reconcileOnRestart(): { reconciledRuns: number; unclaimedTasks: number } {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const runStmt = this.db.prepare(`
        UPDATE task_runs
        SET status = 'failed',
            failure_type = 'cancelled',
            failure_reason = 'Interrupted: Server crashed or restarted while run was active',
            updated_at = ?
        WHERE status = 'running'
      `);
      const runRes = runStmt.run(now) as any;

      const taskStmt = this.db.prepare(`
        UPDATE tasks
        SET status = 'todo',
            claimed_by = NULL,
            claimed_at = NULL,
            blocked_reason = 'Interrupted by server restart, reset to todo for clean retry',
            updated_at = ?
        WHERE status = 'in_progress' AND claimed_by IS NOT NULL
      `);
      const taskRes = taskStmt.run(now) as any;

      return {
        reconciledRuns: runRes.changes,
        unclaimedTasks: taskRes.changes,
      };
    });
  }

  // --- Row Mappers ---
  private mapTaskRow(row: any): TaskRecord {
    return {
      id: row.id,
      key: row.key,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      targetRepo: row.target_repo,
      targetRepoPath: row.target_repo_path || undefined,
      baseCommit: row.base_commit,
      allowedPaths: JSON.parse(row.allowed_paths || '[]'),
      protectedPaths: JSON.parse(row.protected_paths || '[]'),
      verificationCommands: JSON.parse(row.verification_commands || '[]'),
      acceptanceCriteria: JSON.parse(row.acceptance_criteria || '[]'),
      workerConfig: JSON.parse(row.worker_config || '{}'),
      maxAttempts: row.max_attempts,
      timeoutSeconds: row.timeout_seconds,
      requireApproval: Boolean(row.require_approval),
      blockedReason: row.blocked_reason,
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRunRow(row: any): TaskRunRecord {
    return {
      id: row.id,
      taskId: row.task_id,
      status: row.status,
      targetRepo: row.target_repo || undefined,
      baseCommit: row.base_commit,
      targetBranch: row.target_branch,
      worktreePath: row.worktree_path,
      currentAttempt: row.current_attempt,
      durationMs: row.duration_ms,
      failureType: row.failure_type,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAttemptRow(row: any): RunAttemptRecord {
    return {
      id: row.id,
      runId: row.run_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      workerType: row.worker_type,
      prompt: row.prompt,
      diff: row.diff,
      filesModified: JSON.parse(row.files_modified || '[]'),
      logs: row.logs,
      tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : null,
      durationMs: row.duration_ms,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  private mapVerificationRow(row: any): VerificationRecord {
    return {
      id: row.id,
      runId: row.run_id,
      attemptId: row.attempt_id,
      revisionSha: row.revision_sha,
      passed: Boolean(row.passed),
      checks: JSON.parse(row.checks || '[]'),
      criteriaVerified: JSON.parse(row.criteria_verified || '[]'),
      failureReason: row.failure_reason,
      verifiedAt: row.verified_at,
      revisionTreeSha: row.revision_tree_sha ?? null,
      requirementsFingerprint: row.requirements_fingerprint ?? null,
      verificationConfigFingerprint: row.verification_config_fingerprint ?? null,
      evidenceBindingVersion: row.evidence_binding_version ?? null,
    };
  }

  private mapDeliveryRow(row: any): DeliveryRecord {
    return {
      id: row.id,
      runId: row.run_id,
      provider: row.provider,
      repoUrl: row.repo_url,
      baseCommit: row.base_commit,
      deliveredCommit: row.delivered_commit,
      branch: row.branch,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      ciStatus: row.ci_status,
      approvalStatus: row.approval_status,
      approvedBy: row.approved_by,
      deliveredAt: row.delivered_at,
    };
  }

  private mapAuditRow(row: any): AuditEventRecord {
    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      eventType: row.event_type,
      actor: row.actor,
      details: JSON.parse(row.details || '{}'),
      timestamp: row.timestamp,
    };
  }
}

export const taskStore = new TaskStore();
