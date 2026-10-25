# Eliot Research — Architecture

This document defines the product and its non-negotiable invariants. It does not claim that a capability is already
implemented. [MAP](MAP.md) orders delivery, [IMPLEMENTATION](IMPLEMENTATION.md) defines executable contracts, and
[DONORS](DONORS.md) limits reuse.

## Mission

Eliot is a private research workspace for one owner and explicitly connected agents. It turns papers, reports, web
captures and working documents into inspectable, cited knowledge without requiring the owner to operate a retrieval
platform.

> **collect → read → understand → ask → compare → save → revise**

The normal path remains simple: add sources, select scope, ask, receive a streamed answer, and open every citation at
the exact passage. Longer work is an explicit bounded job with progress, cost and Stop.

## Product model

A **project** groups sources, chats and knowledge pages. The shared **Library** owns a source once; projects attach it by
membership. Every upload, paste, URL capture, rendered capture, replacement or owner-supplied correction creates an
immutable **source revision** containing:

- the exact captured bytes and provenance;
- one deterministic canonical UTF-8 text when conversion succeeds;
- a deterministic block/page map into that text;
- optional derived guide, claims, digest, glossary and search projection.

Per-project knowledge consists of saved answers, notes, reports, Wiki pages and a project map. Derived material never
silently replaces source evidence.

A citation resolves to `{ revisionId, block, start, end }`, where `start` and `end` are UTF-8 byte offsets in that exact
revision's canonical text. Old citations continue to identify old revisions after replacement or deletion.

## Non-negotiable invariants

### Evidence and provenance

1. Original captured bytes are immutable and retained before conversion starts.
2. A URL is fetched once per revision. The stored record distinguishes requested URL, final redirected URL, HTTP status,
   capture time and capture method. A Workflow converts stored bytes; it never silently fetches the URL again.
3. Canonical evidence contains deterministic extraction only. OCR, image captions, model summaries and AI Search chunks
   are derived aids, not quotation authority.
4. R2 objects use create-once conditional writes followed by exact size/SHA-256 readback. An ETag is transport metadata,
   not content proof.
5. Search indexes are disposable projections. Deleting or rebuilding one cannot change citation identity.

### Scope and authority

1. Every route, chat turn, tool call, job and write carries an explicit project or immutable revision scope. There is no
   process-wide “current project”.
2. Scope is frozen before retrieval and cannot be widened by a model, tool result or client-supplied label.
3. Cloudflare Access is the only login boundary. The Worker verifies the Access JWT and derives the actor; request bodies,
   headers, source text and tool output never mint authority.
4. Owner writes accepted pages. Connected agents may read and propose; they do not silently accept their own output.

### Paid work

1. Page load, list, read, citation open, reconnect and saving an existing result are storage operations only.
2. Before any model, Web Search, billable AI Search or Browser Run dispatch, Eliot atomically reserves a conservative
   upper cost bound in D1 together with the concrete operation.
3. Concurrent requests cannot independently pass a stale monthly-budget check. A failed admission makes no external call.
4. Exact usage settles the reservation. If dispatch occurred but the provider outcome is unknowable, Eliot charges the
   reserved bound rather than pretending the call was free. A reservation is released only when non-dispatch is proven.
5. Automatic paid retries, fallback models and post-failure continuations are disabled. Retry is a new owner-visible
   attempt with a new operation identity and a new budget reservation.

### Durable execution

1. Workflow instance IDs are attempt-scoped. A terminal Workflow is never restarted to perform paid or mutating work.
2. Paid or mutating Workflow steps have platform retries disabled. Safe idempotent reads and create-once writes may use
   bounded retries.
3. D1 and R2 own reopen/history. Workflow retention and event streams are operational aids, not product storage.
4. Stop is cooperative: it prevents the next external call and preserves the latest readable partial result.

### Knowledge quality

1. Eliot distinguishes a source statement from inference and names missing evidence instead of fabricating an answer.
2. Every accepted source-derived claim has a server-resolved citation. Unknown, malformed or out-of-scope labels are
   removed and counted.
3. Numeric claim fields survive only when their digits and conditions are supported by the exact verified quote.
4. Cross-source comparisons require compatible subject/task family, metric, dataset identity, split, protocol, unit and
   direction. A model may suggest aliases; it cannot override incompatibility.
5. Owner edits are never overwritten. Refresh writes a new page revision and marks dependent pages stale explicitly.

### Graceful degradation

