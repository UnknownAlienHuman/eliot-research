# Eliot Research — Architecture

Target design, audited 2026-10-22. This document defines the product, guarantees and boundaries.
It does not claim that the replacement is implemented or deployed. [IMPLEMENTATION](IMPLEMENTATION.md)
selects mechanisms, [MAP](MAP.md) locates the work, [DONORS](DONORS.md) records reusable solutions,
and [audits](../.github/audits/README.md) retain dated evidence.

## Mission

Eliot is a NotebookLM-style research workspace for one human owner and connected agents.
It turns a changing library of papers, reports, webpages and working documents into inspectable,
versioned knowledge without making the owner administer a research platform.

The product loop is:

> **collect → read → find evidence → distil → compare → save → revise → audit and prune**

The ordinary path must stay ordinary. A question over selected documents should produce a fast streamed
answer with inspectable citations. Full-corpus comparison, long-document distillation and web research are
explicit longer jobs, not invisible work added to every message.

## Product model

A **project** and a **notebook** are the same stored/UI object. Do not create parallel hierarchies.

The **Library** owns a source once. Projects attach sources through memberships. A source can belong to many
projects without duplicating its canonical bytes. Every captured or reparsed representation is an immutable
**source revision**. Notes, digests, reports, maps, audits and Wiki pages are versioned **knowledge pages**.
A citation points to exact bytes in a retained source revision. Derived prose never becomes primary evidence
merely because Eliot generated or saved it.

## Required capabilities

| Area | The complete product must provide |
|---|---|
| Projects | Create, rename, archive, open and switch projects; use several projects in separate tabs; preserve each project's drafts, source selection, chat history, model/tool settings and jobs independently; explicitly compare selected projects and choose where the result is saved. |
| Library | Batch upload files, add URLs or text, keep originals, inspect extraction quality, edit metadata, detect exact duplicates, attach one source to several projects, replace/reparse into a new revision, exclude from retrieval, detach, archive or deliberately delete. |
| Reading | Open the original and canonical readable representation, navigate headings/pages/tables/code, inspect retained revisions and obtain a short source card whose coverage is stated. Reading must work while search or model services are unavailable. |
| Retrieval | Find exact identifiers and semantic matches across English and Russian material; filter by project, source, author, date, language, type and tags; preserve source scope before retrieval; return coherent sections and table context rather than arbitrary fragments; distinguish relevant hits from complete coverage. |
| Evidence | Open every citation against retained revision bytes; preserve old citations after source replacement; expose missing, ambiguous, deleted, still-indexing and partially searched evidence honestly; never let a model invent source IDs or byte ranges. |
| Models | Configure Workers AI, AI Gateway catalog/BYOK routes and compatible custom endpoints through an owner UI; choose global and project defaults plus chat/job overrides; display the resolved route and billing mode; keep credentials in Cloudflare, not application tables or browser storage. |
| Chat | Ask ordinary questions over explicit/default/empty source scope; stream one grounded synthesis; keep response style/length/instructions and selected model/tools; follow up without losing scope; stop or reconnect; reopen conversations; save a cited answer as knowledge. |
| Distillation | Create a quick guide, full source digest, multi-source comparison or research report; process long sources by sections; preserve methods, findings, limitations, disagreements and negative results; record covered, skipped and failed material. |
| Knowledge | Save, edit, compare, export and reopen notes, digests, reports and Wiki pages with immutable history; mark affected pages stale when inputs change; refresh only affected knowledge; preserve owner edits and rejected proposals. |
| Corpus Map | Provide a compact navigational map of sources, topics, versions/timeline, source families, contradictions, gaps and suggested reading routes. Map edges are derived navigation with exact source links, not a graph database or evidence authority. |
| Audits and maintenance | Show unreadable or unindexed sources, duplicate/version candidates, stale pages, unresolved citations, incomplete coverage, abandoned work and removable derived/index data. Produce proposed actions; never auto-delete originals or accepted knowledge. Keep a small attributable activity history. |
| Deep research | Start an explicit durable investigation over selected library scope, optional web discovery and selected external tools; show progress, sources, spending limits, partial findings and cancellation; capture web evidence before citing it. |
| Incoming MCP | Expose Eliot to external agents through standard Streamable HTTP MCP: projects, source search/read/add/update, pages, jobs, tasks and results. Agents may reason with their own models without buying an Eliot model call. |
| Outgoing MCP | Let the owner connect selected remote MCP servers as tools for Eliot chat/research using the Cloudflare Agents SDK client. Tools are scoped and explicitly enabled; mutating tools require an owner decision or a pre-authorized job, not repeated ceremony around read-only calls. |
| Agent collaboration | Bind a connected agent to verified identity, project scope and operations; let it accept/decline owner offers or claim open tasks; save one attributable result; use review or direct-edit mode per project; make paid Eliot jobs a separate permission. |
| Data ownership | Export originals, readable revisions, metadata, knowledge history, citations, tasks and usable chat history. Preserve real data and acknowledged outcomes during replacement of the old implementation. |

## What the owner can rely on

### Canonical data before derived convenience

