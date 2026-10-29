# Eliot Research — Delivery map

This is the executable work plan. It splits [ARCHITECTURE](ARCHITECTURE.md) into usable end-to-end contours.
[IMPLEMENTATION](IMPLEMENTATION.md) is the technical contract, [DONORS](DONORS.md) identifies reusable mechanisms, and
[`eval/`](../eval/README.md) contains fixed acceptance material.

## How a contour is executed

1. Read ARCHITECTURE, this contour and only the IMPLEMENTATION sections named by it.
2. Build only **Build**. Anything under **Not now** waits, even when another document already describes it.
3. Exercise the real API and owner journey on fixed material. No mock acceptance.
4. Open one PR per contour or independently usable slice. State owner outcome, acceptance output, new non-test lines,
   measured latency/cost and deferred work.
5. A contour is done when the owner can use it, hard gates pass, each new route/table/file has a caller and the code
   budget holds or is explicitly justified.

### Acceptance classes

- **Hard functional gate:** correctness, citation validity, data integrity, auth and owner journey. Failure blocks merge.
- **Hard quality gate:** expected facts and abstention on fixed questions. Failure blocks merge.
- **Measured budget:** latency, token use and estimated cost. The first real contour run establishes p50/p95; a target
  becomes a hard regression gate only after it has three comparable runs. A catastrophic ceiling may block immediately.
- **Platform spike:** an uncertain Cloudflare contract is tested before architecture depends on it. A failed spike uses
  the documented fallback; it does not trigger a home-grown platform rewrite.

Unit tests exist only for pure logic whose failure can be silent: UTF-8 ranges, block scanning, label resolution, quote
verification, URL guard, context budgeting, cost admission and Access validation. Add a regression test for a bug that
actually occurred. Product tests remain the contour evals.

Code budgets count new non-test lines under `src/`, excluding UI moved without semantic changes. They are ceilings, not
quotas.

## Current state

- K0 keeps the accepted Material shell with hostname Access auth: `/api/me`, Projects/Settings navigation and System/Light/Dark appearance verified locally on 1440/390 px with Cyrillic fonts, and all assets pass through auth. Live Access and deployed acceptance are not claimed.
- K1 implements projects, the shared Library with immutable revisions, and exact UTF-8 reading (outline, whole text, ranges, original download). Exact text/URL duplicates return 409 with explicit Attach existing, reusing the stored revision with no silent merge. Conversion stays on the current path: native text locally, Workers AI `toMarkdown` where a document format requires it. AI Search and later-contour bindings remain absent.
- K2 has a local Markdown chat path with frozen source scope, server-resolved citations, Stop/reconnect and storage-only Save, plus the R2 model snapshot with the owner-only refresh route. K2 and K3 are not fully accepted; their remaining quality and claim-mode gates stay open in their contour sections below.
- K4 and K6 remain isolated, unaccepted work. K6 is frozen until K2/K3 acceptance.
- The existing `eliotr-core.kleymor-metal.workers.dev` address is retained per owner decision; the replacement is not deployed over it.
- Legacy `apps/`, `packages/`, `crates/` and `infra/` are donor/import material, not implementation instructions.
- PR #417 is the authoritative replacement-documentation history and supersedes the stacked plan in PR #416.

## Contour overview

| # | Owner capability | Depends on | Primary paid effect | Budget |
|---|---|---|---|---|
| K0 | Protected Material shell | — | none | 600 |
| K1 | Projects, ingest and exact reader | K0 | conversion only when needed | 1,500 |
| K2 | Cited chat and saved answers | K1 | one answer call per turn | 1,500 |
| K3 | One-time source understanding | K2 | two bounded calls per new revision | 1,200 |
| K4 | External agents over MCP | K3 | agents bring their own model | 900 |
| K5 | Large-library passage search | K3 | AI Search only after gate | 900 |
| K6 | Project map and comparisons | K3; K5 optional | bounded incremental synthesis | 1,200 |
| K7 | Deep research jobs | K6 | explicit job budget | 1,200 |
| K8 | Outgoing tools/tasks | K7 + concrete need | owner-approved only | by need |
| K9 | Lifecycle and export | K6 | none in ordinary use | 600 |
| K10 | Legacy import/retirement | K9 | one-off script | script |

