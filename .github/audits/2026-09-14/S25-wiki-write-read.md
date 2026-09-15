# S25 — Verify Wiki writer/reader agreement for Unicode and references

Baseline: `a2aca127`; F15, P2 hardening. SQL/TypeScript predicates differ, but creating an unreadable row through normal HTTP is not established: parseInput already validates the edit note.

## 1. Problem

SQL length and JavaScript length use different units, and migration 0064's reference-shape check is weaker than validRef. Not every difference is an exploitable defect. However, every record accepted through a supported writer must be readable by the same application.

## 2. Required change

Exercise edit_note and base_evidence_map_ref through supported writer → commit → reader. Correct demonstrated mismatches and reuse structural validation within this operation. Do not invent a reachable vulnerability when the writer already rejects the input.

## 3. Documentation and exact search anchors

[Language contract, sections 3–4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md); [architecture, section 9.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 9.5. Proposal and publication' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'boundedText' -- apps/eliotr-core/src/wiki-owner-edit-proposal.ts
```

## 4. Implementation approach

Use BMP text, emoji, NUL, lone surrogates, valid/invalid references, and boundary lengths. Execute the actual service against D1; comparing copied regexes alone is insufficient. Invalid input must fail before effects. Deliberately corrupted database rows must produce a safe reader failure. Preserve atomic guards, foreign keys, CAS, and immutability constraints. If all supported writers are already safe, finish with regression tests and precise SQL guarantees rather than adding redundant triggers solely to make every predicate identical.

## 5. Acceptance criteria

- [ ] Every accepted supported write round-trips with identical bytes/hashes.
- [ ] Invalid input leaves no new head/receipt/outbox; corrupted readback is not concealed.
- [ ] Length units and Unicode behavior are explicitly documented and tested.
- [ ] No blanket removal of SQL protection or rewriting of historical migrations.
- [ ] Demonstrate reachability for any defect claimed; record tests, exact SHA, and a negative finding honestly when no supported-path defect exists.
