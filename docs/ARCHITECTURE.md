# Eliot Research — Architecture

This document defines the product and the invariants that implementation must preserve. It does not claim a capability
is implemented. [MAP](MAP.md) orders delivery, [IMPLEMENTATION](IMPLEMENTATION.md) gives the technical contracts, and
[DONORS](DONORS.md) records the mechanisms we may reuse.

## Mission

Eliot is a private, NotebookLM-style research workspace for one owner and the agents that owner connects. It turns a
changing library of papers, reports, web pages and working documents into inspectable, cited knowledge without making
the owner administer retrieval infrastructure.

> **collect → read → understand → ask → compare → save → revise**

The ordinary path stays ordinary: select sources, ask a question, receive a streamed answer, open every citation at the
exact passage. Long work is an explicit job with progress, limits and Stop. Conversion follows an upload; source
understanding requires an explicit request. Page loads, reconnects and saves never start model work.

## Design principles

1. **Canonical text before retrieval.** Keep original bytes and one immutable readable text per source revision. Search
   indexes and model artifacts are disposable projections; they never become primary evidence.
2. **Read whole sources when they fit.** Whole-reading is the default because it preserves context. Verified claims are
   the compact fallback. Passage search is introduced only when measured library scale requires it.
3. **Derive once, reuse everywhere.** A readable revision is converted and distilled once, independent of how many
   projects attach it. Reopening a project, reconnecting a chat or saving an answer performs no paid recomputation.
4. **One toolset for every agent.** Eliot chat, background jobs and external MCP clients use the same small product
   functions: list, outline, read, find claims, search, get page and propose page.
5. **Code controls risk.** Scope, permissions, byte ranges, citation resolution, quote verification, call limits and
   spend admission are deterministic code. Models decide prose and semantic classification, not authority.
6. **Paid effects are explicit and bounded.** Every model/search job has a caller, an upper bound, recorded usage and a
   visible failure state. When a budget is exhausted, the system pauses before the call rather than completing it and
   reporting the bill later.
7. **Cloudflare-native first; optional services behind gates.** Use one Worker, D1, R2, Durable Objects, Workflows and
   Workers AI directly. AI Search and Browser Run arrive only after their contour proves a need and a cost/quality win.
   Do not add KV, Queues, Vectorize, a graph database or another backend without a measured requirement.
8. **Copy mechanisms, not donor platforms.** A donor is pinned to a commit and exact path. Reuse the smallest proven
   mechanism, adapt it to Eliot's data model, retain its licence notice when required, and delete donor-specific layers.
9. **Build by usable contours.** Each contour produces an end-to-end owner capability with real acceptance material.
   Nothing is built merely because a later section mentions it.

## Product model

A **project** groups sources, chats and knowledge pages. The shared **Library** owns each source once; projects attach it
through memberships. A captured or reconverted representation is an immutable **source revision** containing the
original and canonical `text.md`. Per-source **knowledge** consists of a guide, verified claim cards, digest and
glossary. Per-project knowledge consists of an overview, saved answers, notes, reports, Wiki pages and the project map.

A citation resolves to `{ revisionId, block, start, end }`, where `start` and `end` are UTF-8 byte offsets in that
revision's `text.md`. Generated pages are derived material and never silently replace source evidence.

## Complete product capabilities

| Area | Owner-visible result |
|---|---|
| Projects | Create, rename, archive and switch projects; stable project/chat URLs; independent source selection and settings. |
| Library | Add files, URLs and text; keep originals; show conversion states; detect exact duplicates; attach one source to many projects; replace as a new revision; detach, archive or delete deliberately. |
| Reading | Open original or readable text, navigate an outline, reopen exact passage links and old revisions even when models/search are unavailable. |
| Understanding | Requested guide, suggested questions, verified claims, digest and EN/RU glossary per readable revision; deterministic project overview. |
| Ask | Russian or English questions over project default, explicit selection or empty scope; streamed answer, exact citations, stop/reconnect, chat history and Save as page. |
| Retrieval | Whole reading when it fits; verified claims when it does not; AI Search only for scopes that still exceed those modes. Scope is frozen before retrieval and never widened. |
| Knowledge | Versioned notes, answers, reports and Wiki pages; agent proposals; explicit staleness and refresh. |
| Project map | Topics, comparable result tables, disagreement candidates, gaps and reading routes built from verified claims. |
| Deep research | Explicit bounded job over the Library with optional web capture; progress, partial result, cost and Stop. Web material must enter the Library before citation. |
| Agents | External agents connect through MCP, read through the shared tools and write proposals rather than accepted owner pages. |
| Models | Owner selects from provider API catalogues; unknown required metadata blocks paid admission, not selection. Credentials remain in Cloudflare; provider output capacity is separate from job bounds, and the native Flash default is explicit. |
| Data ownership | Export originals, texts, claims and pages; delete with impact preview; missing/deleted evidence stays visibly missing. |

