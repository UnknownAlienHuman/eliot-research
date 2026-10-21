# `apps/eliotr-web`

React/Vite is the target owner interface. It uses the existing `apps/eliotr-core` Worker, one shared
`@eliotr/owner-api-client` transport and one `@eliotr/ui` design system. It replaces the legacy Astro/PWA
presentation; it does not create another backend, deployment, database or browser authority.

Current direction:

- [frontend cutover](../../docs/implementation/frontend-platform-migration.md);
- [implementation plan](../../docs/implementation/backend-entrypoints.md);
- [owner execution map](../../docs/agent-work/frontend-owner-execution-map.md);
- [Material UI guidance](../../docs/agent-work/frontend-material-agent-playbook.md);
- [ResearchSession delivery](../../docs/implementation/research-session-projection-protocol.md);
- [owner UI design](../../docs/design/OWNER_WEB_UI.md).

Historical ER-47/48/49 packets, amendments and checkpoint names do not reserve work or define acceptance.

## Application boundary

The Worker owns authentication, authorization, durable state, model/tool effects, citation identity and saved
results. Browser code receives typed owner APIs and renders bounded public data. It never receives Cloudflare
bindings, database authority, provider credentials, prompts, reasoning or raw provider frames.

The React root injects one `OwnerApiClient` for JSON, binary and range operations. Legacy request-shape methods may
temporarily adapt over that same client; they do not own another fetch/epoch/disposal lifecycle. Components do not
call `fetch`, open sockets or duplicate wire decoders.

TanStack Query owns read lifecycle; Router owns navigable selection. Mutations preserve their original operation
identity and reconcile unknown outcomes instead of retrying blindly. Private source/report/evidence bytes are not
persisted in browser storage.

## Research presentation

Canonical run status and saved reports remain server-owned. The existing ResearchSession is currently a strict
read-only projection. The selected replacement adds one bounded typed channel for coarse phase and provisional
public-text batches over the same authenticated Agent connection. It is not chat, transcript storage, a model/tool
client or another Workflow owner.

Disconnect never cancels or repeats generation. Slow clients cannot block output retention or report saving.
Reconnect reads the same run and canonical report; missed provisional text is an explicit gap, not a durable token
journal.

## Build and lifecycle

The cutover must connect the actual Vite output to the one Worker deployment. A successful Vite build beside an
unchanged legacy asset path is not completion. Preserve API, Agent/WebSocket, Inbox and static routing plus reviewed
CSP/cache/referrer/frame behavior on the produced artifact.

No root service worker is registered. Keep `/sw.js` inert and non-claiming for origin lifetime. The controlled
`/agent-inbox/` retirement path remains separate.

On `pagehide`, mask protected content synchronously, close the lifecycle epoch, abort reads and clear private
views. A persisted `pageshow` stays masked until identity/health/currentness reconciliation. Deployment-generation
change alone does not discard the same owner's safe draft or last read.

## Completion

Complete means the real served React artifact handles the selected Library/Lens/Research/Report/Wiki/Inbox and
agent-task paths through the one owner client, including denial, stale/offline/unknown states and source opening.
Then delete Astro, old controllers/styles, duplicate clients/decoders and unused dependencies. Keep a known-good
rollback artifact, not a second maintained UI.
