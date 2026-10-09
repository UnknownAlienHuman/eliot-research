# `apps/eliotr-web`

Target React owner workspace owned by ER-47 and defined by:

- `docs/agent-work/ER-47-owner-web-interface.md`
- `docs/agent-work/frontend-material-agent-playbook.md`
- `docs/agent-work/frontend-owner-execution-map.md`
- `docs/agent-work/frontend-autonomous-manager-runbook.md`
- `docs/agent-work/frontend-current-contract-amendment-2026-10-09.md`
- `docs/adr/0016-react-cloudflare-owner-ui.md`
- `docs/adr/0017-owner-web-browser-runtime-and-tooling.md`
- `docs/implementation/frontend-platform-migration.md`
- `docs/agent-work/frontend-notebooklm-material-reference.md`
- `docs/agent-work/frontend-autonomous-manager-runbook.md`
- `docs/design/OWNER_WEB_UI.md`

The current-main amendment is mandatory for affected checkpoints. This directory is documentation reservation
only until the owner authorizes a U checkpoint or autonomous tranche. One tranche authorization permits
routine progression to its named human gate; it does not authorize deployment. The app must not enter
production assets before build and acceptance gates pass.

The application will:

- use React, strict TypeScript and Vite;
- integrate the existing `apps/eliotr-core` Worker through the official Cloudflare Vite plugin;
- call same-origin owner API through `@eliotr/owner-api-client`;
- consume one `@eliotr/ui` Material 3 authority;
- use URL/router state and in-memory TanStack Query lifecycle;
- receive no Cloudflare binding, database authority or provider credential in browser code;
- replace, not wrap, legacy Astro/imperative presentation;
- launch without a service worker or private offline cache;
- use canonical HTTP polling/status/history/readback for detailed Research progress and reconciliation.

## ResearchSession boundary

Current ResearchSession is **not** chat, transcript or proactive stream. ER-48 owns one strict transport adapter
using official `agents/client` `AgentClient` callable RPC:

```text
readResearchSessionProjection()
arguments: none
protocol: eliotr.research-session-projection.v1
states: ACTIVE | CANCELLED | ENGINE_COMPLETED
get-messages: 410 SESSION_CHAT_HISTORY_DISABLED
chat/state/history/MCP/other frames: rejected
proactive progress: none
```

React components/hooks do not import `agents/client`, open the socket directly or maintain generic chat state.
Missing/stale/unknown projection stays degraded until canonical HTTP readback. Projection disconnect, page
disposal or hibernation never cancels or repeats a run/effect. `ENGINE_COMPLETED` is not artifact acceptance or
publication.

## Bootstrap dependency candidate

This is a reviewed **proposal**, not an installed/root-integrated tuple. U1.1a writes package-local
manifests/config only. B-U owns frozen install, lockfile, root references, boundaries, scripts/tests and
budgets.

Current root pins:

```text
Node engine          >=22.13.0
pnpm                 11.23.0
Vite                 8.2.2
Wrangler             4.143.1
TypeScript           6.0.3
Vitest               4.1.11
```

Initial package-local candidate:

```text
react                         19.3.0
react-dom                     19.3.0
@types/react                  19.3.0
@types/react-dom              19.3.0
@vitejs/plugin-react          6.1.2
@cloudflare/vite-plugin       1.54.11
react-router                  7.18.4
@tanstack/react-query         5.104.1
tailwindcss                   4.3.3
@tailwindcss/vite             4.3.3
```

Later checkpoint candidates, not U1.1a runtime requirements:

```text
U1.3 composite candidate   @base-ui/react 1.8.0
U1.4 catalog candidate     storybook + @storybook/react-vite 10.6.1
ER-48 projection adapter   exact approved agents/client package surface
```

Rules:

- use plugin order `react()` then `cloudflare({ configPath: ... })` targeting existing
  `apps/eliotr-core/wrangler.jsonc`;
- create no second Worker config, backend or deployment;
- use `react-router` library mode only; no framework mode, SSR/RSC or `@react-router/dev`;
- do not silently raise root Node floor for Router 8;
- Base UI is first composite candidate; React Aria is bounded fallback comparison, not a second maintained
  family;
- Tailwind consumes committed semantic tokens; no arbitrary feature palette or mass generator import;
- Storybook is development-only and absent from production graph;
- React app does not add `@ai-sdk/react`, `agents`, `@cloudflare/ai-chat`, service-worker packages, persistence,
  rich editor, resizable-pane or virtualizer dependencies during U1.1a;
- any exact `agents/client` use belongs to the ER-48 projection adapter and requires B-C/B-U bundle/side-effect
  qualification;
- no `--legacy-peer-deps`, peer override, duplicate React/Vite/Wrangler or unpinned production dependency.

Required B-U evidence includes frozen resolution, peer graph, one React/Vite/Wrangler identity, root TypeScript
and boundary registration, unknown-package negative, generated Cloudflare output and emitted-budget receipt.
Until then every version above remains `PROPOSED`.

## Build boundary

The target build is not React assets copied beside a separately built Worker. The Cloudflare Vite plugin takes
existing Wrangler config and generates one output containing client assets, Worker code and output config.

Existing Astro/Wrangler remains release path during U1/U2. U6 selects the canonical Vite build, updates dry-run/
deploy/attestation through owning packets and removes competing production bundle identities.

Current emitted/deployment/application-schema receipt authority must be extended to owner-web, not replaced.
U6 also creates one separately attested retirement-safe legacy rollback artifact without root service-worker
registration or old fetch/cache worker.

## Routing and Preview boundary

Current source Worker-first families include agent/API/MCP/OAuth/federation/inbox routes. U1.1b must prove
generated output preserves them and test:

- ResearchSession upgrade and no-arg projection RPC reach Worker;
- forbidden frames fail as protocol specifies;
- `get-messages` returns typed 410, never SPA HTML;
- API/agent failures never become SPA fallback.

Preview URLs are currently disabled. Worker Previews do not isolate every bound service. Fixture UI can use
local Vite/Storybook/workerd; integrated Workflow/Queue/provider acceptance remains controlled local or
serialized staging.

## Browser runtime boundary

Legacy root `/sw.js` registers, claims and caches `/`. U6 retires that exact registration/cache through ADR-
0017. New React and safe rollback register no worker. Permanent inert no-cache `/sw.js` remains for origin
lifetime.

A controlled `/agent-inbox/` remains fail-closed until exact unregister and controller-null reload. The React
shell applies a non-private privacy mask synchronously on `pagehide`; persisted `pageshow` remains masked from
first paint until fresh session/health/deployment verification.

Static owner routes receive reviewed CSP/referrer/frame/permissions/noindex/cache headers through Vite public
inputs and actual-response verification. Worker-generated API/OAuth/MCP/agent responses remain backend-owned.

## Agent tooling

Repository source, registry JSON, CSF stories, deterministic fixtures, Playwright tests, traces and screenshots
are authority. MCP tools are optional conveniences. Wrangler and official Cloudflare Vite plugin remain build
authority; beta `cf` CLI cannot introduce parallel config/build/deploy ownership.
