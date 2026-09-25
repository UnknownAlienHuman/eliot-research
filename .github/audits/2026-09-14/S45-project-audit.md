# S45 — Implement PROJECT_VS_LITERATURE_AUDIT with a traceable matrix

Baseline: `a2aca127`; ER-08/10/11. Inputs: #228/#229/#231/#232.

## 1. Problem

Summarizing project documentation does not verify its claims against literature, standards, or operational evidence.

## 2. Required change

Implement one approved product profile with rows linking project claim/assumption → source version → external normative/empirical evidence → counterevidence → mismatch/gap/alternative/severity → exact support/next probe. Project documents, code snapshots, and literature must be admitted sources rather than unverified live links.

## 3. Documentation and exact search anchors

[Architecture, section 7.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'Project claims and assumptions are mapped to evidence' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Use the existing branch executor, source portfolio, exact resolver, and artifact schema. Distinguish normative requirements, implementation claims, observed execution, and author opinion. A design document cannot establish implemented or measured behavior. Pin code commit/document edition/time. Native code anchors require a qualified bridge; otherwise use exact normalized spans with an explicit precision limitation.

An inaccessible external source becomes acquisition debt, not model reconstruction. Severity is an explained assessment of consequences, not automatically a proven vulnerability. Recommendations do not mutate a client project or create PRs without explicit client authority.

## 5. Acceptance criteria

- [ ] Fixtures distinguish an unverified runtime claim, obsolete specification, conflicting primary evidence, and community opinion with appropriate evidence/limitations.
- [ ] File existence does not become execution PASS; retrieval no-hit does not prove an implementation is absent.
- [ ] Source-level and excerpt-level sufficiency remain distinct, and counterpositions are retained.
- [ ] Replay preserves the run/references; scope isolation and artifact readback are verified.
- [ ] Record actual chain tests and exact implementation SHA.
