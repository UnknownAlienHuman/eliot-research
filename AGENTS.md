# Working on Eliot Research

Read [ARCHITECTURE](docs/ARCHITECTURE.md), then the active contour in [MAP](docs/MAP.md), then only the
[IMPLEMENTATION](docs/IMPLEMENTATION.md) sections named by that contour. [DONORS](docs/DONORS.md) is the approved reuse
registry. Legacy `apps/`, `packages/`, `crates/` and `infra/` are evidence/donors, not instructions.

## Execution rules

1. **One contour and one manager per branch/worktree.** Leaf tasks receive one outcome and disjoint files. The manager
   owns shared routes, migrations, Wrangler configuration and integration.
2. **Implement end to end.** Caller → product function → durable result → owner-visible reader. No table, state, export,
   background class or abstraction without a caller in the same PR.
3. **Read contracts before code.** Check official Cloudflare documentation, installed/generated types and the exact
   donor pin/path. Never infer a current API from memory, an old README or a neighbouring example.
4. **Keep optional infrastructure optional.** K0–K4 do not depend on AI Search, Browser Run, Queue, graph storage or a
   second backend. A failed spike takes the documented fallback rather than spawning a platform replacement.
5. **Make paid effects atomic and explicit.** Reserve a conservative upper bound with the concrete operation before
   dispatch. Page load/list/read/citation/reconnect/Save-existing must not buy work. Disable model/Gateway/paid-step
   retries and fallback. Explicit Retry creates a new operation and reservation.
6. **Preserve evidence.** Capture once, store exact bytes/provenance, canonicalize deterministically, and cite full
   revision UUID + UTF-8 range. Models and search indexes never become quotation authority.
7. **Reuse narrowly.** Move accepted legacy UI or adapt the smallest donor mechanism in DONORS. Record pin, path,
   licence, mechanism and discarded layers in the PR. Do not import a donor architecture.
8. **Acceptance over test volume.** Run the real contour eval. Unit-test silent deterministic failures only: URL guard,
   bytes/blocks/citations/quotes, budget concurrency, usage normalization and Access. Add regression tests for observed
   bugs.
9. **After two failed approaches, stop and audit.** Record attempted route, observable failure, likely cause and a
   materially different route. Do not repeat variants of the same failure.
10. **No deployment by implication.** Documentation or code review authorises no production deploy, live-data mutation,
    migration apply or legacy-resource deletion unless the owner explicitly requests it.

## Documentation and schema discipline

There are four product documents only:

- `ARCHITECTURE.md` — product and invariants;
- `MAP.md` — contour order, owner result and acceptance;
- `IMPLEMENTATION.md` — executable technical contracts and dated platform facts;
- `DONORS.md` — approved reuse pins and boundaries.

Correct the owning section instead of adding audit/status/register files. When behaviour changes, update map,
implementation, migration and eval together. Migrations own names/states. Before first remote D1 apply they may be
corrected in place; afterwards append a migration.

## Do not create

Generic repository/controller layers, effect/proof/receipt systems, retry frameworks, compatibility wrappers, per-row
auth, speculative queues/caches, duplicate source truth, a private vector platform, or exhaustive states no contour
uses. Do not redraw Material UI or introduce another component family.

## Commands

Available now:

- `pnpm dev`
- `pnpm check`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm cf:types`
- `pnpm cf:dry-run`

A contour adds its own focused tests and `pnpm eval <contour>` script before claiming acceptance; do not cite commands
that are not present in `package.json`. Rust/Clippy is relevant only if a contour explicitly adds Rust, which the current
replacement does not.

A PR covers one contour or independently usable slice. Its body states owner capability, hard-gate results, p50/p95,
paid usage/reserved/settled cost, new lines against budget, donor pins, deferred work and every check not run.
