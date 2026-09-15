# S08 — Bind research.query replay to the requested scope

Rechecked at `a2aca127`, `research-session.ts:113–121`; finding F05. This is a request-binding defect, not an established data leak: stored authority is also validated.

## 1. Problem

Replay computes a digest from the new query/product/limit but takes `scope.digest` from the previous result. It does not compare the new `parsed.scope_expression`. Reusing an idempotency key can therefore return a result for a different requested scope.

## 2. Required change

Bind request identity to the canonical original scope expression. Replay an identical request; reject a changed scope under the same key before performing new writes.

## 3. Documentation and exact search anchors

[Execution contract, section 3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md); [architecture, section 6.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 6.12. Retrieval trace' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'retrievalRequestDigest' -- apps/eliotr-core/src/research-session.ts packages/retrieval/src/query-persistence.ts
```

## 4. Implementation approach

Persist the missing identity in the existing request/result store, or use an already stored unambiguous field. Do not refreeze merely to compare requests: a new timestamp would create a different snapshot. Use the existing scope codec to define canonical expression equivalence. For historical rows lacking sufficient identity, return an explicit incompatibility instead of guessing. Do not rewrite historical digests.

## 5. Acceptance criteria

- [ ] Identical query/key/expression returns the same evidence/trace without additional scopes, grants, or model calls.
- [ ] PROJECT A→B, selected-source substitution, and GLOBAL→PROJECT under the same key conflict.
- [ ] Query/product/limit changes remain detectable.
- [ ] An incompatible replay performs no writes; current revoke/purge checks remain enforced.
- [ ] Add real HTTP/D1 integration tests and retain implementing SHA and before/after results.
