# Managed generation registry transaction qualification, 2026-10-11

This is a bounded S91.6 backend checkpoint over the actual local SEARCH_DB.
It does not qualify the AI Search provider, purge-preserving rollback, full
S91/S52, S92 or a release.

The new `index-generation-promotion.test.ts` binds
`createAiSearchGenerationRegistryService` to
`createD1AiSearchGenerationRegistryStore(env.SEARCH_DB)`. Before the cases, the
fixture applies the canonical Search migrations with `applyD1Migrations` and
the actual `SEARCH_MIGRATIONS` binding. Fault wrappers delegate real store
reads and compare-and-swap calls; they inject acknowledgement/readback faults
at the boundary. Observation counts are controlled local fixture inputs.
There is no live provider call, copied production SQL or replacement database.

Seven cases passed once on the final source:

1. Each durable authority change performs one compare-and-swap; replay adds none.
2. Promotion persists the exact revision, digest and serving head.
3. Logical replay retains authority bytes and the compare-and-swap count.
4. Insufficient or inconsistent observation refuses promotion and preserves the head.
5. A stale expected head and a genuine competing CAS winner cannot cause partial mutation.
6. Committed promotion with a lost acknowledgement reconciles through durable readback.
7. Missing authoritative readback after a started CAS remains WRITE_UNCERTAIN,
   with no internal reapply.

Final owning TypeScript diagnostics and scoped ESLint passed. The native run
completed at 2026-10-11T20:43:43.967Z, exit 0, seven of seven cases, using a
bounded private Vitest configuration with local bindings, canonical migrations,
source aliases, one runtime worker and the existing port guard. Its configuration
is retained as evidence, not a new production configuration. The ordinary Core
test glob discovers the two new public test files; the assembled project runner
has not been replayed as part of this checkpoint.

The first native attempt failed because the source fixture omitted Search
migration setup. That attempt, the earlier dependency-resolution diagnostics
and the original leaf sources remain retained. The parent added the same
`applyD1Migrations` setup already used by the existing retrieval fixture, then
ran the corrected seven cases once. Passing final cases were not repeated.

Evidence is retained under
`.eliotr-state/backend-full-20261008/s91-managed-registry-transaction-root-20261011/`:
`typescript-r3.json`, `lint-r3.json`, `native-r2.json` and their original output.
Publication and independent final-source review remain separate from these
observed local results. No stage or whole-project completion follows from them.
