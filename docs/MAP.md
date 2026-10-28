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

## Current state — 2026-10-26

- K0 implementation uses `src/index.ts` (Hono), `src/auth.ts` (Access) and the moved Material shell in `src/web/`.
  `/api/me`, Projects/Settings navigation and System/Light/Dark appearance work locally. All assets pass through auth.
- Local acceptance includes 84 focused auth/contrast/block/URL cases and the real Worker/browser eval. K0
  covers 1440/390 px, both themes, explicit appearance persistence, navigation and Cyrillic fonts. Model/search calls: 0.
- Owner chose to keep the existing `eliotr-core.kleymor-metal.workers.dev` address for now. Its hostname Access app
  remains in place; this change does not deploy over that legacy Worker. New-domain setup and live browser/service-token
  acceptance are **not run**, so full deployed K0 acceptance remains open. `scripts/setup.sh` records later custom-domain
  setup; it defaults to an offline plan.
- K1 implements projects, shared Library membership, one-file uploads, pasted text/static URLs, immutable replacement
  revisions, outline, original download and exact UTF-8 ranges. D1/R2/IngestWorkflow run locally; Workers AI `toMarkdown`
  was exercised against the real service. AI Search and later-contour bindings remain absent.
- K1 duplicate text/URL forms now retain the 409 source identity and offer explicit Attach existing, delivered to
  `main` in `d84e8b51`. Both browser scenarios passed on the independent K1 checkout; exact revisions were reused.
  Lint/typecheck, 84 tests, build and both GitHub CI workflows passed on that commit. No deployment was performed.
- The protected-response header correction is delivered in `ca440557`: HTML/assets and source downloads now receive
  private/no-store and framing protection after response construction. K0/K1 real local evals and fast-ci passed on
  that exact commit; WebSocket read-only upgrades were checked separately in the K2/K3 WIP. No deployment was performed.
- K2 is implemented locally with an Agents SDK chat, frozen whole-source scope, one structured streaming model call,
  exact citations, Stop/reconnect, model settings and storage-only Save. Its automatic corpus gates passed; the
  fresh NotebookLM comparison found answer-quality defects, so K2 quality acceptance and merge remain open.
- Legacy `apps/`, `packages/`, `crates/` and `infra/` are donor/import material, not implementation instructions.
- The accepted Material tokens, local fonts, primitives and frame are adapted from the pinned legacy UI; future features
  remain in `packages/ui/src/**` and `apps/eliotr-web/src/app/Shell.tsx` until their contour.
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
   `src/web/api.ts`.
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
journey is explicitly NOT_RUN. The 2026-10-26 run passed both duplicate journeys with the same stored revision and
zero new conversion/model usage. The URL guard was unchanged.
`ELIOT_EVAL_LIMIT=1` adds the actual 25 MiB file and 25 MiB + 1 byte rejection cases. CI runs
`pnpm eval k1 --native-only` with remote AI bindings disabled; it does not claim PDF-service acceptance.

Local run on 2026-10-25: 13 readable sources, the scan negative, 52 exact ranges and the phone journey passed. The
25 MiB native file was readable with zero conversion calls; 25 MiB + 1 byte returned 413. Readable PDF conversion
p50/p95 was 1,697/4,604 ms from the recorded latest attempts. Those 14 corpus sources retain 13 conversion calls and
189,269 reported conversion tokens; the native source used zero. Across deliberate diagnostics and corrected reruns,
the local revision rows record 29 conversion attempts in total, with no automatic retry. Model/search calls were zero.
The sampled local workerd-process RSS peak was 653,914,112 bytes across two processes; isolate peak heap was not
available and production memory/deployment qualification is not claimed.

**Measured budget.** Peak Worker memory is inspected during the 25 MiB case; no exceeded-memory event. Conversion count
must equal the number of files that actually require conversion.

**Not now.** OCR pipeline for scans, search, claims, model answer, bulk direct-to-R2 uploads above 25 MiB.

---

## K2 — Ask

**Owner outcome.** Select sources, ask in Russian or English, receive a streamed answer with exact clickable citations,
stop/reconnect, reopen chat and save an answer as a page.

**Build**

1. Apply `migrations/0002_ask.sql`; add one `ChatAgent` Durable Object per chat and `/agents/*` routing.
2. Discover provider API catalogues with an explicit native Flash fallback; separate valid selection from admission
   requiring known context/input/output prices, using full input rate for unknown cache price and fixed job metadata.
3. Build whole-reading context from the frozen readable revisions. When it does not fit, return a clear narrow-scope
   response; claim/search modes arrive later.
4. Implement compact turn aliases and full-revision persistent labels; persist the full revision ID and exact range.
5. Use one `runTurn` for WebSocket and eval RPC; persist turn before the model call, stream, resolve labels, store
   citations/tokens/timings/cost and never auto-continue a paid failed stream.