- Reading works without models, AI Search or Browser Run.
- Ordinary answering first uses whole sources, then verified claims. AI Search is optional and gated by measured need.
- Static web capture precedes rendered capture.
- When a service, budget or platform spike fails, Eliot exposes the cheaper available path instead of constructing a
  replacement platform inside the application.

## Complete owner capabilities

| Area | Owner-visible result |
|---|---|
| Projects | Create, rename, archive and switch projects; stable project/chat URLs; independent source selection and instructions. |
| Library | Add files, URLs and text; retain originals; see conversion state; detect exact duplicates; attach one source to many projects; replace as a new revision; detach, archive or delete deliberately. |
| Reading | Open original or canonical text, navigate outline/page blocks, copy exact passage links and reopen old revisions without a model. |
| Understanding | One-time guide, suggested questions, verified claims, digest and EN/RU glossary for each readable revision. |
| Ask | Ask in Russian or English over project default, explicit selection or empty scope; stream, Stop, reconnect, reopen history and save an answer. |
| Retrieval | Whole-source reading, verified claims/FTS, and optional gated AI Search for scopes that still do not fit. |
| Knowledge | Versioned notes, answers, reports and Wiki pages; agent proposals; visible dependencies, staleness and refresh. |
| Project map | Topics, strict comparable-result tables, disagreement candidates, gaps and reading routes. |
| Deep research | Explicit Library-first job with fixed limits, optional web discovery/capture, progress, partial result, cost and Stop. |
| Agents | External MCP clients use the same bounded read/propose functions as Eliot. |
| Models | Owner chooses only known routes with dated limits/prices; credentials stay in Cloudflare; private payload logging is off by default. |
| Data ownership | Export originals, canonical texts, claims, pages and citations; preview deletion impact; keep missing evidence visibly missing. |

## Cloudflare system shape

One Cloudflare Worker deployment contains the React/Vite owner app, Hono API, Access verification, Agents SDK chat
routing, stateless MCP endpoint and Workflow classes. HTTP, chat, MCP and Workflows call the same product functions.

| Service | Responsibility | First contour | Boundary |
|---|---|---|---|
| Worker + assets | UI, API, authentication and routing | K0 | one deployment; no second backend |
| D1 | identities, relationships, state, claims, atomic cost reservations and FTS | K1/K2 | no large document bodies |
| R2 | immutable originals, canonical text, block maps, artifacts and page bodies | K1 | create once; exact readback |
| Workflows | ingest, distill, project map and deep research | K1+ | coarse steps; attempts are immutable |
| Durable Objects / `AIChatAgent` | one resumable chat instance per chat ID | K2 | transcript/stream only; D1 owns operation accounting |
| Workers AI + AI Gateway | default model execution and optional provider routing | K2 | explicit route; no automatic retry/fallback; payload logging off |
| AI Search | optional large-library projection | K5 | must pass offset, filter, quality and cost gates |
| Web Search API | web lead discovery | K7 | results are not evidence until captured |
| Browser Run | explicit rendered capture after static fetch fails | K7 | separate paid effect, bounded duration |
| Cloudflare Access | owner and service-token authentication | K0/K4 | hostname applications; Worker validates JWT |

The baseline target is one Workers Paid account. Variable model, search and browser usage is separately admitted and
reported. Current prices and open platform checks are dated in IMPLEMENTATION §16.

## Owner interface

The accepted Material 3 Expressive interface in legacy `packages/ui` and `apps/eliotr-web` is moved, not redrawn. Keep
its semantic tokens, Cyrillic-capable typography, light/dark themes, rail/bottom navigation, touch targets and stable
streaming geometry. Replace legacy runtime/data adapters with the new contracts. A different visual language requires an
explicit owner decision.

## Rules that keep implementation small

1. Deliver caller → product function → durable result → owner-visible reader in one contour.
2. One owner per behaviour. Replace callers and delete predecessors; do not create speculative `v2` layers.
3. Add an abstraction only when it removes present duplication or isolates a platform API already in use.
4. Keep SQL relational and short; keep policy decisions in readable TypeScript.
5. Store bodies in R2 and identities/counts/state in D1.
6. Measure the assembled product on fixed eval material and optimise only the observed bottleneck.
7. Correct the owning document or code; do not create parallel audit/status/receipt bureaucracy.

## Scope boundary

The replacement includes the capabilities above in [MAP](MAP.md) order. Public multi-user sharing, tenancy, connector
marketplaces, automatic personal-memory extraction, graph analytics, audio/video products and a Rust/Wasm rewrite are
later choices. K10 imports useful legacy content before predecessor retirement. Documentation authorises no production
deployment, live-data mutation or legacy-resource deletion by itself.
