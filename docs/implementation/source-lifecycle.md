# Source lifecycle and compact evidence

Checked 2026-10-18 against Eliot source at `d1098123`, current Cloudflare documentation and pinned donor source.
This is the implementation contract for intake, readable representations, search projection and citations. It
refines the [plan](backend-entrypoints.md) and [runtime notes](runtime-contract.md); it creates no new service,
storage platform, proof system or compatibility programme.

## Product result

```text
raw bytes
  → immutable source revision
  → one readable representation
  → exact structural ranges where useful
  → disposable native search projection
  → citations to the retained revision bytes
```

A logical source may belong to several projects without duplicating canonical bytes. A newer revision does not
rewrite an old report or an active owner's admitted material. Search locates passages; it is not source truth.
A citation opens the exact retained revision or reports it unavailable. It never substitutes the current head.

## Minimal ownership

| Concept | Keep | Remove / do not create |
|---|---|---|
| Source | Stable ID, title/origin, current head | Ownership-transfer protocol, seven residency domains |
| Revision | Source ID, immutable raw/readable locators, size/checksum, parser, quality, deletion state | Policy snapshots, witness digests, reservation state machine |
| Membership | Project ↔ logical source | Per-project canonical byte copies |
| Passage | Revision + exact UTF-8 byte range; optional page/table/heading coordinate | Embedder-dependent chunk identity |
| Search item | Provider key, revision mapping, observable item status | Global index generation, promotion manifest, proof registry |
| Citation | Revision, readable representation and exact range stored with retained output | Global EvidenceHandle authority and receipt chain |
| Derived output | Revisioned text plus exact supporting citations | Blind in-place rewrite of text or provenance |

Use existing tables/writers where they already express this state. Do not add a generic event, lineage, receipt or
representation table merely to rename fields. A small representation row is justified only when the product really
retains more than raw bytes and one readable representation.

## Intake: store once, then derive

Start at `packages/cloudflare-raw-ingest/src/`, the existing object writer and source/head D1 writer.

1. Authenticate at HTTP ingress. Validate name/type, declared size and request bounds once.
2. Allocate source/revision and an immutable R2 key. Use native conditional create. `If-None-Match: *` is atomic;
   reconcile an uncertain acknowledgement by reading that exact key and comparing observed bytes/metadata.
   Unknown observation is not absence.
3. Commit metadata in one short D1 transaction. For an existing source, make the revision insert and head update
   conditional on the same expected head (for example, conditional `INSERT ... SELECT` plus conditional `UPDATE`).
   A zero-row predicate is a conflict/no-op, not success; do not perform an unconditional dependent insert and
   inspect `changes` only after commit. No network/model/R2 work occurs inside the transaction.
4. Run one selected conversion outside the transaction. Store readable bytes immutably with parser/version,
   length/checksum, quality and error. Optional enhancement may fail without destroying an already usable result.
5. Derive headings and exact ranges from those stored bytes. Submit native-search work asynchronously. Direct
   reading is already available; indexing is not part of source admission.

A create-once R2 object left after a failed D1 transaction is identifiable by the operation/revision key and can be
cleaned without a backup platform. Useful public state is small: `stored`, `readable`, `search_pending`,
`search_ready`, `failed`. Keep another readiness channel only for a selected caller.

AI Search upload/indexing is asynchronous and failures may be item-scoped. Observe the exact revision item. Do not
infer corpus readiness from upload acknowledgement or recreate a provider-wide registry.

## Stable evidence identity

`packages/retrieval/src/structural-projector.ts` already computes exact UTF-8 ranges and derives section identity
from revision, range and heading path. Keep that operation; remove its generation/receipt scaffolding.

- Revision and readable bytes are immutable.
- Passage identity is revision + exact byte range.
- Page/table coordinates are optional navigation data mapped to those bytes.
- Parser, chunker, embedding model, reranker and search configuration are diagnostics, not citation identity.
- Rebuilding retrieval may change candidates/ranking, never an existing citation.

SurfSense pins splitting independently from the active embedder so model changes do not move citations. Eliot's
revision-bound byte ranges are stronger; keep the principle, not SurfSense's tokenizer or local vector stack.

