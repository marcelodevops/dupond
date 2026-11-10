import crypto from 'crypto';
import { TaskRecord, VerificationRecord } from '../db/schema.js';

/**
 * Bump when the meaning of a stored verification record changes.
 * Records written under an older version no longer satisfy the gate and
 * force fresh verification, the same as a legacy unbound record.
 */
export const EVIDENCE_BINDING_VERSION = 'dupond-evidence-v1';

export interface EvidenceBinding {
  requirementsFingerprint: string;
  verificationConfigFingerprint: string;
  evidenceBindingVersion: string;
}

export interface EvidenceBindingParams {
  acceptanceCriteria?: Array<{ id: string; title: string; checkCommand?: string }>;
  verificationCommands?: Array<string | { command: string; criteriaIds?: string[] }>;
  protectedPaths?: string[];
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value === undefined ? null : value;
}

/** Deterministic JSON: object keys sorted recursively, array order preserved. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeCommand(cmd: string | { command: string; criteriaIds?: string[] }): { command: string; criteriaIds: string[] } {
  if (typeof cmd === 'string') return { command: cmd, criteriaIds: [] };
  return { command: cmd.command, criteriaIds: cmd.criteriaIds || [] };
}

export function computeEvidenceBinding(params: EvidenceBindingParams): EvidenceBinding {
  const criteria = (params.acceptanceCriteria || []).map((c) => ({
    id: c.id,
    title: c.title,
    checkCommand: c.checkCommand || null,
  }));
  const commands = (params.verificationCommands || []).map(normalizeCommand);
  const requirementsFingerprint = sha256(canonicalJson(criteria));
  const verificationConfigFingerprint = sha256(
    canonicalJson({ commands, protectedPaths: params.protectedPaths || [] }),
  );
  return {
    requirementsFingerprint,
    verificationConfigFingerprint,
    evidenceBindingVersion: EVIDENCE_BINDING_VERSION,
  };
}

export type EvidenceInvalidReason =
  | 'no-evidence'
  | 'failed-verification'
  | 'legacy-evidence'
  | 'verifier-upgraded'
  | 'stale-requirements'
  | 'changed-verification-config'
  | 'uncovered-criteria';

export type EvidenceValidity =
  | { valid: true; binding: EvidenceBinding }
  | { valid: false; reason: EvidenceInvalidReason; detail: string };

/**
 * Resolve a task's stored verification against the task's current requirements
 * and verification configuration. Anything that is not provably bound to the
 * present spec is rejected: fail-closed, requiring fresh verification.
 */
export function assessEvidenceValidity(
  task: Pick<TaskRecord, 'acceptanceCriteria' | 'verificationCommands' | 'protectedPaths'>,
  verification: VerificationRecord | null,
): EvidenceValidity {
  const binding = computeEvidenceBinding(task);

  if (!verification) {
    return { valid: false, reason: 'no-evidence', detail: 'No verification record exists for this run.' };
  }
  if (!verification.passed) {
    return {
      valid: false,
      reason: 'failed-verification',
      detail: `Latest verification for revision ${verification.revisionSha} did not pass: ${verification.failureReason || 'unknown failure'}`,
    };
  }
  if (
    !verification.requirementsFingerprint ||
    !verification.verificationConfigFingerprint ||
    !verification.evidenceBindingVersion
  ) {
    return {
      valid: false,
      reason: 'legacy-evidence',
      detail: `Verification record ${verification.id} predates evidence binding and cannot prove acceptance of the current spec. Fresh verification required.`,
    };
  }
  if (verification.evidenceBindingVersion !== binding.evidenceBindingVersion) {
    return {
      valid: false,
      reason: 'verifier-upgraded',
      detail: `Evidence was produced under verification protocol ${verification.evidenceBindingVersion}; the current protocol is ${binding.evidenceBindingVersion}. Fresh verification required.`,
    };
  }
  if (verification.requirementsFingerprint !== binding.requirementsFingerprint) {
    return {
      valid: false,
      reason: 'stale-requirements',
      detail: 'Acceptance criteria changed after this evidence was recorded. The prior verification does not apply to the current requirements.',
    };
  }
  if (verification.verificationConfigFingerprint !== binding.verificationConfigFingerprint) {
    return {
      valid: false,
      reason: 'changed-verification-config',
      detail: 'Verification commands or protected paths changed after this evidence was recorded. Fresh verification required.',
    };
  }

  const requiredCriteria = (task.acceptanceCriteria || []).map((c) => c.id);
  const covered = new Set(verification.criteriaVerified || []);
  const uncovered = requiredCriteria.filter((id) => !covered.has(id));
  if (uncovered.length > 0) {
    return {
      valid: false,
      reason: 'uncovered-criteria',
      detail: `Acceptance criteria [${uncovered.join(', ')}] have no passing evidence on revision ${verification.revisionSha}.`,
    };
  }

  return { valid: true, binding };
}

/**
 * Durable git ref for a run's verified candidate. Pinning the commit keeps the
 * exact verified content reachable after the ephemeral worktree and branch are
 * removed, so acceptance resolves to a real commit instead of a custom snapshot.
 */
export function verifiedRefForRun(runId: string): string {
  return `refs/dupond/verified/${runId}`;
}