## Owner guarantees

**Evidence survives derived systems.** A new conversion creates a new revision. Existing citations continue to point to
the old text. AI Search can be deleted and rebuilt without changing source truth.

**Answers are honest.** Eliot distinguishes source statements from inference, says when selected sources do not contain
the answer, and never invents page numbers, labels or source names. Every accepted citation is server-resolved.

**No hidden paid work.** Opening, listing, reading, reconnecting and saving existing output are storage operations only.
An ordinary answer is one model call in whole/claim mode or a short capped tool loop in search mode. Distillation runs
at most once for an unchanged revision. Research is an explicit job. Failed streams are not automatically continued.

**Graceful degradation.** Reading works without any model. Whole/claim answering works without AI Search. When a paid
service is unavailable or the budget is exhausted, the UI shows the blocked operation and the cheaper available path.

**Projects do not interfere.** There is no process-wide current project. Every route, chat, job and write carries its
project or immutable revision. Removing a project membership never deletes the shared Library source.

**Knowledge changes visibly.** Replacing or deleting a source marks dependent pages stale. Refresh writes a new page
revision. Owner edits are not overwritten; agent output is proposed.

**Practical security.** Cloudflare Access is the only login. A hostname-based Access application protects the UI/API
and supports the chat WebSocket; the Worker validates the JWT. One owner sees all data. Agent service tokens can read
and propose only. Source text and tool output are untrusted data, never instructions.

## System shape

One Cloudflare Worker deployment contains the React/Vite owner app, Hono API, chat Durable Object classes, Workflows
and the MCP endpoint. Product functions are shared by HTTP, chat, MCP and Workflows.

| Service | Role | Introduced | Cost rule |
|---|---|---|---|
| Worker + static assets | UI, API and routing | K0 | One deployment; no second backend. |
| D1 | identities, relationships, states, claims and FTS | K1 | Relational metadata only; no duplicated document bodies. |
| R2 | originals, `text.md`, block maps, artifacts and page bodies | K1 | Immutable keys; delete orphaned objects later. |
| Workflows | conversion, distillation, project knowledge and research | K1+ | Few coarse steps; large bodies in R2, not Workflow state. |
| Durable Objects / Agents SDK | one resumable chat per chat ID | K2 | Created only for active chats; no background loops. |
| Workers AI | `toMarkdown` and default models | K1/K2 | Cheap default model; usage recorded; monthly model budget checked before calls. |
| AI Gateway | provider routing, analytics, caching/rate limits and optional BYOK | K2 | No external provider by default. |
| AI Search | disposable large-library projection | K5 only | Must pass offset, quality and monthly-usage gates first. |
| Browser Run | rendered web capture | K7 only | Use static fetch first; render only when necessary. |
| Cloudflare Access | owner and agent authentication | K0/K4 | Hostname applications; JWT verified by Worker. |

The target baseline is one Workers Paid account. Variable model and search spend is separately budgeted. Current
Cloudflare prices and inclusions are dated in IMPLEMENTATION §15 and must be rechecked before implementation or a cost
claim.

## Owner interface

The accepted Material 3 Expressive interface in legacy `packages/ui` and `apps/eliotr-web` is moved into the replacement,
not redrawn. Keep its semantic tokens, Google Sans with Cyrillic, light/dark themes, navigation rail/bottom bar, touch
targets and stable streaming geometry. Replace legacy data adapters with the new API; do not copy obsolete runtime or
query layers. A different visual language requires an explicit owner decision.

## Rules that keep implementation small

1. Deliver caller → product function → stored result → reader in one contour.
2. One owner per behaviour. Replace callers and delete predecessors; no speculative `v2` layers.
3. Add an abstraction only when it removes present duplication or isolates a platform API already in use.
4. Keep SQL relational and short; keep decisions in readable TypeScript.
5. Store bodies in R2 and IDs/counts in D1/Workflow state.
6. Measure the assembled product on `eval/`; optimise the measured bottleneck.
7. Reviews change the owning document or code. Do not add audit/report bureaucracy to the repository.

## Scope boundary

The replacement includes the capabilities above in [MAP](MAP.md) order. Public multi-user sharing, tenancy, connector
marketplaces, graph analytics, automatic personal-memory extraction, audio/video products and a Rust/Wasm rewrite are
later choices. K10 imports useful legacy content before retiring the old implementation. Documentation authorises no
production deployment, live-data mutation or legacy resource deletion by itself.
