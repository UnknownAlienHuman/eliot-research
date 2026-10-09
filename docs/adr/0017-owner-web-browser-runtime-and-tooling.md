# ADR-0017: Owner-web browser runtime, caching and agent toolchain

- Status: accepted companion to ADR-0016.
- Date: 2026-10-08.
- Review pass: 6 — permanent inert tombstone, no-registration rollback, static-SPA CSP and first-paint bfcache privacy.
- Scope: browser runtime hardening, static-asset headers, page lifecycle, legacy service-worker retirement and
  Cloudflare developer-tool authority for the React owner workspace.
- Runtime/backend authority: unchanged.

## Context

The legacy owner PWA registers `/sw.js` at root scope. That worker caches `/` under `eliotr-shell-v1`, calls
`clients.claim()` and serves a cached response when network fetch fails. Replacing deployed assets does not
remove an installed worker or cache. Service-worker registrations are persistent until explicitly
unregistered, and update checks can be delayed or fail. A browser that has not visited during a planned
migration window may therefore retain the old registration indefinitely.

The standalone `/agent-inbox/` already treats any service-worker controller as unsafe. Calling
`clients.claim()` from a root tombstone would immediately adopt in-scope clients, including the inbox.
Omitting `clients.claim()` prevents proactive adoption, but an active root registration can still control a
new navigation. Permanent isolation therefore requires exact unregister/readback, no future registration and
a stable inert script at the historical `/sw.js` URL for long-dormant registrations that update later.

The ordinary owner static-asset path also lacks the explicit security-header treatment used by the inbox.
Cloudflare Workers Assets can apply `_headers` to static responses, while Worker-generated responses require
headers in code.

A second browser cache exists independently of HTTP and service-worker caches: bfcache can preserve a complete
in-memory page and resume it after history navigation. `Cache-Control:no-store` is not a reliable opt-out in
current Chrome. A React state update scheduled during `pagehide` is not evidence that a privacy mask was
painted before the page froze.

Cloudflare's `cf` CLI is agent-oriented but remains beta. The repository already has pinned Wrangler build,
provision and deploy authority; a second configuration path is prohibited.

## Decision

### 1. No service worker in the initial React owner workspace

The React app registers no service worker. Installability/offline shell behavior is not a launch requirement
for a private evidence application and does not justify stale-code or private-cache risk. A web manifest stays
only when it has a tested purpose independent of background caching.

A future functional worker requires a separate ADR defining scope, versioning, update UX, cache content,
private-route exclusions, inbox isolation and erasure behavior. It must use a different reviewed script/scope
contract; `/sw.js` remains reserved as the inert retirement tombstone while this origin exists.

### 2. Legacy worker retirement is part of cutover

U6 includes a tested migration for the known script/cache, not a generic browser-data cleaner.

#### 2.1 Permanent tombstone delivery

- Serve exact `/sw.js` permanently for the lifetime of the origin as a tiny inert retirement script.
- Use JavaScript content type and `Cache-Control: no-cache, max-age=0` so old registrations can update.
- Install calls `skipWaiting()`.
- Activate deletes only `eliotr-shell-v1` plus separately enumerated evidence-backed legacy shell cache names.
- Activate **must not call `clients.claim()`**.
- An optional bounded retirement message may target only already-controlled owner-workspace clients returned
  without `includeUncontrolled`, after same-origin URL validation and explicit `/agent-inbox/` exclusion. The
  message is an observation, not completion authority.
- The tombstone has no fetch handler and serves no application shell, API or private data.
- Merely serving `/sw.js` does not register it. No accepted current or rollback application may call
  `navigator.serviceWorker.register("/sw.js")`.
- The tombstone URL is not removed by a time window, telemetry estimate or list of observed clients. Browsers
  are not enumerable, and registrations persist beyond page/object lifetimes until explicit unregistration.

The only normal reason to remove `/sw.js` is decommissioning/resetting the entire origin under a separate
platform-exit procedure. It is not reused for another functional worker.

#### 2.2 Exact page-side retirement handling

The owner cutover client and a separately built minimal `/agent-inbox/` helper may enumerate registrations and
act only when all identity checks pass:

- same origin;
- root scope;
- installing/waiting/active `scriptURL` resolves to exact `/sw.js`;
- unrelated registrations are untouched.