K4 may proceed after K3. K5 is not a mandatory prerequisite for K6 when whole/claim retrieval passes the project eval.

---

## K0 — Shell

**Owner outcome.** `research.<domain>` is protected by Cloudflare Access and displays the accepted Material frame on
desktop and phone, with working light/dark themes and `/api/me` showing the authenticated actor.

**Build**

1. Move the Worker entry to `src/index.ts`; add Hono, `jose`, generated binding types and the API error shape.
2. Implement hostname-based Access JWT validation, owner/service-token actor resolution, Origin checks and explicit
   local development bypass. Do not use Worker-level Access because K2 needs WebSockets. IMPLEMENTATION §2.
3. Move the design tokens, primitives, Material Symbols component and frame from the legacy UI. Do not copy old query,
   runtime, preview or regression infrastructure.
4. Keep only Projects and Settings placeholders. Wire CI for lint, typecheck, build and focused unit tests.
5. Perform the one-time custom-domain and Access application setup; record repeatable CLI steps in `scripts/setup.sh`.

**Hard acceptance**

- Browser login and owner service token both resolve to `owner`; malformed, expired and wrong-audience assertions fail.
- 1440 px and 390 px screenshots in light/dark match the accepted frame with no stream-layout placeholder hacks.
- `pnpm check` and focused auth/contrast tests pass.

**Not now.** Projects, storage, model UI, chat, MCP.

**Cost.** No model/search call; ordinary requests are Worker/static asset requests only.

---

## K1 — Read

**Owner outcome.** Create a project, choose many files in one browser action, add URL/text, watch conversion state and
open any readable source with outline and exact passage links.

**Build**

1. Bind D1, R2, Workers AI and `IngestWorkflow`; apply `migrations/0001_library.sql`.
2. Implement projects, shared Library sources, project memberships and immutable revisions.
3. Browser batch UX sends **one file per request**, with at most two uploads in flight. The API accepts one file up to
   25 MiB, never a 100 MiB buffered multipart batch. Text and URL have separate JSON routes/shapes. IMPLEMENTATION §4.
4. Hash, store original under an immutable R2 key, create pending rows and start deterministic
   `ingest-<revisionId>`. Exact duplicates are reported with Attach; never silently merged.
5. Convert native UTF-8 text locally. Use cached `env.AI.toMarkdown().supported()` only for document formats that
   require it. Do not opt into model-assisted image/OCR conversion in K1; scans retain the original and show
   `needs_conversion`. Write canonical `text.md`, exact `blocks.json`, state/warnings and current readable revision.
6. Implement outline, whole text, exact UTF-8 range and original download. Reading must not call a model.
7. Move the project/source/import/reader UI features and replace legacy adapters with `src/shared/api.ts` +
   `src/web/api.ts`. Show filenames, readable states and human revision labels; keep immutable IDs and exact ranges in
   links/API data, and conversion telemetry in eval output.
8. Add block/range/URL-guard tests and `pnpm eval k1`.

**Hard acceptance — `pnpm eval k1`**

- Ingest the ten `eval/arxiv-10` PDFs and the Russian corpus with client concurrency 2.
- Ten arXiv and two text-based Russian PDFs settle as readable/readable-with-warnings; expected arXiv papers produce at
  least 20 KiB and 50 blocks. The additional Russian scan fixture must settle as `needs_conversion`, keep the exact
  original and perform no OCR. The native Russian text fixture must make zero conversion calls.
- Three random ranges per source exactly match slices of the downloaded whole text.
- Eval prints converter, original/text bytes, blocks, wall time and conversion tokens when Cloudflare returns them.
- Owner opens three citations and one copied range link on phone.

`pnpm eval k1` includes the real phone journey, immutable old-revision checks and recovery from an offline upload.
The browser journeys also exercise duplicate pasted text and duplicate static URLs through explicit Attach existing.
`ELIOT_EVAL_NET=1 pnpm eval k1 --native-only` includes the real public static-URL case; without that opt-in its network
journey is explicitly not run. Both duplicate journeys must retain the same stored revision and perform no new
conversion/model work; the URL guard remains in force.
`ELIOT_EVAL_LIMIT=1` adds the actual 25 MiB file and 25 MiB + 1 byte rejection cases. CI runs
`pnpm eval k1 --native-only` with remote AI bindings disabled; it does not claim PDF-service acceptance.

