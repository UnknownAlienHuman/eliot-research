# Eliot Research — Delivery map

This is the executable work order. It splits [ARCHITECTURE](ARCHITECTURE.md) into owner-usable contours.
[IMPLEMENTATION](IMPLEMENTATION.md) supplies exact contracts, [DONORS](DONORS.md) limits reuse, and [`eval/`](../eval/README.md)
contains fixed acceptance material.

## How a contour is executed

1. Read ARCHITECTURE, the active contour below, and only the IMPLEMENTATION sections named by that contour.
2. Build only **Build**. Anything under **Not now** waits even when a later section already describes it.
3. Exercise the real Worker/API/Agent/MCP path on fixed material. A mock is not contour acceptance.
4. Open one PR per contour or independently usable slice. One manager owns its branch/worktree and shared files.
5. Report owner-visible capability, hard gates, latency/cost measurements, new non-test lines, donor pins and anything not
   run. Do not claim the contour complete while a caller, durable result or reader is missing.

### Acceptance classes

- **Hard functional gate:** auth, state, provenance, citation validity, data integrity and owner journey. Failure blocks.
- **Hard quality gate:** expected facts, conditions, strict comparison semantics and required abstention. Failure blocks.
- **Measured budget:** latency, tokens and estimated cost. Establish p50/p95 with real runs; promote a target to a hard
  regression gate only after three comparable runs. An explicit catastrophic ceiling may block immediately.
- **Platform spike:** tests an uncertain Cloudflare contract before product architecture depends on it. Failure selects
  the documented fallback and blocks only that optional capability.

Focused unit tests cover silent deterministic failures: URL guard, UTF-8 ranges, block/page mapping, label/quote
resolution, atomic cost admission, usage normalization and Access validation. Add regression tests for observed bugs, not
hypothetical state-space ceremony. Product behaviour is accepted by the contour eval.

Code budgets count new non-test lines under replacement `src/`; moved UI is reported separately. They are ceilings, not
quotas.

## Current state — 2026-10-25

- `main` contains one root pnpm package, Vite/Worker build and a placeholder React client from PR #415.
- `src/worker.ts` serves `/api/health`; no Access, D1, R2, Durable Object, Workflow, model or AI Search binding is live.
- Migrations in this documentation have not been remotely applied and may still be corrected before K1 begins.
- Legacy `apps/`, `packages/`, `crates/` and `infra/` are donor/import evidence, not implementation instructions.
- The accepted Material interface remains in `packages/ui/src/**` and `apps/eliotr-web/src/app/Shell.tsx`.
- The canonical implementation route is this document plus ARCHITECTURE, IMPLEMENTATION, DONORS and `eval/`; merged PR
  numbers are history, not authority.

## Contour overview

| # | Owner capability | Depends on | Schema | Primary paid effect | New-code ceiling |
|---|---|---|---|---|---:|
| K0 | Protected Material shell | — | — | none | 700 |
| K1 | Projects, immutable ingest and exact reader | K0 | `0001_library.sql` | none | 1,700 |
| K2 | Cited resumable chat and saved answers | K1 | `0002_ask.sql` | one bounded answer call | 1,700 |
| K3 | One-time source understanding | K2 | `0003_distill.sql` | two bounded calls/new revision | 1,300 |
| K4 | External agents over MCP | K3 | `0004_agents.sql` | none inside Eliot | 900 |
| K5 | Optional large-library passage search | K3 | `0005_search.sql` | AI Search after gate | 900 |
| K6 | Project map and strict comparisons | K3; K5 optional | `0006_project.sql` | one bounded incremental synthesis | 1,300 |
| K7 | Bounded deep research | K6 | `0007_jobs.sql` | explicit aggregate job budget | 1,400 |
| K8 | Named outgoing tools/tasks | K7 + concrete need | by need | owner-approved only | by need |
| K9 | Lifecycle and portable export | K6 | none unless proven | none in ordinary use | 700 |
| K10 | Legacy import and retirement | K9 | script | one-off import | script |

K4 may proceed after K3. K5 is optional: K6 proceeds on whole/claim retrieval when its eval passes.

---

## K0 — Protected shell

**Read:** IMPLEMENTATION §§1–2, §14.

**Owner outcome.** `research.<domain>` is protected by Cloudflare Access and displays the accepted Material frame on
phone and desktop. `/api/me` shows the server-derived actor.

**Build**

