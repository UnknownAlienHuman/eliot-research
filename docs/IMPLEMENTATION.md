# Eliot Research — Implementation

Technical contracts for the contours in [MAP](MAP.md). [ARCHITECTURE](ARCHITECTURE.md) says what the product must do;
this document says how. Build a section only when the current contour needs it. Platform facts carry the date they were
checked; re-check anything older than a few weeks against the installed types and current Cloudflare docs before
relying on it (§15).

| Contour | Sections |
|---|---|
| K0 Shell | §1, §2, §13 |
| K1 Read | §1, §3, §4, §5, §13 |
| K2 Ask | §1, §3, §5, §8, §11, §13 |
| K3 Distill | §1, §3, §5, §6, §8 (claim mode) |
| K4 Agents in | §2, §3, §7, §10 |
| K5 Library scale | §3, §7, §8 (search mode), §9, §15 |
| K6 Project knowledge | §3, §10, §12 |
| K7 Deep research | §3, §4, §7, §10 |
| K9 Lifecycle | §1, §14 |

## 1. Runtime, layout and API

One pnpm package, one Worker, one React/Vite app. The Worker serves the UI (static assets), the JSON API, the chat
WebSocket, the MCP endpoint, the chat Durable Object and the Workflows.

### Source layout

| Path | Owns | Contour |
|---|---|---|
| `src/index.ts` | Hono app, route wiring, error mapping, `export` of DO and Workflow classes | K0 |
| `src/auth.ts` | Access JWT validation, actor resolution, local-dev actor | K0 |
| `src/library.ts` | projects, sources, revisions, memberships | K1 |
| `src/ingest.ts`, `src/workflows/ingest.ts` | conversion, `text.md`, `blocks.json`, IngestWorkflow | K1 |
| `src/blocks.ts`, `src/read.ts` | block scanner, outline, exact range reads | K1 |
| `src/models.ts` | model routes, limits, calls | K2 |
| `src/context.ts` | answer context assembly (whole / claims / search) | K2, K3, K5 |
| `src/citations.ts` | labels, label → range mapping, quote verification | K2, K3 |
| `src/chat.ts` | `ChatAgent` (AIChatAgent) | K2 |
| `src/prompts/*.md` | answer, distill, digest, overview prompts (imported as text) | K2, K3 |
| `src/workflows/distill.ts` | DistillWorkflow | K3 |
| `src/tools/*.ts` | the shared toolset (§7) | K4 |
| `src/mcp.ts` | MCP server | K4 |
| `src/search.ts` | AI Search projection (§9) | K5 |
| `src/workflows/project.ts`, `src/workflows/research.ts` | ProjectKnowledgeWorkflow, ResearchWorkflow | K6, K7 |
| `src/shared/` | types used by both Worker and web (API payloads only) | K0 |
| `src/web/` | React app; `src/web/ui/` is the moved Material design system; `src/web/api.ts` holds the fetch hooks | K0 |
| `migrations/` | D1 migrations, one per contour (§3) | K1 |
| `scripts/eval/` | acceptance scripts, run with `pnpm eval <contour>` | K1 |

Split a file when one responsibility becomes hard to read, not in advance. No service/repository/controller layers;
handlers call product functions `(env, actor, input)` directly, and the same functions back the API, chat tools, MCP
and Workflows.

### Configuration

`wrangler.jsonc` (K0 adds what is not there yet):

```jsonc
{
  "name": "eliot-research",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-24",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/agents/*", "/mcp"]  // "/agents/*" from K2, "/mcp" from K4
  },
  // K1
  "d1_databases": [{ "binding": "DB", "database_name": "eliot", "database_id": "<from setup>", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "eliot" }],
  "ai": { "binding": "AI" },
  "workflows": [
    { "binding": "INGEST", "name": "eliot-ingest", "class_name": "IngestWorkflow" }
    // K3: { "binding": "DISTILL", "name": "eliot-distill", "class_name": "DistillWorkflow" }
    // K6: PROJECT_KNOWLEDGE / ProjectKnowledgeWorkflow; K7: RESEARCH / ResearchWorkflow
  ]
  // K2: "durable_objects": { "bindings": [{ "name": "CHAT", "class_name": "ChatAgent" }] },
  //     "exports": { "ChatAgent": { "type": "durable-object", "storage": "sqlite" } }
  // K3: "triggers": { "crons": ["* * * * *"] } for the distillation scheduler (§6); K9 adds a daily sweep
  // K5: "ai_search": [{ "binding": "SEARCH", "instance_name": "library-v1" }]
  // K7: "browser": { "binding": "BROWSER" } for rendered pages
}
```

The `/agents/*` entry in `run_worker_first` and the `CHAT` binding arrive with K2; K0 only needs the assets, the
Worker entry, `workers_dev: false` and `preview_urls: false`.

Worker variables (plain vars unless marked secret): `ACCESS_TEAM`, `ACCESS_AUD_UI`, `ACCESS_AUD_MCP` (K4),
`OWNER_EMAIL`, `UI_ORIGIN` (e.g. `https://research.example.org`), `OWNER_SERVICE_CLIENTS` (comma-separated Access
service-token client IDs that act as the owner, for eval and automation), `MCP_ALLOWED_CLIENTS` (K4),
`DISTILL_CONCURRENCY` (K3, default 2), `ELIOT_LOCAL_DEV` (only in `.dev.vars`).

Already pinned in `package.json` and first used in: `zod` (K1), `ai` and `@cloudflare/ai-chat` (K2), `agents` and
`@modelcontextprotocol/server` (K4). Generate binding types with `wrangler types` and commit the output; never hand-write `Env`. Add `hono`, `jose` and
`vitest` in K0, `tsx` in K1 (eval scripts). Dependency versions are pinned in `package.json`; do not bulk-upgrade them for an unrelated change.

Durable Object classes use the declarative `exports` lifecycle with SQLite storage; D1 schema changes are files in
`migrations/`. Workflows are declared once and started through their bindings.

### Account setup (once)

