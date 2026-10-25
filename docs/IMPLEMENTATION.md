# Eliot Research — Implementation

Technical contracts for [MAP](MAP.md). Build only the sections named by the active contour. Platform facts in §16 are
dated snapshots; recheck official Cloudflare documentation and the installed/generated types before code depends on a
price, limit, binding or SDK name.

| Contour | Sections |
|---|---|
| K0 Shell | §§1–2, §14 |
| K1 Read | §§1, 3–6, §14 |
| K2 Ask | §§1–4, 6–8, §14, §16 |
| K3 Distill | §§3, 6–9, §16 |
| K4 Agents in | §§2–4, 6, 10 |
| K5 Library scale | §§3, 6–7, 10–11, §16 |
| K6 Project knowledge | §§3, 6–7, 12, §14 |
| K7 Deep research | §§3–7, 10, 13–14, §16 |
| K9 Lifecycle | §§3–6, 15 |

## 1. Runtime, layout and Cloudflare configuration

One pnpm package, one Cloudflare Worker and one React/Vite application. The Worker serves assets, Hono API, Agents SDK
routing, stateless MCP and Workflow classes. HTTP, chat, MCP and Workflows call the same product functions:
`(env, actor, input)`. Do not create service/repository/controller mirrors.

| Path | Responsibility |
|---|---|
| `src/index.ts` | Hono/asset/Agent/MCP routing; exports DO/Workflow classes |
| `src/auth.ts` | Access JWT verification, actor and Origin checks |
| `src/api.ts`, `src/shared/api.ts` | route handlers and shared zod payloads |
| `src/library.ts`, `src/ingest.ts`, `src/read.ts`, `src/blocks.ts` | Library, capture, canonicalization and exact reading |
| `src/budget.ts`, `src/models.ts`, `src/usage.ts` | reservations, model metadata and usage normalization |
| `src/citations.ts`, `src/context.ts`, `src/chat.ts` | labels, context and `ChatAgent` turn logic |
| `src/workflows/*.ts` | ingest, distill, search projection, project map, research |
| `src/tools/`, `src/mcp.ts`, `src/search.ts` | shared tools, MCP and optional AI Search |
| `src/web/` | React application; accepted design system under `src/web/ui/` |
| `migrations/`, `scripts/eval/` | contour schema and real acceptance |

### Bindings by contour

- K0: `ASSETS` only.
- K1: `DB`, `BUCKET`; `IngestWorkflow` declared in Wrangler `exports` and called through `ctx.exports`.
- K2: `AI`; SQLite Durable Object `ChatAgent` configured once. Route assets after `/api/*`, `/agents/*`, `/mcp`.
- K3: `DistillWorkflow` export and a Worker cron trigger for admission/reconciliation.
- K5: direct instance `ai_search` binding `SEARCH`; `SearchProjectionWorkflow` export.
- K6: `ProjectKnowledgeWorkflow` export.
- K7: `ResearchWorkflow` export and `BROWSER` only when rendered capture is enabled.

Generate binding types with `wrangler types`; never hand-write `Env`. Same-Worker Workflows use Wrangler `exports`,
`ctx.exports` and explicit `default_retention` of seven days. Add `enable_ctx_exports` while the installed compatibility
contract still requires it. Keep step ceilings far below platform maxima: initial limits are 64 ingest, 32 distill,
64 search projection, 64 project map and 256 research steps.

`ChatAgent` uses the installed Agents SDK/`@cloudflare/ai-chat` declarative or legacy SQLite DO configuration exactly as
compiled by current Wrangler. Do not mix declarative `exports` lifecycle and legacy DO migrations in the same Worker.
Before K2 chooses one, generate types and dry-run packaging; the pin's documented `durable_objects.bindings` plus
`new_sqlite_classes` is the fallback known to work.

All authenticated HTML/API/Agent/MCP responses are `Cache-Control: private, no-store`. Only hashed public assets are
`public, max-age=31536000, immutable`. No private body enters Cache API, service worker, localStorage or public source map.

### Paid effect definition

A paid effect is a model call, Web Search request, potentially billable AI Search ingestion/query, or Browser Run time.
A Workflow itself is not treated as a model effect, but its steps/CPU/storage are measured. Page load, list, read,
citation open, reconnect and saving an existing result must not start paid work.

## 2. Access, actors and routing

Use hostname-based Cloudflare Access applications:

- `research.<domain>` — owner UI/API/Agent WebSocket and owner service token;
- `mcp.research.<domain>` — connected-agent service tokens from K4.

Worker-level Access policy is not selected for the UI because the current platform contract rejects WebSocket upgrades;
a hostname application protects the route and the Worker still validates the application token.

`src/auth.ts` verifies `Cf-Access-Jwt-Assertion` with `jose` and cached JWKS:

1. RS256 signature;
2. exact issuer `https://<team>.cloudflareaccess.com`;
3. expected application audience;
4. `exp`, `nbf`, `iat` sanity;
5. `type === "app"`.

Actor mapping:

