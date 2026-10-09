# Owner-web implementation preflight — 2026-10-09

**Status:** static source audit for PR #329; executable implementation gates remain pending.
**Reviewed main:** `00c85244d362aa89b2f146286a31dffc10a8ed98`.
**PR topology:** one documentation/process commit rebased onto reviewed main; exact head is recorded in the PR
body because this document cannot truthfully contain its own final commit SHA.
**Scope:** ER-47/48/49 bootstrap, B-C/B-U, U1.1a/U1.1b, C0/C1, ResearchSession projection and U6.

This document records concrete repository conditions the first frontend agent will meet. It authorizes no
source implementation, dependency installation, merge, deployment or account mutation. A full checkout could
not be materialized in the review runtime, so no Node/pnpm command below is claimed executed.

## 1. PR and moving-main boundary

The reviewed PR changes documentation/process only relative to reviewed main. It does not modify runtime,
dependencies, lockfile, Worker configuration, migrations, databases or Cloudflare resources. GitHub Actions
are manual-only and no automatic status/check proves the head.

Main is active. Before publication or source work the manager reads `refs/heads/main`, compares the exact base,
reconciles overlaps, and records base/head SHAs. A previous clean compare or PR body is not authority.

## 2. Boundary registration remains fail-open for unknown packages

Current boundary ownership skips a source file when no explicit owner rule matches. Existing negatives cover
forbidden imports inside known packages, not an unknown workspace source root.

B-C/B-U must atomically:

1. enumerate source-bearing workspace packages/apps;
2. require exactly one boundary owner for every discovered root;
3. reject unknown, duplicate, shadowed and stale rules;
4. add an unregistered-package negative requiring exit 1;
5. register owner-client/UI/web imports with finite allowlists;
6. retain exact host-tool exceptions instead of broad exclusions.

Package glob discovery, package-local compile or Vite success is not root integration.

## 3. Root TypeScript registration is absent

Root project references do not yet include:

```text
apps/eliotr-web
packages/ui
packages/owner-api-client
```

B-C/B-U must add exact references and prove that an unreferenced source package cannot be reported as root-
typechecked.

## 4. Reviewed dependency candidate and Node-floor constraint

Current root:

```text
Node >=22.13.0
pnpm 11.23.0
Vite 8.2.2
Wrangler 4.143.1
TypeScript 6.0.3
Vitest 4.1.11
```

U1.1a package-local candidate:

```text
react 19.3.0
react-dom 19.3.0
@types/react 19.3.0
@types/react-dom 19.3.0
@vitejs/plugin-react 6.1.2
@cloudflare/vite-plugin 1.54.11
react-router 7.18.4
@tanstack/react-query 5.104.1
tailwindcss 4.3.3
@tailwindcss/vite 4.3.3
```

Router 8 would raise the Node floor; a leaf may not do that implicitly. Initial bootstrap uses Router 7 library
mode or stops for ER-00. No framework mode, SSR/RSC, second server entrypoint, peer override, legacy-peer-deps,
duplicate React/Vite/Wrangler or unpinned production dependency.

The tuple is `PROPOSED` until frozen install, peer graph, generated output and root gates pass.

## 5. ResearchSession exact projection changes dependency and UI assumptions

Current main no longer presents ResearchSession as generic chat/progress transport. It exposes exactly one
read-only callable snapshot:

```text
agents/client AgentClient
readResearchSessionProjection()
no arguments
protocol eliotr.research-session-projection.v1
states ACTIVE | CANCELLED | ENGINE_COMPLETED
get-messages → 410 SESSION_CHAT_HISTORY_DISABLED
all chat/state/history/MCP/other frames rejected
no proactive progress push
```

The snapshot omits answer content, failure detail, prompt, provider payload and transcript. Canonical HTTP
status/history/readback continues to own detailed progress and reconciliation.

Preflight consequences:

- React app does not declare/import Agents packages;
- ER-48 may propose one exact transport-specific `agents/client` adapter after B-C/B-U qualification;
- only that adapter may open the socket;
- production graph inspection proves Agents SDK does not leak into unrelated HTTP/UI chunks;
- `get-messages` 410 is expected typed behavior;
- missing/stale snapshot remains degraded until canonical HTTP readback;
- `ENGINE_COMPLETED` is not artifact acceptance/publication;
- reconnect/disconnect never creates or cancels a run/effect.

