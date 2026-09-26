# S90 — Measure deployed artifacts instead of treating source bytes as runtime limits

Baseline `a2aca127`; F24/RT-01, ER-00/17/26. The source-size heuristics in check-budgets.mjs are not deployed bundle measurements. The owner's instruction removes artificial procedural limits, not real memory, request, or security bounds.

## 1. Problem

The checker totals TS/JS source, including tests under src. Moving or compressing source can change that number without improving compressed JS/Wasm, startup, or initial PWA load.

## 2. Required change

Replace misleading runtime proxies with measurements of actual build artifacts and the documented performance targets. Retain source-size/line observations as maintainability information, not incentives to minify methods, hide files, or split meaningless packages. Update existing procedural documentation explicitly; do not introduce waivers or name-based exceptions.

## 3. Documentation and exact search anchors

[Production plan Phase 13](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md); [Language contract section 9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
```sh
git grep -n -F '## 15. Phase 13 — execute T6 workload and performance qualification' -- docs/implementation/production-readiness-plan.md
```

## 4. Implementation approach

Use existing build/check tooling to measure compressed emitted Worker JS plus Wasm, initial first-party PWA JS separately from deferred chunks, startup, heap, and per-operation CPU. Repository targets are Worker <=4 MiB compressed, startup <=400 ms, first-party heap target <=32 MiB, and initial PWA JS <=600 KiB gzip. These are repository objectives, not claimed vendor quotas; record measurement method and environment.

Keep test-only artifacts out of production builds. Preserve scope/request/security envelopes and S76 readability. Refactor real responsibility boundaries, not counts. Improve excessive artifacts through dependency review, tree shaking, lazy assets, and removal of genuine duplication, not silently raising targets. An unavailable measurement is NOT_MEASURED, not PASS. Full live workload qualification remains S96.

## 5. Acceptance criteria

- [ ] Reproducible builds report artifact identities and measured sizes; moving a source file alone does not change the runtime acceptance result.
- [ ] An intentionally oversized dependency/build is detected even with small local source; tests are not shipped.
- [ ] Formatting/semantic regressions pass; no package, service, ignore rule, or minification workaround is added solely for LOC.
- [ ] Existing procedural rules and measurements agree. Record exact SHA, environment, commands, measured targets, and remaining bottlenecks; distinguish local measurements from live T6 results.