1. `wrangler d1 create eliot`, `wrangler r2 bucket create eliot`; put the D1 ID into `wrangler.jsonc`.
2. Custom domain `research.<domain>` (UI, API, chat WebSocket) on this Worker; in K4 add `mcp.research.<domain>`.
3. A self-hosted Cloudflare Access application for `research.<domain>` (owner email policy plus a service-token policy
   for `OWNER_SERVICE_CLIENTS`); in K4 a second one for the MCP hostname. Record audience tags and the team domain in
   the variables above.
4. K5: `wrangler ai-search create library-v1 --type builtin` in the `default` namespace with the settings in §9.
5. Model keys for external providers live in AI Gateway (BYOK) or Worker secrets — never in D1 or the browser.

Write these steps into `scripts/setup.sh` as they are first performed, so the next environment needs no manual work
beyond the Access applications.

### HTTP API

JSON under `/api/`, validated with zod. Errors are `{ "error": { "code", "message" } }` with codes `invalid`,
`not_found`, `conflict`, `busy`, `unavailable`; messages are plain owner language. Lists use `?cursor=&limit=` and
return `{ items, nextCursor }`. Two writes are idempotent by design and need nothing else: a chat turn (`turnId` in the
body, primary key of `chat_turn`) and a page revision (`mutationId` in the body, unique in `page_revision`). Uploads are
not deduplicated automatically; the SHA-256 notice handles repeats. There is no generic idempotency layer. The browser
never retries a mutation by itself. Project work is addressed
by `:projectId` in the path.

| Route | Purpose | Contour |
|---|---|---|
| `GET /api/health`, `GET /api/me` | liveness; actor and configured services | K0 |
| `GET/POST /api/projects`, `GET/PATCH /api/projects/:projectId` | list, create, open (summary and sources; K2 adds instructions, K3 the overview), rename, archive | K1 |
| `POST /api/projects/:projectId/sources` | add files (`multipart/form-data`, one file per part), a URL or text; returns created sources | K1 |
| `GET /api/projects/:projectId/sources` | sources with readable state and `sha256` (K3 adds guide summary and distill state) | K1 |
| `PUT/PATCH/DELETE /api/projects/:projectId/sources/:sourceId` | attach an existing source / set `{ enabled }` / detach | K1 |
| `GET/PATCH /api/sources/:sourceId` | source and its revisions; PATCH changes the title (authors and year are filled by K3) | K1 |
| `POST /api/sources/:sourceId/revisions` | replace file, reconvert, or supply owner Markdown | K1 |
| `GET /api/revisions/:revisionId` | outline, blocks, converter, warnings (K3 adds distill state) | K1 |
| `GET /api/revisions/:revisionId/text?start=&end=` | exact UTF-8 byte range of `text.md`; without `start`/`end` the whole text | K1 |
| `GET /api/revisions/:revisionId/original` | original file | K1 |
| `GET/POST /api/projects/:projectId/chats`, `PATCH /api/chats/:chatId` | chat list, create, rename, archive | K2 |
| `GET /agents/chat/:chatId` (WebSocket) | checked against D1, then routed to that chat's `ChatAgent`; the browser streams here | K2 |
| `POST /api/chats/:chatId/turns` | run one turn and wait for it: `{ turnId, question, scope, mode? }` → answer, citations, metrics (§8); used by eval and later tools | K2 |
| `GET /api/settings`, `PATCH /api/settings` | default answer model (K3 adds the distill model); `PATCH /api/projects/:projectId` sets the project override `answerModel` | K2 |
| `GET/POST /api/projects/:projectId/pages`, `GET /api/pages/:pageId` | list, save answer / note, read page with citations | K2 |
| `GET /api/revisions/:revisionId/knowledge` | guide, claims, digest, glossary and the distillation report | K3 |
| `POST /api/page-revisions/:revisionId/decision` | accept or reject a proposal | K4 |
| `POST /api/projects/:projectId/search` | search (same function as the `search` tool) | K5 |
| `POST /api/projects/:projectId/map/refresh`, `POST /api/pages/:pageId/refresh` | rebuild map / refresh a stale page | K6 |
| `POST /api/projects/:projectId/wiki` | write a Wiki page for one map topic: `{ topicId, mutationId }` | K6 |
| `GET/POST /api/projects/:projectId/jobs`, `GET /api/jobs/:jobId`, `POST /api/jobs/:jobId/cancel` | research jobs | K7 |
| `GET /api/sources/:sourceId/impact`, `POST /api/sources/:sourceId/archive`, `DELETE /api/sources/:sourceId` | projects and pages that cite the source; archive; delete | K9 |
| `GET /api/projects/:projectId/export` | ZIP export | K9 |

The MCP endpoint (`POST /mcp` on the MCP hostname) exposes the toolset (§7); it is not a second API.

### Payload shapes

Types live in `src/shared/api.ts` and are the contract between Worker, web app and eval scripts. Core shapes:

```ts
type ReadableState = "pending" | "readable" | "readable_with_warnings" | "needs_conversion" | "failed";
interface Project { id: string; title: string; description: string; archivedAt: number | null; updatedAt: number }
interface SourceRow {
  id: string; title: string; kind: "file" | "url" | "text"; language: string | null;
  revisionId: string | null; readableState: ReadableState; warning: string | null; error: string | null;
  sha256: string | null; enabled: boolean;
  // K3: authors, published, distillState, guideSummary
}
interface Block { i: number; kind: "heading" | "para" | "list" | "table" | "code" | "quote"; level?: number; heading: string; start: number; end: number }
interface RevisionView {
  id: string; sourceId: string; converter: string | null; readableState: ReadableState; warning: string | null;
  readableSize: number | null; blocks: Block[];
}
interface Citation { label: string; revisionId: string; block: number; start: number; end: number; sourceTitle: string; deleted: boolean }
interface Claim {
  id: string; kind: "method" | "result" | "limitation" | "dataset" | "definition" | "other"; statement: string;
  task: string | null; metric: string | null; dataset: string | null; value: string | null; conditions: string | null;
  quote: string; block: number; start: number; end: number;
}
interface Knowledge {                                   // K3, GET /api/revisions/:id/knowledge
  guide: { summary: string; questions: { q: string; blocks: number[] }[] } | null;
  claims: Claim[]; digest: string | null; glossary: { term: string; en: string; ru: string; definition: string; block: number }[];
  report: { kept: number; dropped: number; reasons: Record<string, number>; inputTokens: number; outputTokens: number; model: string } | null;
}
interface PageView { id: string; kind: string; title: string; freshness: "current" | "stale"; revisionId: string;
  status: "accepted" | "proposed" | "rejected"; markdown: string; citations: Citation[] }
interface TurnResult {
  turnId: string; answer: string; citations: Citation[]; contextMode: "whole" | "claims" | "search" | "none";
  inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null;
  firstTokenMs: number | null; totalMs: number; invalidLabels: number; state: "completed" | "partial" | "failed" | "cancelled"; error?: string;
}
type Scope = { mode: "project_default" } | { mode: "explicit"; sourceIds: string[] } | { mode: "empty" };
```

