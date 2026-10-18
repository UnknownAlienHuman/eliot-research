# Source lifecycle and compact evidence

Checked 2026-10-18 against Eliot source at `d1098123`, current Cloudflare documentation and pinned donor source.
This is the selected implementation for intake, readable representations, search projection and citations.
It refines the [implementation plan](backend-entrypoints.md) and [runtime notes](runtime-contract.md); it does not
add a service, storage platform, proof system or compatibility programme.

## Product result

One source follows one understandable lifecycle:

```text
raw bytes
  → immutable source revision
  → one readable representation
  → structural ranges where useful
  → disposable native search projection
  → answer/report citations to exact retained bytes
```

A source may belong to several projects without duplicating its canonical bytes. A newer revision does not rewrite
an older report or a running owner's selected material. Search helps locate passages; it never becomes the source
of truth. A citation opens the exact retained revision or reports that it is no longer available. It never silently
substitutes the current head.

## Minimal data ownership

| Concept | Required state | Not required |
|---|---|---|
| Source | Stable logical ID, title/origin and current head | Ownership-transfer protocol, seven residency domains |
| Source revision | Source ID, immutable raw/readable locators, byte length/checksum, parser/version, quality and deletion state | Policy snapshots, witness digests and a reservation state machine |
| Project membership | Project ↔ logical source relationship | Canonical byte copies per project |
| Structural range | Source revision plus exact UTF-8 byte range and optional heading/page/table display coordinate | Embedding-model-dependent chunk identity |
| Search projection | Provider item key, source revision mapping and observable item status | Global index generation, promotion manifest or proof registry |
| Citation | Source revision, readable representation and exact range stored with the report | Global EvidenceHandle authority, authorization receipt or receipt digest |
| Derived note/Wiki/report | Revisioned text and exact supporting citations | Automatic rewrite of an old revision without an expected-version check |

Use existing tables and writers where they already express this state. Do not add a generic representation,
event, receipt or lineage table merely to rename current fields. If more than the raw and one readable
representation are actually retained, one small representation row is justified; otherwise keep the locator on
`source_revision`.

## Intake: write bytes once, then describe them

Start with `packages/cloudflare-raw-ingest/src/`, the existing bundle writer and the source/head D1 writer.
Replace the current admission chain with the following operations:

1. Authenticate the owner at HTTP ingress. Validate file name/type, declared size and request bounds once.
2. Allocate the logical source/revision and immutable R2 key. Use native conditional create. `If-None-Match: *`
   is atomic in R2; a failed or uncertain acknowledgement is reconciled by reading that exact key and comparing
   actual bytes/metadata. Unknown observation is not absence.
3. In one short D1 transaction, insert the source/revision and move the head with an expected-state predicate.
   No network, model, conversion or R2 operation occurs inside the transaction. An orphaned create-once object
   after a failed D1 commit is known by the operation/revision key and can be cleaned without a backup platform.
4. Run one selected conversion outside the transaction. Store its readable bytes immutably, with parser/version,
   content length/hash, quality and error. An optional enhancement may fail without destroying an already usable
   representation.
5. Derive headings and exact byte ranges from those stored readable bytes. Submit the selected native-search item
   or items asynchronously. Direct source reading is already available; indexing is not part of source admission.

The useful public states are `stored`, `readable`, `search_pending`, `search_ready` and `failed`, derived from the
revision and native item status. Do not preserve a generic ten-channel readiness framework if no selected caller
needs those channels. A conversion or indexing failure is local to that derivative; it does not erase the raw
source.

Cloudflare AI Search upload/indexing is asynchronous and item errors are item-scoped. Track the exact item for the
revision. Do not infer whole-corpus readiness from one upload acknowledgement or recreate a provider-wide registry.

## Stable identity is independent of retrieval configuration

`packages/retrieval/src/structural-projector.ts` already computes exact UTF-8 ranges and derives section identity
from source revision, range and heading path. Preserve that useful operation while deleting its generation and
receipt scaffolding.

The identity rules are:

- a source revision is immutable;
- the readable representation bytes for that revision are immutable;
- an ordinary passage is identified by that revision and an exact byte range;
- page/table coordinates are optional display/navigation data mapped to the same bytes;
- parser, chunker, embedding model, reranker and AI Search configuration are diagnostic versions, not evidence
  identity;
- changing retrieval configuration may rebuild the projection but cannot move an existing citation.

SurfSense deliberately pins document splitting independently from the active embedder so an embedding-model change
does not invalidate citations. Eliot already has a stronger primitive—revision-bound byte ranges—so it should not
copy SurfSense's tokenizer or local vector stack. Keep the principle and the existing Eliot ranges.

