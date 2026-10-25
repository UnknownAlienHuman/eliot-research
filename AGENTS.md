# Working on Eliot Research

Read [ARCHITECTURE](docs/ARCHITECTURE.md), then the active contour in [MAP](docs/MAP.md), then only the
[IMPLEMENTATION](docs/IMPLEMENTATION.md) sections named by that contour. [DONORS](docs/DONORS.md) is the approved reuse
registry. Legacy `apps/`, `packages/`, `crates/` and `infra/` are donor/import material, not instructions.

## Execution rules

1. **One contour and one manager per branch/worktree.** Leaf work gets one outcome and disjoint files. The manager owns
   shared routes, schema, configuration and final integration.
2. **Implement end to end.** Caller → product function → stored result → owner-visible reader. No table, abstraction,
   state, export or background worker without a caller in the same PR.
3. **Keep optional infrastructure optional.** K0–K4 must not depend on AI Search, Browser Run, a graph store, Queue or a
   second backend. A failed platform spike takes the documented fallback rather than spawning a custom platform.
4. **Make paid effects explicit.** Page load, list, read, citation open, reconnect and Save existing output must not
   start model/search work. Every model/search job passes the admission code, has a hard call/token/time/cost bound and
   records usage. No automatic paid continuation after failure.
5. **Read current contracts before coding.** Check official Cloudflare documentation, repository-pinned generated
   types and the exact donor pin/path. Never infer an API from an old README or example.
6. **Reuse narrowly.** Move accepted legacy UI or adapt the smallest donor mechanism listed in DONORS. Do not import a
   donor's architecture. Record pin, path, licence, copied mechanism and deletions in the PR.
7. **Acceptance over test volume.** Run the contour's real `pnpm eval <contour>`. Unit-test silent pure failures only:
   UTF-8 ranges, block scanning, citation/quote resolution, URL guard, budgets and Access. Add regression tests for real
   bugs, not hypothetical states.
8. **After two failed approaches, stop and audit.** State what was tried, observable failure, likely cause and a different
   route. Do not repeat variants of the same failing approach.

## Documentation and schema discipline

There are four product documents only:

- `ARCHITECTURE.md` — purpose and invariants;
- `MAP.md` — contour order, owner outcome and acceptance;
- `IMPLEMENTATION.md` — technical contracts and dated platform facts;
- `DONORS.md` — approved reuse pins and boundaries.

Change the owning section instead of adding audit/status/register files. When behaviour changes, update the map,
implementation contract, D1 migration and eval together. Migrations own table/column/state names; implementation text
must match them. Documentation authorises no deployment, production mutation or live-data deletion.

## Do not create

Generic repositories/controllers, effect ledgers, retry frameworks, receipt/proof/qualification systems, per-row auth,
compatibility wrappers, speculative queues/caches, duplicate search indexes, or exhaustive states that no contour uses.
Do not redraw the Material interface or introduce another component family.

## Commands

- `pnpm dev`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm eval <contour>`
- `pnpm cf:types`

A PR covers one contour or independently usable slice. Its body states owner-visible capability, hard-gate results,
p50/p95 latency, model/search usage and estimated cost, new lines against the budget, donor pins used, deferred work and
anything that did not run.