Upload: `POST /api/projects/:projectId/sources` with `multipart/form-data` parts `file` (repeatable), or JSON
`{ "url": "..." }` / `{ "title": "...", "text": "..." }`; response `{ items: SourceRow[] }`. One request carries at most
100 MB in total (Workers request limit); the UI and eval split larger batches into several requests.

## 2. Access and actor

Cloudflare Access is the only sign-in. Each hostname has its own self-hosted Access application: the UI hostname
admits the owner's browser session and the owner-level service tokens in `OWNER_SERVICE_CLIENTS` (eval, automation);
the MCP hostname (K4) admits agent service tokens and may add Access Managed OAuth for interactive clients later. An
unauthenticated browser is redirected to the Access login and never reaches the Worker. Do not use Worker-level Access
for the UI hostname: it rejects WebSocket upgrades.

`src/auth.ts` runs once per request (and once per WebSocket upgrade):

1. Read `Cf-Access-Jwt-Assertion`; verify signature, issuer `https://<ACCESS_TEAM>.cloudflareaccess.com`, the
   hostname's audience and expiry with `jose` and a cached JWKS (`/cdn-cgi/access/certs`).
2. Map to an actor: `email` equal to `OWNER_EMAIL`, or a service-token `common_name` in `OWNER_SERVICE_CLIENTS` →
   `owner`; a `common_name` in `MCP_ALLOWED_CLIENTS` (MCP hostname only) → `agent:<client-id>`. Anything else → 403.
   Missing, invalid, expired or wrong-audience assertions → 403 (unit tests cover each).
3. For requests carrying a browser session cookie (mutations and WebSocket upgrades) require `Origin` = `UI_ORIGIN`.
   Service-token requests carry no cookie and need no Origin.
4. Pass `actor` to product functions. No per-row or per-result permission checks inside: one owner, everything the
   owner can see is visible; agents can read everything and write only proposals.

Local development: when the Worker variable `ELIOT_LOCAL_DEV=1` comes from `.dev.vars` and the request host is
`localhost` or `127.0.0.1`, the actor is `owner` without a JWT. A deployed Worker that sees `ELIOT_LOCAL_DEV` refuses
all requests. Local runs use local D1/R2; AI and AI Search bindings use `remote: true` when needed.

## 3. Data

### Tables

One migration per contour; the files own all column and state names:

| File | Contour | Adds |
|---|---|---|
| `migrations/0001_library.sql` | K1 | `project`, `source`, `source_revision`, `project_source` |
| `migrations/0002_ask.sql` | K2 | `settings` (seeded with the default answer model), `project.instructions`, `project.answer_model`, `chat`, `chat_turn`, `page`, `page_revision` |
| `migrations/0003_distill.sql` | K3 | `settings.distill_model`, `source.authors`, `source.published`, distillation state, token and `guide_summary` columns, `claim` |
| `migrations/0004_agents.sql` | K4 | `claim_fts` (trigram), backfilled from existing claims |
| `0005_search.sql` (to write) | K5 | `source_revision.search_item_id`, `search_state` |
| `0006_jobs.sql` (to write) | K7 | `job` |

Do not add a table before the contour that reads it. Columns needed by a later contour are added by that contour's
migration unless the table is created in the same contour and the column is part of its identity or state.

| Table | Holds |
|---|---|
| `settings` | default answer and distill model routes |
| `project` | title, description, standing answer instructions, model override |
| `source`, `source_revision` | one Library source; immutable revisions with conversion and distillation state |
| `project_source` | many-to-many membership; `enabled = 0` keeps a source out of answers |
| `claim`, `claim_fts` | distilled claim cards with exact quote ranges (K3); trigram FTS for substring search in any language (K4) |
| `chat`, `chat_turn` | chat inventory; one row per turn with scope, context mode, tokens, timings, error |
| `page`, `page_revision` | project knowledge pages and their revisions (accepted, proposed, rejected) |

### R2 keys

All objects are written once under identity-specific keys and never overwritten.

```text
source/<revision>/original          uploaded bytes
source/<revision>/text.md           canonical readable text (UTF-8)
source/<revision>/blocks.json       block map (§5)
source/<revision>/guide.md          K3 source guide
source/<revision>/digest.md         K3 digest
source/<revision>/glossary.json     K3 EN/RU glossary
source/<revision>/distill.json      K3 raw extraction output and verification report
source/<revision>/chunks.json       K5 AI Search chunk id → byte range
page/<revision>/body.md             page Markdown
page/<revision>/citations.json      resolved citations for that page revision
page/<revision>/data.json           K6 structured data of a map page (§12)
```

### Writes

- IDs are UUIDs generated by the Worker. Timestamps are Unix milliseconds.
- New immutable objects first (R2), then the D1 row that points to them. A failed D1 write leaves an unreferenced R2
  object that the K9 cron sweep removes.
- Heads are the only compare-and-set: `source.current_revision_id`, `page.head_revision_id`. Update with
  `... WHERE id = ? AND <head> IS ?` and check the change count; on zero rows return `conflict`.