- approved owner email → `owner`;
- approved owner service-token `common_name` → `owner`;
- approved MCP application service-token `common_name` → `agent:<client-id>`;
- everything else → 403.

The Worker removes every incoming `x-eliot-*` identity header and verifies Access before routing. The Chat Agent
hostname/path is owner-only, so `ChatAgent` uses the fixed actor `owner` and still verifies that its chat UUID exists in
D1. MCP constructs request-scoped tools by closing over the verified service-token actor. Other server-side product
calls receive an explicit actor argument; no source/body/header can supply one. Browser mutations and Agent WebSocket
upgrades require exact `UI_ORIGIN`; service-token requests have no Origin requirement. Local bypass is allowed only when
`ELIOT_LOCAL_DEV=1` and the request host is localhost; a deployed request seeing that variable fails closed.

Agent route contract:

```text
/agents/chat-agent/<chat UUID>
```

Worker order is `/api/*` → authenticated `/agents/*` → authenticated `/mcp` on its hostname → static assets. `ChatAgent`
is the class/binding name; Agents SDK kebab-cases it to `chat-agent`.

## 3. Schema, immutable objects and operation identity

Migrations own all table/column/state names:

| Migration | Adds |
|---|---|
| `0001_library.sql` | projects, sources, immutable captures/revisions, memberships |
| `0002_ask.sql` | settings, atomic budget reservations, chats/turns, pages/revisions |
| `0003_distill.sql` | distill runs, source metadata and accepted verified claims |
| `0004_agents.sql` | automatically maintained trigram claim FTS |
| `0005_search.sql` | optional AI Search projection runs/items and local usage counters |
| `0006_project.sql` | attempt-scoped project-map runs |
| `0007_jobs.sql` | bounded research jobs, durable calls and evidence membership |

These migrations are editable only until their first remote apply. After that, append a new migration.

D1 triggers reject cross-owner accepted pointers: a source's current revision must belong to that source and be readable;
a page head must be an accepted revision of that page; a current distill/map run and every accepted claim must belong to
the same revision/project; result pages must belong to the owning project. The product code still validates before the
write, but the database is the final integrity boundary.

Store relationships, state, reservations and compact claims in D1; bodies in R2:

```text
source/<revision>/original
source/<revision>/capture.json
source/<revision>/text.md
source/<revision>/blocks.json
source/<revision>/distill/<run>/{draft.json,guide.md,digest.md,glossary.json,report.json}
source/<revision>/search/<profile>/<segment>.json
chat/<chat>/<turn>/citations.json
page/<revision>/{body.md,citations.json,data.json}
job/<job>/{plan.json,partial.md,events.ndjson}
export/<export>/manifest.json
```

### Create-once R2 write

For an immutable key:

1. call `BUCKET.put(key, body, { onlyIf: { etagDoesNotMatch: "*" }, sha256, ... })`;
2. if it succeeds, read `head/get` immediately and verify expected size, SHA-256 and immutable metadata;
3. if the conditional write loses or acknowledgement is uncertain, read the existing object and accept only exact
   size/hash equality;
4. incompatible bytes are `conflict`; inability to verify is retryable/unknown, never permission to overwrite.

R2 is strongly consistent, so exact readback is valid. Multipart ETag is never a digest. Write R2 first, then D1
pointers. Orphaned exact objects are harmless and removed later. Current/head pointers advance by compare-and-set; a
lost race returns `conflict`.

### Attempt identity

Workflow IDs include attempt number:

```text
ingest-<revision>-a<N>
distill-<revision>-a<N>
search-<revision>-<profileHash>-a<N>
project-<project>-<inputHash>-a<N>
research-<job UUID>
```

Store the operation/run row and Workflow ID before `create()`. Repeating the same request reconciles that ID. A terminal
failed/partial/cancelled instance is never restarted for paid or mutating work; explicit Retry creates a new attempt row
(or a new research job) and a new budget reservation.

## 4. HTTP API and payload contracts

All JSON is zod-validated under `/api/`. IDs are UUID strings unless a platform-generated opaque ID is explicitly named.
Timestamps are Unix milliseconds. Unknown fields are rejected on mutations. Common error:

```json
{
  "error": {
    "code": "invalid|not_found|conflict|busy|unavailable|budget|forbidden",
    "message": "owner-readable text",
    "details": {}
  }
}
```

Lists accept `cursor` and `limit` (default 50, maximum 200) and return `{ "items": [], "nextCursor": null }`. A cursor
is a position, not authority; every page re-authenticates and reapplies scope.

### Core routes

