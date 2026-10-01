# S95 — Run actual T4/T5 platform and selected-client conformance

Baseline `a2aca127`; ER-27/26 and participating component owners. This is aggregate live acceptance after S94/#286. Prepare probes locally beforehand, but execute live tests only on approved disposable targets, not the owner's working library.

## 1. Problem

A local Worker or isolated successful provider call does not establish native Workflow recovery, Queue redelivery/DLQ, DO hibernation, Access/MCP/Workspace integration, or failure behavior on the deployed platform.

## 2. Required change

Compose short operation-specific probes from existing integration suites into one reproducible run against the attested build: Access/API/MCP, D1/R2, Queue/DLQ, DO reconnect/hibernation, Workflow cancellation/recovery, model/gateway settlement, AI Search generation, selected Workspace, and independent federation. Reuse S63/S66/S67/S69 erasure/restore/rollback/security cases rather than implementing those systems again inside a test runner.

## 3. Documentation and exact search anchors

[Production readiness Phases 8/10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md); [Cloudflare handoff](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/cloudflare-handoff.md).
```sh
git grep -n -F '## 10. Phase 8 — execute T4 live platform conformance' -- docs/implementation/production-readiness-plan.md
git grep -n -F '## 12. Phase 10 — execute T5 security, privacy and failure hardening' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Reuse integration/provisioning/readback helpers. Any missing runner is a thin CLI composition, not another implementation library. Inputs identify approved target, build, config, schema, corpus, suite, and secret references. Explicit fixture mode makes no account calls; live execution requires established authorization and budget.

Retain expected/observed durable state and identities, not merely HTTP success. Verify native lifecycle semantics against pinned runtime/types; do not treat every errored instance as paused. Response-loss injection may drop acknowledgement but must not fabricate application/provider state. UNKNOWN paid effects are not retried blindly; a first legitimate audit remains distinct from repeated synthesis. Independently read actual storage/provider evidence and validate hashes/generations.

Use the selected gemini-mcp profile, not mandatory legacy Drive OAuth. Missing credentials, independent peer, or external action permission yields NOT_EXECUTED with a precise prerequisite. Cleanup is idempotent and restricted to approved test-owned identities.

## 5. Acceptance criteria

- [ ] Duplicate/lost-ACK/restart/cancel/expiry/revoke/partial-output cases preserve one logical operation without forbidden disclosure or duplicate paid effects.
- [ ] Actual serving search generation, exact evidence, external Workspace action/readback, and independent federation wire behavior are verified.
- [ ] Disposable erasure, clean restore, and rollback do not resurrect obsolete grants or purged content.
- [ ] Fake, stale, wrong-target, and incomplete evidence fails validation; fixture/live results remain distinct and bound to exact SHA/target/config/time.
- [ ] LIVE_QUALIFIED is recorded only when every applicable required observation for that component was actually obtained. No planning or local-only result substitutes for live acceptance.
