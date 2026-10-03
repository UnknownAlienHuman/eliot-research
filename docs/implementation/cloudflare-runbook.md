# Cloudflare provision and deploy runbook

**Deployment gate:** `deploy-cloudflare.mjs --confirm-live` defaults to `FULL_RELEASE`, retaining
`assertLaunchCodeComplete`, `pnpm check`, and the full release gates. Explicit `--maintenance`
selects `MAINTENANCE`: it records launch blockers and source-budget findings while still requiring
compile, lint, boundary, build, binding, and Wrangler artifact checks. Both purposes use the guarded
path and standard Wrangler deployment of one Worker version to 100% traffic with exact readback.
Neither purpose applies D1 migrations. The four resource children run `--verify-existing` with
GET-only exact readback; missing or drifted resources fail closed. The existing exact 18-counter
usage envelope is not a prerequisite for this existing-resource deployment, but remains unknown and
remains required by operations whose heavy-operation policy needs it. Apply D1 migrations separately
through the pinned bounded migration operation described below. Resource creation and AI Search
provisioning retain their existing admission controls. Deployment alone never promotes a product
contour to `LIVE_QUALIFIED`. See
[ADR-0009](../adr/0009-control-plane-deployment-and-runtime-cost-authority.md).

This runbook deploys one Worker/PWA contour without committing Cloudflare account state. It is safe to
hand to a deployment agent; no step requires reading the architecture master document.

## Operator identity (non-secret, browser OAuth only)

Operator authentication uses browser OAuth. The automated scripts currently consume the local
Wrangler profile. The explicitly selected official Cloudflare MCP plugin may also use its own
managed browser-OAuth connection for account/API inspection and the gated Access provisioning
transport; it does not export credentials to Wrangler or grant a general deployment capability.
No API key, API token, or service token is used by
the operator flow, and none may be added to tracked
files. The tracked file `infra/cloudflare/operator-profile.json` is an account-neutral template
with fictional placeholders only (protocol `eliotr.cloudflare-operator-profile.v1`). Real operator
values live only in the ignored local profile `.eliotr-state/cloudflare/operator-profile.json`
or in explicit env vars (see your local MCP map, which is ignored and never committed, for
operator-specific endpoints). Verify the template and the local binding before every deployment:

```bash
node scripts/test-operator-profile.mjs
node scripts/test-public-repo-privacy.mjs
```

| Field | Value source |
|---|---|
| Account name | local ignored profile (read back via `wrangler whoami`) |
| Account ID | local ignored profile; exact 32-hex readback, never committed |
| Operator email | local ignored profile (single owner email) |
| Wrangler profile | local browser-OAuth profile (example: `default`) |
| Workers.dev subdomain | local ignored profile |
| Worker | `eliotr-core` |
| Hostname (only public route) | local ignored profile (`<worker>.<subdomain>.workers.dev`) |
| `ELIOTR_CUSTOM_DOMAIN` | `0` (workers.dev only; Custom Domain out of scope) |
| Access team origin | local ignored profile (`https://<team>.cloudflareaccess.com`) |
| Access owner email (only) | local ignored profile (single exact owner email) |

Single account, single Worker, single hostname. Any drift between the supplied expectations, the
local profile, and live readback fails closed before any Cloudflare mutation. Browser login and
any financial/billing consent cannot be automated: a human completes them in the browser; scripts
only consume the resulting local OAuth profile. A $1 usage alert is advisory monitoring only and does not enforce a billing cap.

### Browser-OAuth source compatibility