Structural ranges are useful for navigation and for bounding exact reads. They need not all become AI Search items.
Prefer one readable representation per source revision. Split into deterministic sections only for a real provider
size, format, navigation or disambiguation requirement. Do not upload arbitrary application chunks with repeated
headers and then let the provider chunk them again by default.

## Search projection: per revision, disposable, observable

Change `packages/cloudflare-ai/src/project-search.ts`, `project-search-item.ts` and the retained delivery callers.

Current code uploads every application section to both `private-prose-g2` and `private-literal-g2`, under a
project-specific folder, then gates search through `ai_search_generation_registry`. Replace that with one selected
native hybrid configuration unless a measured exact-term case proves a separate lane is needed.

A provider item key identifies a particular source revision/readable representation. Uploading a newer revision
creates a new item; it never overwrites the old revision's item. Native item status is the readiness signal:
queued/running/outdated are pending, completed is searchable, and error is an explicit failure. Provider index data
is disposable and can be rebuilt from the retained representation.

Project/source scope is a query concern, not part of canonical identity:

- use a supported compact source-revision filter when it fits the actual metadata/filter bounds;
- never truncate the allowed set or post-filter a global top-k while claiming complete scoped retrieval;
- if a large recurring project genuinely needs a provider-side partition, create one disposable project
  projection mapped to the same canonical revisions—not two lanes and application chunks for every project by
  default;
- preserve full D1 identity and current disclosure checks before a passage reaches the model.

The current search readback joins `source.head_rev`. That is wrong for an already admitted owner run: a newer source
head can make the selected old revision disappear mid-run. Search/read callers must accept the run's exact admitted
revision set. A newer head or project detach does not rewrite that set. Purge/deletion or an external client's
current project/operation access may make a revision unavailable and must be reported explicitly.

Retain an old revision's search item while an active run still needs retrieval over it. After those runs settle,
the projection may be deleted; saved reports reopen their exact citation bytes and do not need the old search item.
No permanent reference-count service is required—use existing active run/result records during cleanup.

## Compact citation reference

The report stores a small inline reference, conceptually:

```ts
type CitationRef = {
  source_revision_ref: string;
  representation: "readable";
  start_byte: number;
  end_byte: number;
  display_anchor?: PageRegion | TableCell | LineRange;
};
```

A report-local citation label or ordinal is presentation, not a global authority ID. The canonical range is the
UTF-8 byte range in the immutable readable representation. An optional whole-representation checksum belongs to
the revision/representation, not to every authorization decision or local function call.

Opening a citation performs one direct operation:

1. authenticate the reader and authorize the report/source for that interface;
2. load the referenced source revision and readable locator;
3. reject purged/redacted/unavailable bytes;
4. read the bounded byte range and validate UTF-8/range, plus the representation checksum when observation requires
   it;
5. return the excerpt and optional display coordinate.

There is no need to persist a scope snapshot digest, authorization receipt, credential generation, assurance
ceilings, residency-key digest, resolution receipt and receipt digest for the same owner read. External connected
clients retain their real project/operation check at disclosure time; that still does not require a universal
receipt chain.

Migrate actual saved `EvidenceHandle` references once to compact report citations after inspecting deployed data.
Then remove obsolete handle/receipt writers, readers, tables, codecs and compatibility fixtures. Do not maintain
both systems indefinitely. Coordinate maps remain only for page/table anchors; ordinary byte-range citations do
not require one.

## Context and source-content boundary

Build the stable application/system instruction separately from per-turn source excerpts. This improves provider
prefix caching and makes the trust boundary clear. The server creates short citation labels and groups excerpts by
source. The model may repeat those labels; it cannot invent a new source reference.

Source bytes are untrusted data. They may not:

- add tools or expand scope;
- change budgets, model, system instructions or finish conditions;
- create valid citation labels;
- authorize a network, write or connected-agent operation.

Escape or delimit the exact envelope syntax used by the prompt, but do not treat a regex tag stripper as the
security boundary. Runtime tool validation, admitted source scope and server-owned labels remain authoritative.
Keep `no match`, `selected source still indexing`, `read failure` and `access/deletion failure` as distinct states.
An empty successful search must never hide an unavailable source.

## Derived summaries, Wiki and links

OpenViking's useful idea is overview-before-detail, not its filesystem or a superior tree-search algorithm. Its
current `HierarchicalRetriever` performs one global scoped retrieval with optional reranking; L0/L1 are derived
sidecars. Eliot can use existing headings, SourceCard/guide/Wiki content and bounded reads without a `viking://`
namespace or another vector database.

Derived content follows these rules:

