# Source lifecycle and compact evidence

Checked 2026-10-21 against `main@4655df4d`, current Cloudflare documentation and pinned donor source. This owns
intake, readable representations, search projection and citations. It creates no new service, proof system or
compatibility programme.

## Product result

```text
raw bytes
→ immutable source revision
→ one readable representation
→ exact structural ranges where useful
→ disposable native search projection
→ citations to retained revision bytes
```

A source may belong to several projects without duplicating canonical bytes. A newer revision does not rewrite an old
report or active admitted selection. Search locates candidates; it is not source truth. A citation opens the exact
retained revision or reports unavailable—never the latest convenient head.

## Foundations already merged

Preserve these fixes; do not wrap or reimplement them:

- admitted research payloads use native conditional R2 creation and exact same-key readback;
- missing checksum metadata no longer substitutes the expected digest;
- R2/readback infrastructure failures retain retryability instead of becoming immutable data conflicts;
- persisted Workflow input/checkpoint objects and compact receipt limits are separate bounds;
- freshness duplicate/membership validation reuses a set instead of rescanning the full source array.

These fixes secure predecessor paths; they do not remove the remaining ingest, evidence or index-control machinery.

## Minimal durable ownership

| Concept | Keep | Remove / do not create |
|---|---|---|
| Source | Stable ID, title/origin, current head | Ownership-transfer protocol, seven residency domains |
| Revision | Source ID, immutable raw/readable locators, size/checksum, parser/quality/deletion | Policy snapshots, witnesses, reservation state machine |
| Membership | Project ↔ logical source | Per-project canonical byte copies |
| Passage | Revision + exact UTF-8 byte range; optional page/table/heading coordinate | Embedder-dependent citation identity |
| Search item | Provider key, revision mapping, observable status | Global generation/promotion/proof registry |
| Citation | Revision, representation and exact range stored with output | Global EvidenceHandle authority/receipt chain |
| Derived output | Revisioned text plus exact supporting citations | Blind in-place text/provenance rewrite |

Use existing state where it already expresses this. Add a representation row only if the product really retains more
than raw bytes and one readable representation. Do not create generic event/lineage/receipt tables merely to rename
fields.

## Intake: store once, derive outside the metadata transaction

Start at `packages/cloudflare-raw-ingest/src/`, the object writer, source/head writer and
`packages/platform-cloudflare/src/d1-ingest-commit.ts`.

1. Authenticate at ingress and validate name/type/declared size/request bounds once.
2. Allocate source/revision plus deterministic immutable R2 key. Use conditional create. On uncertain acknowledgement,
   read that exact key and distinguish matching bytes, conflict and unavailable. Observation failure is not absence.
3. Commit source/revision/head metadata through a short D1 expected-state transaction. Revision insert and head CAS
   must depend on the same expected head; a successful zero-row update is not success.
4. Convert outside the transaction. Store one immutable readable representation with parser/version, size/checksum,
   quality and error. Optional enhancement may fail without destroying an already usable result.
5. Derive headings/ranges from stored readable bytes and submit search asynchronously. Direct reading is available
   before indexing.

The current giant D1 commit fan-out/guard must disappear rather than survive behind a new facade. Retain the actual
atomic outcome and a few conditional statements; remove policy snapshots, witnesses, TTL reservation/readiness,
residency/disclosure and operation-receipt scaffolding as their callers move.

A create-once R2 object left after a failed D1 transaction is reconciled by deterministic identity and later guarded
orphan cleanup. Do not add a distributed transaction/backup platform. Useful public states are small: stored,
readable, search pending/ready, failed.

## Stable passage and citation identity

`packages/retrieval/src/structural-projector.ts` already computes exact UTF-8 ranges. Keep the useful range operation
and remove generation/receipt scaffolding.

- Revision and readable bytes are immutable.
- Passage identity is revision + exact byte range.
- Optional page/table coordinates navigate those bytes.
- Parser/chunker/embedder/reranker/search config are diagnostics, not citation identity.
- Rebuilding retrieval may change ranking, never an existing citation.

A retained citation conceptually contains source revision, readable representation, start/end byte and optional
display anchor. Report-local labels are presentation. Whole-object checksum belongs to the representation, not every
authorization or function call.

