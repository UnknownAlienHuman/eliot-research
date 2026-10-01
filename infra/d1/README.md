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
the pinned TypeScript AST extractor from the frozen workspace install and Python stdlib SQLite;
there is no remote database or Worker runtime dependency. It sets
`SQLITE_LIMIT_EXPR_DEPTH=100` **before** applying both migration chains to separate empty databases.
An isolated compiler calibration checks that a 120-term trigger compiles at 1000, fails at 100,
and that removing the trigger restores compilation. A missing-table negative calibration also
proves the application compiler fails on invalid SQL. Statement caching is disabled.

`EXPLAIN` compiles INSERT, first-column UPDATE, all-column UPDATE and DELETE for every trigger-bearing
table. All-column UPDATE activates UPDATE OF guards. It also compiles every view SELECT and the
supported INSTEAD OF writes for writable views. Probe statements are never executed. Failures print
only the store, object/shape or migration filename and a bounded error category, not SQL or row data.
The same gate inventories application `prepare(...)` calls in Core and package source, evaluates
recoverable literals/registered variants without executing application code, and compiles them with
inert placeholder bindings. Partial static/runtime sites remain in the unresolved inventory;
shadowed names and unknown branches cannot masquerade as recovered constants. Fixture-only files
are reported separately. A query currently passes if **either** Core or Search compiles it. This
checks SQL shape, not which D1 binding actually receives that query; binding-aware target
qualification and runtime-built variants remain work. Per-schema candidate rejection is diagnostic,
while rejection by both schemas fails the gate.

Exit 1 means a schema or recovered application-query compilation failure; exit 2 means missing tooling or an invalid compiler setup.

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

On the 2026-10-01 local checkpoint (Node 25.6.1 / TypeScript 6.0.3 / SQLite 3.50.4), the
depth-100 compiler checks 96 Core migrations, 94 trigger-bearing tables, 22 views and 399
generic statement shapes with zero failures. Search's four migrations compile. The installed
source extractor recovers 780 SQL expressions: Core compiles 739, Search compiles 69, and all
780 compile against at least one candidate schema. It explicitly records 100 unresolved sites
and seven fixture-only files; output lists at most 30 unresolved locations plus an omitted count.
These are compile-only observations, not product requests, native D1 qualification, binding-aware
target verification or exhaustive dynamic-SQL coverage. Native and integration/negative/concurrency
acceptance remain #294/S91/S92 work. The historical 711-query count is superseded by this
reproducible source inventory.
