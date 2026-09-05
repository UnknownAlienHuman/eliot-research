# Cloudflare provision and deploy runbook

**Deployment hold:** `deploy-cloudflare.mjs --confirm-live` rejects registered unfinished mandatory
product paths before any remote effect. Develop/test locally with [local-launch.md](local-launch.md);
do not bypass the hold by invoking raw Wrangler deployment. Removing this negative hold still requires
all normative code, security and live qualification gates.

This runbook deploys one Worker/PWA contour without committing Cloudflare account state. It is safe to
hand to a deployment agent; no step requires reading the architecture master document.

## Preconditions

- Node.js and Corepack satisfy the root `package.json` engines.
- The Cloudflare account has Zero Trust enabled.
- The API token is least-privilege but can read/write Workers, D1, R2, Queues, AI Search, AI Gateway and
  Access applications/policies.
- `ELIOTR_ACCESS_HOSTNAME` names the **only** production URL: either the intended Custom Domain or the
  exact `eliotr-core.<account-subdomain>.workers.dev` hostname.
- `ELIOTR_ACCESS_TEAM_DOMAIN` is the exact `https://<team>.cloudflareaccess.com` issuer origin.
- `ELIOTR_ACCESS_AUDIENCE` is the exact Access application AUD tag used by Worker JWT verification.
- `ELIOTR_OWNER_EMAILS` contains comma-separated exact owner emails. Never use `everyone` or a generic
  valid-email selector.

## Environment

```text
CLOUDFLARE_ACCOUNT_ID              required
CLOUDFLARE_API_TOKEN               required
ELIOTR_ACCESS_HOSTNAME             required, hostname only; no scheme/path/wildcard
ELIOTR_ACCESS_TEAM_DOMAIN          required, exact HTTPS cloudflareaccess.com origin
ELIOTR_ACCESS_AUDIENCE             required, exact Access application AUD tag
ELIOTR_ACCESS_SERVICE_PRINCIPALS   optional comma-separated signed service-token common_name allow-list;
                                    empty denies every service principal
ELIOTR_OWNER_EMAILS                required, comma-separated exact emails
ELIOTR_ENVIRONMENT                 optional: staging|production; live default is production
ELIOTR_DEPLOYMENT_GENERATION       optional; defaults to git-<short-sha>
ELIOTR_CUSTOM_DOMAIN               required: 1 for Custom Domain only; 0 for workers.dev only
ELIOTR_ALLOWED_ADDITIONAL_ACCESS_POLICY_IDS
                                    optional explicit allow-list for reviewed service policies
ELIOTR_ACCESS_SMOKE_COOKIE         optional CF_Authorization value for authenticated HTTP smoke
ELIOTR_SMOKE_BASE_URL              optional; must equal https://ELIOTR_ACCESS_HOSTNAME (optional trailing slash)
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
UUIDs into the generated config. The deployer applies both additive migration streams before exposing the
new Worker generation. The exact generated config is identity-validated and dry-run before either remote
migration stream. Its digest is rechecked between release steps; drift stops the next effect. Do not
depend on Wrangler's automatic D1 config mutation.

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

Worker inventory readback checks the expected compatibility date, static assets and `ResearchSession`
export. This bounded observation is **not** attestation of every binding or the exact deployed code
version. A large/ambiguous inventory fails closed rather than claiming a matching deployment.

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

No mock, missing credential or omitted command may be reported as `PASS`.

## Rollback

Worker rollback does not undo schema or purge history. Keep migrations additive, retain the previous AI
Search generation and old code read path through the observation window, then switch the expected
Worker/index/config heads back explicitly. Never restore D1/R2 before replaying the current purge ledger;
otherwise erased content can be resurrected.
