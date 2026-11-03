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
- K1 implements projects, the shared Library with immutable revisions, and exact UTF-8 reading (outline, whole text, ranges, original download). Exact text/URL duplicates return 409 with explicit Attach existing, reusing the stored revision with no silent merge. Ordinary conversion stays on the current path: native text locally, Workers AI `toMarkdown` where a document format requires it. Explicit PDF OCR has a verified bounded journey and one complete fifteen-page public-PDF preview/reviewed-Apply case; full-corpus OCR quality and deployed Access remain unverified. AI Search and later-contour bindings remain absent.
- K2 has a local Markdown chat path with frozen source scope, server-resolved citations, Stop/reconnect and storage-only Save, plus the R2 model snapshot with the owner-only refresh route. K2 and K3 are not fully accepted; their remaining quality and claim-mode gates stay open in their contour sections below.
- K4 is implemented in main. Its signed-agent read, proposal and owner-decision path is verified locally with test
  JWKS; deployed Access remains unverified. K6 is frozen until K2/K3 acceptance.
- The existing `eliotr-core.kleymor-metal.workers.dev` address is retained per owner decision; the replacement is not deployed over it.
- Legacy `apps/`, `packages/`, `crates/` and `infra/` are donor/import material, not implementation instructions.
- PR #417 is the authoritative replacement-documentation history and supersedes the stacked plan in PR #416.

### Active repair order

Rows 1-10 are accepted slices; rows 11-13 remain open or partial. Slice acceptance does not close K2/K3 semantic,
full-corpus or deployed gates. Implement one usable slice at a time and update its owning contract and row.

