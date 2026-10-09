# Frontend cutover inventory — Astro PWA to canonical React/Vite build

**Date:** 2026-10-08
**Baseline:** `517723e3ee41d208bbc1e1696ed23070000a0150`
**Review pass:** 6 — exact deploy bridge, controller-null inbox recovery, permanent inert tombstone,
no-registration rollback and first-paint bfcache privacy
**Applies to:** U6 canonical cutover and U7 legacy removal
**Authority:** ADR-0016, ADR-0017, ER-25, ER-47, ER-48
**Status:** static inventory; source changes and executable verification are `PENDING`

Replacing `index.astro` or one asset path is not cutover. The legacy owner PWA is embedded in build-input
hashing, deployment receipts, local launch, smoke tests, CI, budgets, inbox routing, worker state and browser
lifecycle. U6 must switch one exact artifact graph without weakening deployment attestation.

Historical audits and receipts remain historical facts. They are not rewritten to pretend React existed.

## 1. Release invariant

Current release authority:

```text
apps/eliotr-pwa Astro build
→ apps/eliotr-pwa/dist
→ generated apps/eliotr-core/wrangler.deploy.jsonc
→ Wrangler dry-run + Eliot attestation
→ wrangler deploy <attested entrypoint> --no-bundle --config wrangler.deploy.jsonc
→ deployment/asset readback
```

Target authority:

```text
apps/eliotr-web Vite client
+ existing apps/eliotr-core Worker input
→ generated client + Worker modules + output config
→ Eliot attestation of exact graph
→ one deploy with no rebuild/config substitution
→ deployment/asset readback
```

During U1-U5 only legacy is releasable. New assets with an old Worker fingerprint, or a new Worker with a
legacy asset receipt, are invalid.

Before switching, U6 also creates one attested **retirement-safe legacy rollback artifact**. It preserves
accepted legacy behavior but removes root service-worker registration and includes exact retirement helpers.
The historical production artifact is not valid post-retirement rollback.

## 2. Confirmed deployment-bridge blocker

The current orchestrator pins `wrangler.deploy.jsonc`, attests a prebuilt entrypoint and deploys it with
explicit `--no-bundle --config`. The Cloudflare Vite plugin emits generated output configuration and a
redirected deploy record discovered from the build directory. Explicit legacy config/entrypoint bypasses that
mechanism.

Therefore this is invalid:

```text
vite build → existing deploy-cloudflare.mjs unchanged
```

U6 selects exactly one bridge.

### Option A — attest/deploy Vite output directly

- Build once with the exact pinned tuple.
- Resolve output config, Worker entry/modules/Wasm and client manifest.
- Bind those bytes in Eliot build/asset/receipt protocols.
- Deploy exact output without rebuilding.

### Option B — redirected Wrangler deployment

- Build once from the exact Vite root/environment.
- Pin `.wrangler/deploy/config.json` and target output config.
- Run Wrangler where the redirect is discoverable, without legacy config/entrypoint override.
- Prove no automatic configuration, source mutation or rebuild after attestation.

Do not mix options. Both preserve migration, binding, capability, authority, secret and remote-readback gates.

Mandatory negatives:

- missing/stale/malformed redirect or wrong working directory;
- build/deploy environment mismatch;
- explicit legacy `--config` fallback;
- automatic configuration edits or another app selection;
- post-attestation rebuild;
- client/output/Worker graph mismatch;
- source/lock/input/output mutation during deploy;
- unrecorded, rebuilt or service-worker-registering rollback artifact.

## 3. Build, deploy and receipt ownership

