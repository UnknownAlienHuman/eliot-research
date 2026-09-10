# Launch 02 / #90 — Executable retrieval and exact evidence

Read [execution-contract.md](execution-contract.md). Code baseline f94bd7a; no query feature is completed
by this task refresh. Canonical: ELIOT_RESEARCH §§4.10,5.3.1,6.1–6.12,13,15.4–15.5,19.2–19.5,19.10;
language §§5–10. Owners ER-04/05/06/07/16/38/39; ER-30 scope, ER-21/24 transport, ER-25 UI,
ER-23 golden corpus, ER-13 SQL, ER-27 integration. Shared edits are serialized.

## Existing inputs — do not rewrite

Inspect `packages/retrieval/src/{ports,lanes,planner,fusion,service,evidence-resolver,exhaustive}.ts`,
`packages/cloudflare-ai/src/ai-search-managed-read.ts`, `packages/platform-cloudflare/src/ai-search.ts`,
`packages/cloudflare-projection/`, `packages/cloudflare-evidence/`, and Worker
`projection-delivery-handler.ts`, `evidence-service.ts`, `scope-service.ts`. Current managed locators,
projection and exact-resolver adapters already have tests; finish composition instead of a second index.
Existing normalized import is sufficient input to Q1 now; it does not wait for raw conversion #98 L3.

## Ordered local checkpoints

### Q1 — Import-fed D1 IDENT/LEX lane (start here)

Files: ER-06 ports/lanes; ER-38 projection adapter; ER-13 existing Search named queries/migrations;
ER-24 delivery wiring only as approved. Import one real bundle through current HTTP admission, then
explicitly execute its existing outbox dispatcher/Queue handler/projector in local tests (local cron
is absent). Add bounded prepared ID/hash/path probes and FTS candidate reads under a pinned projection
watermark. Preserve source revision, section and generation locator identity; never return FTS text as proof.
Tests: actual D1/R2 import -> outbox -> projection -> lane; duplicate delivery, missing/partial/stale
watermark, purged revision, query syntax injection and max/max+1. PASS: exact replay creates no duplicate
canonical revision; expected candidate comes from the admitted bytes; unavailable, incomplete and valid
empty index are distinct. No prefilled final index, static candidate or new vector database qualifies.

### Q2 — Exact/literal verification and fallback (after Q1)

Files: ER-07 resolver/exhaustive + existing ER-39 evidence adapter. Narrow candidates with D1 and scan
bounded pinned R2 ranges for exact phrase/literal matches. Resolve coordinates through the admitted map;
recheck scope/owner/residency/purge/length/content and excerpt hashes. Reuse existing open/verify receipts.
Unsupported tokenizer falls back to a reviewed projection table, not a native embedded index. Full regex
uses bounded normalized scans, not unbounded SQL or a whole-document allocation.
Tests: Unicode offsets, table/cell/line anchors, old revision while head changes, corrupt/missing map,
range/length/hash mismatch, forged handle and mid-read revocation. PASS: 100% pinned-handle reproducibility
for valid cases; no convenient current-byte substitution; missing precision produces a typed narrower gap.

### Q3 — Query service, scope and durable trace (after Q1/Q2)

Files: ER-04 planner/fusion/service, ER-30 scope service, ER-21/24 `research.query` composition.
Freeze an explicitly authorized scope before retrieval; preserve raw query, literals and negatives.
Execute direct/exact/lexical before optional semantic, fuse ranks, deduplicate canonical sections, maintain
source-family diversity, resolve evidence and persist QueryResult/EvidencePack/trace with their bindings.
Version any new scope profile instead of silently treating the metadata-Lens 64-source bound as a complete
large corpus. All skipped/degraded lanes and omissions are visible; source grants are not minted by a query.
Tests: multi-project UNION/INTERSECT/EXCEPT, expired/changed scope and deny/purge during every read,
same retry versus changed inputs, trace cursor substitution, budget/cancel. PASS: actual API returns a
persisted result and trace with authorized evidence; neither accepted ingest nor HTTP 200 grants coverage.

### Q4 — Managed semantic/literal path and controlled degradation (after Q3)