They call `registration.update()`, wait with a bounded timeout until the exact tombstone reaches the expected
installed/activated state or emits its bounded observation, then call `unregister()` on that exact
registration. They read back registration and cache inventory, reload at most once, and after reload verify
that no legacy/tombstone controller remains.

`unregister()` returning true, a message or `controllerchange` alone is not completion. An already controlled
document may remain controlled until navigation; post-reload controller and registration readback are
mandatory.

The inbox helper is browser-local cleanup only. It is a tiny separate bundle, imports no owner UI/client,
uses no owner cookie or service credential, calls no API and remains fail-closed while a controller exists. If
no exact registration exists, it performs no mutation.

#### 2.3 Required upgrade cases

- fresh owner browser with no registration;
- active legacy worker;
- waiting/installing legacy update;
- two controlled owner tabs;
- interrupted migration + reload;
- already retired browser;
- unrelated same-origin registration outside exact scope;
- long-dormant browser returning after the original migration period;
- inbox navigation while a legacy/tombstone registration is active: fail closed, exact retire, clean reload,
  then controller-null;
- rollback after some or all observed browsers retired the worker.

Do not use broad cache deletion, `Clear-Site-Data` for cookies/storage, wildcard registration cleanup or
origin-wide deletion.

#### 2.4 Retirement-safe legacy rollback

The pre-cutover legacy application registers `/sw.js` unconditionally. Restoring those exact old bytes would
recreate a root registration and eventually control new inbox navigations.

Before canonical switch, U6 builds, tests and attests one **retirement-safe legacy rollback artifact**:

- retain accepted legacy owner HTML/JS/CSS behavior and API contracts;
- remove or permanently disable the unconditional `/sw.js` registration path;
- include the standalone exact retirement helper where needed;
- deploy the same permanent no-fetch tombstone at `/sw.js`;
- never restore the old cache/fetch worker or its registration logic;
- bind rollback assets, tombstone bytes, headers and no-registration result into the rollback receipt.

This variant is the only allowed post-retirement rollback. “Exact legacy rollback” means this exact attested
retirement-safe artifact, not the historical production artifact. Rollback is online-first and cannot depend
on reinstalling `eliotr-shell-v1`.

### 3. Static owner security headers are explicit

The Vite static input supplies reviewed Workers Assets `_headers` for owner routes:

- CSP with self-hosted scripts and no object/base/frame authority;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer` or separately justified same-origin policy;
- frame denial through CSP and compatibility header;
- restrictive `Permissions-Policy`, including disabling legacy `unload` where supported;
- `X-Robots-Tag: noindex, nofollow, noarchive` for private and Preview hosts;
- explicit cache policy for HTML, permanent tombstone and content-hashed assets.

The exact CSP is produced after primitive, pane, Markdown and editor dependencies are known. Inline scripts
and script `unsafe-inline` are prohibited.

#### Static-SPA CSP constraint

Static Workers Assets HTML does not naturally receive a unique per-response nonce. Do not specify nonce-based
component setup unless Worker-generated HTML is separately accepted.

Base UI can inject style elements in selected modes, while splitter/positioning dependencies may emit computed
style attributes. Qualification must inspect actual output:

1. disable dependency-injected style elements and use external CSS where supported;
2. keep `style-src-elem` self-only unless an exact stable hash is justified;
3. if computed attributes are unavoidable, use the narrowest tested `style-src-attr` policy and record affected
   components;
4. reject libraries requiring broad script weakening or imaginary nonce plumbing;
5. collect CSP violations in component and integrated browser tests;
6. keep feature-authored inline design styles prohibited except reviewed mathematical layout values behind
   `@eliotr/ui`.

`_headers` applies only to static asset responses. API/OAuth/MCP/inbox and Worker-first routes retain their own
header tests.

### 4. HTTP/cache policy

- HTML/navigation shell: revalidate on every network use; no immutable TTL.
- `/sw.js`: permanent inert tombstone, JavaScript media type, `no-cache, max-age=0`.
- Content-hashed JavaScript/CSS/images: long immutable caching allowed.
- Owner API/protected reads: backend `no-store`.
- Preview HTML/component review: noindex and explicit non-production identity.
- Deployment-generation change must not be hidden by a stale shell.

Actual local/Preview/staging responses are inspected; `_headers` source text alone is not evidence.

### 5. Back/forward cache and page lifecycle

HTTP directives and worker removal do not clear a bfcache snapshot. Eliot owns one lifecycle controller in the
React composition root.

The shell includes a pre-existing, non-private privacy mask/inert guard controlled by one root attribute. The
controller may set that attribute synchronously; this narrow safety operation is not selector-owned product
state, does not reparent DOM and contains no private content.

#### On `pagehide`

Synchronously, before React or Query work:

- set the root privacy-mask/inert guard;
- mark the current lifecycle epoch closed.

Then, without server effects:

- advance the lifecycle epoch;
- abort owner reads and bounded status polling;
- pause/close optional realtime clients;
- remove protected Query entries and clear report/evidence/source-byte view state;
- retain only safe route IDs, permitted non-sensitive drafts, theme and validated pane geometry;
- perform no mutation, retry, receipt settlement or operation-ID allocation.

This runs whether or not `event.persisted` is true. Do not use `unload`. React cleanup remains required but
does not replace the synchronous guard.

#### On `pageshow`

- initial non-persisted load stays masked until normal verification completes;
- a persisted restore stays masked/empty from first paint;
- re-read owner session/health and deployment generation with fresh no-store requests;
- only after successful epoch/currentness reconciliation may routes re-read protected content and clear the
  mask;
- if verification is unavailable/different, remain cleared and show sign-in/reload/degraded recovery;
- a bounded hard reload fallback uses a non-private one-shot loop guard.

A pre-hide late response cannot repopulate state. `pageshow` is not proof that owner, grant, source head or
deployment remains current.

#### Tests

- unit/component pagehide/pageshow transitions;
- root mask set synchronously before first animation frame/restored screenshot;
- real Back/Forward attempts in supported Chromium, Firefox and WebKit, recording actual bfcache use;
- logout/auth change, revoke, purge or deployment change while away;
- pending report/evidence read while navigating away;
- optional realtime closes/reconnects once;
- no old protected bytes before verification.

`no-store` remains correct for protected responses but is not the bfcache security mechanism.

### 6. Cloudflare project tool authority

Wrangler plus the official Cloudflare Vite plugin remain build/dev/preview/deploy authority until a separate
accepted migration changes this.

The beta `cf` CLI may be used for local search or explicitly approved read-only/dry-run exploration. ER-47
agents must not run `cf migrate/dev/build/deploy`, generate a parallel `cloudflare.config.ts`, or authenticate a
second implicit project profile.

### 7. Browser security acceptance

Required negatives:

- legacy worker/cache cannot restore the Astro shell;
- waiting/multi-tab and long-dormant registrations converge without unrelated deletion;
- tombstone never calls `clients.claim()` or handles fetch;
- inbox under an active registration stays fail-closed until exact retire and controller-null reload;
- React and retirement-safe rollback register no worker;
- rollback never restores the old fetch worker/registration path;
- `/sw.js` continues serving the exact inert tombstone after the rollback window;
- reviewed CSP/referrer/frame/permissions/noindex headers are present;
- actual primitive/pane/Markdown output passes CSP;
- malicious content cannot execute/navigate forbidden schemes;
- protected data cannot survive Query, worker, HTTP or bfcache state;
- synchronous mask prevents pre-verification restored paint;
- Preview resources cannot reach production effects.

## Consequences

The React app and post-retirement rollback are online-first. Content-hashed public build assets still cache
normally. `/sw.js` remains a permanent low-cost inert compatibility endpoint because unseen browser
registrations cannot be enumerated or assumed retired.

CSP, worker retirement, no-registration rollback and bfcache handling are cutover gates, not post-release
cleanup. Agent convenience creates no second Cloudflare configuration.

## Documentation checked

Checked on 2026-10-08:

- Workers Assets headers/config: <https://developers.cloudflare.com/workers/static-assets/headers/> and
  <https://developers.cloudflare.com/workers/static-assets/binding/>
- Cloudflare Vite assets: <https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/>
- Base UI CSP: <https://base-ui.com/react/utils/csp-provider>
- CSP `style-src-attr`: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr>
- service-worker registration lifetime/update/unregister/controller behavior:
  <https://w3c.github.io/ServiceWorker/>,
  <https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/unregister>,
  <https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/controller>, and
  <https://developer.chrome.com/blog/fresher-sw/>
- `pageshow`/`pagehide`: <https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event> and
  <https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event>
- bfcache guidance: <https://web.dev/articles/bfcache> and
  <https://developer.chrome.com/docs/web-platform/bfcache-ccns>
- Cloudflare CLI beta/agents: <https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/>
  and <https://developers.cloudflare.com/cf/agents/>