## 6. Worker-first routing source policy exists; generated/live proof remains

Current source sends these families to Worker before SPA assets:

```text
/healthz
/mcp
/agent-inbox
/agent-inbox/*
/agents
/agents/*
/api/*
/federation/*
/oauth/*
```

U1.1b/U6 still proves generated Vite output preserves the matrix and that:

- Agent upgrade and no-arg RPC reach Worker;
- forbidden frames fail/close rather than reach SPA;
- `get-messages` returns typed 410, never SPA HTML;
- API/agent failures never fall through to SPA;
- static routing files are not assumed to govern Worker responses;
- browser/native-edge/staging readback binds exact build identity.

## 7. Workflow admission is composed; automatic conversion remains blocked

Current main composes owner-bound capture and normalized admission through existing authority/storage/promotion
components and rechecks operation, principal, credential/deployment generation, ACTIVE run and held scope.

No authoritative producer of the full conversion bounds/options request has been accepted. Admission does not
extend current run scope.

U2/U3 therefore cannot claim automatic conversion, auto-selection, current-run scope expansion, replacement of
uncertain operation identity or logical source identity from filename/URL/capture ID.

## 8. Prompt/context selection is authority-sensitive

Current main snapshots branch candidates as untrusted data, uses server-selected mandatory evidence refs and
measures the exact provider-native request envelope. Oversized context candidates may be omitted and later
admissible candidates may backfill.

Frontend keeps retrieval candidate budget, prompt-context byte budget, citation outcome and semantic support
separate. It exposes no raw prompt or provider-native request and treats no candidate text as established truth.

## 9. Emitted/deployment evidence must be extended, not forked

Main already has emitted-budget and deployment receipt authority binding source/build inputs, entrypoint,
generated config, Worker bundle, application schema and asset identity. Current asset schema is legacy-PWA-
specific.

B-U/U6 extends it to one Vite owner-web+Worker graph, route-policy digest, rollback and inert `/sw.js`. No
post-attestation rebuild and no React asset graph paired with separately built Worker. Initial eager owner-web
JavaScript remains `<= 600 KiB gzip`.

## 10. Static routing policy remains separate evidence

`_headers`/`_redirects` are excluded from ordinary asset-body manifest and do not govern Worker-generated
responses. U6 needs a separate policy digest/response matrix covering owner static routes, API/OAuth/MCP/agent/
inbox/upgrade paths, security/cache headers, SPA-fallback negatives and permanent tombstone.

## 11. Documentation/index reconciliation

The PR implementation index preserves frontend documents and all backend documents added on main, including:

```text
workflow-conversion-admission-cutover.md
managed-generation-promotion-fence.md
research-session-projection-protocol.md
http-cache-semantics-advisory.md
issue-319-cookie-and-log-verification.md
```

Static inspection shows the required links. The recursive index command remains `PENDING` until run in a full
checkout.

## 12. Valid first implementation boundary

A broad task “implement the interface” remains invalid. After documentation/process gates and owner merge, the
first source checkpoint is only U1.1a:

```text
package-local web/UI manifests
package-local tsconfig/Vite config/index.html
exact dependency proposal
no install/root edit
no feature source
no backend/API/Agent wiring
no service worker/rich editor/resizable panes
```

Then the authorized manager continues automatically:

```text
U1.1a → B-U → U1.1b → U1-R → U1.2 → U1.3 → U1.4 → U1-D → U1.5
→ U2-X → U3 → U4 → U5-X → FINAL-UI owner review
```

ER-49 is required before parallel leaves, not before one manager plus one leaf. C0/B-C/C1 may proceed as a
separate ER-48 lane under the same restriction.

## 13. PENDING executable evidence

```text
pnpm work-packets:check
node scripts/check-docs-index.mjs
node scripts/check-implementation-status.mjs
git diff --check <base>...HEAD
unknown-workspace boundary negative
frozen install and peer graph
root TypeScript / ESLint / Vitest
AgentClient callable/strict-union/410/forbidden-frame browser tests
Vite/workerd generated routing parity
emitted owner-web/Worker/rollback receipt
routing-policy digest and response matrix
Storybook / Playwright / CSP / accessibility / performance
U1-D manager-recorded internal acceptance
U2-X fresh-context internal usability audit
pnpm check:full
staging/live acceptance
```

No item above is PASS until its exact command or human/live receipt exists.
