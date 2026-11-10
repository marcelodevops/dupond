/**
 * Explicit mapping between acceptance requirements (the authoritative contract
 * that evidence must prove) and ordinary checklist items (progress notes that
 * certify nothing). The board used to hold one mixed list, which let a checkbox
 * edit look like a requirements edit and let a requirements edit look like a
 * checkbox edit; these helpers keep the two kinds separate and make promotion
 * between them a deliberate operation.
 */

export interface AcceptanceCriterion {
  id: string;
  title: string;
  /** Progress only. Never used to decide acceptance. */
  completed?: boolean;
  /** The command that proves this requirement. */
  checkCommand?: string;
}

export interface ChecklistItem {
  id: string;
  title: string;
  completed?: boolean;
  checkCommand?: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Merge a criteria list posted by the board with the stored authoritative one.
 * The posted list owns *which* requirements exist — including owning the empty
 * list when the caller explicitly sent one — but each item inherits the stored
 * check command and completion state unless the caller supplied its own. An
 * edit that only rewords a title therefore cannot destroy the command that
 * proves it, and an omitted field is distinguishable from a cleared one.
 */
export function mergePostedCriteria(
  posted: readonly AcceptanceCriterion[],
  stored: readonly AcceptanceCriterion[],
): AcceptanceCriterion[] {
  const previousById = new Map(stored.map((c) => [String(c.id), c]));

  return posted.map((raw) => {
    const id = String(raw.id);
    const previous = previousById.get(id);
    const title = text(raw.title).trim() || text(previous?.title);

    const merged: AcceptanceCriterion = {
      id,
      title,
      completed: typeof raw.completed === 'boolean' ? raw.completed : Boolean(previous?.completed),
    };
    // An absent command inherits the stored one; an explicitly emptied string
    // is an edit that removes the check.
    const checkCommand = 'checkCommand' in raw && raw.checkCommand !== undefined
      ? text(raw.checkCommand)
      : text(previous?.checkCommand);
    if (checkCommand.trim()) merged.checkCommand = checkCommand;

    return merged;
  });
}

/**
 * Turn checklist rows into authoritative criteria. Only used for board entries
 * that predate the split and have no stored criteria at all, so their checkboxes
 * really were the requirements.
 */
export function promoteChecklistItems(items: readonly ChecklistItem[]): AcceptanceCriterion[] {
  return items.map((item) => {
    const criterion: AcceptanceCriterion = {
      id: String(item.id),
      title: text(item.title),
      completed: Boolean(item.completed),
    };
    if (text(item.checkCommand).trim()) criterion.checkCommand = text(item.checkCommand);
    return criterion;
  });
}

/**
 * Promote one checklist row into a requirement and return the new criteria
 * list. Ids are kept so the contract change is readable in the audit trail, and
 * the check command travels with the row when it already had one.
 */
export function withPromotedChecklistItem(
  criteria: readonly AcceptanceCriterion[],
  item: ChecklistItem,
): AcceptanceCriterion[] {
  const existingIds = criteria.map((c) => String(c.id));
  const baseId = String(item.id);
  const id = existingIds.includes(baseId) ? `req-${baseId}` : baseId;
  return [...criteria, ...promoteChecklistItems([{ ...item, id }])];
}

/**
 * A requirement with no check command can never be proven by the verifier, so
 * it must stay visibly uncovered instead of being satisfied by a tick.
 */
export function isAutomaticallyVerifiable(criterion: AcceptanceCriterion): boolean {
  return text(criterion.checkCommand).trim().length > 0;
}

export function uncoveredCriteria(
  criteria: readonly AcceptanceCriterion[],
  verifiedIds: readonly string[],
): string[] {
  const verified = new Set(verifiedIds);
  return criteria.filter((c) => !verified.has(String(c.id))).map((c) => String(c.id));
}