The owner granted every scope requested by Wrangler 4.127.1, and normal browser login was
restored on 2026-10-03. This does not establish compatibility with every Cloudflare API:
[full application access grants the application's requested scopes](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/).
Wrangler's [scope catalog](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/core/scopes.ts)
includes account analytics and D1 write access, but no Billing scope. The
[Usage v2 specification](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v2/)
is Alpha/Restricted and does not document a Wrangler OAuth grant; token-based billing access
has separate [Billing Read/Edit permissions](https://developers.cloudflare.com/billing/understand/billing-permissions/).
The default collector therefore excludes both Billing routes. It does not retry a denied route
through another credential, method, or transport.

The historical 2026-09-09 collector label `AUTH_SCOPE_DENIED` for any 401/403 was too specific.
Current diagnostics distinguish HTTP 401 authentication failure, HTTP 403 authorization denial,
HTTP 404 resource not found, other HTTP failures, and a missing/invalid status. Status alone
does not prove missing owner consent, a missing scope, endpoint entitlement, or unsupported
OAuth. Source limitations describe unsupported counter coverage separately. Errors retain only
fixed safe codes and numeric HTTP status; raw provider bodies, errors, URLs, and credentials are
excluded. Unknown quantities seal admission and never become zero.

The user selected the installed official Cloudflare MCP plugin on 2026-09-09. Reconnecting its
existing project-local server with `codex mcp login cloudflare-api` restored managed OAuth.
A fresh managed MCP client discovered `search`, `execute`, and `docs`, and actual account,
Zero Trust organization, Access application and identity-provider reads returned HTTP 200.
The earlier Wrangler Access 403 therefore does not mean the account is inaccessible. No global
MCP registration or static-token fallback is necessary. The provisioner keeps Wrangler as its
default and supports the explicitly selected MCP transport described below.

Both `/accounts/{account_id}/billable/usage` and `/accounts/{account_id}/billing/usage` still
returned Cloudflare error `10000` through MCP. The [official Usage v2 specification](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v2/)
labels that endpoint Alpha/Restricted; the precise authorization or entitlement cause remains
unconfirmed. Keep those counters unknown. Account-specific readbacks belong only in ignored
operator state and the local MCP map.

The local operator policy declares `free-tier` with `paid_overage:false`, while the historical
2026-09-09 account plan readback showed Paid; that policy/account-plan distinction is an unresolved
configuration reconciliation item, and no tier thresholds are inferred here.

### Usage source coverage (2026-10-03)

The canonical snapshot has 19 required metrics. Complete AI Search instance inventory is the
one point-count source; the other 18 remain `unknown` for admission with the current qualified
sources. D1 metadata and documented GraphQL samples are exposed separately as
`readback.provider_results[].diagnostic_values`, with untrusted metric provenance. Their values
cannot mint an admission capability or change the canonical monthly/daily windows.

D1 collection performs bounded list/detail reads and inventory reconciliation. Its `file_size`
sum is observed current bytes across separate reads, with collection timestamps; it is neither
atomic nor a monthly storage quantity. GraphQL observations are bounded, possibly partial,
adaptive samples for the requested interval. Cloudflare explicitly states
[GraphQL analytics is not a measure of billable usage](https://developers.cloudflare.com/analytics/graphql-api/);
[sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/) and
[record/date limits](https://developers.cloudflare.com/analytics/graphql-api/limits/) prevent
assuming complete exact monthly coverage. An empty, truncated, malformed, denied, or
undocumented response never establishes a billable zero.

A fresh 2026-10-03 exact-account `wrangler whoami` verification and a single bounded
Workers GraphQL query returned HTTP 200 with no GraphQL errors and the documented numeric
response shape under the existing OAuth profile. This confirms that transport for that read;
it does not establish every dataset's entitlement or complete billing coverage. The standard
registry collects D1 stock and Workers/D1/Queues/DO analytics separately. R2 operation classes
remain uncollected because the documented `actionType` description does not qualify its literal
mapping to pricing names. No additional transport or credential is substituted for a failed read.
D1 list/detail metadata collection also succeeded under that verified profile, with matching
inventory and file-size readbacks across both passes. Account-specific sizes and identifiers
remain outside tracked documentation; this receipt proves metadata transport, not monthly usage.

| Unknown admission counter | Unit/window | Official read source and precise limitation |
|---|---|---|
| `workers_requests` | requests/month | [Workers analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) `workersInvocationsAdaptive.sum.requests`: adaptive diagnostic only. |
| `workers_cpu_ms` | CPU-ms/month | Same source documents CPU quantiles, not an exact CPU total. |
| `d1_storage_bytes` | bytes/month | [D1 metadata](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/) `file_size`: current stock; GET accepts D1 Read or D1 Write. |
| `d1_rows_read` | rows/month | [D1 analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) `rowsRead`: adaptive observation, 31-day retention. |
| `d1_rows_written` | rows/month | Same source, `rowsWritten`: adaptive observation, 31-day retention. |
| `r2_storage_gb_month` | GB-month/month | [R2 analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/) reports storage maxima; [pricing](https://developers.cloudflare.com/r2/pricing/) uses average daily peak storage. Bucket inventory has no GB-month quantity. |
| `r2_class_a_ops` | operations/month | R2 adaptive operations grouped by `actionType` can diagnose requests; exact billable Class A monthly coverage is unqualified. |
| `r2_class_b_ops` | operations/month | Same limitation for Class B; unknown actions must not be guessed into a class. |
| `queue_ops` | operations/month | [Queues analytics](https://developers.cloudflare.com/queues/observability/metrics/) `sum.billableOperations`: adaptive reads/writes/deletes, diagnostic only. |
| `do_requests` | requests/month | [Durable Objects analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/) `sum.requests`: adaptive observation; [WebSocket billing](https://developers.cloudflare.com/durable-objects/platform/pricing/) uses a 20:1 ratio that metrics do not apply. |
| `do_gb_seconds` | GB-seconds/month | Documented CPU time does not establish billed duration multiplied by memory. |
| `do_sql_reads` | rows/month | No exact account-wide OAuth monthly SQL-read source is qualified; no undocumented field aliases are invented. |
| `do_sql_writes` | rows/month | Same limitation for SQL writes. |
| `do_storage_bytes` | bytes/month | DO `max.storedBytes` is a stock statistic, not monthly storage usage. |
| `workers_ai_neurons_per_day` | neurons/day | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) directs usage monitoring to its dashboard; no documented exact daily API source is qualified. |
| `ai_search_queries_month` | queries/month | [AI Search stats](https://developers.cloudflare.com/api/resources/ai_search/subresources/namespaces/subresources/instances/methods/stats/) report indexing status and managed-instance metadata, not account-wide monthly search usage. |
| `vectorize_queried_dims_month` | dimensions/month | [Vectorize info](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/info/) has no monthly queried-dimension quantity; Wrangler has no documented Vectorize-specific scope. |
| `vectorize_stored_dims_month` | dimensions/month | Per-index `dimensions` and `vectorCount` are current stock, not exact account-wide monthly stored dimensions. |

This source inventory still qualifies neither a complete account ledger nor a release. The existing
18 required counters remain `UNKNOWN`; diagnostic D1/GraphQL samples do not become canonical usage,
and unknown is not zero. Their status does not block guarded deployment of an already existing
Worker when exact deployment readback succeeds. D1 migrations use a separately reviewed bounded
operation and do not acquire a general spend capability from this deployment decision. Resource
creation, AI Search indexing/query work, model calls, and other heavy operations retain their
existing usage-admission policies. The 18 counters stay unknown until exact evidence is qualified;
ADR-0009 does not mint a capability or alter usage authority. Full S92 and live product acceptance
remain pending.

Model calls retain their existing operation-specific budgets, reservations, authorization,
cancellation, idempotency, and qualification controls; the exact usage proof applies where the
existing operation policy requires it. AI Search indexing/reindexing/query work keeps its existing
heavy-operation controls. Read-only verification of an existing AI Search namespace/instance does
not initiate indexing. If an AI Search namespace or instance is absent, its provisioning path
remains behind the existing admission gate before any AI Search mutation; do not create a fresh
instance while that gate is sealed. A Worker deployment can activate behavior that consumes runtime
resources; this change makes no claim that deployment is free or has no operational effect. The
18 counters stay unknown until exact evidence is qualified; this runbook change does not mint a
capability or alter usage authority. Full S92 and live product acceptance remain pending.

## Preconditions

- Node.js and Corepack satisfy the root `package.json` engines.
- The operator has completed `wrangler login` in a browser for the account in the local ignored
  profile (`ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth`). The deployer verifies the active profile
  with `wrangler whoami` against the exact account ID from the local ignored profile before any
  mutation.
- Wrangler remains the default Access transport. For an explicit run through the selected official
  Cloudflare MCP OAuth connection, set `ELIOTR_ACCESS_TRANSPORT=cloudflare-mcp` and provide
  `ELIOTR_CLOUDFLARE_MCP_CWD` as an absolute local Cloudflare project directory. The MCP transport
  requires `ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth` so static-token mode cannot be selected
  accidentally. It starts a volatile Codex app-server context, verifies the exact account by
  readback, and permits only the fixed Access organization/application/policy requests issued by
  `provision-cloudflare-access.mjs`; it never accepts arbitrary MCP code or exports the managed
  OAuth credential. Wrangler continues to own deployment and binding operations.
- The Cloudflare account has Zero Trust enabled.
- No `CLOUDFLARE_API_TOKEN` is required for the operator flow. (A static token remains only for
  non-interactive CI, where browser login is impossible; it is never the documented operator path.)
- `ELIOTR_ACCESS_HOSTNAME` exactly matches the hostname in the local ignored profile (hostname
  only; no scheme/path/wildcard).
- `ELIOTR_ACCESS_TEAM_DOMAIN` exactly matches the team origin in the local ignored profile on
  re-deploy; it may be empty on first deploy (live organization readback wins).
- `ELIOTR_ACCESS_AUDIENCE` is left empty on first deploy: the AUD tag is Cloudflare-generated
  on Access-application create and read back into the ignored receipt. On re-deploy it must
  reconcile exactly with the receipt; a mismatch fails instead of overriding.
- `ELIOTR_OWNER_EMAILS` exactly matches the owner email list in the local ignored profile.
  Never use `everyone` or a generic valid-email selector.

## Environment

```text
ELIOTR_CLOUDFLARE_AUTH_MODE       required: wrangler-oauth (operator browser flow; unset means CI API-token mode)
ELIOTR_WRANGLER_PROFILE           optional: local browser-OAuth Wrangler profile name
ELIOTR_ACCESS_TRANSPORT            optional: wrangler (default) or cloudflare-mcp (managed MCP OAuth)
ELIOTR_CLOUDFLARE_MCP_CWD          required only for cloudflare-mcp: absolute local project directory
CLOUDFLARE_ACCOUNT_ID              required: account ID from the local ignored profile (exact readback)
CLOUDFLARE_API_TOKEN               CI-only; leave unset for browser-OAuth operation (the deployer injects
                                   the short-lived OAuth bearer into child-process memory only)
ELIOTR_ACCESS_HOSTNAME             required: hostname from the local ignored profile (hostname only)
ELIOTR_ACCESS_TEAM_DOMAIN          required on re-deploy: team origin from the local ignored profile;
                                   may be empty on first deploy (live organization readback wins)
ELIOTR_ACCESS_AUDIENCE             empty on first deploy (Cloudflare-generated on create, then read back);
                                   exact receipt AUD on re-deploy; any override attempt fails
ELIOTR_ACCESS_SERVICE_PRINCIPALS   optional comma-separated signed service-token common_name allow-list;
                                    empty denies every service principal
ELIOTR_OWNER_EMAILS                required: owner email list from the local ignored profile
ELIOTR_ENVIRONMENT                 optional: staging|production; live default is production
ELIOTR_STAGING_TARGET_JSON         required for staging live apply: exact dedicated-account declaration below
ELIOTR_DEPLOYMENT_GENERATION       optional; defaults to git-<short-sha>
ELIOTR_CUSTOM_DOMAIN               required: 0 for this profile (workers.dev only; 1 is out of scope here)
ELIOTR_ALLOWED_ADDITIONAL_ACCESS_POLICY_IDS
                                    optional explicit allow-list for reviewed service policies
ELIOTR_ACCESS_SMOKE_COOKIE         optional CF_Authorization value for authenticated HTTP smoke
ELIOTR_SMOKE_BASE_URL              optional; must equal https://ELIOTR_ACCESS_HOSTNAME (optional trailing slash)
```

A staging live apply must provide an ignored local `ELIOTR_STAGING_TARGET_JSON` value with exactly
`protocol`, `isolation`, `account_id`, `protected_account_ids` and `access_hostname`:

```json
{"protocol":"eliotr.staging-target.v1","isolation":"dedicated-account","account_id":"staging-example-account","protected_account_ids":["production-example-account"],"access_hostname":"staging.example.com"}
```

The account and hostname must exactly match the selected deployment environment. The protected
account list must be nonempty, unique and exclude the target account. Missing declarations,
same-account profiles, identity drift and extra approval flags fail before credential loading,
commands or remote calls. Fixed resource names currently support a dedicated account only;
a reviewed same-account profile still needs complete naming and reconciliation support.
The receipt stores declaration/account digests. This destination guard does not establish owner
approval, account isolation remotely, paid usage permission or S94 acceptance. Obtain the explicit
approval for the exact target and deployment window independently before live apply.

See `.env.example` for placeholder shapes (fictional values only). Google credentials, provider
keys, OAuth tokens and Access cookies are secrets. Add runtime secrets with `wrangler secret put`
or approved secret automation; never place them in tracked JSON or `.env` files.

## Browser login, read-only preflight, first deploy, re-deploy

Every mutation in this runbook follows Intent → Attempt → Receipt → Readback → Reconciliation:
the provisioner declares a plan (Intent), performs create-or-verify calls (Attempt), persists an
ignored non-secret receipt (Receipt), re-reads live state (Readback), and refuses drift on the
next run instead of silently overwriting it (Reconciliation). The exact binding (account ID,
hostname, team origin, AUD, owner set) is read back from live state and compared against the
local ignored profile before any mutation; drift fails closed.

Step 0 — browser login (human, one time per OAuth expiry; cannot be automated):

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami   # must show the account in the local ignored profile
```

If `whoami` shows any other account, log in with the correct account and retry. Never paste an
API token to work around a wrong profile; the deployer rejects account mismatch before mutation.

Step 1 — read-only preflight (zero mutating calls; safe on any account state):

```bash
corepack enable
pnpm install --frozen-lockfile
node scripts/test-operator-profile.mjs
node scripts/test-public-repo-privacy.mjs
node scripts/test-wrangler-oauth.mjs
node scripts/test-cloudflare-browser-auth-integration.mjs
ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth pnpm cf:preflight:remote
```

On an empty account the Access preflight reports a `CREATE` plan with `aud: null` and
`GENERATED_ON_CREATE`: the AUD does not exist yet and must not be invented. The foundation
preflight reports `RUN_ACCESS_PROVISIONER_FIRST` until the Access receipt exists.

Step 2 — first deploy (Access provisioner runs before foundation; no manual dashboard step —
the scripts create-or-verify the hostname-based Access application and the single exact-email
owner policy; Worker-level Access stays prohibited for `ResearchSession` WebSockets):

```bash
ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth pnpm cf:deploy -- --confirm-live
```

Lost responses reconcile: a create that succeeded without a usable readback is recovered by
exact-name re-list, never by creating a duplicate. A short-lived OAuth bearer is injected into
child-process memory only; it never appears in argv, logs, or receipts.

Step 3 — re-deploy: repeat steps 1–2 unchanged. The second run replays as `VERIFIED` with no
new mutations when live state matches the receipts. AUD, team origin, owner set, account, and
hostname drift against the prior receipt fail closed; fix the cause (usually: re-run the Access
provisioner after a reviewed change) instead of deleting receipts.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm cf:preflight:remote
pnpm cf:deploy -- --confirm-live
```

`pnpm-lock.yaml` is committed. Always use the frozen lockfile; dependency repair is a separate reviewed
change. `pnpm check` also invokes the pinned Rust gates from `LANGUAGE_RUNTIME_CONTRACT.md`; install that
toolchain and the pinned Cargo tools before running it locally.

`cf:preflight:remote` performs only GET/readback operations. `cf:deploy` repeats local gates, repeats the
remote preflight, then performs create-or-verify provisioning. It writes the account-specific
`apps/eliotr-core/wrangler.deploy.jsonc` locally. The file and `.eliotr-state/` receipts are ignored by
Git.

## Resource behavior

### D1

The provisioner lists by exact database name, rejects duplicates/jurisdiction drift and injects returned
UUIDs into the generated config. The Worker deployer never runs `wrangler d1 migrations apply`.
It identity-validates and dry-runs the generated config, then compares each remote `d1_migrations`
ledger with the exact local migration names and reads the required Core/Search schema-generation
markers. A missing, extra, duplicate, malformed, or pending ledger; a missing schema marker; or local
input drift stops before Worker upload, deployment-authority changes, and a successful receipt. The
local migration bundle hash is recorded separately: ledger names do not prove remote SQL bytes or
schema shape.

### Separate bounded D1 migration operation

Use `scripts/migrate-cloudflare-d1.mjs` only for one explicit, reviewed, bounded migration intent.
This separate bounded operation does not require the exact 18-counter billing envelope. Its
reviewed risk profile, exact SQL/target pins, count/byte/time bounds, Time Travel bookmark and
reconciliation govern this operation; migration application can consume resources. Resource
creation and heavy runtime operations retain their existing admission requirements.
The versioned intent binds the exact account, generated-config digest, database binding/name/UUID,
entire ordered pending migration suffix, per-file SQL hashes, bundle digest, risk review, schema
probes, and maximum migration count, SQL bytes, deadline, and runtime. The operation validates the
local plan without network or Wrangler when `--confirm-live` is absent:

```bash
node scripts/migrate-cloudflare-d1.mjs --plan ./reviewed-core-migration-intent.json
```

Live use requires explicit confirmation and the same plan file:

```bash
node scripts/migrate-cloudflare-d1.mjs --plan ./reviewed-core-migration-intent.json --confirm-live
```

The command checks the exact account and database identity, production/staging isolation, OAuth
profile where selected, full pending migration suffix, config and SQL hashes, and each declared
schema probe. It captures the current Time Travel bookmark, records the attempt before running the
standard remote migration command against the pinned database name, then reconciles both the exact
ledger and schema probes. The bookmark is a readback, not a newly created backup. Ledger names are
not proof of remote SQL bytes. Restore remains an explicit manual recovery action.

The SQL classifier fails closed outside its documented bounded grammar: `PRAGMA foreign_keys=ON`,
literal-keyed `schema_state` generation updates, `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`,
`CREATE VIEW`, `CREATE TRIGGER`, named trigger/view replacement, and `CREATE INDEX` only on a table created earlier
within the same approved operation. It rejects table rebuild/copy migrations, data backfills,
unsupported or unbounded DML, and index builds on pre-existing tables. The current candidate support
matrix below is derived from local files relative to the last known Core ledger `0066`; it does not
assert that any candidate is currently pending remotely. Read the live ledger in a new exact intent.

| Candidate Core migration after `0066` | Offline bounded-operation support | Review note |
|---|---|---|
| `0067`, `0072`, `0077`-`0080`, `0083`-`0094`, `0097`-`0099` | Supported (21 files) | Bounded schema/metadata forms; exact declared objects and final literal metadata values require readback. |
| `0068`, `0075`, `0081`, `0082`, `0095`, `0100`, `0102` | Review required (7 files) | Column checks/references fall outside the bounded ADD COLUMN grammar. |
| `0069`, `0071`, `0076`, `0096`, `0101`, `0103` | Review required (6 files) | Rebuild/copy/backfill or foreign-key deferral/disabling is outside this operation. |
| `0070`, `0073`, `0074` | Review required (3 files) | Index build targets a pre-existing table. |

The migration command never silently omits an unsupported migration. If any selected file falls
outside the classifier's allowed grammar, the whole intent is refused before the first migration
effect. After command start, timeout, cancellation, or lost acknowledgement is recorded as
`UNKNOWN`; partial ledger progress is preserved and reconciled without automatic restore, retry, or
resume. Continuing requires a new intent after reviewing the live ledger and resulting schema.

Worker readback follows the active deployment to its exact single version at 100% traffic, checks
runtime settings, named exports, the generation variable and configured resource identities before
deployment authority synchronization. Cloudflare's ETag is an opaque observation, not a local
SHA-256 attestation. A deterministic local PWA manifest is pinned and rehashed between release steps. With an Access
cookie, every served asset body must match its local byte count/hash, then active deployment/version
identity is re-read before authority synchronization. A mismatch, redirect, fallback body, deadline
or local drift fails closed. Without a cookie the receipt explicitly records `NOT_EXECUTED`.
Root `_headers`/`_redirects` are excluded from served-content hashing; routing and an atomic
source/build seal are not proved by this observation. Product/T4/T6 qualifications remain separate. The current Worker does not deploy/import the Rust
Wasm kernel; do not fabricate a mandatory empty Wasm binding or a passing Wasm receipt.

### R2

Bucket jurisdiction and default storage class are treated as immutable profile fields. A mismatch fails;
it is never patched under an existing generation. R2 free-tier allowances are operational thresholds
only (monitor usage, stay within the free tier by process): until a verified hard control exists,
no platform cutoff is assumed and no hard stop is asserted.

### Queues

The primary Queue and DLQ are created by exact name. Consumer retry/batch/DLQ settings remain declarative
in `wrangler.jsonc` and are reconciled with the Worker deployment.

### AI Search and AI Gateway

AI Search tokenizer/embedding/fusion drift requires a new instance generation, shadow reindex, T2/T3
checks, item-count readback and retained rollback generation. Gateway drift requires an explicit reviewed
change; the provisioner does not update it silently.

### Access

There is no manual Access step: `scripts/provision-cloudflare-access.mjs` creates-or-verifies the
hostname-based self-hosted application and the one exact-email owner policy, and
`scripts/provision-cloudflare-core.mjs` consumes the verified AUD plus exact team origin from the
ignored receipt. Do not create Access applications or policies in the dashboard; unmanaged entries
fail the undeclared-policy check.
Worker-level Access is prohibited because `ResearchSession` uses WebSockets. Extra service policies fail
unless their IDs are explicitly allow-listed. Hostname Access protects only the exact URL, so the
foundation provisioner enforces one of two exclusive contours: a Custom Domain with `workers.dev`
disabled, or the exact `<worker>.<subdomain>.workers.dev` hostname from the local ignored profile
with no Custom Domain.
The foundation generator writes the exact team domain, AUD tag, and bounded service-principal allow-list
into the ignored deploy config. Invalid values fail before the first Cloudflare request. ER-17 verifies
issuer, audience, signature, time, token class, and service principal; none is inferred merely from the
request reaching the Worker.

## D1 migration discipline

1. Add compatible table, column or index.
2. Deploy code capable of reading old and new shapes when a two-phase change is required.
3. Apply the additive migration.
4. Run bounded backfill Workflow with resumable checkpoints.
5. Switch schema/config generation and observe.
6. Remove an old path only in a later release after rollback and purge requirements expire.

Never combine destructive DDL, code cutover and irreversible backfill into one release.

## Receipts and post-deploy gates

A successful deploy atomically writes `cloudflare-deployment-receipt.json`. Before provisioning mutations,
a previous receipt is moved to `cloudflare-deployment-receipt.json.previous`; a failed attempt does not
leave the previous PASS at the current receipt path. The previous file is historical evidence, not a
statement about the current environment.

Worker readback requires one active deployment with 100% traffic on one version, then
checks that version's resources: every configured typed runtime variable, D1/R2/Queue/DO/Workflow,
AI/Search/Vectorize/Analytics/assets bindings, runtime compatibility and exports. Unknown bindings
fail closed; optional secret bindings are restricted to the reviewed runtime names and secret type.
Secret values are never read or recorded. The receipt records variable count and equality only.
The version identifier and API etag are observations, not a SHA-256 proof of uploaded code bytes.
A large/ambiguous inventory or stale variable fails before deployment authority synchronization.

Canonical and generated D1 configs must explicitly resolve both repository migration directories;
Wrangler's omitted default directory is refused. Local bundle digests bind the selected SQL files;
remote ledgers prove the exact applied names, not historical remote SQL byte equality.
The staging target declaration binds the requested account and excludes declared protected IDs.
It does not prove that the account contains no production resources or supply owner authorization.

Authenticated HTTP smoke runs only with an Access cookie. Both `/healthz` and the capabilities envelope
must report the expected deployment generation; health must be ready and timestamped within two minutes.
Capabilities must retain exact-evidence and honest-completion invariants. HTML login/PWA fallback pages,
redirects, conflicting slices, invalid JSON, oversized bodies and timeouts fail. Cookies go only to the
exact configured HTTPS Access origin. Each request has a 15-second connection-plus-body deadline and a
64 KiB body limit; API inventory readback is bounded to 1 MiB. Response bodies and credentials never enter
error messages or receipts. Keep the operator clock synchronized.

The generated configuration owns plaintext runtime variables. Deployment does not use `--keep-vars`;
Wrangler preserves secrets independently. Product readiness is not inferred from smoke success.
All deeper T4/T6 gates remain explicit `NOT_EXECUTED` until ER-27 performs real:

- D1 write/readback;
- R2 immutable put/readback;
- Queue duplicate delivery and durable-intent acknowledgement;
- Durable Object hibernation/reconnect;
- Workflow retry/resume;
- AI Search locator-to-`EvidenceHandle` resolution;
- Google Drive append/readback/reconnect.

No mock, missing credential or omitted command may be reported as `PASS`. Live status stays
`NOT_EXECUTED` / `IMPLEMENTED_NOT_LIVE` until real receipts exist.
