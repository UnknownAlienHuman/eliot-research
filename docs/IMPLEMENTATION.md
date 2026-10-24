# Eliot Research — Implementation

Technical contracts for the contours in [MAP](MAP.md). [ARCHITECTURE](ARCHITECTURE.md) says what the product must do;
this document says how. Build a section only when the current contour needs it. Platform facts carry the date they were
checked; re-check anything older than a few weeks against the installed types and current Cloudflare docs before
relying on it (§15).

| Contour | Sections |
|---|---|
| K0 Shell | §1, §2, §13 |
| K1 Read | §1 (API), §3, §4, §5 |
| K2 Ask | §5, §8, §11 |
| K3 Distill | §6, §8 (claim mode) |
| K4 Agents in | §7, §10 |
| K5 Library scale | §7, §8 (search mode), §9 |
| K6 Project knowledge | §12 |
| K7 Deep research | §7, §10 |
| K9 Lifecycle | §14 |

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
| `src/shared/` | types used by both Worker and web (API payloads only) | K1 |
| `src/web/` | React app; `src/web/ui/` is the moved Material design system | K0 |
| `migrations/` | D1 migrations | K0 |
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
    "run_worker_first": ["/api/*", "/agents/*", "/mcp"]
  },
  "d1_databases": [{ "binding": "DB", "database_name": "eliot", "database_id": "<from setup>", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "eliot" }],
  "ai": { "binding": "AI" }
  // K2: durable object ChatAgent (declarative exports, SQLite); K1/K3: workflows; K5: "ai_search": [{ "binding": "SEARCH", "instance_name": "library-v1" }]
}
```

Generate binding types with `wrangler types` and commit the output; never hand-write `Env`. Add `hono` and `jose` in
K0. Dependency versions are pinned in `package.json`; do not bulk-upgrade them for an unrelated change.

Durable Object classes use the declarative `exports` lifecycle with SQLite storage; D1 schema changes are files in
`migrations/`. Workflows are declared once and started through their bindings.

### Account setup (once)

1. `wrangler d1 create eliot`, `wrangler r2 bucket create eliot`; put the D1 ID into `wrangler.jsonc`.
2. Custom domains `research.<domain>` (UI, API, chat WebSocket) and, in K4, `mcp.research.<domain>`, both on this Worker.
3. Two Cloudflare Access applications, one per hostname (§2). Record each application's audience tag as Worker
   variables `ACCESS_AUD_UI` and `ACCESS_AUD_MCP`, and the team domain as `ACCESS_TEAM`.
4. K5: `wrangler ai-search create library-v1 --type builtin` in the `default` namespace with the settings in §9.
5. Model keys for external providers live in AI Gateway (BYOK) or Worker secrets — never in D1 or the browser.

Write these steps into `scripts/setup.sh` as they are first performed, so the next environment needs no manual work
beyond the Access applications.

### HTTP API

JSON under `/api/`, validated with zod. Errors are `{ "error": { "code", "message" } }` with codes `invalid`,
`not_found`, `conflict`, `busy`, `unavailable`; messages are plain owner language. Lists use `?cursor=&limit=` and
return `{ items, nextCursor }`. Mutations that create or publish something accept an `Idempotency-Key` header; a repeat
with the same key returns the first result. The browser never retries a mutation by itself. Project work is addressed
by `:projectId` in the path.

| Route | Purpose | Contour |
|---|---|---|
| `GET /api/health`, `GET /api/me` | liveness; actor and configured services | K0 |
| `GET/POST /api/projects`, `GET/PATCH /api/projects/:projectId` | list, create, open (summary + sources + overview), rename, archive, instructions | K1 |
| `POST /api/projects/:projectId/sources` | add files (`multipart/form-data`, one file per part), a URL or text; returns created sources | K1 |
| `GET /api/projects/:projectId/sources` | sources with state, guide summary, distill state | K1 |
| `PUT/DELETE /api/projects/:projectId/sources/:sourceId` | attach existing source / enable-disable / detach | K1 |
| `GET/PATCH /api/sources/:sourceId` | source metadata (title, authors, published) | K1 |
| `POST /api/sources/:sourceId/revisions` | replace file, reconvert, or supply owner Markdown | K1 |
| `GET /api/revisions/:revisionId` | outline, blocks, converter, warnings, distill state | K1 |
| `GET /api/revisions/:revisionId/text?start=&end=` | exact UTF-8 byte range of `text.md` | K1 |
| `GET /api/revisions/:revisionId/original` | original file | K1 |
| `GET/POST /api/projects/:projectId/chats`, `PATCH /api/chats/:chatId` | chat list, create, rename, archive | K2 |
| `GET /agents/chat/:chatId` (WebSocket) | checked against D1, then routed to that chat's `ChatAgent` | K2 |
| `GET /api/settings`, `PATCH /api/settings` | default answer and distill models | K2 |
| `GET/POST /api/projects/:projectId/pages`, `GET /api/pages/:pageId` | list, save answer / note, read page with citations | K2 |
| `GET /api/revisions/:revisionId/knowledge` | guide, claims, digest, glossary | K3 |
| `POST /api/page-revisions/:revisionId/decision` | accept or reject a proposal | K4 |
| `POST /api/projects/:projectId/search` | search (same function as the `search` tool) | K5 |
| `POST /api/projects/:projectId/map/refresh`, `POST /api/pages/:pageId/refresh` | rebuild map / refresh a stale page | K6 |
| `GET/POST /api/projects/:projectId/jobs`, `GET /api/jobs/:jobId`, `POST /api/jobs/:jobId/cancel` | research jobs | K7 |
| `DELETE /api/sources/:sourceId`, `GET /api/projects/:projectId/export` | delete with impact preview, ZIP export | K9 |

The MCP endpoint (`POST /mcp` on the MCP hostname) exposes the toolset (§7); it is not a second API.

## 2. Access and actor

Cloudflare Access is the only sign-in. Each hostname has its own Access application: the UI hostname uses the owner's
browser session; the MCP hostname uses Access service tokens for headless agents (K4) and may add Access Managed OAuth
for interactive clients later. Do not use Worker-level Access for the UI hostname: it rejects WebSocket upgrades.

`src/auth.ts` runs once per request (and once per WebSocket upgrade):

1. Read `Cf-Access-Jwt-Assertion`; verify signature, issuer `https://<ACCESS_TEAM>.cloudflareaccess.com`, the
   hostname's audience and expiry with `jose` and a cached JWKS (`/cdn-cgi/access/certs`).
