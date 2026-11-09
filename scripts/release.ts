import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type RunsFetcher = (sha: string) => WorkflowRun[];

export interface WorkflowRun {
  id: number;
  name: string;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  html_url: string;
}

export type GateState = 'green' | 'pending' | 'blocked';

export interface GateVerdict {
  state: GateState;
  sha: string;
  detail: string;
  runIds: number[];
}

export interface VersionSources {
  packageJson?: string | null;
  packageLock?: string | null;
  packageLockRootPackage?: string | null;
  manifest?: string | null;
}

export interface ReleasePolicy {
  releaseType?: string;
  bumpMinorPreMajor?: boolean;
  bumpPatchForMinorPreMajor?: boolean;
  prerelease?: boolean;
  prereleaseType?: string;
  includeVInTag?: boolean;
  includeComponentInTag?: boolean;
  changelogPath?: string;
  bootstrapSha?: string;
}

export const REQUIRED_WORKFLOWS = ['Dupond Continuous Integration'];
export const PUBLISHED_BRANCH = 'main';

const PENDING_STATUSES = ['queued', 'requested', 'in_progress', 'waiting', 'pending'];
const SUCCESS_CONCLUSIONS = ['success'];

function sameSha(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Newest attempt first: a re-run supersedes the verdict of the attempt before it.
 */
function newestRun(runs: WorkflowRun[]): WorkflowRun {
  return runs.reduce((best, run) =>
    run.run_attempt > best.run_attempt || (run.run_attempt === best.run_attempt && run.id > best.id) ? run : best
  );
}

/**
 * Decides whether the exact commit that would be tagged has verified CI on main.
 * Only a push run against main for this SHA counts; a pull_request run on the same
 * SHA was evaluated against a different base and is not a publish credential.
 */
export function evaluateCiGate(
  runs: WorkflowRun[],
  sha: string,
  requiredWorkflows: string[] = REQUIRED_WORKFLOWS,
): GateVerdict {
  const candidates = runs.filter(
    (run) =>
      sameSha(run.head_sha, sha) &&
      run.event === 'push' &&
      run.head_branch === PUBLISHED_BRANCH &&
      requiredWorkflows.includes(run.name),
  );

  const pending: string[] = [];
  const failures: string[] = [];
  const missing: string[] = [];
  const matched: number[] = [];

  for (const workflow of requiredWorkflows) {
    const forWorkflow = candidates.filter((run) => run.name === workflow);
    if (forWorkflow.length === 0) {
      missing.push(workflow);
      continue;
    }
    const latest = newestRun(forWorkflow);
    if (PENDING_STATUSES.includes(latest.status)) {
      pending.push(`${workflow} run ${latest.id} is ${latest.status}`);
      continue;
    }
    if (latest.conclusion && SUCCESS_CONCLUSIONS.includes(latest.conclusion)) {
      matched.push(latest.id);
      continue;
    }
    failures.push(`${workflow} run ${latest.id} concluded ${latest.conclusion}`);
  }

  if (failures.length > 0) {
    return {
      state: 'blocked',
      sha,
      detail: `Required CI did not pass for ${sha}: ${failures.join('; ')}.`,
      runIds: matched,
    };
  }

  if (pending.length > 0 || missing.length > 0) {
    const parts = [...pending];
    if (missing.length > 0) {
      parts.push(`no main-branch push run found yet for ${missing.join(', ')}`);
      parts.push(
        'if this commit landed through a GitHub Actions token, that push intentionally triggers no workflows; verify CI manually or push the commit through a human account before publishing',
      );
    }
    return { state: 'pending', sha, detail: `Still waiting on required CI for ${sha}: ${parts.join('; ')}.`, runIds: matched };
  }

  return {
    state: 'green',
    sha,
    detail: `Required CI passed for ${sha} (runs ${matched.join(', ')}).`,
    runIds: matched,
  };
}

function readJsonFile(filePath: string): any | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function readVersionSources(repoRoot: string): VersionSources {
  const pkg = readJsonFile(path.join(repoRoot, 'package.json'));
  const lock = readJsonFile(path.join(repoRoot, 'package-lock.json'));
  const manifest = readJsonFile(path.join(repoRoot, '.release-please-manifest.json'));
  // undefined: the file itself is absent. null: the file exists but does not declare a version.
  const field = (json: any, read: (value: any) => string | undefined): string | null | undefined =>
    json === undefined ? undefined : read(json) ?? null;
  return {
    packageJson: field(pkg, (value) => value.version),
    packageLock: field(lock, (value) => value.version),
    packageLockRootPackage: field(lock, (value) => value.packages?.['']?.version),
    manifest: field(manifest, (value) => value['.']),
  };
}

export interface ManifestEntry {
  path: string;
  version: string;
}

export function readManifestEntries(repoRoot: string): ManifestEntry[] {
  const manifest = readJsonFile(path.join(repoRoot, '.release-please-manifest.json')) ?? {};
  return Object.entries(manifest).map(([key, value]) => ({ path: key, version: String(value) }));
}

/**
 * Release Please treats every manifest key as a repository path and every value as
 * a version, so a documentation key such as "$schema" aborts the whole run.
 */
export function findManifestProblems(entries: ManifestEntry[]): string[] {
  return entries
    .filter((entry) => entry.path.startsWith('$') || entry.path === '' || !SEMVER.test(entry.version))
    .map((entry) => `manifest entry "${entry.path}" must be a repository path mapped to a semantic version`);
}

export function readReleasePolicy(repoRoot: string): ReleasePolicy {
  const config = readJsonFile(path.join(repoRoot, 'release-please-config.json')) ?? {};
  const rootPackage = config.packages?.['.'] ?? {};
  const pick = (key: string) => rootPackage[key] ?? config[key];
  return {
    releaseType: pick('release-type'),
    bumpMinorPreMajor: pick('bump-minor-pre-major'),
    bumpPatchForMinorPreMajor: pick('bump-patch-for-minor-pre-major'),
    prerelease: pick('prerelease'),
    prereleaseType: pick('prerelease-type'),
    includeVInTag: pick('include-v-in-tag'),
    includeComponentInTag: pick('include-component-in-tag'),
    changelogPath: pick('changelog-path'),
    bootstrapSha: config['bootstrap-sha'],
  };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Version metadata must agree everywhere, otherwise the tag, the changelog and the
 * published release describe different builds.
 */
export function findVersionMismatches(sources: VersionSources): string[] {
  const problems: string[] = [];
  const entries: Array<[string, string | null | undefined]> = [
    ['package.json', sources.packageJson],
    ['package-lock.json (root version)', sources.packageLock],
    ['package-lock.json (packages[""].version)', sources.packageLockRootPackage],
    ['.release-please-manifest.json', sources.manifest],
  ];

  for (const [label, value] of entries) {
    if (value === undefined) problems.push(`${label}: file missing or unreadable`);
    else if (value === null) problems.push(`${label}: version field missing`);
    else if (!SEMVER.test(value)) problems.push(`${label}: "${value}" is not a semantic version`);
  }
  if (problems.length > 0) return problems;

  const reference = sources.packageJson as string;
  for (const [label, value] of entries) {
    if (value !== reference) problems.push(`${label}: "${value}" disagrees with package.json "${reference}"`);
  }
  return problems;
}

/**
 * Pre-1.0 policy: breaking changes bump the minor, releases stay marked prerelease,
 * and tags keep the leading "v".
 */
export function findPolicyProblems(policy: ReleasePolicy): string[] {
  const problems: string[] = [];
  if (policy.releaseType !== 'node') problems.push(`release-type must be "node", got "${policy.releaseType}"`);
  if (policy.bumpMinorPreMajor !== true) problems.push('bump-minor-pre-major must be true so pre-1.0 breaking changes bump the minor');
  if (policy.bumpPatchForMinorPreMajor === true) problems.push('bump-patch-for-minor-pre-major must not be true: minor bumps would be downgraded to patches');
  if (policy.prerelease !== true) problems.push('prerelease must be true while the product is experimental (major version 0)');
  if (policy.includeVInTag === false) problems.push('include-v-in-tag must stay true so tags are v0.1.0, not 0.1.0');
  // Unset is not safe: strategies/base.ts defaults this to true, so Release Please
  // would tag dupond-orchestrator-v0.2.0 while the manifest and finder use v0.1.0.
  if (policy.includeComponentInTag !== false) problems.push('include-component-in-tag must be set false, otherwise Release Please tags <component>-vX.Y.Z instead of vX.Y.Z');
  if (policy.changelogPath && policy.changelogPath !== 'CHANGELOG.md') problems.push(`changelog-path must be CHANGELOG.md, got "${policy.changelogPath}"`);
  // Before the first tag exists, Release Please would otherwise scan the entire
  // repository history and claim every past commit for the next release.
  if (!/^[0-9a-f]{40}$/.test(policy.bootstrapSha ?? '')) problems.push('bootstrap-sha must pin the full 40-character baseline commit');
  return problems;
}

export const CONVENTIONAL_TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert'];

const TITLE_PATTERN = /^([a-z]+)(?:\(([^()]*)\))?(!)?:[ \t]+(\S.*)$/;

export interface ParsedTitle {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
}

export function parseConventionalTitle(title: string): ParsedTitle | null {
  const match = TITLE_PATTERN.exec(title.trim());
  if (!match) return null;
  const [, type, scope, breakingMark, description] = match;
  if (!CONVENTIONAL_TYPES.includes(type)) return null;
  if (scope !== undefined && scope.trim() === '') return null;
  if (description.trim() === '') return null;
  return { type, scope: scope?.trim() || undefined, breaking: breakingMark === '!', description: description.trim() };
}

export function isConventionalPrTitle(title: string): boolean {
  return parseConventionalTitle(title) !== null;
}

const FALLBACK_EXAMPLE_TITLE = 'fix(release): gate publishing on the exact commit SHA';
const BRANCH_STYLE_TITLE = /^([a-zA-Z]+)[\/\s_-]+(\S.*)$/;
const NEAR_MISS_TITLE = /^([a-zA-Z]+)(?:\(([^()]*)\))?(!)?:[ \t]*(\S.*)$/;

export function suggestConventionalTitle(title: string): string {
  const trimmed = title.trim();
  if (isConventionalPrTitle(trimmed)) return trimmed;
  const nearMiss = NEAR_MISS_TITLE.exec(trimmed);
  if (nearMiss && CONVENTIONAL_TYPES.includes(nearMiss[1].toLowerCase())) {
    const [, type, scope, breaking, description] = nearMiss;
    return `${type.toLowerCase()}${scope ? `(${scope})` : ''}${breaking ?? ''}: ${description.trim()}`;
  }
  const match = BRANCH_STYLE_TITLE.exec(trimmed);
  const type = match?.[1].toLowerCase() ?? '';
  if (!CONVENTIONAL_TYPES.includes(type)) return FALLBACK_EXAMPLE_TITLE;
  return `${type}: ${match![2]}`;
}

/**
 * Pull the notes for one released version out of CHANGELOG.md. Used to publish the
 * experimental v0.1.0 notes written by hand instead of inventing new ones.
 */
export function extractChangelogSection(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const wanted = version.replace(/^v/, '');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^##+\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(lines[i]);
    if (!heading) continue;
    if (start === -1) {
      if (heading[1] === wanted) start = i + 1;
      continue;
    }
    return lines.slice(start, i).join('\n').trim();
  }
  if (start === -1) return '';
  return lines.slice(start).join('\n').trim();
}

function normalizeRepoSlugFromOrigin(): string {
  const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf-8' }).trim();
  const ssh = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!ssh) throw new Error(`Could not derive owner/repo from origin "${url}"`);
  return ssh[1];
}