1. Move the Worker entry to `src/index.ts`; add Hono, `jose`, generated Wrangler binding types and the common API error.
2. Configure a hostname Access application. Verify JWT signature, issuer, audience and expiry in the Worker; derive the
   owner actor and overwrite any client-supplied internal identity header.
3. Move the accepted tokens, primitives, Material Symbols component and shell. Do not copy old query/runtime/preview
   infrastructure.
4. Keep Projects and Settings as honest empty placeholders. Add lint/typecheck/build plus focused auth/security tests.
5. Record repeatable custom-domain/Access setup commands without embedding secrets.

**Hard acceptance**

- Interactive owner login and one owner service token both resolve to `owner`.
- Missing, malformed, expired, wrong-issuer and wrong-audience assertions fail closed.
- Browser mutation from a foreign Origin fails.
- 1440 px and 390 px light/dark screenshots preserve the accepted frame, keyboard focus and touch targets.
- `pnpm check` and focused K0 tests pass.

**Not now.** Projects, D1/R2, chat, models, MCP, generic account system.

**Cost.** No model/search/browser operation.

---

## K1 — Read

**Read:** IMPLEMENTATION §§1, 3–6, §14.

**Owner outcome.** Create a project, select many files in one browser action, add URL/text, watch immutable conversion
state, and open original or canonical text with outline/page blocks and exact passage links.

**Build**

1. Apply `0001_library.sql`; bind D1, R2 and `IngestWorkflow`. K1 does **not** bind Workers AI.
2. Implement projects, shared Library sources, memberships and immutable revisions.
3. Browser batch UX sends one file/request, at most two requests concurrently. API cap: 25 MiB/file. URL and pasted text
   have separate JSON contracts.
4. Admission buffers one accepted body once, computes SHA-256, conditionally creates the exact R2 original, verifies
   size/hash readback, then commits source/revision/membership state. A uniqueness race returns the existing duplicate.
5. URL admission performs the guarded static fetch exactly once, stores requested/final URL, status, capture metadata and
   raw body, then starts conversion. `IngestWorkflow` never refetches.
6. Convert deterministically:
   - UTF-8 text/Markdown/CSV/code locally;
   - text PDFs with pinned `unpdf`, preserving per-page mapping;
   - HTML with deterministic `HTMLRewriter` extraction;
   - owner-supplied Markdown as a new revision.
   Unsupported Office files, standalone images and scans retain originals and become `needs_conversion`.
7. Write immutable `text.md` and `blocks.json`, then compare-and-set the source's readable revision. Reading never calls
   a model.
8. Move project/source/import/reader UI and replace legacy adapters with the new shared API.
9. Add URL/range/block/R2 create-once tests and `pnpm eval k1`.

**Hard acceptance — `pnpm eval k1`**

- Ingest the ten `eval/arxiv-10` PDFs and the Russian corpus with client concurrency two.
- Every text PDF is readable or readable-with-warnings; expected papers yield at least 20 KiB and 50 blocks.
- Requested/final URL and raw-capture SHA survive one redirect fixture; the origin is hit exactly once.
- Three random ranges/source exactly equal UTF-8 slices of the downloaded canonical text.
- Duplicate concurrent upload creates one revision and reports Attach/duplicate to the loser.
- A scan remains `needs_conversion`; no generated image description enters canonical evidence.
- Owner opens original, canonical text, page block and copied exact range on phone.

**Measured budget.** Report peak isolate memory for the 25 MiB case, conversion wall time and original/canonical bytes.
Model/search/browser calls must remain zero.

**Not now.** OCR, Office conversion, Browser Run, claims, answering, direct-to-R2 multipart upload above 25 MiB.

---

## K2 — Ask

**Read:** IMPLEMENTATION §§1–3, 6–8, §14, §16.

**Owner outcome.** Select sources, ask in Russian or English, receive a resumable streamed answer with exact clickable
citations, Stop, reopen history and save the answer as a versioned page.

**Build**

1. Apply `0002_ask.sql`; bind Workers AI and one SQLite Durable Object class `ChatAgent`.
2. Route authenticated requests through `routeAgentRequest`; canonical path is `/agents/chat-agent/:chatId`. Client uses
   `useAgent({ agent: "ChatAgent", name: chatId })` and `useAgentChat`.
3. Extend `AIChatAgent`. Use one `runTurn` from `onChatMessage` and the authenticated eval RPC. Select
   `messageConcurrency = "drop"`: normal UI disables Send while streaming, and overlapping hostile/accidental submits
   cannot queue hidden paid turns. Leave `maxPersistedMessages` unset; model-context pruning is separate.
