# Eliot Research — Implementation

Technical contracts for [MAP](MAP.md). Build only the sections named by the active contour. Platform facts in §15 are
snapshots, not timeless assumptions; recheck official Cloudflare documentation and repository-generated types before
code depends on a price, limit, binding or SDK name.

| Contour | Sections |
|---|---|
| K0 Shell | §1–§2, §13 |
| K1 Read | §1, §3–§5, §13 |
| K2 Ask | §1–§3, §5, §8, §11, §13 |
| K3 Distill | §1, §3, §5–§6, §8 |
| K4 Agents in | §2–§3, §7, §10 |
| K5 Library scale | §3, §7–§10, §15 |
| K6 Project knowledge | §3, §12 |
| K7 Deep research | §3–§4, §7, §10–§12 |
| K9 Lifecycle | §3, §14 |

## 1. Runtime, layout and paid-effect admission

One pnpm package, one Cloudflare Worker and one React/Vite application. The Worker serves assets, Hono API, chat
WebSocket, MCP, Durable Object and Workflow classes. HTTP, chat, MCP and Workflows call the same product functions:
`(env, actor, input)`. Do not create service/repository/controller mirrors.

| Path | Owner |
|---|---|
| `src/index.ts` | routes, errors, DO/Workflow exports |
| `src/auth.ts` | Access JWT and actors |
| `src/cost.ts`, `src/models.ts` | dated model metadata, estimates, admission |
| `src/library.ts`, `src/ingest.ts`, `src/read.ts`, `src/blocks.ts` | Library and exact reading |
| `src/context.ts`, `src/citations.ts`, `src/chat.ts` | cited answers |
| `src/workflows/*.ts` | ingest, distill, project map, research |
| `src/tools/`, `src/mcp.ts`, `src/search.ts` | shared tools, MCP, optional AI Search |
| `src/shared/`, `src/web/` | shared payloads and owner UI |
| `migrations/`, `scripts/eval/` | contour schema and real acceptance |

Bindings arrive only with their contour: K0 `ASSETS`; K1 `DB`, `BUCKET`, `AI`, `INGEST`; K2 `CHAT`; K3 `DISTILL`
and cron; K5 direct `SEARCH`; K6 `PROJECT_KNOWLEDGE`; K7 `RESEARCH` and optional `BROWSER`. Generate `Env` with
Wrangler; never hand-write it.

A paid effect is a model call, rendered Browser capture, billable AI Search use, or a Workflow that invokes one. Page
load, list, read, citation open, reconnect and saving existing output must not start paid work. Before dispatch,
`src/cost.ts` computes a conservative upper bound and rejects or pauses when current-month estimates plus that bound
exceed `settings.monthly_model_budget_microusd` (default $5). Unknown prices are disabled, not treated as free. Store
actual input/cached/output tokens and estimated micro-USD on the row that owns the operation. Distillation runs once per
immutable revision; ordinary whole/claim answers use one model call; search/tool loops and explicit jobs have hard caps.

JSON lives under `/api/`, validated with zod. Error shape:

```json
{ "error": { "code": "invalid|not_found|conflict|busy|unavailable|budget", "message": "owner-readable text" } }
```

Use cursor pagination. Chat inventory uses immutable `(created_at,id)` descending so activity between pages cannot
move an unseen chat above the cursor. Add idempotency only where a natural key exists: turn ID, page-revision mutation ID and
deterministic Workflow ID. The MCP endpoint transports the shared toolset; it is not a second business API.

## 2. Access and actors

Use hostname-based Cloudflare Access applications:

- `research.<domain>` for UI/API/chat and owner service tokens;
- `mcp.research.<domain>` from K4 for agent service tokens.

Do not use Worker-level Access for the UI because its policy rejects WebSocket upgrades. Verify
`Cf-Access-Jwt-Assertion` signature, issuer, audience and expiry with `jose` and cached JWKS. Owner email or approved
owner service-token `common_name` becomes `owner`; approved MCP token becomes `agent:<client-id>`; everything else is
403. Browser mutations and WebSocket upgrades require the exact configured Origin. Agents may read and propose pages;
only owner accepts. Local bypass requires `ELIOT_LOCAL_DEV=1` and localhost; a deployed request seeing it fails closed.

