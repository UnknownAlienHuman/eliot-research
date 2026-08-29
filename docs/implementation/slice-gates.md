# Vertical slice gates

A slice is complete only when its user loop crosses the real platform and leaves inspectable receipts.

| Slice | Implementation result | Mandatory completion evidence |
|---|---|---|
| 0 | toolchain, Worker/PWA, D1/R2/Queue/DO/Workflow, AI gateways/search, Drive schema | dry-run bundle budgets; real R2/D1 write/readback; disposable Drive append/readback/reconnect |
| 1 | source lifecycle, normalized ingest, qualification, exact/lexical/semantic retrieval, evidence handles | real admitted revision; exact handle re-open; AI Search locator resolves through R2; negative stale/purge cases |
| 2 | minimum Wiki, semantic API, generic federation, ranged reads, Draft Inbox | immutable page/body + D1 CAS head; federation candidate bundle; transport/completion separation |
| 3 | SourceCard, DocumentMap, ProjectAtlas, multi-project scopes, readiness | orientation UI/API over real corpus; deterministic UNION/INTERSECT/EXCEPT; explicit omissions |
| 4 | Investigation, protocol, obligations, hypotheses, branches, Workflow, coverage | restart/handoff survives; counter-search; exact denominator; honest terminal disposition |
| 5 | EvidenceAtoms, ArgumentMap, audits, Artifact Compiler, full Wiki dependency tracking | claim audit; copy-on-write section update; citation resolution 100%; purge dependency invalidation |
| 6 | failure/security/erasure hardening; optional replacement transport pilot | T5 pass, OAuth revoke/reconnect, blocked purge, clean restore; replacement never runs alongside Drive |
| 7 | code, scholarly, conversation, structured-data specialist profiles | profile-specific exact handles and measured benefit before enabling optional infrastructure |

No agent may mark a live gate complete using a mocked binding, local Miniflare-only result, prose assertion,
or a green type check.