4. Before model dispatch, freeze readable revision UUIDs and atomically insert the turn plus a D1 budget reservation.
   Budget failure returns a visible assistant error without inference.
5. Build whole-source context only. When it does not fit, ask the owner to narrow scope; claims/search arrive later.
6. Persist per-turn input/output token limits and deadline. Use the pinned Cloudflare `createAI` provider and
   `streamText` with model/Gateway retries, fallbacks and response cache disabled; private prompt/response logging is off.
   Store normalized usage and settle cost exactly/conservatively.
7. Resolve labels server-side, persist citation objects, timings and terminal state; Stop preserves partial text. Closing a
   tab does not cancel. Retry creates a new retained turn.
8. Add chat/page/settings UI, saved answers, label/context/usage tests and `pnpm eval k2`.

**Hard acceptance — `pnpm eval k2`**

- Run C1–C4 and O1–O8 from `eval/arxiv-10/questions.md` in whole mode.
- Every completed source answer has at least one citation, `invalidLabels = 0`, and each range opens to exact bytes.
- C1–C4 contain expected values/conditions; O8 explicitly states that the corpus does not solve hallucinations.
- Two simultaneous reservation attempts near the monthly limit admit at most the one that fits.
- Reconnect during a live stream resumes without a second model call or a second turn row.
- Stop prevents continuation; explicit Retry creates a distinct request/turn/reservation.
- Eval reports route, normalized usage quality, token categories, reserved/settled cost and timing.

**Measured budget.** Record cold/warm p50/p95 first-token and total time. Initial target: warm p50 first token ≤10 s,
p95 total ≤40 s. A completed answer above 90 s is a catastrophic failure. Timing targets tighten only after three
comparable runs.

**Not now.** Claim/search mode, web, chat tools, regenerate, provider-key UI, automatic continuation/fallback.

---

## K3 — Distill

**Read:** IMPLEMENTATION §§3, 6–9, §16.

**Owner outcome.** Each readable revision receives one guide, verified claim set, digest and EN/RU glossary. Large
selections can answer from claims. Unchanged revisions are not silently re-distilled.

**Build**

1. Apply `0003_distill.sql`; bind `DistillWorkflow` and one scheduler trigger.
2. On K3 activation, reconcile/backfill every current readable revision with `distill_state = none`; future ingest queues
   on completion when auto-distill is enabled.
3. Scheduler admits oldest work only while concurrency and atomic monthly budget permit. Budget-blocked and too-large
   items become visible `paused_budget` and `paused_too_large` states.
4. Each attempt receives `distill-<revisionId>-a<N>`. A terminal instance is never restarted; explicit Retry creates a
   new `distill_run` and reservation.
5. First bounded call reads block-labelled canonical text and emits guide/questions/candidate claims. Code verifies
   quote bytes and numbers. Second call receives verified guide/claims only and emits digest/glossary.
6. Store per-attempt artifacts under an immutable R2 prefix. In one D1 transaction replace the accepted claims and
   advance `current_distill_run_id` only after artifacts exist.
7. Assemble project overview deterministically from source titles, guides and questions; no overview model call.
8. Add claim context mode, guide/claims UI, quote/number tests and `pnpm eval k3`.

**Hard acceptance — `pnpm eval k3`**

- All ten papers reach done or a documented partial state; a second run buys no call for unchanged done revisions.
- A revision ingested before K3 is discovered by reconciliation and distilled.
- Every stored quote is an exact canonical range. Unsupported or ambiguous numeric structure is cleared/dropped.
- Transformer, ResNet and LoRA anchors in `questions.md` are present with their conditions and opening citations.
- A failed attempt remains inspectable; Retry uses a new Workflow ID and accepted claims point only to the accepted run.
- Claim mode keeps C1–C4 correct and citations valid.

**Measured budget.** Report calls, token categories, reservation/settlement, kept/dropped reasons and wall time per run.
Claim count and drop percentage are diagnostics, not quality gates.

**Not now.** Cross-source comparisons, claim editor, recurring re-distillation.

---

## K4 — Agents in

**Read:** IMPLEMENTATION §§2–3, §6, §10.

**Owner outcome.** Claude Code, Codex or another MCP client reads Eliot through bounded shared tools and submits a page
proposal that the owner accepts or rejects.

**Build**

