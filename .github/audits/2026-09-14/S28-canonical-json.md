# S28 — Remove duplicate query-digest serialization inside retrieval

Baseline: `a2aca127`; ER-04. The specific pair has been selected and read; this is not an instruction to search for an arbitrary duplicate.

## 1. Problem

The local canonicalJson in `packages/retrieval/src/service.ts:106` and canonicalRetrievalJson in `packages/retrieval/src/query-codec.ts` use equivalent recursion: null/boolean/string, safe integers via String, ordered arrays, and object entries excluding undefined with sorted keys. Public error mapping differs. query-persistence.ts already wraps the codec; its wrapper is not a third algorithm. canonicalEvidenceJson is not equivalent for arbitrary numbers/undefined and is outside this replacement.

## 2. Required change

Use canonicalRetrievalJson in the service while preserving RetrievalQueryError(RETRIEVAL_INPUT_INVALID, "query digest input is not canonical") on rejection. Delete the local recursive algorithm and retain only necessary error adaptation. Do not change DTOs or digest-input fields.

## 3. Documentation and exact search anchors

[Language contract, section 3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md); [service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/retrieval/src/service.ts); [codec](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/retrieval/src/query-codec.ts).

```sh
git grep -n -F 'Canonical serialization rules' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
git grep -n -e 'function canonicalJson' -e 'function canonicalRetrievalJson' -- packages/retrieval/src/service.ts packages/retrieval/src/query-codec.ts
```

## 4. Implementation approach

Retain fixtures for actual digest inputs raw_query/product/literals/requested_limit/scope_digest, key permutations, BMP/non-BMP/escapes, null, -0, safe-integer extrema, nested arrays, and undefined object fields. Invalid fractions/NaN/Infinity/undefined root must preserve the service-boundary error. Sparse arrays, cycles, and arbitrary JavaScript objects are not valid wire inputs; verify existing parser rejection rather than normalizing them into new persisted bytes. Keep query-codec's import of service types type-only to avoid a runtime cycle. TypeScript remains the authority until a separate Rust promotion.

## 5. Acceptance criteria

- [ ] Existing request/result/trace fixtures produce byte-identical digests and IDs; historical replay still works.
- [ ] Service error code/message/retryability are unchanged; the codec's own error contract is also preserved.
- [ ] The local recursive body is removed without deleting the necessary persistence wrapper or incompatible evidence serializer.
- [ ] Boundary/typecheck/retrieval tests pass. Record exact before/after, SHA, and commands; do not claim all 26 serializers were removed.