Original bytes and canonical readable text are retained independently of indexes, guides and model output.
A parser change creates a new revision. A search index is disposable. A source card, digest, corpus map or
Wiki page helps navigate; evidence still opens the source revision that supported the statement.

### Retrieval is a staged read, not “top-k chunks”

Known material is read directly. Focused questions use scoped hybrid retrieval and then hydrate the necessary
canonical section. Broad comparisons first identify relevant sources and coverage, then open supporting sections.
Tables retain captions, headers, units and relevant rows. Duplicate excerpts do not consume the context budget.
A global top-k result never certifies that every selected document was examined.

### Several projects do not interfere

There is no server-global active project. Every route, cache key, chat, draft, job and write carries its project
or chat identity. Switching UI tabs does not retarget a stream or write. Cross-project work freezes an explicit
union of permitted source revisions and a destination project. Shared sources remain one Library object.

### Knowledge changes visibly

A source update marks dependent pages/maps/audits stale but does not rewrite them. Refresh creates an inspectable
revision or proposal. Owner edits are not discarded by regeneration. Deleted evidence becomes unavailable rather
than silently relinked. Removing a project membership does not delete the shared source.

### Execution and spending stay bounded

Ordinary answers use bounded context preparation and one synthesis. Long work runs durably and preserves completed
steps. Cancellation stops admission of later effects once observed; an already dispatched provider call may still
finish or be billed. Cloudflare Gateway limits are used where they fit; Eliot keeps only job-local limits and
state needed to explain and resume the work. Unknown cost remains unknown.

### Authentication is practical

Cloudflare Access is the authentication boundary. Browser/API requests, incoming MCP Managed OAuth and service
tokens resolve to an actor once at ingress. Internal functions receive that server-created actor context.
Eliot does not sign every intermediate object, invent an OAuth issuer, encrypt rows with application keys, exchange
proof tickets between modules or require historical qualification before ordinary work.

Secrets remain in Cloudflare-managed storage. Source text and external tool output are untrusted data, not
authorization instructions. Tool availability, source scope and budgets are host-owned settings.

## Corpus understanding without a graph platform

Each source revision has:

- normalized bibliographic metadata and origin;
- canonical readable text;
- a deterministic block/outline map with byte ranges and page/table hints;
- an optional generated source card or digest with explicit coverage.

A project may have a versioned Corpus Map rendered as a list, tree, timeline or mind map. Its finite node types
are source, topic, time/version, claim/question and gap; its relations are navigation such as discusses,
version-of, supports, contradicts, qualifies and missing. Claim relations must point to exact source passages and
remain labelled generated or owner-confirmed. The map is stored as one derived page revision and rebuilt
selectively from changed inputs. No Neo4j, generic property graph, community-detection service or graph retrieval
path is required.

## System shape

Use one Cloudflare Worker deployment containing:

- one React/Vite owner application;
- one Hono JSON API;
- one incoming MCP endpoint;
- `AIChatAgent` Durable Objects for chats;
- one small owner Tool Connection Agent for outbound MCP connections;
- Cloudflare Workflows for ingestion, research/distillation/map/audit and cleanup.

D1 owns product metadata, relationships and short state. R2 owns originals, canonical readable bodies and larger
immutable derived objects. One AI Search namespace owns disposable search instances. Start with one shared Library
instance; keep topology behind the retrieval module so measured platform limits can later justify native
cross-instance projections without changing product identity or citations. AI Gateway and AI SDK own model routes.
Cloudflare Access owns sign-in.

Browser, HTTP, incoming MCP and background jobs call the same product functions. A module exists for a product
responsibility, not to mirror every transport or donor.

## Rules that prevent another code tumour

1. Implement one complete user action through caller → product function → durable write → reader.
2. Prefer current Cloudflare APIs and maintained SDKs. Copy a donor mechanism, not its platform.
3. Keep one owner of each fact and one current implementation of each behaviour.
4. Replace callers and remove the predecessor after migration; do not stack `v2`, `v3` and compatibility wrappers.
5. Add an abstraction only when it removes existing duplication or isolates a changing platform API.
6. Keep SQL relational and short. Put workflow decisions in readable TypeScript, not triggers or JSON policy algebra.
7. No custom search engine, billing ledger, OAuth issuer, cryptographic proof chain, event-sourcing platform,
   workflow DSL, generic agent governor or model-qualification service.
8. Do not run a model merely to route every request, approve every chunk or restate a provider result.
9. Audits identify reproducible product problems and proposed actions. They are not an approval bureaucracy.
10. Build vertical slices with scoped compile/lint checks. Evaluate quality and performance on the assembled product,
    then change the measured bottleneck instead of adding speculative machinery.

## Scope boundary

The first complete replacement includes every capability in the table, but delivery is staged in [MAP](MAP.md).
Audio/video studio products, public multi-user sharing, enterprise tenancy, a connector marketplace, automatic
memory extraction, general graph analytics, autonomous self-modification and a Rust/Wasm rewrite are later choices.

Useful content, completed outcomes and known active work from the old system remain until verified migration and
owner-approved cutover. Documentation authorizes no deployment, production mutation or live-data deletion.
