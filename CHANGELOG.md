# Changelog

## [0.7.1](https://github.com/marcelodevops/dupond/compare/v0.7.0...v0.7.1) (2026-11-12)


### Bug Fixes

* complete multi-project backend integration ([3fc2753](https://github.com/marcelodevops/dupond/commit/3fc2753071ae3d0d2fa7022cf0e6520f988a62bb))
* complete multi-project backend integration ([78eb943](https://github.com/marcelodevops/dupond/commit/78eb9432b8c2f4a7a6714d38fe1187d0330545c1))

## [0.7.0](https://github.com/marcelodevops/dupond/compare/v0.6.0...v0.7.0) (2026-11-11)


### Features

* **project:** harden workspace and project switching against stale responses, mutations, and missing endpoints ([db7f1c0](https://github.com/marcelodevops/dupond/commit/db7f1c05fa502a87655733bf584646c4eb0eac07))
* **projects:** implement project management ([5fb2313](https://github.com/marcelodevops/dupond/commit/5fb231326853ea90098c32ca7bba3a95b02c9e31))


### Bug Fixes

* **projects:** remove simulated success fallbacks ([5d6e612](https://github.com/marcelodevops/dupond/commit/5d6e61205d97499aac76b935393f6c57bdff7116))
* **tests:** track AEG-104 artifact fixture, isolate test stores, and resolve git fixture branch drift ([6827467](https://github.com/marcelodevops/dupond/commit/682746737fd91875adacc2f1be7fbbc82bf87004))

## [0.6.0](https://github.com/marcelodevops/dupond/compare/v0.5.0...v0.6.0) (2026-11-11)


### Features

* **project:** define shared project contract and API types ([53eab7f](https://github.com/marcelodevops/dupond/commit/53eab7f39e7160b6b6fdf8930ada884480243401))
* **project:** implement centralized project API adapter and session context ([f682d82](https://github.com/marcelodevops/dupond/commit/f682d82efc21d0eca020858128a0b3e4b9968be0))
* **ui:** implement project switcher, creation wizard, and workspace lifecycle ([9916f37](https://github.com/marcelodevops/dupond/commit/9916f37738ac6efd4ae47291787bdd4a9902743b))
* **ui:** implement project switcher, creation wizard, lifecycle modal, and empty board view ([f9080eb](https://github.com/marcelodevops/dupond/commit/f9080eb886e04113f2d1f7519d70eaa9b1ede741))

## [0.5.0](https://github.com/marcelodevops/dupond/compare/v0.4.5...v0.5.0) (2026-11-11)


### Features

* **ui:** add brand logo to header and coordinator avatar to directives terminal ([e048dbe](https://github.com/marcelodevops/dupond/commit/e048dbe680413c1875d6e70d4867fd5eef3c3038))
* **ui:** add reusable AgentAvatar component and role-to-asset mapping ([381f0a2](https://github.com/marcelodevops/dupond/commit/381f0a27b468ba8d8640efa694048bd6644e016e))
* **ui:** integrate character avatars across kanban, modals, matrix, diagrams, and activity feed ([3014ecc](https://github.com/marcelodevops/dupond/commit/3014ecc7598668066f0a581d5bccb58ee8773524))
* **ui:** integrate Dupond character avatars across application ([b391273](https://github.com/marcelodevops/dupond/commit/b3912736a97de985ff88e503c197765c57a610e9))


### Bug Fixes

* **tests:** prevent task key collision in guardrails regression test ([ada2907](https://github.com/marcelodevops/dupond/commit/ada29075cc9a012b9f86fa192fb85adffc4683e6))

## [0.4.5](https://github.com/marcelodevops/dupond/compare/v0.4.4...v0.4.5) (2026-11-11)


### Bug Fixes

* **delivery:** capture approval identity from the validated dispatch … ([150ea39](https://github.com/marcelodevops/dupond/commit/150ea3937fbe76db32187d98a25b021c33c7a73f))
* **delivery:** capture approval identity from the validated dispatch context ([8eb2e04](https://github.com/marcelodevops/dupond/commit/8eb2e04db1cda82078cab6ed9ce3b6e26e18ae9f))

## [0.4.4](https://github.com/marcelodevops/dupond/compare/v0.4.3...v0.4.4) (2026-11-10)


### Bug Fixes

* **acceptance:** route requirement edits to the contract and bind approvals to it ([6b3cde5](https://github.com/marcelodevops/dupond/commit/6b3cde50c7f1bbc6c6ca53e08438e32082e476e9))
* **acceptance:** route requirement edits to the contract and bind approvals to it ([c0d785c](https://github.com/marcelodevops/dupond/commit/c0d785cd4d88d0fb22e80ccc4bd2af5e7659f9fc))

## [0.4.3](https://github.com/marcelodevops/dupond/compare/v0.4.2...v0.4.3) (2026-11-10)


### Bug Fixes

* **ui:** surface API auth failures instead of serving seeded board data ([9b83197](https://github.com/marcelodevops/dupond/commit/9b83197a65a0b604aa74aed8ffc60c1a98ec6ce5))

## [0.4.2](https://github.com/marcelodevops/dupond/compare/v0.4.1...v0.4.2) (2026-11-10)


### Bug Fixes

* **lifecycle:** close six acceptance-lifecycle gaps found in review of 46518be ([d5f8840](https://github.com/marcelodevops/dupond/commit/d5f884023b5884b33bb29f7784704c4506fec5cc))
* **lifecycle:** unify acceptance authority, re-bind specs, gate dirty candidates, re-approve deliveries ([b137ec0](https://github.com/marcelodevops/dupond/commit/b137ec05186c71050541f3e65880986ec712c502))

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