K0 configuration uses `ELIOT_ACCESS_TEAM_DOMAIN` (bare `<team>.cloudflareaccess.com`), `ELIOT_ACCESS_AUD`,
`ELIOT_OWNER_EMAIL`, `ELIOT_OWNER_SERVICE_TOKEN` (the signed `common_name`, not a client secret), and `ELIOT_ORIGIN`.
`exp` is mandatory; only RS256 assertions are accepted. Local bypass runs before production configuration validation,
accepts only `localhost`, `127.0.0.1` or `[::1]`, and rejects Cloudflare edge requests carrying `cf-ray`. It never exempts
mutations or WebSocket upgrades from exact Origin checks. All static assets use `run_worker_first: true` and private,
no-store responses. `workers.dev` and previews are disabled for the replacement by default.
HTTP privacy/security headers are applied after the final response is constructed, including R2 downloads and ASSETS
responses. WebSocket 101 upgrade responses remain intact; they carry no cacheable document body. K0 checks HTML and
its entry asset as well as JSON, and K1 checks text/range/original response headers.

For local use, copy `.dev.vars.example` to `.dev.vars`, then `pnpm dev`. `pnpm cf:types` generates the checked-in Env;
the example keeps variable order aligned with Wrangler configuration so generation is stable locally and in CI.
`pnpm eval k0` exercises the actual running Worker and writes viewport screenshots to ignored `eval/out/k0/`.
On 2026-10-25 the owner retained the existing legacy `eliotr-core.kleymor-metal.workers.dev` hostname Access application;
no replacement deployment or new-domain setup has been performed. Live browser and deployed owner-token acceptance
remain separate from local/signed-fixture checks.

## 3. Data and immutable writes

Migrations own schema names:

| Migration | Adds |
|---|---|
| `0001_library.sql` | project, source, immutable revision, membership |
| `0002_ask.sql` | settings, chat/turn, page/revision, answer usage/cost |
| `0003_distill.sql` | distillation state/usage, source metadata, typed claims |
| `0004_agents.sql` | trigram claim FTS and backfill |
| `0005_search.sql` | K5 item state and monthly counters |
| `0006_jobs.sql` | K7 bounded jobs |

Store identities, relationships, states and compact claims in D1; bodies in R2:

```text
source/<revision>/original
source/<revision>/text.md
source/<revision>/blocks.json
source/<revision>/{guide.md,digest.md,glossary.json,distill.json,chunks.json}
source/<revision>/{distill-call1.json,distill-call2.json,distill-verified.json}
source/<revision>/checked/{guide.md,digest.md,glossary.json,distill.json}
page/<revision>/{body.md,citations.json,data.json}
```

Objects are immutable. Write R2 first, then the D1 pointer. Advance current/head revision by compare-and-set and return
`conflict` on a lost synchronous head race. Background ingest has already returned 202: an older completed conversion
stays readable with a visible conflict warning and never replaces the newer head. Retrying a page Save with the same
mutation UUID returns its already committed winner. Old revisions remain readable for old citations. Use UUIDs and Unix milliseconds. Do not add
a generic effects ledger; each operation stores its own model route, usage and estimate.

## 4. Ingest and conversion

The browser may select many files but sends one file/request with at most two concurrent requests. API file cap is
25 MiB, avoiding a buffered multipart batch near the 128 MiB Worker isolate limit. URL and pasted text use separate JSON
routes. Buffer once, hash SHA-256, store original, create pending rows and start deterministic `ingest-<revisionId>`.
An exact duplicate returns the existing source plus Attach; never silently merge.

The HTTP surface is `/api/projects`, `/api/projects/:id/sources/{file,text,url,attach}`, `/api/sources/:id` and
`/api/revisions/:id/{text,range,outline,original}`. The file route accepts one multipart `file`; text/URL use separate,
strict JSON shapes. An explicit `sourceId` replacement creates a new revision of that attached source, including a
deliberate reconversion of identical bytes. Ordinary duplicate uploads return 409 plus the existing identity; a
conditional insert in the D1 batch guards concurrent duplicates without a second identity store.

Revision metadata records `conversion_calls` before dispatch, nullable `conversion_tokens` when the service returns
usage, and `conversion_ms`. Every Workflow step has retries disabled; conversion is one call bounded to 60 seconds.
The Blob sent to `toMarkdown` carries its stored MIME type: the real service rejected an empty type. PDF metadata and
embedded-image conversion are disabled. Output containing only page headings is `needs_conversion`, never readable
source evidence. Exactly one leading UTF-8 BOM is removed before canonical storage; readers preserve those stored bytes.

`IngestWorkflow` converts native UTF-8 text locally. Cache `env.AI.toMarkdown().supported()` and call `toMarkdown` only
for required document formats. K1 does not opt into model-assisted image/OCR conversion: retain scans/images and mark
`needs_conversion`; owner-supplied Markdown creates a new revision. Static URL fetch is preferred; Browser Run is K7
only. Validate non-empty UTF-8, write `text.md` and `blocks.json`, then advance readable state. AI Search OCR is never
canonical source text.