Structural ranges need not all become provider items. Prefer one readable representation per revision. Split only
for a demonstrated provider size/format/navigation need. Do not upload arbitrary application chunks with repeated
headers and then ask the provider to chunk them again by default.

## Search projection: revision-specific and disposable

Change `packages/cloudflare-ai/src/project-search.ts`, `project-search-item.ts` and retained delivery callers.
Current code uploads each application section to prose and literal instances under a project folder, then gates
search through `ai_search_generation_registry`. Select one native hybrid configuration unless a measured exact-term
case proves a second lane necessary.

A provider item identifies one revision/readable representation. A newer revision receives a new item; it never
overwrites the old one. Native status is readiness: queued/running/outdated are pending, completed is searchable,
error is explicit failure. Provider data is disposable and rebuildable from retained bytes.

Scope is a query concern, not canonical identity:

- use a supported compact revision filter when it fits actual metadata/filter bounds;
- never truncate the allowed set or post-filter global top-k while claiming complete scoped retrieval;
- use a disposable project projection only for a demonstrated large recurring scope that cannot be represented
  correctly—not two lanes and section copies for every project by default;
- perform full D1 identity/disclosure readback before text reaches the model.

Current readback joins `source.head_rev`. That is incorrect for an already admitted owner run: a newer head can
make its selected old revision disappear. Search/read callers take the run's exact admitted revision set. A newer
head or project detach does not rewrite that set. Purge/deletion, or an external client's current disclosure check,
may make a revision unavailable and must be reported explicitly.

Keep an old revision's search item while an active run still needs retrieval over it. After those runs settle, the
projection may be deleted; saved reports reopen retained bytes and do not need the old index item. Use existing
active-run/result records during cleanup; do not build a permanent reference-count service.

## Compact citation

Retained output stores a small inline reference, conceptually:

```ts
type CitationRef = {
  source_revision_ref: string;
  representation: "readable";
  start_byte: number;
  end_byte: number;
  display_anchor?: PageRegion | TableCell | LineRange;
};
```

A report-local label/ordinal is presentation, not a global authority ID. A whole-representation checksum belongs
to the revision/representation, not every authorization decision or function call.

Opening a citation:

1. authenticates the reader and applies the real interface disclosure check;
2. loads the referenced revision/readable locator;
3. rejects purged, redacted or unavailable bytes;
4. performs one bounded range read and validates the range/UTF-8 plus observed representation checksum where needed;
5. returns the excerpt and optional display coordinate.

The same owner read does not need a scope digest, authorization receipt, credential generation, assurance ceilings,
residency digest, resolution receipt and receipt digest. External clients retain their actual project/operation
check at disclosure time; that still does not require a universal receipt chain.

After inspecting deployed data, drain or settle active old runs, then convert every retained `EvidenceHandle`
consumer that remains product scope—reports, Wiki/derived artifacts and saved research records—to compact citations.
Remove obsolete handle/receipt writers, readers, tables, codecs and compatibility fixtures in the same migration.
Do not keep both systems indefinitely. Coordinate maps remain only for real page/table navigation.

## Source content is data

Keep stable application/system instruction separate from dynamic excerpts. The server creates short citation labels
and groups excerpts by source. The model may repeat supplied labels; it cannot mint a new source reference.

Source bytes may not add tools, expand scope, change budgets/model/system instructions/finish conditions, create
valid labels or authorize network/write/agent operations. Escape the actual envelope syntax, but do not treat regex
tag stripping as the security boundary. Runtime action validation, admitted scope and server labels are authoritative.
Keep `no match`, `still indexing`, `read failure` and `access/deletion failure` distinct.

## Derived summaries and Wiki

OpenViking's useful mechanism is overview-before-detail, not its filesystem or a superior tree algorithm. Its
current `HierarchicalRetriever` performs global scoped retrieval with optional reranking; L0/L1 are derived sidecars.
Eliot can use existing headings, SourceCard/guide/Wiki content and bounded reads without `viking://` or another DB.

Derived content:

