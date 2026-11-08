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

## Version policy

* `fix:`, `perf:` → patch bump.
* `feat:` → minor bump.
* Breaking change (`feat!:` / `fix!:` / `BREAKING CHANGE:` footer) → **minor**
  bump while major is `0`, because `bump-minor-pre-major: true`. Major stays `0`
  until the product is declared production-ready; the maintainer who flips it
  records the decision in the release PR.
* `docs:`, `test:`, `build:`, `ci:`, `chore:` → no bump, no changelog entry.
* Every release is published as a GitHub **prerelease** while major is `0`, via
  `prerelease: true`. `prerelease-type` is deliberately unset so versions remain
  `0.2.0` rather than `0.2.0-beta.1`.
* `bump-patch-for-minor-pre-major` stays `false`: a `feat:` must not be downgraded
  to a patch.
* To force a specific version (hotfix, or "this is the 1.0.0 moment"), set
  `release-as` in `release-please-config.json` for one cycle, or pass
  `release-as` to the action, then remove it. Release Please records the result in
  the manifest.

Because Dupond squash-merges, **the PR title becomes the commit message on main
and therefore decides the version**. The `Dupond Pull Request Title` check refuses
titles that are not Conventional Commits so they cannot silently disappear from a
release. Release Please's own titles (`chore: release 0.2.0`, or
`chore(main): release 0.2.0`) pass the same check.

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
* Nothing here requires repository secrets. `ci-gate` uses the job token read-only
  (`actions: read`); `prepare`/`publish` get `contents: write` plus
  `pull-requests: write` and nothing broader. Credentials are never echoed.

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

The release notes body must be the `0.1.0` section of `CHANGELOG.md`: it states the
demonstrated capability (one live task produced a real PR in `dupond-live-demo` with
passing acceptance tests and CI) and the limitations (supervised use on disposable
repositories, single demonstration, no npm publication). Do not replace it with
generated marketing copy or GitHub's auto-generated notes.

Publishing v0.1.0 to npm is out of scope and must stay out: the package is
`"private": true`, and no workflow logs in to a registry.