**Measured budget.** Peak Worker memory is inspected during the 25 MiB case; no exceeded-memory event. Conversion count
must equal the number of files that actually require conversion.

**Not now.** OCR pipeline for scans, search, claims, model answer, bulk direct-to-R2 uploads above 25 MiB.

---

## K2 — Ask

**Owner outcome.** Select sources, ask in Russian or English, receive a streamed answer with exact clickable citations,
stop/reconnect, reopen chat and save an answer as a page.

**Build**

1. Apply `migrations/0002_ask.sql`; add one `ChatAgent` Durable Object per chat and `/agents/*` routing.
2. Read provider catalogues from the R2 snapshot. The owner edits the provider configuration in Settings; owner-only
   `POST /api/models/refresh` discovers JSON models and available provider quota data; a partial provider failure preserves that provider's prior slice and
   returns a warning. If no snapshot exists, use the native Flash fallback. Paid admission remains separate and
   requires usable context/output bounds and provider allowance, without per-model price prerequisites.
   Keep Command Code and add Kilo, Nous Portal and OpenCode Go through that same configuration. Go's live IDs join its
   published metadata for limits and API protocol; no model-name mapping or private donor login is copied. New provider
   rows start disabled, and saving them does not refresh catalogues or start inference.
   OpenRouter's Data use choice defaults to `deny`; explicit `allow` applies to new admissions only. Saving preserves
   catalogue metadata and defaults, performs no model/search work and never changes account privacy settings.
3. Build whole-reading context from the frozen readable revisions. When it does not fit, return a clear narrow-scope
   response; claim/search modes arrive later.
4. Implement compact turn aliases and full-revision persistent labels; persist the full revision ID and exact range.
5. Use one `runTurn` for WebSocket and eval RPC; persist the turn before the model call, stream once, resolve labels,
   store citations/usage/timing/cost and never auto-continue a paid failed stream.
6. Add chat/page APIs, one visible Material catalogue with answer/understanding defaults, compact chat/project pickers,
   saved answers and the moved chat/evidence UI. Provider configuration is separate from credentials kept in Cloudflare.
   Persist the native usage choice (included quota or standard Cloudflare billing) without starting a job or changing
   models. An unverified included-only cap pauses native requests; it must never silently enable paid overage.
7. Add label/context/cost cases and `pnpm eval k2`.

**Behavioral contract.** Only Send starts answer inference. Each turn freezes its source revisions and admitted model
metadata. Chat always returns ordinary Markdown with inline compact source labels; one generic `SYSTEM_PROMPT` applies
across corpora, with no fixed-paper coaching or JSON sentence/label enum. The server resolves labels and byte ranges.
Groups of fully specified labels may normalize to separate inline references after every member passes the same
frozen-scope validation; unknown identities and shorthand remain failures.
Standalone `Page N` / `Страница N` markers and empty headings are omitted from model input and citation labels;
canonical text, block IDs and byte ranges are unchanged. GET, history, reconnect and Save are storage-only. Stop preserves partial output; a failed paid turn is
never retried automatically.
Missing citation/numeric-support spans are advisory marks, not stream-state transitions. A completed generation can
still fail the quality gate; diagnostics do not waive citation, expected-fact or owner-review requirements.
The composer remains visible while reading long answers. Citation details retain exact passage links; runtime counters
and internal processing terminology stay in API/eval output rather than the owner reading interface.
Provider data-policy rejection shows a safe reason and leaves the chosen model and policy unchanged.

**Hard acceptance — `pnpm eval k2`**

- Run C1–C4 and O1–O8 from `eval/arxiv-10/questions.md` in whole mode.
  Freeze the configured global answer model for the complete run. The owner's temporary OpenRouter selection changes
  the provider, not the questions, source bytes, citation rules or quality gates.
