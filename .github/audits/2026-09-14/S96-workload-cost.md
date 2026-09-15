# S96 — Measure T6 capacity, latency, overload, and cost

Baseline `a2aca127`; ER-35/17/26. Inputs: attested staging #286, instrumentation #263, build measurements #282, and functioning product paths. Prepare the driver locally, but run live load only against approved resources and budget. This is workload acceptance, not a prediction from source size.

## 1. Problem

Large source files do not prove poor runtime performance; managed Cloudflare capacity does not eliminate application contention, unnecessary model calls, or retry queues. Actual per-operation measurements are required.

## 2. Required change

Run the canonical workload: 5/20/50 read agents, five interactive sessions, ten queued ingestion/projection jobs, and two concurrent long Research Workflows. Separately measure read/open, model-backed runs, indexing, and upgrade/recovery. Test overload with a defined stopping rule rather than repeating until a lucky green run.

## 3. Documentation and exact search anchors

[Production readiness Phase 13](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).
```sh
git grep -n -F '## 15. Phase 13 — execute T6 workload and performance qualification' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Reuse existing workload/probe tools. An external load driver is not another backend. Pin build/config/corpus, concurrency mix, duration/warmup, repetitions, approved maximum spend, and stop condition. Use established profile/operator parameters; do not invent authorization or hide unspecified targets.

Measure p50/p95/p99 and error rates separately by operation, throughput, D1 conflicts, queue lag, R2/AI Search latency, Workflow/DO overhead, CPU, and memory. Distinguish cold/warm behavior and record input/output sizes and cache hit rates. Never repeat unknown external effects merely to collect data.

Use actual usage receipts/provider reporting; label estimated costs separately from bills. Preserve repository targets from S90 rather than substituting vendor maxima for SLOs. Compare Rust and TS on the same family/input with one effect path. Overload must return bounded retryable outcomes/backoff, preserve admitted jobs, and never strengthen research coverage or disposition.

## 5. Acceptance criteria

- [ ] Reproducible per-workload/per-operation results retain samples, percentiles/errors, CPU/memory/throughput/usage/cost, and experimental conditions.
- [ ] Applicable canonical build/startup/PWA and selected-profile SLO/spend targets are measured and pass; unknown or unmeasured targets are not accepted.
- [ ] Overload/cancel/restart produce no unbounded buffers/loops or duplicate paid calls; queues recover and authorized evidence remains readable under model-budget exhaustion.
- [ ] Route bottlenecks to the existing owning task with before/after measurements; do not raise targets to manufacture PASS.
- [ ] Retain exact SHA, commands, and receipts. Local simulation is not live qualification, and a future monthly bill cannot be claimed as measured.