Files: ER-16 existing managed-read/gateway adapters, ER-04 planner, current `infra/ai-search/` profiles.
Reuse strict locator decoding; bind each item to active instance/embedding/projector generation and D1
manifest. Keep query rewriting off by default, exact raw literals, controlled context_expansion 0–3,
conditional reranking and bounded relevant windows. Do not mix raw vector scores across A/B generations.
Tests with controlled provider replies plus real D1/R2: wrong/extra fields, fake handles, stale/foreign
items, neighboring-chunk disclosure, incomplete B, outage/timeout/cost-stop and malformed response.
PASS: AI Search remains primary relevance when available; valid exact/LEX fallback still works without it;
managed previews never become evidence before Q2. No-hit never becomes complete-scope absence.

### Q5 — Exhaustive job and denominator (after Q2/Q3; execution uses W2 in #92)

Files: ER-07 `exhaustive.ts`, ER-30 scope, ER-09 shared bounded Workflow stages. Partition the immutable
eligible revision set into deterministic shards/cursors; persist partial manifests and reconcile every
shard before final count/group/dedup output. The scanner can be implemented before W2; its actual durable
execution must use W2, not a second workflow service. Never use rerank/top-k to discard a shard.
Tests: all-occurrences corpus with matches beyond first page, empty complete scope, failed/missing/duplicate
shard, sampled/unknown denominator, restart and purge. PASS: exact phrase recall 100% within a truly complete
scope; only all eligible successfully reconciled shards allow NO_MATCH_IN_COMPLETE_SCOPE. Otherwise retain
unknown/partial disposition, exact omissions and restart cursor; no claimed completeness from a row limit.

### Q6 — Query/evidence UI and golden quality (after Q3/Q4; Q5 for exhaustive UI)

Files: ER-25 query/evidence panels, ER-23 `tests/golden-corpus/**`, shared L1 Playwright harness.
Render query product, scope, generations/degradation, exact snippet/native anchor/hash and open/verify
status. No private offline cache. Provide background-job handles for exhaustive work, not a giant response.
Add real RU/EN/project/code/table cases with adjudicated source spans, not answer text generated by the
same tested model. Tests preserve hedges/units/versions/negative findings and distinguish source evidence
from an insufficient cropped excerpt. PASS: exact recall/reproduction 100%, accepted citation resolution
100%, forbidden collapses/leaks 0; labelled semantic Recall@20 initially >=0.90 per §19.4. An unexecuted
managed-quality evaluation stays unqualified and blocks generation promotion, not replaced by mock scores.

### Q7 — Complete local lifecycle and probe (after Q1–Q6)

Register focused `tests/integration/` cases under ER-27. In L1 browser/storage harness:
real import -> actual projection -> query -> verify -> open -> trace; repeat after restart, during managed
outage and after purge/revoke. Add the retrieval suite to O1's shared live runner; implement its missing-
credential, wrong-generation, non-JSON and timeout failure paths locally. PASS: storage/API/UI agree on
exact immutable evidence; no stubs in the path and no forbidden stronger disposition.

## Commands and final acceptance

Run shared full command block plus focused retrieval/cloudflare-ai/cloudflare-projection/evidence tests,
strict Worker fixtures, existing SQL checks and L1 browser suite. All Q1–Q7 local checkboxes are required
before code-complete. Observe <=512 KiB semantic response, <=8 MiB buffered R2 and existing narrower limits.
New pure semantics target canonical language crates (scope/evidence/coverage/projection-core), with
versioned parity inputs; no large new TS domain package or premature authority promotion.

## Live-only work after #96 O7

Real admitted corpus -> actual Queue/projection -> active D1/AI Search generation -> query -> exact R2
open. Retain independent item/count/readback, T2/T3 quality, rank-only shadow, expected-head A->B switch,
cancel/rollback and no partial/mixed-generation exposure. Measure generation-tagged p95 against canonical
exact <800 ms and hybrid <2.5 s targets; retain actual costs. Inject outage/purge during resolution. Follow
cloudflare-handoff.md #90. This plan does not authorize provisioning, paid calls or a partial deployment.
