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
| `src/cost.ts`, `src/models.ts`, `src/model-{catalog,quota,transport}.ts`, `src/native-model-catalog.ts` | usage, catalogues, model bounds and provider admission/transport |
| `src/library.ts`, `src/ingest.ts`, `src/read.ts`, `src/blocks.ts` | Library and exact reading |
| `src/ocr.ts`, `src/workflows/ocr.ts` | explicit PDF OCR, saved preview and storage-only Apply |
| `src/context.ts`, `src/citations.ts`, `src/chat.ts` | cited answers |
| `src/workflows/ingest.ts`, `src/workflows/ocr.ts`, `src/workflows/distill.ts` | implemented ingest, explicit OCR and distillation workflows |
| `src/tools.ts`, `src/mcp.ts`, `src/proposals.ts` | shared tools, MCP and owner-reviewed proposals |
| `src/shared/`, `src/web/` | shared payloads and owner UI |
| `migrations/`, `scripts/eval/` | contour schema and real acceptance |

This table names current owners. AI Search (`src/search.ts`, K5), project-knowledge and research workflows (K6/K7)
are planned only; their files and bindings are not part of the current replacement. Add them only at their MAP gate.

Bindings arrive only with their contour: K0 `ASSETS`; K1 `DB`, `BUCKET`, `AI`, `INGEST`, plus `OCR` for explicit PDF jobs; K2 `CHAT`; K3 `DISTILL`
and cron for reconciliation and the explicitly requested queue; K5 direct `SEARCH`; K6 `PROJECT_KNOWLEDGE`; K7 `RESEARCH` and optional `BROWSER`. Generate `Env` with
Wrangler; never hand-write it.

A paid effect is a model call, rendered Browser capture, billable AI Search use, or a Workflow that invokes one. Page
load, list, read, citation open, reconnect and saving existing output must not start paid work. Before dispatch,
`src/cost.ts` claims admission separately from nullable declared token capacity and checks call/time limits and provider allowance. Model prices and a local
monthly currency/token budget are not admission prerequisites. Store capacity basis and actual input/cached/output
counts on the owning row; unknown counts remain unknown. Historical currency estimates and reservations remain recorded
without being reinterpreted as tokens or Neurons. Distillation runs once per
immutable revision; ordinary whole/claim answers use one model call; search/tool loops and explicit jobs have hard caps.

Understanding readers preserve the revision's stored model route even when it is absent from the live catalogue.
`progress.configuredModel` separately names the current default for an explicit new/resumed job. Unknown preview
metadata stays null. The storage reader starts no discovery or generation.

JSON lives under `/api/`, validated with zod. Error shape:

```json
{ "error": { "code": "invalid|not_found|conflict|busy|unavailable|budget", "message": "owner-readable text" } }
```

Use cursor pagination. Chat inventory uses immutable `(created_at,id)` descending so activity between pages cannot
move an unseen chat above the cursor. Add idempotency only where a natural key exists: project/chat/turn ID, source-revision ID, page-revision mutation ID and
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
It reports authentication observed in twelve parsed `/api/me` responses; deployed Access owner-token and browser-login
checks always remain `NOT_RUN` because the browser eval accepts loopback origins only, even with synthetic CI Access headers.
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
| `0005_model_gateway.sql` | nullable `settings.model_gateway_id`; existing-Gateway opt-in |
| `0006_integrity.sql` | approved #420 guards for source/page ownership and terminal-turn/capture-identity immutability |
| `0007_manual_understanding.sql` | explicit source understanding, removal of the automatic switch |
| `0008_model_providers.sql` | provider configuration, owning-row token bounds and saved native usage choice; existing accounting data retained |
| `0009_agents.sql` | trigram claim FTS/backfill and immutable proposal base revision |
| `0010_source_ocr.sql` | owner-requested `source_ocr_job`, frozen PDF/model inputs, bounded page progress/usage, preview identity and applied revision |
| `0011_studio_pages.sql` | published-page index on immutable creation time and ID for Studio pagination |
| `0012_model_admission.sql` | chat admission claim independent of nullable capacity, revision capacity basis; old terminal receipts remain unchanged |

Apply all active `migrations/*.sql` in filename order: currently `0001`–`0003` and `0005`–`0012`.
The unaccepted `0004_agents.sql` draft is preserved at `infra/legacy-migrations/0004_agents.sql`, outside that selection.

Store identities, relationships, states and compact claims in D1; bodies in R2:

