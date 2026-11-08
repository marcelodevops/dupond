import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  evaluateCiGate,
  waitUntilGreen,
  extractChangelogSection,
  findPolicyProblems,
  findVersionMismatches,
  findManifestProblems,
  isConventionalPrTitle,
  parseConventionalTitle,
  readManifestEntries,
  readReleasePolicy,
  readVersionSources,
  REQUIRED_WORKFLOWS,
} from '../scripts/release.ts';
import type { WorkflowRun } from '../scripts/release.ts';

// Synthetic fixtures, not real commits: the gate must separate two distinct SHAs and
// no test in this file reaches the GitHub API.
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    name: REQUIRED_WORKFLOWS[0],
    head_sha: SHA,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    html_url: 'https://github.com/acme/dupond/actions/runs/1',
    ...overrides,
  };
}

async function main() {
  console.log('=== RUNNING RELEASE POLICY, CI GATE & VERSION CONSISTENCY TESTS ===\n');

  // --------------------------------------------------------------------------
  // Part 1: the publish gate only accepts CI for the exact release commit
  // --------------------------------------------------------------------------
  console.log('--- Part 1: Required-CI publish gate ---');

  const green = evaluateCiGate([run()], SHA);
  assert.strictEqual(green.state, 'green', green.detail);
  console.log('✔ [PASS] Successful push CI on main for the release commit permits publishing');

  const otherSha = evaluateCiGate([run({ head_sha: OTHER_SHA })], SHA);
  assert.notStrictEqual(otherSha.state, 'green', 'A green run for a different commit must not authorize this one');
  const otherShaWait = waitUntilGreen(SHA, () => [run({ head_sha: OTHER_SHA })], REQUIRED_WORKFLOWS, 1, 0, () => {}, () => {});
  assert.strictEqual(otherShaWait.state, 'blocked', otherShaWait.detail);
  console.log('✔ [PASS] Green CI on a different commit does not authorize the release commit');

  const prRunOnly = evaluateCiGate([run({ event: 'pull_request' })], SHA);
  assert.notStrictEqual(prRunOnly.state, 'green', 'A pull_request run is not a publish credential for main');
  console.log('✔ [PASS] Pull-request run for the same SHA is not treated as main CI');

  const branchRun = evaluateCiGate([run({ head_branch: 'feat/other' })], SHA);
  assert.notStrictEqual(branchRun.state, 'green', 'Push CI on a branch other than main must not publish');
  console.log('✔ [PASS] Push CI outside main does not authorize publishing');

  const pending = evaluateCiGate([run({ status: 'in_progress', conclusion: null })], SHA);
  assert.strictEqual(pending.state, 'pending', pending.detail);
  console.log('✔ [PASS] In-progress CI reports pending rather than permission to publish');

  const failed = evaluateCiGate([run({ conclusion: 'failure' })], SHA);
  assert.strictEqual(failed.state, 'blocked', failed.detail);
  assert.ok(failed.detail.includes('concluded failure'), failed.detail);
  console.log('✔ [PASS] Failed required CI blocks publishing');

  // Retries reconcile: the newest attempt is the verdict, both directions.
  const retriedToGreen = evaluateCiGate(
    [run({ id: 10, conclusion: 'failure', run_attempt: 1 }), run({ id: 10, conclusion: 'success', run_attempt: 2 })],
    SHA,
  );
  assert.strictEqual(retriedToGreen.state, 'green', retriedToGreen.detail);
  const retriedToRed = evaluateCiGate(
    [run({ id: 10, conclusion: 'success', run_attempt: 1 }), run({ id: 11, conclusion: 'failure', run_attempt: 2 })],
    SHA,
  );
  assert.strictEqual(retriedToRed.state, 'blocked', 'A later failing attempt supersedes an earlier success');
  console.log('✔ [PASS] Re-runs reconcile to the newest attempt in both directions');

  const neverRan = evaluateCiGate([], SHA);
  assert.strictEqual(neverRan.state, 'pending', 'A missing run may still be queued');
  assert.ok(neverRan.detail.includes('no main-branch push run found yet'), neverRan.detail);
  assert.ok(neverRan.detail.includes('GitHub Actions token'), 'Must name the token restriction explicitly');
  console.log('✔ [PASS] Missing CI run explains the Actions-token restriction');

  // --------------------------------------------------------------------------
  // Part 2: the gate waits for CI instead of failing early, then stops waiting
  // --------------------------------------------------------------------------
  console.log('\n--- Part 2: Bounded waiting (no network) ---');

  const calls: number[] = [];
  const slept: number[] = [];
  const fakeSleep = (ms: number) => {
    slept.push(ms);
  };
  const fetched = waitUntilGreen(
    SHA,
    () => {
      calls.push(calls.length + 1);
      return calls.length < 2 ? [run({ status: 'in_progress', conclusion: null })] : [run()];
    },
    REQUIRED_WORKFLOWS,
    60,
    5,
    fakeSleep,
    () => {},
  );
  assert.strictEqual(fetched.state, 'green', fetched.detail);
  assert.strictEqual(fetched.runIds.length, 1);
  assert.strictEqual(calls.length, 2, 'gate must re-poll instead of giving up on the first pending answer');
  assert.deepStrictEqual(slept, [5000]);
  console.log(`✔ [PASS] Gate polls until required CI turns green (${calls.length} fetches, ${slept.length} waits)`);

  const timedOut = waitUntilGreen(
    SHA,
    () => [run({ status: 'in_progress', conclusion: null })],
    REQUIRED_WORKFLOWS,
    1,
    0,
    () => {},
    () => {},
  );
  assert.strictEqual(timedOut.state, 'blocked', 'A CI run that never finishes must not publish');
  assert.ok(timedOut.detail.includes('Timed out'), timedOut.detail);
  console.log('✔ [PASS] Timeout while CI is pending blocks publishing');

  const earlyFail = waitUntilGreen(
    SHA,
    () => [run({ conclusion: 'cancelled' })],
    REQUIRED_WORKFLOWS,
    60,
    5,
    () => {
      throw new Error('must not sleep once CI is conclusively not green');
    },
    () => {},
  );
  assert.strictEqual(earlyFail.state, 'blocked', earlyFail.detail);
  console.log('✔ [PASS] Definitive non-success returns immediately without waiting');

  // --------------------------------------------------------------------------
  // Part 3: version metadata and release policy agree in this repository
  // --------------------------------------------------------------------------
  console.log('\n--- Part 3: Version metadata and release policy ---');

  const repoRoot = process.cwd();
  const realSources = readVersionSources(repoRoot);
  assert.strictEqual(realSources.packageJson, realSources.manifest, 'package.json and the Release Please manifest must agree');
  assert.deepStrictEqual(findVersionMismatches(realSources), [], `version metadata drifted: ${JSON.stringify(realSources)}`);
  assert.deepStrictEqual(findPolicyProblems(readReleasePolicy(repoRoot)), [], 'shipped release policy is invalid');
  // Every manifest key is read as a path and every value as a version, so editor
  // metadata would abort the release run.
  assert.deepStrictEqual(readManifestEntries(repoRoot), [{ path: '.', version: realSources.packageJson as string }]);
  assert.deepStrictEqual(findManifestProblems(readManifestEntries(repoRoot)), [], 'shipped manifest keys are not Release Please paths');
  // The baseline must be the commit that first carried 0.1.0, otherwise commits
  // from before the experimental release would be counted into the next one.
  assert.strictEqual(
    readReleasePolicy(repoRoot).bootstrapSha,
    'bd3726ade06a4f60e9964d087f83e9bf25bfa572',
    'bootstrap-sha must be the v0.1.0 preparation commit',
  );
  assert.deepStrictEqual(
    findManifestProblems([
      { path: '$schema', version: 'https://example.invalid/manifest.json' },
      { path: '', version: '0.1.0' },
      { path: '.', version: 'next' },
    ]).length,
    3,
    'metadata keys, empty paths and non-semver values must all be refused',
  );
  console.log(`✔ [PASS] package.json, package-lock.json and manifest all agree on ${realSources.packageJson}`);
  console.log('✔ [PASS] Shipped release policy keeps pre-1.0 breaking changes on minor bumps and releases prerelease');

  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp_release_')));
  try {
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'x', version: '0.3.0' }));
    fs.writeFileSync(path.join(tmpRoot, 'package-lock.json'), JSON.stringify({ version: '0.3.0', lockfileVersion: 3, packages: { '': { version: '0.2.9' } } }));
    fs.writeFileSync(path.join(tmpRoot, '.release-please-manifest.json'), JSON.stringify({ '.': '0.3.0' }));
    fs.writeFileSync(path.join(tmpRoot, 'release-please-config.json'), JSON.stringify({ 'release-type': 'python', 'bump-minor-pre-major': false, prerelease: false, 'include-v-in-tag': false }));
    const mismatched = findVersionMismatches(readVersionSources(tmpRoot));
    assert.ok(mismatched.some((problem) => problem.includes('packages[""].version')), mismatched.join('\n'));
    const policyProblems = findPolicyProblems(readReleasePolicy(tmpRoot));
    assert.strictEqual(policyProblems.length, 5, policyProblems.join('\n'));
    assert.ok(
      policyProblems.some((problem) => problem.includes('bootstrap-sha')),
      'An unpinned bootstrap baseline would let the automation release all of history',
    );
    console.log('✔ [PASS] Lockfile root-package drift and unsafe policy flags are both refused');

    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'x', version: 'not-a-version' }));
    assert.ok(
      findVersionMismatches(readVersionSources(tmpRoot)).some((problem) => problem.includes('not a semantic version')),
      'Non-semver version strings must be rejected',
    );
    console.log('✔ [PASS] Non-semver version metadata is rejected');

    fs.rmSync(path.join(tmpRoot, 'package-lock.json'));
    assert.ok(
      findVersionMismatches(readVersionSources(tmpRoot)).some((problem) => problem.includes('file missing')),
      'A missing lockfile must be reported, not silently skipped',
    );
    console.log('✔ [PASS] Missing version file fails closed instead of passing silently');

    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'x', version: '0.3.0' }));
    fs.writeFileSync(path.join(tmpRoot, 'package-lock.json'), JSON.stringify({ version: '0.3.0', lockfileVersion: 3, packages: {} }));
    assert.ok(
      findVersionMismatches(readVersionSources(tmpRoot)).some((problem) => problem.includes('version field missing')),
      'A lockfile without a root package version must be reported',
    );
    console.log('✔ [PASS] Version field absent from a present file is reported separately');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // --------------------------------------------------------------------------
  // Part 4: squash-merge titles that drive release decisions
  // --------------------------------------------------------------------------
  console.log('\n--- Part 4: Conventional Commits titles ---');

  for (const title of [
    'feat: add repair feedback loop',
    'fix(delivery): bind push to persisted target',
    'feat!: drop legacy worker adapter',
    'chore: release 0.2.0',
    'chore(main): release 0.2.0',
    'docs(releasing): clarify pre-1.0 bumps',
  ]) {
    assert.ok(isConventionalPrTitle(title), `expected to pass: ${title}`);
  }
  // Release Please opens its own PRs with these titles; the title gate must not
  // block the tool that decides versions.
  const rpTitle = parseConventionalTitle('chore: release 0.2.0');
  assert.ok(rpTitle);
  assert.strictEqual(rpTitle!.type, 'chore');
  assert.strictEqual(rpTitle!.description, 'release 0.2.0');
  console.log('✔ [PASS] Conventional titles pass, including Release Please pull request titles');

  for (const title of [
    'Update readme',
    'WIP',
    'feat:no space after colon',
    'feature: add thing',
    'FEAT: shouty',
    'feat: ',
    '',
    'fix(scope)!: ',
  ]) {
    assert.ok(!isConventionalPrTitle(title), `expected to be refused: ${JSON.stringify(title)}`);
  }
  console.log('✔ [PASS] Free-form titles that would produce no version bump are refused');

  // --------------------------------------------------------------------------
  // Part 5: release notes come from the changelog that ships in the repository
  // --------------------------------------------------------------------------
  console.log('\n--- Part 5: Changelog note extraction ---');

  const notes = extractChangelogSection(fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf-8'), '0.1.0');
  assert.ok(notes.includes('Experimental'), 'v0.1.0 notes must preserve the experimental framing');
  assert.ok(notes.includes('Demonstration evidence'), 'v0.1.0 notes must keep the demonstration evidence');
  assert.ok(notes.includes('Scope and limitations'), 'v0.1.0 notes must keep the known limitations');
  assert.ok(!notes.includes('## 0.1.0'), 'section body must not repeat its own heading');
  console.log('✔ [PASS] v0.1.0 release notes extract truthfully from CHANGELOG.md');

  const stacked = extractChangelogSection(
    [
      '# Changelog',
      '',
      '## 0.2.0',
      '### Features',
      '- newer thing',
      '',
      '## 0.1.0',
      '### Included',
      '- older thing',
      '',
      '### Limitations',
      '- still experimental',
    ].join('\n'),
    '0.1.0',
  );
  assert.ok(stacked.includes('older thing') && stacked.includes('still experimental'), stacked);
  assert.ok(!stacked.includes('newer thing'), 'must stop at the next version heading');
  assert.strictEqual(extractChangelogSection('# Changelog\n\n## 0.1.0\n\nx\n', '9.9.9'), '', 'unknown version yields no notes');
  console.log('✔ [PASS] Extraction stops at the next version and never fabricates notes');

  console.log('\n=== ALL RELEASE AUTOMATION TESTS PASSED ===');
}

main().catch((err) => {
  console.error('Release automation test failed:', err);
  process.exit(1);
});