| Current path | U6 disposition | Owner |
|---|---|---|
| `package.json` | one canonical candidate/build/attest command plus exact rollback build/attest command | ER-00 |
| `apps/eliotr-pwa/package.json` | freeze product behavior; extract inbox; build rollback variant without registration | ER-25 + ER-00 |
| `apps/eliotr-pwa/src/main.ts` | remove/disable unconditional `/sw.js` registration in rollback/cutover source path | ER-25 + U6 integrator |
| `apps/eliotr-pwa/public/sw.js` | replace deployed route permanently with inert no-fetch/non-claiming tombstone | ER-25 + U6 integrator |
| `apps/eliotr-core/package.json` | consume selected bridge; no second release bundle | ER-00/ER-24 |
| `apps/eliotr-core/wrangler.jsonc` | remain input/resource authority; generated output identifies assets | ER-24/ER-26 |
| `scripts/deploy-cloudflare.mjs` | selected bridge while preserving release/rollback gates | ER-26/ER-00 |
| deployment orchestration tests | one-build identity, redirect/config, failure order, safe rollback and permanent tombstone | ER-26/ER-00 |
| `.github/workflows/ci.yml` | candidate and rollback verification; preserve manual-trigger policy | ER-00 |

## 4. Build-input and evidence protocols

Forward generations must bind:

```text
source commit + dirty state
lockfile + exact tools
build/deploy CLOUDFLARE_ENV
input Wrangler config
Vite/plugin/options
redirect record when used
output wrangler.json
client eager graph
Worker entry/modules/Wasm
static headers/routing
standalone inbox assets
permanent tombstone bytes + cache allowlist
retirement-safe rollback manifest
no-service-worker-registration static/runtime receipt
```

Required protocol changes:

| Area | Change |
|---|---|
| build inputs | include React/Vite/UI/client, environment and rollback inputs; retain historical readers |
| deployment assets | bind client, routing/headers, inbox, tombstone and rollback graph |
| build evidence | bind Worker/output/redirect/client/rollback identities |
| schemas | additive generation; never reinterpret old receipts |
| tests | graph mismatch, path escape/symlink, stale redirect, rebuild, old-worker restoration, rollback registration |

Input config, redirect, output config and rollback artifact are distinct identities.

## 5. Local development, launch and smoke

Local acceptance must prove:

- Windows/Linux start/restart/stop;
- `CLOUDFLARE_ENV=test` and `remoteBindings:false`;
- no production remote/effectful binding;
- fixture versus local-simulation truth;
- same-origin API/SPA separation;
- no competing Astro/Vite process;
- exact candidate entry family and real security/cache headers;
- retirement-safe rollback fixture registers no worker;
- Local Explorer is available only after binding preflight.

Root TypeScript, Vitest, ESLint, boundaries and budgets add ER-47/48 through ER-00 and retain legacy checks
until U7. Do not delete tests because selectors changed or call chunk renaming a size improvement.

## 6. Standalone agent inbox

Before deleting the legacy package, U6 gives the inbox an explicit home for:

```text
source
standalone build/output
exact browser-local retirement helper
route/asset tests
CSP/no-store headers
service-token/browser safety
```

It remains a separate bundle, reuses no owner cookies/private client data, registers no worker and keeps
Access bypass limited to `/agent-inbox/*`.

An active root registration can control inbox navigation even when the tombstone does not call
`clients.claim()`. Therefore:

- any non-null `navigator.serviceWorker.controller` keeps the inbox fail-closed;
- its helper may update/unregister only the exact same-origin root `/sw.js` registration;
- it reads back registration/cache state and reloads at most once;
- only a controller-null reload enables inbox operation;
- it calls no owner API and carries no owner/service credential.

## 7. Browser cutover

### 7.1 Permanent service-worker tombstone

Legacy facts:

- owner entry unconditionally registers root `/sw.js`;
- old worker caches `/` as `eliotr-shell-v1`;
- old worker calls `clients.claim()` and handles fetch with cache fallback;
- inbox rejects any controller.

U6:

1. permanently serves exact `/sw.js` as JavaScript with `no-cache, max-age=0`;
2. install calls `skipWaiting()`;
3. activate deletes only enumerated legacy shell caches;
4. tombstone never calls `clients.claim()` and has no fetch handler;
5. optional message targets only already-controlled owner clients after same-origin validation and inbox
   exclusion;
6. owner/inbox helpers touch only exact root `/sw.js` registration;
7. perform `update → tombstone activation/observation → unregister → registration/cache readback`;
8. reload at most once, then verify controller-null and expected app/inbox build;
9. treat unregister result/message/controllerchange as observations, not completion;
10. cover fresh, active, waiting, multi-tab, interrupted, already-retired, unrelated-registration,
    inbox-controlled and long-dormant browser cases.

