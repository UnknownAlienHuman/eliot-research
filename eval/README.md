# Eval — fixed material for contour acceptance

Every contour in [MAP](../docs/MAP.md) is accepted by running `pnpm eval <contour>` against a running Eliot (local or
deployed) on the material in this folder. These scripts are the product's tests: they drive the real system through
its API or MCP, measure, and print a table that goes into the PR description.

## Material

| Folder | What | Used by |
|---|---|---|
| `arxiv-10/` | ten well-known ML papers (`sources.json`: arXiv IDs and PDF URLs), twelve questions with expected points (`questions.md`: O1–O8 open, C1–C4 exact), and the NotebookLM / old-Eliot baseline from 2026-10-16 (`baseline.md`) | K1, K2, K3, K4, K6 |
| `ru/` | 2–3 open-access Russian papers (URLs + short expected facts), added in K1 | K1, K2 |
| `library-200/` | 200 arXiv IDs plus ten "needle" questions with the expected paper and section, added in K5 | K5 |
| `../tests/golden-corpus/` | twelve small legacy cases for tricky grounding (recommendation vs decision, numbers with conditions, superseded facts, absence, prompt injection, Russian). Convert to plain `{question, sources, must_contain[], must_not_claim[]}` in K2 and use as an extra check; drop its evidence-handle and coverage fields | K2 |

PDFs are downloaded by the scripts from `sources.json`; they are not committed.

## Scripts

`scripts/eval/<contour>.ts`, run with `pnpm eval <contour>` (`tsx`). Configuration from the environment:

- `ELIOT_URL` — base URL (`http://localhost:5173` for local dev with the local-dev actor, or the deployed host);
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` — an Access service token for a deployed host;
- `ELIOT_EVAL_PROJECT` — project name to create or reuse (default: the corpus name).

Each script:

1. creates or reuses the project and uploads the corpus through the public API (idempotent: existing sources are reused);
2. runs its checks;
3. prints a Markdown table to stdout and writes details to `eval/out/<contour>-<date>.md` (git-ignored);
4. exits non-zero when an automatic threshold fails.

Automatic measurements per contour are listed in MAP. Answer quality on open questions is judged by the owner against
`questions.md` and `baseline.md`; a script may add an LLM judge score per expected point as a hint, never as the gate.

Keep the scripts small: one file per contour, shared helpers in `scripts/eval/lib.ts` (HTTP client, upload, polling,
table printing). No test framework, no mocks.
