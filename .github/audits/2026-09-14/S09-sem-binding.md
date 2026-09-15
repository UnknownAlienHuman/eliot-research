# S09 — Pass AI Search into the Research Workflow

Baseline: `a2aca127`; finding F04. A small wiring fix, not a new search system.

## 1. Problem

The internal RETRIEVE_BRANCHES path forwards CORE_DB/SEARCH_DB/EVIDENCE_BUCKET but drops AI_SEARCH. In `research-retrieval-composition.ts`, an undefined binding makes `sem = null`. A separate query endpoint or an existing adapter does not prove that research.run actually uses SEM.

## 2. Required change

Thread the existing AI_SEARCH binding through the complete stage-dependency chain to `retrieveWithHeldScope`. Preserve an explicit degraded path when the binding is absent or fails.

## 3. Documentation and exact search anchors

[Architecture DEC-003 and section 6.12](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'ERC24-DEC-003' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 6.12. Retrieval trace' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'retrieveWithHeldScope' -- apps/eliotr-core/src
```

## 4. Implementation approach

Check types and composition in `research-retrieve-branches.ts`, `research-stage-handlers.ts`, `research-semantic-server.ts`, and `research-retrieval-composition.ts`. Do not bypass generation-registry checks or Evidence resolution. Exercise the same factory used by the actual Worker Workflow. A controlled managed-service response is acceptable in the test; storage, scope checks, and resolution remain real. The relevant fixture passage must be reachable only through SEM, not through a lexical match or the leading-document fallback.

## 5. Acceptance criteria

- [ ] The Research stage actually calls the existing managed adapter.
- [ ] A SEM-only locator resolves to exact authorized R2 bytes and is recorded in the trace.
- [ ] Absent binding/service outage is not represented as successful semantic search; exact/lex retain their specified behavior.
- [ ] Foreign, stale, and purged SEM hits are excluded from evidence.
- [ ] Replay reuses persisted results without repeating completed work. Record tests and exact SHA; a controlled fixture does not establish live retrieval quality.
