# ADR-0009: Separate control-plane deployment from runtime cost authority

- Status: accepted for the scoped ER-26 deployment and migration-operation amendment.
- Date: 2026-10-03.
- Scope: guarded deployment of an existing Worker and a separate bounded D1 migration operation.

## Context

The exact Cloudflare billable-usage envelope still has 18 counters that are `UNKNOWN`. Those
counters remain required wherever the existing heavy-operation policy requires them. They do not
establish whether an already provisioned Worker has the exact configured identity, bindings,
schema, assets, and active-version readback required by a guarded deployment. Resource creation,
AI Search indexing, model execution, and other heavy operations keep their existing operation
policies.

ER-26's former step 6 combined applying migrations with a Worker deployment. The two effects have
different identities, review inputs, and recovery rules, so migration work and Worker deployment
must have separate operation records.

## Decision

1. A guarded deployment of the existing `eliotr-core` Worker does not require an exact 18-counter
   billing envelope. The operation still requires its existing account, Worker, resource, config,
   asset, and authorization checks. It runs the normal single-step Wrangler deployment, which
   immediately sends the selected Worker version to 100% traffic, then requires exact active
   deployment and asset readback. This is not a zero-cost or zero-impact operation.
2. The Worker deployment operation never applies D1 migrations. Its four resource children run
   `--verify-existing`, which performs GET-only exact readback and fails for missing or drifted
   resources. It validates the complete D1 migration ledger and the source-required Core and
   Search schema generations before upload. A mismatch stops deployment. Resource creation remains
   in its separate provisioning path with its existing admission controls.
3. D1 migration application is a distinct `migrate-cloudflare-d1.mjs --plan <intent.json>
   --confirm-live` operation. This bounded operation also does not require the exact 18-counter
   billing envelope; its explicit risk review, exact target and SQL pins, count/byte/time bounds,
   pre-effect Time Travel bookmark and reconciliation are its operation-specific controls.
   Migration application can consume resources and is not a zero-cost operation.
   Its exact versioned intent pins account, generated config digest,
   database binding/name/UUID, the entire ordered pending migration suffix, local SQL hashes and
   bundle digest, risk review, schema probes, and count/byte/deadline/runtime bounds. The command
   rechecks those inputs and the pending ledger immediately before the effect. Local `--plan`
   inspection without `--confirm-live` makes no Cloudflare or Wrangler calls.
4. The migration operation's SQL classifier accepts only its explicit bounded DDL and metadata
   forms. It rejects rebuild/copy/backfill operations, unsupported data changes, and indexes on
   pre-existing tables. Every accepted migration must have its required schema probes, including
   absence or an exact reviewed initial definition for every created object and the expected final
   definition. Case-insensitive pre-effect schema inspection rejects conflicting objects before SQL
   application or ledger advancement. A current
   D1 Time Travel bookmark is recorded before application; it is evidence of the observed bookmark,
   not a newly created backup. Timeout, cancellation, or lost acknowledgement after start remains
   `UNKNOWN`; partial ledger progress is retained and reconciled. It never restores or reapplies a
   partial migration automatically. A new reviewed intent is required to continue.
5. Full release remains the default deployment purpose and retains `assertLaunchCodeComplete`,
   `pnpm check`, the PWA build, generated binding types, Wrangler dry-run, and the full release
   gates. Explicit `--maintenance` records the current full-release blockers and source-budget
   findings, then runs meaningful compile, lint, actual repository boundary checks, supplemental
   negative boundary fixtures, build, binding, and artifact gates; those gates still block on failure.
   Actual source/configuration file membership and bytes are captured before profile inspection and
   gates, including installed runtime dependency inputs. Generated configuration is pinned after
   exact resource readback; the generated-config dry run emits an explicit metafile and prepared
   bundle. Metafile inputs must belong to the captured set, and unchanged prepared bytes are uploaded
   with `--no-bundle`. These bounded local correspondence checks do not attest compiler internals or
   make the remote operation atomic. A maintenance receipt reports its purpose and does not qualify
   a full release.
6. Maintenance pins the current active Worker identity and authenticated capability profile before
   upload. The source-derived candidate profile must preserve slices, routes, Google transport,
   federation settings, orientation limits, and safety invariants. Before deployment-authority
   synchronization, the uploaded Worker must match the pinned candidate profile and generation;
   both are read again after synchronization. Existing deployment authority CAS and readback remain
   in force. Maintenance cannot enable additional slices or weaken evidence/completion invariants.
7. Model calls, AI Search creation/indexing/query, Vectorize, and other heavy operations retain
   their current authorization, usage admission, budget, cancellation/idempotency, and qualification
   controls. This decision creates no universal usage bypass or new permission framework and does
   not alter ADR-0007.

## Platform consequences

Cloudflare versions contain Worker code, static assets, bindings, and compatibility settings;
attached D1/R2 state is not versioned. Standard `wrangler deploy` creates a version and immediately
sends it to 100% traffic. A Worker rollback creates a deployment of an older version, but does not
roll back connected data. Changed or deleted bindings and Durable Object lifecycle changes can also
prevent rollback. Code rollback therefore does not replace data recovery or compatibility planning.

D1's migration system records names in `d1_migrations`. Exact names do not prove the remote SQL
bytes or schema shape, so the migration operation additionally pins local bytes and checks declared
schema probes. Deployment checks exact remote migration names plus the required schema-generation
markers. Cloudflare Time Travel keeps automatic bookmarks and exposes a current bookmark; recording
it does not create a fresh backup. A restore changes database state and cancels in-flight queries,
so restore remains an explicit manual recovery action rather than automatic rollback.

Cloudflare budget alerts send notifications and do not pause or cap usage. The published Workers
script upload limit is 64 MiB uncompressed. Repository source ceilings and the S90 compressed
Worker target (4 MiB) are separate project gates and remain unchanged. The 18 usage counters remain
`UNKNOWN` under the current qualified source matrix. Current source-budget findings remain
maintenance/release-check findings; they are not the Cloudflare upload limit and maintenance
receipts must report them honestly. Full S92 and live product acceptance remain pending.

## Official references

- [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Billing budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)