| Order | Problem and implementation owner | Closure |
|---|---|---|
| 1 · K2 | `context.ts` bounds assembly to 16 MiB of cumulative streamed-byte/allocation charges, including bounded source/claim metadata and reused block maps; see [IMPLEMENTATION §8](IMPLEMENTATION.md#8-ask-and-context). | Accepted in [#465](https://github.com/UnknownAlienHuman/eliot-research/pull/465), `d9f41495`. Memory repair only. |
| 2 · K2 | `chat.ts` preserves interrupted queued input as a visible, undispatched failed turn before clearing queue state, including the promotion gap; see [IMPLEMENTATION §8](IMPLEMENTATION.md#8-ask-and-context). | Accepted in [#466](https://github.com/UnknownAlienHuman/eliot-research/pull/466), `86f76f9f`. Restart, live-fault and readonly reconnect checks cover queue preservation. |
| 3 · K2 | `chat.ts` marks an unfinished D1 settlement on its owning DO turn, retains its active pointer and finds marked older turns through a bounded index; see [§8](IMPLEMENTATION.md#8-ask-and-context). | Accepted in [#467](https://github.com/UnknownAlienHuman/eliot-research/pull/467), `f7f644dc`. Terminal D1 mismatches remain visible; unmarked historical orphans are not backfilled. |
| 4 · K1 | `workflows/ingest.ts` retries only storage load/commit; `ingest-completion.ts` atomically publishes a retained result with guarded head and dependent freshness. Source reads reconcile the existing Workflow output; see [§4](IMPLEMENTATION.md#4-ingest-and-conversion). | Accepted in [#468](https://github.com/UnknownAlienHuman/eliot-research/pull/468), `a84dbbb4`. Conversion/store never retries, retained artifacts must match, and a newer readable head wins. |
| 5 · K1/K2/K4 | `pages.ts` Save and `proposals.ts` acceptance compute freshness from the complete immutable input set inside their guarded publication batch; see [§3](IMPLEMENTATION.md#3-data-and-immutable-writes). | Accepted in [#469](https://github.com/UnknownAlienHuman/eliot-research/pull/469), `e4d072aa`. Strict transactional SQLite and Workerd/D1/R2/browser checks cover old input/citation bytes and the replay/CAS winner. |
| 6 · K2 | `chat.ts` and `web/Chat.tsx` expose stable older-turn pages, merge versioned live/history payloads and bridge disjoint reconnect windows; see [§8](IMPLEMENTATION.md#8-ask-and-context). | Accepted in [#470](https://github.com/UnknownAlienHuman/eliot-research/pull/470), `f571c06c`. Queue/notice ordering and the visible-turn scroll anchor are verified; model history stays latest-50. |
| 7 · K2/K4 | `pages.ts` uses a scoped immutable value cursor; `StudioView` reads more pages and shows accessible freshness in list and selected detail; see [§13](IMPLEMENTATION.md#13-owner-interface). | Accepted in [#471](https://github.com/UnknownAlienHuman/eliot-research/pull/471), `cf6451ba`. Refresh retains and rereads selection outside the first 50; external eligibility changes require explicit Refresh. |
| 8 · K1/K2 | `web/Chat.tsx` scopes Send/Stop/Save continuations to their initiating view; `web/Library.tsx` scopes Reader reads and replacement, with pending project/source locks in `App`; see [§13](IMPLEMENTATION.md#13-owner-interface). | Accepted in [#472](https://github.com/UnknownAlienHuman/eliot-research/pull/472), `ceb840a0`. Desktop/phone checks cover project/Settings remounts and independent upload locks. Submitted writes retain their target. |
| 9 · K3 | `workflows/distill.ts` no longer requests or promotes un-attributed author/date guesses; see [§6](IMPLEMENTATION.md#6-one-time-distillation). | Accepted in [#473](https://github.com/UnknownAlienHuman/eliot-research/pull/473), `a8d5d215`. New metadata stays `''`/`NULL`; historical values/evidence remain unchanged. |
| 10 · K2/K3 | Exact retained NotebookLM export and sidecars are preserved in the owner's local archive; hash/access/completeness are recorded in the existing [baseline](../eval/arxiv-10/baseline.md). | Accepted in [#474](https://github.com/UnknownAlienHuman/eliot-research/pull/474), `fedd0406`. Second-checkout verification covers frozen `answers.md`/`runs.json` hashes, unique IDs, questions and all twelve retained answer bodies; sidecar equality was checked separately locally. Archive contents stay outside Git; another machine requires authorized private transfer. The citation probe remains incomplete; answer-text availability does not establish quality acceptance. |
| 11 · K2/K3 | Partially complete: pure post-stream usage projection was accepted in [#475](https://github.com/UnknownAlienHuman/eliot-research/pull/475), merged as `d718301c`. `ChatView` still combines UI lifecycles; its bounded decomposition in [§13](IMPLEMENTATION.md#13-owner-interface) remains open. | Accepted server extraction preserved admission, deadlines, citations, queue and settlement. Remaining UI work must preserve route changes, selection, Stop/reconnect/Save and account for added/removed code. |
| 12 · K2/K3 | Citation identity and numeric occurrence still do not establish source meaning or fact coverage. Finish the quality repairs below against unchanged questions and anchors. | K2 facts/citations/latency and owner comparison; K3 all-source reuse/anchors, semantic support for claims/guide/digest/glossary and real claim-mode C1–C4 pass their existing gates. Targeted runs cannot establish full acceptance. |
| 13 · K0/K4 | Deployed Access remains unverified. After an authorized deployment, check the existing owner/agent boundary and WebSocket path. | Owner browser/token work; invalid or wrong-audience JWTs fail; agents read/propose but cannot accept or invoke owner-only paid work. Local JWKS evidence alone cannot close this row. |

Automatic `fast-ci` covers lint/types/build and local native/MCP journeys. Its K2/K3 native modes do not close semantic,
full-corpus or deployed-Access gates. Legacy deletion remains K10, after accepted import; retained donor code is not
part of the active replacement runtime.


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

Dependencies are acceptance gates for further contour expansion. The existing K4 local slice landed against available
K3 read/claim contracts before K3 acceptance; retain it as an implemented-but-unaccepted exception and fix its defects
without treating K3 as accepted. Further K4 expansion and K6 work wait for K2/K3 acceptance. K5 is not a mandatory
prerequisite for K6 when whole/claim retrieval passes the project eval.

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
open any readable source with outline and exact passage links. Explicitly run PDF OCR with a selected model, review
its text preview, and Apply a new readable revision while retaining the original and old citation targets.

**Build**

1. Bind D1, R2, Workers AI and `IngestWorkflow`; apply `migrations/0001_library.sql`.
2. Implement projects, shared Library sources, project memberships and immutable revisions.
   Projects defaults to active rows; Show archived projects pages through archived rows and exposes the existing
   Unarchive action. Archive/restore keeps sources, history and saved evidence intact.
   Add sources exposes the existing Library in bounded pages and attaches a saved source without another upload,
   conversion or understanding call. Already attached sources are excluded; Refresh rescans Library changes.
3. Browser batch UX sends **one file per request**, with at most two uploads in flight. The API accepts one file up to
   25 MiB, never a 100 MiB buffered multipart batch. Text and URL have separate JSON routes/shapes. IMPLEMENTATION §4.
4. Hash, store original under an immutable R2 key, create pending rows and start deterministic
   `ingest-<revisionId>`. Exact duplicates are reported with Attach; never silently merged.
5. Convert native UTF-8 text locally. Use cached `env.AI.toMarkdown().supported()` only for document formats that
   require it. Ordinary ingest never invokes OCR; scans retain the original and show
   `needs_conversion`. Write canonical `text.md`, exact `blocks.json`, state/warnings and current readable revision.
   Flag unexpected non-printing text characters without rewriting evidence; older readable revisions show the same
   reader warning on load without mutating their metadata or starting conversion.
6. Implement outline, whole text, exact UTF-8 range and original download. Reading must not call a model.
7. Move the project/source/import/reader UI features and replace legacy adapters with `src/shared/api.ts` +
   `src/web/api.ts`. Show filenames, readable states and human revision labels; keep immutable IDs and exact ranges in
   links/API data, and conversion telemetry in eval output.
8. Add block/range/URL-guard tests and `pnpm eval k1`.
9. Add the owner-only PDF OCR path under `migrations/0010_source_ocr.sql` and IMPLEMENTATION §4: explicit
   create/upload/Start, serial pages with at most one call per page, selected model and bounded usage. Stop prevents
   the next call; no paid retry or automatic continuation. Preview/read/Apply are storage only. Apply creates a new
   immutable revision and marks dependent pages stale; ordinary ingest and source understanding remain separate.
   Use the latest live PDF revision as the OCR base, even at `needs_conversion`, and capture the current readable
   revision separately. Start/Apply require an unchanged latest base and the captured current revision.

**Hard acceptance — `pnpm eval k1`**

- Ingest the ten `eval/arxiv-10` PDFs and the Russian corpus with client concurrency 2.
- Ten arXiv and two text-based Russian PDFs settle as readable/readable-with-warnings; expected arXiv papers produce at
  least 20 KiB and 50 blocks. The additional Russian scan fixture must settle as `needs_conversion`, keep the exact
  original and perform no OCR. The native Russian text fixture must make zero conversion calls.
- Three random ranges per source exactly match slices of the downloaded whole text.
- The native Markdown browser fixture keeps an unambiguous table caption and its rows in one bounded stored block;
  opening its exact range shows both caption and rows, and the old range survives replacement.
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

**Explicit PDF OCR acceptance — bounded local journey verified.** `pnpm eval k1 --ocr` retained a real-service
upload/Start/idempotence PASS prefix with one call, then failed at the preview UI label. After the label fix, GET-only
reopen matched the stored preview. Explicit `--resume-job=<UUID>` continued that ready job through storage-only
preview/Apply/repeat-Apply and old-citation checks with no additional inference for it; the retained prefix was not
replayed or regraded as a fresh complete run. A separate two-page cancellation fixture stopped after one call and one
completed page. Final dependency comparison passed: one affected page stale, one unrelated page current, unchanged
page heads/body/citations and exact old range bytes. Across both jobs there were two observed inference calls;
the admitted ceiling was three (one apply page plus two cancellation-fixture pages). Usage and retained artifacts
are in IMPLEMENTATION §4. An additional original fifteen-page Transformer PDF completed on GLM with fifteen calls;
reviewed corrections were applied as one new readable revision, repeated Apply added no revision or call, and old
canonical/range/original bytes were preserved. Full-corpus OCR quality, deployed Access and owner semantic acceptance
remain unverified; K2/K3 remain unaccepted. Monetary cost is unknown and latency regression budgets are unestablished.

**Not now.** Automatic OCR, search, claims, model answer, bulk direct-to-R2 uploads above 25 MiB.

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
   The project header opens a paged active-project picker with Refresh/Retry; switching opens that project's chat
   without creating a chat or sending a question. Switching to another project confirms discarding a nonblank draft;
   cancelling or closing the picker preserves the current draft and source scope.
   History and New chat also confirm before discarding a nonblank draft; cancellation preserves the current chat and scope.
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
Missing citation/numeric-support spans remain API/eval diagnostics without frames in the owner answer. They do not
change stream state. A completed generation can
still fail the quality gate; diagnostics do not waive citation, expected-fact or owner-review requirements.
The composer remains visible while reading long answers. Citation details retain exact passage links; runtime counters
and internal processing terminology stay in API/eval output rather than the owner reading interface.
Provider data-policy rejection shows a safe reason and leaves the chosen model and policy unchanged.
Model selection applies to the next Send, and each stored answer names the model that produced it. A new chat in an
empty project can Send; it must not wait for a source to exist. Choosing a provider or model starts no inference.
Sources, Chat and Studio share one project screen on desktop and use three bottom destinations on phone. Source
selection stays in the source pane; Add, history and project settings do not fill the conversation with forms.

**Hard acceptance — `pnpm eval k2`**

Any failed or missing hard-check row exits 1 even when owner review is also pending. Exit 2 is reserved for an otherwise
hard-passing comparison awaiting owner review; advisory counters do not change this classification.

`pnpm eval k2 --journey-only` exercises the phone Stop/reconnect/Save path separately from the fixed twelve-question
benchmark. It reads `ELIOT_EVAL_PROJECT` and an existing calibrated C3 chat in `ELIOT_EVAL_CHAT`; model work requires
`ELIOT_K2_MODEL=1`. The run creates at most one empty-scope control turn on the frozen global model, stops after
visible text, reopens the stored result, and saves the existing C3 once with an idempotent repeat and exact reader
links. A completed-before-Stop or cancelled-before-text outcome remains `NOT_RUN` for streamed Stop coverage.

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
twelve-question benchmark uses the tracked [baseline summary](../eval/arxiv-10/baseline.md). Full NotebookLM answers
were retained under the git-ignored `eval/out/notebooklm-20261026/answers.md`; they are absent from a fresh checkout.
See [evidence availability](../eval/README.md#comparison-evidence) for recovery and the summary fallback. Comparison
results belong in the PR and do not replace these gates. Neither K2 nor K3 is deployed.

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
   an extra overview model call. Open it from Studio, load sources in bounded pages and Refresh to rescan changed
   membership/heads. Each row opens the immutable revision whose summary was shown.
6. Add claim context mode. Preserve whole originals where the shared budget permits; compress eligible sources only
   as needed, retaining the complete frozen scope and aliases. The same answer prompt and citation resolver are used.
7. Add reader guide/claims UI, quote cases and `pnpm eval k3`. Reader metadata shows availability and verification
   caveats; quote links retain exact identities without displaying UUIDs or call/token/time/reservation counters.
   Stored questions in the overview and current Reader prepare an editable chat draft with only that source visibly
   selected. Replacing an existing draft requires confirmation; historical Reader questions remain read-only.
   API progress retains the admitted job bound independently of later model-default or catalogue changes.
   A successful Understand or Save refreshes the workspace source badge without reloading the document or resetting
   loaded pages or source selection; list/progress reads perform no inference.
   If the following status read fails, the accepted request remains visible and Reload understanding retries only
   the read. A lost, non-2xx or unreadable POST reply leaves its outcome unknown and blocks Understand/Save until a
   successful status read; a returned `none` only enables a later explicit request. Mounting always refreshes status.

**Hard acceptance — `pnpm eval k3`**

- Before model work, verify the exact ten baseline source/revision identities and original/canonical bytes, the
  separate twelve-source overflow scope, its already-understood extras and its prepared claim chat. Missing or
  ambiguous inputs stop the run before any paid call; duplicate stored answers are never silently reused. Check the
  extras' own recorded call counts separately. An admission or unfinished/failed answer stops later eval submissions;
  completed answers that fail a quality check remain failed checks while the remaining fixed controls may run.
  Already accepted jobs retain their results; queued revisions keep their stored model selection.
- All ten papers reach `done` or a documented `partial` state; a second eval run performs no re-distillation of unchanged revisions.
  `pnpm eval k3 --unchanged-only` preflights all ten terminal revisions, submits each exact revision ID once and compares
  the stored reports, claims, call counts and usage. This reuse check does not waive the semantic or claim-mode gates.
- Every stored quote is an exact byte range; numeric result fields are cleared when not supported by their quote.
  Parsed numeric fields use the same literal interpretation as quote verification; source spelling stays unchanged.
- Claim statements retain non-whitespace text after declared reference annotations are removed.
- Guide/digest/claims exclude known empty citation wrappers; glossary terms are nonblank. Ambiguous Markdown
  output is retained as `partial`; no full Markdown parser is added to the Worker.
- Numbers in statements and conditions must match complete numeric literals in that same quote, rather than
  borrowing digits from a decimal axis tick, another number or another excerpt. Units, metrics and conditions must
  also be supported by that quote; numeric occurrence alone does not pass the semantic quality gate.
- A result's `valueText` contains at most one numeric quantity. Compound lists are rejected rather than split or
  silently retained with `valueNumber=null`; scientific notation remains one quantity.
- Formatting preserves the selected statement's qualifiers and conditions. Missing structured numeric context rejects
  the card rather than rewriting it into a bare scalar; the primary numeric value must occur in the stored statement.
- Transformer, ResNet and LoRA anchor expectations in `eval/arxiv-10/questions.md` are present with correct conditions;
  no unsupported number is stored. Claim count and drop rate are reported, not quality gates.
- An anchor must be expressed by an EN/RU stored claim statement and supported by that same claim's exact quote; a matching
  phrase only inside a broad quote does not establish that the claim card contains the fact. Guides/digests are not
  anchor evidence.
- Claim mode keeps C1–C4 correct and citations valid; overview pages through every active readable project source
  without a model call. Tied timestamps, deleted cursor anchors, project isolation, Retry/Refresh and pinned Reader
  links pass `--overview-only` and `--overview-browser`; newly eligible earlier sources require Refresh.
- The automatic claims path is exercised in a separate real overflow project: reuse the ten baseline sources and
  attach the public papers in `eval/arxiv-10/overflow.json`. Measured source bytes must exceed the unchanged model
  whole-reading cap, and all four turns must report `contextMode=claims`. The baseline PDFs/questions remain unchanged;
  no forced mode, reduced model cap, repeated padding or K5 search infrastructure is used.
- Eval prints per-revision calls, known/unknown tokens, recorded token bounds, kept/dropped reasons and wall time.
  Recorded historical calls and observed calls since the run's preflight are separate totals; an unconfirmed request
  remains unknown until its accepted submission or terminal observation is known. Overflow uses the actual job output
  reserve within published capacity, rather than treating published output capacity as a reservation.

**Not now.** Cross-source topic map/comparison, claim editor, recurring re-distillation.

K3 is not fully accepted or deployed. The ten baseline papers reached `done`; the unchanged-revision check dispatched
no further inference. Required conditions for the French Transformer result and some LoRA anchors remain unresolved.
All four real overflow answers used `claims` mode; statement-local numeric and citation support gates remain open.
Semantic support for guide, digest and glossary
content remains separate from label and numeric validation. Storage-only Save/recheck does not dispatch inference
and does not qualify K3.

**Remaining quality repairs (proposed).** Diagnose each failure against its exact source revision: incorrect canonical
text, wrong/missing selected evidence, lost statement conditions, numeric-format rejection or unsupported prose.
A narrow supplementary-Unicode normalized-quote mapping repair is covered by synthetic regressions and storage-only
Save/GET/range replay (IMPLEMENTATION §5), accepted in [#476](https://github.com/UnknownAlienHuman/eliot-research/pull/476)
as `ec6ffbfa`. Current whole-block extraction takes exact matching; this is not evidence of
a repaired fresh-model/corpus failure and does not close the semantic, anchor, claim-mode or latency gates.
A separate first-call statement-reference repair applies the existing declared-label check before numeric verification
and preserves surviving claim order and original candidate indexes (IMPLEMENTATION §6). It has a synthetic whole-block/storage reproduction; no
inline annotations were found in the inspected retained corpus reports, so it does not close their coverage failures.
That repair was accepted in [#477](https://github.com/UnknownAlienHuman/eliot-research/pull/477) as `e57c9df0`.
The A3 GPU-memory evaluation gate requires complete recognized statement/quote forms; unmatched input is
`REVIEW_REQUIRED`, not a factual-failure verdict (IMPLEMENTATION §6). The actual retained 929-byte source block
requires review, so A3 acceptance remains open. [#478](https://github.com/UnknownAlienHuman/eliot-research/pull/478)
was accepted only as this guard (`96ee0d27`).
[#479](https://github.com/UnknownAlienHuman/eliot-research/pull/479) unified citation/distillation code ranges;
an unmatched backtick inside a fence cannot mask later prose references. Quote verification now reuses local canonical
bytes and folds only fallback slices; this reduces repeated work without changing evidence or quality gates.
Repair defective PDF text only through the existing reviewed OCR/immutable Apply path; preserve old bytes and citations.
For correct input, keep candidate statements atomic and complete, then review each against its own frozen evidence
within the existing two calls. Guide/digest/glossary prose needs the same semantic scrutiny; adding a third verifier,
paper-specific prompts or weakening anchors is not a remedy. Fix numeric-format regressions narrowly, without inferring
units or conditions. [#430](https://github.com/UnknownAlienHuman/eliot-research/pull/430),
[#454](https://github.com/UnknownAlienHuman/eliot-research/pull/454) and
[#459](https://github.com/UnknownAlienHuman/eliot-research/pull/459) are unaccepted attempts at the checked commit;
reuse only applicable changes after reading their failed observations. K6 stays frozen. Reusing stored output must not
regrade historical failures or trigger a new paid job.

---

## K4 — Agents in

**Owner outcome.** Claude Code, Codex or another MCP client reads Eliot through the same tools and submits a proposed
page that the owner can accept or reject.

**Build**

1. Apply `migrations/0009_agents.sql`; backfill/write trigram FTS over current verified claim bodies and retain a proposal's accepted base revision.
2. Implement the shared product tools as `(env, actor, input) → compact Markdown` with hard output caps.
3. Expose them through stateless Streamable HTTP MCP on a separate Access-protected hostname. Agent service-token actors
   may read and propose; only owner accepts.
   Catalogue refresh and source-understanding tools use the existing owner-authorized functions; agent actors cannot invoke these side effects.
4. Move the proposals inbox and add `pnpm eval k4` using a real MCP client.

**Hard acceptance.** Every tool respects scope/size and labels resolve. A connected agent answers O2/O5 using only Eliot
tools, proposes a page, and all citations remain valid after owner acceptance.

**Cost.** Eliot performs no model call for an external-agent request; the client brings its own model. FTS/read tools
use D1/R2 only.

The initial slice adds 1,365 non-test source lines and removes ten against the 900-line target. The excess retains
bounded UTF-8 tool pagination, immutable cited proposals with stale-head checks, and the owner review dialog; these
remain plain product functions and existing Material controls. In a local signed-JWT fixture containing ten exact
arXiv canonical texts, an external agent answered O2/O5 through Eliot tools, proposed one page and read it after a
reviewed test-owner acceptance. All 22 cited ranges retained their identities and exact bytes; agent attempts to
refresh models or request understanding were denied without side effects. This verifies the local functional path,
not deployed Cloudflare Access or K2/K3 quality acceptance. Deployed Access remains open, so K4 is not fully accepted.

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
