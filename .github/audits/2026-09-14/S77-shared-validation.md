# S77 — Share Unicode validation without conflating wire contracts

Baseline `a2aca127`; F23/DUP-01. Complements S28/#220. This is an assignment, not an implemented refactor. Similar function names do not establish identical input contracts.

## 1. Problem

Copies of boundedText repeat Unicode, NUL, and length checks while disagreeing on units and permitted formatting. Replacing them indiscriminately can change valid requests or persisted identities.

## 2. Required change

Extract a pure well-formed-Unicode/length primitive into an existing lower contracts/domain layer. Keep domain-specific permitted characters, error codes, and bounds explicit at the caller. Begin with Wiki owner editing; migrate further callers only after differential tests establish equivalent behavior. Do not force incompatible contracts to agree.

## 3. Documentation and exact search anchors

[Language contract, sections 3–4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md); [Wiki producer](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/wiki-owner-edit-proposal.ts).
```sh
git grep -n -F 'function boundedText' -- apps packages
git grep -n -F 'hasLoneSurrogate' -- apps/eliotr-core/src/wiki-owner-edit-proposal.ts
```

## 4. Implementation approach

For each candidate, record UTF-8-byte versus UTF-16-unit counting, trimming, empty/NUL/surrogate/control handling, and error mapping. The shared primitive reports validity/reason without I/O or changing text; length units are explicit, not inferred defaults. Wrappers retain domain codes/status. Strict input schemas remain authoritative; introduce no validator DSL, new package, or second schema registry.

Use existing canonical fixtures for differential checks. Fix known bugs as separately identified contract/version changes, not accidental refactoring. Inventory remaining serializers against S28 and Rust M2: retain genuinely different byte contracts; remove equivalent recursive implementations when callers switch. This inventory does not authorize an unbounded all-repository rewrite.

## 5. Acceptance criteria

- [ ] BMP/astral/surrogate/NUL/LF/CRLF/empty/max/max+1 cases preserve each migrated caller's accepted bytes and errors.
- [ ] No silent trimming, normalization, or retrospective ID/hash changes; Wiki writes still round-trip through readers.
- [ ] Migrated callers no longer duplicate the primitive; remaining differences are justified by contract, not hidden by LOC counts.
- [ ] Boundary/typecheck, focused differential tests, and caller integration pass. Record exact functions removed, implementing SHA, and results; no new authority service.