URL guard: HTTPS by default; reject credentials, IP literals, localhost and private/link-local ranges; revalidate every
redirect; cap redirects, body and wall time. Network content is untrusted data.

K1 static capture uses HTTPS port 443, at most three redirects, a 15-second total deadline and a streamed 25 MiB cap.
Hostname validation does not pin DNS resolution; DNS rebinding prevention is not claimed. No owner/model credentials
are sent to captured sites or corpus download hosts. `ELIOT_REMOTE_BINDINGS=0 pnpm dev` disables remote services for
local native-text work and CI; the production bindings and Access checks are unchanged. `pnpm db:local` applies pending
`0001`–`0003` and `0005_model_gateway.sql` through `migrations/000[1235]_*.sql`; future K4 `0004` stays excluded.
Remote D1/R2 provisioning and deployment are not run.

## 5. Blocks, labels, citations and quote verification

`blocks.json` stores ordered heading/paragraph/list/table/code/quote blocks with nearest heading and exact UTF-8 byte
`[start,end)` in `text.md`. Compute byte offsets, not JavaScript character indexes. Split prose near sentence boundaries;
keep tables/code intact up to a bounded size.

Turn/job labels are compact (`[S1:14]`) and frozen per operation. Persistent labels use the full revision UUID
(`[R<revision-uuid>:14]`); UI may visually shorten them but stored identity never does. A citation stores full revision,
block, byte range, source title and deleted flag. Server resolves labels, removes unknown/out-of-scope labels and counts
them. Saving an answer rewrites compact aliases to persistent labels.

For each candidate quote, search exact bytes in the stated block, then adjacent blocks; only then apply conservative
whitespace/quote/dash/soft-hyphen normalization with a map back to original bytes. Prefer the stated block, mark
ambiguous duplicates, and drop unmatched claims. Every digit group in a structured numeric value must occur in the
verified quote or the structured numeric field is cleared.
Decimal values additionally require a complete matching token, including any exponent: `41.0` and a separate `8` do
not support `41.8` or `41,8`. Unambiguous decimal commas match decimal points; ambiguous comma-thousands keep the
existing digit-group rule. This check also applies to statements, conditions, digest and glossary; existing integer,
thousands and scientific-value checks remain in force.

The verifier stores the original canonical slice, including original whitespace and punctuation, after normalized
matching. Candidate statements with unsupported digit groups are dropped rather than retained with misleading prose.
Digest/glossary numeric statements are checked against only the verified quotes selected by their labels; a valid
label alone does not authorize a new number or experiment condition.

Claims retain source-language task/metric/dataset, value text, optional parsed number/unit, conditions, quote and exact
range. K6 owns cross-source normalization; K3 must not pretend raw multilingual strings are canonical.

## 6. One-time distillation

States: `none|queued|running|paused|done|partial|failed`. Ingest queues a readable revision only once when auto-distill
is enabled and no completed artifact exists. Cron admits oldest work while concurrency and monthly budget permit;
insufficient budget becomes visible `paused`. Workflow ID is `distill-<revisionId>`; reconcile stale `running` rows
against the existing instance instead of creating a retry service.

`DistillWorkflow` uses two bounded calls:

1. labelled canonical text → metadata, draft guide, 3–5 questions and candidate claims;
2. verified original excerpts → supported claim selection, final 3–5 sentence guide, digest and EN/RU glossary.

Each input block is a separate JSON record containing its exact `quoteBlock` and text, so a label does not implicitly
name following blocks or an entire section. The first output requests the source guide before detailed claims.
Each claim still selects one `quoteBlock` from the closed compact label set for that immutable revision. Code resolves
it to the full original block as its own quote, preserving PDF line-break hyphens, brackets and Markdown bytes;
the model does not transcribe canonical evidence. Claim quote/range and numeric checks remain against that one block,
and a statement that adds numbers absent from it is rejected.

Draft guide items use `{ labels, text }`, with the closed `labels` array of 1–4 source-block selections before `text`.
Code resolves every declared label to its exact canonical block and checks references and numbers against only the
union of those selected quotes. It splits authored prose and retains at most the first numerically supported sentence
per item, yielding at most five draft sentences; an early paragraph cannot consume the whole guide allowance.
`Verified.guide` retains these `{ labels, text }` records as hypotheses. Call two receives them directly alongside
candidate claims, with original excerpts as the sole evidence. The retained excerpt pool is exactly the union of
declared claim `quoteBlock` selections and guide `labels`; code adds no inferred evidence bindings. Final guide and
digest items also use `{ labels, text }` with 1–4 selected excerpts; glossary records likewise select labels first.
Historical cached synthesis rechecks do not consume `Verified.guide` or expand its frozen evidence pool, so this new
producer shape does not rebind or rewrite old artifacts. Raw selections are retained in R2, stored labels use the full
revision UUID, and a final user task explicitly states the English/Russian response language in both calls. These
request/validation changes do not establish paid-service or quality acceptance.

