# React/Worker cutover

The target is `apps/eliotr-web` (React/Vite), one owner client and the existing `apps/eliotr-core` Worker.
Use [the architecture](../architecture/ELIOT_RESEARCH.md), [implementation plan](backend-entrypoints.md)
and [UI delivery map](../agent-work/frontend-owner-execution-map.md). Frontend claim/ancestry tools are removed.
No second Worker, Pages service, API/database authority or parallel UI framework is required.

## One client and deployed artifact

Move browser callers to canonical owner-client methods and remove duplicated wire decoders and legacy
protocol implementations. Preserve request scope, practical bounds, cancellation and original mutation
identity. Owner reads can tolerate additive fields and a previous deployment; writes and evidence obey
their actual contract. Implement the selected ordinary stream through that same server/client boundary,
not a second transcript/executor. Existing HTTP run status and saved results remain authoritative.

Current legacy assets remain served until the integrated replacement is ready. The existing deploy script's
`--no-bundle --config wrangler.deploy.jsonc` path does not automatically consume redirected Vite output.
Connect the actual build entrypoint, assets and config; a Vite build followed by an unchanged legacy deploy
is not a cutover. Verify API/static/Inbox routing, headers and served files on the actual artifact.
No new build-attestation service or signed deployment registry is required.

Use `CLOUDFLARE_ENV=test` and `remoteBindings:false` for ordinary integrated development. Retain local
isolation from production resources. Storybook uses fixtures, not production bindings. Prepare the build
and rollback during refactoring; actual production deployment/cutover uses the owner's action authorization.

## Browser lifecycle

React and rollback never register a root service worker. Keep `/sw.js` permanently inert, non-claiming
and without a fetch handler; never restore the historical cache worker. Preserve separately served
`/agent-inbox/` and its exact same-origin root-registration retirement helper and controller-null recovery.

Under ADR-0017, pagehide masks synchronously, closes the lifecycle epoch, aborts pending reads, pauses
polling and clears protected views. A suspended page stays masked until session/health reconciliation.
Retain only the permitted non-sensitive drafts/preferences. Principal change, sign-out and applicable
revocation/deletion clear private state; late responses cannot restore it. Under ADR-0018 a deployment
change alone is not loss of identity: preserve the same owner's draft/last read and reconcile with a stale
indication. Never replay an uncertain mutation to refresh a read.

Keep same-origin authenticated transport, CSRF where required, safe Markdown/CSP and exact source opening.
No prompts, reasoning, credentials, raw provider frames or fabricated source coordinates reach the UI.

## Retirement and acceptance

Keep a known-good rollback artifact with inert service-worker behavior only while its API/data contract remains
compatible. Worker rollback does not restore D1/R2; use [the data-cutover procedure](production-readiness-plan.md)
when changing storage. Old tabs must reopen safely, not replay uncertain writes against a new schema.
After callers and served assets switch, delete Astro source, old controllers/styles and unused client dependencies.
A bounded recovery artifact does not require two maintained codebases. Move Core fixture imports with real callers.

Compile/lint while implementing; browser/product checks follow assembly. Check actual response headers,
Inbox recovery, old tabs/bfcache, focus, source opening and rollback against the integrated build.
Record unrun environment checks as pending. Neither this document nor a branch push deploys or deletes data.
