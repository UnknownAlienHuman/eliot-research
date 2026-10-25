# Eliot Research — Delivery map

This is the work plan. It splits the product from [ARCHITECTURE](ARCHITECTURE.md) into **contours**: small end-to-end
capabilities that the owner can use and judge on real material. [IMPLEMENTATION](IMPLEMENTATION.md) holds the technical
contracts each contour refers to; [DONORS](DONORS.md) names what to reuse; [`eval/`](../eval/README.md) holds the fixed
material every acceptance runs on.

## How to work a contour

1. Read ARCHITECTURE, the contour below and only the IMPLEMENTATION sections it lists.
2. Build exactly the items under **Build**. Anything listed under **Out of scope** — and anything not listed — waits for
   its own contour, even if IMPLEMENTATION already describes it.
3. Run the contour's acceptance against a deployed or local system and show the result to the owner.
4. Open a PR per contour (or per clearly separable step of one). The PR body states what the owner can do now, the
   acceptance output, new lines of code against the budget, and what was deferred.

A contour is **done** when its acceptance passes, the owner has seen it work, every new file/table/route has a caller,
and the code budget holds or the PR explains why not. The next contour starts after that — not before, and not later
"when everything is ready".

**Testing policy.** Each contour has one acceptance script (`pnpm eval <contour>`) that drives the real system through
its API on the fixed material in `eval/`. Unit tests exist only for pure functions whose mistakes are silent: UTF-8
ranges, block scanning, citation-label mapping, quote verification, the URL guard, context budgeting, Access checks. A regression test
is added only for a bug that actually happened. No tests or mocks for capabilities that cannot work yet.

**Budgets** count new non-test lines in `src/`, excluding UI moved from `packages/ui` and `apps/eliotr-web`. They are
limits for judgement, not targets: a contour that needs far fewer lines should use far fewer. Count with
`git diff -M --numstat origin/main...HEAD -- src ':(exclude)src/web/ui' ':(exclude)**/*.test.ts'` (sum of the first
column; moved files appear as renames and count only their edits).

## Current state (2026-10-24)

