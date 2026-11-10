import { TaskRecord, TaskRunRecord, VerificationRecord, DeliveryRecord } from '../db/schema.js';
import { TaskStore, LifecycleSnapshot, taskStore as defaultTaskStore } from '../db/database.js';
import { assessApprovalCurrency, assessEvidenceValidity, EvidenceValidity } from '../verification/evidenceBinding.js';

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
 * with compare-and-swap plus audit event in one transaction. UI/JSON state is
 * a projection of these outcomes and cannot grant acceptance on its own.
 *
 * The authoritative decision runs inside the store transaction's write lock
 * against freshly read rows. Validating evidence before the write is not a
 * guarantee: another connection can change the requirements, the verification
 * evidence, or the relevant run in the window between validation and commit,
 * so the same checks are re-executed transactionally and only that outcome is
 * applied.
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

    // Fast-path pre-check against the current read so callers get precise,
    // typed refusals (including the evidence breakdown) without opening a
    // write transaction for hopeless transitions.
    const run = this.store.getLatestRunForTask(task.id);
    const verification = run ? this.store.getLatestVerification(run.id) : null;
    const delivery = run ? this.store.getDeliveryForRun(run.id) : null;
    const preDecision = this.evaluate(request, { task, run, verification, delivery });
    if (!preDecision.accept) {
      const result: TransitionResult = {
        ok: false,
        from,
        to: request.to,
        reason: preDecision.reason,
        detail: preDecision.detail,
      };
      if (request.to === 'review' || request.to === 'done') {
        result.evidence = assessEvidenceValidity(task, verification);
      }
      return result;
    }

    let rejection: { reason?: string; detail?: string } | null = null;
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
      },
      guard: (snapshot) => {
        const decision = this.evaluate(request, snapshot);
        if (!decision.accept) rejection = { reason: decision.reason, detail: decision.detail };
        return decision;
      },
    });

    if (!applied) {
      // `rejection` is written from inside the transaction guard; re-widen it
      // explicitly because control-flow analysis assumes the closure ran.
      const refusal = rejection as { reason?: string; detail?: string } | null;
      if (refusal) {
        return {
          ok: false,
          from,
          to: request.to,
          reason: refusal.reason,
          detail: refusal.detail,
          evidence: request.to === 'review' || request.to === 'done'
            ? assessEvidenceValidity(task, this.store.getLatestVerification(this.store.getLatestRunForTask(task.id)?.id || '') || null)
            : undefined,
        };
      }
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
   * All rules that decide whether `request` may be applied, evaluated against
   * the given (fresh, inside-transaction) snapshot. Pure: reads nothing except
   * the snapshot.
   */
  private evaluate(request: TransitionRequest, snapshot: LifecycleSnapshot): {
    accept: boolean;
    reason?: string;
    detail?: string;
    run?: TaskRunRecord | null;
  } {
    const { task, run, verification, delivery } = snapshot;
    if (!task) {
      return { accept: false, reason: 'not-found', detail: `Task ${request.taskId} disappeared before the transition could apply.` };
    }
    const status = task.status;

    if (request.to === 'review') {
      if (!REVIEW_ALLOWED_FROM.includes(status)) {
        return { accept: false, reason: 'transition-not-allowed', detail: `Cannot enter Review from "${status}". Reopen the task first.` };
      }
      const validity = assessEvidenceValidity(task, verification);
      if (!validity.valid) {
        return {
          accept: false,
          reason: validity.reason,
          detail: `Review requires current passing evidence bound to this task's requirements: ${validity.detail}`,
        };
      }
      return { accept: true, run };
    }

    if (request.to === 'done') {
      const validity = assessEvidenceValidity(task, verification);
      if (!validity.valid) {
        return {
          accept: false,
          reason: validity.reason,
          detail: `Done requires current passing evidence bound to this task's requirements: ${validity.detail}`,
        };
      }
      if (!delivery) {
        return {
          accept: false,
          reason: 'delivery-pending',
          detail: `Done requires a recorded delivery for run ${run?.id || '(none)'}. Verified work alone does not complete a task.`,
        };
      }
      if (verification && delivery.deliveredCommit !== verification.revisionSha) {
        return {
          accept: false,
          reason: 'delivered-revision-mismatch',
          detail: `Delivered commit ${delivery.deliveredCommit} is not the verified revision ${verification.revisionSha}. Acceptance must resolve to the exact delivered content.`,
        };
      }
      if (task.requireApproval && delivery.approvalStatus !== 'approved') {
        return {
          accept: false,
          reason: 'approval-pending',
          detail: `Delivery approval is "${delivery.approvalStatus}"; Done requires an approved delivery.`,
        };
      }
      if (task.requireApproval && delivery.approvalStatus === 'approved') {
        // The approval flag alone is not evidence of consent: it must certify
        // the contract and revision being accepted now, otherwise an approval
        // granted for a superseded spec would authorize Done.
        const currency = assessApprovalCurrency({ task, delivery, verification });
        if (!currency.accepted) {
          return {
            accept: false,
            reason: currency.reason,
            detail: `Done requires an approval bound to the current requirements and evidence: ${currency.detail}`,
          };
        }
      }
      if (!request.viaDelivery && !DONE_ALLOWED_FROM.includes(status)) {
        return {
          accept: false,
          reason: 'transition-not-allowed',
          detail: `Manual Done transition requires status Review (got "${status}").`,
        };
      }
      return { accept: true, run };
    }

    if (request.to === 'in_progress') {
      if (!START_ALLOWED_FROM.includes(status)) {
        return { accept: false, reason: 'transition-not-allowed', detail: `Cannot start work from "${status}". Reopen the task first.` };
      }
      return { accept: true, run };
    }

    if (REOPEN_TARGETS.includes(request.to)) {
      return { accept: true, run };
    }

    return { accept: false, reason: 'unsupported-transition', detail: `Lifecycle service does not mediate transitions to "${request.to}".` };
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