| Method/path | Request | Result |
|---|---|---|
| `GET /api/health` | — | liveness and compiled capability names, no secrets |
| `GET /api/me` | — | `{ actor, kind, capabilities }` |
| `GET/POST /api/projects` | create `{ title, description? }` | project list/project |
| `GET/PATCH /api/projects/:id` | patch `{ title?, description?, instructions?, answerModel?, expectedUpdatedAt }` | project or conflict |
| `GET/PATCH /api/settings` | patch only fields introduced by completed contours plus `expectedUpdatedAt` | singleton settings/budget summary |
| `GET /api/projects/:id/sources` | cursor/limit | memberships + current revision state |
| `PUT /api/projects/:id/sources/:sourceId` | `{ enabled?: boolean }` | attach/update membership |
| `DELETE /api/projects/:id/sources/:sourceId` | — | detach only |
| `GET /api/sources/:id` | — | source + revision inventory |
| `PATCH /api/sources/:id` | `{ title?, expectedUpdatedAt }` | source or conflict |
| `GET /api/revisions/:id` | — | provenance, state, outline summary |
| `GET /api/revisions/:id/original` | optional Range | exact original bytes |
| `GET /api/revisions/:id/text?start=&end=` | UTF-8 byte range | canonical bytes/text with content range |
| `GET /api/revisions/:id/blocks` | cursor/limit | block metadata, no duplicated body |
| `GET/POST /api/projects/:id/chats` | create `{ title? }` | chat inventory/chat |
| `PATCH /api/chats/:id` | `{ title?, archived?, expectedUpdatedAt }` | chat |
| `GET/POST /api/projects/:id/pages` | create owner note | page inventory/page |
| `GET /api/pages/:id` | — | page + head revision |
| `POST /api/page-revisions/:id/decision` | `{ decision: "accept"|"reject", expectedHeadRevisionId? }` | owner-only proposal decision |
| `GET /api/revisions/:id/knowledge` | — | guide/claims/digest/glossary state |
| `POST /api/projects/:id/map/refresh` | `{ expectedInputHash? }` | K6 run |
| `GET/POST /api/projects/:id/jobs` | create research job | K7 inventory/job |
| `GET /api/jobs/:id` | — | limits, usage, progress, result/partial |
| `POST /api/jobs/:id/stop` | — | cooperative stop requested |
| `GET /api/sources/:id/impact` | — | K9 affected projects/pages/revisions |
| `POST /api/sources/:id/archive` | `{ archived: boolean, expectedUpdatedAt }` | K9 source state |
| `DELETE /api/sources/:id` | `{ expectedUpdatedAt, confirmSourceId }` | K9 logical delete + cleanup job/result |
| `GET /api/projects/:id/export` | — | streamed ZIP in K9 |

### Source admission

File:

```text
POST /api/projects/:projectId/sources/file
Content-Type: multipart/form-data
fields: file (exactly one, ≤25 MiB), title? (≤500 chars)
```

Text:

```json
POST /api/projects/:projectId/sources/text
{ "title": "...", "text": "≤2 MiB UTF-8", "mime": "text/markdown" }
```

URL:

```json
POST /api/projects/:projectId/sources/url
{ "url": "https://...", "title": "optional" }
```

Every admission returns:

```json
{
  "source": { "id": "...", "title": "..." },
  "revision": { "id": "...", "readableState": "pending|..." },
  "duplicate": false,
  "attachableSourceId": null
}
```

A detected duplicate returns `duplicate:true` and the existing source identity; it never silently merges membership.
Replacement uses the same three payloads under `/api/sources/:sourceId/revisions/{file|text|url}` and requires
`expectedRevisionNo`.

`GET /api/revisions/:id/text` requires either no range (whole text within the response cap) or decimal `start`/`end`
UTF-8 byte offsets with `0 <= start < end <= canonical_size`. Default range cap is 256 KiB; whole download may stream.
Return `text/plain; charset=utf-8`, `X-Eliot-Byte-Start`, `X-Eliot-Byte-End`, revision ID and canonical SHA-256. Reject a
range that cuts through an invalid UTF-8 boundary rather than silently shifting it. Citation opens use stored verified
boundaries and therefore always pass.

### Chat submit body

The browser uses the Agent WebSocket, not a parallel chat HTTP API:

```ts
useAgent({ agent: "ChatAgent", name: chatId })
useAgentChat({
  agent,
  body: {
    version: 1,
    projectId,
    scope: { mode: "project_default" | "explicit" | "empty", sourceIds?: string[] },
    modelRoute?: string
  }
})
```

The body is untrusted selection input. `options.requestId` from `AIChatAgent` is the authoritative `turn_id`; server code
re-resolves project membership, current readable revisions, allowed model route and budget. Eval scripts connect to the
same Agent route/protocol with an owner service token; there is no test-only inference endpoint.

## 5. Capture, deduplication and deterministic canonicalization

### Admission and dedup key

Buffer one admitted file/body once. Compute SHA-256 and a compact dedup key:

```text
sha256(kind + NUL + provenanceIdentity + NUL + originalSha256)
```

`provenanceIdentity` is empty for file/text, normalized requested URL for static/browser capture, and source UUID for
owner-supplied Markdown. `source_revision.dedup_key` is unique, so concurrent duplicate admission has one winner. The
loser reads the winning source and returns duplicate/Attach.

### URL guard and provenance