- stores exact supporting citations with its revision;
- becomes stale when a contributor changes or is deleted;
- refreshes on explicit request, selected maintenance or next meaningful reuse—not every edit;
- if background refresh exists, uses both change threshold and maximum age;
- keeps contradictory source-backed observations separate;
- replaces contributor sets rather than unioning deleted support back in.

WeKnora's expected-version page write and body-free revision list are useful. Its current auto-link/meta updates
still write by page ID without the same expected version. Do not copy that. Visible text, aliases and provenance
change through one expected revision/head transition. Pure decoration is render-time; stored decoration is a new
revision.

## Replacement map

| Current source | Keep/write | Remove after caller migration |
|---|---|---|
| `cloudflare-raw-ingest/raw-normalized-admission-service.ts` and related policy/snapshot files | Conditional R2 create, one D1 revision/head transition, one conversion result | Policy snapshots, witness digests, TTL reservation, residency/disclosure and receipt chain |
| `retrieval/structural-projector.ts`, D1 Search section writers | Exact UTF-8 ranges and the projection actually used | Projection generation identity, item-set proof/activation and duplicate arbitrary chunks |
| `cloudflare-ai/project-search.ts` | One native hybrid search, per-revision status, admitted revisions and D1 readback | Default prose+literal duplication, unneeded project copies, generation/promotion fences |
| `contracts/evidence.ts`, `retrieval/evidence-resolver.ts`, `cloudflare-evidence/` | Compact citation create/open against immutable bytes | Global handle registry, V1/V2 receipts, authorization/verification and assurance/residency envelopes |
| `source_readiness` callers | Concrete readable/search state needed by UI/admission | Unselected channels/generations and generic readiness orchestration |
| Wiki/artifact writers | Expected-revision body/provenance write; body-free history | In-place text/provenance mutation without conflict detection |

Move shared source readers, erasure operations and report writers before deleting wrappers. Remove the superseded
chain and its tests rather than placing another adapter in front of it.

## Donor decisions

| Donor | Take | Reject |
|---|---|---|
| [SurfSense `176aed2`](https://github.com/MODSetter/SurfSense/blob/176aed261a24a85d217538960e91c59746561bd2/surfsense_local/backend/worker/ingestion/chunking.py) | Server labels, stable instruction/dynamic excerpts, output reserve, embedder-independent evidence identity, short derived-index replacement | SQLite/vector stack, fixed token estimates, regex-only injection defense, chunk ID as Eliot authority |
| [OpenViking `9cd7786`](https://github.com/volcengine/OpenViking/blob/9cd7786176b005f33ba6ae6fc96f8bbac2455b7a/openviking/retrieve/hierarchical_retriever.py) | Overview before detail, one query embedding, dedupe before optional rerank, sidecar freshness metadata | Context filesystem, AGPL code reuse, memory/graph platform, claim of recursive hierarchy traversal |
| [WeKnora `2c0d838`](https://github.com/Tencent/WeKnora/blob/2c0d8384398ca756ee414eef01b71caf91e2caa6/internal/application/repository/wiki_page.go) | Expected-version page update, atomic snapshot+write, body-free history | GORM/store topology, COUNT+OFFSET default, blind auto-link/meta writes |
| Cloudflare native APIs | Atomic R2 create-once, D1 short transactions, asynchronous item indexing, native hybrid retrieval | Second application index lifecycle, polling in reads, provider state as source truth |

No donor code or dependency is selected here. Cloudflare references checked 2026-10-18:
[R2 conditional-write consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[AI Search Items](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) and
[asynchronous indexing/querying](https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/).

## Completion

Complete means:

- a real upload creates a readable revision without the old proof chain;
- direct reading works before indexing finishes;
- update creates a new revision without moving old citations/admitted revisions;
- native search locators resolve to exact permitted bytes;
- all retained outputs store/open compact citations;
- purge returns explicit unavailable and never substitutes another revision;
- old ingest, evidence and generation code/schema/fixtures are removed after the one-time data transition.

Run scoped TypeScript compile/lint and affected D1/query checks during implementation. Final product tests and
measurements follow assembly. This document does not claim the runtime refactor or migration is complete.
