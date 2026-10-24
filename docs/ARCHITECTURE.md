# Eliot Research — Architecture

Target design, audited 2026-10-23. This document defines the product, guarantees and boundaries.
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
Primary evidence citations point to exact UTF-8 byte ranges in the retained readable representation of one source
revision. Original-file page, table and figure coordinates are separate navigation hints with explicit fidelity; they do
not replace the canonical range. Saved-page references open the retained page revision and are labelled derived knowledge;
they do not turn generated prose into an independent primary source.

## Required capabilities

| Area | The complete product must provide |
|---|---|
| Projects | Create, rename, archive, open and switch projects; identify each open project/chat in its URL so separate tabs restore independently; preserve each project's drafts, source selection, chat history, model/tool settings and jobs independently; explicitly compare selected projects and choose where the result is saved. |
| Library | Batch upload files, add URLs or text, keep originals, inspect extraction quality and omissions, edit metadata, detect exact duplicates, attach one source to several projects, replace/reparse into a new revision, exclude from retrieval, detach, archive or deliberately delete. Unsupported, empty or unreliable conversions remain stored and visibly need conversion; they are not silently indexed as readable. |
| Reading | Open the original and canonical readable representation, navigate headings and only observed or verified page/table/figure anchors, inspect retained revisions and obtain a short source card whose coverage is stated. Reading must work while search or model services are unavailable. |
| Retrieval | Find exact identifiers and semantic matches across English and Russian material; filter by project, source, author, date, language, type and tags; preserve source scope before retrieval; return coherent sections and table context rather than arbitrary fragments; distinguish relevant hits from complete coverage. |
| Evidence | Open every citation against retained readable-revision bytes; preserve old citations after source replacement; expose missing, ambiguous, deleted, still-indexing, partially extracted and partially searched evidence honestly; never let a model invent source IDs, byte ranges or original-page coordinates. Generated image descriptions are discovery aids, not literal quotations or OCR. |
| Models | Configure Workers AI, AI Gateway catalog/BYOK routes and compatible custom endpoints through an owner UI; keep a visible capability profile for each selectable model/route (context/output bounds, streaming, tools, structured output and supported input types); choose simple global/project chat and research defaults plus turn/job overrides; never dispatch an operation to a route that does not meet its declared minimum; display the resolved route and billing mode; keep credentials in Cloudflare, not application tables or browser storage. |
| Chat | Ask ordinary questions over explicit/default/empty source scope; stream a grounded synthesis; keep response style/length/instructions and selected model/tools; follow up without losing scope; stop or reconnect; reopen conversations; save a cited answer as knowledge. A no-tool turn performs one synthesis. A tool-assisted turn is explicitly selected, exposes only approved tools and has a short hard-capped tool loop; SDK tool-result auto-continuation is disabled and Eliot admits at most one controlled continuation for the submitted attempt. It never silently becomes deep research. |
| Distillation | Create a quick guide, full source digest, multi-source comparison or research report; process long sources by sections; preserve methods, findings, limitations, disagreements and negative results; record covered, skipped, failed and unextractable material. |
| Analytical reviews | Check claims, review hypotheses and compare project requirements/claims with literature; retain supporting and contrary evidence, conditions, alternatives and unresolved questions. These are profiles of the shared research operation, not a second audit engine. |
| Knowledge | Save, search by content, edit selected sections without regenerating unrelated text, compare, export and reopen accepted notes, digests, reports and Wiki pages with immutable history; mark affected pages stale when inputs change; refresh only affected knowledge; preserve owner edits and rejected proposals. |
| Corpus Map | Provide a compact navigational map of sources, topics, versions/timeline, source families, contradictions, gaps and suggested reading routes. Map edges are derived navigation with exact source links, not a graph database or evidence authority. |
| Audits and maintenance | Show unreadable or unindexed sources, duplicate/version candidates, stale pages, unresolved citations, incomplete extraction/search coverage, abandoned work and removable derived/index data. Produce proposed actions; never auto-delete originals or accepted knowledge. Keep a small attributable activity history. |
| Deep research | Find candidate sources through a lightweight explicit search, or start an explicit durable investigation over selected library scope, optional web discovery and selected external tools; show progress, sources, spending limits, partial findings and cancellation; capture web evidence before citing it. |
| Incoming MCP | Expose Eliot to external agents through standard Streamable HTTP MCP: projects, source search/read/add/update, pages, jobs, tasks and results. Agents may reason with their own models without buying Eliot answer generation; native search/indexing still uses Cloudflare resources. |
| Outgoing MCP | Let the owner connect selected remote MCP servers as tools for Eliot chat/research using the Cloudflare Agents SDK client. Tools are scoped and explicitly enabled; mutating tools require an owner decision or a pre-authorized job, not repeated ceremony around read-only calls. |
| Agent collaboration | Bind a connected agent to verified identity, project scope and operations; let it accept/decline owner offers or claim open tasks; save one attributable result; use review or direct-edit mode per project; make paid Eliot jobs a separate permission. |
| Data ownership | Export originals, readable revisions, conversion profiles and warnings, metadata, knowledge history, citations, tasks and usable chat history. Chat export is a versioned product snapshot built from supported Agent message/state APIs and retained large-body references, not a dump of private SDK tables. Preserve real data and acknowledged outcomes during replacement of the old implementation. |