- `page_revision.mutation_id` and `chat_turn.turn_id` make retries return the existing row.
- Scope lists are small JSON arrays in the row that used them (`chat_turn.scope_json`, `page_revision.inputs_json`).
  Promote to join tables only if a real query becomes slow.

## 4. Ingest and conversion

### Admission

`POST /api/projects/:projectId/sources` accepts several files at once; each file becomes one source and one revision.
For each: check size, read the file into memory (≤ 25 MB), hash it with `crypto.subtle.digest("SHA-256", bytes)`, write
`source/<rev>/original`, create rows (`readable_state = 'pending'`, shown as "Converting"), return the created sources
immediately and start `IngestWorkflow` with instance ID `ingest-<revision>`. An identical SHA-256 already in the
Library is reported ("already in Library as …") with an Attach action; it is not merged silently. Scripts and agents
avoid duplicates by checking `sha256` in the sources list before uploading.

Limits: file ≤ 25 MB; URL capture ≤ 10 MB; pasted text ≤ 2 MB; readable `text.md` ≤ 10 MiB (AI Search item limit).
A larger readable text is kept and readable but marked `readable_with_warnings` ("too large to index").

### Conversion (IngestWorkflow step `convert`)

| Input | Converter | `converter` value |
|---|---|---|
| `.md`, `.txt`, `.csv`, valid UTF-8 text | used as is (BOM removed, line endings kept) | `local_text` |
| PDF, DOCX, XLSX, PPTX, ODT, HTML, images and other formats in the cached `env.AI.toMarkdown().supported()` list | `env.AI.toMarkdown({ name, blob })` as in the legacy donor; confirm the signature in the generated types | `workers_ai_markdown` |
| URL | `fetch` with `Accept: text/markdown, text/html;q=0.9`; Markdown response used as text, HTML converted with `toMarkdown` | `local_text` / `workers_ai_markdown` |
| JavaScript-rendered page (K7, needs a `BROWSER` binding) | Browser Run `/markdown` quick action | `browser_markdown` |
| Owner/agent-supplied Markdown for a scan | stored as a new revision | `owner_markdown` |

Read only the documented result fields (`format`, `data` or `error`, `tokens`) and ignore unknown ones. Cache the
`supported()` list in a module variable for the life of the isolate; do not call it per upload.

Result states:

- `readable` — non-empty UTF-8 text, no warnings.
- `readable_with_warnings` — usable, with a one-line `warning_summary` for exactly these cases: little text
  extracted (readable bytes < 1 % of original bytes for a PDF over 100 KB), the input was an image (its text is a
  generated description, not literal text), the input was a GIF (first frame only), `text.md` over 10 MiB (too large
  to index).
- `needs_conversion` — empty or unusable text (typically a scan). The original is kept; the reader shows "This file
  needs text conversion" with an action to upload Markdown. AI Search OCR output is never used as source text.
- `failed` — conversion error; the reader shows the error and Retry.

A replacement or reconversion creates a new revision; the source's current revision advances only to a readable one.
Old revisions stay readable for old citations.

### URL guard

HTTPS only (HTTP allowed only when the owner explicitly confirms); no credentials in the URL; no IP literals, `localhost`,
private or link-local ranges; at most 5 redirects, each re-checked; size and 20-second time limits; store the final URL in
`source.origin_url`; the revision's `created_at` is the capture time. Do not claim DNS pinning.

### Language

Detect `en` / `ru` / other by character script ratio of the first 50 KB; store in `source.language`.

## 5. Blocks, labels and citations

### Block map

`blocks.json` is an array produced by `src/blocks.ts` from `text.md`:

```json
[{ "i": 0, "kind": "heading", "level": 1, "heading": "Attention Is All You Need", "start": 0, "end": 27 },
 { "i": 1, "kind": "para", "heading": "Abstract", "start": 29, "end": 1180 }]
```

- `kind`: `heading`, `para`, `list`, `table`, `code`, `quote`.
- `start`/`end`: UTF-8 byte offsets in `text.md`, `end` exclusive. Computed on bytes, not JavaScript string indices.
- `heading`: the nearest heading text above the block (for display and labels).
- Blocks follow paragraph boundaries; paragraphs longer than ~1,500 tokens split at sentence ends; tables and code
  fences stay whole up to 8 KB, then split by rows/lines with the header row noted.

Reference implementation for offsets and headings: `packages/retrieval/src/structural-projector.ts` (legacy, tests
alongside). No Markdown AST library is needed for this.

### Labels

- In Eliot's own chat and jobs: `[S<k>:<i>]`, where `S<k>` is a short alias the server assigns to each source revision
  in that turn or job (`S1`, `S2`, …) and `<i>` is the block index. Claim-mode citations use the claim's block.
- **Stored form** `[<rev8>:<i>]`, where `<rev8>` is the first 8 hex characters of the revision ID: used in everything
  persisted across turns — saved answers and all pages — and in MCP tool outputs (agents call across stateless
  requests). When an answer is saved, its turn aliases are rewritten to the stored form.
- Inside one source's own artifacts (guide, digest) labels are `[<i>]`, the block index of that source.
- The server keeps the alias table per turn/job and resolves every form to `{ revision_id, block, start, end }`.

### From answer to citation

1. Parse every `[label]` in the model output.
2. Resolve to a revision and block; unknown labels are removed from the text and counted (`invalid_labels`).
3. Store the resolved citations with the answer message (and in `page/<rev>/citations.json` when saved).
4. The UI renders each label as a chip; clicking opens `/api/revisions/:id/text?start&end` in the reader with
   surrounding blocks.

A citation is valid when its label resolves to a block of a revision that was in the turn's context. That is the
100 % check in K2 acceptance.

### Quote verification (K3, and any tool that returns quotes)

Given a quote and a block index:

1. Exact substring search in the block's bytes; then in the two neighbouring blocks.
2. If not found: compare after normalising whitespace, quotation marks, dashes and soft hyphens, keeping a map from
   normalised to original offsets; take the match's original byte range.