Code verifies quotes and numbers between calls. Draft statements are hypotheses, not evidence: the second call checks
each retained candidate against its own quote and can add a small number of atomic facts from the same frozen excerpts.
Only its supported, code-checked output is committed to the claim reader. Result claims describe one scalar result
per task/dataset/metric/condition instead of a compound table row. Citation annotations are resolved separately from
factual numbers; an unknown annotation rejects its item. Paid steps have no retry; only deterministic storage steps
may use bounded native Workflow retries, with immutable R2 writes and natural `(revision, ordinal)` claim keys.
Store raw result/report in R2, compact verified claims in D1, and usage,
cost and kept/dropped reasons on the revision. Assemble project overview deterministically from titles, guide summaries
and questions; do not buy an extra overview call. Quality is anchor facts and citation validity, not claim count.
`done` records a completed pipeline with supported artifacts; rejecting individual candidate hypotheses is normal
filtering and remains diagnostic. `partial` records a missing required component or an interrupted/error outcome,
not a nonzero drop percentage. The same exact-quote, numeric-support and anchor gates apply to both states.
Guide/digest describe the paper for the owner rather than candidate review or model reasoning. Conflicting source
values remain attributed to their separate source passages instead of being silently reconciled.
Known inline reference annotations are excluded from numeric verification but preserved as full persistent labels
in guide/digest/glossary storage, including within sentence-level validation. Code literals remain literal; unknown
annotations still reject the item. This avoids erasing an inline citation and leaving broken prose such as `block .`.

K3 records `distill_calls` (hard maximum two), `distill_started_at` and `distill_ms` on the owning revision. Admission
reserves both full-context call bounds in the same monthly pool as chat, with at most two revisions running. Each
Workflow paid step has zero retries; an atomic per-revision dispatch count prevents step replay from buying a duplicate
call. Completed/partial revisions return existing artifacts on a repeated explicit request. Budget-paused work resumes
only by explicit request. Unknown Workflow dispatch/status never authorizes another instance.
Each background distillation call has a 180 s deadline (native paid-step deadline 4 minutes); the K2 chat ceiling stays
90 s. The reader shows the current attempt count and the pre-dispatch maximum reservation. Long papers can use the
same bounded two-call pipeline without a chat-sized timeout or a reduced quality target.
An unconfirmed Workflow dispatch with zero paid calls is terminalized by a `running AND distill_calls=0` compare-and-set,
releasing its concurrency slot and unused reservation. If paid dispatch already won, its usage/reservation is retained.
A 15-minute product recovery ceiling (not a Cloudflare limit) prevents later paid dispatch; reconciliation finalizes
expired or lost instances instead of holding both slots forever. Status/storage errors remain visible. Failed work is
never recreated automatically, and uncertainty after a paid call never releases its conservative usage reservation.
Raw call output and verification details remain in immutable R2 artifacts. The final artifact is written before its D1
state; a lost D1 reply reconciles that same stored result without overwriting it or repeating inference. A conditional
write that finds an existing artifact must verify equal content; different content is a conflict. Digest paragraphs
are checked one authored sentence at a time with the same declared evidence, retaining supported sentences and
rejecting unsupported numbers without rewriting them. Guide/digest links resolve against the immutable block map,
while claim cards open their exact original quote ranges.

If both bounded calls finished, the owner can explicitly **Save available output** after failure or **Recheck saved
output** after a verifier correction. `POST /api/sources/:id/understanding` with `saveAvailable:true` validates the
retained current-shape synthesis against frozen canonical excerpts and commits supported artifacts only. This path
never admits, dispatches or retries a model call and works with no remaining model budget. Missing/incompatible output
returns 409. Original `distill.json`, any earlier recovery report, and original derived bodies remain intact.

The corrected guide, digest, glossary and report use fixed immutable `source/<revision>/checked/` keys. The report's
`artifacts` map names those three bodies; nullable `source_revision.distill_report_key` selects the current report.
Publish this head, `guide_summary`, `claim_count` and the current claim rows in one D1 batch guarded by the old head.
Current claims are the ordinal prefix `[0, claim_count)`; upserts retain existing row IDs, and old trailing derived rows
are retained but excluded by readers, context and later FTS queries. No original or legacy/live data is deleted.
Calls, tokens, estimated cost and original model wall time remain unchanged. A repeated save of the checked head
returns the same result. GET exposes `canRecover` from compatible stored output only; failed output is never re-queued.

## 7. Shared tools

Tools return compact Markdown with explicit pagination and a default 4,000-token cap:

