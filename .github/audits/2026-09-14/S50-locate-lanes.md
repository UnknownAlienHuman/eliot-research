# S50 — Complete LOCATE with literal search, diversity, and structural context

Baseline: `a2aca127`; ER-04/06/07/16/24. Reuse #201's binding fix, #215's fallback correction, and #240's structural resolution rather than reimplementing them.

## 1. Problem

FAST_SEARCH or one semantic lane does not complete canonical LOCATE. Compose existing planners/lanes/fusion with controlled literal/context/reranking operations and a truthful trace.

## 2. Required change

Support LOCATE through the existing query endpoint/codec: IDENT/EXACT first, then applicable LEX/SEM/LITERAL; canonical-section deduplication, source-family diversity, selective reranking, and authorized parent/neighbor expansion before exact resolution. ORIENT uses Atlas #241; VERIFY_EXACT retains its direct path. Align public values/versioning with QueryRequest without renaming existing FAST_SEARCH behavior.

## 3. Documentation and exact search anchors

[Architecture, sections 6.5–6.9](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 6.7. Query pipeline' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 6.9. Query rewriting' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse packages/retrieval planner/lanes/fusion and Cloudflare adapters. Do not reimplement managed chunking, embeddings, or reranking. Preserve raw queries, literals, and negations; rewriting is off by default and any subqueries appear in the trace. Rerank a bounded relevant window, not merely the start of the file. Exact identifiers/quotes do not require a reasoning model and must not disappear because of scoring.

Pin the active generation and never mix raw vector scores from different generations. Resolve each managed locator through canonical policy/residency/purge and exact-byte checks. Mark absent/timed-out lanes explicitly degraded. ATOM/ARGUMENT/WIKI/ARTIFACT lanes are completed with their corresponding stores/tasks; do not add empty success executors here.

## 5. Acceptance criteria

- [ ] Exact-ID/quote cases return reproducible bytes without reasoning calls; vague and tail-literal cases retrieve expected sections.
- [ ] Duplicate passages from one source do not crowd out independent source families.
- [ ] Rewriting, negation, unavailable lanes, and provider outages are represented accurately; no false absence claim occurs.
- [ ] Exercise actual query→R2 evidence→persisted trace, currentness, and replay; record exact SHA/results.
- [ ] Measure Recall@20 later on the real qualified generation rather than claiming it from controlled fixtures.
