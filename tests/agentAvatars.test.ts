import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveCharacterRole,
  getCharacterRoleInfo,
  CHARACTER_AVATAR_ASSETS,
  CHARACTER_ROLE_DETAILS,
  CharacterRole,
} from '../src/lib/agentAvatars.ts';
import { test } from 'vitest';

test('agent avatar & role mapping suite', async () => {
console.log('=== RUNNING AGENT AVATAR & ROLE MAPPING TESTS ===\n');

// 1. Asset file verification
console.log('--- Part 1: Physical Asset Verification ---');
const assetsDir = path.resolve(process.cwd(), 'resources', 'agents');
const requiredFiles = [
  'coordinator.png',
  'planner.png',
  'coding-worker.png',
  'verifier.png',
  'reviewer.png',
  'delivery.png',
];

for (const file of requiredFiles) {
  const fullPath = path.join(assetsDir, file);
  assert.ok(fs.existsSync(fullPath), `Asset file must exist: ${file}`);
  const stats = fs.statSync(fullPath);
  assert.ok(stats.size > 100000, `Asset ${file} must have reasonable file size (found ${stats.size} bytes)`);
}
console.log('✔ [PASS] All 6 character avatar PNG assets exist and are non-empty');

// 2. Exact Application Roles in DEFAULT_AGENTS
console.log('\n--- Part 2: DEFAULT_AGENTS Mapping ---');
assert.strictEqual(
  resolveCharacterRole('Chief Orchestrator', 'Chief Orchestrator', 'agent-orch'),
  'coordinator',
  'Dupond Prime (Chief Orchestrator) must map to coordinator',
);

assert.strictEqual(
  resolveCharacterRole('Solutions Architect & Tech Lead', 'Solutions Architect', 'agent-arch'),
  'planner',
  'Nexus-7 (Solutions Architect & Tech Lead) must map to planner',
);

assert.strictEqual(
  resolveCharacterRole('Senior Frontend & UX Specialist', 'Frontend Engineer', 'agent-fe'),
  'coding-worker',
  'Lyra UI (Senior Frontend & UX Specialist) must map to coding-worker',
);

assert.strictEqual(
  resolveCharacterRole('Backend & Integrations Engineer', 'Backend Engineer', 'agent-be'),
  'coding-worker',
  'Kaelen Dev (Backend & Integrations Engineer) must map to coding-worker',
);

assert.strictEqual(
  resolveCharacterRole('SecOps & Quality Assurance Lead', 'QA & Security Analyst', 'agent-qa'),
  'verifier',
  'Valkyrie QA (SecOps & Quality Assurance Lead) must map to verifier',
);

assert.strictEqual(
  resolveCharacterRole('DevOps & Site Reliability Engineer', 'DevOps Engineer', 'agent-devops'),
  'delivery',
  'Atlas CI (DevOps & Site Reliability Engineer) must map to delivery',
);
console.log('✔ [PASS] All 6 DEFAULT_AGENTS map accurately to their approved character avatars');

// 3. Dynamic Roles from Real Workflow Telemetry
console.log('\n--- Part 3: Dynamic Role History & Workflow Mapping ---');
assert.strictEqual(resolveCharacterRole('System Orchestrator'), 'coordinator');
assert.strictEqual(resolveCharacterRole('Product & Scrum Scribe'), 'coordinator');
assert.strictEqual(resolveCharacterRole('Data Governance Lead'), 'planner');
assert.strictEqual(resolveCharacterRole('Design Systems Lead'), 'coding-worker');
assert.strictEqual(resolveCharacterRole('Integration Specialist'), 'coding-worker');
assert.strictEqual(resolveCharacterRole('Full-Stack Engineer'), 'coding-worker');
assert.strictEqual(resolveCharacterRole('Penetration Tester'), 'verifier');
assert.strictEqual(resolveCharacterRole('Authoritative Verifier'), 'verifier');
assert.strictEqual(resolveCharacterRole('QA Engineer'), 'verifier');
assert.strictEqual(resolveCharacterRole('Code Reviewer'), 'reviewer');
assert.strictEqual(resolveCharacterRole('Diff Auditor'), 'reviewer');
assert.strictEqual(resolveCharacterRole('Release Architect'), 'delivery');
assert.strictEqual(resolveCharacterRole('Release Specialist'), 'delivery');
console.log('✔ [PASS] Dynamic roles and workflow specialties map to correct archetypes');

// 4. Base Role Fallback
console.log('\n--- Part 4: Base Role Fallback ---');
// If current role is unmapped, fallback to baseRole
assert.strictEqual(
  resolveCharacterRole('Experimental Sub-Routine', 'Frontend Engineer'),
  'coding-worker',
  'Unrecognized dynamic role must fall back to valid baseRole',
);
assert.strictEqual(
  resolveCharacterRole('Temporary Standby', 'QA & Security Analyst'),
  'verifier',
  'Unrecognized dynamic role must fall back to QA baseRole',
);
console.log('✔ [PASS] Unrecognized dynamic role falls back to baseRole');

// 5. Agent ID Aliases
console.log('\n--- Part 5: Agent ID Aliases ---');
assert.strictEqual(resolveCharacterRole(null, null, 'agent-orch'), 'coordinator');
assert.strictEqual(resolveCharacterRole(null, null, 'agent-arch'), 'planner');
assert.strictEqual(resolveCharacterRole(null, null, 'agent-fe'), 'coding-worker');
assert.strictEqual(resolveCharacterRole(null, null, 'agent-be'), 'coding-worker');
assert.strictEqual(resolveCharacterRole(null, null, 'agent-qa'), 'verifier');
assert.strictEqual(resolveCharacterRole(null, null, 'agent-devops'), 'delivery');
console.log('✔ [PASS] Agent ID aliases resolve correctly when roles are absent');

// 6. Unknown Role Neutral Fallback
console.log('\n--- Part 6: Unknown Role Neutral Fallback ---');
assert.strictEqual(resolveCharacterRole('Unknown Persona'), 'unknown');
assert.strictEqual(resolveCharacterRole('External Oracle Bot'), 'unknown');
assert.strictEqual(resolveCharacterRole(''), 'unknown');
assert.strictEqual(resolveCharacterRole(null, null, null), 'unknown');
assert.strictEqual(resolveCharacterRole(undefined, undefined, undefined), 'unknown');

const unknownInfo = getCharacterRoleInfo('unknown');
assert.strictEqual(unknownInfo.character, 'unknown');
assert.strictEqual(unknownInfo.assetUrl, null, 'Unknown role must have null assetUrl for neutral icon fallback');
console.log('✔ [PASS] Unknown, empty, and null roles cleanly fall back to neutral "unknown"');

// 7. Role Details Metadata
console.log('\n--- Part 7: Role Details Metadata Integrity ---');
const roles: CharacterRole[] = [
  'coordinator',
  'planner',
  'coding-worker',
  'verifier',
  'reviewer',
  'delivery',
  'unknown',
];

for (const r of roles) {
  const details = CHARACTER_ROLE_DETAILS[r];
  assert.ok(details.title, `Role ${r} must have a title`);
  assert.ok(details.visualDescription, `Role ${r} must have a visual description`);
  assert.ok(details.defaultAlt, `Role ${r} must have default alt text`);
}
console.log('✔ [PASS] Role details metadata is complete and accessible');

console.log('\n===============================================================');
console.log('=== ALL AGENT AVATAR & ROLE MAPPING TESTS PASSED CLEANLY ===');
console.log('===============================================================');
});