- Every completed answer has at least one citation, `invalidLabels = 0`, and every cited range opens.
- C1–C4 contain the expected values and conditions. O8 abstains where the corpus lacks the answer.
- Owner judges O1, O2, O3 and O8 at least as useful and honest as the recorded NotebookLM baseline.
- Each turn respects its recorded input/output, call and time bounds and provider limits; eval reports known token
  usage separately from unknown usage. It does not convert tokens into Cloudflare Neurons or infer monetary prices.

**Measured budget.** Record cold/warm p50/p95 first-token and total time. Initial target: warm p50 first token ≤ 10 s,
p95 total ≤ 40 s. Catastrophic ceiling: a completed answer taking > 90 s fails K2. Promote tighter thresholds after three
comparable runs rather than making one provider fluctuation invalidate the architecture.

**Not now.** Claim mode, AI Search, web, chat tools, automatic regenerate, external-key UI.

K2 is not fully accepted or deployed: citation validity, latency and owner quality review remain open. The unchanged
twelve-question NotebookLM baseline is retained at `eval/out/notebooklm-20261026/answers.md`; comparison results belong
in the PR, and do not replace these gates. Neither K2 nor K3 is deployed.

## K3 — Distill

**Owner outcome.** Each new readable revision receives one guide, verified claim set, digest and EN/RU glossary. The
project overview is assembled from guides. Large selections can answer from claims. An unchanged revision is never
re-distilled automatically.

**Build**

1. Apply `migrations/0003_distill.sql` and `0007_manual_understanding.sql`; add `DistillWorkflow` and quote/number verification.
2. Ingest makes a revision readable without queueing understanding. Understand explicitly requests one revision;
   unchanged completed or partial output is returned without another model call.
3. Admit only the explicitly requested revision while concurrency and provider allowance permit. Blocked work is
   visibly `paused` until another explicit request. Cron only reconciles stale `running` rows against
   deterministic Workflow IDs; it never admits queued revisions.
   Keep an already queued model selection on repeat; reject a conflicting explicit model before dispatch.
4. Use at most two bounded calls: labelled canonical text produces guide and candidate claims; code verifies
   quotes/ranges/numbers; the second call receives only verified material and produces digest/glossary. Store raw
   output/report in R2 and compact claims in D1. Paid calls do not retry.
   Preserve a safe failure reason for the reader without retaining raw provider errors or credentials.
5. Assemble project overview deterministically from source titles, guide summaries and suggested questions; do not buy
   an extra overview model call.
6. Add claim context mode. The same answer prompt and citation resolver are used.
7. Add reader guide/claims UI, quote cases and `pnpm eval k3`. Reader metadata shows availability and verification
   caveats; quote links retain exact identities without displaying UUIDs or call/token/time/reservation counters.
   API progress retains the admitted job bound independently of later model-default or catalogue changes.

**Hard acceptance — `pnpm eval k3`**

- All ten papers reach `done` or a documented `partial` state; a second eval run performs no re-distillation of unchanged revisions.
  `pnpm eval k3 --unchanged-only` preflights all ten terminal revisions, submits each exact revision ID once and compares
  the stored reports, claims, call counts and usage. This reuse check does not waive the semantic or claim-mode gates.
- Every stored quote is an exact byte range; numeric result fields are cleared when not supported by their quote.
- Numbers in statements and conditions must match complete numeric literals in that same quote, rather than
  borrowing digits from a decimal axis tick, another number or another excerpt. Units, metrics and conditions must
  also be supported by that quote; numeric occurrence alone does not pass the semantic quality gate.
- A result's `valueText` contains at most one numeric quantity. Compound lists are rejected rather than split or
  silently retained with `valueNumber=null`; scientific notation remains one quantity.
- Formatting preserves the selected statement's qualifiers and conditions. Missing structured numeric context rejects
  the card rather than rewriting it into a bare scalar; the primary numeric value must occur in the stored statement.
- Transformer, ResNet and LoRA anchor expectations in `eval/arxiv-10/questions.md` are present with correct conditions;
  no unsupported number is stored. Claim count and drop rate are reported, not quality gates.
- An anchor must be expressed by a stored claim statement and supported by that same claim's exact quote; a matching
  phrase only inside a broad quote does not establish that the claim card contains the fact. Guides/digests are not
  anchor evidence.
