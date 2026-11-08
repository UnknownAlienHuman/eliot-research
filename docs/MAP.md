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
- New chat/distill accounting caps known input-plus-output capacity by the published combined window; existing receipts and reported usage stay unchanged.
- Context assembly, final chat framing and source understanding use the provider input ceiling plus output headroom only inside an explicitly known combined window; the separate 16 MiB materialization allowance still applies.
- Whole-reading overlaps at most the current source's block-map/text GETs while consuming bodies serially; missing maps and budget failures cancel unused text without opening later sources. The storage-only K2 context eval covers this bound; production latency and K2 semantic acceptance remain separate.
- K2 has a local Markdown chat path with frozen source scope, server-resolved citations, Stop/reconnect and storage-only Save, plus the R2 model snapshot with the owner-only refresh route. K2 and K3 are not fully accepted; their remaining quality and claim-mode gates stay open in their contour sections below.
- Numeric source checks preserve the ViT compute range across `2 − 4` / `2–4` formatting, without rewriting answers or canonical ranges. This deterministic correction does not establish semantic answer quality.
- K4 is implemented in main. Its signed-agent read, proposal and owner-decision path is verified locally with test
  JWKS; deployed Access remains unverified. K6 is frozen until K2/K3 acceptance.
- The existing `eliotr-core.kleymor-metal.workers.dev` address is retained per owner decision; the replacement is not deployed over it.
- Existing-address replacement is prepared locally via `env.production` and the retained `ResearchSession` export
  alias. Its signed Workerd RPC/WebSocket/MCP probe is local-only; remote deployment and K10 import remain pending (§2).
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
| 11 · K2/K3 | Partially complete: pure post-stream usage projection was accepted in [#475](https://github.com/UnknownAlienHuman/eliot-research/pull/475), merged as `d718301c`. Composer presentation is extracted to `ChatComposer`; `ChatView` retains conversation state, lifecycle and action ownership; see [§13](IMPLEMENTATION.md#13-owner-interface). | Server extraction preserved admission, deadlines, citations, queue and settlement. The UI extraction slice is complete locally; the existing K0 Chat suite passed 53/53. Sol's bounded source audit passed with blob IDs. Chrome spot-check observed composer/draft rendering and History opening. e622 CI runs `42337156849` and `42337156855` passed native/browser History/New chat Cancel/Confirm/draft+scope at 1440/390. Manual extension Cancel was not verified: its test tab was removed and the dialog is gone; no user action is pending. K2/K3 quality gates remain open. |
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
   Project creation preserves edits made while waiting and safely repeats an unconfirmed request with the same UUID.
   Projects defaults to active rows; Show archived projects pages through archived rows and exposes the existing
   Unarchive action. Archive/restore keeps sources, history and saved evidence intact.
   Add sources exposes the existing Library in bounded pages and attaches a saved source without another upload,
   conversion or understanding call. Already attached sources are excluded; Refresh rescans Library changes.
3. Browser batch UX sends **one file per request**, with at most two uploads in flight. The API accepts one file up to
   25 MiB, never a 100 MiB buffered multipart batch. Text and URL have separate JSON routes/shapes. IMPLEMENTATION §4.
   Text/URL forms allow one pending request each and retain edits made while waiting for its response.
   Confirmed additions cancel older source-list reads before refreshing, so new sources become selectable even
   while the project's first list load was pending.
4. Hash, store original under an immutable R2 key, create pending rows and start deterministic
   `ingest-<revisionId>`. Exact duplicates are reported with Attach; never silently merged. Concurrent uploads or
   replacements cannot admit the same bytes for different live sources; deliberate reconversion within one source remains available.
   A replacement whose response was lost can explicitly repeat its revision ID without admitting another ingest.
   A confirmed replacement refreshes active source lists even after Reader/project navigation, retaining loaded
   source pages and selection while updating current-text/original links and understanding availability.
5. Convert native UTF-8 text locally. Use cached `env.AI.toMarkdown().supported()` only for document formats that
   require it. Ordinary ingest never invokes OCR; scans retain the original and show
   `needs_conversion`. Write canonical `text.md`, exact `blocks.json`, state/warnings and current readable revision.
   Flag unexpected non-printing text characters without rewriting evidence; older readable revisions show the same
   reader warning on load without mutating their metadata or starting conversion.
6. Implement outline, whole text, exact UTF-8 range and original download. Reading must not call a model.
   Find in source navigates literal case-insensitive matches in the loaded revision, wrapping forward/backward and
   reusing exact passage links. Copy also accepts the highlighted passage; a missing term leaves that passage intact.
   Failed text/outline reads have an explicit retry without losing the selected citation. Text, outline and revision
   identity publish together; navigation fences pending retry responses. The Reader component regression injects both
   read failures and verifies UTF-8 selection, repeated retry and cross-revision/source navigation.
   Clear passage retains the requested immutable revision while its metadata is loading or unavailable. Back/Forward
   around that Clear action restores only the highlight, never a different revision.
7. Move the project/source/import/reader UI features and replace legacy adapters with `src/shared/api.ts` +
   `src/web/api.ts`. Show filenames, readable states and human revision labels; keep immutable IDs and exact ranges in
   links/API data, and conversion telemetry in eval output. Source titles use the row width ahead of the secondary
   Original action and expand for the open/focused row; the K1 Library browser journey checks scanning, keyboard
   selection/navigation and immutable Reader versus latest-original identity at desktop/phone widths.
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
- At 1440 px and 390 px, Outline starts closed as a native disclosure above a single canonical-text column.
  Opening it preserves the existing reading measure, heading/passage links and exact `<pre>` text content.
- Owner opens three citations and one copied range link on phone; UTF-8 selection and copied ranges stay exact.

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
   requires usable input metadata and assembly headroom, without per-model price prerequisites.
   Providers enforce quota/billing rules.
   A valid stored catalogue is authoritative; a successful native slice cannot be supplemented with an absent fallback
   route. Preserve a failed native refresh's prior slice and show warnings on read/Refresh without changing selections.
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
   Retain accepted input before post-acceptance validation; a restart before the first payload stores the same question
   as never sent, with known zero usage. Reads and repeat IDs do not start it again.
6. Add chat/page APIs, one visible Material catalogue with answer/understanding defaults, compact chat/project pickers,
   saved answers and the moved chat/evidence UI. Provider configuration is separate from credentials kept in Cloudflare.
   All-provider labels identify origin without merging distinct provider/native-ID pairs. Filters preserve the current
   choice separately when it is outside the results. Configured model choice/Save remains separate from connection
   and paid admission; show saved Gateway status/setup beside the catalogue, without granting credential access.
   Save/validate only changed defaults, retaining an untouched missing/disabled default and treating an unchanged
   stale replay as a no-op. Refresh warnings stay visible and do not claim an unconditional clean refresh.
   The project header opens a paged active-project picker with Refresh/Retry; switching opens that project's chat
   without creating a chat or sending a question. Switching to another project confirms discarding a nonblank draft;
   cancelling or closing the picker preserves the current draft and source scope.
   History and New chat also confirm before discarding a nonblank draft; cancellation preserves the current chat and scope.
   Blank Chat offers the first recent saved conversation from the existing newest-created-first history page.
   Opening it is explicit, confirms discarding a nonblank draft, and never sends a question. Loading/error and Retry
   remain visible beside the usable new-chat composer; late history never navigates or changes the draft/scope.
   Saved chat entry shows its latest messages once; Reader/Back, Retry and reconnect preserve deliberate history reading.
   Late font/control reflow keeps an already-bottom reader at the bottom without moving deliberate history reading.
   Latest returns to the end explicitly. `pnpm eval k2 --scroll-browser` covers this desktop/phone journey using stored
   snapshot fixtures and native Reader reads, with model calls blocked.
   New chat retires an unconfirmed first Send even on the unchanged blank route, without letting its late reply reuse the old chat or block the new composer.
   Native requests use the existing Cloudflare plan without a local billing selector or synthetic allowance veto.
   Explain Free exhaustion and possible Paid overage; do not change the subscription, selected models or providers,
   or claim that Eliot enforces a separate free spending cap. Reject retired nativeUsageMode writes before mutation.
7. Add label/context/cost cases and `pnpm eval k2`.

**Behavioral contract.** Only Send starts answer inference. Each turn freezes its source revisions and admitted model
metadata. Fresh chat requests an experimental 8,192-token job budget and always passes its applied value as the SDK
`maxOutputTokens`. Known provider maxima and estimated remaining known combined windows clip that value;
`outputReserveTokens` serves assembly only, while a null provider maximum remains unknown.
Optional `TurnView.outputBudget` stores `requestedTokens` and `appliedTokens` in existing DO JSON and public reads;
old missing fields remain omitted. A `length` finish preserves text and known usage as partial/failed, without
automatic continuation.
Admission has its own claim; a missing numeric capacity never permits another call for the same turn.
Fresh native rows request `high` only when one `reasoning_effort` property uniquely advertises it in `supported_efforts`;
otherwise the SDK option is omitted, while stored `low` remains literal. This is a request policy, not semantic acceptance.
Chat always returns ordinary Markdown with inline compact source labels; one generic `SYSTEM_PROMPT` applies
across corpora, with no fixed-paper coaching or JSON sentence/label enum. Each whole or compact evidence block is one
JSON `{label,text}` record with literal brackets escaped, and its label applies only to that block's text. The label
inventory and derived claim statements/conditions remain separate orientation, not evidence. The server resolves
labels and byte ranges.
Adjacent user input parts share one message without changing their text; assistant history and system instructions
keep their boundaries. The same message assembly governs context estimation and the single model dispatch.
Markdown reference definitions cannot redirect exact registered citation tokens in chat or saved answers, including
adjacent tokens parsed as one link; ordinary explicit links and unregistered labels retain their Markdown behavior.
Escaped literal backticks do not hide prose citations from resolution or Save; real inline-code labels remain literal.
Groups of fully specified labels may normalize to separate inline references after every member passes the same
frozen-scope validation; unknown identities and shorthand remain failures.
Inline citations use compact passage numbers; full titles remain available to assistive technology and on hover.
Keyboard and pointer activation keep the same immutable Reader target.
Standalone `Page N` / `Страница N` markers and empty headings are omitted from model input and citation labels;
canonical text, block IDs and byte ranges are unchanged. GET, history, reconnect and Save are storage-only.
Stop preserves partial output; a failed paid turn is never retried automatically. New Save bodies omit advisory
missing-citation and numeric-support counter prefixes; `TurnView.warnings` remains in API/eval output.
Save preserves recorded partial-error and history-omission notes, distinguishing interrupted generation from
rejected source references. Existing pages are not rewritten.
An explicit repeat of an unconfirmed Save in the mounted workspace reuses its
mutation UUID and returns the committed page rather than duplicating it; confirmed saves remain distinct copies.
Stream checkpoints also flush a received tail during provider pauses. Stored text retains resolved citation targets through restart and Save, with no source reread or automatic model continuation.
For a nonstandard provider finish normalized to `other`, the stored failure includes a bounded safe provider code.
An explicit repeat of an unconfirmed Send in the same composer reuses its ID, unchanged input and known chat target;
a new question or a repeat after confirmation has a new ID. See IMPLEMENTATION §8 for the volatile-draft boundary.
Follow-ups may omit whole older exchanges to fit the selected evidence while keeping the latest reusable exchange.
The answer and saved page disclose that omission; a latest exchange that cannot fit is not shortened to force a call.
Model history is selected independently of the UI's 50-row page, with SQL payload/scan checks before transfer.
Failed turns do not displace usable history; exhausted safe reads are disclosed or rejected before inference.
New-chat creation also retains its UUID/title for explicit replay. After reload, History opens a committed chat/result
without resending; it does not reconstruct an unaccepted draft.
The first HTTP or socket history restores the prior source scope before Send becomes ready. A slow or failed HTTP
read cannot widen a socket-restored chat's scope; later reconnects preserve the owner's current selection.
Missing citation/numeric-support spans remain API/eval diagnostics without frames in the owner answer. They do not
change stream state. A completed generation can
still fail the quality gate; diagnostics do not waive citation, expected-fact or owner-review requirements.
The composer remains visible while reading long answers. Its collapsed Sources and model row and compact, resizable
question field leave reading space on both desktop and phone; model warnings remain visible when controls are collapsed.
Failed turns show the full reason instead of an empty-answer placeholder, with partial text retained when present.
Citation details retain exact passage links; runtime counters
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
p95 total ≤ 40 s. A completed answer taking > 90 s fails the K2 latency gate; that metric does not abort generation.
Promote tighter thresholds after three comparable runs rather than making one provider fluctuation invalidate the architecture.

**Not now.** Claim mode, AI Search, web, chat tools, automatic regenerate, external-key UI.

K2 is not fully accepted or deployed: citation validity, latency and owner quality review remain open. The unchanged
twelve-question benchmark uses the tracked [baseline summary](../eval/arxiv-10/baseline.md). Full NotebookLM answers
were retained under the git-ignored `eval/out/notebooklm-20261026/answers.md`; they are absent from a fresh checkout.
See [evidence availability](../eval/README.md#comparison-evidence) for recovery and the summary fallback. Comparison
results belong in the PR and do not replace these gates. Neither K2 nor K3 is deployed.

## K3 — Distill

**Owner outcome.** An explicitly understood readable revision exposes reviewed claims and a deterministic digest,
with a guide, suggested questions and glossary when available. The project overview reuses stored summaries.
Large selections can answer from claims. An unchanged revision is never re-distilled automatically.

**Build**

1. Apply the existing distillation, manual-understanding and retry migrations through
   `0014_distill_attempt_switch_guard.sql`; retain `DistillWorkflow` and canonical quote/number verification.
2. Ingest makes a revision readable at understanding `none`. Understand explicitly requests one revision;
   normal requests reuse completed or partial output without another model call.
3. Admit only the requested revision under the existing two-slot concurrency limit and usable model metadata.
   Explicitly requested work waits `queued` when slots are full; completion and cron drain only undispatched work.
   Missing routes or unusable metadata leave it visibly `paused`; provider rejection fails without paid retry.
   Keep the queued route and accepted intent on repeat, rejecting conflicting explicit choices before dispatch.
   Explicit Retry uses a stable request ID and predecessor compare-and-set, archives the exact old receipt and
   claims, and requires confirmed terminal Workflow status for completed predecessors, including legacy zero calls.
   Unknown replies retain that request across remount; reads, Reload, Save and previous-attempt controls remain
   storage only. Preserve durable accepted/rejected retry identity and the attempt-scoped native Low/High choice.
   Changing a selection starts no work. Compact Low quality and delivery remain unqualified;
   High latency as a failure cause remains unproven.
4. Pin `producerFormat: "compact-k3-v1"` in new accepted intent and internal Workflow parameters.
   An absent marker keeps queued legacy work on its existing format; raw output and history are never regenerated.
   Call one is requested to return at most 32 `{ quoteBlock, kind?, statement }` candidates with complete atomic
   statements, qualifiers, conditions and comparisons. It requests no scalar tuple, guide, questions or glossary.
   Native compact call one uses public `Output.json()` complete decoding from final `onEnd` output after a normal
   finish; review and other paths retain `Output.object`. The outgoing native text request and prompt schema stay
   unchanged. Full valid decoded Raw1 is stored unchanged and untrusted; syntactic JSON is not owner-visible facts.
   The persisted Raw envelope remains strict. Code consumes only `candidates` from decoded output, ignoring outer
   metadata without rewriting raw artifacts or using a metadata-key whitelist. Original positions 0-31 retain
   strict candidate-field, canonical quote, UTF-8 range, numeric and reference checks. Drops preserve C indexes;
   later positions never backfill them, and normalized review candidates number at most 32.
   Every later index is `unreviewed-work-limit`, not a semantic rejection. Existing allocation is charged before
   diagnostic arrays are created. Tail drops derive `requiresReview`, keeping publication and storage-only Recheck
   partial even with a valid guide and every offered candidate selected. Invalid/truncated first-call JSON or
   `length` retains null output and known usage, with no second call or guessed repair.
   Compact nullable typed fields stay null; current `find_claims` uses text query and scope, without typed filters.
   Call two receives unique evidence once plus candidate-to-`evidenceId` bindings. Its output boundary consumes only
   selections, rejections and guide, ignoring outer metadata; `Output.object`, strict decision fields, IDs and
   duplicate checks remain. Reasons stay nonempty diagnostic prose, with brevity requested rather than a 160-character
   scalar bound; existing per-call limits apply, and full decoded reasons remain in Raw2 rather than owner facts.
   Metadata values never enter evidence or published claims. Missing decisions remain
   unknown, with no added facts or rewritten statements. Compact envelope/non-array failures persist a safe reason
   in the existing attempt-fenced `distill_error` before Workflow reconstruction, preserving it after prototype loss.
   An optional guide is an ordered subset of selected IDs, rendered as whole frozen statements with citations;
   the digest is deterministic from selected claims. Missing or bad guide output keeps reviewed claims and digest
   as `partial`. Missing or invalid call two never publishes call-one drafts.
   Fresh compact extraction requests 8,192 output tokens and review 4,096, clipped after the actual prompt/schema
   estimate by `requestedOutputLimit`. Existing raw artifacts and reports record requested/applied budgets;
   optional report `producerFormat` identifies the contract, while absent historical fields stay unknown.
   Legacy in-flight attempts retain their frozen cap policy.
   Keep at most two calls, zero paid retries, six minutes per call, seven minutes per native step, the absolute
   fifteen-minute recovery ceiling and the existing 16 MiB allowance. Native delivery retains the public SDK
   single-consumer/final-validator boundary and safe failure/known-usage handling in IMPLEMENTATION §6.
   Retained `claim-plan-*` and markerless output use only the compatibility path for old formats, history and Save.
5. Assemble project overview deterministically from titles, available guide summaries and stored questions.
   Open it from Studio, page through all eligible sources and Refresh to rescan membership/heads.
   Each row opens the immutable revision whose stored summary was shown; overview performs no model call.
6. Preserve whole originals where the shared context budget permits. Compress eligible sources only as needed,
   retaining the complete frozen scope, order and aliases with the same answer prompt and citation resolver.
7. Show claims beside exact source excerpts, useful availability/progress and verification caveats.
   Optional guide/questions/glossary do not block reviewed compact claims and digest from remaining readable.
   Quote links retain exact identities; call/token/time/reservation counters stay in API/eval diagnostics.
   Available current questions prepare an editable draft with that source selected; replacing a draft requires
   confirmation, and historical questions remain read-only. Understand/Save refresh the source badge without
   reloading text or resetting pagination/selection. Lost or unreadable POST replies remain unknown until a
   successful status read; Reload retries only that read, and `none` enables only a later explicit request.
   Mount refreshes status, and read failure blocks actions until Reload succeeds.

**Hard acceptance — `pnpm eval k3`**

All gates below remain OPEN for `compact-k3-v1`; implementation or storage-only checks do not close them.

- Before model work, verify all ten baseline source/revision identities and original/canonical bytes, the separate
  twelve-source overflow scope, its already-understood extras and prepared claim chat. Missing or ambiguous inputs
  stop before any paid call. Count the extras' recorded calls separately and never silently reuse duplicate answers.
  Admission or unfinished/failed answers stop later submissions; completed quality failures remain failed checks.
- Every baseline paper reaches `done` or a documented `partial` result. A full unchanged-revision reuse run performs
  no re-distillation. `--unchanged-only` compares reports, claims, calls and usage for every exact terminal revision;
  this does not waive semantic or claim-mode gates. Queued revisions keep their accepted route and producer format.
- Every stored quote and citation resolves to its exact original UTF-8 bytes within the frozen revision and scope.
  Candidate/reference filtering preserves surviving order and IDs. No source is dropped to make an answer fit.
- Statements retain complete qualifiers, conditions, units and comparisons supported by their own quote.
  Complete numeric literals and references remain required; finding the same numbers does not establish meaning.
  Compact typed nullable fields remain null. Legacy scalar/guide/glossary checks apply only to their retained format.
- Review publishes only explicitly selected, rechecked candidates. Missing decisions remain unknown.
  Raw1 remains untrusted and unchanged; only strict validated original positions 0-31 may enter review, without
  tail backfill. Every later index has `unreviewed-work-limit`, forcing partial publish and storage-only Recheck
  even when all offered candidates are selected and the guide is valid.
  Guide IDs must be an ordered subset of selected IDs, with whole frozen statements and original citation bindings.
  Missing/bad guide yields readable partial claims and digest; missing/invalid call two publishes no draft claims.
  Compact completion does not require three guide sentences, suggested questions or a glossary.
- A1-A3 in `eval/arxiv-10/questions.md` retain their complete existing expectations and conditions for Transformer,
  ResNet and LoRA. Each anchor must occur in an EN/RU claim statement supported by that claim's own exact quote;
  a phrase only inside a broad excerpt, guide or digest does not establish claim coverage.
  The A3 unmatched form remains `REVIEW_REQUIRED`. Claim count and drop rate are diagnostics rather than quality gates.
- Semantic support and owner review remain required across the full corpus, including reviewed claims and every
  available derived view. Exact ranges, valid references and numeric occurrence alone cannot accept quality.
  Explicit storage-only Recheck revalidates the same frozen format into a separate checked report, preserving
  original artifacts. It applies no new prompt or producer and does not close semantic acceptance.
- C1-C4 remain correct with valid citations in real automatic claim mode. The separate overflow project reuses
  the ten baseline sources plus the unchanged public extras in `overflow.json`; measured bytes must exceed the
  model's whole-reading cap and all four turns must report `contextMode=claims`.
  Do not force the mode, reduce model capacity, add repeated padding or introduce K5 infrastructure.
- Overview pages through every eligible current readable source without inference. Timestamp ties, deleted cursor
  anchors, project isolation, Retry/Refresh and pinned Reader links pass the existing overview gates.
  Newly eligible sources before the cursor require Refresh.
- Eval selects completion rules by the stored producer marker, preserving old-format requirements.
  It reports per-attempt historical and newly observed calls separately, known/unknown usage, requested/applied
  output budgets, declared capacity, kept/dropped/unknown decisions and wall time.
  An unconfirmed request stays unknown until acceptance or a terminal observation is established.

**Not now.** Cross-source topic map/comparison, claim editor, recurring re-distillation or another verifier call.

K3 is not fully accepted or deployed. Retained legacy runs recorded ten baseline papers as `done`, unchanged reuse
and four claim-mode overflow answers, but they do not qualify the compact producer or its current corpus.
A1-A3, C1-C4, semantic support, full-corpus/reuse acceptance, latency and owner review remain open.

On 2026-11-07, bounded compact controls used the same unchanged Transformer revision with Low reasoning.
Flash call one failed on an array over 32 candidates after 82.506 s, reporting 12,298 input and 4,151 output tokens.
A separate DeepSeek V4.1 call one ended with `length` after 60.108 s, reporting 12,057 input and 8,192 output tokens.
Flash control `dc9ed7ac-baf1-4384-a9ce-bf099b238066` failed after 94.522 s, with 12,298 input and 5,037 output
tokens; its 61-candidate JSON also contained `$schema` and was rejected by the decoded outer boundary before call two.
Those three controls stopped before call two. Control `88d91f54-7a1d-40a2-95fb-a90e91cffa27` passed the first step,
then failed review SDK validation at `selected.0.reason` over 160 characters. Its two calls took 91.560 s and
reported 19,056 input, 5,176 output and 0 cached tokens, with requested budgets 8,192/4,096; it published zero claims
and no guide or digest. The archived dc9 view matched its retained content except for `currentAttemptId`.
The outer-metadata boundary is fixed offline. No paid repeat has run after the final reason-field fix; full K3
semantic and corpus gates remain OPEN. Global defaults remain Flash; successor quality remains unqualified.

**Remaining quality work.** Diagnose each retained failure against its exact revision: conversion loss,
missing evidence, lost statement conditions, numeric-format rejection or unsupported prose.
The quote-range, declared-reference and code-range repairs in
[#476](https://github.com/UnknownAlienHuman/eliot-research/pull/476),
[#477](https://github.com/UnknownAlienHuman/eliot-research/pull/477) and
[#479](https://github.com/UnknownAlienHuman/eliot-research/pull/479) establish their bounded storage/static behavior,
not fresh-model quality. [#478](https://github.com/UnknownAlienHuman/eliot-research/pull/478) guards the A3 decision;
the retained 929-byte block still requires review. Repair defective PDF text only through reviewed OCR and immutable
Apply, preserving old bytes and citations. Review each complete compact statement against its frozen evidence
within the same two calls; no paper-specific prompt, weaker anchor or paid repair chain closes the gap.
[#430](https://github.com/UnknownAlienHuman/eliot-research/pull/430),
[#454](https://github.com/UnknownAlienHuman/eliot-research/pull/454) and
[#459](https://github.com/UnknownAlienHuman/eliot-research/pull/459) remain unaccepted attempts.
K6 stays frozen, and reusing stored output never starts paid work.

---

## K4 — Agents in

**Owner outcome.** Claude Code, Codex or another MCP client reads Eliot through the same tools and submits a proposed
page that the owner can accept or reject.

**Build**

1. Apply `migrations/0009_agents.sql`; backfill/write trigram FTS over current verified claim bodies and retain a proposal's accepted base revision.
2. Implement the shared product tools as `(env, actor, input) → compact Markdown` with hard output caps.
3. Expose them through stateless Streamable HTTP MCP on a separate Access-protected hostname. Agent service-token actors
   may read and propose; only owner accepts.
   A separate MCP Access audience is selected only on `/mcp`; UI/API/chat retain their own audience. The signed local
   K4 eval rejects cross-application owner assertions and retains the agent proposal/owner-acceptance checks.
   Catalogue refresh and source-understanding tools use the existing owner-authorized functions; agent actors cannot invoke these side effects.
4. Move the proposals inbox and add `pnpm eval k4` using a real MCP client.
   Failed proposal writes clean up confirmed fresh orphan objects; committed or uncertain D1 outcomes retain bytes.
   Opening a proposal citation releases the review dialog and focuses its exact source passage; reopening review
   retains the selected draft. The K1 browser journey covers both inline and listed citations without accepting it.

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

The first K10 preparation slice is `pnpm legacy:export --database /private/core.sqlite --objects /private/r2
--output /private/export` (one line). It reads an existing offline SQLite/R2 snapshot only, preserves project/source/
membership metadata and exports every LIVE revision's verified manifest and exact readable bytes. Empty original
references are reported as `not_recorded`, never reconstructed or asserted to exist. The synthetic 8-project,
15-source, 17-LIVE-revision fixture checks this shape, including immutable old revisions and integrity failures.
This is not a production inventory verification, full legacy export or target import; artifact/wiki/research output,
owner comparison, reauthorisation and retirement remain open. No live data, schema or deployment is changed.
