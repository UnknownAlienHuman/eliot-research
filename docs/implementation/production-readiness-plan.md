# Release and schema transitions

Current implementation decision, checked 2026-10-21 against `main@b920ea2f`. Runtime cutover is not complete.
[The manifesto](../architecture/ELIOT_RESEARCH.md) selects the product; [the plan](backend-entrypoints.md) selects work.
This replaces the historical full-product/Rust-first release programme, not the existing deployment tools by itself.

## Three different observations

| Question | Evidence | Not evidence |
|---|---|---|
| What can this build offer? | Actual route/handler composition and explicit configuration | A registered filename, source comment or old ER packet |
| Can this operation use its resources now? | Bounded read-only observations of its required resources | A binding name, successful upload or a global slice label |
| Does the owner journey work? | Its result on the named build/environment, with limitations recorded | Typecheck, dry-run, HTTP 200 or Workflow completion alone |

A source-code change, a deployment and a product acceptance are separate actions. Do not run remote provisioning,
change secrets, apply migrations or buy model calls just to inspect capabilities. A search/model/connector outage
blocks operations using it, not unrelated reads of retained reports, sources or Wiki. Authorization/deletion failures
remain mandatory at the affected disclosure boundary; they are not optional freshness failures.

## Why the current release gate must change

The inspected source still has four overlapping authorities:

- `apps/eliotr-core/src/composition-root.ts` declares runtime capabilities;
- `scripts/check-launch-code.mjs` interprets its TypeScript syntax and requires broad legacy slices, including
  `FEDERATION`, regardless of the selected concrete integration;
- `scripts/lib/launch-operation-composition.mjs` walks factories/aliases to infer callable handlers;
- `implementation-status.json` and `check-implementation-status.mjs` maintain exact source-comment/status/packet
  correspondence. Maintenance deployment also reads that registry via `readFullReleaseBlockers()`.

None is a proof that a user operation works. Removing only one AST condition leaves the competing interpreters.
Do not extend them to recognize more syntax, turn every registry row green, or hide actual unavailable operations.

There is also a narrower readiness defect: `readiness.ts` converts every D1 read error into `null`, then reports
`*_SCHEMA_NOT_APPLIED`. Its accepted `core-v11-owner-orientation` marker predates later migrations, including Wiki
outbox removal. The marker alone cannot establish their presence or the required table shape. Deployment already
has a separate applied-name reader in `scripts/lib/deployment-migrations.mjs`; preserve that useful check.
These are source findings, not a statement about the actual production database.

## Replace the interpreters, not the deployment checks

1. Extract the pure `capabilities()` calculation into `apps/eliotr-core/src/capabilities.ts`. Pass public configuration
   facts and the existing route table explicitly. Keep one concrete function, not a plugin/capability registry or
   another hand-maintained list of handler names. The Worker calls it; tooling imports its emitted module from the
   same checked build without importing the Worker entrypoint, starting bindings or reading secrets.
2. Move `deploy-cloudflare.mjs`, `provision-cloudflare-core.mjs` and `deployment-maintenance.mjs` to that value.
   Keep transport selection, target identity, safe route/auth comparisons and authenticated post-deploy readback.
   A declared or configured feature is not promoted to healthy or production-ready by this function.
3. Stop parsing schema constants from TypeScript source. Share the required schema values with `readiness.ts` through
   ordinary exports. At deployment, compare the existing `d1_migrations` applied-name set with the selected migration
   files; do not accept only the largest filename or invent another generation ledger. For a changed table, verify
   the needed shape/query as part of that cutover. A local SQL digest does not prove which bytes ran remotely.
4. Keep health reads bounded and operation-specific. Missing required schema, incompatible schema and observation
   failure have different outcomes. Unknown observation never permits initialization, repair or migration. Do not
   enumerate the entire schema, open every report or call a model on each health/navigation request.
5. With callers moved, remove `readFullReleaseBlockers`, status-registry dependencies, `check-implementation-status`
   and its source sentinels, AST-only capability/factory/schema parsing and their exclusive fixtures. Keep only useful
   value validation/CLI glue from `check-launch-code.mjs`, or move its remaining consumers and delete it entirely.
   Update package/CI callers and old entrypoint documents in that integration; no compatibility command or PASS stub.

Do not add a new service, signed receipt inventory, release DSL, config interpreter or mandatory status file.
A normal PR/build log can name what changed, what was checked and what is still unknown. The current tooling and
actual deployment authorization remain in force until this code replacement; editing this document bypasses neither.

