# Releasing Dupond

Dupond uses Semantic Versioning 2.0.0 with Conventional Commits, and one release
mechanism: [Release Please](https://github.com/googleapis/release-please)
(`googleapis/release-please-action@v5`). Do not add changesets, standard-version,
semantic-release, or hand-written bump commits alongside it; competing tools
disagree about which version is next and produce duplicate tags.

## Ownership

| Concern | Authority |
| --- | --- |
| Next version, CHANGELOG entries, tag, GitHub release | Release Please (`release-please-config.json`, `.release-please-manifest.json`) |
| Version strings in `package.json` / `package-lock.json` | Release Please's `node` release type (it updates both, including `packages[""].version`) |
| Whether a commit may be tagged | `.github/workflows/release.yml` → `ci-gate` job → `scripts/release.ts gate` |
| Commit classification | PR title check (`.github/workflows/pr-title.yml`) |

Never hand-edit the version in `package.json`, `package-lock.json`, or
`.release-please-manifest.json`. If they disagree, `npm run release:check` fails
and CI blocks the release PR.

`.release-please-manifest.json` must contain nothing but `"path": "version"` pairs.
Release Please parses every key as a repository path and every value as a version,
so an editor hint such as `"$schema"` aborts the run with `unable to parse version
string`; that is why the shipped manifest has no `$schema` key even though its JSON
schema file is published. `release-please-config.json` does accept `$schema`.

## Version policy

The rules below are what release-please 17 actually does, verified against its
source (`strategies/node.ts`, `versioning-strategies/default.ts`,
`util/filter-commits.ts`) rather than assumed from its documentation.

* `feat:` → minor bump, listed under *Features*.
* `fix:`, `perf:`, `revert:` → patch bump, listed under their own sections.
* Breaking change (`feat!:` / `fix!:` / a `BREAKING CHANGE:` footer) → **minor**
  bump while major is `0`, because `bump-minor-pre-major: true`; at 1.0.0 and above
  the same commit becomes a major bump. Flipping major to `1` is the maintainer's
  declaration that Dupond is no longer experimental, and it is recorded in the
  release PR that does it.
* `chore:`, `ci:`, `docs:`, `style:`, `refactor:`, `test:`, `build:` are *hidden*:
  they never appear in the changelog, **but they still produce a patch bump** if no
  breaking or feature commit is in range. Release Please only skips a release when
  there are zero commits after the last tag. So a chore-only merge still opens a
  `0.1.1`-style release PR; if that is not wanted yet, leave the PR open (it keeps
  being updated and folds in the next change) or add the `autorelease: snooze`
  label to postpone it.
* A hidden type that carries a `BREAKING CHANGE:` footer is still counted, so
  never use `docs!:` casually.
* To force an exact version for one cycle, add a `RELEASE AS: 1.0.0` note to the
  commit that should decide it, or set/pass `release-as`. The chosen version is
  written back to `.release-please-manifest.json`.
* Every release is published as a GitHub **prerelease** while major is `0`, via
  `prerelease: true`. `prerelease-type` is deliberately unset so versions remain
  `0.2.0` rather than `0.2.0-beta.1`.
* `bump-patch-for-minor-pre-major` stays `false`: a `feat:` must not be downgraded
  to a patch.
* `bootstrap-sha` is pinned to `bd3726a`, the commit that first carried `0.1.0`.
  Without it, the first run would find no tag, walk up to 250 commits of repository
  history, and offer to release all of it as one version with a rewritten changelog.

* Tag names stay `vX.Y.Z`: `include-component-in-tag` is set to `false`
  explicitly. Left out, release-please defaults it to `true` (`strategies/base.ts`,
  `options.includeComponentInTag ?? true`) and tags `dupond-orchestrator-vX.Y.Z`,
  while the release *finder* only matches a component-free tag — so automation would
  never recognize the release it just made. This was observed: the first candidate
  PR linked its comparison as `dupond-orchestrator-v0.1.0`, a ref that does not exist.

Dupond merges PRs with **merge commits**, and the merge commit's own subject
(`Merge pull request #10 from …`) is not a Conventional Commit at all — release-please
logs `commit could not be parsed` for it. The version therefore comes from what the
platform associates with that commit: **the pull request title decides it**. Verified
on the real run 42531631584: PR #10 was merged as merge commit `2f2d70f`, and because
its title was `feat: release automation`, the candidate release PR contained
`### Features * release automation (2f2d70f)` and bumped to `0.2.0`. The
`Dupond Pull Request Title` check exists because of exactly this: a title outside
Conventional Commits is invisible to release automation. Release Please's own titles
(`chore: release 0.2.0`, or `chore(main): release 0.2.0`) pass the same check.

## Release flow

1. Merge feature/fix PRs into `main` with Conventional Commit titles.
2. On the next push to `main`, the `prepare` job opens or updates a single release
   PR containing the version bumps, the CHANGELOG section, and the manifest update.
   That job runs Release Please with `skip-github-release: true`, so it can never
   tag anything.
3. Review the release PR like any other change and merge it.
4. The push of that merge triggers `release.yml` again. `ci-gate` waits for the
   required workflow `Dupond Continuous Integration` to pass **for the exact commit
   SHA being published** (`github.sha`), then `publish` runs Release Please with
   `skip-github-pull-request: true`, which creates the tag and GitHub release.
   Only a `push` run against `main` for that SHA counts; a green `pull_request` run
   on the same commit, or green CI on a neighbouring commit, does not authorize a
   publish.
5. The release PR then gains the `autorelease: tagged` label. That label, the tag,
   and the manifest entry are the three things to compare when deciding whether a
   run reconciled or stalled.

The first release PR the automation actually built was `0.2.0`, from the `feat:`
title of PR #10 — not the `0.1.1` this document first predicted, because the PR
title (not the `ci:` commits) decided the bump. Merge such a PR when there is
something real to ship with it, or leave it open/snooze it; it keeps being updated
and folds in later changes.

## Duplicates, races, and retries

* `concurrency.group: dupond-release-please-${{ github.ref }}` with
  `cancel-in-progress: false` serializes automation runs; a run that may already
  have created a tag is never cancelled mid-flight.
* Release Please reads existing tags/releases before creating them and treats an
  already-present tag as a `DuplicateReleaseError` warning rather than an error, so
  a re-run reconciles instead of double-publishing.
* Re-running a CI workflow is safe: the gate always uses the newest attempt
  (`run_attempt`), so a re-run that fails revokes a previous success and a re-run
  that succeeds replaces a previous failure.
* If a publish is blocked (red CI, timed-out gate, or a runner outage) nothing is
  tagged. Fix CI, then run **Dupond Release Automation → Run workflow** on `main`.
  The pending release is picked up and published exactly once.

## GitHub Actions token restrictions

Resources created by the default `GITHUB_TOKEN` do **not** trigger workflows. Plan
around that instead of assuming success:

* Release Please's release PR may show no checks. Merge it anyway only if the
  gate will verify CI on the resulting `main` commit — which it does, and that is
  the authoritative check. To force checks onto the PR itself, close and reopen it,
  or configure a personal-access-token `token` input for the action.
* The `vX.Y.Z` tag and the release created by the `publish` job trigger nothing.
  Any later step that must react to a release (npm publish, deploy, artifact
  mirror) has to run as a job in this same workflow with `needs: publish`; a
  `on: release` or `on: push: tags` workflow will simply never fire.
* Nothing here requires repository **secrets**. `ci-gate` uses the job token read-only
  (`actions: read`); `prepare`/`publish` get `contents: write` plus
  `pull-requests: write` and nothing broader. Credentials are never echoed.

## Required repository setting (not a secret)

`prepare` needs one toggle that the workflow's own `permissions` block cannot grant:
**Settings → Actions → General → "Allow GitHub Actions to create and approve pull
requests"**. With it off, the job token is refused no matter what the workflow asks
for, and the first real run failed exactly there — after successfully creating the
`release-please--branches--main--components--dupond-orchestrator` branch:

```
##[error]release-please failed: GitHub Actions is not permitted to create or approve pull requests.
```

`publish` depends on `prepare`, so that failure also means nothing is tagged: the
run fails closed rather than half-releasing. Re-run
**Dupond Release Automation → Run workflow** on `main` after enabling the toggle; the
bot branch is reused, so no duplicate is created.

## The experimental v0.1.0 release

v0.1.0 was prepared by the release-preparation PR that added `CHANGELOG.md` and set
`0.1.0` in `package.json` and `package-lock.json`. Release automation landed after
that, so the automation did not author the bump and does not re-author it:
`.release-please-manifest.json` is seeded with `{ ".": "0.1.0" }`, and tag `v0.1.0`
plus its GitHub release are created once, directly, from the merge commit of that
preparation PR.

Reconcile-check before and after that one manual publish (all read-only):

```sh
npm run release:check
npx tsx scripts/release.ts gate --sha "$(git rev-parse origin/main)"   # exits 0 only when CI is green for that SHA
npx tsx scripts/release.ts notes --version 0.1.0                        # the truthful notes body, straight from CHANGELOG.md
gh release view v0.1.0
```

Those commands are read-only; `gate` exits `0` only when main-branch push CI passed
for the exact SHA. Running `npx release-please release-pr --dry-run` against this
repository is not a substitute: the CLI reads releases over GraphQL, and the
fine-grained `GITHUB_TOKEN` used for delivery is rejected there with `401`, even
though the same credential works for the REST calls above. The action does not have
that limitation because it authenticates as the workflow run.

The release notes body must be the `0.1.0` section of `CHANGELOG.md`: it states the
demonstrated capability (one live task produced a real PR in `dupond-live-demo` with
passing acceptance tests and CI) and the limitations (supervised use on disposable
repositories, single demonstration, no npm publication). Do not replace it with
generated marketing copy or GitHub's auto-generated notes.

Publishing v0.1.0 to npm is out of scope and must stay out: the package is
`"private": true`, and no workflow logs in to a registry.
