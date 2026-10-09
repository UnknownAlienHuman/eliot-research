# Implementation entry point

The repository is not production-ready. Architecture owns product intent; language/runtime contract owns
responsibility; readiness plan owns production declaration; current delivery plan controls source stop/resume.

1. Start at [`docs/START-HERE.md`](docs/START-HERE.md), then current backend router/delivery plan. Use PR #292
   for original S01–S99; readiness plan owns release criteria.
2. Inspect `implementation-status.json` and `gap-register.md`.
3. Claim one packet from [`docs/agent-work/`](docs/agent-work/README.md). ER-47/48 are manager packets; ER-49
   owns static scheduler. Exact C/U/B assignments are in execution map.
4. Before ER-49, at most one frontend manager + one leaf. After ER-49:
   - claim is committed before source work;
   - each source-edit commit has exactly one active covering claim in parent tree;
   - one active claim per checkpoint and one manager context per packet;
   - predecessor refs name checkpoint + ancestor commit; manager/external gates include approval ref.
   ER-49 validates mechanics, not semantic truth of approval/test evidence.
5. Read owned paths, exact checkpoint, input contracts, acceptance cases and named architecture only.
6. Read `LANGUAGE_RUNTIME_CONTRACT.md` for capability owner.
7. Implement behind existing ports. A package-local manifest/compiler result is not root integration: C1/U1
   build waits for ER-00 B-C/B-U lock/reference/boundary receipt.
8. Follow `branch-discipline.md`. Direct main default; only explicit owner authorization assigns one manager
   worktree/review branch. Leaves create no additional worktree/branch. Branch/claim does not lift stop or
   authorize merge/deploy/account mutation.
9. During authorized code phase, run scoped compile/lint. Frontend checkpoints run scheduler/bootstrap,
   component/browser/visual/CSP/performance and named human gates. Broad suites follow assembly. Deferred checks
   never PASS.
10. Record deterministic, human-review, live, recovery and workload evidence separately.

Frontend cutover additionally requires:

- one exact attested Vite client + existing Worker graph;
- one attested retirement-safe legacy rollback with no root service-worker registration;
- permanent non-claiming `/sw.js` tombstone and old cache/fetch worker retirement;
- controller-null standalone inbox recovery;
- synchronous first-paint privacy mask across bfcache restore;
- exact byte ranges bound to admitted revision + strong immutable representation validator;
- no hidden reasoning or parallel Research completion authority;
- U1-R live NotebookLM/Material reference and internal U1-D visual acceptance before shell assembly;
- fresh-context U2-X internal usability audit before completing real feature wiring;
- one owner review of the complete U5-X interface before final merge/deploy.

Primary maps:

- `docs/implementation/production-readiness-plan.md`
- `docs/architecture/ELIOT_RESEARCH.md`
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`
- `docs/implementation/branch-discipline.md`
- `docs/implementation/toolchain.md`
- `docs/implementation/dependency-map.md`
- `docs/implementation/contract-index.md`
- `docs/implementation/runtime-contract.md`
- `docs/implementation/slice-gates.md`
- `docs/implementation/cloudflare-runbook.md`
- `docs/implementation/release-checklist.md`
- `docs/implementation/security-checklist.md`
- `docs/agent-work/manifest.json`
- `docs/agent-work/frontend-owner-execution-map.md`
- `docs/design/OWNER_WEB_UI.md`
- `docs/implementation/frontend-agent-harness.md`
- `docs/implementation/frontend-cutover-inventory-2026-10-08.md`

System remains fail-closed. A type-compatible placeholder is not implemented; a fixture, claim, package-local
build, attractive screenshot or automated click flow is not repository/live/aesthetic/usability acceptance.
Production declaration requires every mandatory readiness condition.
