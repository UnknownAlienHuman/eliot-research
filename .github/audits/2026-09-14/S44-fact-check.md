# S44 — FACT_CHECK must account for every input claim

Baseline: `a2aca127`; ER-10/11/21. Inputs: #227/#232. Existing claim audit serves generated REPORT output; do not write a second auditor.

## 1. Problem

Auditing generated claims is not equivalent to fact-checking text supplied by the user. The product must not silently omit an inconvenient claim or replace it with a weaker one.

## 2. Required change

Implement an approved FACT_CHECK profile that preserves original input text/hash and maps extracted claims to original regions. Use existing retrieval → freeze → claim audit → artifact. Each claim receives an existing canonical verdict, support/counterevidence, scope/precision, and an explanation of unresolved evidence.

## 3. Documentation and exact search anchors

[Architecture, sections 7.9, 7.12, and 19.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'source may genuinely contain the required evidence' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Treat claim splitting as a candidate transformation with retained original-span mapping. The server assigns identifiers and checks input coverage. Input text is the object being checked, not evidence of its own truth. Reuse AUDIT_CLAIMS schemas/handlers and exact resolution. Keep source_satisfies_requirement separate from supplied_excerpt_supports_requirement.

Cropped negation, stitched quotes, wrong units/populations/versions, and unknown coverage cannot be repaired by persuasive paraphrase. Model majority voting does not resolve a disputed claim. Preserve raw input through normalization; do not create additional public verdict enums. Semantic completeness of claim extraction requires the labeled corpus/quality evaluation as well as mechanical span coverage, not an assumption that IDs alone prove all claims were captured.

## 5. Acceptance criteria

- [ ] A five-claim fixture produces SUPPORTED, PARTIALLY_SUPPORTED, UNSUPPORTED, CONTRADICTED, and NOT_VERIFIABLE_IN_SCOPE without losing input regions.
- [ ] A correct source with an inadequate supplied excerpt is not SUPPORTED; fabricated citations fail.
- [ ] Candidate deletion or weakening of an input claim is detected by the regression fixtures.
- [ ] Resume/replay preserve original mapping and audit receipts.
- [ ] Actual API→artifact/citation tests and exact SHA are retained; real nuanced-quality acceptance remains separate from controlled labels.