```text
source/<revision>/original
source/<revision>/original-<upload>  # caller-ID file replacement; server-owned upload UUID
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

`POST /api/projects` accepts an optional caller UUID. Repeating it with the same trimmed title and effective description
returns the active project without updating it; changed inputs or an archived/renamed collision return 409. New and
replayed acceptance responses retain 201. Omitting the UUID still creates a new project.
Project lists default to active rows; `/api/projects?archived=true` returns only archived projects with the same
50-row cursor pagination. Archive/restore uses the existing project PATCH and changes no memberships, evidence,
history or pages. Omitted title/archive fields are preserved by the UPDATE itself so concurrent Rename and Unarchive
cannot restore one another's stale values. No deletion or model work is part of project archival.

**Freshness repair — implementation and acceptance in MAP.** Ingest publication batches its terminal revision,
guarded readable head and dependent accepted-head staleness atomically; OCR Apply also invalidates existing accepted
heads. Match exact string revision IDs in accepted heads' `inputs_json`; do not stale unrelated pages or pages on a
failed head race. `saveAnswer` and proposal acceptance calculate freshness inside their existing guarded head UPDATE,
in the same D1 batch that inserts or accepts the immutable page revision. Evaluate every recorded `inputs_json` ID,
including uncited context, as an exact JSON string against its available, readable source revision and that source's
current readable head. Missing, deleted, unreadable or superseded inputs make the new head stale; all-current inputs
and the empty input array make it current, including when replacing a stale head. Archive or detach alone does not
make evidence unavailable. A source switch serialized before publication is observed there; a switch serialized after
publication invalidates the newly accepted dependent head. Historical input order, bodies and citation bytes remain
unchanged. Repeated Save/Accept returns the recorded winner without recomputing freshness; Reject, a failed head CAS
and replay of an older acceptance cannot change another head's freshness. No dependency store, automatic refresh or
model call is added. Studio freshness display remains the separate open §13 repair.
Freshness follows the current readable head: a pending, failed or unreadable replacement retains the prior readable
evidence until a new readable head wins. Show that replacement's conversion state separately.

## 4. Ingest and conversion

The browser may select many files but sends one file/request with at most two concurrent requests. API file cap is
25 MiB, avoiding a buffered multipart batch near the 128 MiB Worker isolate limit. URL and pasted text use separate JSON
routes. Buffer once, hash SHA-256, store original, create pending rows and start deterministic `ingest-<revisionId>`.
An exact duplicate returns the existing source plus Attach; never silently merge.

The HTTP surface is `/api/projects`, `/api/projects/:id/sources/{file,text,url,attach,available}`, `/api/sources/:id` and
`/api/revisions/:id/{text,range,outline,original}`. The file route accepts one multipart `file`; text/URL use separate,
strict JSON shapes. Reader text/outline GET failures expose an explicit Retry readable text action for the same
revision and selected UTF-8 range. Retry coalesces repeated clicks, does no writes or model work, and ignores departed
responses. Text, outline and loaded revision publish together: a failed outline cannot leave another revision's text
under the previous revision identity. Read failures are separate from clipboard and upload actions.
An explicit `sourceId` replacement creates a new revision of that attached source, including a
deliberate reconversion of identical bytes. Ordinary duplicate uploads return 409 plus the existing identity; a
conditional insert in the D1 batch guards concurrent uploads and replacements against the same bytes belonging to
another live source. Only a stored revision starts ingest; a losing request retains the existing source and revisions.
File replacements may supply a revision UUID. A repeat returns that stored revision only when source membership and
the immutable file identity match; changed bytes, metadata or an unavailable revision are rejected. It performs no R2 write
or Workflow creation. Concurrent attempts use separate server-owned original keys: only the key recorded on the winning
D1 revision may start ingest, including after a lost batch reply. Losing attempts may remove only their own unreferenced key.

Add sources → Browse Library lists active shared sources not already attached to that project, including saved sources
not yet readable. `GET /api/projects/:id/sources/available` reads metadata only: 50 rows plus one lookahead, ordered by
immutable `(source.created_at,source.id)` descending. Its value cursor is JSON `[projectId,createdAt,id]`, checked for
project, safe nonnegative timestamp and UUID. Attaching a row cannot move the cursor or admit conversion/understanding;
the existing idempotent Attach reuses the shared source identity. Its source read may finish storage publication
of an already completed ingest from the existing Workflow result and matching retained artifacts (§4); it starts no
new conversion, understanding or model call. Membership insertion remains idempotent.
An attached row opens the listed revision directly, even when it falls beyond the project's loaded source pages.
Refresh restarts the list for new sources or eligibility changes above its cursor. Closing the dialog cancels reads;
submitted Attach keeps its original project. The dialog uses the existing query client and Material controls.

Revision metadata records `conversion_calls` before dispatch, nullable `conversion_tokens` when the service returns
usage, and `conversion_ms`. Load/commit storage steps allow two retries (three attempts, one-second delay, 30 seconds
per attempt). `convert and store` has retries disabled; conversion is one call bounded to 60 seconds. A started
conversion uses a `conversion_calls=0 AND readable_state='pending'` compare-and-set before dispatch; replay without
winning that claim cannot call the service. An ambiguous claim acknowledgement retains its persisted count, and
completion uses `MAX` for calls plus known-first nullable tokens, never resetting uncertain work to zero.
The Blob sent to `toMarkdown` carries its stored MIME type: the real service rejected an empty type. PDF metadata and
embedded-image conversion are disabled. Output containing only page headings is `needs_conversion`, never readable
source evidence. Exactly one leading UTF-8 BOM is removed before canonical storage; readers preserve those stored bytes.

**Completion recovery — implemented slice, acceptance in MAP.** `ingest-completion.ts` owns the storage publication
used by Workflow and source reader. A single D1 batch publishes revision metadata, stales exact dependencies of the
previous accepted head and advances the source only to a newer readable revision. The existing newest-readable,
ownership and non-deleted guards remain; an older completion stays readable with a conflict warning and cannot
replace a newer readable head. A newer pending/unreadable replacement does not hide the older readable result.
Read-back adopts a committed batch whose reply was lost; different terminal metadata is not overwritten. A matching
older readable-but-unpublished result can finish publication without replaying conversion even when a newer revision
is pending. Preflight checks newest readable, and the batch checks the full terminal projection (including the
warning/state pair) again before head advancement or staleness. Historical capture fields
remain immutable under migration `0006`; later Save/Accept computes freshness at its own publication boundary (§3).
Canonical R2 writes use conditional create, never overwrite an existing text or block object, and retain returned
ETags in the small cached conversion result. Commit/reconciliation checks both objects' ETags and text size. Text
alone, equal sizes, missing blocks or changed objects do not prove completion. A partial store remains a failure;
neither conversion nor R2 writes are repeated to repair it. Original bytes remain available.
On exhausted storage attempts, a separate bounded storage step records an actionable failure without reducing known
call/usage fields. The Workflow returns its cached conversion metadata (not bodies), even if that failure write is
unavailable. Source detail reads consult only the existing `ingest-<revisionId>` instance, for the requested revision
or latest revision, after ownership validation. At most one status read and one storage commit run per source read.
A complete matching output plus retained artifacts can finish commit. No read creates, recreates, resumes or restarts
a Workflow, and no recovery resolves a converter or calls a model. Missing completed evidence gives an actionable
failure; unknown/unavailable status remains pending with an explicit warning, since the original job may still run.
An ambiguous create/status reply also retains pending identity rather than falsely stopping the accepted job.
Unmarked legacy instances without retained conversion metadata cannot be reconstructed from artifact presence.
Checked 2026-11-02 against pinned Workers types `5.20261024.1` and official
[Workflow retry/cache rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[Workers status API](https://developers.cloudflare.com/workflows/build/workers-api/) and
[R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

`IngestWorkflow` converts native UTF-8 text locally. Cache `env.AI.toMarkdown().supported()` and call `toMarkdown` only
for required document formats. Ordinary ingest never invokes OCR or opts into model-assisted image conversion: retain scans/images and mark
`needs_conversion`; owner-supplied Markdown creates a new revision. Static URL fetch is preferred; Browser Run is K7
only. Validate non-empty UTF-8, write `text.md` and `blocks.json`, then advance readable state. AI Search OCR is never
canonical source text.

URL guard: HTTPS by default; reject credentials, IP literals, localhost and private/link-local ranges; revalidate every
redirect; cap redirects, body and wall time. Network content is untrusted data.

K1 static capture uses HTTPS port 443, at most three redirects, a 15-second total deadline and a streamed 25 MiB cap.
Hostname validation does not pin DNS resolution; DNS rebinding prevention is not claimed. No owner/model credentials
are sent to captured sites or corpus download hosts. `ELIOT_REMOTE_BINDINGS=0 pnpm dev` disables remote services for
local native-text work and CI; the production bindings and Access checks are unchanged. `pnpm db:local` applies pending
active `migrations/*.sql` in filename order, including `0011_studio_pages.sql`; archived `0004` stays excluded.
Remote D1/R2 provisioning and deployment are not run.

Unexpected C0/DEL characters, excluding ordinary text whitespace, produce a readable-text warning without changing
canonical bytes or ranges. New conversions persist `readable_with_warnings`; the reader applies the same check to
the loaded active text of older revisions without a D1 write. This detects non-printing characters, not mathematical
fidelity or every conversion loss; the original remains available for inspection.

### Explicit PDF OCR and reviewed Apply

The owner-approved exception is a separate PDF-only operation, never an ingest fallback. Migration
`0010_source_ocr.sql` owns `source_ocr_job`; `src/shared/api.ts` owns `OCR_LIMITS`, `OcrState` and `OcrJobView`.
States are `preparing|queued|running|ready|failed|cancelled|applied`. A job retains project/source/base revision,
`base_current_revision_id`, `model_route`/`model_snapshot`, page inputs/count, dispatched calls, completed pages,
token bound, nullable actual usage, `deadline_at`, preview SHA/size and `applied_revision_id`. R2 holds page inputs and
saved OCR output below `source/<base-revision>/ocr/<job>/`; these are not canonical source evidence before Apply.

The owner API is rooted at `/api/projects/:projectId/sources/:sourceId/ocr`:

1. Explicit create (`POST` root) freezes `jobId`, `baseRevisionId`, selected `model`, complete `pageCount` and
   `originalSha256` in a `preparing` job. Only the source's latest live (non-deleted) revision is eligible, and its
   original must be a PDF. The reader passes `source.revisionId` as `baseRevisionId`, including at `needs_conversion`;
   capture `source.currentRevisionId` separately in `base_current_revision_id`, even when it is an older readable
   revision or null. Verify attached-source scope and the stored original PDF/hash. The browser
   renders that original locally and uploads every page once as PNG (`PUT /:jobId/pages/:pageNumber`). Create/upload
   perform no inference; no partial page selection silently replaces the document.
2. Only explicit `POST /:jobId/start` admits paid work after all pages are present, the base is still the latest live
   revision, and the separately captured current still matches. Selected-route, token/time/concurrency and
   provider-allowance checks must also pass. Freeze the admitted model snapshot; no automatic model
   substitution. Known non-image models are rejected; unknown image capability is not proof of support and a provider
   rejection stops the job. `ocr-<jobId>` processes pages serially, at most one model call per page and `pageCount`
   calls total. Count dispatch before the call; paid steps have no retry or automatic continuation after failure.
3. `POST /:jobId/cancel` records Stop before another page dispatch. An in-flight page may finish and record usage;
   it does not authorize the next page or Apply. Closing the dialog is not Stop. A failed/cancelled job is not resumed
   by reading or reopening it; another paid run requires a new explicit owner action.
4. `GET` root and `GET /:jobId` read stored jobs/progress; `GET /:jobId/preview` reads complete saved text for review
   and editing. These reads never refresh models, start a Workflow or make an inference call. Record input/cached/output
   usage when returned; unavailable usage remains null rather than zero or an invented Neurons/currency conversion.
5. Only a `ready` preview may be applied (`POST /:jobId/apply`, optional reviewed `text`). Apply is storage only:
   validate non-empty bounded text, write immutable `text.md` and exact UTF-8 `blocks.json`, then compare-and-set the
   separately captured current in D1 only while the OCR base is still the latest live revision. Create a new readable
   revision referencing the same original PDF/hash; retain every old revision, canonical byte range and citation target.
   Mark accepted pages dependent on the replaced readable current revision stale. A changed latest base or current
   conflicts instead of overwriting it; repeated Apply returns the job's existing `appliedRevisionId`.
   The new revision starts with understanding `none`; no conversion, OCR or distillation is triggered by Apply.
   The reader invalidates the existing project Sources query after Apply. Opening the already applied current
   revision closes the OCR dialog and retains loaded text/outline, without resetting pagination or selection.

Shared bounds are 1–1,000 pages, at most 1 MiB PNG and 4,000,000 pixels per page, browser render long edge at most
2,000 pixels, 90 seconds per page call, and 25 MiB for the complete/reviewed text. Admission stores
`pageCount * modelTokenReservation(model)` as the job token bound and a finite deadline; these are job bounds, not provider
prices or a billing guarantee. The ordinary 60-second `toMarkdown` conversion bound remains separate.
OCR allocates output independently of the interactive chat reserve. The shared `ocrOutputLimit` used by admission
and the Run preview selects at least 16,384 output tokens per page when published capacity permits, caps that
allocation at capacity, and never reduces a larger reserve. Unknown capacity retains the existing usable reserve.
Create and Start retain their existing validation; admitted legacy snapshots and counters are unchanged.
Safe application failure causes are stored on the job before crossing a Workflow step boundary. Finalization keeps
the recorded cause, including an incomplete page's finish reason, while existing R2 reports remain immutable.
Opaque provider error bodies and headers are not retained.

`pnpm eval k1 --ocr` uses explicitly supplied derivative fixture identities, selected model and complete page count;
without `ELIOT_K1_OCR_MODEL=1` a fresh run performs read/reopen checks only. Paid Run is an explicit opt-in.
`pnpm eval k1 --ocr --resume-job=<UUID>` is an eval-only continuation for an existing ready job, not a product retry:
it verifies `ELIOT_OCR_PRIOR_RESULT`, `ELIOT_OCR_PRIOR_EVIDENCE` range hashes and `ELIOT_OCR_ORIGINAL_SHA256`, then reads
the saved preview and performs storage-only Apply/repeat-Apply. It never creates, uploads or starts that job again.
The optional separate cancellation fixture still requires its explicit fixture scope and paid opt-in; it is not a
retry of the retained job. No failed job is automatically resumed and no product continuation layer is added.

Local real-service results (2026-10-31 UTC) verify this bounded control/storage journey on derivative scans:

- `eval/out/k1-ocr/2026-10-31T00-52-32-409Z/result.json` remains **FAIL** at the preview UI label. Its retained
  upload/Start/idempotence prefix passed: two Start requests dispatched one call; the one-page job reached `ready`.
- The label fix's GET-only reopen loaded the exact stored preview without inference. The explicit continuation in
  `eval/out/k1-ocr/2026-10-31T00-59-35-012Z/result.json` is **PASS_RESUMED**: saved preview, immutable Apply,
  repeat-Apply with zero extra revisions/calls, and old-citation checks passed. Upload/Start were retained-prefix
  evidence, not repeated actions. The separate two-page Stop fixture finished `cancelled` with one call/one completed
  page, recording the in-flight result without dispatching page two.
- `eval/out/k1-ocr-live/dependency-result-final.json` passed against the retained before baseline: one dependent page
  became stale and one unrelated page stayed current; heads, body UTF-8, serialized citations API data and exact old
  range bytes matched. This comparison made GET requests only.

Actual usage across the two jobs was **two observed inference calls** against an admitted ceiling of **three calls**
(one apply page plus two cancellation-fixture pages), input `3,783 + 3,783 = 7,566`, output
`1,310 + 1,281 = 2,591` tokens, with zero reported cached tokens. The resumed Apply job kept its original one-call
usage; it was not rerun. Monetary cost and Neurons remain unknown; latency budgets are not established.
Full PDF/corpus OCR transcription quality and deployed Access are **NOT_RUN**; owner semantic acceptance is not
claimed. These local results do not accept K2/K3 or establish a complete fresh corpus OCR run.
An additional complete-Transformer request on the selected free Nemotron route stopped at page 14: 14 calls,
13 completed pages, 44,940 input and 32,145 output tokens, zero cached tokens. The failing page reports
`finish=length`, 8,192 output tokens and zero text bytes in 36,686 ms. No complete preview or Apply occurred;
its original report and counters remain retained. A fresh Nemotron run with the larger allocation stopped after
four dispatches and three completed pages with an external request failure; its final token totals remain unknown.
Neither failed run produced a complete preview or Apply.
A separate explicit GLM run in the authorized standard mode completed all fifteen original pages in fifteen calls:
62,145 input, 10,786 output and zero cached tokens. Its saved preview was reviewed against all original page images;
four transcription corrections restored a margin stamp, two name details and missing diagram labels. Apply stored
one new reviewed revision (42,771 UTF-8 bytes), retained the original PDF and old canonical/range bytes, and left
understanding at `none`/zero calls. Repeat Apply returned that same revision without new inference or revision.
The job took 202.325 seconds (one full-job sample). Per-page nearest-rank latency across fifteen calls was p50
14.614 seconds and p95 25.923 seconds. Monetary cost, Neurons and remaining provider quota are unknown.
This is one reviewed full-PDF case, not full-corpus OCR quality or K2/K3 acceptance.

## 5. Blocks, labels, citations and quote verification

`blocks.json` stores ordered heading/paragraph/list/table/code/quote blocks with nearest heading and exact UTF-8 byte
`[start,end)` in `text.md`. Compute byte offsets, not JavaScript character indexes. Split prose near sentence boundaries;
keep tables/code intact up to a bounded size.

On new scans, an ordered marker interrupts a paragraph only with numeric start 1, including `01.`.
An existing list keeps unindented continuation lines until a blank line or another recognized block.
Only new readable representations use this rule; stored block maps and citation ranges remain unchanged.

New scans join an explicit adjacent `Table <number>:` or `Table <number>.` caption with its sole neighboring
whole table when the complete original span, including intervening whitespace, fits 4,096 bytes. A caption between
two tables, a table with two candidate captions, or a caption/table split by the size bound stays separate. The
joined block retains the original UTF-8 bytes and nearest heading; block IDs remain sequential. This changes only
new readable representations. Existing stored block maps and citation identities are never rewritten.

Turn/job labels are compact (`[S1:14]`) and frozen per operation. Persistent labels use the full revision UUID
(`[R<revision-uuid>:14]`); UI may visually shorten them but stored identity never does. A citation stores full revision,
block, byte range, source title and deleted flag. Server resolves labels, removes unknown/out-of-scope labels and counts
them. Saving an answer rewrites compact aliases to persistent labels.

A comma-separated bracket group of fully specified labels, such as `[S1:14, S2:8]`, is normalized to separate labels
only when every member resolves in the same frozen set of supplied citable blocks with original byte ranges. A bad member rejects the
whole group. A dash-separated pair such as `[S1:14–S1:15]` normalizes only when both fully specified compact labels resolve to
the same source and consecutive ascending citable block IDs. It emits those two references without inferring any
interior block. Code and inline literals remain literal. Missing aliases, shorthand such as `[S1:14–15]`, nonadjacent
ranges, bare source markers and unknown blocks stay invalid; no neighboring block or missing identity is inferred. This
normalization preserves factual prose and citation targets. Repeated references to the same immutable block reuse
their first emitted label so every occurrence can link through the returned citation metadata. No model call is
added, and stored turn states are never regraded.

`code-ranges.ts` owns the supported top-level fence/inline ranges for citation and distillation checks. Matching
backtick runs stay outside fences; an unmatched run remains prose and does not hide later independent spans.
Code bytes remain literal. Reference authority stays with each caller, using its existing frozen labels.

Quote verification reuses one local canonical byte buffer, including across label resolution and verification in each
distillation storage operation. String callers encode once. `sliceUtf8` validates integer bounds and UTF-8 boundaries
before fatal decoding, preserving BOM bytes. Normalized text/maps are computed only for fallback slices; empty candidate
sets do no source work. No source buffer or folded map is cached between operations.

For each candidate quote, search exact bytes in the stated block, then adjacent blocks; only then apply conservative
whitespace/quote/dash/soft-hyphen normalization with a map back to original bytes. Prefer the stated block, mark
ambiguous duplicates, and drop unmatched claims. Numeric support compares complete numeric literals, including their
signs and exponents, rather than digits borrowed from a fraction or another quantity. `0.50` does not support `50`;
`41.0` and a separate `8` do not support `41.8` or `41,8`. Unambiguous decimal commas match decimal points; ambiguous
comma-thousands retain their written grouping. This check also applies to statements, conditions, digest and glossary.
Code checks numeric identity without converting fractions to percentages. Unit, row, metric and condition association
must also be supported by the same quote, but remain the model's own-quote review and the semantic acceptance gate.
A missing literal percent sign alone does not establish a false number: a table may state its measurement in words.
Unsupported scalar numeric metadata is cleared together with its unit. Numeric verification does not evaluate
arbitrary mathematics or establish semantic support.
An adjacent ASCII dash between complete unattached scalar operands is an infix separator for literal matching;
range or subtraction meaning remains a semantic check. Unary and exponent signs retain their identity, and a
standalone negative value cannot borrow the positive endpoint of a range.
Explicit multiplication powers such as `7.6×10⁹` and `7.6×10^9` are checked as one token. Flattened `7.6×109`,
or a mantissa and exponent found separately elsewhere in a passage, cannot support that scientific quantity.
Balanced TeX integer powers (`10^{-6}`, `3.7×10^{4}`) and single-backslash `\times`/`\cdot` spellings use the same
token identity as their explicit caret forms. Incomplete braces and separately written quantities are not repaired;
canonical text and citation ranges remain unchanged.
The production verifier and K3 stored eval share `src/numbers.ts`; the eval does not keep a weaker numeric checker.
Parsed `valueNumber` uses the same normalization after its format check: `0,500` becomes `0.5`, while `1,280,000`
remains `1280000`. `valueText`, quotes, ranges and previously unparsed formats remain unchanged.

The verifier stores the original canonical slice, including original whitespace and punctuation, after normalized
matching. Candidate statements with unsupported digit groups are dropped rather than retained with misleading prose.
The normalization map has one entry per UTF-16 unit, including both units of a supplementary character, because string
search returns UTF-16 indexes. A supplementary character before or within a normalized quote must not shift its
original UTF-8 range. Exact matches, stated-block preference and duplicate ambiguity retain their existing behavior.
This exported fallback is covered by synthetic quote regressions and a retained-candidate Save/GET/range case on
Workerd/D1/R2. Current extraction resolves whole canonical blocks and normally takes the exact-match path; no observed
fresh-model or corpus failure is attributed to this fallback. The fixture establishes range/storage correctness,
not semantic support, missing-anchor recovery or live model quality.
Digest/glossary numeric statements are checked against only the verified quotes selected by their labels; a valid
label alone does not authorize a new number or experiment condition.

Claims retain source-language task/metric/dataset, value text, optional parsed number/unit, conditions, quote and exact
range. K6 owns cross-source normalization; K3 must not pretend raw multilingual strings are canonical.

## 6. One-time distillation

Model-facing source JSON Unicode-escapes literal square brackets inside strings while retaining the exact authority
label strings. JSON decoding preserves the original value; canonical bytes and stored artifacts remain unchanged.
Extraction and synthesis preserve table row, metric and column/split identity; blank cells are unreported results.

States: `none|queued|running|paused|done|partial|failed`. Ingest leaves readable revisions at `none`. Only an explicit
Understand request queues its requested revision and attempts admission, subject to concurrency and provider allowance.
A full concurrency window leaves work `queued`; Workflow completion and cron admit already requested `queued` rows
with zero calls, in creation order, using their stored model route. Unavailable models or allowance become visible
`paused` until another explicit request. Cron also reconciles stale `running` rows against Workflow ID
`distill-<revisionId>` for original attempts and `distill-attempt-<attemptId>` for explicit retries, without restarting uncertain work. Migration `0007_manual_understanding.sql`
removes the obsolete `settings.auto_distill` switch and pauses unstarted legacy queued revisions so the owner can
resume them explicitly. Settings no longer accepts or exposes `autoDistill`.

After a successful Understand or Save-existing POST the reader invalidates the active `sources` query for that project
and rereads understanding. Infinite source pages retain loaded pagination and source selection. A failed follow-up GET
shows the accepted request with a storage-only Reload action; Understand/Save stay unavailable until a successful read.
The reader locks before dispatch. Any POST error—including a lost reply, non-2xx response or unreadable JSON—leaves the
outcome unknown and keeps both actions unavailable until Reload succeeds. A successful read of `none` only enables a
later explicit request; it never resubmits.
Mounting the reader always refreshes status, and a failed status read blocks actions until Reload succeeds.
The existing QueryClient owns revision-scoped status reads, passes their AbortSignal and polls queued/running work
without overlapping reads. A read error stops polling until Reload; the last received view is retained with its error.
Navigation cancels reads and ignores the departed reader's action continuation. Submitted POSTs keep their original
source/revision; a successful late POST may still invalidate its owning project's source badge query. These reads never
dispatch understanding, and no document reload or new server state is introduced.

**Bibliographic metadata — implementation and acceptance in MAP.** Current ingest/OCR inputs have no separate,
reliably attributed author/date fields; PDF conversion explicitly disables PDF metadata. Canonical text, including
front matter, bylines, references and date-looking strings, is content rather than a typed bibliographic input.
Distillation no longer requests authors/publication in the extraction schema or promotes model guesses into `source`.
New sources retain the schema defaults: authors `''`, publication `NULL`. Only a future explicit source metadata
producer with an identifiable field boundary may populate them; no name/date parser or paid metadata pass is added.

Legacy raw call output may still contain author/date guesses. Verification ignores those fields without rewriting
the immutable raw bytes or source text, quotes and ranges. Existing source-wide D1 authors/publication remain unchanged
during verification, GET and explicit Save-existing reuse, including when reading later revisions of that source.
This repair does not certify or correct historical values; correction requires its own explicit stored-data change.
Accounting and the existing two-call bound remain unchanged. Checked 2026-11-03 against the pinned D1/R2/Workflows types
and official [prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[conditional R2 writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) and
[Workflow steps](https://developers.cloudflare.com/workflows/build/workers-api/) contracts.
`pnpm eval k3 --metadata-only` runs the production verification/storage/GET/Save paths on isolated Workerd/D1/R2,
with retained synthetic outputs and both paid producer callbacks skipped. It checks default/historical metadata,
replacement heads and immutable bytes/ETags. A separate synthetic cached-candidate case uses storage-only Save to
recheck normalized supplementary-Unicode quotes, then verifies D1 and exact revision/range reads and repeated Save.
The two recorded calls remain historical fixture data; no producer is invoked. It establishes storage behavior,
not model quality or paid-step replay.

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
Fresh candidates that already fail the scalar-result projection are excluded before the second call. Their originally
selected source blocks remain in the same declared evidence pool; code neither splits a compound candidate nor creates
facts from it. Historical verified candidate IDs are not recomputed during cached-output rechecks.
Only its supported, code-checked output is committed to the claim reader. Result claims describe one scalar result
per task/dataset/metric/condition instead of a compound table row. A result's `valueText` may contain at most one numeric
quantity; an explicit list such as two percentages is rejected even when both values occur in the quote and
`valueNumber` is null. Scientific powers count as one quantity. Code does not split the list, infer conditions or relabel
it to retain a card. Citation annotations are resolved separately from factual numbers; an unknown annotation rejects
its item. First-call claim statements use the same declared-reference cleaner as guide text and second-call additions
before numeric verification. Only the claim's own `quoteBlock`, its persistent form and corresponding `[block N]`
annotation may be removed; unknown references and annotation-only statements reject the candidate. Code literals
remain literal and factual numbers still need the original quote. Drop indexes identify the original candidates;
diagnostic entries need not be sorted. Surviving claims retain their order.
The raw first output, original block/range and frozen evidence selections remain unchanged. Historical cached candidate
IDs are not recomputed and no output is automatically rechecked or regenerated. Synthetic retained outputs reproduce
this gap through current whole-block verification and Workerd/D1/R2 storage; the inspected corpus reports contained no
such inline annotations. This does not explain their missing anchors or establish model quality.
Paid steps have no retry; only deterministic storage steps
may use bounded native Workflow retries, with immutable R2 writes and natural `(revision, ordinal)` claim keys.
Result cards preserve the original statement selected by call two instead of replacing it with a synthetic scalar
sentence. Its primary numeric value must occur in that statement, and every authored number must be represented in
the structured primary result or context, all supported by the same exact quote. Missing numeric conditions reject
the card instead of disappearing during formatting. Qualifiers and delta descriptions remain authored prose;
semantic support is still a separate quality gate.
Code also rejects a result whose simple literal dataset name carries one explicit data split while its own quote
names that same dataset with a different unambiguous split. It does not rewrite fields or infer dataset aliases;
ambiguous splits and other task/metric/dataset semantics remain for quality review.
New second-call additional claims require the same nullable structured fields as extraction. Cached outputs may
omit these fields; storage-only rechecks retain that shape and treat omissions as null without inventing metadata.
Store raw result/report in R2, compact verified claims in D1, and usage
and kept/dropped reasons on the revision. Assemble project overview deterministically from titles, guide summaries
and questions; do not buy an extra overview call. Quality is anchor facts and citation validity, not claim count.
`GET /api/projects/:id/overview` returns `{ sources, nextCursor }`: 50 active attached sources with current readable
heads, ordered by immutable source `(created_at,id)` ascending. Its value cursor includes the project ID; only returned
rows load R2 reports, never the lookahead. Title/head/understanding updates do not move the boundary. An old-created
source that becomes eligible before the boundary requires Refresh; one scan is not a membership snapshot.
Studio opens the overview. Load more retains the preceding rows; Retry repeats the failed page. Refresh discards the
scan and requests page one, while project changes/unmount cancel the prior query. Rows open their exact revision in
Reader. The existing QueryClient owns this storage-only read state while mounted; leaving the overview discards its pages.
The K3 A3 GPU-memory gate accepts the frozen source sentence or exact EN/RU assertion forms naming LoRA,
GPT-3 175B and threefold memory reduction. Both complete fields must match; otherwise `REVIEW_REQUIRED` blocks
automatic acceptance without a factual-failure verdict. No sentence is discarded. The retained paragraph block 5,
bytes `[1011,1940)`, matches its canonical R2 range (929 bytes) and requires review. Passing the isolated source sentence
does not close this actual anchor. `pnpm eval k3 --anchors-only` runs synthetic checks before API calls and rejects
model opt-in. This is not general semantic verification; frozen questions and production claim verification are unchanged.
Each private R2 `distill-call1.json` / `distill-call2.json` may retain `usage.providerUsage` from AI SDK `usage.raw`
as a JSON object or null. A typed structured-output failure retains `output: null` and known usage in the same immutable
artifact. Its safe failure cause is exposed by the owning report; request bodies, headers and private protocol fields
are excluded.
It remains failed and unavailable for Save unless complete compatible output exists. The final report retains
`usage.providerUsage` as an array of at most two such entries for
saved call responses; older artifacts may omit the field. This is provider usage telemetry, not request bodies,
headers or credentials, and adds no table, ledger or model call. Missing token counts remain unknown.
Capture the fixed safe provider-failure projection on the owning revision before crossing the Workflow step boundary.
The final report and reader retain that cause even when Workflow serialization strips the original error class;
provider response bodies, request headers and credentials remain excluded.
`done` records a completed pipeline with supported artifacts; rejecting individual candidate hypotheses is normal
filtering and remains diagnostic. `partial` records a missing required component, ambiguous Markdown visibility or an interrupted/error outcome,
not a nonzero drop percentage. The same exact-quote, numeric-support and anchor gates apply to both states.
In particular, nonempty validated final guide and digest may be stored with zero claims as `partial`; missing claims
alone must not discard those readable artifacts. Zero claims never produces `done`: both normal finish and storage-only
Save available output require at least three guide sentences and at least one kept final claim for `done`. Only the
second call's supported selections/additions become cards; first-call draft candidates are never promoted to fill an
empty final claim set. A readable zero-claim partial result is not full K3 acceptance or proof of semantic quality.
Known empty claim statements (whitespace or punctuation/formatting wrappers around declared references) do not count
as kept claims, including cached rechecks. Additional-claim drop reasons retain their original call-two array indexes.
Guide/digest describe the paper for the owner rather than candidate review or model reasoning. Conflicting source
values remain attributed to their separate source passages instead of being silently reconciled.
Guide/digest sentences need content beyond declared citations and punctuation/formatting wrappers; `[S1:1].`,
`([S1:1])` and `**[S1:1]**` do not count toward completion. Glossary entries also require nonblank EN/RU terms.
Ordinary letters, numbers, Unicode symbols and nonblank supported fenced/inline code remain content. The bounded
check does not parse Markdown: explicit links, images, HTML/entities, footnotes, reference definitions, indented code
and ambiguous marker-only output are kept as whole review units rather than sentence-split, and force `partial`
even with three guide units and kept claims. Only the existing fenced/inline forms promise code-literal treatment;
other constructs retain the existing reference-cleaning policy, and the original raw output remains available.
Ambiguous surviving claim statements, such as a tilde-only remainder, also prevent `done` without discarding the card.
Claim review uses the original statement before reference cleaning or result formatting, and counts only final kept
cards. Retained claims recover this origin from call one and its recorded claim-drop indexes, with block/text alignment;
missing or unmatched legacy origins conservatively keep surviving cards as `partial`. No stored field is added.
This gives up automatic visibility classification of those constructs; it does not discard them or establish
semantic support. Both normal completion and storage-only Save apply this policy without another model call.
Known inline reference annotations are excluded from numeric verification but preserved as full persistent labels
in guide/digest/glossary storage, including within sentence-level validation. Code literals remain literal; unknown
annotations still reject the item. This avoids erasing an inline citation and leaving broken prose such as `block .`.

K3 records `distill_calls` (hard maximum two per explicit attempt), `distill_started_at` and `distill_ms` on the owning revision. Admission
records declared capacity when known before dispatch, with at most two revisions running. Each
new internal `DistillInput` is `{ revisionId, model: ModelSpec, attemptId? }`: after admission and before Workflow creation,
snapshot the resolved metadata and use it throughout the job, without a new R2/D1 artifact, state or ledger.
Admission basis is `published`, `unknown` or `legacy`. New declared capacity is the input ceiling plus published
output capacity per call, capped by an explicitly known combined context window. An input-only ceiling does not
imply a combined window; unknown output leaves the numeric capacity `null`. Previously admitted values remain
unchanged, including older conservative sums that exceed a now-known combined window. `progress.maximumTokens` exposes only
a positive published value; `recordedTokenLimit` retains the owning row/report value separately. Legacy reservations
are not provider maxima. Zero is the existing released-reservation sentinel when no call dispatched, with known-zero
usage; it is not published provider capacity. Only unstarted work without a recorded value may forecast from metadata.
Changing defaults never recomputes stored admission values. Legacy replay retains its original output cap, and old R2
reports are not rewritten; API copies mark missing historical basis as legacy. OCR keeps its frozen per-page cap.
Queued work retains its selected route. Repeating the request without an override keeps that selection; an explicit
different route conflicts before scheduling. Only a successful `none`/`paused` transition may establish a new selection.
Old terminal reports and cached Save retain their recorded usage and shape. Each
Workflow paid step has zero retries; an atomic per-revision dispatch count prevents step replay from buying a duplicate
call. Explicit Understand schedules only its requested revision. Ingest never queues understanding. Completion and cron
may admit only already requested, undispatched queued work; admission atomically rechecks revision/source liveness,
readability, the frozen model route and the two-slot limit after asynchronous model/provider checks. Missing stored
routes pause rather than adopting a new default. A failure draining the queue cannot retry the finalized Workflow.
Completed or unchanged work is not automatically re-distilled, and failed paid work is never retried automatically. The
pipeline uses at most two bounded model calls with zero paid-step retries. Completed/partial revisions return existing
artifacts on repeat. Budget-paused work resumes
only by explicit request. Unknown Workflow dispatch/status never authorizes another instance.
Each background distillation call has a 180 s deadline (native paid-step deadline 4 minutes). Ordinary chat uses Stop
and platform/provider limits; its K2 latency gate remains separate from execution. The owner reader shows availability,
progress, useful model names and verification caveats. Calls, reservations,
token counts and wall time remain in API/eval diagnostics rather than the reading interface. Long papers can use the
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
Calls, tokens, estimated cost, original model wall time and retained provider usage telemetry remain unchanged.
A repeated save of the checked head returns the same result. GET exposes `canRecover` from compatible stored output
only; failed output is never re-queued.
**Explicit failed/partial-attempt retry.** Migration `0013_understanding_retry.sql` adds nullable current
`distill_attempt_id` and canonical `distill_request_json` to `source_revision`; the revision remains the sole active
state/counter owner. Null means the original revision-scoped attempt. `distill_history` is an immutable terminal
archive with a real reader: GET `/api/sources/:id/understanding/history?revisionId=...` pages stable archived identities;
GET understanding with `attemptId` opens their exact saved receipt, claims and artifact pointers. A new retry uses
`source/<revision>/understanding/<attemptId>/` for raw output, verification, bodies and checked reports. Canonical
original/text/block keys and citation identities do not change. Future K9 source-prefix export/cleanup must include
these paths; this change implements no lifecycle mutation.

POST understanding accepts `retry:{attemptId,previousAttemptId}` separately from `saveAvailable`. The client retains
that UUID and exact body in session storage before dispatch. Server replay checks current and archived identities
before model/default/allowance work; a reused identity with a different canonical body conflicts. New acceptance
requires the expected current failed or partial predecessor. Paid predecessors require confirmed `complete|errored|terminated`
Workflow status; unknown, active or unreadable status blocks retry, including retention cases that cannot be
distinguished from a transient failure. A failed zero-call predecessor may switch despite uncertain instance create:
its terminal state and the new identity fence the old dispatch CAS. No elapsed-time guess proves quiescence.

Before switching, immutable `history/<retryRequestId>.json` beneath the predecessor attempt prefix preserves the exact owning revision row (including legacy cost/pricing,
unknown token counts and zero sentinels) and current claims. It contains no request-time timestamp or newly generated value; the caller request ID makes a distinct snapshot key when a competing Save changes that predecessor.
The owning row is reread after confirmed Workflow quiescence so an in-flight legacy settlement cannot be lost.
`Understanding.recordedUsage` exposes that exact current/archived D1 accounting separately from unchanged R2
`report.usage`; nulls, zeros and legacy currency/date fields are retained verbatim. Snapshot failure or unequal existing bytes blocks retry. A single D1 batch archives that pointer and changes the current
identity/projection; the old attempt's fields are never reconstructed from current model defaults. A lost batch reply
rereads the same identity; cron can admit only the already accepted queued attempt. Finish captures the owning claim count in its initial attempt-scoped SQL snapshot, before R2 waits; later claims from another attempt cannot enter the old report. Every admission, dispatch, failure,
verification, claim publication, finish and Save publication is fenced by the owning attempt. Old artifacts remain
immutable and late old writes cannot publish into the new current attempt. Context freezes attempt, report, claim count,
summary and state, then checks them in its single claims read; a changed projection rejects before inference.

The reader distinguishes Retry understanding (a new model run using provider allowance), storage-only Reload and Save.
A lost/malformed retry reply stays unresolved across remount; GET with `requestId` returns that exact `knownRequestId` only when it is
already current or archived; an older cached acknowledgement cannot clear a later pending request. Reading its old predecessor does not clear the pending identity. After a successful status
read, Send same request explicitly resends the retained body; it may start that run if never accepted. Only a confirmed
receipt permits a later explicit new retry. Previous-attempt controls perform reads only. Partial retry archives the working prior guide/claims/report before
switching, so that result remains readable in history. Terminal pre-admission rejections use the same immutable
`distill_history` table with `rejection` instead of a snapshot pointer; they do not appear as model runs in history.
The rejection insert refuses an accepted current identity, while acceptance refuses any rejected identity, so the
D1 winner is definitive even when a duplicate preflight fails while the original request is still in flight.
POST returns a matching `rejected` outcome and GET returns `requestRejection` beside its exact `knownRequestId`.
The matching accepted GET receipt owns history invalidation, including recovery after a lost or malformed POST reply;
it explicitly cancels any pre-accept history fetch before starting a fresh read, including a first fetch without cached
data. An already open history refreshes without remounting. Rejected receipts do not invalidate run history.
Reopening a cached Previous attempts list explicitly refetches it, coalescing an in-flight receipt read and retaining
the selected historical reader and loaded pagination; the first open enables one initial fetch.
Only this durable outcome clears a rejected pending request and permits a fresh explicit model/ID choice; an ordinary
HTTP error leaves the request unknown. Replays adopt either accepted or rejected winners before model work.
`pnpm eval k3 --retry-only` applies strict migrations and exercises pinned Workerd/Workflows/D1/R2 and the production
browser controls at 1440/390 widths. Both paid producer callbacks are replaced with retained synthetic output and external
network is denied. This verifies storage/replay/fencing behavior, not model quality, provider availability or deployed
migration compatibility. Production migration/deployment are NOT_RUN. Once retry rows exist, the Worker and Workflow
binding must execute attempt-aware code; old unfenced code cannot safely process the new identity/artifact paths.
This change does not establish a safe rollback to an older build.

## 7. Shared tools

Tools return compact Markdown with explicit pagination and a default 4,000-token cap:

`read` identifies each complete citable block beside its original text and byte interval. Unlabelled edges and wrappers
remain in requested byte order; formatting overhead counts toward the cap, and an oversized request must be narrowed.

`list_projects`, `list_sources`, `get_guide`, `outline`, `read`, `find_claims`, `search`, `get_page`, `propose_page`; K7
adds `web_search`, `web_read`, `capture_url`. Every tool accepts `(env, actor, input)`, enforces scope/output/write
authority in code and uses full source/revision IDs from `list_sources`. Descriptions stay short and state when to use the
tool. Before K5, `search` uses guides/claims/FTS; after K5 it may use AI Search with claim fallback.
K4 also exposes `refresh_models` and `request_understanding` to owner-authenticated MCP clients. Agent actors are
rejected before either existing product function runs. These tools never grant an agent paid-job authority.

## 8. Ask and context

Each source context declares its exact citable-label inventory from the resolver's same block set. Block IDs can have
gaps and are never page numbers; the inventory is included in the existing input-token estimate.

Freeze readable revision IDs at turn start. Context modes are whole labelled text, verified K3 guides/claims when whole
text does not fit, K5 search with at most six shared-tool steps, or explicit empty scope. The input estimate must fit the published input/assembly ceiling. Only when an explicit combined
`contextWindowTokens` is known, also reserve existing output headroom inside that window: the input budget is
`min(contextTokens, contextWindowTokens - outputReserveTokens)`; without a known window it is `contextTokens`. If the complete scope does not fit, choose whole or
compact evidence per source within that same budget, compressing eligible sources with the greatest savings first.
Readable sources without usable knowledge remain whole when they fit; no source is dropped or reordered. Mixed
requests retain `claims` mode whenever any source is compressed. Recompute history against the final label inventory
and reject the full request before inference if no representation fits. No source understanding or search is started.
`outputReserveTokens` is assembly headroom, not the provider's generation maximum. Chat and source understanding
use a published `maxOutputTokens`, clamped by an estimated remaining allowance, not measured provider tokenization.
`contextWindowTokens` retains a declared combined window independently of the input/assembly ceiling. Clamp output
by estimated remaining headroom only when that combined window is known. Old cached rows and generic refreshes may
retain no combined-window metadata; then preserve published output capacity without subtracting the input ceiling.
An unknown
maximum stays `null` in the catalogue and Eliot omits the SDK option; SDK/provider defaults may then apply,
not an inferred 8,192-token maximum or an unlimited output promise. A non-null chat `token_limit_kind` is its admission
claim even with `token_limit=null`; the atomic claim cannot repeat or change while started. Migration 0012 marks only
previously admitted started rows as legacy; terminal rows are never backfilled. GET, stream and repeat receipts expose
the same basis without changing old payloads. Actual reported usage is retained even if it contradicts declared capacity.
OCR retains its separate frozen
per-page output cap described in section 4.
For compressed sources, include the stored guide with its exact
quoted source passages. Deduplicate identical (block, quote) pairs within each frozen revision while retaining distinct
quotes from the same block. Keep derived claim statements and conditions in a separate orientation message marked as
non-evidence; only original quoted passages provide evidence and citation labels. Source and orientation text both
count toward the same context budget.

Estimate the final instructions/messages JSON as UTF-8 bytes / 3 plus existing per-message and fixed framing overhead.
Assembly and dispatch use the same estimate without copying the full source JSON. This is a heuristic, not a guaranteed
token upper bound or proof that a provider will accept the request. Unknown output defaults can also exceed the reserved
headroom (the pinned Anthropic Claude adapter can serialize `max_tokens=128000` when Eliot omits the option); capacity
and accounting stay unknown rather than adopting that default as published metadata. `estimatedInputTokens` retains
its content-only API meaning. Include newest in-scope history
up to 10% of context, charging JSON escaping and message framing during selection while retaining content-only totals. Public assistant history retains
a citation only when the prior full ordered scope is a prefix of the current scope and its stored source, revision,
block and exact range match a currently supplied passage. Render that citation with its current compact alias;
strip unverified, stale and unavailable references. Prior assistant prose remains conversation context, not evidence.
The Command Code adapter sends the current question and frozen source context without previous conversation turns.
It does not capture or synthesize private reasoning fields. Existing private wire records remain untouched; the
ordinary chat path uses public text and verified labels only. A partial prior answer is identified as incomplete.

Resolve one `ModelSpec` for each turn and freeze it across admission, context limits, request bounds and settlement.
The HTTP Send handler and synchronous eval share `runTurn`: persist the started turn, record the token bound after
provider admission, assemble frozen context, dispatch one streaming model call, resolve citations and persist answer,
citation, token, timing, invalid-label and terminal-state fields. Historical currency columns remain unchanged.
First nonblank text and terminal/Stop results persist immediately. Intermediate full-turn checkpoints are throttled
to once per second; one pending timeout flushes accumulated text during provider silence. Each checkpoint is stored
before broadcast. Finalization clears the timeout; a checkpoint write failure aborts the stream and uses the existing
terminal-save path, without retrying inference. Runtime stalls or storage failure can delay persistence; restart retains
the last stored checkpoint and never continues the model automatically.
WebSocket frames and reconnect expose state snapshots and never enqueue or dispatch paid work. An authorised history
read/reconnect may finish the idempotent local save of an already accepted, proven-undispatched self-handoff or settle
an already stored answer's D1 projection, as specified below; it does not admit work or change terminal D1 accounting.
GET, history, reconnect and Save never start model/search work. One active turn
and one queued submission are allowed; the next returns `409/busy`. Stop stores partial text, closing a tab does not
cancel, and failed streams are not automatically continued. Retrying a confirmed failed generation is a new owner submission.
Before the first turn payload is durable, fresh acceptance retains its full input in the existing self-handoff slot.
A distinct next question gets a truthful busy response until that input is saved; the normal waiting slot then reopens.
The mounted composer retains one unconfirmed Send ID, its normalized question/scope/ordered source IDs/explicit model
and any acknowledged chat ID. An explicit Send with identical input reuses them after a lost or unreadable response;
only a matching turn-ID acknowledgement consumes the attempt in its visible view. Sources/overview navigation retains
it with the draft. Changed input has a new turn ID in the same known chat; changing chats or unmounting discards the draft and attempt.
No read or timer sends it again, and an empty history read does not prove rejection.
For a new conversation the same attempt retains its creation UUID and original title before POST `/chats`. The optional
caller ID uses the existing chat primary key: insert returns 201; matching project/title and an unarchived chat return
the stored row with 200. Foreign, archived or differently titled identities return 409 without updating metadata. Omitted IDs keep
server-generated creation. Titles must be valid Unicode; the composer uses up to 80 complete code points.
After reload, History can open a committed chat and any accepted turn through existing storage-only reads. No request
is resumed automatically. If only creation committed, the full question is not recoverable from its truncated title;
unaccepted draft text is not persisted in the URL, localStorage or another client cache.
Ordinary chat has no application wall-clock or idle-abort timer. Stop signals abort and preserves received text;
its response acknowledges that signal, not upstream completion. The pinned SDK can close its consumer and release
the local queue even if transport cancellation stalls; missing provider usage stays unknown. Provider/platform failures
remain failed without text or partial with text. Only explicit owner Stop can produce
cancelled. After the SDK iterator closes, read any resolved usage and check the signal before accepting a normal finish:
abort can close the iterator normally. The eval's model POST wait has no 90-second client cutoff; a failed wait is
reconciled by bounded reads of that same submitted turn ID, never another Send.
Platform facts checked 2026-11-04: [Durable Objects RPC/HTTP](https://developers.cloudflare.com/durable-objects/platform/limits/)
has no fixed wall-time cap while a request, connection or I/O remains active; CPU/memory limits still apply.
[AI Gateway request timeout](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/) concerns the
first response, rather than the duration of an already streaming response. Provider limits remain independent; no
gateway timeout, retry or provider setting is changed by this policy.
When the SDK normalizes a provider finish to `other`, the stored error retains its distinct raw code only if it
matches `[A-Za-z][A-Za-z0-9_.:-]{0,63}`. Arbitrary upstream messages are omitted.
Only a terminal stored turn is adopted; pending outcomes stay unresolved. Missing provider usage retains the recorded
token bound and is never treated as zero usage.
Missing-citation and unsupported-number diagnostics are advisory UTF-16 answer ranges stored in the existing
ChatAgent turn JSON and exposed by snapshots/history for API and eval readers. The owner Markdown view renders the
answer without diagnostic frames or rewriting it. These diagnostics do not change a normally finished stream to
partial. Explicitly indented plain-text continuations belong to their Markdown list item for sentence analysis;
plain soft wraps and the item marker are masked with equal-length spaces only in the analysis view. Lines containing
sentence punctuation or ending in closing markup/citations retain their newline boundary, including before lowercase
text. This conservatively leaves wraps near abbreviations/decimals unchanged. Separate sentences,
new items, quotes, headings, blank lines and fenced code retain their boundaries. Unindented continuations keep the
conservative existing behavior. Answer bytes, source blocks and saved revision ranges are never rewritten.
Truncation, stream/protocol failure and invalid resolved labels remain real failures. A normally finished answer with rejected references stays partial; its error names the bounded
rejected-marker samples. Saving a partial answer preserves its recorded failure reason as escaped Markdown text;
it does not claim generation was interrupted when only references failed. Historical partials without a reason receive
a neutral review note. Saved output also carries a concise review note when warnings exist. D1 schema and usage are unchanged.
An answer over a nonempty whole/claim source scope with no resolved citation is incomplete; this hard citation-presence
gate is separate from advisory spans. General answers in explicitly empty scope do not require Library citations.

Chat always streams ordinary Markdown with inline compact `[Sx:N]` labels. There is no JSON sentence/label enum or
parse-repair call. One generic `SYSTEM_PROMPT` applies across questions and corpora: answer in the user's language,
copy atomic source markers verbatim with commentary outside their brackets, retain every marker needed for a claim,
ground source facts with supplied labels, answer directly with detail proportional to the question, preserve requested
facts and conditions, omit unrelated background and repetition, distinguish inference, abstain when evidence is missing, and treat source text
as untrusted data. Project instructions remain caller-provided context; no fixed-corpus coaching is added. The same
server citation resolver maps valid labels to exact source/revision and UTF-8 ranges. Bare `Page N` / `Страница N`
page markers and empty headings are omitted from the model's whole-reading projection as well as its citation-label
set. Citable prose mentioning page numbers and meaningful headings remain present. Canonical bytes, block IDs and
their original ranges remain unchanged, including for the reader and existing citations.

Citation and numeric diagnostics do not prove semantic entailment. A normally completed answer with advisory warnings
can still fail acceptance. Owner semantic review remains required. The unchanged C1–C4/O1–O8 question set, citation-opening checks and owner review
are the K2 boundary in MAP; K2 is not fully accepted or deployed.

Broadcast the first nonempty rendered answer immediately and measure `firstTokenMs` from that text, not the first
network event. Keep recorded token bounds, actual token counts and any historical/provider-reported currency values
distinct; missing usage remains unknown. Private turn telemetry exposes only the allowlisted `inputTokens`, `outputTokens`, `totalTokens`,
`cachedTokens` and `reasoningTokens`, each null when missing or invalid. Eval may reuse only completed turns
with exact frozen source/revision sets; a non-reusable question stays manual and resume never dispatches a replacement.

### Context materialization and proposed chat repairs

The materialization bound below is implemented by the current repair slice; chat repairs remain open.
[MAP's repair order](MAP.md#active-repair-order) owns acceptance status.

- **Materialization bound — `context.ts`.** Each assembly has one cumulative **16 MiB** allocation allowance, separate
  from the provider input budget. It counts actual streamed R2 bytes, chunk bookkeeping, contiguous copies,
  decoded UTF-16 strings, conservative parsed-JSON overhead, metadata, labels, orientation and joined projections.
  Distill extraction and verification reuse the streamed canonical-text/block-map reader and the same per-operation
  allowance; extraction also charges decoded passages, escaped source JSON and joined projections before dispatch.
  Verification and synthesis storage charge resolved canonical quotes, verifier slices/fold maps and joined evidence;
  repeated references reuse one decoded block within the operation. Legacy maps are not rescanned or capped at the
  current scanner's block size. Charges remain conservative allocation accounting, not measured heap usage.
  Charges are not released for discarded attempts. This is a product guard, not a measurement of V8's heap or a
  process-wide concurrency limit; SDKs, the caller's already-loaded turn payloads and other isolate requests need
  additional memory. The implementation PR records observed memory separately from this accounting bound.
  R2 bodies use `body.getReader()`, count chunks before retaining them, and cancel on failure. Block maps are read
  first and reused within the assembly; a block larger than the remaining allowance rejects before its text GET.
  Reports, guides and exact ranges use the same bound, and ranges must return exactly their requested byte length.
  At most 256 guide ranges are fetched per assembly; another range rejects the whole request before its GET,
  preventing small passages from turning the byte allowance into thousands of serial reads.
  Declared sizes cannot waive the streamed checks. No subsequent body is fetched after exhaustion.
  Source queries return at most 1,025 rows and reject more than **1,024** sources; explicit ID arrays share that cap.
  Explicit selection uses one `json_each` query in first-occurrence order and the same conservative byte-based SQL
  metadata bound as default selection. Near the allowance, non-ASCII metadata may reject earlier than the old JS loop.
  IDs and explicit input IDs are capped at 128 UTF-8 bytes. SQL clips title/summary/report-key fields above
  4,096/32,768/4,096 bytes and marks the complete request invalid, rather than publishing truncated metadata.
  Lengths use `length(CAST(field AS BLOB))`, including NUL tails. Window sums include IDs and suppress oversized
  aggregate metadata before transfer.
  Claim queries similarly suppress oversized fields and reject more than **256** rows, without using a partial list.
  History is selected newest-first before copying older exchanges. Raw exchanges above the existing history-token
  reserve stop older-history selection before label normalization; UTF-8 token estimation no longer allocates encoded copies.
  Caller and output reserves remain unchanged.
  Metadata still chooses eligible whole/compact representations before body reads. `readable_size` is only a
  preflight estimate, not an exact token count or a lower bound on projected citable text: fitting marker-heavy
  sources remain eligible. Frozen scope/order, aliases and original UTF-8 citation ranges are preserved. Failure
  returns the existing narrow-scope/understanding-needed response before inference, without automatic distillation.
  Checked 2026-11-02 against the installed `@cloudflare/workers-types@5.20261024.1` R2 declarations and the official
  [R2 range/body contract](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) and
  [Worker memory contract](https://developers.cloudflare.com/workers/platform/limits/#memory). The platform's
  128 MB limit is shared by the isolate, not a separate allowance for each assembly.
- **Interrupted accepted input - `chat.ts`.** Fresh acceptance and queue promotion both retain the unchanged request in
  `queued` with the same active ID until validation, first DO payload write and state clear finish. Snapshots hide this
  self-handoff; it is not a second waiting question. Before clearing input on recovery, store its turn ID/question/input
  in the existing DO turn history as `failed` with an explicit never-dispatched message and zero token usage/bound.
  Do not resolve a new model or invent frozen revision IDs for a question that never started. Persist this recovery
  before clearing the queue; repeat recovery must preserve an already recorded turn. Retain the active turn's partial
  text and unknown usage as today. GET, onStart and reconnect never start either model call. Repeating the recovered ID
  returns the stored result; retry through a new Send has a new ID. The existing reader shows the saved failure reason.
  The original request is retained in optional `TurnView.input` inside that existing DO payload. `model` keeps only
  an explicitly requested route, or an empty string when none was chosen; no default/catalogue lookup or revision
  freeze is performed. A never-started retained question has no D1 admission row. Its DO usage and token bound are known zero,
  while an interrupted active turn retains its existing known values and nulls.
  Shared question/selection/model fields are stored once on the turn; compact input metadata retains project/chat
  identity and optional-field presence, and reads reconstruct the exact request. This avoids doubling a long accepted
  question within the platform's [2 MB SQLite row limit](https://developers.cloudflare.com/durable-objects/platform/limits/).
  Stop preserves the retained input while aborting the active handoff. A validation failure records the question as
  undispatched without a model call.
  If its local write or queue-state clear fails, release the settled in-memory task/controller and retain the input.
  Make one storage-only recovery attempt when that task ends. A subsequent authorised history read/reconnect, submit
  or Stop may make one further attempt after project validation; no timer, background loop or automatic Send is added.
  Persist the failed, never-dispatched turn before clearing the self-handoff. While storage remains unavailable,
  return a clear `503/unavailable` rather than hide the question or discard its input. Once recovered, reconnect and
  repeat-ID return the stored outcome and a new explicit Send can use the freed slot without restarting the object.
  The authorised WebSocket connection obtains its snapshot through server RPC: the pinned Agents SDK forbids
  `setState` inside its readonly connection context. This also covers a handoff failing while the connection opens.
  Connections remain readonly; no client mutation is enabled.
  A retained self-handoff with only an empty, unadmitted `started` row is also recovered as known zero, retaining
  its creation time and original queued input. Terminal or already-admitted rows are never rewritten by this repair.
  Client notifications are best-effort so a disconnected reader cannot interrupt persistence or queue handoff;
  reconnect reads the stored snapshot. Read queue/active state together after awaiting history, so a delayed history
  read cannot resurrect a question that finished meanwhile. This does not implement terminal D1 settlement/reconciliation below.
- **Older turns - `chat.ts`, `index.ts`, `shared/api.ts`, `web/Chat.tsx`.** GET on the existing
  `/api/projects/:id/chats/:chatId/turns` resource returns at most 50 turns and `nextCursor`. The validated value cursor
  records chat ID and the oldest returned immutable `(created_at,id)`; strict descending tuple comparison handles
  timestamp ties without depending on the anchor row's continued existence. A covering DO index supports the range;
  one ID-only lookahead detects more rows without loading a 51st answer. Authorization and bounded storage-only
  recovery still run before reading payloads. Initial HTTP/WebSocket snapshots retain their latest-50 window and also
  return a next cursor; model-history `getTurns` remains latest-50 regardless of how much the owner browses.
  `writeTurn` preserves `created_at` on conflict and increments the same row's `history_version`. Startup adds that
  column with legacy default zero and the ordering index, without rewriting old payloads. Read and stream projections
  carry `createdAt`/`historyVersion`; neither is duplicated inside payload JSON or used as model context. UI merges by
  immutable turn ID and stored version, including the first preparation/handoff frame and the wait=1 receipt.
  The same DO has one constant-size `chat_history_clock` row for ordering queue/settlement projections across HTTP
  and WebSocket. Existing state/payload writes advance it before writing; a failed write can leave an unused version
  but cannot publish changed state with an older version. Repeated reads do not advance it. Snapshots and queue frames
  expose `stateVersion` and the complete queue/settlement-notice projection, including an explicit null to clear a notice.
  Queue frames use the same bounded pending-turn/latest-50 ID projection as snapshots, including notices for pending
  turns outside the current page. Both go through the same client merge: a newer queue frame may supersede an older
  snapshot only with its notice/clear included. Older projections cannot resurrect a queue or an obsolete notice. This is transport
  metadata only, not an admission mechanism, effects ledger or another message store. UI sorts by creation time/ID,
  so delayed pages/snapshots cannot regress streamed text or erase older rows. Ordinary overlapping reconnects keep
  the older cursor. A disjoint latest window after
  more than 50 missed turns resets only the pagination boundary to that snapshot: explicit Load earlier messages fills
  the middle gap, deduplicates through retained rows and continues older. No automatic full-history fetch runs.
  Only a newer head window may move that boundary; a delayed older first socket snapshot cannot replace a newer HTTP
  boundary. Initial scope restoration uses the merged latest turn and respects manual selection. A successful
  authorized socket snapshot makes chat ready; a later failed parallel initial HTTP read cannot disable Send.
  An older request's success/error/finally is scoped to its initiating project/chat and request generation; obsolete
  reads are aborted. Older pages never restore selection, queue or composer state. Page merging preserves a visible
  turn element's offset in the conversation scrollport, rather than using total height growth: middle-gap insertion
  and streamed growth below the reader must not move it. Keyed answer/details remain open; old answers use the existing storage-only Save with their
  original citations. Checked 2026-11-03 against Agents `0.30.1`, Workers types `5.20261024.1` and the official
  [SQLite cursor contract](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sql-api): queries
  are fully consumed synchronously before any await, including the ID-only lookahead.
- **Terminal settlement — `chat.ts`.** The owning DO payload has optional `settlementPending: true` before the D1
  INSERT attempt; an INSERT may commit without acknowledging it. A terminal result retains that marker until a D1
  primary-binding read confirms its projection. `active` names an execution **or unfinished settlement**: release the
  volatile task/controller when execution ends, retain the pointer while settlement is pending, and do not replace it
  with another Send. If queued B exists, save B as never dispatched under the interrupted-queue rule before clearing
  it. B has known zero usage and no D1 row, and never receives a settlement marker. Storage recovery never promotes B.
  Startup and authorised history/reconnect, repeat-ID, Stop and Save reads perform storage-only recovery. One action
  selects at most **eight** marked IDs via the partial `turns_pending_settlement` DO index, prioritising the active ID.
  This also finds marked results outside the latest-50 history window or with a cleared pointer. An unresolved marked
  orphan becomes the active settlement pointer. Historical **unmarked** terminal orphans whose pointer was already
  lost are not backfilled by this slice; it does not scan all historical payloads or add a second turn store.
  For each selected turn, read D1 once; update at most once and only with `WHERE state='started'` plus model/scope-mode
  identity guards, then read back once, including after an update error or zero changes. An already-terminal row is
  read and compared without issuing an UPDATE, respecting migration `0006`. Exact comparison covers model, scope
  mode, ordered revision JSON, context mode, state, input/cached/output counts, token bound, citation/invalid-label
  counts, first-token/total timing and error. Historical currency, pricing date and creation time remain untouched.
  A started D1 row can be ahead of a DO checkpoint: recover its known token counts/bound and frozen scope when the DO
  value is still unknown/uninitialised; persist those values before terminalising D1. Null remains null when neither
  record knows usage. Scope is checkpointed in DO before its D1 write. A confirmed missing row at the pristine
  pre-INSERT checkpoint means no admission/dispatch and known zero; no D1 receipt is invented. A read failure does
  not prove absence. Missing rows with evidence of execution remain pending and visible.
  On exact confirmation, clear the marker and error locally, then release the pointer. An ambiguous committed update
  converges by read-back; a local marker-clear failure retries that confirmation without updating terminal D1. Storage
  failure or terminal mismatch retains the marker, payload and pointer, with a safe `settlementError` in the existing
  reader; an older hidden turn's error is also exposed by the snapshot and existing history Retry control. Mismatched
  terminal rows are never overwritten or silently adopted. One action has no retry loop, timer, model lookup,
  admission or inference. Notifications remain best-effort. Checked 2026-11-02 against pinned Agents `0.30.1`, Workers
  types `5.20261024.1`, the official [D1 prepared-statement contract](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
  and [DO SQLite contract](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

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
`ELIOT_MCP_ORIGIN` selects that endpoint's exact origin. The UI and MCP hostnames use an Access application audience
that covers both configured hosts; signed service tokens become read/propose agents only on MCP, never on UI APIs.
Migration `0009_agents.sql` adds the proposal base to existing page revisions and maintains current-claim FTS.
Checked-output recovery publishes its guarded head before claim upserts, so FTS insert/update and head maintenance
are all used. No claim-delete trigger is needed before lifecycle deletion has a caller. Headless proposals are omitted
from accepted Studio pages until the owner accepts them.

For an external client against the built Worker, `pnpm eval k4 --serve-signed-agent` uses explicit loopback MCP/UI
origins with one shared nonzero port. It starts the existing Miniflare fixture with test JWKS, no AI binding and no
automatic data seeding. Test credentials are written only to a private ignored session file; the session expires and
disposes after 30 minutes. The ordinary signed fixture retains its five-minute credentials. This is local protocol
and actor verification, not deployed Access acceptance.

Workflow IDs are deterministic: `ingest-<revision>`, `ocr-<job>`, `distill-<revision>`,
`project-<project>-<inputHash>`, `research-<job>`. Reuse an existing instance according to installed types. Each external
call is one bounded step; paid model/search calls are not automatically repeated. Each deterministic write is a short
separate step. Avoid fine-grained polling loops because
steps are billed; use `uploadAndPoll` in one step when safe. Bodies stay in R2 and Workflow state keeps IDs/counts/compact
diagnostics. Progress lives in the D1 row already polled by UI. Check cancellation and budget before every external
call; an in-flight call may finish.

## 11. Models

The native default's cold-start metadata includes its documented low reasoning effort, matching the existing native
catalogue discovery policy. GLM 5.3 Flash supports low/high/max and defaults to max when effort is omitted; reasoning
cannot be disabled. The admitted model keeps this parameter frozen with its context and output bounds.

Model routes preserve provider-native identity: `workers-ai:<model>` or `gateway:<provider>/<native ID>`. Provider
APIs supply current catalogue entries and capabilities; unknown metadata remains visible and does not by itself ban
selection. Paid admission requires usable input metadata and provider allowance, without a price lookup or a
locally invented monthly allowance. Record declared input plus published output capacity when both are known (twice
for distillation), otherwise `null` with an independent admission claim. Freeze the admitted `ModelSpec` and retain
unknown usage as unknown. The assembly reserve does not become a provider maximum; legacy/OCR snapshots retain
their admitted per-call cap. Provider errors/limits remain visible; there is no artificial
quota, paid fallback or model-name allowlist/banlist.

**Providers.** Migration `0008_model_providers.sql` stores the editable provider configuration in
`settings.model_providers_json`: ID, adapter type (`workers-ai` or `openai-compatible`), HTTPS API base URL, enabled
flag and the existing Cloudflare provider slug/path prefix. ID supplies the `gateway:<id>/<native model>` identity;
the Cloudflare slug/path supplies routing, including the required `custom-` prefix for custom providers. These values
contain no credentials. Owner-only PUT `/api/models/providers` saves configuration; GET reads it. Neither discovers
models or starts inference. The seeded providers preserve the existing Workers AI, OpenRouter and Command Code routes.

Migration `0008_model_providers.sql` seeds Kilo, Nous Portal and OpenCode Go alongside the existing providers.
The new provider rows start disabled. It adds settings and token bounds without rewriting existing models,
usage or credentials; the earlier unmerged provider migrations are consolidated into this file.
The current official endpoints were checked on 2026-10-29; the pinned donor's older Kilo URL is not reused.

| Provider ID | Configured API root | Public model catalogue | Gateway prefix |
|---|---|---|---|
| `command-code` | `https://api.commandcode.ai/provider/v1` | API root + `/models` | `custom-command-code/v1` |
| `kilo` | `https://ai-gateway.kilo.ai/api/v1` | API root + `/models` | `custom-kilo/v1` |
| `nous` | `https://inference-api.nousresearch.com/v1` | API root + `/models` | `custom-nous/v1` |
| `opencode-go` | `https://opencode.ai/inference/go` | `https://opencode.ai/inference/go/v1/models` | `custom-opencode-go` |

The custom Gateway definitions retain each upstream fixed prefix: Command Code `/provider`, Kilo `/api`, Nous's
origin and OpenCode Go `/inference/go`. Provider credentials remain in Gateway BYOK. Public catalogue reads do not
prove authenticated inference. No private CLI login, OAuth store or provider key is imported from OpenCodex.

Optional `modelsUrl` overrides the usual API-root + `/models` read. Optional `metadataUrl` reads published provider
metadata during explicit Refresh only. OpenCode documents [models.dev](https://opencode.ai/v2/docs/models) as its
model-data source: Go's live API remains the authority for IDs, while the `opencode-go` block of
`https://models.dev/api.json` supplies its published limits, modalities, API package and endpoint. The join includes
only live Go IDs and ignores prices, foreign provider blocks and extra metadata-only IDs. It contains no model-name
table or family inference. Ordinary catalogue bounds remain 4 MiB and 2,000 rows; this optional metadata read has an
8 MiB bound for the observed 5.94 MB feed, and only the selected provider's data enters the existing R2 snapshot.
Unavailable or malformed metadata for the configured provider/live IDs preserves the last good provider slice with a
warning. A missing optional live-ID entry stays unknown; foreign and metadata-only IDs are ignored. Missing usable
limits or API metadata never authorize a call.

Per-model `apiProtocol` and `apiBaseUrl` freeze the published API choice alongside normal routing metadata. Package
metadata selects the maintained Chat Completions, Responses, Anthropic or Google SDK; absent metadata remains unknown.
The endpoint must be HTTPS beneath the owner-approved provider API root, and is checked again before transport.
The selected native SDK loads lazily and builds the request; receiver-bound `AI.fetch` forwards it through the configured custom Gateway route,
stripping vendor credentials while keeping required protocol headers and streaming query parameters. Responses uses
`store:false` without previous-response or conversation state. Calls retain their existing token, time, attempt and
usage bounds. Editing either discovery URL invalidates old routing metadata until explicit Refresh succeeds.

Provider references: [Command Code API](https://commandcode.ai/docs/provider),
[Kilo Gateway API](https://kilo.ai/docs/gateway/api-reference), [Nous Portal](https://portal.nousresearch.com),
[OpenCode Go](https://opencode.ai/v2/docs/console/go/) and its
[inference APIs](https://opencode.ai/v2/docs/console/api/inference). Publication dates were not exposed; retrieval
date is 2026-10-29. Their model lists and account access remain dynamic.

**Catalogue and refresh.** R2 `catalog/models.json` is the model snapshot. GET `/api/models`, settings/model selection
and paid admission read stored metadata only. The owner-only POST `/api/models/refresh` accepts
an empty object and is the only provider discovery path. Refresh stores the timestamp and provider configuration in the
same R2 object; no D1/settings migration is required. A provider refresh failure preserves that provider's prior slice
and returns a warning while available provider slices may update. On an absent snapshot, GET returns the native Flash
fallback, `snapshot.updatedAt: null`, `snapshot.refreshNeeded: true` and a refresh-needed warning. The snapshot
contains no credentials.

Provider quotas are optional display data in the same R2 snapshot. Explicit Refresh reads OpenRouter's documented
`GET /api/v1/key` through the configured Gateway's receiver-bound `AI.fetch`, without a provider Authorization header.
The installed Agents 0.30.1 native path preserves the method and headers; the OpenRouter GET path was verified on
2026-10-28. The read has one attempt, a 15-second timeout and a 64-KiB body bound. Unsupported or unavailable quota
data remains null; no unit or reset date is invented. Stored quota values are tied to their provider route and Gateway
ID, and GET only reads those stored values. A quota-read failure does not invalidate successfully refreshed models.
Quota data is an observation, separate from owning-row request bounds. The official endpoint is described in
[OpenRouter's key-limit documentation](https://openrouter.ai/docs/api_reference/limits.md) and
[OpenAPI schema](https://openrouter.ai/openapi.json), retrieved 2026-10-28; no publication date was exposed.

Workers AI's native free allocation is 10,000 Neurons per UTC day, shared across that account's Workers AI usage and
reset at 00:00 UTC. On Workers Paid, usage beyond the free allocation is billed; the included allocation alone is not
a paid-account spending cap ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), updated
2026-10-20). Tokens, Neurons and provider credit balances are separate units. Eliot does not derive one from another or
apply the Workers AI allocation to OpenRouter/Command Code.

Explicit catalogue Refresh also reads the current day's Neurons from Cloudflare GraphQL
`aiInferenceAdaptiveGroups { sum { totalNeurons } }`, from 00:00 UTC to now. It uses public account setting
`ELIOT_CF_ACCOUNT_ID` and a separate `ELIOT_CF_ANALYTICS_TOKEN` secret restricted to Account Analytics: Read.
The bounded read is stored in the existing R2 snapshot; page loads and GETs use only that cached current-day value.
A valid empty dataset is zero. Missing access, invalid data and stale-day data remain unavailable. The counter is an
observation, not a token conversion or a guarantee that a Paid account stops at the free allocation.

Migration `0008_model_providers.sql` stores the owner choice in `settings.native_usage_mode`:
`included` (default) or `standard`. GET/PUT `/api/settings` exposes `nativeUsageMode`; saving the choice performs no
inference, does not change the selected provider/models and applies to new admissions. `included` keeps native
requests paused while an exact 10,000-Neuron daily cap cannot be verified/enforced for this connection. It is not a
working usage meter or a claim that the Paid account stops at that allocation. `standard` explicitly permits normal
Cloudflare billing, including Paid overage, while retaining each job's token/call/time bounds. Missing or unreadable
policy fails closed for native requests. Non-native providers use their own limits independently of this setting.

During refresh, each enabled compatible provider supplies its bounded JSON `/models` catalogue; Workers AI uses its
native binding. Partial failure preserves that provider's last good metadata and its original routing configuration.
Changing a provider's base URL or Gateway route invalidates old external metadata until an explicit refresh succeeds.
Neither API nor HTML prices are required or parsed for new model selection/admission. Missing usable context/output
metadata blocks dispatch. The UI filters do not run discovery or change selection.
Catalogue and metadata URLs pass the existing public-URL guard, and redirects are rejected. If a public catalogue
denies access with 401/403, an explicitly configured Gateway can read that same provider path using stored BYOK;
credentials are never sent by the app or forwarded to a different origin. A refused authenticated read remains a
provider failure and preserves its prior catalogue slice.
The admitted external `ModelSpec` carries the provider configuration and Gateway ID from that same catalogue read;
transport uses this frozen routing instead of reading changed settings after admission.
Published `supported_parameters` may advertise temperature support; those requests use temperature 0 for source-faithful
generation, while missing metadata leaves the parameter unset. OpenRouter structured jobs disable reasoning only when
the same snapshot advertises its control and explicitly marks it non-mandatory. Chat, mandatory reasoning and unknown
capabilities are not silently given that override. The existing output/call bounds remain unchanged; truncation is a
failed structured result, retained for inspection without an automatic repair call.

Cloudflare documents R2 object consistency in the [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
(dateModified: 2026-07-31), supporting the single-object snapshot timestamp contract.

The factory fallback remains native Workers AI Flash (`workers-ai:@cf/zai-org/glm-5.3-flash`); the stored global answer
and understanding defaults are owner choices. The owner currently uses OpenRouter while native allowance remains paused.
Benchmarks freeze the configured answer and understanding models for the run; they never switch models per question
or lower the evidence gates for a provider. Available choices include the explicit native `workers-ai:@cf/zai-org/glm-5.3` route, Command Code through
`gateway:command-code/<native-id>`, and owner-selected OpenRouter routes
`gateway:openrouter/dots-studio/dots-3-note-preview:free`,
`gateway:openrouter/thinkingmachines/inkling:free`, and
`gateway:openrouter/nvidia/nemotron-3.5-super-vl:free`. These are route choices, not an availability guarantee or
catalogue restriction. Provider APIs provide the selectable catalogue; no model-name allowlist or ban is introduced.
OpenRouter embed/rerank IDs remain separate future K5 capabilities, not chat choices.

Settings uses one visible provider/search/free-name filter and catalogue, with Answers/Understanding choosing which
default is being edited. Filters are display-only; the catalogue has no pagination or technical model-details panel.
Chat and project settings use compact provider then model selection with the applicable default available. Refresh preserves the
selected provider/native-ID pair. Usable model bounds and provider allowance remain required for dispatch.

Migration `0005_model_gateway.sql` adds nullable `settings.model_gateway_id`; null disables external routes. Owner-only
GET `/api/models/connection` and PUT read/save the exact existing named Gateway ID. Enabling requires
`confirmCredentialAccess: true`; default is rejected because it may create a Gateway implicitly. Saving records owner
consent/configuration only and does not prove Gateway or provider usability. No credential input, secret, direct
provider Authorization header or dummy key is stored in Eliot; credentials remain in Cloudflare's default BYOK alias.

Compatible providers use the installed `@ai-sdk/openai-compatible` provider through the pinned Agents provider-native
`AI.fetch` adapter, with one attempt, no-wholesale, skip-cache and no-log controls. Source forwarding of those controls
does not prove live Gateway enforcement. Command Code receives the current question and frozen source context without
history, avoiding a private multi-turn protocol dependency. It uses no fabricated reasoning marker, private capture,
repair call or automatic retry. See §8 for public history and frozen source rules.

The official OpenRouter API configuration includes optional `dataCollection: "deny" | "allow"` in the existing
`settings.model_providers_json`; omitted values normalize to `deny`, including old configurations. Settings exposes
the choice only for that API root, using the existing Save action. `deny` restricts routing to providers that do not
collect user data; owner-selected `allow` permits providers that may retain or train on inputs under their terms.
Saving performs no discovery or inference and preserves catalogue identities, bounds and selected models. Admission
freezes the choice in `ModelSpec.routing.provider`; every OpenRouter transport uses that frozen value, with `deny`
for older admitted jobs that lack it. Later settings edits apply only to new admissions. Other providers reject the
field. Account privacy settings can impose additional restrictions and are never changed by this control. This
contract was checked against the official provider-routing documentation on 2026-10-29; no publication date was exposed.

A known structured 404 reporting no endpoints
matching the provider's data policy is shown as a fixed, actionable failure with its HTTP status. Unknown or malformed
error bodies retain the generic status message. Raw provider text is never copied into that reason, and the failure
does not change the selected model or data policy or start another request. Catalogue presence does not establish
that the account has an endpoint eligible under this policy.

OpenRouter uses the installed Agents AI Gateway adapter and `@ai-sdk/openai-compatible`, with provider fallbacks
disabled and the same one-attempt/no-wholesale/skip-cache/no-log intent. The gateway route contains the native model
ID; no direct provider key or alternate route is used. Cloudflare Gateway BYOK describes Eliot's OpenRouter API
credential; OpenRouter `usage.is_byok` describes an upstream provider key and does not prove Cloudflare wholesale or
fallback behavior. Live enforcement and external provider billing acceptance remain unverified.

Official provider facts remain subject to recheck before implementation or merge. References include the [OpenRouter
catalog](https://openrouter.ai/api/v1/models), its [provider-routing contract](https://openrouter.ai/docs/guides/routing/provider-selection),
the [Cloudflare Agents AI SDK](https://developers.cloudflare.com/agents/models/ai-sdk/) (updated 2026-10-26),
[AI Gateway OpenRouter routing](https://developers.cloudflare.com/ai-gateway/usage/providers/openrouter/) (2026-04-20),
[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) (2026-09-22),
[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) (2026-09-30) and
[request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/) (2026-09-14).
OpenRouter metadata examples were retrieved 2026-10-26; its API records provided no dateModified.

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

Shared card, chip and labelled-field presentation lives in `src/web/ui/controls.css`; native elements keep their
semantics and feature styles keep only their layout or distinct variants. The layout uses one 48rem breakpoint;
reduced-motion and forced-colour queries remain accessibility preferences. Appearance is selected once in the header.
The chat composer stays visible at the bottom of the reading pane while earlier answers scroll. Answer details show
cited passages; token counts, timings and context/verification counters stay in API/eval diagnostics. Library and
understanding show useful availability, progress and actionable failures without model routes or workflow machinery.
The project screen uses Sources, Chat and Studio panes on desktop and the same three destinations in the compact
bottom bar. Pane contents scroll independently; the composer is the final Chat row, never a sticky overlay over
sources. Sources start with readable-source checkboxes and current understanding availability. One Add action opens
the existing file/text/URL forms in a native dialog. History is a menu and project settings a dialog. Opening a source
passage temporarily replaces the center reader without dropping the selected chat or source scope. Saved output
refreshes Studio through the existing storage-only page API.
The source Reader highlights a citation's exact UTF-8 range inside the complete canonical text and focuses/scrolls
to it on passage navigation. The surrounding text and the pre's complete text content stay unchanged. Copy link
handles selections within or across the mark; invalid ranges retain full text with an error and Clear passage.
Add sources keeps text and URL drafts independent. Each form allows one pending submission while its fields remain
editable. Success clears only the unchanged submitted draft; later edits, failures and duplicate responses keep it.
Closing and reopening the dialog does not cancel the write or discard newer input. Drafts stay local to the mounted
project workspace; no automatic retry or browser persistence is added.
Projects exposes Show archived projects and Unarchive. Each list view owns its query/cursor; switching views aborts
old reads and starts its first page. Failed reads keep loaded rows and offer Retry. A pending write or Rename edit
disables view switching; failed writes preserve the row/edit, while success refreshes that view. The active-only
project picker and MCP default remain unchanged.
Create waits for Rename to finish or be cancelled. If an update removes the edited row from the loaded pages, its
existing editor stays available above the list with the unsaved name and original target; Save/Cancel never depend
on that row remaining visible.
A successful Save closes only the submitted edit; typing while it is pending remains unsaved until another explicit Save.
Create also preserves text edited while its request is pending. An explicit repeat of an unconfirmed, unchanged
payload reuses its UUID; confirmation or a changed payload starts a new attempt. The draft and UUID are local to the
mounted Projects form and are discarded on remount/reload.
The project header's Switch project opens a native dialog over the existing `/api/projects` pages. Loading, empty,
initial/page Retry and Refresh stay in that picker; its list reads abort on close or route change. Selecting a project
opens its chat route without creating a chat or sending a question. Escape/Close returns focus and preserves the
originating draft/selection. An ordinary same-tab choice of another project requires confirmation before discarding
a nonblank question; Cancel leaves the picker, draft and source scope intact. Current-project and blank-draft choices
need no confirmation. Confirmed project changes keep the workspace's existing reset semantics.
Converting project-default scope to an explicit selection waits until all source pages are loaded; it never drops
unloaded sources. Already explicit selections retain their full IDs while the visible source list is paginated.
Choosing a stored suggested question explicitly selects its one source and opens the existing chat composer. Workspace
owns the draft text and visible source selection; ChatView retains the Send/Stop/Save lifecycle and draft-edit guard.
A nonblank different draft requires confirmation, with Keep draft/Escape preserving its text and selection. Route
changes dismiss the pending choice. The composer displays its current source scope. Chat freezes current readable
heads on explicit Send; historical Reader questions stay read-only. Prefill creates no chat or inference request.

Routes: K0 `/`, `/settings`; K1 `/p/:projectId/sources`, `/p/:projectId/source/:sourceId?start=&end=`; K2
`/p/:projectId/chat/:chatId?`, `/p/:projectId/studio`; K3 `/p/:projectId/overview` and understanding in the source reader.
Every screen has loading, empty and actionable error states plus stale/paused where relevant. Use one Markdown renderer
with raw HTML disabled and resolved citation chips. Do not cache private text in localStorage or a service worker.
The web renderer uses `remark-math` and `rehype-katex` for `\(...\)`, `\[...\]` and `$$...$$` as native MathML, without
KaTeX styles or font assets. Only the TeX compatibility path adds a standard GFM Markdown AST pass to preserve code, links
and other literal nodes. Single `$` stays literal for currency; unfinished expressions stay readable and display formulas
scroll locally. This targets modern Chromium with native MathML, with no legacy HTML fallback or stored-evidence changes.

The shared model picker reuses the approved legacy Material interaction and provider/native-ID identity. Settings
provider, search and free-name filters only filter the displayed catalogue; they do not change saved routes or admission.
Chat uses compact provider then model controls with project default available. A provider with no enabled,
unambiguous catalogue choices is visibly unavailable. Model changes affect the next Send; each answer shows its stored
model's name. New chats may Send with no sources, while existing chats wait for their history to load. Changing chats
clears the previous queue view and ignores messages from the closed connection. The inherited model name is displayed
without sending an explicit override.
On phone, one Sources and model disclosure shows the current scope and model summary while the existing controls
stay mounted. Opening it exposes scope navigation and the same picker; collapsing keeps draft/selection/provider
state and leaves model errors, pending status and data-use warnings visible. Desktop controls remain expanded.
History and New chat confirm before discarding a nonblank question draft. Cancel preserves the open menu, chat, draft
and source scope. Choosing the current chat, remaining in a new chat or using a modified link leaves its draft intact
without confirmation; blank drafts follow the existing navigation. This applies to these controls, not browser Back/Forward.
Settings keeps human provider names and known quota values on compact rows,
with provider addresses and Gateway routing in connection dialogs. Both owner billing and data-use choices remain.
Unknown metadata stays visible, and model-job admission remains separate
from selection.

**Conversation decomposition — open.** Keep the active conversation's HTTP/socket/history/version/cursor/scroll
lifecycle together when separating it from presentational composer/actions. Each route, connection and source selection
keeps one state owner; preserve stale-response cancellation, queued status and current Material layout. Use existing
React/QueryClient facilities where they remove current duplication. In `ChatAgent.runTurn`, keep admission → frozen
context → dispatch → settlement visible in one orchestrator; extract only deterministic citation/completion and usage
projection helpers, keeping stop/deadline ordering intact. Then review `SourcesPane`, `OcrDialog` and `ModelSettings`
for similarly independent responsibilities when touching them. Function length locates review targets; it is not a
quota or justification for a hook hierarchy, generic lifecycle framework, new provider layer or mass file splitting.

`web/use-chat-history.ts` owns project chat-list reads, paging and created-row insertion. Both page paths merge by ID,
so a delayed first page cannot erase a newly created chat. Failure retains loaded rows/cursor; initial failure offers
Retry. Cleanup aborts the current read. Conversation HTTP/socket/version/cursor/scroll and Send/Stop/Save remain in
`ChatView`.
Its memoized turn content retains unchanged answers across streamed frames. The existing conversation box's resize
observer pauses content rendering while CSS hides that pane on desktop or phone, retaining its DOM/details and the
owning socket/history/action state; revealing it renders the latest received turn without replaying hidden frames.

**Post-stream usage.** `chat-usage.ts:turnUsageProjection` owns the pure
post-stream projection of AI SDK reported token/provider usage and the known-zero undispatched case. `runTurn` applies
that usage-only patch at its original post-stream point. An absent report leaves existing unknown values and the held
reservation untouched; reported zeros stay zero and missing reported fields stay null. It reuses the existing safe
provider-usage projection. Admission, abort/deadline, queue, citation work and durable settlement remain orchestrated
by `ChatAgent`; no state owner or effect moved. Existing stream/Stop/deadline/settlement and view-isolation gates check
the assembled path. The larger ChatView history/socket ownership decomposition remains open and is not part of this slice.

**Studio completeness — implementation and acceptance in MAP.** The existing pages GET returns at most 50 summaries,
with a project/kind-scoped value cursor on immutable `(created_at,id)` and a 51st metadata-row lookahead. Migration
`0011_studio_pages` indexes published pages in that order. Accept and source invalidation change head/freshness and
`updated_at`, not the pagination key; a cursor never re-reads its anchor. List/detail expose creation time and the
existing accepted `headRevisionNo`, without another version store. Supported writers advance that revision number;
within one head freshness changes only from current to stale. The UI uses those facts to deduplicate and merge
reordered metadata without letting a delayed current/older-head response undo an already observed stale/newer head.

Studio exposes explicit Load more pages, Refresh pages and separate list/detail retries. Current/Stale appears as text
in the list with a button description, and selected detail announces its own returned head's freshness as a status.
Loading more keeps selection. Refresh restarts the listing, discarding unchecked older summaries, while preserving
the selected reader and rereading it independently, even outside the first page. Detail never borrows status from an
older list row; a newer list head can trigger a fresh detail read. Requests are abortable and scoped by project/page
and generation through success/error/finally. A failed read does not claim refreshed freshness.

Owner acceptance triggers a new scan and selects the accepted page directly. A headless proposal can become eligible
above an already passed cursor: immutable ordering cannot make that old scan discover it. External acceptance and
source changes are picked up by explicit Refresh, rather than polling or claiming one scan captures every concurrent
eligibility change. Historical bodies and exact citation links remain immutable. These reads never start model/search
work. Checked 2026-11-03 against pinned D1 types and the official [D1 binding](https://developers.cloudflare.com/d1/worker-api/d1-database/)
and [SQLite tuple pagination](https://www.sqlite.org/rowvalue.html#scrolling_window_queries) contracts.

**Asynchronous view isolation — implementation and acceptance in MAP.** Chat Send freezes the question, source scope
and model override before awaiting chat creation. A departed creation view cannot dispatch a turn after that await.
An already submitted write retains its original target; its acknowledgement, error and navigation belong to the
initiating mounted location, including its navigation generation. Returning A→B→A does not renew old ownership.
Draft edits made during Send survive acknowledgement and intentional first-chat navigation; that navigation also
retains newer source selection rather than restoring the sent scope from history. Stop/Save result messages use the
same view ownership. A successful Save still refreshes Studio in its owning mounted project. Separate project/chat
request generations prevent an old completion from unlocking a newer Send.

Reader is keyed by project/source, resetting metadata, text and both React/native replacement-file state on source
change. Revision and passage navigation reuse that source reader. Metadata reads carry source/revision generation
and abort signals; pending polls do not overlap. A metadata read error retains the last source view, stops polling
and offers Retry source status. Successful explicit Retry restores pending polling until conversion settles;
metadata errors remain separate from text and replacement errors. Text/outline reads abort on revision change/unmount. A replacement
POST remains bound to its original source/file, while only its initiating location may change URL, error or file
selection. A narrow `(projectId,sourceId)` lock in the existing App outlives keyed Reader/workspace remounts, pane changes
and same-tab project/Settings navigation. A→B→A and same-source query changes cannot dispatch another A upload before
settlement, while other project/source pairs can upload independently. Only the owning POST's settlement removes its
key; completed requests leave no retained lock. This is a same-tab request guard, not cross-tab or reload idempotency.
Existing source/citation and same-revision OCR navigation retain text/outline semantics.
An explicit repeat for the same selected replacement File reuses its revision UUID until a matching acknowledgement.
A changed File or a confirmed new upload gets a new UUID. Reader remounts discard the File and attempt; no browser draft
is persisted. Confirmation clears the file input so the same file can be deliberately selected again.
No write is cancelled or automatically retried to infer its server outcome, and no read starts model work.

`pnpm eval k2 --view-isolation` exercises the reused workspace on desktop and phone, including held success/error
responses, A→B→A, project/Settings remounts, serialized polls, revision changes and independent project/source locks.
Success/error cleanup is checked while the original workspace is absent. It uses native stored sources and intercepts
model and held replacement POSTs before dispatch. Lost, malformed and mismatched replies are also tested after actual
native replacement acceptance: an explicit repeat adds no revision, while a confirmed new action does. Stored turns
remain empty and native conversion calls stay zero; this proves view ownership and storage replay, not model semantics.
Checked against pinned React 19.3 and official
[effect cleanup](https://react.dev/reference/react/useEffect) and
[AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) contracts.

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
| Native Flash fallback and catalogue admission contract in §11 | dynamic provider metadata; no static GLM price snapshot is claimed |
| Direct `ai_search` binding addresses an existing default-namespace instance | verified |
| AI Search billing starts 2026-11-01; included 5M ingestion, 10 GB-month, 1k semantic and 1k full-text queries | verified |
| Excess: $0.75/M ingestion, $2/GB-month, $0.75/1k semantic/vector/hybrid, $0.10/1k full-text | verified |
| AI Search text/code and OCR PDFs max 10 MiB; other files/PDF without OCR max 4 MiB | verified |
| AI Search chunk offsets exactly equal uploaded UTF-8 bytes | **open — K5 spike** |
| `$in` handles 500 revision IDs on the real binding | **open — K5 spike** |
| Best Russian keyword tokenizer | **open — K5 spike** |
| Prompt-cache behaviour and maximum output for each enabled route | **open — K2 measurement/schema check** |

### Unmerged proposal PR #419 (explicitly unaccepted)

[PR #419](https://github.com/UnknownAlienHuman/eliot-research/pull/419) at
`4dfcd8eb308e84f26c6c7e42a921aec25746a19c` remains closed and unmerged (checked 2026-10-28). Its proposed converter,
read APIs and rewritten migrations are not accepted contracts. Current K1 retains native UTF-8 text or
`env.AI.toMarkdown().transform()` with embedded-image opt-out and PDF metadata disabled; those request options alone
do not prove that service output contains no derived image descriptions. Existing canonical revisions and citations
must remain intact.

The proposed `unjs/unpdf@87c7edc43ee99a17d2aa20acf271c4889332720b` (`1.9.1`, MIT, `src/text.ts` and
`examples/cloudflare/index.ts`) is not adopted. Its parallel page extraction would need measurement before replacing K1.

| Choice / current decision | Implication |
|---|---|
| Read API: `/text`, `/range`, `/outline` or PR `/text?start=&end=` and `/blocks` | Retain current callers unless an API change is explicitly accepted. |
| Canonical converter: current K1 path or deterministic PDF/HTML extraction | A replacement needs an explicit converter decision and fresh K1 acceptance. |
| Image evidence: explicit PDF OCR with preview/Apply is owner-approved | Use §4's separate selected-model job and immutable new revision. Ordinary ingest remains without OCR; the bounded local journey is verified, while full PDF/corpus OCR quality remains NOT_RUN. This does not adopt PR #419 or approve general image descriptions. |
| Schema: revision-owned state or PR attempt/reservation tables | PR rewrites `0001`–`0004`, renames columns and adds run/reservation tables. These incompatible contracts require deliberate migration design; do not apply them to retained data. |