6. Add chat/page APIs, minimal model selector, saved answers and the moved chat/evidence UI.
7. Add label/context/cost tests and `pnpm eval k2`.

The model-choice slice uses Cloudflare, Command Code and OpenRouter discovery with independent provider warnings and
the existing Material picker. Selected-only official HTML pricing requires exact provider/native-ID and currency/unit
matches; the corrected generic parser's selected Beam GET verified zero rates, while mismatches remain UNKNOWN.
Browser discovery/selection PASS covers 596 models, 1440/390 px, row 463 and both late-response races; actual project
PATCH/GET preserved the canonical choice without changing defaults/Gateway. The first legacy-path CC attempt failed
HTTP 502 and remains retained. A separate provider-native Beam caller smoke completed in 3,843 ms with 415/0/134
tokens and zero estimated cost; its one-turn manifest cannot redispatch. This **CALLER_SMOKE_PASS** does not close
K2/K3 quality or deployment gates; 0006's 75-case SQL proof is a separate config result.
The subsequent Beam corpus run passed C1, then stopped at C2 HTTP 400 without retry. The former fabricated history
marker is withdrawn in favour of private durable capture and unchanged replay of actual assistant protocol fields;
legacy missing state requires a new chat before any call. Capability-selected text streaming was checked separately:
new C2/C3 turns completed under the former workaround, while C4 stayed partial
because it supplied no citations. Failed/interrupted turns remain retained; O1–O8 on Beam and owner acceptance stay open.
The retained local Muse run completed C1–C4 with valid labels, but O1/O2 stopped at `length` and remained partial.
An immutable build of published `main` then failed O3 with unknown usage, retaining its 106,496 micro-USD reservation.
No failed turn was auto-retried; complete K2 quality, remaining open questions and owner acceptance are unqualified.
The 2026-10-27 local protocol correction passes the full local check (266 tests), including SQLite reload/replay and
uncited-answer regressions. A stored-only revalidation under the current coverage gate qualifies C1/C2 only;
C3/C4 and O1–O8 remain NOT_REVALIDATED. It made no model calls and does not qualify live provider or owner acceptance.
The separate real Beam C1 protocol attempt returned external HTTP 503 in 1,440 ms. One request was dispatched; no
retry or second turn followed. Token usage is unknown, estimate zero; no private wire was captured. Failed-state
persistence after an actual restart passed, but successful reasoning replay and full K2 quality remain open.

**Hard acceptance — `pnpm eval k2`**

- Run C1–C4 and O1–O8 from `eval/arxiv-10/questions.md` in whole mode.
- Every completed answer has at least one citation, `invalidLabels = 0`, and every cited range opens.
- C1–C4 contain the expected values and conditions. O8 abstains where the corpus lacks the answer.
- Owner judges O1, O2, O3 and O8 at least as useful and honest as the recorded NotebookLM baseline.
- No turn exceeds the configured monthly model budget; eval reports input/cached/output tokens and estimated USD.

**Measured budget.** Record cold/warm p50/p95 first-token and total time. Initial target: warm p50 first token ≤ 10 s,
p95 total ≤ 40 s. Catastrophic ceiling: a completed answer taking > 90 s fails K2. Promote tighter thresholds after three
comparable runs rather than making one provider fluctuation invalidate the architecture.

**Not now.** Claim mode, AI Search, web, chat tools, automatic regenerate, external-key UI.

Local WIP on 2026-10-26 registers only three external generation choices through the owner's existing OpenRouter
default BYOK credential: `dots-studio/dots-3-note-preview:free`, `thinkingmachines/inkling:free`, and
`nvidia/nemotron-3.5-super-vl:free`, each under `gateway:openrouter/<exact-id>`. Native defaults stay unchanged.
Their real provider capacities remain visible in advanced details; current chat/distill jobs retain the existing
8,192-token output bound. Zero catalog prices do not imply unlimited quota; unavailable models fail visibly with no
paid fallback. Existing credential metadata grants no consent; the owner must connect explicitly, and saved connection
configuration does not prove provider usability.
Owner-authorized NASA smoke through the local Worker and real OpenRouter provider is **LIMITED**: Dots chat completed
and distill reached `done` (four claims, two calls); Nemotron chat completed with a mixed-language defect. Its distill
initially failed; explicit cached publication then produced readable `partial` with five guide sentences, digest and
zero claims, preserving both model calls and original usage. Repeat Save was identical and source text unchanged.
Semantic source review on 2026-10-27 UTC leaves both glossaries **LIMITED**: Dots adds an unsupported rocky-surface
definition and mixed-script Russian terminology; Nemotron adds unsupported orbit/wobble qualifiers. Its five guide
sentences and digest are entailed, but numeric/label validity alone does not establish a fully grounded glossary.
Inkling chat failed with the original cause unknown; its separate non-streaming distill was refused with HTTP 403
after one attempt, with no retry/bypass. Including two later distinct Dots questions, receipts record five chat attempts
and five distill steps at zero estimated model cost. Dots client RUN1 observed `started:13 → completed:126` characters
from one explicit POST (`browser-1793060247504.json`); stored reload/Save proof is separate (`browser-1793058845678.json`).
Monthly spend/budget stayed 79,537/4,158,177 micro-USD. This single live sample supplies no p50/p95, full K2/K3 acceptance
or negative fallback proof. OpenRouter `is_byok: false` describes its upstream-key layer, not a Cloudflare wholesale
verdict; see IMPLEMENTATION §6/§8/§11 for contracts, metrics and boundaries.