- store exact supporting citation refs with the derived revision;
- mark an affected summary/note stale when a contributing revision changes or is deleted;
- regenerate only on explicit request, selected background maintenance or next meaningful reuse;
- if background refresh is enabled, use both a change threshold and maximum age so rare changes do not leave a
  summary stale forever;
- keep contradictory source-backed observations separate;
- never replace a contributor set with a union that resurrects deleted support.

WeKnora's expected-version page write and body-free revision listing are useful. Its current
`UpdateAutoLinkedContent` and metadata updates still write by page ID without an expected-version predicate. Do not
copy that behavior. Persisted visible text, aliases and source/chunk references change through the same expected
revision/head transition. Pure decoration can be rendered at read time; if it is stored, it is a new revision.

## Concrete replacement map

| Current source | Keep/write | Remove after callers move |
|---|---|---|
| `cloudflare-raw-ingest/raw-normalized-admission-service.ts` and related snapshot/policy files | Small owner intake using conditional R2 create, one D1 source/revision/head write and one conversion result | Policy snapshots, witness digests, TTL reservation states, seven-domain residency/disclosure and receipt chain |
| `retrieval/structural-projector.ts`, D1 Search section writers | Exact UTF-8 structure/ranges and only the projection shape actually used | Projection-generation identity, item-set proof/activation machinery and duplicated arbitrary chunks |
| `cloudflare-ai/project-search.ts` | One native hybrid search, per-revision item status, exact admitted revision set and D1 readback | Prose+literal default duplication, project copies without demonstrated need, generation registry/promotion fences |
| `contracts/evidence.ts`, `retrieval/evidence-resolver.ts`, `cloudflare-evidence/` | Direct compact citation creation/opening against immutable revision bytes | Global handle registry, V1/V2 resolution receipts, authorization/verification receipt chains and assurance/residency envelopes |
| `source_readiness` callers | Concrete readable/search state required by UI and run admission | Unselected channel/generation states and generic readiness orchestration |
| Wiki/artifact writers | Expected-revision body/provenance write; body-free revision list | In-place automatic text/provenance mutation without conflict detection |

Do not delete a shared source reader, erasure operation or report writer merely because a proof wrapper around it is
removed. First move the real caller to the small operation, then delete the superseded chain and its tests.

## Donor decisions

| Donor | Take | Reject |
|---|---|---|
| [SurfSense `176aed2`](https://github.com/MODSetter/SurfSense/blob/176aed261a24a85d217538960e91c59746561bd2/surfsense_local/backend/worker/ingestion/chunking.py) | Server labels, stable instruction vs dynamic excerpts, output reserve, embedder-independent citation identity, short atomic derived-index replacement | SQLite/vector stack, fixed token estimates, regex-only injection defense, chunk ID as canonical Eliot evidence |
| [OpenViking `9cd7786`](https://github.com/volcengine/OpenViking/blob/9cd7786176b005f33ba6ae6fc96f8bbac2455b7a/openviking/retrieve/hierarchical_retriever.py) | Overview before detail, one query embedding, dedupe before optional rerank, derived sidecar freshness metadata | Context filesystem, AGPL code reuse, global memory/graph platform, claim that its retriever recursively traverses a hierarchy |
| [WeKnora `2c0d838`](https://github.com/Tencent/WeKnora/blob/2c0d8384398ca756ee414eef01b71caf91e2caa6/internal/application/repository/wiki_page.go) | Expected-version page update, atomic snapshot+write and body-free revision listings | GORM/store topology, COUNT+OFFSET default, blind automatic link/meta rewrites |
| Cloudflare native APIs | Atomic R2 create-once, D1 short transactions, asynchronous per-item AI Search indexing and native hybrid retrieval | A second application index lifecycle, upload polling inside question/list reads or provider state as canonical source truth |

These are independently implemented behaviors. No donor code or dependency is selected by this document.

Cloudflare references checked 2026-10-18: [R2 conditional-write consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[AI Search Items binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) and
[asynchronous indexing/querying](https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/).

## Completion

This work is complete only when:

- one real upload creates a readable source revision without the old admission/proof chain;
- direct reading works before search indexing finishes;
- a source update creates a new revision without moving old citations or an active owner's admitted revision set;
- native search returns locators that resolve to exact permitted bytes;
- reports store/open compact citations without EvidenceHandle receipt machinery;
- deletion/purge produces an explicit unavailable citation and never substitutes another revision;
- the superseded ingest, evidence and index-generation code, schema and fixtures are removed after the required
  one-time data transition.

During implementation run scoped TypeScript compile/lint and the affected D1/query checks. Final product tests and
measurements follow assembly. This document does not claim the runtime refactor or migration is already complete.