URL capture accepts HTTPS by default. Reject credentials, IP literals, localhost and private/link-local hostnames; do
not enable VPC/private-network access. Revalidate every redirect, maximum five. GET only; no caller-provided headers or
cookies. Stream-read with an abort controller and stop at 10 MiB rather than trusting `Content-Length`; cap wall time at
20 seconds. The stored original is the exact response-body byte sequence exposed by Workers Fetch after platform HTTP
content decoding, not a claim to preserve wire compression. Record:

```json
{
  "requestedUrl": "...",
  "finalUrl": "...",
  "status": 200,
  "contentType": "...",
  "capturedAt": 0,
  "redirects": ["..."],
  "method": "static_fetch|browser_fetch"
}
```

This is a public-URL guard, not a claim of DNS pinning. The admission request performs the fetch once, stores exact raw
bytes and metadata, and only then starts `IngestWorkflow`. The Workflow reads R2; it never refetches.

### Canonical converters

A converter is deterministic, versioned and never calls a model:

- `utf8`: validate/decode UTF-8, remove BOM, normalize CRLF/CR to LF, reject NUL/empty text; otherwise preserve content.
- `unpdf`: pinned `unjs/unpdf`; load the PDF once and process pages sequentially rather than using an all-pages
  `Promise.all` helper under the 128 MiB Worker limit. Join pages with exactly two LF characters, record each page byte
  range, and apply only versioned whitespace rules. Use structured text items only for deterministic layout grouping.
- `html_text`: Worker `HTMLRewriter`; ignore script/style/noscript/template, retain headings/paragraph/list/table/link
  text with deterministic separators, resolve links from the stored final URL, and never execute page code.
- `owner_markdown`: validate owner-provided UTF-8 Markdown as a new revision.

Standalone images, scans with no useful text, encrypted PDFs and unsupported binary Office formats become
`needs_conversion`. Do not call `AI.toMarkdown` for canonical evidence: its image pipeline may generate descriptions,
and the current options do not disable those descriptions. A later explicit OCR contour may store OCR as derived text
or require owner acceptance before making a new canonical revision.

Canonical output is written before `blocks.json`; both include SHA/version. Advance `source.current_revision_id` only
for readable/readable-with-warnings output by compare-and-set.

## 6. Blocks, labels, citations and quotes

`blocks.json` schema:

```ts
type BlockMapV1 = {
  version: 1;
  canonicalSha256: string;
  bytes: number;
  pages: Array<{ page: number; start: number; end: number }>;
  blocks: Array<{
    index: number;
    kind: "heading" | "paragraph" | "list" | "table" | "code" | "quote";
    start: number;
    end: number;
    page?: number;
    headingPath: string[];
  }>;
};
```

All offsets are UTF-8 byte `[start,end)` in `text.md`, never JavaScript character indexes. Blocks do not duplicate body
text. Split prose near sentence boundaries around a bounded size; keep tables/code intact up to a hard byte cap, then
split by row/line. Validate increasing, non-overlapping in-range offsets before publication.

Turn/job labels are compact and frozen per operation: `[S1:14]`. Persistent page labels use the complete revision UUID:
`[R550e8400-e29b-41d4-a716-446655440000:14]`. The UI may shorten display text but stored identity never does.

Stored citation object:

```ts
type CitationV1 = {
  label: string;
  revisionId: string;
  block: number;
  start: number;
  end: number;
  sourceTitle: string;
  deleted: boolean;
};
```

Server resolution rejects unknown alias, wrong revision/scope, missing block and out-of-range bytes; rejected labels are
removed and counted. Saving an answer rewrites operation aliases to full persistent labels and stores resolved citation
objects. Citation chips render objects, not regex text alone.

Candidate quote verification: exact bytes in stated block, then adjacent blocks, then conservative whitespace/quote/
dash/soft-hyphen normalization with a reversible map to original bytes. Prefer the stated block; duplicate matches are
ambiguous. Drop unmatched claims. A structured numeric field is retained only when every digit group and material
condition is supported by the verified quote.

## 7. Atomic paid-effect budget and usage settlement

### Reservation protocol

`budget_reservation` is deliberately narrow. It serializes monthly spend; it is not a generic effect/proof ledger.
The concrete model-operation rows persist `input_token_limit`, `output_token_limit`, call count and `deadline_at`; the
reservation persists the monetary ceiling.


Before dispatch:

1. calculate a conservative upper bound from the selected route and hard input/output/call/time caps; persist those
   caps and the deadline on the concrete operation/run row;
2. in one transactional `DB.batch`, insert the reservation first, then the concrete operation/run that references it
   (or insert the reservation then update a queued run). The SQL trigger atomically increments
   `budget_month.reserved_microusd` only if it fits, and ownership triggers reject a mismatched operation;
3. on `budget_exceeded`, the entire batch rolls back and no external call occurs;
4. immediately before the external call, set `dispatched_at` and the operation's running/streaming state;
5. after completion, normalize usage, calculate actual cost and atomically set reservation `settled` plus operation
   terminal state;
