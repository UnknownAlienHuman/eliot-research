# S71 — Make operational failures and existing spend controls observable

Baseline: `a2aca127`; ER-17/26. Reuse S17/#209 error causes and S68/#260 findings; instrument independent paths without waiting for the whole system.

## 1. Problem

READY describes checked component availability, not Research quality. The owner must distinguish unavailable models, denied policy, stale indexes, DLQ growth, and stuck runs without directly querying SQL.

## 2. Required change

Complete existing content-free metrics/health/readiness for latency, conflicts, outbox age, retries/DLQ, index generations, citation failures, model/transport degradation, erasure deadlines, and usage/cost. Connect them to existing Connections/details and the configured alert sink. Do not build another monitoring backend.

## 3. Documentation and exact search anchors

[Production-readiness plan, Phase 12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).

```sh
git grep -n -F '## 14. Phase 12 — establish observability, SLOs and spend controls' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Reuse packages/platform-cloudflare/src/observability.ts, Analytics Engine, health/diagnostic readers, native AI Gateway limits, and Budget Governor. Observations contain operation kind/generation/trace/duration, not prompts, sources, private paths, or credentials. Preserve the architecture's complete observation requirement for security/erasure/DEEP/AUDIT/REPORT failures; sampled ordinary telemetry is not complete coverage.

Measure per-product SLOs, not a single Worker-wide average. Missing telemetry/sinks are unknown/degraded, not zero errors. Expose existing usage/reservation/readback, without introducing another financial subsystem. Model-budget exhaustion must leave authorized exact/open/trace access available.

## 5. Acceptance criteria

- [ ] Injected auth/model/index/Queue/erasure failures show their actual origin/trace and an actionable owner explanation without SQL inspection.
- [ ] Unknown differs from zero; a configured sink receives a real test alert and missing configuration is visible.
- [ ] Log/metric fixtures contain no secrets, sources, or prompts; usage agrees with existing receipts and replay does not double count.
- [ ] Read-only evidence remains usable after model-budget exhaustion.
- [ ] Record actual storage/HTTP metric tests, exact SHA, and separate sink/native-limit receipts.