## Small deployment path

Keep the pinned Wrangler toolchain and existing one-Worker topology. The target is build → inspect affected changes
→ explicitly apply approved deployment/migrations → authenticated readback. Use native Worker version/deployment
identities and one selected configuration, not a bespoke promotion/signature framework.

Before a remote effect, identify the actual account, Worker, database/resource IDs, configuration, built assets and
pending schema changes. Do not silently provision a missing dependency, broaden Access or switch the provider.
Use the existing read-only migration inspection; applying migrations is a separately explicit operation.

Verify the selected compiled artifact locally, then confirm the actual deployed version, routes/authentication,
required bindings and affected journey. A local binding proxy is an emulator, not live evidence. A capability
preview endpoint must not become an unauthenticated path to private data or paid work.

Ordinary same-schema updates need a known compatible prior Worker version. A breaking source/API/schema cutover
needs the transition below. Native gradual deployment is not permission to run incompatible old/new writers against
one database. No automatic restore or rollback to a version whose data contract no longer holds.

## Destructive data cutover without permanent legacy

Choose a bounded maintenance window for the affected write path when a direct incompatible conversion is smaller
than maintaining two implementations. This is an explicit deployment decision, not permission to reset the product.

- Stop new affected writes/admissions, including relevant Queue/cron producers, and settle or explicitly stop affected
  active work without repeating paid effects. An empty browser is not proof that durable writers have drained.
- Inspect actual retained rows and the applied migration ledger. Capture a usable recovery point and retain required
  immutable R2 bytes; do not schedule their deletion during the rollback window.
- Convert once, verify identities/counts/heads/citations and the affected query, then switch server/client together.
  A failed conversion stays closed with diagnostics; it never silently chooses between conflicting saved revisions.
- Remove predecessor callers and schemas when their migration is verified. Retain a recovery artifact only for the
  bounded transition, not a permanent fallback reader or old executor. Clear/reopen old browser sessions safely;
  never resubmit an uncertain write from an obsolete tab.
- Resume the selected write path only after readback. If new writes already exist, prefer a forward correction;
  restoring old D1 state is a separate data-recovery decision that must account for those writes and current deletion
  state. Restoring metadata cannot recover already-purged R2 bytes or undo a provider charge.

Worker rollback changes code/configuration/assets, not D1/R2 contents. Durable Object class lifecycle changes can
also prevent rollback across the change. Record a realistic recovery option for the actual migration, not merely
“keep old bundle.” Do not promise a global atomic deployment across Worker, D1, R2, Queue and external providers.

## Acceptance of the assembled product

Use a bounded representative corpus and the exact selected provider/model/settings. Check the actual owner journeys:

| Journey | Required observation |
|---|---|
| Import/project/read | Exact retained source opens; empty projects remain visible; indexing is separate |
| Ordinary answer | Progressive public text, one intended generation, saved report and exact citation reopen |
| Explicit deep research | Bounded search/read actions, visible progress, honest partial result and cancellation |
| Wiki/Inbox | Real continuation, owner decision or direct edit, one revision and visible expected-head conflict |
| Connected agent | Actual connection, one accepted task and its result under the selected access boundary |

Also check foreign/expired access, source deletion, duplicate delivery, uncertain acknowledgements, concurrent edits,
reconnect/slow subscribers and a selected dependency outage on the assembled paths. Use retained focused cases;
do not add a universal acceptance engine or run model judges around every answer.

Measure first visible text and final save separately; record total model/tool calls, D1/R2 operations and failures.
State corpus size, cold/warm conditions and cache hits. A cached report open is not fresh generation latency.
Use the current agreed performance/bundle limits; source-line reductions and emulator timings are not live savings.

The release note identifies build/environment, affected journeys, checks actually completed, known limitations and
recovery/data-transition status. Existing CI remains useful evidence within its scope. No mandatory all-family Rust
port, universal federation, Drive Exchange, backup platform or canceled search-generation programme is restored.

## Platform references

Checked 2026-10-21; use the installed toolchain, not an unreviewed upgrade:

- [Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/): versioned
  code/assets/configuration are distinct from associated storage state.
- [Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) and
  [Durable Object lifecycle changes](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/): recovery has resource/schema constraints.
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and
  [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/): use the native applied-migration ledger
  and point-in-time recovery where available; neither restores other products or external effects.
- [Wrangler API](https://developers.cloudflare.com/workers/wrangler/api/): local binding proxies are not proof of
  production behavior. Native tooling is a dependency, not another Eliot abstraction layer.
