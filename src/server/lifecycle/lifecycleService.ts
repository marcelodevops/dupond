import { TaskRecord, TaskRunRecord, VerificationRecord, DeliveryRecord } from '../db/schema.js';
import { TaskStore, taskStore as defaultTaskStore } from '../db/database.js';
import { assessEvidenceValidity, EvidenceValidity } from '../verification/evidenceBinding.js';

export type LifecycleStatus = TaskRecord['status'];

export interface TransitionRequest {
  taskId: string;
  to: LifecycleStatus;
  actor: string;
  reason?: string;
  /** Set by the delivery service when the transition is a consequence of a completed delivery. */
  viaDelivery?: boolean;
}

export interface TransitionResult {
  ok: boolean;
  from?: LifecycleStatus;
  to: LifecycleStatus;
  reason?: string;
  detail?: string;
  evidence?: EvidenceValidity;
}

const REVIEW_ALLOWED_FROM: LifecycleStatus[] = ['todo', 'backlog', 'in_progress', 'blocked', 'review'];
const DONE_ALLOWED_FROM: LifecycleStatus[] = ['review'];
const REOPEN_TARGETS: LifecycleStatus[] = ['todo', 'backlog', 'blocked'];
const START_ALLOWED_FROM: LifecycleStatus[] = ['todo', 'backlog', 'blocked'];

/**
 * The single authoritative lifecycle service. Every status change that claims
 * acceptance (Review, Done) is validated here against bound evidence, applied
 * with compare-and-swap, and audited inside the same transaction. UI/JSON state
 * is a projection of these outcomes and cannot grant acceptance on its own.
 */
export class LifecycleService {
  private store: TaskStore;

  constructor(store: TaskStore = defaultTaskStore) {
    this.store = store;
  }

  public transition(request: TransitionRequest): TransitionResult {
    const task = this.store.getTask(request.taskId);
    if (!task) {
      return { ok: false, to: request.to, reason: 'not-found', detail: `Task ${request.taskId} is not registered in the authoritative store.` };
    }

    const from = task.status;
    const run = this.store.getLatestRunForTask(task.id);
    const verification = run ? this.store.getLatestVerification(run.id) : null;

    if (request.to === 'review') {
      if (!REVIEW_ALLOWED_FROM.includes(from)) {
        return { ok: false, from, to: request.to, reason: 'transition-not-allowed', detail: `Cannot enter Review from "${from}". Reopen the task first.` };
      }
      const validity = assessEvidenceValidity(task, verification);
      if (!validity.valid) {
        return {
          ok: false,
          from,
          to: request.to,
          reason: validity.reason,
          detail: `Review requires current passing evidence bound to this task's requirements: ${validity.detail}`,
          evidence: validity,
        };
      }
    }

    if (request.to === 'done') {
      const validity = assessEvidenceValidity(task, verification);
      if (!validity.valid) {
        return {
          ok: false,
          from,
          to: request.to,
          reason: validity.reason,
          detail: `Done requires current passing evidence bound to this task's requirements: ${validity.detail}`,
          evidence: validity,
        };
      }
      const delivery = run ? this.store.getDeliveryForRun(run.id) : null;
      if (!delivery) {
        return {
          ok: false,
          from,
          to: request.to,
          reason: 'delivery-pending',
          detail: `Done requires a recorded delivery for run ${run?.id || '(none)'}. Verified work alone does not complete a task.`,
        };
      }
      if (verification && delivery.deliveredCommit !== verification.revisionSha) {
        return {
          ok: false,
          from,
          to: request.to,
          reason: 'delivered-revision-mismatch',
          detail: `Delivered commit ${delivery.deliveredCommit} is not the verified revision ${verification.revisionSha}. Acceptance must resolve to the exact delivered content.`,
        };
      }
      if (task.requireApproval && delivery.approvalStatus !== 'approved') {
        return {
          ok: false,
          from,
          to: request.to,
          reason: 'approval-pending',
          detail: `Delivery approval is "${delivery.approvalStatus}"; Done requires an approved delivery.`,
        };
      }
      if (!request.viaDelivery && !DONE_ALLOWED_FROM.includes(from)) {
        return {
          ok: false,
          from,
          to: request.to,
          reason: 'transition-not-allowed',
          detail: `Manual Done transition requires status Review (got "${from}").`,
        };
      }
    }

    if (request.to === 'in_progress') {
      if (!START_ALLOWED_FROM.includes(from)) {
        return { ok: false, from, to: request.to, reason: 'transition-not-allowed', detail: `Cannot start work from "${from}". Reopen the task first.` };
      }
    } else if (!REOPEN_TARGETS.includes(request.to) && request.to !== 'review' && request.to !== 'done') {
      return { ok: false, from, to: request.to, reason: 'unsupported-transition', detail: `Lifecycle service does not mediate transitions to "${request.to}".` };
    }

    const applied = this.store.transitionTaskCas({
      taskId: task.id,
      expectedFrom: [from],
      to: request.to,
      clearClaim: request.to !== 'in_progress',
      actor: request.actor,
      details: {
        from,
        to: request.to,
        actor: request.actor,
        reason: request.reason,
        viaDelivery: request.viaDelivery === true,
        runId: run?.id || null,
        verificationId: verification?.id || null,
      },
    });

    if (!applied) {
      return {
        ok: false,
        from,
        to: request.to,
        reason: 'conflict',
        detail: `Task status changed concurrently; transition from "${from}" was not applied.`,
      };
    }

    return { ok: true, from, to: request.to };
  }

  /**
   * Used by autonomous pipelines that already hold the evidence: validates the
   * evidence binding for the given run before applying the transition, so no
   * caller can advance a task to Review on stale or unbound proof.
   */
  public reviewGate(task: TaskRecord, verification: VerificationRecord | null): EvidenceValidity {
    return assessEvidenceValidity(task, verification);
  }
}

export const defaultLifecycleService = new LifecycleService();