6. when non-dispatch is proven, set `released`. If dispatch happened and outcome/usage is unknowable, settle the full
   reserved amount and mark usage conservative/unknown.

A reconciler may release only a stale reservation with `dispatched_at IS NULL` and no active platform operation. Final
reservations are immutable. The Cloudflare bill remains authoritative; Eliot is an admission guard and report.

Reservation ownership is exact:

| Operation kind | `operation_id` |
|---|---|
| `chat_turn` | `<chatId>:<turnId>` |
| `distill` | `distill_run.id` |
| `project_map` | `project_knowledge_run.id` |
| `research` | `research_job.id` |
| `ai_search_ingest` | `search_projection_run.id` |
| `ai_search_query` | `search_query_run.id` |

Research uses one aggregate reservation covering all allowed model/Web Search/Browser work. Its subcalls do not create
nested reservations. Every K5 AI Search request still has a `search_query_run`: chat/MCP/eval use `budget_mode=direct`
and their own `ai_search_query` reservation; research uses `budget_mode=aggregate`, `owner_operation_kind=research_job`
and points to the job's existing `research` reservation.

### Token normalization

Provider token semantics differ. Store:

- `input_tokens_total` — provider-reported total when available;
- `input_tokens_uncached`;
- `cache_read_tokens`;
- `cache_write_tokens`;
- `output_tokens`;
- `usage_quality = exact|derived|conservative|unknown`.

A route adapter documents whether total includes cache categories. Exact cost is:

```text
uncached_input × input_rate
+ cache_read × cache_read_rate
+ cache_write × cache_write_rate
+ output × output_rate
```

Never add cache tokens twice. If semantics/breakdown are incomplete, price the reported total at the ordinary uncached
input rate, do not also add reported cache tokens, reserve the configured maximum output, and mark `conservative`.
Unknown route prices disable the route.

AI Search included-use counters are local Eliot guards; they cannot see other account usage. Cloudflare dashboard/bill
is authoritative. Usage beyond Eliot's 90% headroom is off until the owner explicitly enables and reserves list-price
excess.

## 8. Models and cited chat

Internal routes are `workers-ai:<id>` or `gateway:<catalog-id>`. `src/models.ts` owns context limit, output reserve,
capabilities, usage semantics and dated prices. Unknown routes stay disabled.

Use the pinned experimental provider only behind one adapter:

```ts
import { createAI } from "agents/models/ai-sdk";

const cloudflare = createAI({
  binding: env.AI,
  id: "eliot",
  skipCache: true,
  collectLog: false,
  retries: { maxAttempts: 1 }
});
```

For every paid `streamText`/`generateText` call:

- `maxRetries: 0`;
- no fallback list;
- explicit abort/deadline and maximum output;
- `sessionAffinity` set to stable chat/job identity only where the selected Workers AI route supports it;
- AI Gateway response cache and prompt/response log collection off for private research payloads;
- Eliot stores only its own route/usage/timing/cost metadata.

Gateway/BYOK catalog routes require explicit owner credentials, price metadata and eval. Expensive models are never
automatically selected.

### Context modes

Freeze current readable revision UUIDs at turn start:

1. `whole`: labelled selected canonical texts fit within `min(0.6 × verified model context, 400000)` tokens after
   history/output reserve;
2. `claims` (K3): guides plus all selected verified claims fit when whole does not;
3. `search` (K5): guides plus at most six explicit shared-tool steps;
4. `none`: explicit empty scope and no claim that Library evidence was used.

Estimate preflight conservatively as UTF-8 bytes/3 until route-specific token counting is measured. History uses newest
prior turns, labels removed, at most 10% of context, and excludes answers citing revisions outside current scope. Keep
stable source-prefix ordering to permit provider prefix caching, but never assume a cache discount before usage proves it.

### `ChatAgent`

`ChatAgent extends AIChatAgent` and selects `messageConcurrency = "drop"`. Normal UI disables Send while streaming;
overlapping submissions cannot create a hidden queue of paid turns. Do not expose destructive regenerate. Leave
`maxPersistedMessages` unset so retained history is not silently deleted; prune only model context.

`onChatMessage(_onFinish, options)` calls one `runTurn`:

1. use the owner-only routed identity and verify chat/project existence in D1;
2. use `options.requestId` as `turn_id`; validate body version/project/scope/model selection;
3. freeze scope and atomically reserve/insert `chat_turn`;
4. assemble context; set dispatch state; call one `streamText`;
5. stream through AIChatAgent resumable protocol;
6. resolve labels, persist citations/usage/timing/terminal state and settle reservation.

Stop passes `options.abortSignal`, stores partial text and settles observed/full-reserved cost. Browser disconnect is not
Stop; reconnect replays the active stream. A provider/network failure is final for that turn. Retry is a new user action,
message, request ID and reservation.

Prompt contract: answer in question language; lead with the answer; append labels to every source-derived factual
sentence; distinguish inference; name missing evidence and abstain; never invent a label/source/page number.

