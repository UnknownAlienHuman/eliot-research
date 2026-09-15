# S23 — Distinguish document-introduction fallback from relevant retrieval

Baseline: `a2aca127`; finding F07. S09/#201 owns SEM wiring; do not duplicate that change here.

## 1. Problem

`selectedDocumentFallbackCandidates` selects early sections by normalized_start_byte and presents them as LEX candidates when direct matching fails. The bytes are genuine, but that does not establish their relevance to the question.

## 2. Required change

Represent fallback as limited orientation rather than a false lexical match. Ensure it does not displace actual SEM/exact results or justify completeness/absence claims.

## 3. Documentation and exact search anchors

[Architecture, sections 0, 6.12, and 7.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'One top-k RAG pass' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 6.12. Retrieval trace' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'selectedDocumentFallbackCandidates' -- apps/eliotr-core/src
```

## 4. Implementation approach

Reuse existing selected_document_fallback metadata and retrieval traces; do not create another search engine. Add a small labeled fixture with an answer near the end, a contradiction outside the initial sections, and a passage reachable only through SEM. Compare direct retrieval and fallback during EvidencePack assembly. Insufficient evidence should produce a truthful limited answer/next probe, not confident conclusions drawn from an introduction. Preserve scoped exact resolution.

## 5. Acceptance criteria

- [ ] Trace/result data distinguishes actual retrieval hits from fallback orientation.
- [ ] Arbitrary introductory sections do not displace relevant SEM/exact evidence.
- [ ] A tail-located answer/counterexample is not replaced with a claim of absence.
- [ ] Unknown/sampled coverage remains explicit; no whole-corpus buffering or blanket model invocation is introduced.
- [ ] Record fixture before/after measurements, tests, and exact SHA. Do not invent a live Recall score from the controlled fixture.
