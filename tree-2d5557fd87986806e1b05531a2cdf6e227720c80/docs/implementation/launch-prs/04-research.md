# Launch 04 / #92 — Durable investigations, governed execution and sessions

Follow execution-contract.md. Baseline f94bd7a; Workflow/Session are not completed by this plan.
Read canonical ELIOT_RESEARCH §§7.1–7.12,8.1–8.5,13.1–13.3,14.4/14.6,15,19.2–19.3/19.8;
language §§4–10. Owners ER-08 ledger, ER-09 Workflow, ER-10 freeze/audit/coverage, ER-16 model gateway,
ER-24 DO/HTTP, ER-25 UI, ER-13 SQL, ER-23/27 fixtures. ER-20 here is Google I/O, NOT model authority.

Existing modules: `packages/research/src/{ports,investigation-service,workflow,evidence-freeze,claim-audit,coverage}.ts`,
`apps/eliotr-core/src/{research-workflow,research-session}.ts`, `infra/workflows/research-workflow.json`,
`packages/platform-cloudflare/src/model-gateway.ts`, domain coverage and current policy/reference contracts.
Reuse scope/evidence and outbox adapters. No new agent framework, global DO or alternate workflow server.

## Checkpoints: one state family/expensive boundary per claim

### W1 — Durable Investigation ledger (independent first task)

ER-08 service/ports and ER-13 additive persistence. Store versioned protocol, goal, scope, required grade,
lane registrations, obligations/hypotheses/portfolio/debts and expected-revision checkpoint head. Bind
principal, input digest, policy/deployment and idempotency identity. Separate required Evidence Grade
from observed execution, fidelity and assurance; protocol/grade changes require explicit supersession.
Tests: create/replay/conflicting inputs, concurrent head CAS, lost ACK, reopen, restart/model swap,
wrong verifier, confirmatory metric changed after exposure. PASS: same ledger reconstructs after restart;
one CAS winner; only named verifier accepts an obligation; post-exposure deviations cannot silently
remain confirmatory. Tests inspect actual D1 state, not in-memory success ports.

### W2 — Monotone bounded stage executor (after W1)

ER-09 Workflow + current stage manifest. Implement canonical §7.7 checkpoints from protocol/scope freeze
through materialization, grouping only inexpensive adjacent stages. Each stage loads immutable handles,
checks expected attempt/current authority/cancel/budget, persists output to R2 then exact receipt/checkpoint
and notifies only afterwards. Workflow completion is engine state, not research disposition. One Workflow
per operation; fan-out default 2, normal max 4, nested 0. Reuse this executor for Q5 exhaustive jobs.
Tests: crash before/after each persisted stage, duplicate Queue delivery, stale attempt, lost receipt ACK,
missing R2 output, cancellation race and 64 KiB+1 step result. PASS: restart resumes the same operation,
no duplicate durable effect, <=64 KiB step outputs (handles only), no long source text in engine state.

### W3 — Model/retrieval attempts and budget settlement (after W2 and #90 Q3)

ER-09 execution, ER-16 gateway and policy context compiler. Build AllowedReferenceManifest from current
scope, tools/verifiers, precision/disclosure and expiry. Capture/admit new URLs as no-effect candidates
before adding them to later manifests. Persist CostQuote/reservation before DEEP/AUDIT/REPORT and each
attempt before a paid call. Gateway keys remain server secrets; no keys in browser/agent/D1/R2.
Tests: known persisted provider result + lost ACK resumes without new call; unknown upstream settlement
remains UNKNOWN with reconciliation/next probe, not a new intent. Count calls/settlements around every
checkpoint; test budget 70/80/90/95/100% actions, consent-required escalation, expiry/cancel before/after
fetch and injected source instructions. PASS: no unauthorized paid retry or tool, no fake zero-cost receipt;
100% exhaustion blocks premium calls while allowed exact/open/trace remain usable. No blanket catch/retry.

### W4 — Evidence Freeze, claim audit, coverage and nine dispositions (after W3)

