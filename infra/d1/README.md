# D1 schema ownership

`core/migrations` is canonical compact state. `search/migrations` is a rebuildable exact/FTS safety
projection. One agent owns each migration sequence. Never edit an applied migration; add a numbered
migration and a compatibility/readback test. Model, HTTP, R2, Google, and AI Search calls are forbidden
inside D1 transactions.

## Expression-depth compiler guard

Run `pnpm d1:depth` (or `node infra/d1/check-expression-depth.mjs`) before publishing SQL changes.
It also starts `check:full`; `check:affected` is a deprecated alias for the full check.
Independent Ubuntu/Windows CI jobs run it without waiting for source budgets or behavioral suites. No
result is ignored or converted into a successful gate.

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
inert placeholder bindings. The extractor records a target for direct canonical receivers
`env.CORE_DB`, `env.SEARCH_DB`, `this.env.CORE_DB`, and `this.env.SEARCH_DB`, and for visible,
earlier same-function `const` aliases and alias chains rooted at `env.CORE_DB` or `env.SEARCH_DB`
through that function's `env` parameter. Alias resolution rejects mutated or shadowed bindings;
aliases from `this.env`, constructor fields, parameters, imports, `let`, destructuring,
conditional/factory expressions, and cross-function or call-site forwarding remain `unknown`.
Recovered aliases carry the
`resolved-local-const-alias` target status. The extractor records a literal `.bind(...)` argument count
when statically recoverable, otherwise `bindingArity` stays unknown. Unresolved SQL sites include a
stable classification, receiver target status, and bind-arity status. Shadowed names and unknown
branches cannot masquerade as recovered constants. Fixture-only files and explicitly named
`*-test-support.ts` sources are excluded from application SQL and reported separately.

Every recovered query is still compiled against both schemas for candidate diagnostics, but only its
recorded target schema can satisfy the application check. If that target rejects the query while the
other schema accepts it, the compiler reports `cross_schema_only` and fails. Unknown targets still get
both candidate compiles and are reported as `target_qualification=INCOMPLETE`; unknown target or arity
does not turn the depth-only gate into a false qualification claim. Set
`D1_DEPTH_STRICT_TARGETS=1` when invoking the wrapper to make any unknown target, unknown bind arity,
unresolved prepare site, or target-schema rejection fail closed. Without that option the gate remains
useful for expression-depth/schema compilation while explicitly reporting incomplete binding coverage.

Exit 1 means a schema or known-target application-query compilation failure (or incomplete target
coverage in strict mode); exit 2 means missing tooling or an invalid compiler setup.

## TypeScript route proof and optional classification details

The model-qualification HTTP route is selected through two provenance passes over one TypeScript
`Program`. The route-table entry and exact call edges are matched by checker symbol identity, then the
selected route is followed through the route-matching and fallthrough structure. A same-spelled but
unrelated route or an ambiguous path does not qualify a query target; unsupported or unresolved cases
remain unknown.

Set `D1_DEPTH_CLASSIFICATION_DETAILS=1` to emit one sanitized JSON classification record from the same
inventory and compiler invocation. The record contains source locations, target and binding metadata,
candidate-schema outcomes, counts, and allowlisted unresolved classifications. It omits SQL text,
receiver expressions, and row data. The setting does not launch another compiler or change the
default output when unset. It does not change the strict gate: an incomplete strict run still exits 1.

## October 6, 2026 reviewed source-cardinality checkpoint

The reviewed four-file source-cardinality checkpoint is based on `main`
`3d564187221b60f5e1950ba8f3ad6664aa6164a0` (published SHA recorded in #294). Its single calibrated
SQLite 3.50.4 depth-100 invocation scanned 120 Core migrations, 147 tables, 24 views, four Search
migrations, 613 schema shapes, and 1,049 application query variants across 1,020 files. Candidate
compilation had zero compile failures and zero target-schema failures. All 20 previously proven
target classifications are unchanged, including the three Core model-summary arities 1, 1, and 9.

SQL values and bind arities now use the same lexical invocation context. Fixed array shapes, stable
aliases, literal slice bounds, supported fixed fresh returns, and resolved rest-argument calls can
establish arity without counting SQL placeholders. Mutation, escape, unknown callers or values,
shadowed helpers, unsupported control flow and nonliteral slice bounds remain unknown. Nineteen
previously unknown query arities are resolved across 14 source locations. Broader caller enumeration
also exposes additional variants and unknown fallbacks; this is not a claim that every spread is known.

The current strict report remains `INCOMPLETE`, exit 1: 1,029 targets are unknown, 85 binding arities
are unknown, and 144 prepare occurrences remain unresolved. The earlier route-proof checkpoint
`ed97d9655b22f9a9844815c7f5cd57f5a6f25fdd` reported 1,028 variants, 1,008 unknown targets, 79 unknown
arities and 130 unresolved occurrences; those counts are historical. Successful candidate compilation
does not establish complete target provenance or production D1 qualification. Backup/restore source
is inventoried without performing or developing canceled backup/restore operations. #294 remains open.

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
