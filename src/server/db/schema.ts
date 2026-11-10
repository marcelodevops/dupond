export interface TaskRecord {
  id: string;
  key: string;
  title: string;
  description: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
  priority: 'critical' | 'high' | 'medium' | 'low';
  targetRepo: string;
  targetRepoPath?: string;
  baseCommit: string;
  allowedPaths: string[]; // JSON array
  protectedPaths: string[]; // JSON array
  verificationCommands: Array<string | { command: string; criteriaIds?: string[] }>; // JSON array
  acceptanceCriteria: Array<{ id: string; title: string; completed: boolean; checkCommand?: string }>;
  workerConfig: {
    provider: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
  };
  maxAttempts: number;
  timeoutSeconds: number;
  requireApproval: boolean;
  blockedReason?: string | null;
  claimedBy?: string | null;
  claimedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRunRecord {
  id: string;
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  targetRepo?: string;
  baseCommit: string;
  targetBranch: string;
  worktreePath?: string | null;
  currentAttempt: number;
  durationMs: number;
  failureType?: 'implementation' | 'verification' | 'delivery' | 'ci' | 'timeout' | 'cancelled' | null;
  failureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunAttemptRecord {
  id: string;
  runId: string;
  attemptNumber: number;
  status: 'running' | 'succeeded' | 'failed' | 'timeout';
  workerType: string;
  prompt?: string | null;
  diff?: string | null;
  filesModified: string[];
  logs?: string | null;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } | null;
  durationMs: number;
  errorMessage?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface VerificationRecord {
  id: string;
  runId: string;
  attemptId: string;
  revisionSha: string;
  passed: boolean;
  checks: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
    durationMs: number;
  }>;
  criteriaVerified: string[];
  failureReason?: string | null;
  verifiedAt: string;
  // Evidence binding: the exact content and spec this verification proves.
  // Null on records written before evidence binding existed, which the
  // validity gate treats as insufficient (fresh verification required).
  revisionTreeSha?: string | null;
  requirementsFingerprint?: string | null;
  verificationConfigFingerprint?: string | null;
  evidenceBindingVersion?: string | null;
}

export interface DeliveryRecord {
  id: string;
  runId: string;
  provider: 'github' | 'local_git';
  repoUrl: string;
  baseCommit: string;
  deliveredCommit: string;
  branch: string;
  prNumber?: number | null;
  prUrl?: string | null;
  ciStatus: 'pending' | 'success' | 'failure' | 'unknown';
  approvalStatus: 'approved' | 'pending_approval' | 'rejected';
  approvedBy?: string | null;
  // The identity the approval certifies: the contract and candidate revision
  // that were current when the operator approved, plus the evidence row it
  // rested on. Null when unapproved or when approval predates binding, which
  // the lifecycle gate treats as insufficient (fresh approval required).
  approvalRequirementsFingerprint?: string | null;
  approvalVerificationConfigFingerprint?: string | null;
  approvalRevisionSha?: string | null;
  approvalVerificationId?: string | null;
  approvalBindingVersion?: string | null;
  deliveredAt: string;
}

export interface AuditEventRecord {
  id: string;
  taskId?: string | null;
  runId?: string | null;
  eventType: string;
  actor: string;
  details: Record<string, any>;
  timestamp: string;
}

export const DDL_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  target_repo TEXT NOT NULL,
  target_repo_path TEXT,
  base_commit TEXT NOT NULL,
  allowed_paths TEXT NOT NULL,
  protected_paths TEXT NOT NULL,
  verification_commands TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  worker_config TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  timeout_seconds INTEGER NOT NULL DEFAULT 600,
  require_approval INTEGER NOT NULL DEFAULT 1,
  blocked_reason TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL,
  target_repo TEXT,
  base_commit TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  worktree_path TEXT,
  current_attempt INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  failure_type TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  worker_type TEXT NOT NULL,
  prompt TEXT,
  diff TEXT,
  files_modified TEXT NOT NULL,
  logs TEXT,
  token_usage TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS verification_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  attempt_id TEXT NOT NULL REFERENCES run_attempts(id),
  revision_sha TEXT NOT NULL,
  passed INTEGER NOT NULL,
  checks TEXT NOT NULL,
  criteria_verified TEXT NOT NULL,
  failure_reason TEXT,
  verified_at TEXT NOT NULL,
  revision_tree_sha TEXT,
  requirements_fingerprint TEXT,
  verification_config_fingerprint TEXT,
  evidence_binding_version TEXT
);

CREATE TABLE IF NOT EXISTS delivery_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  provider TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  delivered_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  ci_status TEXT NOT NULL,
  approval_status TEXT NOT NULL,
  approved_by TEXT,
  approval_requirements_fingerprint TEXT,
  approval_verification_config_fingerprint TEXT,
  approval_revision_sha TEXT,
  approval_verification_id TEXT,
  approval_binding_version TEXT,
  delivered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  details TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_run_attempts_run_id ON run_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_verifications_run_id ON verification_records(run_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_run_id ON delivery_records(run_id);
`;
