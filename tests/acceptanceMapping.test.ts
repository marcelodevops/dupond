/**
 * The contract between the board's acceptance editor and the authoritative
 * store: requirements are the contract, checklist rows are progress, and the
 * mapping between them is explicit. These cases cover the shared helpers and
 * the rendered editor, because the defect being guarded against was exactly a
 * UI that looked like it was editing requirements while writing something else.
 */

import assert from 'assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';

test('acceptance mapping suite', async () => {
console.log('=== RUNNING ACCEPTANCE MAPPING SUITE ===\n');

const {
  mergePostedCriteria,
  promoteChecklistItems,
  withPromotedChecklistItem,
  isAutomaticallyVerifiable,
  uncoveredCriteria,
} = await import('../src/services/acceptanceMapping.js');
const { computeEvidenceBinding } = await import('../src/server/verification/evidenceBinding.js');

const CHECK = 'npm test';
const stored = [
  { id: 'c-add', title: 'add() sums', completed: false, checkCommand: CHECK },
  { id: 'c-div', title: 'div() divides', completed: true, checkCommand: 'node -e "1/1"' },
];

// Test 1: rewording a requirement keeps its check command
const reworded = mergePostedCriteria(
  stored.map((c) => ({ ...c, title: `${c.title} — clarified` })),
  stored,
);
assert.strictEqual(reworded.length, 2);
assert.strictEqual(reworded[0].checkCommand, CHECK, 'a title-only edit must not drop the proof');
assert.strictEqual(reworded[1].checkCommand, 'node -e "1/1"');
assert.strictEqual(reworded[0].title, 'add() sums — clarified');
console.log('✔ [PASS] Editing a requirement preserves its stored check command');

// Test 2: a requirement posted without a check command inherits the stored one,
// and an emptied command field is an explicit removal.
const barePost = mergePostedCriteria([{ id: 'c-add', title: 'add() sums' }], stored);
assert.strictEqual(barePost[0].checkCommand, CHECK, 'omitted field is not a clear');
const clearedPost = mergePostedCriteria([{ id: 'c-add', title: 'add() sums', checkCommand: '' }], stored);
assert.strictEqual(clearedPost[0].checkCommand, undefined, 'an emptied command field removes the check');
assert.strictEqual(isAutomaticallyVerifiable(clearedPost[0]), false, 'a checkless requirement is not verifiable');
console.log('✔ [PASS] Omitted vs cleared check commands are distinguished');

// Test 3: an explicitly empty list is a statement ("no requirements"); a newly
// added requirement is uncovered until something proves it.
assert.deepStrictEqual(mergePostedCriteria([], stored), [], 'empty posted list clears the contract');
const withNew = mergePostedCriteria([...stored, { id: 'c-ratio', title: 'ratio() exported' }], stored);
assert.strictEqual(withNew.length, 3);
assert.strictEqual(withNew[2].checkCommand, undefined, 'a new requirement has no proof yet');
assert.deepStrictEqual(uncoveredCriteria(withNew, ['c-add', 'c-div']), ['c-ratio']);
console.log('✔ [PASS] Explicit empty list clears; a new requirement stays uncovered');

// Test 4: promoting a checklist row makes it a requirement, carrying any check
// command it had and keeping ids stable and unique.
const promoted = withPromotedChecklistItem(stored, { id: 'st-1', title: 'handle empty input', completed: true, checkCommand: CHECK });
assert.strictEqual(promoted.length, 3);
assert.strictEqual(promoted[2].id, 'st-1');
assert.strictEqual(promoted[2].title, 'handle empty input');
assert.strictEqual(promoted[2].checkCommand, CHECK, 'the check travels with the row');
const colliding = withPromotedChecklistItem(stored, { id: 'c-add', title: 'duplicate id row' });
assert.strictEqual(colliding[2].id, 'req-c-add', 'a colliding id is not silently merged');
assert.deepStrictEqual(promoteChecklistItems([]), []);
console.log('✔ [PASS] Promoting a checklist row yields a real requirement with unique ids');

// Test 5: the requirement fingerprint is the contract — a checkbox tick, or a
// promotion without a check command, must not be able to certify acceptance,
// while a genuine requirement edit must be.
const baseline = computeEvidenceBinding({ description: 'spec', acceptanceCriteria: stored as any, verificationCommands: [CHECK], protectedPaths: [] });
const tickedOnly = computeEvidenceBinding({
  description: 'spec',
  acceptanceCriteria: stored.map((c) => ({ ...c, completed: true })) as any,
  verificationCommands: [CHECK],
  protectedPaths: [],
});
assert.strictEqual(tickedOnly.requirementsFingerprint, baseline.requirementsFingerprint, 'ticking a box changes no contract');
const rewordedBinding = computeEvidenceBinding({
  description: 'spec',
  acceptanceCriteria: reworded as any,
  verificationCommands: [CHECK],
  protectedPaths: [],
});
assert.notStrictEqual(rewordedBinding.requirementsFingerprint, baseline.requirementsFingerprint, 'rewording a requirement re-binds it');
console.log('✔ [PASS] Checkbox state never alters the requirements fingerprint');

// Test 6: the rendered editor shows two separate concerns, so an operator
// cannot mistake a progress tick for an acceptance decision.
(globalThis as any).fetch = async () => new Response('{}', { status: 200 });
const { TaskDetailModal } = await import('../src/components/TaskDetailModal.js');
const task: any = {
  id: 't-1',
  key: 'AEG-101',
  title: 'Evidence-bound task',
  description: 'Requirements must reach the authoritative contract',
  status: 'in_progress',
  priority: 'high',
  epicId: 'epic-1',
  assignedAgentId: '',
  estimatedHours: 1,
  spentHours: 0,
  dependencies: [],
  tags: [],
  deliverables: [],
  subtasks: [{ id: 'st-1', title: 'draft the module', completed: true }],
  acceptanceCriteria: stored,
};
const html = renderToStaticMarkup(createElement(TaskDetailModal, {
  task,
  onClose: () => {},
  onUpdateTask: () => {},
  agents: [],
  epics: [],
  allTasks: [task],
  onExecuteAgentOnTask: async () => {},
  isExecutingStep: false,
}));
assert.ok(html.includes('Acceptance Criteria'), 'the authoritative editor is rendered');
assert.ok(html.includes('add() sums'), 'stored requirements are shown, not checklist rows');
assert.ok(html.includes('node -e &quot;1/1&quot;'), 'the check command proving a requirement is visible');
assert.ok(html.includes('Checklist (progress only)'), 'progress rows are labelled as such');
assert.ok(!html.includes('Acceptance Criteria &amp; Subtasks'), 'the old mixed heading is gone');
console.log('✔ [PASS] The modal renders authoritative criteria separately from progress items');

console.log('\n=== ALL ACCEPTANCE MAPPING TESTS PASSED CLEANLY ===');
});
