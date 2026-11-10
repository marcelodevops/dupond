import crypto from 'crypto';
import { DeliveryRecord, TaskRecord, VerificationRecord } from '../db/schema.js';

/**
 * Bump when the meaning of a stored verification record changes.
 * Records written under an older version no longer satisfy the gate and
 * force fresh verification, the same as a legacy unbound record.
 *
 * v2 folds the task description (the specification) into the requirements
 * fingerprint, which v1 omitted. Migration behavior: v1-bound evidence cannot
 * prove the v2 contract, so it is rejected as `verifier-upgraded` and fresh
 * verification is required. No rows are rewritten; fingerprints are only ever
 * produced by the verification pipeline at record time.
 */
export const EVIDENCE_BINDING_VERSION = 'dupond-evidence-v2';

export interface EvidenceBinding {
  requirementsFingerprint: string;
  verificationConfigFingerprint: string;
  evidenceBindingVersion: string;
}

export interface EvidenceBindingParams {
  description?: string;
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
  // The description is the specification the criteria are written against. An
  // edit that rewords what is being accepted must invalidate evidence, so it
  // belongs in the requirements fingerprint alongside the criteria themselves.
  const specification = params.description ?? '';
  const requirementsFingerprint = sha256(canonicalJson({ specification, criteria }));
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
  task: Pick<TaskRecord, 'acceptanceCriteria' | 'verificationCommands' | 'protectedPaths' | 'description'>,
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
      detail: 'The specification or acceptance criteria changed after this evidence was recorded. The prior verification does not apply to the current requirements.',
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

/**
 * What an operator's approval certifies: the candidate revision, the contract
 * (specification + criteria and verification configuration) that was current
 * when it was given, and the evidence record it rested on. Approval is only
 * ever persisted with this identity attached, so a later decision can tell
 * whether the approval still applies to what would be accepted.
 */
export interface ApprovalExpectation {
  revisionSha: string;
  requirementsFingerprint: string;
  verificationConfigFingerprint: string;
  verificationId: string;
  evidenceBindingVersion: string;
}

export type ApprovalAssessment =
  | { accepted: true }
  | { accepted: false; reason: string; detail: string };

type SpecSource = Pick<TaskRecord, 'acceptanceCriteria' | 'verificationCommands' | 'protectedPaths' | 'description'>;

/**
 * Validate the identity an approval claims *before* it is written, against
 * freshly read state. Callers cannot substitute their own earlier checks for
 * this one: a requirements edit, a new verification record, or a newer
 * candidate that lands between the caller's validation and the approval write
 * makes this refuse, so no approval is ever recorded against a contract the
 * operator did not review.
 */
export function validateApprovalExpectation(params: {
  task: SpecSource;
  verification: VerificationRecord | null;
  deliveredCommit: string;
  expectation: ApprovalExpectation;
}): ApprovalAssessment {
  const { task, verification, deliveredCommit, expectation } = params;
  const binding = computeEvidenceBinding(task);

  if (expectation.evidenceBindingVersion !== binding.evidenceBindingVersion) {
    return {
      accepted: false,
      reason: 'verifier-upgraded',
      detail: `The approval was prepared under verification protocol ${expectation.evidenceBindingVersion}; the current protocol is ${binding.evidenceBindingVersion}. Fresh approval required.`,
    };
  }
  if (
    expectation.requirementsFingerprint !== binding.requirementsFingerprint ||
    expectation.verificationConfigFingerprint !== binding.verificationConfigFingerprint
  ) {
    return {
      accepted: false,
      reason: 'stale-requirements',
      detail: 'The specification, acceptance criteria, or verification configuration changed after this approval was prepared. The approval certifies a contract the task no longer has.',
    };
  }
  if (expectation.revisionSha !== deliveredCommit) {
    return {
      accepted: false,
      reason: 'approval-revision-mismatch',
      detail: `The approval was prepared for revision ${expectation.revisionSha}, but this delivery carries ${deliveredCommit}.`,
    };
  }
  if (!verification || verification.id !== expectation.verificationId) {
    return {
      accepted: false,
      reason: 'no-evidence',
      detail: `The evidence this approval rested on (${expectation.verificationId}) is no longer the latest verification for this run.`,
    };
  }
  const validity = assessEvidenceValidity(task, verification);
  if (!validity.valid) {
    return { accepted: false, reason: validity.reason, detail: validity.detail };
  }
  return { accepted: true };
}

/**
 * Whether the approval already recorded on a delivery still certifies what is
 * about to be accepted: the same contract, the same evidence, the same
 * revision. Rows approved before approval binding existed carry no identity and
 * are refused, the same way legacy evidence is refused.
 */
export function assessApprovalCurrency(params: {
  task: SpecSource;
  delivery: DeliveryRecord;
  verification: VerificationRecord | null;
}): ApprovalAssessment {
  const { task, delivery, verification } = params;
  const binding = computeEvidenceBinding(task);

  if (
    !delivery.approvalRequirementsFingerprint ||
    !delivery.approvalVerificationConfigFingerprint ||
    !delivery.approvalRevisionSha ||
    !delivery.approvalVerificationId ||
    !delivery.approvalBindingVersion
  ) {
    return {
      accepted: false,
      reason: 'legacy-approval',
      detail: `Approval by ${delivery.approvedBy || 'unknown'} predates approval binding and cannot certify the current contract. Explicit operator re-approval is required.`,
    };
  }
  if (
    delivery.approvalRequirementsFingerprint !== binding.requirementsFingerprint ||
    delivery.approvalVerificationConfigFingerprint !== binding.verificationConfigFingerprint ||
    delivery.approvalBindingVersion !== binding.evidenceBindingVersion
  ) {
    return {
      accepted: false,
      reason: 'stale-approval',
      detail: 'The approval was granted against a different specification or verification configuration than the task has now. Explicit operator re-approval is required.',
    };
  }
  if (delivery.approvalRevisionSha !== delivery.deliveredCommit) {
    return {
      accepted: false,
      reason: 'approval-revision-mismatch',
      detail: `The approval certifies revision ${delivery.approvalRevisionSha}, but this delivery carries ${delivery.deliveredCommit}.`,
    };
  }
  if (!verification || delivery.approvalVerificationId !== verification.id) {
    return {
      accepted: false,
      reason: 'stale-approval',
      detail: `The approval rested on verification ${delivery.approvalVerificationId}, which is no longer the latest evidence for this run.`,
    };
  }
  return { accepted: true };
}