1. Apply `0004_agents.sql`; backfill and automatically maintain trigram FTS over accepted claims.
2. Implement product tools as `(env, actor, input) → compact Markdown`, with explicit cursor/output caps and full IDs.
3. Expose a fresh stateless MCP SDK v2 server/request through `createMcpHandler` at `POST /mcp` on
   `mcp.research.<domain>`. Validate exact Host/Origin policy and Access service-token actor before constructing tools.
4. Agents may list/read/search/get pages and propose; only owner accepts/rejects. No upload or arbitrary URL fetch tool.
5. Move proposals inbox and add `pnpm eval k4` using a real MCP client.

**Hard acceptance.** Every tool respects actor, project/source scope and output cap. A real client answers O2/O5 using
only Eliot tools, submits a proposal, owner accepts it, and all citations still resolve. A forged actor/header and an
unapproved service token fail.

**Cost.** Eliot performs no model call for external-agent requests; the MCP client brings its own model. D1/R2/FTS only.

**Not now.** Per-agent project ACLs, task marketplace, outgoing MCP, large upload through MCP.

---

## K5 — Optional library scale

**Read:** IMPLEMENTATION §§3, 6–7, 10–11, §16.

**Owner outcome.** A scope too large for whole/claim mode can retrieve exact relevant passages. Identifier/number queries
use full-text retrieval; semantic questions use measured hybrid retrieval.

### Activation gate

Before product code depends on AI Search, run one real-instance spike and publish:

1. chunk offsets map exactly to uploaded canonical UTF-8 bytes;
2. metadata filtering enforces an intended scope of 500 revision UUIDs without leakage;
3. Russian `porter` versus `trigram` keyword quality;
4. installed binding behaviour for upload/poll/list/delete and duplicate keys;
5. `library-200` quality/latency gain over claims/FTS;
6. forecasted Eliot-owned ingestion/storage/query use under current included allocation.

Failure of offset, filter or quality gates blocks K5. Keep whole/claims/FTS and ask for a narrower scope; do not create a
private Vectorize stack.

**Build after the gate**

1. Apply `0005_search.sql`; create one explicitly configured built-in-storage hybrid instance and direct instance
   binding. Do not inherit platform defaults.
2. On activation, reconcile/backfill every current readable revision. Index only current revisions and exact canonical
   bytes; unchanged content/profile is not re-uploaded.
3. Each indexing attempt uses a new Workflow ID. Persist item key/ID and chunk→canonical range map. Publish replacement
   ready state before deleting the old projection item.
4. Freeze scope before query and filter before ranking. Empty scope makes no call. Hydrate every hit to canonical blocks.
5. Keep query rewrite, reranking and similarity cache off until an eval proves a gain. Fail locally to claims/narrower
   scope without widening or hidden query fan-out.
6. Enforce Eliot-local monthly caps below the included tier; excess is disabled until owner explicitly budgets it.

**Hard acceptance — `pnpm eval k5`.** At least 9/10 `library-200` needles cite the expected paper/section; no filter
leakage; `invalidLabels = 0`; K2/K3 remain correct. A pre-K5 readable revision is indexed by reconciliation.

**Measured budget.** Report index bytes/tokens, semantic/full-text counts, fallback count and p50/p95 query latency.

**Not now.** Per-project instances, public Search/Chat/MCP endpoints, AI Search generation, custom vector store.

---

## K6 — Project knowledge

**Read:** IMPLEMENTATION §§3, 7, 12–13.

**Owner outcome.** A living project map shows topics, strict comparable-result tables, disagreement candidates, gaps and
reading routes. Source changes stale only dependent pages.

**Build**

1. Apply `0006_project.sql`; bind `ProjectKnowledgeWorkflow`.
2. Build sorted current input revision IDs and an input hash. Unchanged successful input reuses the current map. Explicit
   Retry/new input uses `project-<projectId>-<inputHash>-a<N>`.
3. Parse numeric values/units and form comparison candidates in code. Compatibility requires normalized subject/task
   family, metric, dataset identity, split, protocol, unit and direction. Unknown/ambiguous fields remain separate.
4. A bounded model call may label topics, gaps and reading routes from compact guides/claims. It may propose aliases but
   cannot merge comparison groups or override deterministic incompatibility.
5. Disagreement candidates exist only inside compatible groups and display exact quotes/conditions from both sources.
6. Write a versioned map page plus structured `data.json`, full input IDs and citations. Refresh writes a new revision;
   Wiki pages are generated only on request.
