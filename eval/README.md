# Eval — fixed material for contour acceptance

`pnpm eval <contour>` drives a running Eliot through its public API. The current dispatcher supports K0–K3;
MCP acceptance belongs to the future K4 contour. These scripts test the assembled product, not mocks. Reports belong
in the contour PR. [MAP](../docs/MAP.md) owns current status and acceptance; script presence is not a contour pass.

## Acceptance semantics

- **Hard functional:** auth, state, byte ranges, citations, data integrity and owner journey. Non-zero on failure.
- **Hard quality:** fixed expected facts, conditions and required abstention. Non-zero on failure.
- **Measured budget:** latency, tokens, estimated cost and Cloudflare usage. Record p50/p95 and outliers. A target becomes
  a regression gate after three comparable runs; an explicit catastrophic ceiling may fail immediately.
- **Platform spike:** verifies an uncertain Cloudflare contract before the product depends on it. Failure selects the
  documented fallback and blocks that optional contour, not the core product.

The owner judges K2 open answers against the recorded expectations and baseline. Mechanical citation checks do not
establish semantic support. K3 quote, numeric, anchor and claim-mode gates remain hard checks; a limited smoke pass
does not close them.

## Material

| Folder | Contents | Contours |
|---|---|---|
| [`arxiv-10/`](arxiv-10/) | [source manifest](arxiv-10/sources.json), [O1–O8 / C1–C4 / A1–A3](arxiv-10/questions.md), [baseline](arxiv-10/baseline.md) | K1–K3 now; reuse in later contours per MAP |
| [`arxiv-10/overflow.json`](arxiv-10/overflow.json) | additional public papers for the real K3 overflow/automatic-claims journey | K3 |
| [`ru/`](ru/) | [Russian PDF and native-text manifest](ru/sources.json), including the scan negative case | K1–K3 |

PDFs are downloaded from `sources.json`; do not commit them. Cache downloads under `eval/cache/` (git-ignored) by
SHA-256 so repeated runs do not redownload unchanged material.

## Runtime

The entry point is [`scripts/eval/run.ts`](../scripts/eval/run.ts), invoked by `pnpm eval`. Implemented scripts are
[`k0.ts`](../scripts/eval/k0.ts), [`k1.ts`](../scripts/eval/k1.ts), [`k2.ts`](../scripts/eval/k2.ts) and
[`k3.ts`](../scripts/eval/k3.ts); each currently contains its own small transport/check helpers.

| Command / mode | Actual scope |
|---|---|
| `pnpm eval k0` | Worker/Access/Material browser journey, zero model calls |
| `pnpm eval k1 --native-only` | native-text ingest/reader/browser fixtures; PDF conversion not run |
| `pnpm eval k1` | full K1 corpus and browser checks; document conversion may use the live service |
| `pnpm eval k2 --native-only` | limited reader/history smoke, zero model calls |
| `pnpm eval k2 --models-only` | disconnected Gateway consent/admission and 390px Settings/understanding; no credential enable or provider call, not external-model acceptance |
| `pnpm eval k2 --picker-only` | empty-project chat readiness, dynamic model/provider selection and intercepted Send payloads; zero inference, unchanged stored turns/usage, frontend proof only |
| `pnpm eval k2 --stored-only` | existing chat hard-gate revalidation; requires `ELIOT_EVAL_CHAT`, no new chat or turn |
| `pnpm eval k2` without model opt-in | limited storage smoke, not full K2 acceptance |
| `pnpm eval k3 --native-only` | explicitly limited storage smoke, zero model calls; optional cached-output checks are separate fixtures |
| `pnpm eval k3` without model opt-in | stored hard-gate validation; nonzero on missing/failed work, unsupported quotes/numbers, missing anchors or unverified claim-mode C1–C4 |
| `pnpm eval k3 --unchanged-only` | preflight ten terminal revisions, submit each exact revision once and verify unchanged reports, claims, call counts and usage; no inference |

The model opt-ins `ELIOT_K2_MODEL=1` and `ELIOT_K3_MODEL=1` enable paid paths only when the root explicitly releases
that run. K2/K3 reuse existing readable corpus revisions; they do not repeat ingestion/conversion to fill missing
evidence. K3 checks known failed/paused revisions before admitting work and does not automatically retry them.

Environment:

- `ELIOT_URL` — running app base URL, default `http://127.0.0.1:5173`;
- `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` — deployed owner service token;
- `ELIOT_OWNER_JWT` — optional owner assertion for K1–K3;
- `ELIOT_EVAL_PROJECT` — project title; native K2/K3 default to `k1-eval`, full/stored corpus modes to
  `Библиотека — PDF и точные ссылки`;
- `ELIOT_EVAL_CHAT` — existing K2 chat for resume or stored-only validation;
- `ELIOT_K3_CLAIM_PROJECT`, `ELIOT_K3_CLAIM_CHAT` — existing overflow project/chat for stored claim-mode C1–C4 checks;
- `ELIOT_EVAL_NET=1` — explicitly include K1 network URL checks in native mode;
- `ELIOT_EVAL_LIMIT=1` — include K1 25 MiB boundary checks.

Start the app with its matching local bindings/state before running eval. K2/K3 need K1 material already present.
For native CI, [fast-ci](../.github/workflows/fast-ci.yml) disables remote bindings before starting the app, then runs
K0 followed by native K1/K2/K3. Native fixtures mutate local storage; serialize these runs against other fixture/settings
work. Ingest does not start understanding. Stored K3 mode performs reads only against the app; the explicit
`--unchanged-only` mode also submits existing terminal revisions to verify reuse.

K1 uploads **one file per request**, at most two concurrently, and caches PDF downloads by SHA-256. K2/K3 select the
existing source/revision identities. Results are written beneath `eval/out/k0/`, `eval/out/k1/`, `eval/out/k2/` and
`eval/out/k3/` (git-ignored); filenames vary by mode. Nonzero means a check failed or required preparation/evidence is
missing. No eval success implies deployment or future-contour acceptance.

K2 model rows report known/unknown tokens, recorded bounds, first-token/total time, citations/invalid labels and terminal
state. K3 reports persisted per-revision calls, tokens, provider usage when available, wall time and kept/dropped reasons;
a second unchanged pass must show no dispatch. Historical cost is retained without inferring a price or treating it as
additional spend by a read-only run.

## Contour-specific rules

- **K1:** compare three random R2 range reads per source byte-for-byte with the full canonical text.
- **K2:** C1–C4 and O8 are hard. Open-answer review remains human. The first run establishes timing baselines.
- **K3:** claim count and model self-reported confidence are diagnostics only. Hard checks are exact quote ranges,
  numeric support and the [anchor table](arxiv-10/questions.md#k3--якоря-дистилляции) for Transformer, ResNet and LoRA,
  plus actual automatic claim-mode C1–C4. Anchors count only source-specific exact claim quotes with the required
  conditions, never generated digest. Stored turns must report `contextMode=claims`; native smoke is not that journey.
- **K4 and later:** material, commands and acceptance arrive with their contours. Follow [MAP](../docs/MAP.md);
  planned search corpora and legacy golden tests are not current replacement acceptance.

Keep one script per contour. Do not introduce a second test framework or mocks for capabilities that do not exist.