export function defaultRepo(): string {
  return process.env.GITHUB_REPOSITORY || normalizeRepoSlugFromOrigin();
}

export function fetchWorkflowRunsViaGh(sha: string, repo: string): WorkflowRun[] {
  const stdout = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
      '--jq',
      '.workflow_runs[] | {id,name,head_sha,head_branch,event,status,conclusion,run_attempt,html_url}',
    ],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WorkflowRun);
  return parsed.filter((run) => sameSha(run.head_sha, sha));
}

export interface ReleaseRecord {
  id: number;
  tag_name: string;
  name?: string | null;
  commit_id?: string | null;
}

export interface ReleaseMetadataPatch {
  id: number;
  tag: string;
  fields: Record<string, string>;
  reasons: string[];
}

export const RELEASE_TITLE_PREFIX = 'Dupond';
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// A release must carry a human title and the commit its tag actually points at.
// Titles an author wrote by hand are never overwritten, and a tag that cannot be
// resolved is left alone rather than guessed.
export function planReleaseMetadata(
  releases: ReleaseRecord[],
  resolveTagCommit: (tag: string) => string | null,
): ReleaseMetadataPatch[] {
  const patches: ReleaseMetadataPatch[] = [];
  for (const release of releases) {
    if (!SEMVER_TAG.test(release.tag_name)) continue;
    const fields: Record<string, string> = {};
    const reasons: string[] = [];
    const title = (release.name ?? '').trim();
    if (title === release.tag_name || title === '') {
      fields.name = `${RELEASE_TITLE_PREFIX} ${release.tag_name}`;
      reasons.push('untitled release gets the Dupond prefix');
    }
    if (!release.commit_id) {
      const sha = resolveTagCommit(release.tag_name);
      if (sha) {
        fields.target_commitish = sha;
        reasons.push('no commit recorded, so the tag is resolved explicitly');
      }
    }
    if (Object.keys(fields).length > 0) {
      patches.push({ id: release.id, tag: release.tag_name, fields, reasons });
    }
  }
  return patches;
}

