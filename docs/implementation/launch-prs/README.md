# Launch PR series

Baseline: `92118fa010ea0c455356f11c98d279be781c3873` (2026-09-05). Owner requested nine separate PRs.
All theme PRs target `main`; they are not a stack. Refresh from current main before implementation.
This index groups existing work packets; it does not create duplicate authority or replace owned paths.

| Theme | Plan | Required integration predecessors |
|---|---|---|
| 01 Library / source ingest | 01-library.md | none; reuse existing ingest/session |
| 02 Content retrieval | 02-retrieval.md | 01 for populated UI; existing scope/evidence ports |
| 03 Full Corpus Lens | 03-corpus-lens.md | 02 for exact evidence navigation |
| 04 Research / durable jobs | 04-research.md | 02; 03 for protocols using structural navigation |
| 05 Memory OS federation | 05-federation.md | 02 and 04 for executable research jobs |
| 06 Wiki / reports / changes | 06-wiki-reports.md | 02 and 04 for publication |
| 07 Drive / Google | 07-google.md | 01 for canonical import; no reverse authority |
| 08 Erasure / recovery / operations | 08-recovery.md | 01, 04, 05, 06, 07 for final dependency closure |
| 09 Rust authority | 09-rust.md | parallel by stable family; integrate current TS tests |

Each plan is introduced in its own draft PR under this directory, so not-yet-merged plans are found
on the corresponding PR branch. Only topic 01 is initially selected for implementation; the others
are queued and unclaimed. Implement one bounded checkpoint per commit with a negative test.
Do not merge a theme while mandatory code remains pending. Do not label code-only/local results
LIVE_QUALIFIED. First complete staging trial and production release are separate gates, governed by
`../production-readiness-plan.md`. Optional Slice 7 is not added to this series.

Shared edits (composition root, routes, manifests, CI, migrations, status/gap records) require existing
packet integration permission. Allocate migrations against current main; do not copy competing fixtures
or barrels. All PWA work belongs to ER-25; a theme may delegate narrowly named panel/transport tests,
not another theme's UI files. One active implementation worktree per agent; drafts are queue records.

Every theme requires frozen install, lint, strict typecheck including Workers fixtures, packet and
boundary/budget gates, negative tests, Worker/PWA builds, and exact-head CI. Rust changes additionally
require all Rust gates. Check local Linux/Windows boot and browser-level user loops for changed UI.

Release verification is shared, not omitted as a tenth feature: each theme supplies representative
RU/EN/code/table tests, permission/purge/failure cases and cost/budget evidence. Topic 08 assembles
T4/T5/T6, restore and rollback checks; topic 09 supplies Wasm performance and promotion evidence.
No partial product deployment, mock provider success, hidden auth bypass or launch-gate removal.
