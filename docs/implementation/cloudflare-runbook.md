# Cloudflare provision and deploy runbook

**Deployment hold:** `deploy-cloudflare.mjs --confirm-live` rejects registered unfinished mandatory
product paths before any remote effect. Develop/test locally with [local-launch.md](local-launch.md);
do not bypass the hold by invoking raw Wrangler deployment. Removing this negative hold still requires
all normative code, security and live qualification gates.

This runbook deploys one Worker/PWA contour without committing Cloudflare account state. It is safe to
hand to a deployment agent; no step requires reading the architecture master document.

## Operator identity (non-secret, browser OAuth only)

Browser OAuth through the local Wrangler `default` profile is the ONLY operator auth method.
No API key, API token, or service token is used by this flow, and none may be added to tracked
files. The exact tracked identity lives in `infra/cloudflare/operator-profile.json`
(protocol `eliotr.cloudflare-operator-profile.v1`); verify it before every deployment:

```bash
node scripts/test-operator-profile.mjs
```

| Field | Exact value |
|---|---|
| Account name | `Kleymor.metal@gmail.com's Account` |
| Account ID | `bc10e9f02aa57f4adc5a7a48ad1bacff` |
| Operator email | `kleymor.metal@gmail.com` |
| Wrangler profile | `default` (browser OAuth) |
| Workers.dev subdomain | `kleymor-metal` |
| Worker | `eliotr-core` |
| Hostname (only public route) | `eliotr-core.kleymor-metal.workers.dev` |
| `ELIOTR_CUSTOM_DOMAIN` | `0` (workers.dev only; Custom Domain out of scope) |
| Access team origin | `https://iuriilisenkov.cloudflareaccess.com` |
| Access owner email (only) | `kleymor.metal@gmail.com` |

Single account, single Worker, single hostname. Any drift in these values fails closed before
any Cloudflare mutation. Browser login and any financial/billing consent cannot be automated:
a human completes them in the browser; scripts only consume the resulting local OAuth profile.

## Preconditions

- Node.js and Corepack satisfy the root `package.json` engines.
- The operator has completed `wrangler login` in a browser for the account above
  (`ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth`, profile `default`). The deployer verifies the
  active profile with `wrangler whoami` against the exact account ID above.
- The Cloudflare account has Zero Trust enabled.
- No `CLOUDFLARE_API_TOKEN` is required for the operator flow. (A static token remains only for
  non-interactive CI, where browser login is impossible; it is never the documented operator path.)
- `ELIOTR_ACCESS_HOSTNAME` is exactly `eliotr-core.kleymor-metal.workers.dev` (hostname only;
  no scheme/path/wildcard).
- `ELIOTR_ACCESS_TEAM_DOMAIN` is exactly `https://iuriilisenkov.cloudflareaccess.com`.
- `ELIOTR_ACCESS_AUDIENCE` is left empty on first deploy: the AUD tag is Cloudflare-generated
  on Access-application create and read back into the ignored receipt. On re-deploy it must
  reconcile exactly with the receipt; a mismatch fails instead of overriding.
- `ELIOTR_OWNER_EMAILS` is exactly `kleymor.metal@gmail.com`. Never use `everyone` or a generic
  valid-email selector.

## Environment

```text
ELIOTR_CLOUDFLARE_AUTH_MODE       required: wrangler-oauth (operator browser flow; unset means CI API-token mode)
ELIOTR_WRANGLER_PROFILE           optional: default; the verified browser-OAuth Wrangler profile
CLOUDFLARE_ACCOUNT_ID              required: bc10e9f02aa57f4adc5a7a48ad1bacff
CLOUDFLARE_API_TOKEN               CI-only; leave unset for browser-OAuth operation (the deployer injects
                                   the short-lived OAuth bearer into child-process memory only)
ELIOTR_ACCESS_HOSTNAME             required: eliotr-core.kleymor-metal.workers.dev (hostname only)
ELIOTR_ACCESS_TEAM_DOMAIN          required on re-deploy: https://iuriilisenkov.cloudflareaccess.com;
                                   may be empty on first deploy (live organization readback wins)
ELIOTR_ACCESS_AUDIENCE             empty on first deploy (Cloudflare-generated on create, then read back);
                                   exact receipt AUD on re-deploy; any override attempt fails
ELIOTR_ACCESS_SERVICE_PRINCIPALS   optional comma-separated signed service-token common_name allow-list;
                                    empty denies every service principal
ELIOTR_OWNER_EMAILS                required: kleymor.metal@gmail.com (single exact owner email)
ELIOTR_ENVIRONMENT                 optional: staging|production; live default is production
ELIOTR_DEPLOYMENT_GENERATION       optional; defaults to git-<short-sha>
ELIOTR_CUSTOM_DOMAIN               required: 0 for this profile (workers.dev only; 1 is out of scope here)
ELIOTR_ALLOWED_ADDITIONAL_ACCESS_POLICY_IDS
                                    optional explicit allow-list for reviewed service policies
ELIOTR_ACCESS_SMOKE_COOKIE         optional CF_Authorization value for authenticated HTTP smoke
ELIOTR_SMOKE_BASE_URL              optional; must equal https://ELIOTR_ACCESS_HOSTNAME (optional trailing slash)
```

Google credentials, provider keys, OAuth tokens and Access cookies are secrets. Add runtime secrets with
`wrangler secret put` or approved secret automation; never place them in tracked JSON or `.env` files.

## Browser login, read-only preflight, first deploy, re-deploy

Every mutation in this runbook follows Intent → Attempt → Receipt → Readback → Reconciliation:
the provisioner declares a plan (Intent), performs create-or-verify calls (Attempt), persists an
ignored non-secret receipt (Receipt), re-reads live state (Readback), and refuses drift on the
next run instead of silently overwriting it (Reconciliation).

Step 0 — browser login (human, one time per OAuth expiry; cannot be automated):

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami   # must show Kleymor.metal@gmail.com's Account / bc10e9f02aa57f4adc5a7a48ad1bacff
```

If `whoami` shows any other account, log in with the correct account and retry. Never paste an
API token to work around a wrong profile; the deployer rejects account mismatch before mutation.

Step 1 — read-only preflight (zero mutating calls; safe on any account state):

```bash
corepack enable
pnpm install --frozen-lockfile
node scripts/test-operator-profile.mjs
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
UUIDs into the generated config. The deployer applies both additive migration streams before exposing the
new Worker generation. The exact generated config is identity-validated and dry-run before either remote
migration stream. Its digest is rechecked between release steps; drift stops the next effect. Do not
depend on Wrangler's automatic D1 config mutation.

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
