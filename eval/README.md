# Eval — fixed material for contour acceptance

Every contour in [MAP](../docs/MAP.md) is accepted by running `pnpm eval <contour>` against a running Eliot (local or
deployed) on the material in this folder. These scripts are the product's tests: they drive the real system through
its API or MCP, measure, and print a table that goes into the PR description.

## Material

| Folder | What | Used by |
|---|---|---|
| `arxiv-10/` | ten well-known ML papers (`sources.json`: arXiv IDs and PDF URLs), twelve questions with expected points (`questions.md`: O1–O8 open, C1–C4 exact), and the NotebookLM / old-Eliot baseline from 2026-10-16 (`baseline.md`) | K1, K2, K3, K4, K6 |
| `ru/` | `sources.json` with 2–3 open-access (CC-BY) Russian papers and a few expected facts, added in K1 | K1, K2 |
| `library-200/` | 200 arXiv IDs plus ten "needle" questions with the expected paper and section, added in K5 | K5 |
| `golden/` | created in K2 from the twelve legacy cases in `../tests/golden-corpus/` (recommendation vs decision, numbers with conditions, superseded facts, absence, prompt injection, Russian): plain `{ question, sources, must_contain[], must_not_claim[] }` plus the small source files; evidence-handle and coverage fields are dropped. Report-only | K2 |

PDFs are downloaded by the scripts from `sources.json`; they are not committed.

## Scripts

`scripts/eval/<contour>.ts`, run with `pnpm eval <contour>` (`tsx`). Configuration from the environment:

- `ELIOT_URL` — base URL (`http://localhost:5173` for local dev with the local-dev actor, or the deployed host);
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` — for a deployed host, a service token listed in the Worker
  variable `OWNER_SERVICE_CLIENTS`, so the script acts as the owner (IMPLEMENTATION §2);
- `ELIOT_EVAL_PROJECT` — project name to create or reuse (default: the corpus name).

Each script:

1. creates or reuses the project and uploads the corpus through the public API, skipping files whose SHA-256 already
   appears in the project's sources list;
2. runs its checks;
3. prints a Markdown table to stdout and writes details to `eval/out/<contour>-<date>.md` (git-ignored);
4. exits non-zero when an automatic threshold fails.

Automatic thresholds per contour are listed in MAP; they decide the script's exit code. A contour is accepted only
when the script passes **and** the owner has judged the open-question answers against `questions.md` and
`baseline.md`. A script may print an LLM-judge score per expected point as a hint; that score never decides anything.

Keep the scripts small: one file per contour, shared helpers in `scripts/eval/lib.ts` (HTTP client, upload, polling,
table printing). No test framework, no mocks.