- Claim mode keeps C1–C4 correct and citations valid; overview lists every readable source without a model call.
- The automatic claims path is exercised in a separate real overflow project: reuse the ten baseline sources and
  attach the public papers in `eval/arxiv-10/overflow.json`. Measured source bytes must exceed the unchanged model
  whole-reading cap, and all four turns must report `contextMode=claims`. The baseline PDFs/questions remain unchanged;
  no forced mode, reduced model cap, repeated padding or K5 search infrastructure is used.
- Eval prints per-revision calls, known/unknown tokens, recorded token bounds, kept/dropped reasons and wall time.
  Recorded historical calls and observed calls since the run's preflight are separate totals; an unconfirmed request
  remains unknown until its accepted submission or terminal observation is known. Overflow uses the actual job output
  reserve within published capacity, rather than treating published output capacity as a reservation.

**Not now.** Cross-source topic map/comparison, claim editor, recurring re-distillation.

K3 is not fully accepted or deployed. Open quality gates remain for three ResNet anchors, the LoRA frozen/low-rank
mechanism and latency anchors, and claim-mode C1–C4; semantic support for guide, digest and glossary content remains
separate from label and numeric validation. Storage-only Save/recheck does not dispatch inference and does not
qualify K3.

---

## K4 — Agents in

**Owner outcome.** Claude Code, Codex or another MCP client reads Eliot through the same tools and submits a proposed
page that the owner can accept or reject.

**Build**

1. Apply `migrations/0004_agents.sql`; backfill/write trigram FTS over verified claim bodies.
2. Implement the shared product tools as `(env, actor, input) → compact Markdown` with hard output caps.
3. Expose them through stateless Streamable HTTP MCP on a separate Access-protected hostname. Agent service-token actors
   may read and propose; only owner accepts.
4. Move the proposals inbox and add `pnpm eval k4` using a real MCP client.

**Hard acceptance.** Every tool respects scope/size and labels resolve. A connected agent answers O2/O5 using only Eliot
tools, proposes a page, and all citations remain valid after owner acceptance.

**Cost.** Eliot performs no model call for an external-agent request; the client brings its own model. FTS/read tools
use D1/R2 only.

**Not now.** Per-agent project ACLs, task marketplace, outgoing MCP tools, large upload through MCP.

---

## K5 — Library scale

**Owner outcome.** Large scopes that do not fit whole or claim mode can retrieve relevant passages with exact source
scope and exact citations. Identifier/number searches use cheaper full-text mode.

**Activation gate — before building product code**

Run one spike against a real AI Search instance and record in IMPLEMENTATION §15:

1. `items.chunks()` byte offsets map exactly to uploaded UTF-8 bytes.
2. Metadata `$in` supports the intended revision scope (test 500 IDs).
3. Russian keyword quality with `porter` versus `trigram`.
4. `uploadAndPoll` and item deletion behave as the installed binding types describe.
5. The `library-200` eval demonstrates a material quality/latency gain over claim mode.
6. Forecasted monthly ingestion/storage/semantic/full-text usage fits the included tier or has explicit owner approval.

A failed offset/scope gate means K5 does not ship. Keep whole/claim/FTS retrieval and ask the owner to narrow scope;
do not build a private Vectorize stack as an automatic reaction.

**Build after the gate**

1. Create one built-in-storage AI Search instance in `default`; bind it directly.
2. Index one item per **current readable revision**. Unchanged revisions are not uploaded again; replacement deletes the
   old search item after the new one is ready. Keep old R2 text for citations.
3. Use `uploadAndPoll` inside one Workflow step, then store the chunk-ID → byte-range map.
4. Search with frozen revision filters. Hydrate/snaps hits to source blocks before the model sees them.
5. Use full-text for quoted identifiers/numbers and hybrid for semantic questions. Keep reranking and query rewrite off
   until a measured eval proves their value.
6. Add search context/tool loop with a strict step cap and a local fallback to claim mode.
7. Cap ordinary monthly usage below the included allocation (initially 900 semantic + 900 full-text queries,
   4.5M ingestion tokens and 9 GiB indexed storage) to retain operational headroom.

**Hard acceptance — `pnpm eval k5`.** At least 9/10 `library-200` needles cite the expected paper/section;
`invalidLabels = 0`; source filters never leak. K2/K3 evals still pass.