2. Map to an actor: owner email → `owner`; service token client ID in `MCP_ALLOWED_CLIENTS` → `agent:<client-id>`.
   Anything else → 403.
3. For browser mutations and WebSocket upgrades require the configured UI `Origin`.
4. Pass `actor` to product functions. No per-row or per-result permission checks inside: one owner, everything the
   owner can see is visible; agents can read everything and write only proposals.

Local development: when the Worker variable `ELIOT_LOCAL_DEV=1` comes from `.dev.vars` and the request host is
`localhost` or `127.0.0.1`, the actor is `owner` without a JWT. A deployed Worker that sees `ELIOT_LOCAL_DEV` refuses
all requests. Local runs use local D1/R2; AI and AI Search bindings use `remote: true` when needed.

## 3. Data

### Tables

`migrations/0001_initial.sql` holds the tables for K0–K3; it owns all column and state names. Later contours add:
`0002_search.sql` (K5: `source_revision.search_item_id`, `search_state`), `0003_jobs.sql` (K7: `job`), plus whatever
K6/K8/K9 need, written in that contour. Do not add a table before the contour that reads it.

| Table | Holds |
|---|---|
| `settings` | default answer and distill model routes |
| `project` | title, description, standing answer instructions, model override |
| `source`, `source_revision` | one Library source; immutable revisions with conversion and distillation state |
| `project_source` | many-to-many membership; `enabled = 0` keeps a source out of answers |
| `claim`, `claim_fts` | distilled claim cards with exact quote ranges; trigram FTS for substring search in any language |
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
For each: check size, create rows (`readable_state = 'pending'`), stream bytes to `source/<rev>/original` while hashing
(SHA-256), return the created sources immediately, start `IngestWorkflow` with the revision ID as instance ID. An
identical SHA-256 already in the Library is reported to the owner ("already in Library as …") with an Attach action;
it is not merged silently.

Limits: file ≤ 25 MB; URL capture ≤ 10 MB; pasted text ≤ 2 MB; readable `text.md` ≤ 10 MiB (AI Search item limit).
A larger readable text is kept and readable but marked `readable_with_warnings` ("too large to index").