## 9. One-time distillation

`source_revision.distill_state` is the owner-visible summary; `distill_run` preserves attempts and the exact model-call,
input/output-token and deadline bounds. On K3 activation, a
reconciler queues every current readable revision with `none`. Future ingest does the same. Project attachment never
queues duplicate work.

Scheduler rules:

- oldest queued first;
- configured concurrency default two;
- estimate both model calls and apply atomic budget admission;
- insufficient budget → `paused_budget`; input above verified context → `paused_too_large`;
- attempt ID/Workflow ID are created before dispatch;
- stale `running` rows reconcile against that exact instance; terminal Retry increments attempt.

Each model step has Workflow retries `limit: 0` and AI SDK retries zero:

1. labelled canonical text → `DistillDraftV1`:

```ts
type DistillDraftV1 = {
  version: 1;
  metadata: { title?: string; authors?: string[]; published?: string; language?: string };
  guide: string;
  suggestedQuestions: string[];
  claims: Array<{
    kind: "method" | "result" | "limitation" | "dataset" | "definition" | "other";
    statement: string;
    blockHint: number;
    quote: string;
    subject?: string; task?: string; metric?: string; dataset?: string;
    split?: string; protocol?: string; valueText?: string; unit?: string;
    higherIsBetter?: boolean; conditions?: string;
  }>;
};
```

2. code resolves exact quote ranges, parses numbers/units and drops/clears unsupported structure;
3. verified guide + claims only → `DistillSummaryV1 { version, digest, glossary:[{term,en,ru,definition,claimOrdinals}] }`;
4. store attempt artifacts, replace accepted claims and advance `current_distill_run_id` in one D1 transaction.

Project overview is deterministic from source titles, guide summaries and questions. Claim count/confidence never proves
quality.

## 10. Shared tools and MCP

Tools return compact Markdown, default maximum 4,000 estimated tokens, with explicit cursor/limit. Every tool accepts
`(env, actor, input)`, enforces authority/scope/output cap in code and uses full IDs returned by list tools.

| Tool | Backing before/after K5 |
|---|---|
| `list_projects` | D1 |
| `list_sources` | D1; full source/current revision IDs |
| `get_guide` | D1/R2 |
| `outline` | `blocks.json` |
| `read` | exact canonical R2 byte range/block/heading query |
| `find_claims` | D1 accepted claims + trigram FTS |
| `search` | K4 guides/claims/FTS; K5 AI Search with local fallback |
| `get_page` | D1/R2 |
| `propose_page` | D1/R2 proposed revision only |
| `web_search`, `capture_url` | K7 only; not exposed to external agents by default |

Descriptions stay under 60 words and tell the model when **not** to use the tool. Code, not the description, enforces
scope and bounds.

MCP uses installed SDK v2:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
```

Create a fresh stateless server per request at exact `POST /mcp`. Worker verifies Access first and closes the derived
actor over registered tool handlers. Configure exact `allowedHostnames`, no wildcard browser Origin, and `corsOptions:
false` unless a named browser client is added. Do not create an MCP Durable Object/session, OAuth subsystem, business API,
large upload tool or public endpoint.

## 11. Optional AI Search projection

K5 remains disabled until its spike proves offsets, filters, Russian quality and value. The selected profile is versioned
and explicit: instance ID, embedding model, vector/keyword index method, tokenizer, keyword mode, fusion, chunk size,
overlap, max results, score threshold, reranking, query rewriting and cache. A changing platform default never silently
reindexes the Library.

Initial intended profile after the spike:

- one built-in-storage instance `library-v1` in namespace `default`;
- hybrid index; 512-token chunks; zero overlap;
- reranking, query rewriting and similarity cache off;
- metadata: `revision_id`, `source_id`, `language`, `profile`, `segment`;
- full-text for quoted identifiers/numbers; hybrid for semantic questions.

Index current canonical bytes only. Reconcile all current readable revisions when K5 activates. Keep each uploaded
segment at or below 9 MiB for headroom under the current 10 MiB plain-text limit; split larger canonical files
deterministically at block boundaries. `search_projection_item.start_byte/end_byte` maps
segment-local offsets back to the revision. Item keys are deterministic:
`revision/<uuid>/<profile>/<ordinal>.md`.

One indexing attempt:

1. verify canonical hash/profile and local monthly caps;
2. write queued run/items and reserve any forecasted excess;
3. `uploadAndPoll` each deterministic item inside a coarse Workflow step with platform step retries disabled;
4. read item chunks, store chunk ID → segment/canonical byte map;
5. mark the complete profile ready, then delete predecessor profile items.

Query freezes revision scope and applies metadata filters before ranking. Empty scope makes no call. Before dispatch,
insert `search_query_run` plus a direct reservation in one D1 batch, or attach it to the existing aggregate research
reservation; after response update the local monthly counter and settle the direct operation (the job settles aggregate
cost). Hydrate each hit to canonical bytes, snap to covering blocks and emit ordinary Eliot labels. Any offset
mismatch, scope leak, unsupported filter or unavailable Search causes visible claim/narrower-scope fallback; never widen
scope or silently fan out queries.

Eliot-local caps: 4.5M ingestion tokens, 900 semantic/hybrid queries, 900 full-text queries and 9 GiB indexed bytes per
month. They retain included-tier headroom; account-wide Cloudflare usage may be higher.

## 12. Project map and strict comparison

`ProjectKnowledgeWorkflow` consumes guides and accepted verified claims, not raw full corpus by default. Build sorted
input revision IDs and SHA-256; unchanged successful input reuses the current page.

Comparison code parses/normalizes:

```text
subject/task family | metric | dataset identity | split | evaluation protocol | unit | direction
```

Use Unicode NFKC, case folding, punctuation/whitespace normalization and a small versioned alias dictionary. Parse units
and numeric values in code. A row is comparable only when every required dimension is known and compatible. Unknown,
ambiguous, different-unit, different-dataset, different-split or different-protocol results remain separate. A model may
suggest aliases for owner review; it cannot change the grouping during that run.

One bounded synthesis call may produce topic labels, gaps and reading routes from compact guides/claims. It receives the
deterministic comparison groups rather than raw result strings. Disagreement candidates exist only inside one compatible
group and show exact quotes plus conditions.

Store map Markdown, structured `data.json`, full input IDs and citations in a page revision. Advance
`project.current_map_run_id` only after accepted output exists. Source replacement/deletion marks pages stale when their
`inputs_json` contains that full revision UUID.

## 13. Deep research

A research job freezes scope, limits, route and deadline at creation. Estimate the full upper bound (model calls/tokens,
Web Search provider requests and Browser Run seconds), then atomically create `research_job` plus one aggregate budget
reservation. No iteration may enlarge it.

Validated plan/action contracts:

```ts
type ResearchPlanV1 = {
  version: 1;
  subquestions: string[];       // 1..12
  maxIterations: number;        // <= job.max_model_calls
};