ER-10 modules + ER-08 debt/reopen records. Freeze exact evidence handles/hashes, denominator, scope,
protocol/lane and model/prompt/tool generations before synthesis. Post-freeze additions create an explicit
reopen and new freeze; rerun affected checks. Audit reference, number/unit/conditions, specification,
method/artifact alignment, source sufficiency AND excerpt sufficiency independently. Preserve rivals,
negative findings and unresolved debt with owner/next probe/review/expiry. E3 requires its actual evidence
and registration, not a model label. Only the exact nine enum values from §7.11 may leave this boundary.
Tests: cropped hedge/negation, stitched quote, number absent from span, recommendation->decision,
hypothesis->observation, stale version, unadmitted source, unknown/sample denominator, post-freeze input
and invalid verifier. PASS: forbidden collapse count 0; accepted citation resolution 100%; unsupported
precision is typed/narrowed; no sampled/unknown NO_MATCH_IN_COMPLETE_SCOPE. Provider/Workflow COMPLETED
cannot upgrade an INCONCLUSIVE/INCOMPLETE_COVERAGE disposition.

### W5 — Hibernation-safe session transport (after W1/W2)

ER-24 `research-session.ts` and versioned ER-21 transport. Route by principal + investigation/chat ID.
Keep only clients, stream cursor, pending approvals and compact presentation state; D1/R2 remain owner
of transcript, ledger, model receipts and artifacts. Persist before notify; authenticate reconnect and
replay the durable cursor, with explicit bounded subscribers/backpressure and no cross-principal stream.
Tests: disconnect/DO eviction/restart, lost notification, duplicate cursor, token rotation, stale/foreign
cursor and slow subscriber. PASS: durable progress survives, no lost/duplicated operation, <=64 KiB
messages and <=256 KiB persisted live DO state; no full source/model output retained only in DO memory.

### W6 — Public run/job/result UI and materialization (after W4/W5 and #94 P2/P3)

ER-21/24 connect `research.run` and versioned status/progress/cancel/result using existing interfaces;
ER-25 adds panels to #98 L1 harness. Consume P2/P3 canonical section/artifact publishing, not another
compiler. Show question/protocol/grade, actual evidence/coverage, debts, budget and honest terminal state.
Test start -> observe -> disconnect/reconnect -> cancel or completed result -> reopen under real local
Worker/D1/R2. PASS: public operations execute instead of pending sentinels; results/trace survive reload;
late results do not override cancellation or repopulate unauthorized UI. Unfinished publication must not
be simulated to close W6; W1–W5 can land independently to avoid a whole-PR dependency cycle.

### W7 — Protocol matrix and live-ready probes (after W1–W6)

ER-23/27 golden + L1 browser tests: ASK/BRIEF, COMPARE, HYPOTHESIS_REVIEW, FACT_CHECK,
PROJECT_VS_LITERATURE_AUDIT, DEEP_RESEARCH and REPORT with appropriate protocol/grade, corpus-only and
captured-web modes. Drive/Google outage must not disable this core. Exercise all §19.2 forbidden-collapse
families and stops. Add Workflow/session/budget suites to #96 O1 runner, including malformed receipt and
missing-input branches. PASS: real local persisted lifecycle and exact accepted references, all failures
preserve partial artifacts and truthful next steps; no claimed live model quality from recorded outputs.

## Verification / remote boundary

Run execution-contract.md commands, research/domain/policy/Worker tests, strict fixtures, L1 browser
loop and exact-head full CI. New pure state/coverage/research semantics name language-contract target
crates and versioned parity tests; no permanent TS/Rust duplicate. All W1–W7 local acceptance is required.

After O7 permits one complete staging deploy: repeat actual Workflow retries, DO hibernation, cancellation,
provider idempotency/uncertain settlement and cost-stop with real gateways, approved budget and retained
redacted receipts. Measure first-token target <4 s after retrieval; DEEP/AUDIT/REPORT stay asynchronous.
Keep failed/missing provider evidence unqualified; no fake billing guarantee. See cloudflare-handoff.md #92.
