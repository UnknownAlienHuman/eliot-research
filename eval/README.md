# Eval — fixed material for contour acceptance

`pnpm eval <contour>` drives a running Eliot through its public HTTP, Agent WebSocket or MCP contract. These scripts test
the assembled product, not mocks. A contour PR pastes the compact table and states every check that did not run.

## Gate semantics

- **Hard functional:** auth, immutable provenance, exact bytes, state, cost admission, citations and owner journey.
- **Hard quality:** fixed facts/conditions, abstention and strict comparison semantics.
- **Measured budget:** latency, token categories, reservations/settlements and Cloudflare usage. Record p50/p95/outliers.
  A target becomes a regression gate after three comparable runs; MAP may define an immediate catastrophic ceiling.
- **Platform spike:** verifies an uncertain Cloudflare contract before architecture depends on it. Failure selects the
  documented fallback and blocks only the optional contour.

An optional LLM judge may annotate output but never controls exit status. Open-answer usefulness remains owner review.

## Material

| Folder | Contents | Contours |
|---|---|---|
| `arxiv-10/` | ten fixed ML papers, O1–O8, C1–C4, K3 anchors and recorded baseline | K1–K4, K6 |
| `ru/` | 2–3 open-access Russian papers, hashes and expected facts, added by K1 | K1–K3 |
| `library-200/` | 200 fixed arXiv IDs plus ten expected paper/section needles, added only by K5 | K5 |
| `fixtures/` | redirect/HTML/scan/duplicate/Access/cost fixtures, added with owning contour | K0–K7 |
| `golden/` | compact migrated legacy cases (`must_contain`, `must_not_claim`); report-only until promoted | K2+ |

Download PDFs from `sources.json`; do not commit them. Cache under `eval/cache/` by SHA-256. Generated reports belong
under `eval/out/`; both paths are git-ignored.

## Runtime

Scripts live in `scripts/eval/<contour>.ts` and share only transport/upload/poll/table helpers in
`scripts/eval/lib/`. Environment:

- `ELIOT_URL` — local/deployed base URL;
- `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` — owner service token for deployed runs;
- `ELIOT_EVAL_PROJECT` — reusable project title;
- contour-specific Cloudflare IDs only when a platform spike requires them.

Each script:

1. creates/reuses its project;
2. uploads one file/request, maximum two concurrently, skipping known exact duplicates;
3. uses the same public route/protocol as the owner (Agent WebSocket for chat, real MCP client for K4);
4. executes hard gates and measurements;
5. prints a compact table and writes details to `eval/out/<contour>-<timestamp>.md`;
6. exits non-zero only for the hard gates/catastrophic ceilings in MAP.

Every paid row includes operation ID, route/provider, reserved/settled micro-USD, normalized usage quality, uncached/
cache-read/cache-write/output tokens, first-token/total time and terminal state. Workflow rows include attempt/Workflow
ID, platform retries, steps, wall time and paused/partial state. Search rows include profile, segments, ingestion tokens,
indexed bytes, query type/count, filter leakage and fallback count. Browser rows include seconds and capture method.

Before any contour eval, apply every migration in order to a fresh SQLite database, enable foreign keys, run
`integrity_check`/`foreign_key_check`, exercise concurrent budget admission, and adversarially prove that cross-source
current revisions, cross-page heads, cross-revision claims/distill pointers, cross-project map/results and mismatched
reservation owners are rejected.

## Contour checks

### K0

- owner browser and service-token Access success;
- malformed/expired/wrong-audience token failure;
- forged internal actor and foreign Origin failure;
- 1440/390 light/dark screenshots and keyboard focus.

### K1

- ten arXiv PDFs + Russian corpus;
- deterministic PDF page/block extraction and three byte-equal random ranges/source;
- redirect fixture stores requested/final URL and contacts origin exactly once;
- concurrent duplicate admission creates one revision;
- immutable R2 conflict/readback case;
- scan/image remains `needs_conversion`; model/search/browser call count is zero.

### K2

- C1–C4 exact facts and O8 abstention are hard;
- every source-derived completed answer has valid opening citations and zero invalid labels;
- two concurrent reservations near the limit admit only the fitting operation;
- reconnect resumes one stream/turn; Stop and explicit Retry identities are distinct;
- usage normalization never double-counts cached input.

### K3

- exact quote ranges and numeric support;
- Transformer/ResNet/LoRA anchors in `questions.md`;
- a pre-K3 readable revision is found by reconciliation;
- unchanged done revision buys zero new calls;
- failed attempt + explicit Retry uses a new Workflow/run and only accepted claims are searchable.

Claim count, drop percentage and model confidence are diagnostics only.

### K4

- a real MCP v2 client lists/reads/searches/proposes;
- every tool obeys actor, scope, cursor and output cap;
- forged/unapproved service token fails;
- accepted proposal citations still resolve.

### K5

Run the offset/filter/Russian/profile/cost spike before product activation. Compare identical needles against claim/FTS
fallback. Hard gates: at least 9/10 expected paper/section hits, zero scope leak, valid canonical hydration and unchanged
K2/K3 quality. Include a canonical document split into multiple AI Search items.

### K6

Comparison output includes the full compatibility key: subject/task family, metric, dataset identity, split, protocol,
unit and direction. Deliberately incompatible fixtures remain separate. Replacing one revision stales exactly dependent
pages. Unchanged input hash buys no synthesis call.

### K7

Two web-required questions must finish/partial inside every configured counter. Web result URLs cannot be cited before
capture. Static fixtures buy zero browser seconds. Stop prevents the next external call. Injected failure after dispatch
must not automatically duplicate a paid call.

## No metric theatre

Do not promote claim count, number of tests, code coverage, model self-score or a pretty report to acceptance. The hard
question is whether the owner can use the contour and inspect the evidence, state and cost through the real product.