type ResearchActionV1 =
  | { version: 1; type: "library_search"; query: string; sourceIds?: string[] }
  | { version: 1; type: "read"; revisionId: string; start?: number; end?: number }
  | { version: 1; type: "web_search"; query: string; limit: number }
  | { version: 1; type: "capture_url"; url: string; reason: string; allowBrowser: boolean }
  | { version: 1; type: "final"; markdown: string };
```

The planner/action model cannot supply counters, actor, credentials, budget or authority. Code validates that source IDs
are in frozen scope and capture URLs came from the current job's search leads or explicit owner input.

Workflow loop:

1. Library search/read first.
2. When allowed and needed, Cloudflare Web Search through the AI binding/Gateway. Default provider is Ceramic; no
   automatic provider fallback. Store query, provider, result URL/title/description and cost.
3. A result is a lead, not evidence. `capture_url` performs K1 static capture first. Only when static body is unsuitable,
   `allowBrowser` is true and remaining seconds/captures/budget fit may a pinned Cloudflare Playwright client open one
   Browser Run session, `goto` the validated URL, wait under the job deadline, and serialize `page.content()`. Do not use
   screenshot/AI extraction as text. Store the rendered HTML/provenance; deterministic `html_text` makes canonical
   evidence.
4. Before every model/search/browser call check state, Stop, deadline and remaining counters. Persist a planned `callId`
   before dispatch and the result after. Paid steps use no automatic retry; unknown outcomes stop partial rather than
   duplicate the call.
5. Persist monotonic D1 progress and latest partial Markdown/R2 event record after each completed iteration.
6. Final synthesis may cite only Library revision labels. Resolve citations and save completed/partial report page.

Static capture is not Browser Run. Browser time is measured in whole seconds conservatively; one active browser per job.
Stop changes state to `stopping`; the in-flight call may finish, but no next call starts.

## 14. Owner interface

Move the accepted Material UI; do not redraw it. `src/web/ui/` owns tokens/primitives/features. Raw colours, font stacks,
radii or timings outside tokens are defects. Move a feature only with the contour that makes it live; replace legacy API
and query adapters rather than copying them.

Routes:

- K0: `/`, `/settings`;
- K1: `/p/:projectId/sources`, `/p/:projectId/source/:sourceId?revision=&start=&end=`;
- K2: `/p/:projectId/chat/:chatId`, `/p/:projectId/studio`;
- K4: `/p/:projectId/inbox`;
- K6/K7: map/report/job views under the project.

Every screen has loading, empty, actionable error and relevant paused/stale/partial states. One Markdown renderer, raw
HTML disabled. Citation chips use resolved objects. Streaming reserves stable layout. Private source/page text is not
stored in localStorage, IndexedDB, service worker cache or analytics payloads.

## 15. Lifecycle and portable export

Detach removes membership only. Archive hides a source from new selection. Delete first returns an impact preview, then
marks source/revisions deleted so current retrieval excludes them. R2/Search cleanup occurs synchronously or by one
bounded daily cleanup; citation identity remains and displays deleted/missing evidence.

Source replacement/deletion marks dependent page revisions stale by full UUID in `inputs_json`; it never retargets a
citation. Settings explains that deleting Eliot's local copy cannot recall data already sent to a model/search provider.

Export streams ZIP rather than buffering it. Include:

- projects/memberships/sources/revisions manifest;
- exact originals and capture metadata;
- canonical texts/block maps;
- accepted claims and distill reports;
- pages, revisions, citation/data files;
- chats only through the selected `AIChatAgent` history export adapter once it is qualified;
- SHA-256/size/media type for every entry and manifest schema version.

Use a pinned Worker-compatible streaming ZIP implementation only when K9 starts. Verify every digest after extraction.

## 16. Dated platform facts, pins and open spikes

Checked against official Cloudflare documentation and pinned source on 2026-10-25. Recheck immediately before dependent
implementation/merge.

| Fact | Status |
|---|---|
| Worker isolate memory 128 MiB; Eliot file cap 25 MiB | verified; app cap deliberately lower |
| Hostname Access + Worker JWT validation supports the selected Agent WebSocket route | verified design; deployed handshake remains K0/K2 acceptance |
| D1 `batch()` is transactional and rolls back the sequence on statement failure | verified; budget admission relies on it |
| R2 conditional writes are atomic and R2 reads/writes/deletes/list are strongly consistent | verified |
| Workflows Paid includes 500k steps and 1 GB-month; retries/rollback handlers are not billed as steps | verified pricing |
| Workflow default step retry is five; paid/mutating Eliot steps must set retry limit zero | verified |
| New Paid Workflow default retention is seven days; max 30 | verified |
| `ctx.exports` Workflow calls require current Wrangler/Vite versions and possibly `enable_ctx_exports` | installed pins satisfy version floor; dry-run required |
| Agents SDK route is `/agents/<kebab-class>/<instance>` via `routeAgentRequest` | verified at pin |
| `AIChatAgent` persists SQLite messages and resumes streams; default concurrency is queue | verified; Eliot explicitly selects drop |
| `agents/models/ai-sdk` `createAI` supports gateway logging/cache/retry/session options | verified at pin; experimental surface |
| AI SDK model retries default above zero in relevant APIs | verified; Eliot sets `maxRetries:0` |
| AI Gateway logs are enabled by default unless overridden | verified; Eliot sends `collectLog:false` for private payloads |
| Workers AI Markdown Conversion may generate image descriptions and cannot disable them through current options | verified; not canonical evidence |
| AI Search billing starts 2026-11-01; included 5M ingestion, 10 GB-month, 1k semantic and 1k full-text queries | verified |
| AI Search excess: $0.75/M ingestion, $2/GB-month, $0.75/1k semantic/vector/hybrid, $0.10/1k full-text | verified |
| Browser Run Paid includes 10 browser hours/month; duration excess $0.09/hour | verified; session concurrency may add cost |
| Cloudflare Web Search beta providers: Ceramic $0.25/1k, Linkup $5/1k, Exa $7/1k | verified; provider terms/privacy recheck before K7 |
| GLM-5.3 Flash context/prices below | verified model page on audit date |

Primary verification pages:

- [D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [R2 consistency and conditional writes](https://developers.cloudflare.com/r2/reference/consistency/)
- [Workflow Workers API/exports](https://developers.cloudflare.com/workflows/build/workers-api/),
  [retry defaults](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) and
  [pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Markdown conversion options](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/)
- [AI Search items](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) and
  [limits/pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)
- [Web Search providers](https://developers.cloudflare.com/web-search/providers/)
- [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)

Pinned review baselines:

- `cloudflare/agents@321814b6c13f72cff82161e7eb20312574ac9b7a`;
- `unjs/unpdf@87c7edc43ee99a17d2aa20acf271c4889332720b` (MIT, package 1.9.1);
- installed `agents 0.30.1`, `@cloudflare/ai-chat 0.12.2`, AI SDK `7.0.152`, Wrangler `4.152.0`, Vite plugin `1.65.0`.

Initial model routes checked 2026-10-24/25:

| Use | Model ID | Context | $/1M input / cached input / output |
|---|---|---:|---:|
| default answer/distill/map/research | `@cf/zai-org/glm-5.3-flash` | 1,048,576 | 0.15 / 0.03 / 0.50 |
| owner-selected hard synthesis | `@cf/zai-org/glm-5.3` | 1,048,576 | 1.40 / 0.26 / 4.40 |

Open checks that remain deliberate spikes, not assumptions:

- exact maximum output tokens and usage/cache semantics of each enabled model route (K2);
- AI Search chunk offset correspondence to uploaded UTF-8, `$in` scope at 500 revisions and Russian tokenizer quality
  (K5);
- deployed Access service-token WebSocket handshake and actor propagation (K2);
- `AIChatAgent` history/export API needed for K9 portable chat export;
- Browser Run rendered HTML capture semantics and duration accounting (K7).