## What the owner can rely on

### Canonical data before derived convenience

Original bytes and canonical readable text are retained independently of indexes, guides and model output.
A parser, OCR path or corrected mapping creates a new revision. Exact citations address the immutable readable text;
page/table/figure anchors remain separately typed as verified, observed or unavailable. A search index is disposable.
A source card, digest, generated image description, corpus map or Wiki page helps navigate; evidence still opens the
source revision that supported the statement.

Direct Workers AI Markdown Conversion and OCR inside AI Search are not treated as the same pipeline. Eliot publishes a
usable readable head only when it has retained ordered text. A scan whose direct conversion is empty or unreliable remains
`stored_needs_conversion` until an explicit converter returns retained text with declared mapping, or the owner/agent
provides normalized Markdown as a new revision. Hidden index OCR never becomes canonical evidence merely because search
returned a chunk.

### Retrieval is a staged read, not “top-k chunks”

Known material is read directly. Focused questions use scoped hybrid retrieval and then hydrate the necessary
canonical section. Bounded same-scope reading/refinement needs no new owner instruction. Sources, saved knowledge
and a deliberate combined view are distinct search targets; drafts and repeated generated reports cannot masquerade
as additional evidence. Broad comparisons first identify relevant sources and coverage, then open supporting sections.
Tables retain exact captions, headers, units and relevant rows when conversion actually preserved them; uncertain layout
stays prose rather than becoming a fabricated table. Duplicate excerpts do not consume the context budget.
A global top-k result never certifies that every selected document was examined. Indexing failures, unreadable parts,
unprocessed frames/figures and extraction omissions remain in the coverage denominator; a successful search response is
not complete-corpus evidence. Processing all extracted text is not proof that extraction retained every figure, table or
appendix. Reading all sections also does not make a truncated final synthesis complete: retain coverage and output-
completion status separately.

### Several projects do not interfere

There is no server-global active project. Every route, cache key, chat, draft, job and write carries its project
or chat identity. Switching UI tabs does not retarget a stream or write. Cross-project work freezes an explicit
union of permitted source revisions and a destination project. Shared sources remain one Library object. Narrowing
a chat's source scope also narrows model-bound history; old answers cannot silently reintroduce excluded evidence.
Default project scope, an explicit selection and no document scope are distinct intents; an empty list cannot mean both all and none.
Server-saved drafts survive reload without copying private research into browser persistence. Pending chat messages
keep their submitted settings. Project-local contribution does not implicitly authorize rewriting a shared Library
source for every other project; global source changes are explicit owner-authorized operations.

### Knowledge changes visibly

A source update marks dependent pages/maps/audits stale but does not rewrite them. Refresh creates an inspectable
revision or proposal. Owner edits are not discarded by regeneration. Deleted evidence becomes unavailable rather
than silently relinked. Removing a project membership does not delete the shared source. Dependencies remain visible
through digest → Wiki → report reuse. A newly added source can make a project-wide overview incomplete even though
no previous report cited it; show that distinction without regenerating every page. Deliberately historical snapshots
remain historical; a new source version does not make them failed current reviews. Concurrent replacement cannot silently
overwrite a source head published by another operation.

### Execution and spending stay bounded

A no-tool ordinary answer uses bounded context preparation and one synthesis. A tool-assisted turn is explicitly
selected, caps model/tool steps and still ends in one grounded synthesis; it does not enter the durable research
workflow. Model capability/context limits are resolved before rendered context is admitted; an unknown custom route
uses conservative text-only bounds until the owner supplies verified settings. Tool results and approvals cannot trigger
unbounded SDK continuations. Long work runs durably and preserves completed steps. Cancellation stops admission of later
effects once observed; an already dispatched provider call may still finish or be billed. Cloudflare Gateway limits are
used where they fit; Eliot keeps only job-local limits and state needed to explain and resume the work. Unknown cost
remains unknown. Retries, recovery and timeouts are configured at every actual SDK/provider/Workflow boundary; a logging
hook is not a spend-control mechanism. Saving an already generated answer again does not generate or purchase it again.
Opening a project, reconnecting, loading a catalogue or polling status does not admit new model work; generating a guide is explicit.
Model context limits and temporary Workflow/SDK retention must not delete the owner's saved research history.

