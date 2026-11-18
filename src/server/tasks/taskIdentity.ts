import { Task } from '../../types/index.js';

export interface TaskIdentityConflictRecord {
  taskId: string;
  taskKey: string;
  detectedAt: string;
  variantCount: number;
  variants: Array<Record<string, unknown>>;
}

export interface TaskIdentityReconciliationResult {
  tasks: Task[];
  consolidated: Array<{ taskId: string; taskKey: string; duplicateCount: number }>;
  conflicts: TaskIdentityConflictRecord[];
  changed: boolean;
}

function sortValue(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortValue);
  if (val && typeof val === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      const v = (val as Record<string, unknown>)[key];
      if (v !== undefined) sorted[key] = sortValue(v);
    }
    return sorted;
  }
  return val;
}

function stripEphemeralFields(task: Task): Record<string, unknown> {
  const { lastUpdated: _lu, identityConflict: _ic, ...rest } = task as Task & Record<string, unknown>;
  return rest;
}

export function canonicalTaskSignature(task: Task): string {
  return JSON.stringify(sortValue(stripEphemeralFields(task)));
}

/**
 * Reconciles duplicate task IDs within a single project's board task list.
 * - Identical copies collapse deterministically into one logical task.
 * - Conflicting copies preserve all distinct variants on `identityConflict`
 *   without silently discarding fields or picking a winner.
 */
export function reconcileProjectTaskIdentity(tasks: Task[]): TaskIdentityReconciliationResult {
  const groups = new Map<string, Task[]>();
  const order: string[] = [];

  for (const task of tasks) {
    const id = task.id || task.key;
    if (!groups.has(id)) {
      groups.set(id, []);
      order.push(id);
    }
    groups.get(id)!.push(task);
  }

  const resultTasks: Task[] = [];
  const consolidated: Array<{ taskId: string; taskKey: string; duplicateCount: number }> = [];
  const conflicts: TaskIdentityConflictRecord[] = [];
  let changed = false;

  for (const id of order) {
    const group = groups.get(id)!;
    if (group.length === 1) {
      const single = group[0];
      if (single.identityConflict) {
        conflicts.push(single.identityConflict);
      }
      resultTasks.push(single);
      continue;
    }

    changed = true;
    const seen = new Map<string, Task>();
    for (const item of group) {
      if (item.identityConflict && Array.isArray(item.identityConflict.variants)) {
        for (const v of item.identityConflict.variants) {
          const vt = v as unknown as Task;
          const sig = canonicalTaskSignature(vt);
          if (!seen.has(sig)) seen.set(sig, vt);
        }
      }
      const sig = canonicalTaskSignature(item);
      if (!seen.has(sig)) seen.set(sig, item);
    }

    const uniqueVariants = Array.from(seen.values());
    if (uniqueVariants.length === 1) {
      const { identityConflict: _ic, ...clean } = uniqueVariants[0];
      resultTasks.push(clean as Task);
      consolidated.push({
        taskId: id,
        taskKey: clean.key || id,
        duplicateCount: group.length,
      });
    } else {
      const base = uniqueVariants[0];
      const conflict: TaskIdentityConflictRecord = {
        taskId: id,
        taskKey: base.key || id,
        detectedAt: base.identityConflict?.detectedAt || new Date().toISOString(),
        variantCount: uniqueVariants.length,
        variants: uniqueVariants.map((v) => stripEphemeralFields(v)),
      };
      conflicts.push(conflict);
      resultTasks.push({
        ...base,
        identityConflict: conflict,
      });
    }
  }

  return { tasks: resultTasks, consolidated, conflicts, changed };
}