The tombstone URL is not removed after a measured window. Registrations persist until explicit unregistration,
and browsers cannot be enumerated. `/sw.js` remains an inert compatibility endpoint for the origin lifetime.
No broad cookie/storage/cache deletion is allowed.

### 7.2 Retirement-safe rollback

The historical legacy build cannot be used after retirement because it registers `/sw.js` again. U6 prepares:

```text
accepted legacy owner behavior
- unconditional service-worker registration
- historical fetch/cache worker
+ exact standalone retirement helper
+ permanent inert tombstone route
```

The variant gets an immutable build digest and browser receipt. Tests prove owner navigation,
Library/Research/Connections, Access and standalone inbox still work online; no owner/inbox page registers a
worker; old worker/cache are never restored.

Rollback selects this exact artifact without rebuilding. Restoring the old graph then patching `/sw.js` is
invalid.

### 7.3 Back/forward cache

The shell ships a non-private root privacy mask/inert guard. On `pagehide`, the controller sets it
synchronously before React/Query cleanup, closes the lifecycle epoch, aborts reads/polling, pauses realtime and
removes protected Query/report/evidence/source-byte state without mutation/retry.

A persisted `pageshow` stays masked from first restored paint until fresh no-store owner-session/health/
deployment verification. Only then may routes read protected content and remove the guard. A later React
commit is not first-paint evidence.

Acceptance records actual bfcache use and asserts the guard before first animation frame/screenshot across
logout, revoke, purge, deployment change and pending evidence reads.

## 8. Routing, Access, CSP and cache

`run_worker_first` API/MCP/OAuth/federation routes remain authoritative. SPA fallback never turns API errors
into HTML.

Inspect actual responses for:

- owner Access and inbox bypass;
- CSP/nosniff/referrer/frame/permissions/noindex;
- HTML revalidation versus immutable hashed assets;
- permanent `/sw.js` media/cache policy;
- input/output route parity;
- primitive/pane/Markdown behavior under actual CSP;
- Preview cookie/OAuth/custom-domain behavior.

Do not expose all `/assets/*`; owner assets remain inside owner Access.

## 9. Serialized U6 groups

1. candidate Vite client+Worker build;
2. deployment bridge selection and negatives;
3. forward attestation protocols;
4. retirement-safe rollback build/attestation;
5. candidate/rollback local and CI verification;
6. standalone inbox extraction and controller-null recovery;
7. permanent inert tombstone, no-registration rollback, first-paint mask and headers;
8. serialized Queue/Workflow/Access/external staging;
9. canonical switch without rebuild;
10. rollback using only exact safe artifact;
11. legacy Astro/renderers/styles/compatibility removal;
12. status/history closeout.

One integrator serializes root manifests, lockfile, CI, Worker config, deployment schemas and commands.

## 10. U7 completion evidence

Establish by search and executable observation:

- production no longer invokes Astro except exact rollback command during its bounded support window;
- no current receipt requires unqualified historical legacy dist;
- no current smoke expects `/_astro` outside rollback artifact;
- React imports no legacy renderer/style/client implementation;
- no owner or inbox bundle registers a root worker;
- historical fetch worker/cache are never restored;
- `/sw.js` permanently serves exact inert tombstone;
- controlled inbox recovers only after exact unregister and controller-null reload;
- bfcache restore is masked before first paint;
- one Vite graph is built, attested, deployed and rollback-tested;
- inbox builds/routes/tests independently;
- ER-48 is the only maintained browser wire implementation;
- client/CSS/font/visual/Worker/rollback budgets pass;
- P1-P10 and full ordered release acceptance pass.

After the rollback support window closes, remove the Astro rollback artifact/command by an explicit
readback-backed checkpoint. **Do not remove or repurpose `/sw.js`; the inert tombstone remains.**

Static search is necessary but insufficient. Observe output/redirect resolution, response headers, browser
registrations/controllers/lifecycle, asset routes and deployment receipts.