### Conversion (IngestWorkflow step `convert`)

| Input | Converter | `converter` value |
|---|---|---|
| `.md`, `.txt`, `.csv`, valid UTF-8 text | used as is (BOM removed, line endings kept) | `local_text` |
| PDF, DOCX, XLSX, PPTX, ODT, HTML, images and other formats in the cached `env.AI.toMarkdown().supported()` list | `env.AI.toMarkdown([{ name, blob }])` | `workers_ai_markdown` |
| URL | `fetch` with `Accept: text/markdown, text/html;q=0.9`; Markdown response used as text, HTML converted with `toMarkdown` | `local_text` / `workers_ai_markdown` |
| JavaScript-rendered page (owner asks to render) | Browser Run `/markdown` quick action | `browser_markdown` |
| Owner/agent-supplied Markdown for a scan | stored as a new revision | `owner_markdown` |

Read only the documented result fields (`format`, `data` or `error`, `tokens`) and ignore unknown ones. Cache the
`supported()` list in a module variable for the life of the isolate; do not call it per upload.

Result states:

- `readable` — non-empty UTF-8 text, no warnings.
- `readable_with_warnings` — usable, with a one-line `warning_summary`: very low text density for the page count, image
  descriptions present (generated, not literal text), first frame only for GIF, too large to index.
- `needs_conversion` — empty or unusable text (typically a scan). The original is kept; the reader shows "This file
  needs text conversion" with an action to upload Markdown. AI Search OCR output is never used as source text.
- `failed` — conversion error; the reader shows the error and Retry.

A replacement or reconversion creates a new revision; the source's current revision advances only to a readable one.
Old revisions stay readable for old citations.

### URL guard

HTTPS only (HTTP allowed only when the owner explicitly confirms); no credentials in the URL; no IP literals, `localhost`,
private or link-local ranges; at most 5 redirects, each re-checked; size and 20-second time limits; store the final URL
and capture time. Do not claim DNS pinning.

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
- In MCP tool outputs (agents call across stateless requests): `[<rev8>:<i>]`, where `<rev8>` is the first 8 hex
  characters of the revision ID. Pages proposed by agents use this form.
- The server keeps the alias table per turn/job and resolves both forms to `{ revision_id, block, start, end }`.

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
   blocks; 15–60 claims covering the main method, every headline result with its number, unit and conditions, every
   limitation the authors state, datasets and key definitions; quotes copied verbatim (≤ 300 characters); statements
   in the source language; nothing that is not in the text.
3. **Verify** quotes and numbers (§5). Fill `title`/`authors`/`published` into `source` only if those fields are empty.
4. **Digest and glossary** (second call, input = guide + verified claims only, not raw text):
   `digest.md` with sections *Question and contribution*, *Method*, *Key results* (bullets with numbers and labels),
   *Limitations* (stated by authors), *Where it fits* (relation to other work as the paper states it); and
   `glossary.json` `[{ "term": "...", "en": "...", "ru": "...", "definition": "...", "block": 12 }]`. Every factual
   sentence in the digest carries a claim's block label; labels that do not belong to a verified claim are removed.
5. **Write** R2 artifacts, insert `claim` rows and `claim_fts` rows (`body` = statement + quote + task/metric/dataset),
   set `distill_state` (`done`, or `partial` if the second call failed) and `distill_model`.
6. **Project overview**: if no other revision of any project containing this source is `queued`/`running`, regenerate
   `page(kind='overview')` for those projects from their source guides (title, one paragraph per source, 5 suggested
   questions across sources).

Each model call is its own Workflow step with retries (`limit: 5`, delay from `Retry-After` when present, exponential
otherwise). A 4xx that is not 429 fails the step without retry (`NonRetryableError`). Concurrency: start Distill
instances through a small per-account limit (Workflow instance concurrency) sized to the model's rate limit (§11).

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
| `list_sources` | `project`, optional `query` | table: source label, title, year, state, one-line guide summary | D1 | K4 |
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

## 8. Ask

### Context modes

`src/context.ts` chooses one mode per turn and records it in `chat_turn.context_mode`:

1. **whole** — the selected readable texts, each wrapped as `<source alias="S1" title="..." year="...">` with `[i]`
   block markers, fit within the whole-reading budget: `min(0.6 × model context, 250,000)` tokens minus history and
   output reserve. Estimate tokens as `utf8_bytes / 3`, which is conservative for English and Russian.
