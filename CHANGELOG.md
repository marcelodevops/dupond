# Changelog

## [0.4.1](https://github.com/marcelodevops/dupond/compare/v0.4.0...v0.4.1) (2026-11-10)


### Bug Fixes

* remove checkbox-based acceptance grants from the JSON quality path ([d91f261](https://github.com/marcelodevops/dupond/commit/d91f261b4e5cd5abff3f6a44c8933e971c60da65))

## [0.4.0](https://github.com/marcelodevops/dupond/compare/v0.3.0...v0.4.0) (2026-11-10)


### Features

* version acceptance evidence and unify authoritative lifecycle transitions ([05c9cb4](https://github.com/marcelodevops/dupond/commit/05c9cb401ecb4538dc6a29cbb896edcb6015ac57))
* versioned acceptance evidence and one authoritative lifecycle ([7490f07](https://github.com/marcelodevops/dupond/commit/7490f07164fff6c24eb67e5081e35d6bc8f73ae8))

## [0.3.0](https://github.com/marcelodevops/dupond/compare/v0.2.3...v0.3.0) (2026-11-09)


### Features

* **worker:** implement provider-independent coding workers with Gemini and OpenAI support ([7aa4718](https://github.com/marcelodevops/dupond/commit/7aa471897029347873a2fa1db6f495d739396947))
* **worker:** implement provider-independent coding workers with Gemini and OpenAI support ([9933f56](https://github.com/marcelodevops/dupond/commit/9933f56ddea0fed3b072e78682ed609331a6b1f9))

## [0.2.3](https://github.com/marcelodevops/dupond/compare/v0.2.2...v0.2.3) (2026-11-09)


### Bug Fixes

* **release:** gate the commit that will actually be tagged ([36ae500](https://github.com/marcelodevops/dupond/commit/36ae500d3f2d102dc4d5280b0b4c90fabdec728f))
* **release:** gate the commit that will actually be tagged ([490fc99](https://github.com/marcelodevops/dupond/commit/490fc99d101f00c2784f8a6e998fe640670d2215))
* **release:** read pending releases over REST and trust recorded provenance ([edfa7d1](https://github.com/marcelodevops/dupond/commit/edfa7d1cb94a558d1b389af9846df2f55427dbfc))
* **release:** read pending releases over REST and trust recorded provenance ([bcc19a9](https://github.com/marcelodevops/dupond/commit/bcc19a9cc0c4a812338432029c9af793e0bae8b1))

## [0.2.2](https://github.com/marcelodevops/dupond-project-leader/compare/v0.2.1...v0.2.2) (2026-11-09)


### Bug Fixes

* **release:** treat release-metadata refusals as skips instead of cra… ([8b19cc3](https://github.com/marcelodevops/dupond-project-leader/commit/8b19cc3a0187927f89fd2261c3ee40769110d91a))
* **release:** treat release-metadata refusals as skips instead of crashes ([efc6223](https://github.com/marcelodevops/dupond-project-leader/commit/efc622349e7bf2eed0e3bf316bfc87ddf83274cd))

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
