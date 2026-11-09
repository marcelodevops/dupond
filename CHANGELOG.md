# Changelog

## [0.2.1](https://github.com/marcelodevops/dupond-project-leader/compare/v0.2.0...v0.2.1) (2026-11-09)


### Bug Fixes

* **release:** use a workflow permission scope Actions accepts ([a246c9c](https://github.com/marcelodevops/dupond-project-leader/commit/a246c9c75d7f20626fdb8c5cc6b37e6eb80b9e9d))
* **release:** use a workflow permission scope Actions accepts ([02eb336](https://github.com/marcelodevops/dupond-project-leader/commit/02eb336eece2a4a8f443486669422f1539a6759d))

## [0.2.0](https://github.com/marcelodevops/dupond-project-leader/compare/v0.1.0...v0.2.0) (2026-11-09)


### Features

* release automation ([2f2d70f](https://github.com/marcelodevops/dupond-project-leader/commit/2f2d70ffd1e0e2f8e84d9183532a73461ea4bf28))

## 0.1.0 — Experimental

First demonstrated task-to-PR milestone for Dupond.

### Included

- Authenticated HTTP API and server-side task coordination.
- SQLite task, run, attempt, verification, and delivery records.
- Live Gemini coding worker with repository inspection, file editing, command execution, and rate-limit retry handling.
- Isolated Git worktrees and platform-specific command isolation: macOS Seatbelt or Linux containers.
- Explicit target repository resolution and delivery identity checks.
- Acceptance checks, protected-path checks, and verification bound to commit revisions.
- Bounded repair attempts and command cancellation support.
- Remote-base fetching, merge verification, and renewed approval after integration changes a revision.
- GitHub branch and PR delivery with explicit approval requirements.
- Automated CI on macOS and Ubuntu.

### Demonstration evidence

The percentageOf demonstration produced a real, unmerged PR in a separate GitHub repository. Only src/math.js changed; acceptance tests and GitHub CI passed.

- PR: https://github.com/marcelodevops/dupond-live-demo/pull/1
- Delivered revision: e62c2e9ed11d1349efacb2344e08d2a8a9edeafb
- CI: https://github.com/marcelodevops/dupond-live-demo/actions/runs/42520092355

### Scope and limitations

- Experimental release intended for supervised use on disposable or low-risk repositories; the demonstration does not establish production readiness.
- Requires Node.js 22, Gemini access, a supported sandbox, an explicit local target checkout, and Git/GitHub authentication for live delivery.
- GitHub delivery uses the gh CLI. Publishing an npm package is not part of this release.
- One live task demonstrates feasibility, not repeatability across arbitrary projects.
- Local/bare-remote test paths can generate placeholder PR metadata; they are not evidence of real GitHub PR creation.
- Command cancellation does not establish cancellation of every in-flight model request. Sandbox behavior and resource limits should be reviewed for each deployment.
