# S57 — Build ArgumentMap from source spans, not unconstrained GraphRAG

Baseline: `a2aca127`; ER-32/06/10. Inputs: qualified maps #240 and atoms #248 where needed. Unrelated product PRs are not prerequisites.

## 1. Problem

Keyword/co-occurrence graphs neither explain an argument nor prove causality. The architecture requires source-local problem → premises → evidence → claims → limitations/objections.

## 2. Required change

Complete existing ArgumentMap contracts/ports and persist the relation ledger: node/edge identities, source revision, exact supporting spans, precision class, and unresolved objections. Connect ARGUMENT navigation/retrieval to authorized readers without a separate graph database.

## 3. Documentation and exact search anchors

[Architecture, sections 5.4 and 6.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 5.4. ArgumentMap' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'No graph database in v1.' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse the D1 relation ledger and immutable graph views in existing stores. Preserve distinctions among native, deterministic/parser-derived, model-candidate, and human-reviewed precision. A model-inferred edge cannot become a source-native assertion. Edges reference actual passages and distinguish the author's reasoning from external validation.

Cross-source links require authorization for both sources and explicit lineage; node count is not evidence independence. Same trigger/revision/extractor generation is idempotent, with no blanket full-source distillation. Integrate update/purge dependencies with #247. Expansion uses bounded authorized traversal and cannot loop indefinitely.

## 5. Acceptance criteria

- [ ] Claim/premise/objection/alternative fixtures reconstruct the recorded argument with exact spans.
- [ ] Co-occurrence→causality, recommendation→decision, fabricated/foreign edges, and cropped negation fail acceptance or remain explicitly unaccepted candidates.
- [ ] Cyclic/oversized expansion follows existing byte/step bounds without whole-corpus loading.
- [ ] ARGUMENT queries/navigation do not present graph edges as verified final truth.
- [ ] Record actual storage/replay/purge tests and exact SHA/results.
