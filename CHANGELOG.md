# Changelog

## [0.19.0](https://github.com/marcelodevops/dupond/compare/v0.18.0...v0.19.0) (2026-11-23)


### Features

* integrate Antigravity CLI coding worker and remove Gemini CLI ([#82](https://github.com/marcelodevops/dupond/issues/82)) ([b40ff64](https://github.com/marcelodevops/dupond/commit/b40ff6422b774a985fa9c00cd87148f4af489df5))
* **ui:** add inline help for operator approval credential and unconfigured state ([b228833](https://github.com/marcelodevops/dupond/commit/b228833519410a6df31d049852c307e74119eb16))


### Bug Fixes

* **agy:** enforce profile and repository config isolation in OS sandbox ([6e47230](https://github.com/marcelodevops/dupond/commit/6e4723017b0eb22c8da89766ae1fa60d5e89cb62))
* **agy:** gate macOS probes and coding execution before spawning agy ([ed05186](https://github.com/marcelodevops/dupond/commit/ed05186dd4fefe0535ef77d51b0220b002a953b4))
* **agy:** prevent macOS keychain prompts and surface sanitized auth states ([fcab2d6](https://github.com/marcelodevops/dupond/commit/fcab2d61e05efa93e3bff72aa4d004995a18f551))
* **delivery:** avoid sending placeholder repoUrl when project uses localPath ([5fe186c](https://github.com/marcelodevops/dupond/commit/5fe186cfef6a3320aa69fe832c68b455c466a6c5))
* **lifecycle:** block execution on completed (done) tasks in UI and API ([8eecd4c](https://github.com/marcelodevops/dupond/commit/8eecd4cc0d63f7361df412f555882e9a82a8c74d))
* **lifecycle:** remove unscoped getTask fallback in RepairCoordinator done guard ([5e234ef](https://github.com/marcelodevops/dupond/commit/5e234ef80d6449e4695f3c28d390061670e5f066))

## [0.18.0](https://github.com/marcelodevops/dupond/compare/v0.17.0...v0.18.0) (2026-11-22)


### Features

* **auth:** add isolated Antigravity CLI PTY OAuth onboarding prototype ([f276c8e](https://github.com/marcelodevops/dupond/commit/f276c8ee9312a967abcf9aee6bc30ce2f5feb4b7))
* **auth:** Antigravity CLI PTY OAuth onboarding prototype ([e4c9ed6](https://github.com/marcelodevops/dupond/commit/e4c9ed6c08097aee201b4505cd9f95d8daf8e8a3))


### Bug Fixes

* **agy-auth:** confirm dual process-group teardown, serialize lifecycle, and drop raw feedback ([2c54e7b](https://github.com/marcelodevops/dupond/commit/2c54e7b9047f9117ebb0f06269b8efe1f299a148))
* **agy-auth:** extract unwrapped OSC 8 and delimited multi-line OAuth URLs ([838573a](https://github.com/marcelodevops/dupond/commit/838573ae6a54685f8454f1ff912ee53e52328177))
* **agy-auth:** yield on real timers during process wait and make model probes async, bounded, and cancellable ([2de55c1](https://github.com/marcelodevops/dupond/commit/2de55c1239890d2818d3feb389bf50e97c5dbd0f))

## [0.17.0](https://github.com/marcelodevops/dupond/compare/v0.16.0...v0.17.0) (2026-11-20)


### Features

* **worker:** add Gemini CLI coding-worker provider ([52a0a88](https://github.com/marcelodevops/dupond/commit/52a0a886b7558022ccd2f2d4b39a41fdbba47095))

## [0.16.0](https://github.com/marcelodevops/dupond/compare/v0.15.0...v0.16.0) (2026-11-20)


### Features

* **sandbox:** add rawArgv, gitReadOnly, denyWritePaths, and minimal auth seeding ([6a1c975](https://github.com/marcelodevops/dupond/commit/6a1c97511039ca4c736b03bcbb3a838cc39f0d79))
* **ui:** add OpenCode CLI worker and model selection in Task Details and Add Task ([c65e072](https://github.com/marcelodevops/dupond/commit/c65e072668f3e03dcaaa16ccde878b790b05ed13))
* **worker:** add OpenCode CLI coding-worker adapter ([024ecc3](https://github.com/marcelodevops/dupond/commit/024ecc3875be4e43380451f7e3ca57f874eaeece))
* **worker:** add OpenCode CLI coding-worker adapter with worktree isolation and boundary checks ([821ef13](https://github.com/marcelodevops/dupond/commit/821ef1333a72b945f919c08203ba731328991058))


### Bug Fixes

* **opencode:** override inherited PWD in sandbox and fail fast on startup prerequisites ([e5ae0f2](https://github.com/marcelodevops/dupond/commit/e5ae0f2637306cb7f9c239037753524aae0e5612))
* **opencode:** route CLI execution through OS sandbox and verify full repo baseline ([2018240](https://github.com/marcelodevops/dupond/commit/2018240226ab6e8cdb949262d20640d4b6dace9d))
* **opencode:** strip parent PWD and fail fast on deterministic startup prerequisites ([4dd4229](https://github.com/marcelodevops/dupond/commit/4dd4229df4eea23d5030763f4d0927d6e61d3494))
* **sandbox:** pin PWD to worktreePath instead of inheriting parent server PWD ([de5e403](https://github.com/marcelodevops/dupond/commit/de5e403cd8a49b6113c3e703f2bd18f15984961d))
* **sandbox:** translate protected-path subtree and glob patterns into enforceable OS rules ([3052c2a](https://github.com/marcelodevops/dupond/commit/3052c2a4d0dc8e6f2d112608799a374829d8db12))

## [0.15.0](https://github.com/marcelodevops/dupond/compare/v0.14.1...v0.15.0) (2026-11-18)


### Features

* **credentials:** add application-scoped OpenAI credential store, resolver, and Responses API test ([74df6c5](https://github.com/marcelodevops/dupond/commit/74df6c53c2dcf86efde076f039c29cbd4d9fb94d))
* **settings:** add application-scoped OpenAI credential onboarding ([5b57e2b](https://github.com/marcelodevops/dupond/commit/5b57e2bde0e8185b6e7077a3a610f8b904802a5c))
* **ui:** add OpenAI credential onboarding section in Application Settings and task configuration link ([07ed571](https://github.com/marcelodevops/dupond/commit/07ed57182792a7bc46516a26c26a642bf98c8f3b))
* **ui:** support custom OpenAI test models and model-bound verification badges ([ffdec1e](https://github.com/marcelodevops/dupond/commit/ffdec1ef5283a65e62026d10099605aef855bf64))
* **worker:** wire OpenAIProviderAdapter to unified credential resolver and sanitize OpenAI secrets ([413519f](https://github.com/marcelodevops/dupond/commit/413519fee021f8b686908c359b980b9afbd6e93a))


### Bug Fixes

* **credentials:** enforce atomic provider-level test ordering and custom OpenAI model validation ([6def0e8](https://github.com/marcelodevops/dupond/commit/6def0e801b3972cb0deaa507c9aadbc217480606))

## [0.14.1](https://github.com/marcelodevops/dupond/compare/v0.14.0...v0.14.1) (2026-11-18)


### Bug Fixes

* **coordinator:** centralize authoritative-to-board blocked status projection ([8b3303f](https://github.com/marcelodevops/dupond/commit/8b3303f34da5cdddd7081a5290009fa0cecf9d31))
* **kanban:** keep blocked and unexpected-status tasks visible and ignore worktrees in Vite dev watch ([1ccfcc3](https://github.com/marcelodevops/dupond/commit/1ccfcc352814d9886941a73f1d637b0a90eebc42))
* **server:** project agent-step outcomes and ignore worktrees in Vite dev watch ([2c681d8](https://github.com/marcelodevops/dupond/commit/2c681d8204ff97feb71f123015f3df37e9f082a9))
* **ui:** render blocked and unexpected-status tasks visibly and reconcile on failed execution ([894660e](https://github.com/marcelodevops/dupond/commit/894660e5f931644e044edcad46d9aa192630cd06))

## [0.14.0](https://github.com/marcelodevops/dupond/compare/v0.13.0...v0.14.0) (2026-11-18)


### Features

* **identity:** enforce project-scoped task identity deduplication and conflict recovery ([ae89e88](https://github.com/marcelodevops/dupond/commit/ae89e88b9307790d540b40db7403483b81be2f46))
* **ui:** surface identity conflicts and explicit registration consequence ([88c3db2](https://github.com/marcelodevops/dupond/commit/88c3db2566849cac5efa2aeabc0999c2754e6f09))


### Bug Fixes

* enforce project-scoped task identity, explicit registration copy, and refusal audits ([a2679de](https://github.com/marcelodevops/dupond/commit/a2679dee487accd3a9c493247b8311873442a8ef))
* **identity:** durably preserve all conflict variants before resolution ([4154241](https://github.com/marcelodevops/dupond/commit/415424164354161d4141492e4e3c41a471cc1bc7))

## [0.13.0](https://github.com/marcelodevops/dupond/compare/v0.12.0...v0.13.0) (2026-11-18)


### Features

* **delivery:** review delivery and state sync ([4077de8](https://github.com/marcelodevops/dupond/commit/4077de8894479ef495f0eac260ac5dbef4a72b87))
* **ui:** surface Project Settings action when registration lacks repository ([b48510e](https://github.com/marcelodevops/dupond/commit/b48510e9cd08ce336ea0e78501c4a6254a483f00))
* **ui:** surface unregistered task recovery and next-action guidance ([84a757b](https://github.com/marcelodevops/dupond/commit/84a757b0322de26a07015123e837e7df148ff194))


### Bug Fixes

* block unregistered board tasks cleanly and add safe authoritative registration ([d3d1297](https://github.com/marcelodevops/dupond/commit/d3d129707a1cfac21545c80b27ce757e188c2168))
* replace legacy artifact fallback with authoritative task registration ([1781783](https://github.com/marcelodevops/dupond/commit/178178339d22f34c9ac6fe84e009e118b27b5e53))
* require explicit target repository during task registration ([8f69832](https://github.com/marcelodevops/dupond/commit/8f69832458cdbdaab088b099ea110d4e8a0dc628))

## [0.12.0](https://github.com/marcelodevops/dupond/compare/v0.11.0...v0.12.0) (2026-11-16)


### Features

* add review decision and PR delivery workflow in API and TaskDetailModal ([93b4876](https://github.com/marcelodevops/dupond/commit/93b48763338cf113657e371a4da6704a2b9d2fa8))
* bind UI review/delivery actions to inspected candidate and show unresolved feedback ([cbb92a4](https://github.com/marcelodevops/dupond/commit/cbb92a44249cba7882a004c96542e028248c9339))
* review approval, PR delivery controls, and secondary-project state sync ([e5366b8](https://github.com/marcelodevops/dupond/commit/e5366b8f760a15c98b6568d8e56f75a0e53cb898))
* **runs:** add sanitized read-only run evidence and structured transition refusals ([cacd980](https://github.com/marcelodevops/dupond/commit/cacd9804f8a0ccd467811129d80ad0e8ad387855))
* **ui:** unify authoritative task transitions and surface Runs & Evidence inspection ([430f6da](https://github.com/marcelodevops/dupond/commit/430f6da5b6e0b3f2d4a6b8c8e7fad37ac5803c65))
* unify authoritative task transitions and add read-only run evidence inspection ([4be1fb2](https://github.com/marcelodevops/dupond/commit/4be1fb23c308f521f2bb0d962e4d2a07ea105673))


### Bug Fixes

* allow project task keys and align adopted criteria in state sync ([0dadf02](https://github.com/marcelodevops/dupond/commit/0dadf0297e36570f9c5d70bbbdd0c4264c6e9990))
* **coordinator:** resolve project repository settings from ProjectStore during worker step ([5a48ee7](https://github.com/marcelodevops/dupond/commit/5a48ee782e52951056c8242d6ec857120e9ffb23))
* guard container startup cancellation and retry cleanup ([7fdcdd5](https://github.com/marcelodevops/dupond/commit/7fdcdd559219931036e39114da9623f714b8fb64))
* hydrate project repository on adopted tasks and persist non-default project step state ([e2f242a](https://github.com/marcelodevops/dupond/commit/e2f242ac1868a147f342699bdd318018cfe8d77d))
* kill container immediately on abort and retry startup cleanup ([1fb97aa](https://github.com/marcelodevops/dupond/commit/1fb97aa3c1630d57aeaf51a9e9431425414c84de))
* persist review decisions, revoke rejected candidates, and bind review to exact candidate ([0f92501](https://github.com/marcelodevops/dupond/commit/0f925016e140099ca7be76978eb86202562710e8))
* preserve host env for container CLI so podman reuses pre-pulled image ([01237b4](https://github.com/marcelodevops/dupond/commit/01237b44c983b76b44018cce154b0cef0fcce48f))
* require candidate binding in delivery service and block legacy dispatch ([68ff923](https://github.com/marcelodevops/dupond/commit/68ff923c7a49bf0556df159ae5282b62efab5e0a))
* require complete candidate binding and revalidate before delivery push ([f2693b2](https://github.com/marcelodevops/dupond/commit/f2693b2931b9103c481ca1250a012a966331ff8a))
* **runs:** bind candidate evidence strictly to verified immutable commits and attempt metadata ([e40f4d8](https://github.com/marcelodevops/dupond/commit/e40f4d8766953e619040872017c4b275c9ba3445))

## [0.11.0](https://github.com/marcelodevops/dupond/compare/v0.10.0...v0.11.0) (2026-11-16)


### Features

* **ui:** show Test Connection pending elapsed timer, Cancel action, and inconclusive banner ([d81599a](https://github.com/marcelodevops/dupond/commit/d81599a3cc21f0744a1e23010deef0d56e39a0ea))


### Bug Fixes

* **gemini:** add bounded Test Connection timeout, SDK abort propagation, and inconclusive outcome ([0a5d04a](https://github.com/marcelodevops/dupond/commit/0a5d04aeab23f1375e7679bc1f84d6a99da81667))
* handle Gemini Test Connection timeouts and cancellation safely ([8b599a3](https://github.com/marcelodevops/dupond/commit/8b599a3ff986290e44ce9041c9c13f25dc0debba))

## [0.10.0](https://github.com/marcelodevops/dupond/compare/v0.9.0...v0.10.0) (2026-11-15)


### Features

* **settings:** separate Project Settings from Application Settings ([c85581d](https://github.com/marcelodevops/dupond/commit/c85581d653503da723045109d0a8f201a258be37))
* **settings:** separate Project Settings from Application Settings and enforce active-run guard ([be6180d](https://github.com/marcelodevops/dupond/commit/be6180dbbd441ecb6039381e8c948aa2d0e06319))


### Bug Fixes

* **settings:** eliminate stale modal frame on reopen and update Gemini error message ([9d7e58b](https://github.com/marcelodevops/dupond/commit/9d7e58ba0b9aabe95633e66b6b22094c05cf19b6))
* **settings:** stabilize focus handling, invalidate stale repo verification, and guard ProjectContext updates ([7e9de0b](https://github.com/marcelodevops/dupond/commit/7e9de0bccb1dae7d871a82d86903cb07e254b4b3))

## [0.9.0](https://github.com/marcelodevops/dupond/compare/v0.8.4...v0.9.0) (2026-11-15)


### Features

* **credentials:** add encrypted app_credentials store and key rotation support ([2c91059](https://github.com/marcelodevops/dupond/commit/2c910599e357f95de2c2a97b2c8c2158ed055d18))
* **gemini:** add encrypted Gemini credential onboarding and browser verification ([8982fce](https://github.com/marcelodevops/dupond/commit/8982fce1480900f828b6c3da94bd9ec175d87704))
* **gemini:** unify credential resolver, cache invalidation, and credential API ([ded91f5](https://github.com/marcelodevops/dupond/commit/ded91f56e7b540982dcb8654af4a52a4559d60cf))
* **ui:** add Gemini credential management in settings and onboarding from plan ingestion ([a458ed6](https://github.com/marcelodevops/dupond/commit/a458ed64d7b794981e97e88ba4acdf098c0847b5))


### Bug Fixes

* **crypto:** fail closed on key persistence failure and serialize concurrent first-key creation ([14e0462](https://github.com/marcelodevops/dupond/commit/14e04629a36eed195e9bef1ca8f1e5ff43509e4e))
* **e2e:** settle delayed route continuation before unrouting ([edfc958](https://github.com/marcelodevops/dupond/commit/edfc958a9dc31a3c19b10337a7b2670cfccc8761))
* **e2e:** terminate server process group and wait for port release before restart ([8a3fb54](https://github.com/marcelodevops/dupond/commit/8a3fb54b35fff27fffa14aa61d46a35f820d95f5))
* **gemini:** bind credential test outcomes to version, fingerprint, and model ([4f4333d](https://github.com/marcelodevops/dupond/commit/4f4333d718214fc8231720ae36721b7622ae3bb8))
* **ui:** refresh projects on operator auth and allow readiness settings before project load ([fad1b84](https://github.com/marcelodevops/dupond/commit/fad1b8480b79b2850d4f6598b9a50869e9a96dbd))
* **ui:** represent loading and error readiness states explicitly instead of Not Configured ([39f7a51](https://github.com/marcelodevops/dupond/commit/39f7a51355cd4da85e461c276b96fdea8318a9d2))

## [0.8.4](https://github.com/marcelodevops/dupond/compare/v0.8.3...v0.8.4) (2026-11-15)


### Bug Fixes

* **ui:** use Dupond character portrait as visible application logo ([2644d71](https://github.com/marcelodevops/dupond/commit/2644d711606a7b9b5817d2cab8ac6f94e99c9c9a))

## [0.8.3](https://github.com/marcelodevops/dupond/compare/v0.8.2...v0.8.3) (2026-11-15)


### Bug Fixes

* **security:** crash-recoverable connection-key rotation ([6250501](https://github.com/marcelodevops/dupond/commit/6250501394235517b298b5de11f66699f545c913))
* **security:** enforce app exclusion, snapshot validation, and recovery identity ([f42d3a0](https://github.com/marcelodevops/dupond/commit/f42d3a06a650c2585d3c7428cbad4cf6dc42c0bf))
* **security:** implement crash-recoverable connection-key rotation ([852a724](https://github.com/marcelodevops/dupond/commit/852a7242424020ca2af41d22fa9f00719b88da05))
* **security:** refuse ambiguous missing-metadata recovery when .next exists ([a3f2285](https://github.com/marcelodevops/dupond/commit/a3f2285983ef5fa1f57c38f99559ba980f7c6ac4))
* **types:** resolve TypeScript checks in rotateConnKey and tests ([8e2b2d0](https://github.com/marcelodevops/dupond/commit/8e2b2d07c0b22805cfba368d6ea1b6f77309d3ca))

## [0.8.2](https://github.com/marcelodevops/dupond/compare/v0.8.1...v0.8.2) (2026-11-15)


### Bug Fixes

* **security:** security tier1 execution boundaries v2 ([b1a4286](https://github.com/marcelodevops/dupond/commit/b1a428629d36a5c53808484c126ac34cf485dbfe))

## [0.8.1](https://github.com/marcelodevops/dupond/compare/v0.8.0...v0.8.1) (2026-11-13)


### Bug Fixes

* **projects:** project correctness repairs ([adcf543](https://github.com/marcelodevops/dupond/commit/adcf54352df0a08724243e8acdd4647b4793ce3e))
* **server:** check default coordinator tasks for cross-project transition mismatch ([251bda6](https://github.com/marcelodevops/dupond/commit/251bda6e398730c6b6a7573aeefcf8ce8c8b954b))

## [0.8.0](https://github.com/marcelodevops/dupond/compare/v0.7.1...v0.8.0) (2026-11-13)


### Features

* **adoption:** enforce strict project isolation and atomic plan adoption ([ca4f965](https://github.com/marcelodevops/dupond/commit/ca4f965994e805407dcb921076ef8cf39bc30def))
* **context:** enforce explicit project context and honest error visibility ([d6bc4b1](https://github.com/marcelodevops/dupond/commit/d6bc4b1d9647440be3a1b39000da69f7a12e8b02))
* **planning:** remove fabricated plan fallbacks and persist source plans ([093334a](https://github.com/marcelodevops/dupond/commit/093334ab4ad617f6e6b9a08619604ff9d6dcd211))
* **settings:** introduce project settings window and server-side repo verification ([1771632](https://github.com/marcelodevops/dupond/commit/177163236d13666a2b6cd0ea1ced0527ab91934b))


### Bug Fixes

* **adoption:** enforce source plan ownership and synchronize authoritative database tasks ([9b8b4cc](https://github.com/marcelodevops/dupond/commit/9b8b4cc2b9779b34bfa603babb869e56d218c125))
* **db:** enforce scoped task lookups and migrate legacy table constraints ([a4f9bb8](https://github.com/marcelodevops/dupond/commit/a4f9bb8e639d1f6fee9be0670cad69798a92939e))
* **projects:** align default project fixed identity guard with store record name ([6dfc6b3](https://github.com/marcelodevops/dupond/commit/6dfc6b3649dac46a80a7d2401a60ef806c94f1ee))
* **projects:** repair multi-project workflow integrity and honest error visibility ([555e3f8](https://github.com/marcelodevops/dupond/commit/555e3f87774326cc99edf3e8000f5aa9e8f883c7))
* **tests:** probe the address the journey server actually binds ([b139ec1](https://github.com/marcelodevops/dupond/commit/b139ec160cfbdce08eed2866ff5a564ee7a72f3b))
* **types:** resolve TypeScript compilation errors in project API and task schema ([d0160f4](https://github.com/marcelodevops/dupond/commit/d0160f4b7b05d2558dcc9f2a9ec4d25d7815215b))

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