- Root package, Vite + Worker shell and CI switch are merged (PR #415): `src/worker.ts` serves `/api/health`,
  `src/client/` renders a placeholder page with an unrelated dark stylesheet.
- No D1, R2, AI, AI Search, Durable Object or Workflow binding exists yet. `wrangler.jsonc` routes only `/api/*` and
  `/mcp` to the Worker.
- Legacy code in `apps/`, `packages/`, `crates/`, `infra/` is donor and data-migration material only. Its README files
  are not instructions.
- The accepted Material interface lives in `packages/ui/src/**` and `apps/eliotr-web/src/app/Shell.tsx` + `shell.css`.

## Overview

| # | Contour | What the owner gets | Needs | Budget |
|---|---|---|---|---|
| K0 | Shell | Protected site with the familiar Material frame, light/dark, phone | — | 600 |
| K1 | Read | Projects; batch upload of files, URLs and text; readable text with outline; reader that opens any passage | K0 | 1,500 |
| K2 | Ask | Questions over selected sources; streamed answer with clickable exact citations; saved answers; chat history | K1 | 1,500 |
| K3 | Distill | Automatic per-source guide, claim cards, digest and glossary; project overview with suggested questions; answers use them | K2 | 1,200 |
| K4 | Agents in | Claude Code / Codex use Eliot through MCP with the same tools; their pages arrive as proposals | K3 | 900 |
| K5 | Library scale | Questions over the whole library or large selections through AI Search; exact keyword mode; tools in chat | K3 | 900 |
| K6 | Project knowledge | Topic map, comparison table, disagreements, gaps, reading routes, Wiki pages; refresh only what changed | K5 | 1,200 |
| K7 | Deep research | Long investigation with library and web, captured web sources, progress, budget and Stop | K6 | 1,200 |
| K8 | Outgoing tools and tasks | Owner-approved remote MCP tools in chat and research; tasks offered to connected agents | K7 | by need |
| K9 | Lifecycle and export | Delete/detach/archive with visible impact; ZIP export of originals, texts, claims and pages | K6 | 600 |
| K10 | Legacy import | Old originals, readable texts and saved reports imported; legacy retired | K9 | script |

K4 and K5 may run in parallel after K3.

---

## K0 — Shell

**Owner outcome.** Opening `research.<domain>` shows the Material frame (top bar, navigation rail on wide screens,
bottom bar on phones, both colourful themes) behind Cloudflare Access. Nothing else yet.

**Why first.** Every later contour lands in this frame; the design must be moved before any screen is built, or the
placeholder stylesheet becomes the design by accident.

**Build**

1. `wrangler.jsonc` — set `"main": "src/index.ts"`, `workers_dev: false` and `preview_urls: false`; add the Worker
   variables `ACCESS_TEAM`, `ACCESS_AUD_UI`, `OWNER_EMAIL`, `UI_ORIGIN`, `OWNER_SERVICE_CLIENTS`. Data bindings arrive
   with K1, the chat binding with K2. IMPLEMENTATION §1.
2. Run `wrangler types` and commit the generated `worker-configuration.d.ts`; delete the hand-written `Env` in
   `src/worker.ts` and the ambient `@cloudflare/workers-types` reference.
3. Add `hono`, `jose` and `vitest`. Replace `src/worker.ts` with `src/index.ts`: a Hono app with `GET /api/health`
   and `GET /api/me`, errors in the `{ error: { code, message } }` shape, plus the ingress middleware in `src/auth.ts`
   (Access JWT check, owner/service-token actor, Origin rule, local-dev actor). IMPLEMENTATION §1–§2.
4. Rename `src/client/` to `src/web/`. `git mv` the design foundation from `packages/ui/src` into `src/web/ui/`:
   `tokens/` (theme and fonts), `primitives/`, the Material Symbols icon component, and `contrast.test.ts` (keep the
   contrast checks, drop its file-hash assertion). Do not move `*.stories.tsx`.
5. Rebuild the frame from `apps/eliotr-web/src/app/Shell.tsx` and `shell.css`: top app bar, navigation rail (wide) /
   bottom bar (phone) with the items **Projects** and **Settings**, and an empty content area for K0's two placeholder
   routes `/` and `/settings`. Drop Shell's imports of `LiveWorkspace`, `InboxPanel`, privacy and runtime modules and
   the inbox/connections items; project panes (Sources, Chat, Studio) come with K1/K2. Delete `src/client/styles.css`.
   Copy favicon, per-scheme `theme-color` and `noindex` meta from the legacy `apps/eliotr-web/index.html`.
   IMPLEMENTATION §13.
6. Tooling: add a `test` script (`vitest run`, include `src/**/*.test.ts`), point `vitest.config.ts` at `src/`, run
   `pnpm test` in `.github/workflows/fast-ci.yml`; fix `frontend-owner.yml` path filters to `src/web/**`. Delete the
   manual legacy `.github/workflows/ci.yml`; delete legacy scripts under `scripts/` that no remaining workflow or
   `package.json` script calls (check each with `rg`).
7. Unit tests for `src/auth.ts`: missing, malformed, expired and wrong-audience assertions → 403; owner email and an
   owner service token → `owner`; cookie request with a foreign `Origin` → 403 (reuse the cases in the legacy
   `packages/cloudflare-access/src/access.test.ts`).
8. One-time setup from IMPLEMENTATION §1: custom domain and the UI Access application.

**Acceptance**

- In a browser the deployed site asks for Access login, then `/api/me` returns `{ actor: "owner" }`; the same call
  with an owner service token returns `owner`; the auth unit tests pass.
- The PR attaches screenshots of the frame at 1440 px and 390 px in light and dark; the owner compares them with the
  legacy interface and checks there are no layout jumps.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` pass in CI. No `pnpm eval` yet.

**Out of scope.** Projects, data, models screen, chat, MCP.

**Donors.** Legacy `packages/ui`, `apps/eliotr-web/src/app/Shell.tsx`; `cloudflare/agents-starter` for Vite/Wrangler
layout (reference only).

---

## K1 — Read

**Owner outcome.** Create a project, drop a batch of PDFs/DOCX/HTML/Markdown files, paste a URL or text. Each source
shows its state (`pending` shown as "Converting", `readable`, `readable_with_warnings`, `needs_conversion`, `failed`)
and opens in a reader with an outline; any passage can be linked and reopened exactly.

**Why.** Everything else stands on retained readable text with stable byte offsets. Reading must work without models
and without search.

**Build**

1. Bindings `DB`, `BUCKET`, `AI` and workflow `INGEST` in `wrangler.jsonc`; apply `migrations/0001_library.sql`
   (`wrangler d1 migrations apply eliot --local`, then remote). IMPLEMENTATION §1, §3.
2. `src/library.ts` — projects (create, rename, archive, list), sources (add file/URL/text, attach/detach, enable,
   list with `sha256`), revisions (create on replace or reconvert).
3. `src/ingest.ts` + `IngestWorkflow` (`src/workflows/ingest.ts`, instance ID `ingest-<revision>`) — per revision:
   convert → write `text.md` → build `blocks.json` → set `readable_state` and `source.current_revision_id`.
   Conversion, limits and warning cases in IMPLEMENTATION §4; upload is one multipart request with several files, each
   file its own source.
4. `src/blocks.ts` — pure block scanner over `text.md`: headings, paragraphs, lists, tables, code fences, with exact
   UTF-8 byte ranges and heading path. Port the tested offset/heading helpers from
   `packages/retrieval/src/structural-projector.ts`; do not port its 32–64 KiB splitter. IMPLEMENTATION §5.
5. `src/read.ts` — outline, block list, exact range read (`R2.get` with `range`), whole text, original download.
6. API routes and payload types for K1 from IMPLEMENTATION §1 (`src/shared/api.ts`).
7. UI: `git mv` `packages/ui/src/features/sources/projects`, `.../import`, `.../document` into
   `src/web/ui/features/`; replace their `@eliotr/owner-api-client` and `src/query` imports with `src/shared/api.ts`
   types and hooks in `src/web/api.ts`; Projects home, Sources tab with multi-file drop and per-source state, reader
   with outline, highlighted range and copyable link; routes `/p/:projectId/sources` and `/p/:projectId/source/:sourceId`.
8. Unit tests: block scanner (Cyrillic, CRLF, BOM, fenced code, tables), range read helper, URL guard.
9. Eval harness: add `tsx` and the script `"eval": "tsx scripts/eval/run.ts"`; `scripts/eval/lib.ts` (HTTP client,
   upload, polling, table) and `scripts/eval/k1.ts`, as described in [`eval/README.md`](../eval/README.md).

**Acceptance — `pnpm eval k1`**

- Downloads the ten PDFs listed in `eval/arxiv-10/sources.json` and uploads them in one request to project `arxiv-10`
  (sources already present, matched by `sha256`, are reused); adds the Russian documents of `eval/ru/sources.json`,
  which this contour creates with 2–3 open-access (CC-BY) Russian papers and their URLs — the owner may replace them.
- Waits until all are settled; prints a table per source: state, converter, text bytes, block count, seconds, and the
  total text size of the corpus (needed for K2's whole-reading budget).
- Passes when all papers are `readable`/`readable_with_warnings`, each text has ≥ 20 KB and ≥ 50 blocks, and for three
  random blocks per source the range route returns exactly the bytes at that range of the whole text fetched once.
- Owner opens three passages from the reader and one copied link on a phone.

**Out of scope.** OCR for scans (they stay `needs_conversion`), metadata editing beyond title, search, models,
duplicates UI beyond the SHA-256 notice.

**Donors.** `packages/cloudflare-markdown/src/markdown-conversion.ts` (conversion call and result parsing, trimmed),
`packages/platform-cloudflare/src/r2.ts` (`putImmutable` idea only), `packages/cloudflare-evidence/src/content-store.ts`
(range read).

---

## K2 — Ask

**Owner outcome.** In a project, choose sources (or all), ask in Russian or English, watch the answer stream with
citations like `[S2:14]`; clicking a citation opens the exact passage. Answers can be saved as pages; chats reopen.

**Why.** This is the product's core loop and the place the old system failed (0 of 2 benchmark questions answered,
86–114 s per answer). It must beat that by a wide margin before anything is layered on top.

**Build**

1. `migrations/0002_ask.sql`; Durable Object binding `CHAT` (class `ChatAgent`) and `"/agents/*"` in
   `run_worker_first`. IMPLEMENTATION §1, §3.
2. `src/models.ts` — model routes and limits table (context, max output, tools, price note), calls through the AI SDK
   (`streamText`) with Workers AI or AI Gateway. Defaults from `settings`. IMPLEMENTATION §11.
3. `src/context.ts` — builds the answer context: when the selected texts fit the whole-reading budget, every selected
   text goes in whole, block-labelled; otherwise the turn stops with a clear message to narrow the selection (K3 adds
   claim mode, K5 search mode). IMPLEMENTATION §8.
4. `src/citations.ts` — label formats (turn aliases and the stored form), parsing of labels in model output,
   mapping to `{revision, block, start, end}`, removing and counting unknown labels. IMPLEMENTATION §5.
5. `src/chat.ts` — `ChatAgent` (`AIChatAgent`) with one `runTurn` used by the WebSocket stream and by the RPC method
   behind `POST /api/chats/:chatId/turns`; writes `chat_turn` before the model call, stores citations on the message,
   records tokens, citations, invalid labels and timings. Route `/agents/chat/:chatId` checks the chat in D1 first.
   IMPLEMENTATION §8.
6. `src/prompts/answer.md` — the answer instructions (IMPLEMENTATION §8 gives the required content).
7. Pages: save an answer as `page(kind='answer')` with citations rewritten to the stored form; Studio tab lists pages
   (read-only).
8. Minimal Models setting: choose the default answer model and a per-project override from the configured list (keys
   are Worker secrets / AI Gateway; no key entry UI yet).
9. UI: `git mv` `packages/ui/src/features/research/run` and `.../evidence` (imports replaced as in K1); composer with
   scope chips (project default / explicit / none), citation chips that open the reader, Save answer, chat list;
   routes `/p/:projectId/chat/:chatId?` and `/p/:projectId/studio`.
10. Unit tests: label parser and mapper (both forms), context budget arithmetic.
11. `scripts/eval/k2.ts`; convert `tests/golden-corpus` cases to the plain format in `eval/golden/` (see
    `eval/README.md`) and run them as a report-only extra.

**Acceptance — `pnpm eval k2`**

- Runs the twelve questions in `eval/arxiv-10/questions.md` (C1–C4, O1–O8) through `POST /api/chats/:chatId/turns`
  against project `arxiv-10` with all sources selected (whole-reading mode), one new chat per question, in file order:
  the first question measures a cold prompt, the rest a cached one.
- Prints per question: first-token time, total time, input/cached/output tokens, citations, invalid labels; and the
  golden-case report.
- Writes answers to `eval/out/k2-<date>.md` (git-ignored) next to the expected points and the NotebookLM baseline.
- The script passes (exit code 0) when every answer has `invalid_labels` = 0 and ≥ 1 citation, every cited range opens,
  C1–C4 contain the exact values from `questions.md`, the first question's first token ≤ 10 s and the others ≤ 4 s,
  and every answer completes ≤ 40 s.
- The contour is accepted when, in addition, the owner judges O1, O2, O3 and O8 at least as good as the NotebookLM
  answers recorded in `eval/arxiv-10/baseline.md` (all eight recorded questions correct, 10–40 s, honest O8).

**Out of scope.** Tools in chat, web, AI Search, claim mode, cross-project questions, regenerate, model key UI.

**Donors.** `cloudflare/agents` examples `resumable-stream-chat`, `context-overflow-recovery`; legacy
`apps/eliotr-web/src/app/ChatModelPicker.tsx`; `vercel/ai` citation mapping idea.

---

## K3 — Distill

**Owner outcome.** A few minutes after upload every readable source has a **guide** (what it is about, 3–5 suggested
questions), **claim cards** (methods, results with numbers and conditions, limitations, datasets — each with its exact
quote), a **digest** and an EN/RU **glossary**. The project opens with an automatic **overview** and suggested
questions. Answers over large selections use claim cards instead of failing.

**Why.** Models are cheap or free; understanding each document once and well is worth more than clever chunk search.
Claim cards are also the backbone of comparisons (K6) and agent work (K4).

**Build**

1. `DistillWorkflow` (`src/workflows/distill.ts`): `IngestWorkflow` marks a readable revision `queued`, the
   distillation cron starts it (step 2); read-and-extract call → quote verification → digest-and-glossary call → write R2 artifacts and D1 `claim` rows →
   set `distill_state`. Apply `migrations/0003_distill.sql`; workflow binding `DISTILL`. Contracts and prompts in
   IMPLEMENTATION §6, quote verification in §5.
2. Scheduler and rate limits: a cron trigger (`* * * * *`, `scheduled` handler) starts queued distillations while fewer
   than `DISTILL_CONCURRENCY` (default 2) run; model calls retry with the provider's `Retry-After` (IMPLEMENTATION §6).
3. Project overview: when the last queued distillation of a project finishes, regenerate `page(kind='overview')` from
   the source guides (one cheap call). Opening a project never starts model work.
4. `src/context.ts` gains **claim mode**: when whole reading does not fit, the context is the guides plus the claim
   cards of all selected sources (claims carry exact ranges, so citations stay exact). `chat_turn.context_mode`
   records which mode answered.
5. UI: reader side panel with guide and claims (quotes highlighted in text); Studio lists digests and the overview;
   suggested questions drop into the composer.
6. Unit tests: quote locator (exact, whitespace-normalised, Cyrillic, ambiguous repeats), number check.
7. `scripts/eval/k3.ts`.

**Acceptance — `pnpm eval k3`**

- Distils the ten papers; prints per paper (from `GET /api/revisions/:id/knowledge` and the distillation report):
  claims kept/dropped with reasons, result claims with numbers, input/output tokens, cost at the model's list price,
  seconds.
- Passes when all ten are `done`, each has ≥ 15 kept claims, dropped claims ≤ 20 %, every stored quote is found at its
  byte range (by construction, re-checked), and the overview lists all ten sources.
- Re-runs the K2 questions twice through the turns API — `mode: "claims"` and `mode: "whole"` — and prints both;
  claim mode must keep C1–C4 correct.
- Owner reads the digests of Transformer, ResNet and LoRA against the papers.

**Out of scope.** Cross-source comparison and topic map (K6), editing claims, re-distilling unchanged revisions.

**Donors.** PaperQA2 (score → summarise → abstain), Anthropic Contextual Retrieval (context prefix idea), NotebookLM
source guide — ideas only (DONORS).

---

## K4 — Agents in

**Owner outcome.** Claude Code or Codex connect to `mcp.research.<domain>` and work with the library through the same
tools Eliot's own chat uses. Anything they write arrives as a **proposed page** that the owner accepts or rejects in
Studio.

**Why.** Handing research to connected agents is the product's differentiator, and agents bring their own models.

**Build**

1. `migrations/0004_agents.sql` (`claim_fts`, backfilled); DistillWorkflow starts writing `claim_fts` rows.
2. `src/tools/` — the shared toolset from IMPLEMENTATION §7 as plain functions `(env, actor, input) → text`. Before K5,
   `search` is backed by `claim_fts` + guides; K5 swaps in AI Search behind the same signature.
3. `src/mcp.ts` — `createMcpHandler` (from `agents/mcp/server`) on the MCP hostname, stateless Streamable HTTP, registering those tools plus
   `propose_page` and `get_page`. IMPLEMENTATION §10.
4. Access application for the MCP hostname with service tokens; allowed client IDs in a Worker variable; actor
   `agent:<client-id>` recorded on page revisions. No agent table yet.
5. UI: proposals inbox in Studio (move `packages/ui/src/features/agents/DecisionInbox.tsx`), accept/reject.
6. `scripts/eval/k4.ts` — an MCP client calls every tool against `arxiv-10` and checks output size caps and formats.

**Acceptance**

- `pnpm eval k4` passes (all tools respond within caps, labels resolve).
- In Claude Code, the owner asks O2 and O5 "using only the eliot tools"; the agent reads, cites and proposes a page;
  the owner accepts it; every citation in the accepted page opens its passage.

**Out of scope.** Task offers and claims, per-agent project restrictions, paid Eliot jobs over MCP, outgoing tools.

**Donors.** `cloudflare/agents` examples `mcp-worker-authenticated`, `mcp-server`.

---

## K5 — Library scale

**Owner outcome.** Ask over the whole library or a large selection; Eliot finds the relevant papers and passages,
reads them and answers with exact citations. An exact-keyword mode finds identifiers and numbers. The chat can use
tools (search, read, claims) for a few steps.

**Build**

1. Spike first, one script, results recorded in IMPLEMENTATION §15: byte-offset base of `items.chunks()`; `$in` with
   500 revision IDs; Russian keyword behaviour with `porter` vs `trigram`. Choose settings from the results.
2. Setup: AI Search instance `library-v1` in the `default` namespace with the settings in IMPLEMENTATION §9; binding
   `SEARCH` (`ai_search`).
3. Migration `0005_search.sql`: `source_revision.search_item_id`, `search_state`.
4. `IngestWorkflow` uploads `text.md` as one item per revision with metadata, waits for indexing, stores the chunk map
   (`chunks()` → `source/<rev>/chunks.json`).
5. `search` tool backed by AI Search: frozen revision filter → chunks → byte ranges → snapped to blocks → labelled
   passages. Same signature as in K4.
6. `src/context.ts` gains **search mode**, and chat gets tools (`search`, `read`, `find_claims`) with a step cap.
   IMPLEMENTATION §8.
7. `eval/library-200/` — 200 arXiv IDs plus ten "needle" questions with the expected paper and section.

**Acceptance — `pnpm eval k5`**: ≥ 9/10 needles answered with the right paper cited; `invalid_labels` = 0; median first
token ≤ 6 s; the K2 script still passes.

**Out of scope.** Per-project instances, reranking, AI Search generation or public endpoints.

**Donors.** `cloudflare/agents` example `context-overflow-recovery`; AI Search docs for filters and chunks.

---

## K6 — Project knowledge

**Owner outcome.** Each project has a living **map**: topics with their sources and claims, a **comparison table**
built from claims with matching task/metric, **disagreements** to review, **gaps**, and **reading routes**; Wiki pages
per topic on request. When a source is replaced or removed, only pages that cite it turn stale; Refresh makes a new
revision.

**Build**

1. `ProjectKnowledgeWorkflow` (binding `PROJECT_KNOWLEDGE`), started after the last distillation of a batch and on
   Refresh — topic assignment per new source (guide + claims), comparison rows by code from claim
   keys, disagreement check only inside a key group, gap questions from perspectives. Output: `page(kind='map')` with
   `body.md` and `data.json`. IMPLEMENTATION §12.
2. Wiki page per topic on request (`POST /api/projects/:projectId/wiki`); stale marking from `page_revision.inputs_json`; Refresh creates a new revision
   (proposal when an agent asks).
3. UI: move `packages/ui/src/features/studio` and `.../research/report`; map view (list/tree), comparison table,
   disagreement list with links to both quotes.

**Acceptance — `pnpm eval k6`** on `arxiv-10`. Script: ≥ 5 topics and every source in at least one; ≥ 3 comparison
groups with values from ≥ 2 sources; after replacing one paper, exactly the pages whose `inputs_json` contain its old
revision are `stale`. Owner: the topics cover residual connections, normalisation, optimisation, attention/positional
encoding, scaling, efficient fine-tuning and vision transfer, and O1–O5 can be answered from the map.

**Out of scope.** Graph database, centrality, automatic Wiki for every topic.

**Donors.** STORM perspectives, GraphRAG summary-level reduce, Karpathy LLM-wiki index/log/lint — ideas (DONORS).

---

## K7 — Deep research

**Owner outcome.** Start an investigation with a question, budget and optional web; watch progress; Stop any time;
receive a cited report saved as a page, with web sources captured into the Library before they are cited.

**Build**

1. Migration `0006_jobs.sql`: `job` (project, question, model, state `queued|running|done|failed|cancelled`, limits,
   usage, progress, result page, timestamps). IMPLEMENTATION §10.
2. `ResearchWorkflow` (binding `RESEARCH`) — bounded loop (plan → search/read/claims → web search → capture → synthesize) over the shared
   toolset; web tools from the Agents SDK; capture through `IngestWorkflow`; progress written to the job row.
   Rendered pages use Browser Run through a new `BROWSER` binding (converter `browser_markdown`, IMPLEMENTATION §4).
3. UI: job list and detail with progress, partial findings and Stop.

**Acceptance — `pnpm eval k7`**: two questions that need the web (e.g. LoRA variants since 2023 versus the LoRA paper's
claims) produce reports with ≥ 5 captured sources and valid citations within the budget; Stop ends the job within one
step.

**Donors.** `dzhng/deep-research` (loop, MIT), `G4brym/workers-research` (`src/workflows.ts`, MIT), `cloudflare/agents`
examples `web-research`, `workflows`.

---

## K8 — Outgoing tools and agent tasks

Start only when a concrete need exists (a remote MCP server the owner wants in chat, or a task to hand to an agent).
Then: owner-approved remote MCP connections through the Agents SDK MCP client; read-only tools first; mutating tools
need the owner's approval per call; tasks as simple offers an agent can accept and answer with a proposed page.
Write the contour here before building it.

## K9 — Lifecycle and export

1. Delete from Library: preview affected projects/pages, hide immediately (`state`, `deleted_at`), remove R2 objects and
   the AI Search item in the request or a daily cron sweep; old citations show "deleted".
2. Detach and archive without deleting the shared source.
3. Export: ZIP of originals, `text.md`, claims (JSON), pages (Markdown + citations) and a manifest, streamed from R2.

**Acceptance:** delete a paper from `arxiv-10` → its pages turn stale, citations show deleted, search no longer returns
it; export of the project opens and contains every file listed.

## K10 — Legacy import and retirement

A one-off script, not a framework: read legacy stores (table below), copy originals, readable texts and saved reports
through the K1/K2 APIs into new projects, print counts and checksums, let the owner compare. Re-authorise any external
connection. After the owner accepts, remove `apps/`, `packages/`, `crates/`, legacy `infra/` migrations and old
Cloudflare resources in one PR.

| Legacy data | Where it lives (pinned [`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7)) | Import as |
|---|---|---|
| Projects and memberships | `project`, `project_source_membership` (`packages/cloudflare-navigation/src/project-owner-service.ts`) | projects + `project_source` |
| Original files | `raw_file_capture.object_key` (`packages/cloudflare-raw-ingest/src/raw-ingest.ts`); `source_revision.original_r2_key` may be NULL | source originals |
| Readable text | normalized bundle `content.md` (`packages/cloudflare-evidence/src/content-store.ts`, `packages/platform-cloudflare/src/ingest-promotion.ts`) | revisions with `owner_markdown` converter |
| Saved reports | `artifact_revision`/`artifact_head` + section objects (`packages/cloudflare-artifacts/src/artifact-draft-read-service.ts`) | `page(kind='report')` |
| Wiki | `wiki_publication_*` and older `wiki_revision`/`wiki_head` (`packages/cloudflare-wiki/src/wiki-publication-store.ts`) | `page(kind='wiki')`; proposals stay proposals |
| Research questions and outputs | `research_workflow_run`/checkpoint refs in `WORK_BUCKET` (`packages/cloudflare-research-runtime/src/research-session-application.ts`) | report pages where an output exists |
| Chats | none: the legacy session kept no transcript (`apps/eliotr-core/src/research-session.ts`) | nothing |
| Agent grants, Google connections, backups | `project_client_grant`, `google_exchange_connection`, `backup-parts/` | not imported; re-authorise if still needed |