Local K2 run on 2026-10-26: all C1–C4/O1–O8 completed with zero invalid labels and byte-checked ranges, at
$0.120236 estimated model cost. Cold first/total time was 25,724/27,763 ms; warm first-token p50/p95 was
7,361/23,601 ms and warm total p50/p95 was 23,161/40,703 ms. The initial 40 s p95 target was missed; the 90 s hard
ceiling passed. Phone Stop/reload restored the empty scope, partial Save and reconnect added no model work; one active
plus one queued input accepted and the third returned 409. The focused suite has 108 passing cases.

A fresh private Gemini Notebook/NotebookLM notebook received the same ten SHA-256-matched PDFs and the same twelve
questions without gold hints. All completed; C1–C4 values were correct and O8 abstained. Three representative citations
opened their source passages. Browser capture did not instrument service latency or expose provider usage/cost.
Content review found unsupported terminology and an overstatement in Eliot O1, unsupported inferences and a Chinese
fragment in O2, and training/fine-tuning confusion plus coverage gaps in O3. A three-call prompt experiment cost
$0.043536 and improved coverage but retained a language defect and introduced a numeric inconsistency; the experimental
prompt was reverted. No quality pass or owner acceptance is claimed. Do not repeat successful paid turns to tune these
examples; resolve the evidence/quality failure before accepting K2.

---

## K3 — Distill

**Owner outcome.** Each new readable revision receives one guide, verified claim set, digest and EN/RU glossary. The
project overview is assembled from guides. Large selections can answer from claims. Unchanged revisions are never
re-distilled automatically.

**Build**

1. Apply `migrations/0003_distill.sql`; add `DistillWorkflow`, scheduler and quote/number verification.
2. Ingest marks a readable revision queued only when auto-distill is enabled and no completed artifact exists.
3. Scheduler admits the oldest queued revisions only while concurrency and monthly model budget allow. Budget-blocked
   work becomes visibly `paused`, not a hidden retry loop. Reconcile stale `running` rows against deterministic Workflow
   IDs.
4. First call reads block-labelled text and emits guide + candidate claims. Code verifies quotes/ranges/numbers. Second
   call receives only verified material and emits digest/glossary. Store raw output/report in R2 and compact claims in
   D1.
5. Assemble project overview deterministically from source titles, guide summaries and suggested questions; do not buy
   an extra overview model call.
6. Add claim context mode. The same answer prompt and citation resolver are used.
7. Add reader guide/claims UI, quote tests and `pnpm eval k3`.

**Hard acceptance — `pnpm eval k3`**

- All ten papers reach `done` or a documented `partial` state; a second eval run performs no re-distillation of unchanged revisions.
- Every stored quote is an exact byte range; numeric result fields are cleared when not supported by their quote.
- Transformer, ResNet and LoRA anchor expectations in `eval/arxiv-10/questions.md` are present with correct conditions;
  no unsupported number is stored. Claim count and drop rate are reported, not quality gates.
- Claim mode keeps C1–C4 correct and citations valid; overview lists every readable source without a model call.
- The automatic claims path is exercised in a separate real overflow project: reuse the ten baseline sources and
  attach the public papers in `eval/arxiv-10/overflow.json`. Measured source bytes must exceed the unchanged model
  whole-reading cap, and all four turns must report `contextMode=claims`. The baseline PDFs/questions remain unchanged;
  no forced mode, reduced model cap, repeated padding or K5 search infrastructure is used.
- Eval prints per-revision calls, tokens, estimated cost, kept/dropped reasons and wall time.

**Not now.** Cross-source topic map/comparison, claim editor, recurring re-distillation.

Local K3 diagnostics on 2026-10-26 are **not acceptance**. Transformer ended `partial` after two calls (3 kept claims,
3,123 micro-USD); BERT ended `failed` after one call (no verified claims, 4,444 micro-USD, no second call). Inspection
of the raw output against canonical bytes found model-joined PDF hyphenation and changed brackets, plus claims with
numbers absent from their quoted row. The strict verifier correctly rejected them. The second-stage numeric guard
and closed block-selection request were corrected; that corrected model path has not yet passed service acceptance.
Existing failed/partial attempts are retained, with no automatic paid retry. Re-requesting the unchanged Transformer
revision returned identical output, two total calls and zero cost delta. Full K3 remains open, including all ten
sources, anchors and real claim-mode C1–C4.