7. Add `pnpm eval k6`.

**Hard acceptance.** All readable sources appear in topics; at least three genuinely compatible multi-source result
groups exist; deliberately incompatible unit/dataset/protocol fixtures remain separate. Replacing one paper stales
exactly pages that list its old revision. O1–O5 are answerable from the map with inspectable evidence.

**Cost.** Incremental. Unchanged input buys no call; deterministic comparisons buy none.

**Not now.** Graph database, centrality, automatic Wiki for every topic, model-decided result equivalence.

---

## K7 — Deep research

**Read:** IMPLEMENTATION §§3–5, 7, 10, 13, §16.

**Owner outcome.** Start a Library-first investigation with explicit limits, inspect progress/cost, Stop, and receive a
cited final or partial report. Web pages are captured before citation.

**Build**

1. Apply `0007_jobs.sql`; bind `ResearchWorkflow`, Web Search through Workers AI/AI Gateway, and Browser Run only for
   explicit rendered capture.
2. At job creation freeze scope, validate limits/deadline, estimate the entire upper bound and atomically reserve it.
3. Store a validated `ResearchPlan.v1`. Each iteration emits one validated `ResearchAction.v1`: Library tool call,
   `web_search`, `capture_url`, or final text. Invalid/over-limit action stops visibly.
4. Search/read Library first. Default web provider is Ceramic; provider choice and exact per-query price are dated.
5. Web results are leads. Static capture through K1 is first. Browser Run is allowed only after static capture is
   demonstrably unsuitable and remaining browser seconds/captures/budget permit. Rendered HTML is stored, then
   deterministic HTML extraction creates a revision.
6. Check Stop/deadline/remaining counters before every external call. Persist each planned/dispatched/result call and
   the job evidence revisions in D1. Paid model/Web Search/Browser steps have no automatic retry. Persist monotonic
   progress and partial Markdown after each completed iteration.
7. Final synthesis cites only the job evidence revisions; save final/partial report with all input UUIDs and settle the
   aggregate reservation.
8. Add `pnpm eval k7`.

**Hard acceptance.** Two web-required questions produce valid reports with at least five captured sources inside every
configured limit. Search-result URLs not captured cannot appear as citations. Static fixtures buy no browser time.
Stop prevents the next external call and leaves a readable partial result. A crash/retry does not duplicate a paid call
or restart the terminal Workflow.

**Not now.** Autonomous recurring research, invisible limit expansion, uncaptured web citations, unrestricted browser
agent, Search-provider fallback.

---

## K8 — Named outgoing tools and tasks

Write this contour only after a concrete remote MCP server or connected-agent task exists. Start read-only. Every remote
mutation requires owner approval and preserves the remote system's idempotency identity. Task offers are ordinary
records accepted by one connected agent and completed with a proposal. Do not build a marketplace or generic
orchestration platform.

## K9 — Lifecycle and export

**Owner outcome.** Detach, archive, delete with impact preview, and download a portable verified export.

1. Detach removes only project membership. Archive hides from new selection. Delete marks hidden immediately after
   impact preview, retains citation identity and removes R2/projection objects synchronously or by bounded cleanup.
2. Replacement/deletion marks dependent pages stale from full revision IDs; citations never retarget.
3. Stream a ZIP with originals, capture metadata, canonical text/block maps, claims, pages/citations and a checksum
   manifest. Avoid buffering the archive in Worker memory.
4. Acceptance deletes one eval source, proves current retrieval exclusion and old citation identity, then verifies every
   export manifest digest after extraction.

## K10 — Legacy import and retirement

One idempotent import script, not a migration framework: read the pinned legacy stores, send useful originals/canonical
text/reports through K1/K2 contracts, print stable IDs/counts/checksums and let the owner compare. Reauthorise external
connections. Only after owner acceptance may a dedicated PR remove legacy applications, packages, crates, migrations
and Cloudflare resources.

| Legacy material | Import target |
|---|---|
| projects and memberships | projects + `project_source` |
| original file captures | Library originals with provenance |
| normalized `content.md` | revision using `owner_markdown` converter |
| artifact/Wiki revisions | report/Wiki pages preserving proposal state where meaningful |
| completed research output | report pages when a real output exists |
| legacy chats | only through a separately verified transcript adapter; otherwise export/archive, do not invent history |
| grants/connections/backups | never copy blindly; reauthorise or separately archive |