`list_projects`, `list_sources`, `get_guide`, `outline`, `read`, `find_claims`, `search`, `get_page`, `propose_page`; K7
adds `web_search`, `web_read`, `capture_url`. Every tool accepts `(env, actor, input)`, enforces scope/output/write
authority in code and uses full source/revision IDs from `list_sources`. Descriptions stay short and state when to use the
tool. Before K5, `search` uses guides/claims/FTS; after K5 it may use AI Search with claim fallback.

## 8. Ask and context

Freeze current readable revision IDs at turn start. Context modes:

1. `whole`: selected labelled text fits within `min(0.6 × model context, 400k)` tokens after history/output reserve;
2. `claims` (K3): guides plus verified claims fit when whole does not;
3. `search` (K5): guides plus at most six shared-tool steps;
4. `none`: explicit empty scope and no Library claim.

Claims mode includes the stored guide with its exact quoted source passages, not an unlabelled summary that the
answer cannot cite. Guide ranges are hydrated through R2 range reads; the whole source body is not loaded on this path.

Estimate text conservatively as UTF-8 bytes / 3. History is newest prior turns, stripped of labels, capped at 10% of
context and excludes answers whose cited revisions are outside scope. Keep source-prefix bytes stable for cache reuse.

One `runTurn(input)` backs WebSocket and synchronous eval. Insert `chat_turn(state='started')` before dispatch, apply
budget admission, assemble context, stream once, resolve labels server-side, then persist answer, citations, tokens,
first-token/total time, cost, invalid-label count and terminal state. One active turn/chat; queue one second submission.
Stop stores partial text. Closing a tab does not cancel. Failed streams are never auto-continued; Retry creates a new
turn. Prompt rules: answer in question language, lead with answer, cite each source-derived factual sentence,
distinguish inference, abstain with missing evidence, and never invent labels.

K2 uses the installed Agents SDK 0.30.1 `Agent` with SQLite turn storage and read-only WebSocket snapshots; HTTP Send
is the paid caller. SDK state is server-owned, reconnect never resubmits, and a third input returns `409/busy` while
one turn is active and one is queued. Stop and queued cancellation are visible; partial text remains saveable.
AI SDK 7.0.152 receives system rules through `instructions`, with source text in an untrusted user message.
One structured streaming output contains statements and labels constrained to the frozen block set; server code
renders and resolves those model-selected labels. There is no repair call or fabricated fallback citation.
The real Workers AI GLM 5.3 Flash structured streaming call was exercised on 2026-10-26. Admission reserves the full
model context at uncached input price plus maximum output, then settles to reported SDK usage; unknown usage retains
the reservation. Saving rewrites aliases outside code fences and uses a page mutation UUID without model work.

## 9. AI Search projection — K5 only

AI Search is optional and must pass the K5 spike: exact byte-offset mapping, revision-scope filters including 500 IDs,
Russian tokenizer quality, installed binding behaviour, measured gain over claims/FTS, and an acceptable monthly
forecast. Failure keeps whole/claim/FTS and narrower scopes; it does not authorize a custom Vectorize stack.

After the gate, use one built-in-storage hybrid instance `library-v1` in `default` through a direct `ai_search` binding.
Index only current readable revisions; unchanged revisions are not uploaded again. Start with 512-token chunks, zero
overlap, reranking/query rewrite/cache off, and only revision/source/language metadata. Run `uploadAndPoll()` inside one
Workflow step, persist chunk-ID → canonical byte ranges, switch to the replacement item only after ready, then delete
the old search item. Canonical R2 text remains.

Resolve scope before retrieval and filter before search. Empty scope makes no call. Use full-text for quoted
identifiers/numbers and hybrid for semantic questions. Hydrate each hit to canonical bytes and ordinary Eliot labels.
On errors, offset mismatch or unsupported filter size, fall back to claims/narrower scope without widening or silently
batching expensive queries.

Initial monthly owner guard leaves included-tier headroom: 4.5M ingestion tokens, 900 semantic/hybrid queries,
900 full-text queries and 9 GiB indexed storage. Recheck before merge because billing begins 2026-11-01.

## 10. MCP and Workflows

Use the installed Agents SDK `createMcpHandler` path verified by generated types, a fresh MCP SDK v2 server/request and
stateless Streamable HTTP at `POST /mcp`. Allow exact hostnames only. Register §7 tools; no K7 web tools before K7 and no
large upload through MCP.

Workflow IDs are deterministic: `ingest-<revision>`, `distill-<revision>`,
`project-<project>-<inputHash>`, `research-<job>`. Reuse an existing instance according to installed types. Each external
call is one retryable step; each deterministic write is a short separate step. Avoid fine-grained polling loops because
steps are billed; use `uploadAndPoll` in one step when safe. Bodies stay in R2 and Workflow state keeps IDs/counts/compact
diagnostics. Progress lives in the D1 row already polled by UI. Check cancellation and budget before every external
call; an in-flight call may finish.

