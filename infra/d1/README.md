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
application query. The real-workerd jobs and S91/S92 acceptance remain required. Migration 0084
repairs the reviewed chain; do not edit old migrations or raise the limit to make this pass.

## 0084 authority-chain repair

The forward migration decorrelates effective-scope/workflow/recovery lookups, compacts composite
identity equality and separates checkpoint invariants within one atomic trigger invocation. It keeps
legacy/delegated branches disjoint and preserves semijoin cardinality with DISTINCT where joins may
find multiple witnesses. No durable authorization cache, owner bypass, table rewrite or weaker expiry,
purge, revocation, receipt, CAS or cancellation predicate is introduced.

The actual Stop/Recover statements also use shallow same-operation joins. Their 18 fence bindings,
original-owner exception, independent owner-machine cancellation and effective-execution requirement
for recovery remain unchanged. Each join is pinned to the unique run operation; it cannot multiply
recovery reservations. The grant writer retains an insertion failure through exact readback: a matching
row reconciles a lost acknowledgement, while an unconfirmed write/read failure is a bounded 503 with
retryable=false. Proven no-match without a storage failure retains the existing 403. Internal causes
are not exposed through HTTP/MCP error text.

On the reviewed Node 22.16.0 / TypeScript 6.0.3 / SQLite 3.46.1 checkpoint, the unchanged depth-100
compiler checks 83 Core migrations, 78 trigger-bearing tables, 12 views and 325 statement shapes with
zero failures; Search's four migrations compile. Additional source-derived EXPLAIN checks covered
702 statically recovered prepare expressions and nine query/run/artifact scope-grant variants. All
711 compile against the appropriate Core or Search schema. These are compile-only observations,
not executed product requests, native D1 qualification or exhaustive dynamic-SQL coverage. Remaining
runtime-built prepare sites and integration/negative/concurrency acceptance remain #294/S91/S92 work.