**Measured budget.** Report p50/p95 latency and actual query type/count. AI Search billing assumptions are dated and
rechecked before merge.

**Not now.** Per-project instances, public AI Search endpoint, AI Search generation, custom vector database.

---

## K6 — Project knowledge

**Owner outcome.** A living project map shows topics, compatible comparison rows, disagreement candidates, gaps,
reading routes and owner-requested Wiki pages. Source changes stale only dependent pages.

**Build**

1. `ProjectKnowledgeWorkflow` starts only on explicit Refresh.
2. Assign new sources to at most 12 topics using guide + verified claims. Reuse existing topics where possible.
3. Build comparison candidates by code: NFKC/lowercase normalization, parsed numeric value/unit, dataset and condition
   compatibility. Use one bounded semantic grouping call only for unmatched EN/RU synonyms; never compare incompatible
   units/datasets merely because raw `task`/`metric` text matches.
4. Check disagreement only inside compatible groups and show both exact quotes.
5. Build gaps/routes from compact guides/claims; write a versioned map page. Wiki pages are generated only on request.
6. Mark pages stale from `inputs_json`; Refresh writes a new revision/proposal.

**Hard acceptance — `pnpm eval k6`.** All sources appear in topics; at least three genuinely comparable multi-source
result groups; replacing one paper stales exactly the pages that used the old revision. Owner can answer O1–O5 from the
map and inspect evidence for every comparison.

**Cost.** Incremental: unchanged source/topic assignments are reused. No full-corpus re-read.

**Not now.** Graph database, centrality, automatic Wiki for every topic.

---

## K7 — Deep research

**Owner outcome.** Start a bounded investigation over Library plus optional web, see progress and estimated spend, Stop,
and receive a cited report. Web evidence is captured before citation.

**Build**

1. Add `job` migration/state with explicit `maxModelCalls`, `maxTokens`, `maxWebCaptures`, `maxEstimatedCostMicrousd`
   and deadline.
2. Implement `ResearchWorkflow`: plan → Library tools → optional web search/read → capture selected pages → synthesize.
   Static fetch first; Browser Run only when rendered content is necessary.
3. Check cancellation/budget before every external call; persist compact progress and partial findings.
4. Save final/partial report as a page with resolved citations.

**Hard acceptance — `pnpm eval k7`.** Two web-required questions produce valid reports with at least five captured
sources inside configured limits. Stop prevents the next external call and leaves a readable partial result.

**Not now.** Autonomous recurring research, invisible budget expansion, uncaptured web citations.

---

## K8 — Outgoing tools and tasks

Write this contour only after a named remote MCP server or connected agent task is required. Start read-only. Every
mutating remote call needs owner approval. Task offers are simple records that a connected agent accepts and completes
with a proposed page. Do not build a marketplace or generic orchestration layer.

## K9 — Lifecycle and export

1. Detach removes project membership; Archive hides a Library source from new selection; Delete previews affected
   projects/pages, hides immediately and removes R2/search objects synchronously or in a daily cleanup.
2. Old citations remain present and show deleted evidence rather than retargeting.
3. Export streams a ZIP of originals, `text.md`, claims, pages/citations and manifest.

**Hard acceptance.** Deleting one `arxiv-10` source stales dependent pages, removes it from current retrieval and keeps
old citation identity visible. Export opens and matches its manifest.

## K10 — Legacy import and retirement

One idempotent script, not a migration framework: read the pinned legacy stores, upload originals/readable text/reports
through K1/K2 APIs, print counts/checksums and let the owner compare. Reauthorise external connections. Only after owner
acceptance remove old applications, packages, crates, migrations and Cloudflare resources in a dedicated PR.

| Legacy material | Import target |
|---|---|
| projects and memberships | projects + `project_source` |
| original file captures | Library originals |
| normalized `content.md` | revision with `owner_markdown` converter |
| artifact/wiki revisions | report/wiki pages, preserving proposal state |
| completed research outputs | report pages when output exists |
| chats | none: legacy did not retain a usable transcript |
| agent grants/connections/backups | do not copy blindly; reauthorise or separately archive |