2. **claims** (K3) — whole does not fit: guides plus all verified claims of the selected sources, each claim rendered
   with its label. If even that exceeds the budget, include claims ranked by `claim_fts` match to the question until
   the budget is reached, and say so in the answer footer.
3. **search** (K5) — the model gets the guides of the selected sources and the tools `search`, `read`, `find_claims`
   with at most 6 tool steps, then must answer.
4. **none** — explicit empty scope: no sources; the answer says it uses no library material.

Scope: `project_default` = enabled sources of the project; `explicit` = the chosen sources; `empty` = none. The scope
of each turn is stored in `chat_turn.scope_json` (revision IDs). History sent to the model: previous questions and
answers of the chat (text only, citations kept as labels) within 10 % of the budget, newest first; answers whose cited
revisions are outside the current scope are left out.

### ChatAgent

`ChatAgent extends AIChatAgent` from `@cloudflare/ai-chat`; the browser uses `useAgentChat` from
`@cloudflare/ai-chat/react`.

- `onChatMessage`: insert `chat_turn` (`started`), build context, call `streamText` with the turn's model, stream to the
  client, then update tokens, `first_token_ms`, `total_ms`, `state`.
- One active turn per chat; a second submit while streaming waits in the SDK queue (`messageConcurrency: "queue"`).
- Stop cancels the stream; closing the tab does not (`cancelOnClientAbort: false`, `resume: true`).
- After a crash, keep the partial answer and mark the turn `partial` (`onChatRecovery` → `{ continue: false }`); no
  automatic paid continuation.
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

On `eval/arxiv-10` with all ten papers (≈100k tokens, whole mode): first token ≤ 6 s on a cold prompt and ≤ 4 s when the
prompt is cached; every answer complete ≤ 40 s; 100 % valid citations. The old system took 86–114 s and the model saw
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
covering blocks, and return labelled passages. Inspect `errors` in the response and report partial results. An empty
scope returns nothing without calling Search. Keyword mode sets `retrieval_type: "keyword"`; quoted strings in the
query are additionally checked as exact substrings in the hydrated text.

Limits (2026-10-01 docs): 500,000 files per hybrid instance, 5 custom metadata fields, 64 filterable bytes per string,
at most 50 results per query, item key ≤ 128 characters, text item ≤ 10 MiB. Billing for AI Search starts 2026-11-01
(agent report; check the pricing page).

## 10. MCP server and Workflows

### MCP (K4)

`src/mcp.ts` uses `createMcpHandler` from `agents/mcp` with an MCP SDK v2 server factory: a fresh server per request,
stateless Streamable HTTP at `POST /mcp` on the MCP hostname only, exact `allowedHostnames`. It registers the tools of
§7 (without the web tools) with their descriptions. The actor comes from §2; agents can call every read tool and
`propose_page`. Large uploads are not accepted over MCP; `capture_url` arrives in K7.

### Workflows

| Workflow | Started by | Steps | State lives in |
|---|---|---|---|
| `IngestWorkflow` (K1) | source upload, revision creation | convert → write text/blocks → set state → (K3) start Distill → (K5) index | `source_revision` |
| `DistillWorkflow` (K3) | Ingest | §6 | `source_revision.distill_state`, R2, `claim` |
| `ProjectKnowledgeWorkflow` (K6) | end of a distill batch, owner Refresh | §12 | map page revisions |
| `ResearchWorkflow` (K7) | owner | plan → search/read/claims → web → capture → synthesize | `job` |

Instance IDs are deterministic (`ingest-<revision>`, `distill-<revision>`, `project-<project>-<timestamp>`,
`research-<job>`), so a repeated start finds the existing instance. Each external call (model, fetch, AI Search upload)
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

Defaults (Workers AI pages checked 2026-10-24):

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

`ProjectKnowledgeWorkflow(projectId)` builds one map page revision (`page(kind='map')`): `body.md` for reading and
`data.json` for the UI:

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

Routes: `/` (projects), `/p/:projectId/sources`, `/p/:projectId/chat/:chatId?`, `/p/:projectId/studio`,
`/p/:projectId/source/:sourceId?start=&end=`, `/settings`. Every request and stream carries its project or chat ID;
switching tabs never redirects a stream.

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