Opening a citation authenticates the interface, loads that revision, applies real deletion/disclosure, validates the
bounded range/UTF-8 and returns the excerpt. A current owner read does not need historical scope/credential/policy/
residency receipts. A connected client still needs its current explicit disclosure predicate.

After inspecting deployed data and settling active old runs, convert retained EvidenceHandle consumers—reports,
Wiki/derived content and saved research state—to compact refs. Remove obsolete writers/readers/tables/codecs/fixtures
in the same migration; no permanent dual evidence system.

## Search projection is disposable and revision-specific

Change `packages/cloudflare-ai/src/project-search.ts`, item/delivery callers and retained exact readback.

Select one native hybrid configuration unless a measured exact-term case proves a second lane. Prefer one provider
item per useful readable revision; let native chunking work. Split only for an actual provider/format/navigation bound
and retain mapping to original ranges.

Scope is a query concern:

- use compact stable revision metadata/filtering within actual provider bounds;
- never truncate the allowed revision set or post-filter global top-k while claiming scoped completeness;
- use a project projection only for a demonstrated recurring scope native filtering cannot express;
- perform full D1 identity/disclosure readback before model context.

Current search readback must use the run's exact admitted revisions, not join to today's `source.head_rev`. A new head
or project detach does not rewrite an active owner's selection. Purge/deletion or an external client's current
access may make it unavailable and must be explicit.

Remove default prose+literal duplication, unnecessary project copies, `ai_search_generation_registry`, promotion/
fence reads and writer-exclusive managed-item intent/receipt code after callers move. Native item status is readiness;
provider snippets/scores are locators, not citations.

Keep an old revision's item only while an active run needs retrieval over it. Saved reports reopen retained bytes and
do not require the historical index. Use existing run/result records for bounded cleanup; no permanent reference-count
service.

## Source content is untrusted data

Keep stable instructions separate from excerpts. The server issues short citation labels and groups passages by
source. Source/model text cannot add tools, change scope/model/budget/system instructions, alter finish conditions,
issue canonical citations or authorize effects. Escape the actual envelope syntax, but regex stripping is not the
security boundary.

Keep empty search, still indexing, read failure and access/deletion failure distinct. `FULL` refuses overflow or
missing selected material; it never silently truncates and claims completeness.

## Derived summaries and Wiki

Derived content stores exact supporting citations with its own revision. It becomes stale when contributors change or
are deleted and refreshes on explicit request, selected maintenance or meaningful reuse—not every edit. Preserve
source-backed disagreement. Replace contributor sets; never union deleted support back in.

Use existing headings/SourceCard/report/Wiki data for overview-before-detail. Do not add OpenViking's filesystem,
GraphRAG/Mem0 extraction, another DB or blind WeKnora-style page-ID updates. Visible text/provenance changes through
one expected revision/head transition; pure decoration is render-time.

## Remaining replacement map

| Current cohort | Keep/write | Remove after caller migration |
|---|---|---|
| Raw ingest + `d1-ingest-commit.ts` | Conditional objects; short source/revision/head transaction; one conversion | Commit-guard fan-out, snapshots, witnesses, TTL/residency/receipt chains |
| Structural projector/search section writers | Exact ranges and only the projection used | Generation identity, activation proofs and duplicate chunks |
| AI Search project path | One native hybrid query, revision status, admitted set and exact readback | Prose+literal default, unneeded project copies, promotion fences |
| Historical owner scope/policy lease | Direct current owner entitlement; explicit deletion | Scope/participant/lease replay for owner reads |
| Evidence contracts/resolvers | Compact citation create/open | Global handle registry and authorization/verification/assurance envelopes |
| Source readiness callers | Concrete readable/search status needed by UI/admission | Unselected channels/generations and generic orchestration |

Move shared readers, erasure callers and retained-output writers before deletion. Removing code is complete only when
real upload/read/search/cite callers use the selected path and predecessor schema/fixtures are gone.

## Completion

Complete means a real upload becomes readable without the old proof chain; update creates a new revision without
moving old citations; search resolves exact permitted bytes; retained outputs store/open compact refs; purge returns
unavailable; and old ingest/scope/evidence/generation machinery is removed after verified data transition.

Run scoped TypeScript/SQL checks during implementation. Product tests/measurements follow assembly. This document does
not claim the remaining runtime refactor or migration is complete.
