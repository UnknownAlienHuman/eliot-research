# Agent ER-25 — legacy owner PWA freeze

`apps/eliotr-pwa` is the currently served compatibility implementation while the replacement owner
workspace is built under [ADR-0016](../../docs/adr/0016-react-cloudflare-owner-ui.md) and the browser
cutover is governed by [ADR-0017](../../docs/adr/0017-owner-web-browser-runtime-and-tooling.md).

Read:

- `docs/implementation/frontend-platform-migration.md`
- `docs/implementation/frontend-cutover-inventory-2026-10-08.md`
- `docs/design/OWNER_WEB_UI.md`
- `apps/eliotr-web/AGENTS.md`

## Allowed changes

Only bounded changes required to prevent a security, authorization, data-loss, privacy or release-blocking
defect before cutover. Preserve the existing owner API, strict decoding, protected-state clearing and
standalone `/agent-inbox/` isolation.

U6 may create and attest one **retirement-safe legacy rollback variant** whose only presentation-runtime
change is removal/disablement of the unconditional root `/sw.js` registration plus the exact standalone
retirement helper required by ADR-0017. This is a release-safety artifact, not progress toward the React UI.
It must retain legacy owner behavior and tests while proving that neither owner pages nor `/agent-inbox/`
recreate a root service-worker registration after retirement.

The standalone inbox may contain a tiny browser-local retirement helper that acts only on an exact same-origin
root registration whose worker script is `/sw.js`, performs update/unregister/readback and reloads once. It
must remain a separate bundle, call no owner API, carry no credential and stay fail-closed while any controller
remains.

## Prohibited changes

- no new visual redesign or navigation shell;
- no new global CSS/design layer or specificity override;
- no new `innerHTML` feature renderer;
- no new DOM reparenting, MutationObserver layout synchronization or selector-owned application state;
- no new feature whose accepted implementation belongs in `apps/eliotr-web`;
- no direct Cloudflare/Google/provider binding or browser credential;
- no reintroduction of `navigator.serviceWorker.register("/sw.js")` into the retirement-safe rollback variant;
- no restoration of the legacy fetch-handling/cache worker after retirement;
- no removal of other legacy behavior before the React replacement passes its named acceptance checkpoint.

When a critical legacy repair is unavoidable, keep it minimal, record why it cannot wait for the React
slice, and add/retain the negative case. Do not describe the repair as progress toward the new design.

The isolated `/agent-inbox/` page remains a separate bundle and transport boundary. It may call only the
declared service-token dispatch, task, exact-evidence and run-recovery APIs. It must not import Cloudflare
bindings, reuse owner cookies, register a service worker, persist credentials/task data, share owner bundles
or create scheduler/completion authority. Its exact retirement helper is browser-local cleanup, not a service
registration or owner-session transport.