### Authentication is practical

Cloudflare Access is the authentication boundary, with WebSocket-compatible browser/API protection and a separate
incoming MCP hostname on the same Worker. Browser/API requests, incoming MCP Managed OAuth and service
tokens resolve to an actor once at ingress. Internal functions receive that server-created actor context.
Eliot does not sign every intermediate object, invent an OAuth issuer, encrypt rows with application keys, exchange
proof tickets between modules or require historical qualification before ordinary work.

Secrets remain in Cloudflare-managed storage. Source text and external tool output are untrusted data, not
authorization instructions. Tool availability, source scope and budgets are host-owned settings.

### The owner interface is kept and polished, not redrawn

The existing Material 3 Expressive owner interface (`packages/ui` and `apps/eliotr-web` at the pinned baseline) is the
accepted design. The replacement moves it into the new application and connects it to the new product functions; it
does not introduce another visual language. Keep its colour/type/shape/motion tokens, self-hosted Google Sans, colourful
light and dark themes, the top app bar with navigation rail (bottom bar on phones), the Sources | conversation/reader |
Agents-and-tools panes with one stable scroll owner each, 48 dp touch targets and geometry that does not jump while
answers stream. Changes are polish: plain owner language, fixes for observed usability problems and new screens built
from the same tokens and components. A different look requires an explicit owner decision.

## Corpus understanding without a graph platform

Each source revision has:

- normalized bibliographic metadata and origin;
- original bytes and one immutable canonical readable representation when available;
- converter identity/options, output digest, warnings, known omissions and anchor fidelity;
- a deterministic block/outline map with exact readable-text ranges and optional typed page/table/figure hints;
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
- SQLite-backed `AIChatAgent` Durable Objects for chats;
- one small SQLite-backed owner Tool Connection Agent for outbound MCP connections;
- Cloudflare Workflows for ingestion, research/distillation/map/audit and cleanup.

Declare new Durable Object classes through Cloudflare's current declarative `exports` lifecycle; keep D1 SQL migrations
separate. D1 owns product metadata, relationships and short state. R2 owns originals, canonical readable bodies and larger
immutable derived/chat bodies. One AI Search namespace owns disposable search instances. Start with one shared Library
instance; keep topology behind the retrieval module so measured platform limits can later justify native cross-instance
projections without changing product identity or citations. AI Gateway and AI SDK own model routes. Cloudflare Access
owns sign-in.

Browser, HTTP, incoming MCP and background jobs call the same product functions. A module exists for a product
responsibility, not to mirror every transport or donor.

## Rules that prevent another code tumour

1. Implement one complete user action through caller → product function → durable write → reader.
2. Prefer current Cloudflare APIs and maintained SDKs. Copy a donor mechanism, not its platform.
3. Keep one owner of each fact and one current implementation of each behaviour.
4. Replace callers and remove the predecessor after migration; do not stack `v2`, `v3` and compatibility wrappers.
5. Add an abstraction only when it removes existing duplication or isolates a changing platform API.
6. Keep SQL relational and short. Put workflow decisions in readable TypeScript, not triggers or JSON policy algebra.
7. No custom search engine, billing ledger (per-turn/job usage counters and records of mutating tool calls are ordinary
   D1 state, not a ledger), OAuth issuer, cryptographic proof chain, event-sourcing platform,
   workflow DSL, generic agent governor, converter marketplace or model-qualification service.
8. Do not run a model merely to route every request, approve every chunk or restate a provider result.
9. Parse provider responses for required fields and stable discriminants; do not fail because an API added an unrelated
   field or recreate the old exact-shape contract stack.
10. Audits identify reproducible product problems and proposed actions. They are not an approval bureaucracy.
11. Build vertical slices with scoped compile/lint checks. Evaluate quality and performance on the assembled product,
    then change the measured bottleneck instead of adding speculative machinery.

## Scope boundary

The first complete replacement includes every capability in the table, but delivery is staged in [MAP](MAP.md).
Audio/video studio products, public multi-user sharing, enterprise tenancy, a connector marketplace, automatic
memory extraction, general graph analytics, autonomous self-modification and a Rust/Wasm rewrite are later choices.

Useful content, completed outcomes and known active work from the old system remain until verified migration and
owner-approved cutover. Simplifying the schema must preserve effective access restrictions and revocations, not only bodies.
Documentation authorizes no deployment, production mutation or live-data deletion.