export function fetchReleasesViaGh(repo: string): ReleaseRecord[] {
  const stdout = execFileSync(
    'gh',
    ['api', '--paginate', `/repos/${repo}/releases?per_page=100`, '--jq', '.[] | {id,tag_name,name,commit_id}'],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReleaseRecord);
}

// GitHub dereferences annotated tags here, so this returns the commit a tag points
// at rather than the tag object itself.
export function resolveTagCommitViaGh(tag: string, repo: string): string | null {
  if (!SEMVER_TAG.test(tag)) return null;
  try {
    const stdout = execFileSync('gh', ['api', `/repos/${repo}/commits/${encodeURIComponent(tag)}`, '--jq', '.sha'], {
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function patchReleaseMetadataViaGh(id: number, repo: string, fields: Record<string, string>): void {
  const args = ['api', '-X', 'PATCH', `/repos/${repo}/releases/${id}`];
  for (const [key, value] of Object.entries(fields)) args.push('-f', `${key}=${value}`);
  execFileSync('gh', args, { encoding: 'utf-8', stdio: 'pipe' });
}

interface CliArgs {
  command: string;
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): CliArgs {
  const [command = 'consistency', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags };
}

export function waitUntilGreen(
  sha: string,
  fetchRuns: RunsFetcher,
  required: string[],
  timeoutSeconds: number,
  intervalSeconds: number,
  sleep: (ms: number) => void,
  log: (message: string) => void,
): GateVerdict {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let verdict = evaluateCiGate(fetchRuns(sha), sha, required);
  while (verdict.state === 'pending' && Date.now() < deadline) {
    log(`[gate] ${verdict.detail}`);
    sleep(intervalSeconds * 1000);
    verdict = evaluateCiGate(fetchRuns(sha), sha, required);
  }
  if (verdict.state === 'pending') {
    verdict = { ...verdict, state: 'blocked', detail: `Timed out after ${timeoutSeconds}s waiting for required CI on ${sha}: ${verdict.detail}` };
  }
  return verdict;
}

export function main(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): number {
  const { command, flags } = parseArgs(argv);

  if (command === 'consistency') {
    const problems = [
      ...findVersionMismatches(readVersionSources(cwd)),
      ...findManifestProblems(readManifestEntries(cwd)),
      ...findPolicyProblems(readReleasePolicy(cwd)),
    ];
    if (problems.length > 0) {
      console.error('[release] version/policy problems:\n- ' + problems.join('\n- '));
      return 1;
    }
    console.log(`[release] version metadata and release policy are consistent (${readVersionSources(cwd).packageJson})`);
    return 0;
  }

  if (command === 'pr-title') {
    const title = String(flags.title ?? process.env.PR_TITLE ?? '');
    if (!title) {
      console.error('[release] pr-title requires --title or PR_TITLE');
      return 2;
    }
    if (isConventionalPrTitle(title)) {
      console.log(`[release] title follows Conventional Commits: ${title}`);
      return 0;
    }
    console.error(
      `[release] title is not Conventional Commits and would be invisible to release automation: ${title}\n` +
        `        expected one of: ${CONVENTIONAL_TYPES.join(', ')}(<scope>)?(!)?: description\n` +
        `        example: ${suggestConventionalTitle(title)}`,
    );
    return 1;
  }

  if (command === 'notes') {
    const version = String(flags.version ?? '');
    if (!version) {
      console.error('[release] notes requires --version');
      return 2;
    }
    const changelog = fs.readFileSync(path.join(cwd, String(flags.in ?? 'CHANGELOG.md')), 'utf-8');
    const section = extractChangelogSection(changelog, version);
    if (!section) {
      console.error(`[release] CHANGELOG.md has no section for ${version}`);
      return 1;
    }
    if (typeof flags.out === 'string') {
      fs.writeFileSync(flags.out, section + '\n');
      console.log(`[release] wrote ${version} release notes to ${flags.out}`);
      return 0;
    }
    process.stdout.write(section + '\n');
    return 0;
  }

  if (command === 'gate') {
    const sha = String(flags.sha ?? '');
    if (!sha) {
      console.error('[release] gate requires --sha');
      return 2;
    }
    const repo = typeof flags.repo === 'string' ? flags.repo : defaultRepo();
    const timeoutSeconds = Number(flags.timeout ?? 1800);
    const intervalSeconds = Number(flags.interval ?? 30);
    const fetcher: RunsFetcher = (target) => fetchWorkflowRunsViaGh(target, repo);
    const verdict = flags.wait
      ? waitUntilGreen(sha, fetcher, REQUIRED_WORKFLOWS, timeoutSeconds, intervalSeconds, (ms) => {
          execFileSync('sleep', [String(Math.ceil(ms / 1000))], { stdio: 'ignore' });
        }, (message) => console.log(message))
      : evaluateCiGate(fetcher(sha), sha, REQUIRED_WORKFLOWS);
    console.log(`[gate] ${verdict.state}: ${verdict.detail}`);
    return verdict.state === 'green' ? 0 : 1;
  }

  if (command === 'hygiene') {
    const repo = typeof flags.repo === 'string' ? flags.repo : defaultRepo();
    const patches = planReleaseMetadata(fetchReleasesViaGh(repo), (tag) => resolveTagCommitViaGh(tag, repo));
    if (patches.length === 0) {
      console.log('[hygiene] every release already has a title and a recorded commit');
      return 0;
    }
    for (const patch of patches) {
      console.log(`[hygiene] ${patch.tag} (release ${patch.id}): ${patch.reasons.join('; ')}`);
      if (flags.apply === true) patchReleaseMetadataViaGh(patch.id, repo, patch.fields);
    }
    if (flags.apply !== true) console.log('[hygiene] dry run: pass --apply to write');
    return 0;
  }

  console.error(`[release] unknown command "${command}" (expected: consistency, gate, hygiene, notes, pr-title)`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
