# Cloudflare provision and deploy runbook

This runbook deploys one Worker/PWA contour without committing Cloudflare account state. It is safe to
hand to a deployment agent; no step requires reading the architecture master document.

## Preconditions

- Node.js and Corepack satisfy the root `package.json` engines.
- The Cloudflare account has Zero Trust enabled.
- The API token is least-privilege but can read/write Workers, D1, R2, Queues, AI Search, AI Gateway and
  Access applications/policies.
- `ELIOTR_ACCESS_HOSTNAME` names the **only** production URL: either the intended Custom Domain or the
  exact `eliotr-core.<account-subdomain>.workers.dev` hostname.
- `ELIOTR_OWNER_EMAILS` contains comma-separated exact owner emails. Never use `everyone` or a generic
  valid-email selector.

## Environment

```text
CLOUDFLARE_ACCOUNT_ID              required
CLOUDFLARE_API_TOKEN               required
ELIOTR_ACCESS_HOSTNAME             required, hostname only; no scheme/path/wildcard
ELIOTR_OWNER_EMAILS                required, comma-separated exact emails
ELIOTR_ENVIRONMENT                 optional: staging|production; live default is production
ELIOTR_DEPLOYMENT_GENERATION       optional; defaults to git-<short-sha>
ELIOTR_CUSTOM_DOMAIN               required: 1 for Custom Domain only; 0 for workers.dev only
ELIOTR_ALLOWED_ADDITIONAL_ACCESS_POLICY_IDS
                                    optional explicit allow-list for reviewed service policies
ELIOTR_ACCESS_SMOKE_COOKIE         optional CF_Authorization value for authenticated HTTP smoke
ELIOTR_SMOKE_BASE_URL              optional; defaults to https://ELIOTR_ACCESS_HOSTNAME
```

Google credentials, provider keys, OAuth tokens and Access cookies are secrets. Add runtime secrets with
`wrangler secret put` or approved secret automation; never place them in tracked JSON or `.env` files.

## First environment or repeat deployment

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm cf:preflight:remote
pnpm cf:deploy -- --confirm-live
```

Until ER-00 has committed `pnpm-lock.yaml`, use `pnpm install --no-frozen-lockfile` once and commit the
result in the workspace packet before allowing CI or deployment agents to continue.

`cf:preflight:remote` performs only GET/readback operations. `cf:deploy` repeats local gates, repeats the
remote preflight, then performs create-or-verify provisioning. It writes the account-specific
`apps/eliotr-core/wrangler.deploy.jsonc` locally. The file and `.eliotr-state/` receipts are ignored by
Git.

## Resource behavior

### D1

The provisioner lists by exact database name, rejects duplicates/jurisdiction drift and injects returned
UUIDs into the generated config. The deployer applies both additive migration streams before exposing the
new Worker generation. Do not depend on Wrangler's automatic D1 config mutation.

### R2

Bucket jurisdiction and default storage class are treated as immutable profile fields. A mismatch fails;
it is never patched under an existing generation.

### Queues

The primary Queue and DLQ are created by exact name. Consumer retry/batch/DLQ settings remain declarative
in `wrangler.jsonc` and are reconciled with the Worker deployment.

### AI Search and AI Gateway

AI Search tokenizer/embedding/fusion drift requires a new instance generation, shadow reindex, T2/T3
checks, item-count readback and retained rollback generation. Gateway drift requires an explicit reviewed
change; the provisioner does not update it silently.

### Access

The provisioner creates a hostname-based self-hosted application and one exact-email owner policy.
Worker-level Access is prohibited because `ResearchSession` uses WebSockets. Extra service policies fail
unless their IDs are explicitly allow-listed. Hostname Access protects only the exact URL, so the
foundation provisioner enforces one of two exclusive contours: a Custom Domain with `workers.dev`
disabled, or the exact `eliotr-core.<account-subdomain>.workers.dev` hostname with no Custom Domain.
Application roles and service-principal authorization remain ER-17 responsibilities and must verify the
Access assertion; they are not inferred merely from the request reaching the Worker.

## D1 migration discipline

1. Add compatible table, column or index.
2. Deploy code capable of reading old and new shapes when a two-phase change is required.
3. Apply the additive migration.
4. Run bounded backfill Workflow with resumable checkpoints.
5. Switch schema/config generation and observe.
6. Remove an old path only in a later release after rollback and purge requirements expire.

Never combine destructive DDL, code cutover and irreversible backfill into one release.

## Receipts and post-deploy gates

A successful deploy writes `cloudflare-deployment-receipt.json`. It verifies Worker readback and the
`ResearchSession` declarative Durable Object export. Authenticated HTTP smoke runs only when an Access
cookie is supplied. All deeper T4/T6 gates remain explicit `NOT_EXECUTED` until ER-27 performs real:

- D1 write/readback;
- R2 immutable put/readback;
- Queue duplicate delivery and durable-intent acknowledgement;
- Durable Object hibernation/reconnect;
- Workflow retry/resume;
- AI Search locator-to-`EvidenceHandle` resolution;
- Google Drive append/readback/reconnect.

No mock, missing credential or omitted command may be reported as `PASS`.

## Rollback

Worker rollback does not undo schema or purge history. Keep migrations additive, retain the previous AI
Search generation and old code read path through the observation window, then switch the expected
Worker/index/config heads back explicitly. Never restore D1/R2 before replaying the current purge ledger;
otherwise erased content can be resurrected.
