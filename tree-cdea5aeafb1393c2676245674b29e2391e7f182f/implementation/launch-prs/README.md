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
| 08 Erasure / recovery / operations | 08-recovery.md | 01–07 plus 09 promoted kernel for final dependency/rollback closure |
| 09 Rust authority | 09-rust.md | parallel by stable family; integrate current TS tests |

Each plan is introduced in its own draft PR under this directory, so not-yet-merged plans are found
on the corresponding PR branch. #89 is merged as an explicitly requested tested checkpoint; unfinished Library work is in #98.
The initial parallel local tasks and remaining dependencies are in [agent-start.md](agent-start.md). Implement one bounded checkpoint per commit with a negative test.
Do not merge a theme as complete while mandatory code remains pending. An explicitly owner-authorized
checkpoint merge must preserve its unchecked acceptance and linked open follow-up issue. Do not label code-only/local results
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


## Integration handoffs

Admission does not imply index readiness. Topic 02 must execute the actual local outbox/projection path
with cron absent and remote AI disabled, then prove local lexical/exact fallback independently of
semantic readiness. Topic 03 consumes admitted coordinate maps, not metadata guesses. Topic 04 records
unknown paid effects rather than retrying with a new identity. Topic 05 pins an independent peer contract
client. Topic 06 separates non-published drafts from publication and rechecks authority at head CAS.
Topic 07 must not treat a service token as a source grant; its unscoped catalog stays withheld.
Topic 08 assembles local code/recovery evidence before the first complete staging trial, then records
actual live receipts; the two gates must not depend circularly on each other. Topic 09 preserves each
integrated family's existing canonical bytes and schema rules before per-family Rust promotion.


## Cloudflare execution handoff

[cloudflare-handoff.md](cloudflare-handoff.md) assigns concrete account-only work to the existing
#89–#97 PRs, including target approval, prerequisites, exact observations, negative cases and redacted
receipts. No additional queue branches are needed. The current status is BLOCKED by mandatory code;
local namespace setup and known-operation reload recovery do not finish Library, retrieval or research.
The account agent must not mistake unfinished local code for a credential-dependent test.