3. If several equal matches exist, take the one in the stated block; otherwise the first, and mark it ambiguous.
4. If nothing matches, the quote is unverified: the claim is dropped (counted in the distill report).

Numbers: every digit group in a claim's `value` must appear in its quote; otherwise `value` is cleared and the claim
kept as a statement.

## 6. Distillation (K3)

Purpose: read each source once with a large model and keep what a researcher needs, each item tied to an exact quote.

### DistillWorkflow(revisionId)

1. **Load** `text.md` and `blocks.json`; render the text with a `[i]` marker at the start of every block.
2. **Read and extract** (one call, `settings.distill_model`, structured output when the model supports it, otherwise a
   fenced JSON block validated with zod; one retry with the validation error on failure). Output:

   ```json
   {
     "title": "Attention Is All You Need",
     "authors": "Vaswani et al.",
     "published": "2017",
     "guide": {
       "summary": "3–5 sentences: problem, approach, main result, why it matters.",
       "questions": [{ "q": "How does multi-head attention differ from single-head attention?", "blocks": [41, 43] }]
     },
     "claims": [
       { "kind": "result", "statement": "The big Transformer reaches 28.4 BLEU on WMT 2014 English-German.",
         "task": "machine translation", "metric": "BLEU", "dataset": "WMT 2014 En-De",
         "value": "28.4", "conditions": "Transformer (big), newstest2014",
         "quote": "achieves 28.4 BLEU on the WMT 2014 English-to-German translation task", "block": 3 }
     ]
   }
   ```

   Prompt `src/prompts/distill-read.md` must ask for: 3–5 questions a reader would ask, each answerable from cited
   blocks; 25–60 claims for a typical paper (fewer only for short texts) covering the main method, every headline result with its number, unit and conditions, every
   limitation the authors state, datasets and key definitions; quotes copied verbatim (≤ 300 characters); statements
   in the source language; nothing that is not in the text.
3. **Verify** quotes and numbers (§5). Fill `title`/`authors`/`published` into `source` only if those fields are empty.
4. **Digest and glossary** (second call, input = guide + verified claims only, not raw text):
   `digest.md` with sections *Question and contribution*, *Method*, *Key results* (bullets with numbers and labels),
   *Limitations* (stated by authors), *Where it fits* (relation to other work as the paper states it); and
   `glossary.json` `[{ "term": "...", "en": "...", "ru": "...", "definition": "...", "block": 12 }]`. Every factual
   sentence in the digest carries a claim's block label in the `[<i>]` form; labels that do not belong to a verified
   claim are removed.
