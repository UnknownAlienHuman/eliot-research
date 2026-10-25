# Eval — fixed material for contour acceptance

`pnpm eval <contour>` drives a running Eliot through its public API or MCP. These scripts test the assembled product,
not mocks. Their Markdown output belongs in the contour PR.

## Acceptance semantics

- **Hard functional:** auth, state, byte ranges, citations, data integrity and owner journey. Non-zero on failure.
- **Hard quality:** fixed expected facts, conditions and required abstention. Non-zero on failure.
- **Measured budget:** latency, tokens, estimated cost and Cloudflare usage. Record p50/p95 and outliers. A target becomes
  a regression gate after three comparable runs; an explicit catastrophic ceiling may fail immediately.
- **Platform spike:** verifies an uncertain Cloudflare contract before the product depends on it. Failure selects the
  documented fallback and blocks that optional contour, not the core product.

An optional LLM judge may annotate output but never controls exit status. The owner judges open answers against the
recorded expectations and baseline.

## Material

| Folder | Contents | Contours |
|---|---|---|
| `arxiv-10/` | ten fixed ML papers, O1–O8 open questions, C1–C4 exact calibration, K3 distillation anchors and NotebookLM/old-Eliot baseline | K1–K4, K6 |
| `ru/` | 2–3 open-access Russian papers and expected facts, added in K1 | K1–K3 |
| `library-200/` | 200 arXiv IDs and ten expected-paper/section needles, added only in K5 | K5 |
| `golden/` | compact migrated legacy cases: question, sources, `must_contain`, `must_not_claim`; report-only until a contour promotes one | K2+ |

PDFs are downloaded from `sources.json`; do not commit them. Cache downloads under `eval/cache/` (git-ignored) by
SHA-256 so repeated runs do not redownload unchanged material.

## Runtime

Scripts live in `scripts/eval/<contour>.ts` and share only transport/upload/poll/table helpers in `scripts/eval/lib.ts`.
Environment:

- `ELIOT_URL` — local or deployed base URL;
- `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` — deployed owner service token;
- `ELIOT_EVAL_PROJECT` — reusable project title, default corpus name.

Each script:

1. creates/reuses its project;
2. uploads **one file per request**, at most two concurrently, skipping known SHA-256 files;
3. runs the contour checks through public contracts;
4. prints a compact table and writes details to `eval/out/<contour>-<date>.md` (git-ignored);
5. exits non-zero only for the hard gates/catastrophic ceilings defined in MAP.

Every model/search row includes route/mode, input/cached/output tokens, estimated micro-USD, first-token/total time,
citations/invalid labels and terminal state. Workflow evals include steps, retries, wall time and paused/budget state.
Search evals include ingestion tokens, indexed bytes, semantic/full-text query counts and fallback count.

## Contour-specific rules

- **K1:** compare three random R2 range reads per source byte-for-byte with the full canonical text.
- **K2:** C1–C4 and O8 are hard. Open-answer review remains human. The first run establishes timing baselines.
- **K3:** claim count and model self-reported confidence are diagnostics only. Hard checks are exact quote ranges,
  numeric support and the anchor table in `arxiv-10/questions.md` for Transformer, ResNet and LoRA.
- **K5:** run the offset/filter/Russian-tokenizer spike before provisioning becomes architecture. Compare AI Search to
  claim/FTS fallback on the same needles and publish the monthly usage forecast.
- **K6:** comparison rows must show normalized key, parsed value/unit, dataset and conditions; incompatible rows must
  remain separate.

Keep one script per contour. Do not introduce a second test framework or mocks for capabilities that do not exist.