A separate retained validation corpus now has ten pipeline-completed revisions. The real Flash service used twenty
bounded calls (two per revision), totaling 64,651 micro-USD. BatchNorm's
two saved responses initially failed deterministic digest validation; sentence-level checking recovered nine supported
claims by explicit storage-only Save, with calls/tokens/cost and original/text bytes unchanged. The zero-headroom save,
repeat-save idempotence and phone reader/citation journey passed locally. The full service eval failed A1 French
41.8 BLEU and its 3.5-day/eight-GPU anchor; it did not retry any revision. Raw inspection found a stored statement
41.8 quoting a passage with 41.0 plus a separate 8: the digit-group guard incorrectly accepted this combination.
The decimal guard and regression now reject it; retained artifacts are diagnostic evidence, not quality-accepted
knowledge. The original PDF itself has 41.8 in its abstract/Table 2 and 41.0 in §6.1, and canonical text preserves
that conflict. This does not demonstrate a converter defect. Source-guide wording was also corrected to exclude
candidate-review narration; that new request path is **not service-tested**. Automatic claim-mode C1–C4 remain
**NOT_RUN**. No further paid work is started to turn this failed run green.
Explicit cached rechecks on the three affected revisions now exclude four rejected claim assertions from the current
read path: Transformer 10→9, GAN 17→16 and BERT 12→10. All 115 D1 rows remain; `claim_count` selects 111 current cards.
Checked R2 bodies and the report head publish atomically with current claim metadata. Real phone/browser checks,
zero-headroom save, exact ranges, unchanged originals/texts, repeat-save identity and unchanged usage passed. The latest
stored eval has three open gates: the two A1 anchors and claim-mode NOT_RUN, with no numeric violations or new POST.

Raw diagnosis found a general request-shape mismatch: all 14 first-pass Transformer claims were table results, while
guide items contained 3–4 sentences (653–1,133 characters) assigned to one roughly 1 KiB block. The chosen excerpt pool
omitted the abstract's headline-result block; call two could not recover material it never received. Label membership
alone does not establish semantic support. JSON block boundaries, guide-first output and sentence-level guide bounds
now make that contract explicit without source-specific branches or adding evidence to retained outputs. This changed
paid request remains **NOT_RUN**; no further paid attempt is started merely to green the eval.

The combined K0/K2/K3 and external-model slice measured before integration adds 1,831 non-test `src/` lines (generated bindings excluded), counting
all shared UI additions conservatively. The K3 1,200-line target is exceeded; the excess covers exact quote/number
checking, primary-passage hydration and owner-visible cached-output correction, without an additional platform or
generic retry layer. This combined count supersedes the earlier approximate 1,440-line figure; it is not a claim that
all changes belong to K3 or that the target was met.
The earlier stored run on `.wrangler/state` exited nonzero with 25 violations. The latest stored-only run on the fresh
ten-source corpus initially had seven violations. After the explicit correction it exits nonzero with three open
gates. It adds no POST/model work and leaves 64,651 micro-USD unchanged.
Anchors use only exact claim quotes from their actual source, never generated digest or unsupported conditions as
evidence. Native-only smoke success and diagnostic-script exit codes are not K3 acceptance.

Budget evidence is from the same local Worker at `127.0.0.1:5173`, local D1 `DB` under `.wrangler/state/v3/d1`:
Transformer admission at 07:34:09 UTC reserved 322,766 micro-USD over 828,757 chat usage (1,151,523 total); settlement
at 07:35:02 replaced that reservation with 3,123 (831,880 total). BERT ran 07:49:24–07:50:32 UTC, settling to 4,444;
the 14:09 UTC storage check showed 836,324 total against the unchanged 5,000,000 budget. A reservation snapshot is not
an additional bill. `admitDistill` updates the owning revision atomically before Workflow creation; each model dispatch
then atomically increments its bounded call count before `generateText`.

**Fresh-run cost bound (2026-10-26).** Ten baseline sources × two calls + two overflow sources × two calls + four
claim answers = **28 calls**, reserving **4,518,724 micro-USD** at Flash's worst-case model-token bound, plus PDF
conversion. The twenty-call baseline alone reserves 3,227,660 micro-USD; 24 calls / approximately $3.88 excludes overflow
and is not the full-run total. The reported remaining 4,078,640 micro-USD cannot admit the full fresh bound; no budget
increase is assumed.

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

1. `ProjectKnowledgeWorkflow` starts after a completed distillation batch or explicit Refresh.
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