5. **Write** `guide.md`, `digest.md`, `glossary.json` and `distill.json` (raw output and the verification report:
   kept/dropped counts, reasons) to R2; set `source_revision.guide_summary` (the guide's first sentence, for lists),
   insert `claim` rows (from K4 also `claim_fts` rows, `body` = statement + quote + task/metric/dataset), set
   `distill_state` (`done`, or `partial` if the second call failed), `distill_model` and the token columns.
6. **Project overview**: if no other revision of any project containing this source is `queued`/`running`, regenerate
   `page(kind='overview')` for those projects from their source guides (title, one paragraph per source, 5 suggested
   questions across sources). Pages written by Workflows use actor `owner` and origin `job`. From K6 the same condition
   also starts `ProjectKnowledgeWorkflow` for those projects (§12).

Each model call is its own Workflow step with retries (`limit: 5`, delay from `Retry-After` when present, exponential
otherwise). A 4xx that is not 429 fails the step without retry (`NonRetryableError`).

Concurrency: `IngestWorkflow` only sets `distill_state = 'queued'`. A cron trigger (every minute) counts revisions in
`running` and starts `DistillWorkflow` for the oldest `queued` ones while fewer than `DISTILL_CONCURRENCY` (Worker
variable, default 2) are running. Raise the number when the model's rate limit allows (§11).

Budget per 10k-token paper: about 15k input and 4k output tokens across the two calls.

### Reading the artifacts

- The reader shows guide and claims next to the text; clicking a claim highlights its quote.
- Answers use claims in claim mode (§8); tools expose them (§7).
- A new revision gets its own distillation; old revisions keep theirs.

## 7. The shared toolset

One set of functions in `src/tools/`, used by Eliot's chat (K5), research jobs (K7), the MCP server (K4) and the API.
Each tool takes `(env, actor, input)` and returns **compact Markdown** meant for a model to read: titles and labels,
no raw JSON, a hard size cap, and a hint when more is available.

| Tool | Input | Output | Backend | From |
|---|---|---|---|---|
| `list_projects` | — | table: id, title, sources, updated | D1 | K4 |
| `list_sources` | `project`, optional `query` | table: source label (`<rev8>` of the current revision), title, year, state, `guide_summary` | D1 | K4 |
| `get_guide` | `source` | guide summary, suggested questions, claim count by kind, digest if present | R2 | K4 |
| `outline` | `source` | headings with block index ranges | R2 `blocks.json` | K4 |
| `read` | `source`, one of `blocks: [from, to]` / `heading` / `query_in_source`, `max_tokens` (default 3,000) | block-labelled text | R2 range | K4 |
| `find_claims` | `query` and/or `task`/`metric`/`dataset`, `project`, `limit` | claims with statement, value, conditions, quote and label | D1 `claim_fts` | K4 |
| `search` | `query`, `project` or `sources`, `mode: hybrid|keyword`, `limit` (≤ 20) | passages with label, title, heading | K4: claims + guides; K5: AI Search (§9) | K4/K5 |
| `get_page` | `page` | page Markdown with citations | R2 | K4 |
| `propose_page` | `project`, `title`, `kind`, `markdown` with labels | page and revision ID (status `proposed` for agents, `accepted` for the owner) | D1 + R2 | K4 |
| `web_search`, `web_read` | query / URL | results / page Markdown (leads only, never cited) | Agents SDK web tools | K7 |
| `capture_url` | `project`, `url` | new source (enters ingest) | §4 | K7 |

Rules:

- Default output cap 4,000 tokens; every list ends with "N more — call with `cursor`" when truncated.
- Errors are short instructions to the model ("source not found — call `list_sources`"), not stack traces.
- Scope, labels, size caps and the agent write rule (proposals only) are enforced in code, not left to the model.
- Tool descriptions in `src/tools/descriptions.ts` say when to use each tool; keep them under 60 words each.
- A `source` argument accepts the label shown by `list_sources` (`<rev8>`) or a full source ID; `page` and `project`
  arguments take the IDs shown by the list tools.

## 8. Ask

### Context modes

`src/context.ts` chooses one mode per turn and records it in `chat_turn.context_mode`:

1. **whole** — the selected readable texts, each wrapped as `<source alias="S1" title="..." year="...">` with the
   block's full label (`[S1:0]`, `[S1:1]`, …) at the start of every block, fit within the whole-reading budget: `min(0.6 × model context, 400,000)` tokens minus history and
   output reserve. Estimate tokens as `utf8_bytes / 3`, which is conservative for English and Russian.
2. **claims** (K3) — whole does not fit: guides (their `[<i>]` labels rewritten to `[S<k>:<i>]`) plus all verified
   claims of the selected sources, each claim rendered with its turn label. If even that exceeds the budget, the turn
   asks the owner to narrow the selection; from K5 it switches to search mode instead.
3. **search** (K5) — the model gets the guides of the selected sources and the tools `search`, `read`, `find_claims`
   with at most 6 tool steps, then must answer.
4. **none** — explicit empty scope: no sources; the answer says it uses no library material.

The turns API may force a mode with `mode` (used by K3 acceptance to compare whole and claim mode); the browser never
sets it.

Scope: `project_default` = enabled sources of the project; `explicit` = the chosen sources; `empty` = none. At turn
start each source is resolved to its current readable revision; the revision IDs are stored in `chat_turn.scope_json`.
History sent to the model: previous questions and answers of the chat as plain text with citation labels removed,
within 10 % of the budget, newest first; answers whose cited revisions are outside the current scope are left out.
Model selection: the turn uses `project.answer_model` when set, otherwise `settings.answer_model`.

### ChatAgent

`ChatAgent extends AIChatAgent` from `@cloudflare/ai-chat`; the browser uses `useAgentChat` from
`@cloudflare/ai-chat/react`.

- One turn function `runTurn(input)` used by both entry points: `onChatMessage` (browser, streaming over the WebSocket)
  and the RPC method `ask(input)` behind `POST /api/chats/:chatId/turns` (appends the user message the same way the
  SDK does for a browser message, waits for the turn to settle and returns `TurnResult` built from `chat_turn` and the
  stored assistant message; check the installed `AIChatAgent` types for the method that persists a message and runs
  `onChatMessage` — `saveMessages` in `@cloudflare/ai-chat` 0.12.2). It inserts `chat_turn` (`started`), builds context, calls `streamText` with the turn's model, resolves
  labels, stores the citations on the assistant message as a `data-citations` part, then updates tokens, `citations`,
  `invalid_labels`, `first_token_ms`, `total_ms` and `state`.
- One active turn per chat; a second submit while streaming waits in the SDK queue (`messageConcurrency: "queue"`).
- Stop cancels the stream and sets the turn to `cancelled` (keeping any text already streamed); closing the tab does
  not stop it (`cancelOnClientAbort: false`, `resume: true`).
- After a crash, keep the partial answer and mark the turn `partial` (override the protected `onChatRecovery` to
  return `{ continue: false }`); no automatic paid continuation.
- Token usage comes from the AI SDK result `usage`: `inputTokens`, `outputTokens` and
  `inputTokenDetails.cacheReadTokens` (stored as `chat_turn.cached_tokens`).
- K5 tools: server-side tools with a step limit; `autoContinueAfterToolResult: false` on the client.
- Never put credentials, usage or scope decisions into client-editable state.

### Answer prompt (`src/prompts/answer.md`)

The prompt must require: answer in the language of the question; start with the direct answer, then details; every
factual sentence ends with one or more labels from the provided context; use only the provided sources (plus clearly
marked general knowledge when the owner's instructions allow it); distinguish what a source states from what is
inferred; when the sources do not contain the answer, say so plainly and name what is missing; for comparisons use a
short table; finish with 2–3 follow-up questions. The project's `instructions` are appended verbatim.

### Failures

Model errors, rate limits and timeouts end the turn as `failed` with a plain reason and a Retry button that resubmits
the same question as a new turn. Reading sources never depends on the model being available.

### Targets (K2 acceptance)

On `eval/arxiv-10` with all ten papers in whole mode (their readable text is expected around 600–800 KB; K1 prints
the measured size and K2 the model-reported tokens): first token ≤ 10 s for the first question on a new source set
(cold) and ≤ 4 s for later questions over the same sources (cached prompt); every answer complete ≤ 40 s;
`invalid_labels` = 0 and every citation opens its passage. These are starting targets; K2 records the measurements. The old system took 86–114 s and the model saw
16 fragments (≈60 KB of ≈800 KB), half irrelevant — whole reading exists to remove exactly that.

## 9. Search projection (K5)

AI Search instance `library-v1` in the `default` namespace, bound as `SEARCH` with the `ai_search` binding (the instance
binding only reaches the `default` namespace). Settings (set at creation, versioned in `scripts/setup.sh`):

| Setting | Value | Why |
|---|---|---|
| index method | vector + keyword (hybrid) | semantic and exact terms |
| embedding model | `@cf/qwen/qwen3-embedding-0.6b` (multilingual) | English and Russian |
| keyword tokenizer | decided by the K5 spike (`porter` vs `trigram`) | `porter` is English stemming |
| chunk size / overlap | 512 tokens / 0 | precise passages, no duplicate text |
| `cache` | `false` | the default response cache (48 h) must not serve stale results |
| reranking | off | the only built-in reranker is English (`bge-reranker-base`) |
| query rewrite | off | the model already writes the query |
| custom metadata | `revision_id`, `source_id`, `language` (text) | filters; values ≤ 64 bytes |

Indexing: after a revision becomes readable, `env.SEARCH.items.upload("r/<revision>.md", textMd, { metadata })`, store
`search_item_id`, set `search_state='queued'`; a Workflow step waits (`step.sleep` between `items.get(id).info()` checks)
until `completed`, then pages through `items.get(id).chunks({ limit: 100, offset })` and stores
`{ id, start_byte, end_byte }` in `source/<rev>/chunks.json`. Deleting or replacing a revision deletes its item.

Query: resolve the scope in D1 to revision IDs; call
`env.SEARCH.search({ query, ai_search_options: { retrieval: { retrieval_type, max_num_results, match_threshold: 0,
filters: { revision_id: { $in: ids } } } } })`; for each chunk, look up its byte range in `chunks.json`, snap to the
covering blocks, and return labelled passages. A single-instance search response has no per-instance `errors` field: a
failed call throws, and the tool then answers "search unavailable" (chat falls back to claim mode). An empty scope
returns nothing without calling Search. Keyword mode sets `retrieval_type: "keyword"`; quoted strings in the
query are additionally checked as exact substrings in the hydrated text.

Limits (2026-10-01 docs): 500,000 files per hybrid instance, 5 custom metadata fields, 64 filterable bytes per string,
at most 50 results per query, item key ≤ 128 characters, text item ≤ 10 MiB. Billing for AI Search starts 2026-11-01
(agent report; check the pricing page).

## 10. MCP server and Workflows

### MCP (K4)

`src/mcp.ts` uses `createMcpHandler` from `agents/mcp/server` (the factory form; `agents/mcp` also carries deprecated
SDK v1 overloads) with an MCP SDK v2 server factory: a fresh server per request, stateless Streamable HTTP at
`POST /mcp` on the MCP hostname only, exact `allowedHostnames`. Leave the SDK's `legacy` option at its default unless a
named client needs `legacy: "stateless"`. It registers the tools of
§7 except `web_search`, `web_read` and `capture_url`, with their descriptions. The actor comes from §2; agents can call every read tool and
`propose_page`. Large uploads are not accepted over MCP; `capture_url` arrives in K7.

### Workflows

| Workflow | Started by | Steps | State lives in |
|---|---|---|---|
| `IngestWorkflow` (K1) | source upload, revision creation | convert → write text/blocks → set state → (K3) mark distillation `queued` → (K5) index | `source_revision` |
| `DistillWorkflow` (K3) | the distillation cron (§6) | §6 | `source_revision.distill_state`, R2, `claim` |
| `ProjectKnowledgeWorkflow` (K6) | last distillation of a batch (§6 step 6), owner Refresh | §12 | map page revisions |
| `ResearchWorkflow` (K7) | owner | plan → search/read/claims → web → capture → synthesize | `job` |

Instance IDs are deterministic (`ingest-<revision>`, `distill-<revision>`, `project-<project>-<timestamp>`,
`research-<job>`). `create()` throws when the ID already exists, so a repeated start first calls `get(id)` (or catches
that error) and reuses the existing instance. Each external call (model, fetch, AI Search upload)
is its own step with retries; deterministic writes are separate steps. Step results stay small (IDs, counts); bodies go
to R2. Progress is written to the row the UI already reads; the UI polls every 3 s while something is running.

`job` (K7): `id`, `project_id`, `question`, `model`, `state` (`queued`, `running`, `done`, `failed`, `cancelled`),
`limits_json` (max model calls, max tokens, max web captures, deadline), `usage_json`, `progress` (one line),
`result_page_id`, timestamps. Cancel sets `state='cancelled'`; every step checks it before an external call. A call
already in flight may finish.

## 11. Models

Models are reached through the AI SDK (`ai` 7) with Workers AI for `@cf/...` models and AI Gateway for external
providers. Model routes are strings `workers-ai:<model>` or `gateway:<provider>/<model>`. A table in `src/models.ts`
holds, per route: context window, max output tokens, tool calling (yes/no), structured output (yes/no), price note.
Unknown routes get conservative values (32k context, 4k output, no tools).

Defaults (Workers AI pages checked 2026-10-24; max output tokens per model is an open check in §15):

| Use | Model | Context | Tools | Price per 1M in / out (cached in) |
|---|---|---|---|---|
| Answer, distill | `@cf/zai-org/glm-5.3-flash` | 1,048,576 | yes | $0.15 / $0.50 ($0.03) |
| Alternative long context | `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | 1,048,576 | yes | $0.30 / $1.20 ($0.006); 20 req/min (50 with prepaid Gateway credits) |
| Cheap short tasks | `@cf/zai-org/glm-4.7-flash` | 131,072 | yes | $0.06 / $0.40 |
| Hard synthesis (optional) | `@cf/zai-org/glm-5.3` | 1,048,576 | yes | $1.40 / $4.40 ($0.26) |

External subsidised or free models are added as Gateway routes with the owner's keys stored in AI Gateway. Set AI SDK
`maxRetries: 0` for chat (the user retries); Workflows retry at the step level. Prefer models with prompt caching for
whole-reading answers and keep the source block of the prompt identical between turns so it caches. The real
constraint for bulk distillation is the provider rate limit, not price.

Before dispatch, check the rendered request fits the route's context and output limits; a selection that does not fit
switches context mode (§8) instead of failing at the provider.

## 12. Project knowledge (K6)

`ProjectKnowledgeWorkflow(projectId)` (workflow binding `PROJECT_KNOWLEDGE`) builds one map page revision
(`page(kind='map')`): `body.md` for reading and `data.json` for the UI. It starts when the last distillation of a batch
finishes (§6 step 6) and on Refresh:

```json
{
  "topics": [{ "id": "t1", "label": "Training very deep networks", "sources": ["<rev>"], "claims": ["<claim id>"] }],
  "comparisons": [{ "task": "image classification", "metric": "top-1 accuracy", "rows": [
    { "claim": "<id>", "source": "<rev>", "value": "88.55%", "conditions": "ViT-H/14, JFT-300M pre-training" }] }],
  "disagreements": [{ "claims": ["<id>", "<id>"], "note": "different datasets; not directly comparable" }],
  "gaps": ["No paper evaluates ViT on detection or segmentation"],
  "routes": [{ "goal": "Understand attention-based models", "sources": ["<rev>", "<rev>"] }]
}
```

Steps:

1. Topics: for each source without a topic assignment, one call with its guide and claims plus the current topic list
   returns topic IDs (new topics allowed, at most 12 in a project). Stored in the map's `data.json`.
2. Comparisons: by code — group claims by `(task, metric)`; keep groups with values from at least two sources; mark
   rows with different conditions.
3. Disagreements: one call per comparison group with differing values, asking whether the claims conflict under
   comparable conditions; the owner sees them as candidates with both quotes.
4. Gaps and routes: one call over topics, guides and the project instructions.
5. Wiki on request: a page per topic written from that topic's claims, every sentence labelled.

Staleness: when a source revision is replaced or deleted, every page revision whose `inputs_json` contains the old
revision marks its page `stale`. Refresh writes a new revision; for agents it is a proposal.

## 13. User interface

The accepted Material interface is moved, not redrawn. `src/web/ui/` is `packages/ui/src` moved with `git mv`: tokens
(theme, Google Sans with Cyrillic), primitives, the Material Symbols icon component, feature components and their CSS.
Screens use only the semantic tokens (`--md-sys-color-*`, `--eliot-*`); raw colours, font stacks, radii or durations
outside `tokens/` are defects. When a contour ships a journey, move that feature's component and CSS, keep markup and
class names, and change only prop types (to `src/shared/`) and copy. Do not move legacy query adapters, preview or
regression fixtures, or the unused Tailwind import. `contrast.test.ts` keeps its contrast checks; drop its file hash.

Routes by contour: K0 `/` and `/settings` (placeholders in the moved frame); K1 `/p/:projectId/sources` and
`/p/:projectId/source/:sourceId?start=&end=`; K2 `/p/:projectId/chat/:chatId?` and `/p/:projectId/studio`. Every
request and stream carries its project or chat ID; switching tabs never redirects a stream.

Moving rules: imports from `@eliotr/owner-api-client` and `apps/eliotr-web/src/query/**` are replaced by types from
`src/shared/api.ts` and hooks in `src/web/api.ts`; Storybook stories and preview/regression files are not moved. The
legacy `apps/eliotr-web` no longer builds at HEAD (the root package switched in PR #415); the pinned legacy commit keeps
it reproducible, so `git mv` breaks no active build.

Copy uses product words: project, source, question, answer, page, agent, model. Primary UI never shows engine, receipt,
manifest, bytes, digest, qualification, admission or projection; technical detail goes behind a Details disclosure.
States every list and panel needs: loading, empty, error with one action, stale. Private text stays in memory and
server state, not in localStorage or a service worker. Render Markdown with one renderer with raw HTML disabled; build
citation chips from resolved citations, not from text.

## 14. Lifecycle and export (K9)

- Detach removes a membership; Archive hides a source from new selections; Delete hides immediately (`state='deleted'`,
  `deleted_at` on revisions), then removes R2 objects and the AI Search item in the request or the daily cron sweep.
  Old citations show "deleted"; pages citing it turn stale.
- Before Delete, show the projects and pages that cite the source (query `project_source` and `page_revision.inputs_json`).
- Export streams a ZIP: originals, `text.md`, `claims.json`, pages (`.md` + citations) and a manifest of files.
- Deleting Eliot's copy cannot recall text already sent to model providers; the UI says so once in Settings.

## 15. Platform facts and open checks

| Fact | Status | Checked |
|---|---|---|
| `ai_search` instance binding reaches only instances in the `default` namespace | verified, Wrangler configuration docs | 2026-10-24 |
| AI Search response cache defaults to on (TTL 48 h); only reranker is `bge-reranker-base` | verified, AI Search Workers binding docs | 2026-10-24 |
| AI Search limits in §9 | verified, limits and pricing page (updated 2026-10-01) | 2026-10-24 |
| `items.get(id).chunks()` returns `id`, `text`, `start_byte`, `end_byte`; search hits return chunk `id` without offsets | verified, Items API docs (updated 2026-10-01) | 2026-10-24 |
| AI Search public `/mcp` endpoint is unauthenticated unless put behind Access on a custom domain; not used | verified, AI Search MCP docs (updated 2026-08-06) | 2026-10-24 |
| D1 supports FTS5 with the trigram tokenizer | verified, D1 "Use indexes" page | 2026-10-24 |
| Workers AI model facts in §11 | verified, model pages | 2026-10-24 |
| Cloudflare has no graph product; Agent Memory is a lossy private beta; Code Mode is experimental | agent report | 2026-10-24 |
| Byte offsets of `chunks()` are counted in the uploaded `.md` bytes | **open** — K5 spike | — |
| Russian keyword search: `porter` vs `trigram` in AI Search | **open** — K5 spike | — |
| `$in` filter with 500 IDs on the real binding | **open** — K5 spike | — |
| Prompt caching through AI Gateway for external routes | **open** — K2 | — |
| Max output tokens of the default models | **open** — read from the model pages in K2 | — |
| SDK names used here (`AIChatAgent`, `messageConcurrency`, `onChatRecovery`, `saveMessages`, `useAgentChat` options, `createMcpHandler` from `agents/mcp/server`, `toMarkdown`, AI Search binding methods, `step.do` retries with a delay function, `NonRetryableError`, `Workflow.create`/`get`, R2 range, D1 `batch`, AI SDK `usage.inputTokenDetails.cacheReadTokens`) | verified against installed `.d.ts` (agents 0.30.1, @cloudflare/ai-chat 0.12.2, workers-types 5.20260926.1, ai 7.0.152, wrangler 4.152.0 schema) | 2026-10-24 |
