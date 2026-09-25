# D1 schema ownership

`core/migrations` is canonical compact state. `search/migrations` is a rebuildable exact/FTS safety
projection. One agent owns each migration sequence. Never edit an applied migration; add a numbered
migration and a compatibility/readback test. Model, HTTP, R2, Google, and AI Search calls are forbidden
inside D1 transactions.

## Expression-depth compiler guard

Run `pnpm d1:depth` (or `node infra/d1/check-expression-depth.mjs`) before publishing SQL changes.
It also starts `check`/`check:affected`; independent Ubuntu/Windows CI jobs run it without waiting
for source budgets or behavioral suites. No result is ignored or converted into a successful gate.

The build-time wrapper requires Python >=3.11 with SQLite >=3.45 (CI selects Python 3.13). It uses
stdlib only, no package installation, remote database or Worker runtime dependency. It sets
`SQLITE_LIMIT_EXPR_DEPTH=100` **before** applying both migration chains to separate empty databases.
An isolated compiler calibration checks that a 120-term trigger compiles at 1000, fails at 100,
and that removing the trigger restores compilation. Statement caching is disabled.

`EXPLAIN` compiles INSERT, first-column UPDATE, all-column UPDATE and DELETE for every trigger-bearing
table. All-column UPDATE activates UPDATE OF guards. It also compiles every view SELECT and the
supported INSTEAD OF writes for writable views. Probe statements are never executed. Failures print
only the store, object/shape or migration filename and a bounded error category, not SQL or row data.
Exit 1 means a schema compilation failure; exit 2 means missing tooling or an invalid compiler setup.

This is the depth-100 check for #293/#294, **not full D1 emulation or behavioral acceptance**. It does
not prove authorization, concurrency, readback, native runtime limits or every dynamically constructed
application query. The real-workerd jobs and S91/S92 acceptance remain required. A forward migration
must repair the existing failures; do not edit old migrations or raise the limit to make this pass.
