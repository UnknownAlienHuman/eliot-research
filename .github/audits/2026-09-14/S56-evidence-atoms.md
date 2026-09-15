# S56 — Connect selective EvidenceAtoms and source-specific profiles

Baseline: `a2aca127`; ER-32/10/39. Reuse existing distillation/argument contracts/ports and exact resolution; no new graph/vector store.

## 1. Problem

Navigation summaries do not preserve the modality/conditions of exact source-local propositions. The architecture forbids a blanket LLM pass over every paragraph at ingest.

## 2. Required change

Connect only the specified triggers to existing extraction/admission: core source, active inquiry, repeated retrieval, comparison/audit/report, suspected contradiction, accepted dependency, or explicit owner request. Persist EvidenceAtoms with exact span/hash/handle, polarity, modality, units, conditions, population, time, and extractor generation. PaperProfile and project-document profiles retain their distinct semantic fields from sections 5.6–5.7.

## 3. Documentation and exact search anchors

[Architecture, sections 5.5–5.7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 5.5. EvidenceAtom' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'Full LLM compilation of every paragraph at ingest is prohibited.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Model candidate → strict schema and exact Evidence resolution → current scope/purge/residency → existing canonical write/outbox. Numbers and quotations must occur in the cited material; models cannot mint evidence IDs. Keep scientific observation, inference, recommendation, and later review claims distinct. Likewise, a project requirement, decision, and implementation claim are not interchangeable.

Identity binds source/extractor/semantic content and required residency. Repeating a trigger cannot re-pay for the same settled extraction. ATOM retrieval uses admitted atoms and current source references, without treating a derived atom as an independent source. Rejected candidates are not indexed as facts.

## 5. Acceptance criteria

- [ ] Recommendation→decision, hypothesis→finding, wrong unit/negation/population/time, fabricated span, and foreign-scope cases fail.
- [ ] Valid paper/project atoms open exact source bytes; trigger replay/restart converges.
- [ ] Ordinary unrelated ingest causes zero atom-extraction LLM calls.
- [ ] Purge prevents atom/ATOM-lane disclosure.
- [ ] Exercise source→trigger→candidate→admission→query and shared Golden cases; record exact SHA/results, with real quality measurements separately.