## 11. Models

Routes are `workers-ai:<model>` or `gateway:<provider>/<model>`. `src/models.ts` owns context, output reserve,
capabilities and dated unit prices. Unknown routes stay disabled. Native routes rechecked 2026-10-26 (pricing page
updated 2026-10-20); external facts below checked 2026-10-26:

| Use | Route | Context | Max output | $/1M input / cached / output |
|---|---|---:|---:|---:|
| default answer + distill | `workers-ai:@cf/zai-org/glm-5.3-flash` | 1,048,576 | 8,192 | 0.15 / 0.03 / 0.50 |
| owner-selected hard synthesis | `workers-ai:@cf/zai-org/glm-5.3` | 1,048,576 | 8,192 | 1.40 / 0.26 / 4.40 |
| optional OpenRouter; local WIP | `gateway:openrouter/dots-studio/dots-3-note-preview:free` | 512,000 | 460,800 | 0 / — / 0 |
| optional OpenRouter; local WIP | `gateway:openrouter/thinkingmachines/inkling:free` | 1,048,576 | 262,144 | 0 / — / 0 |
| optional OpenRouter; local WIP | `gateway:openrouter/nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | 131,072 | 0 / — / 0 |

OpenRouter `maxOutputTokens` preserves the verified provider cap. Ordinary chat/distill jobs separately retain the
existing 8,192-token output bound in `outputReserveTokens`: `modelOutputLimit = min(outputReserveTokens ?? maxOutputTokens,
maxOutputTokens)`. Use that result for request output, context fit and budget reservation. Context limits stay unchanged;
the reserve does not redefine model capacity or force claim-mode overflow. Native configured output remains 8,192.
Show model capacity and the job bound only in advanced model details, keeping ordinary Material controls/layout.

Native answer/distill defaults remain Flash; the expensive native route is never automatic. These three exact `:free`
IDs are the only registered external generation choices. The public catalog prices prompt/completion at zero and lists
no separate cached-input rate. Their model-token estimate is zero, not a promise of unlimited quota or availability.
Provider limits/errors remain visible failures; no artificial local quota, paid fallback or alternate model is added.
`nvidia/nemotron-3.5-embed-8b:free` and `nvidia/nemotron-3.5-rerank-8b:free` are separate future K5 capabilities, not chat choices.

Local connection contract: `0005_model_gateway.sql` adds nullable `settings.model_gateway_id`; null disables the
external routes. `GET /api/models/connection` returns `{ connection: { gatewayId, provider: "openrouter",
alias: "default" } }`. Owner-only `PUT` accepts `{ gatewayId, confirmCredentialAccess: true }` to enable access to
the owner's existing OpenRouter default BYOK credential, or `{ gatewayId: null }` to disconnect. The owner checkbox is
mandatory when enabling; existing credential metadata grants no access by itself. Use an exact existing named Gateway
in the Worker's account; `default` is rejected because that name can create a Gateway implicitly. Saving records
configuration without checking Gateway existence or provider usability. No new credential, secret input, provider
Authorization header or dummy key is needed. Credentials stay in Cloudflare; the app uses only the `default` BYOK alias.

External transport uses installed `agents@0.30.1` and `@ai-sdk/openai-compatible@3.0.79` (Apache-2.0). Build the vendor
model with `createOpenAICompatible({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1", includeUsage: true, ... })`
and `openrouter.languageModel(model.id)`, then wrap the model object with
`createAI({ binding: env.AI }).languageModel(vendor, { gateway: { id, ... }, vendorKey: "gateway", ... })`.
The Agents adapter replaces the vendor fetch with the AI binding's provider-native `AI.fetch` path; it does not treat
`openrouter/<id>` as a Cloudflare catalog model. No direct provider key, fallback legs or dynamic route is used.

The request body sets `provider: { allow_fallbacks: false, require_parameters: true }`. Request headers set
`cf-aig-no-wholesale: true`, `cf-aig-max-attempts: 1`, `cf-aig-skip-cache: true`, `cf-aig-collect-log: false` (strings).
Gateway options also set the saved ID, `skipCache: true`, `collectLog: false` and `retries.maxAttempts: 1`. Forwarding
these controls through the installed adapter/workerd is source evidence, not proof of live Gateway/provider enforcement.
Current OpenRouter service acceptance is **NOT_RUN**; saving configuration or earlier provider fake-binding checks do not
prove these routes usable. Owner credential access and model selection remain explicit.

Dots and Nemotron advertise `response_format` and `structured_outputs`; Inkling advertises neither. Inkling's contract
is ordinary JSON text: chat/distill add the schema to `instructions` before vendor conversion, the transport removes
`response_format`, and `Output.object` validates locally. Invalid output fails without a repair model call.

The OpenRouter usage converter preserves absent input/output counts as unknown rather than the provider SDK's
zero defaults. Reported output includes reasoning; do not add reasoning again or subtract it for billing. Cached input
remains part of input. When total and prompt counts are available, output uses the larger of reported completion and
`total - prompt`; contradictory totals leave output unknown. Unknown usage retains the admitted estimate. These are
local adapter contract checks; no Google `combinedUsage` or external service billing acceptance is claimed.

Explicit Understand accepts optional `input.model` and freezes the selected route in that revision's `distill_model`.
Connection availability is checked before budget admission; the call transport resolves before the dispatch counter.
A disconnected external route already queued becomes `paused` with zero calls. Reconnecting does not resume it;
the owner must request Understand explicitly. Completed/partial revisions are not re-distilled by changing the model.
Chat uses one model call and distill at most two; both use AI SDK `maxRetries: 0`, and model Workflow steps use retry
limit zero. Only deterministic storage steps may retry. No continuation or repair call follows a failed model response.

Official public metadata checked 2026-10-26 at 23:13 UTC: [OpenRouter catalog](https://openrouter.ai/api/v1/models) and
the [Dots](https://openrouter.ai/api/v1/models/dots-studio/dots-3-note-preview:free/endpoints),
[Inkling](https://openrouter.ai/api/v1/models/thinkingmachines/inkling:free/endpoints), and
[Nemotron](https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-super-vl:free/endpoints) endpoint records. This is a
retrieval date; those API records provide no `dateModified`.
Transport references: [Agents AI SDK](https://developers.cloudflare.com/agents/models/ai-sdk/) (updated 2026-10-26),
[Cloudflare OpenRouter provider](https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/) (2026-04-20),
[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) (2026-09-22),
[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) (2026-09-30),
[request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/) (2026-09-14), and
[OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

## 12. Project knowledge and research

Project map consumes guides and verified claims, not raw corpus by default. Incrementally assign changed sources to at
most 12 topics. Parse numbers/units in code and normalize task/metric/dataset using Unicode NFKC, lowercase and
whitespace/punctuation rules. One bounded semantic call may map unmatched EN/RU synonyms but cannot override
unit/dataset/condition incompatibility. Comparison rows require at least two compatible sources; disagreement candidates
show both exact quotes. Store body, structured data, full input revision IDs and citations. Source change marks only
dependent pages stale; Refresh writes a new revision. Generate Wiki pages only on request.

Deep research is an explicit bounded Workflow: Library first, optional web lead generation, capture selected pages
through K1, then synthesize. Prefer static fetch; use Browser Run only when rendering is necessary. Never cite an
uncaptured web result. Check stop/budget before every external call and preserve readable partial findings.

## 13. Owner interface

Move the accepted Material 3 Expressive UI; do not redraw it. `src/web/ui/` owns tokens/primitives/features. Raw colours,
font stacks, radii or timings outside tokens are defects. Move each feature with the contour that makes it live and
replace legacy adapters rather than copying old runtime/query layers.

Routes: K0 `/`, `/settings`; K1 `/p/:projectId/sources`, `/p/:projectId/source/:sourceId?start=&end=`; K2
`/p/:projectId/chat/:chatId?`, `/p/:projectId/studio`; K3 `/p/:projectId/overview` and understanding in the source reader.
Every screen has loading, empty and actionable error states plus
stale/paused where relevant. Use one Markdown renderer with raw HTML disabled and resolved citation chips. Do not cache
private text in localStorage or a service worker.

## 14. Lifecycle and export

Detach removes membership only. Archive hides a source from new selection. Delete previews affected projects/pages,
marks deleted immediately, then removes R2/search objects synchronously or in daily cleanup. Deleted evidence stays
identified and citations never retarget. Replacement/deletion marks pages stale from full revision IDs. Export streams
a ZIP of originals, `text.md`, claims, pages/citations and a checksum manifest.

## 15. Platform facts and open checks

Checked against official Cloudflare documentation on 2026-10-24. Recheck before implementation or merge.

| Fact | Status |
|---|---|
| Workers Paid minimum $5/account/month; isolate memory 128 MiB; Free/Pro request body 100 MB | verified; Eliot caps files at 25 MiB |
| Worker-level Access rejects WebSocket upgrades | verified; use hostname Access |
| Workflows Paid: 500k steps + 1 GB-month included; then $0.80/100k steps and $0.20/GB-month; retries not steps | verified |
| Workers AI: 10k free neurons/day; Paid excess $0.011/1k neurons | verified |
| `toMarkdown` free for most formats; model-assisted image conversion may consume Workers AI | verified |
| GLM contexts/prices in §11 | verified model pages |
| Direct `ai_search` binding addresses an existing default-namespace instance | verified |
| AI Search billing starts 2026-11-01; included 5M ingestion, 10 GB-month, 1k semantic and 1k full-text queries | verified |
| Excess: $0.75/M ingestion, $2/GB-month, $0.75/1k semantic/vector/hybrid, $0.10/1k full-text | verified |
| AI Search text/code and OCR PDFs max 10 MiB; other files/PDF without OCR max 4 MiB | verified |
| AI Search chunk offsets exactly equal uploaded UTF-8 bytes | **open — K5 spike** |
| `$in` handles 500 revision IDs on the real binding | **open — K5 spike** |
| Best Russian keyword tokenizer | **open — K5 spike** |
| Prompt-cache behaviour and maximum output for each enabled route | **open — K2 measurement/schema check** |

### Unmerged proposal PR #419 (explicitly unaccepted)

[PR #419](https://github.com/UnknownAlienHuman/eliot-research/pull/419) (`docs/final-contract-audit` @
`4dfcd8eb308e84f26c6c7e42a921aec25746a19c`) is **OPEN / CONFLICTING** (`mergeStateStatus: DIRTY`, not merged),
checked live 2026-10-26 after the K1 duplicate-fix delivery. GitHub reports its base SHA, also the comparison merge base, as
`397d04538dceca69eb975896513a6049f2d4a266`; current remote `main` and local `origin/main` are
`ca4405576272a72654981d34b817c8f0ff7f8ef4`. Local `main` is `909c641ecd5af737d9c79ca650c2fb98f7160533`
plus shared K3 WIP. The PR has one commit changing 18 documentation/migration files, including rewrites of
`0001`–`0004` and new `0005_search.sql`, `0006_project.sql`, `0007_jobs.sql`; it supplies no converter runtime.
Its proposed contracts are not accepted architecture or evidence that the current product implements them.

The PR's §4 rejects `AI.toMarkdown` as canonical evidence and proposes deterministic UTF-8/PDF/HTML extraction.
Current K1 code on `origin/main` and local WIP still uses native text or `env.AI.toMarkdown().transform()`;
standalone images are rejected before conversion, and embedded HTML/DOCX/PDF images request
`convert: false, maxConvertedImages: 0`, with PDF metadata disabled. Installed `@cloudflare/workers-types`
`5.20261024.1` exposes those embedded-image controls; that type contract does not prove service output contains
no generated descriptions. The PR's contrary platform claim is also not established by its documentation alone.
Existing K1 corpus evidence belongs to the recorded converter/output, not an unimplemented replacement;
no new image-heavy PDF check or conversion was run in this reconciliation.

The proposed PDF donor is already pinned: `unjs/unpdf@87c7edc43ee99a17d2aa20acf271c4889332720b`, package
`1.9.1`, MIT, paths `src/text.ts` and `examples/cloudflare/index.ts` verified at that commit. Its text helpers
use `Promise.all` over pages, so the PR's sequential-page requirement still needs implementation and measurement.
Both registries retain legacy Eliot `7c034569b908d3b03a8b821b7c537477a24b10f7` and Agents
`321814b6c13f72cff82161e7eb20312574ac9b7a`; the current registry retains
`packages/cloudflare-markdown/src/markdown-conversion.ts`, while the PR removes that converter donor.

| Choice needing owner decision | Implication |
|---|---|
| Canonical converter: retain current K1 path or adopt deterministic extraction | Current instruction retains `toMarkdown`; adopting the pinned `unpdf`/HTML proposal requires an explicit converter change and fresh K1 acceptance. Existing canonical revisions/citations must remain intact. |
| Image evidence: current no-OCR policy or a separately accepted OCR/description path | Keep originals and `needs_conversion`; embedded-image opt-out needs real output verification. Accepting derived image text as canonical evidence would require an explicit policy and a new revision, not a silent reinterpretation of old text. |
| Schema: current revision-owned state or PR attempt/reservation tables | Reconcile deliberately with current callers and retained local data. PR `0001` excludes `workers_ai_markdown` and replaces `readable_size` with `canonical_size`; `0002` renames the budget field and adds `budget_month`/`budget_reservation`; `0003` adds `distill_run`/`claim.distill_run_id` and different paused states, whereas local WIP retains revision-owned `distill_started_at`, `distill_calls` and `distill_ms`. These are incompatible contracts, not append-only migrations ready to apply. |
