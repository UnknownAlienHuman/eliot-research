# Frontend stack validation — React owner workspace

**Date:** 2026-10-08
**Baseline:** `517723e3ee41d208bbc1e1696ed23070000a0150`
**Review pass:** 6 — supplied-proposal disposition, native-first primitives, owner-approved visual direction,
immutable byte representations, progressive Research transport, exact tool compatibility, local bindings and
attested deploy bridge.
**Status:** researched evidence; dependency installation and executable compatibility remain `PENDING`.
**Authority:** supporting evidence for ADR-0016/0017, ER-47/48 and execution map.

This file answers whether selected frontend can fit the existing Worker/release machinery and what U1/U6 must
prove. Product interaction lives in `OWNER_WEB_UI.md`; scheduling lives in execution map.

The supplied proposal correctly identifies React, Vite, Tailwind, progressive tool/result UI and source-owned
components as strong directions for a dynamic NotebookLM-like client. Its mandatory Hono/Agents backend,
generic Vectorize Top-K RAG, raw chain-of-thought and immediate Tiptap/generator grid are not adopted because
Eliot already has Worker/API/Workflow/exact-evidence authority and no truthful operation for several controls.

## 1. Selected direction

| Concern | Decision | Qualification boundary |
|---|---|---|
| View | React 19.x | exact pin, strict TS, Strict Mode effect tests |
| Build | Vite 8.x + official Cloudflare plugin | exact peer tuple + one client/Worker output |
| Navigation | React Router SPA library | product URL codecs; no SSR |
| Remote state | TanStack Query | memory only, explicit cancellation/currentness/removal |
| Styling | Tailwind v4 behind semantic tokens | syntax, not design authority |
| Native controls | platform semantics first | no unnecessary wrapper/library replacement |
| Composite primitives | Base UI candidate; React Aria comparison | one external family after a11y/CSP/browser tests |
| Product UI | `@eliotr/ui` | minimum active catalog by real consumer |
| Pane geometry | `@eliotr/ui` abstraction | splitter provisional; static panes accepted |
| Component review | stable CSF + catalog | MCP optional |
| Browser acceptance | Playwright | deterministic interaction/a11y/CSP/network/visual |
| Product reference | U1-R current live NotebookLM + official M3/M3 Expressive matrix | before tokens/shell |
| Visual direction | U1-D internal manager-accepted canonical composition | before shell assembly |
| Usability | U2-X fresh-context no-hint primary-loop audit | before real feature completion |
| Local inspection | Local Explorer + DevTools | after binding preflight |
| Progressive Research | transport-neutral public snapshots/events over one run | polling baseline; versioned channel only via ER-21/24 |
| Realtime | Agents SDK only for approved durable channel | not generic owner-data/Research authority |

Hono is optional router, not source of binding support. RSC/Next/vinext/TanStack Start/React Router full-stack
are excluded because private owner workspace has mature server/API root and no SEO/SSR requirement.

### 1.1 Supplied proposal disposition

| Element | Eliot decision | Reason / retained requirement |
|---|---|---|
| React 19 + Vite | **Adopt** | correct dynamic SPA fit; exact tuple remains executable proof |
| Tailwind + shadcn-style source ownership + M3 | **Adapt** | Tailwind syntax; `@eliotr/ui` semantic authority; native first, one composite family |
| Three resizable columns | **Adapt** | Sources + Research + contextual evidence; Studio destination; resize provisional |
| Streaming/tool calls | **Retain outcome, change trust model** | bounded public stages/events/receipts; no hidden reasoning; polling valid |
| `@ai-sdk/react` | **Not baseline** | only after event contract and measured lifecycle/bundle value |
| Hono rewrite | **Reject for migration** | unrelated backend rewrite |
| Agents SDK core backend | **Reject as generic authority; optional capability** | owner API/Workflow/D1/MCP remain authority |
| Generic Vectorize + Workers AI Top-K | **Reject as Eliot replacement** | indexes are locators; exact admitted-revision evidence required |
| Tiptap immediately | **Defer** | no editor before versioned edit/COW/re-audit/readback command |
| Generator grid | **Defer/omit** | only implemented operations visible |
| MCP via Agents SDK | **Preserve outcome, not rewrite** | existing authenticated MCP/federation remains |

This records disposition, not implementation.

## 2. Current repository and upstream tuple

Reviewed repository pins:

```text
Node >= 22.13.0
pnpm 11.23.0
TypeScript 6.0.3
Vite 8.2.2
Wrangler 4.143.1
@cloudflare/vitest-plugin 1.3.2
Playwright Core 1.63.0
```

Workers SDK main checked 2026-10-08 reports:

```text
@cloudflare/vite-plugin 1.63.1
peer Vite: ^6.1.0 || ^7.0.0 || ^8.0.0
Wrangler main: 4.149.0
```

This proves Vite 8 is in current plugin peer range, not that published plugin 1.63.1 and repository Wrangler
4.143.1 form supported tuple. U1 either retains Wrangler and chooses compatible plugin release or updates
plugin+Wrangler atomically under ER-00 with lock/types/full gates. No `--legacy-peer-deps`, peer override or
duplicate Wrangler.

Primary evidence:

- <https://developers.cloudflare.com/workers/vite-plugin/reference/api/>
- <https://github.com/cloudflare/workers-sdk/blob/main/packages/vite-plugin-cloudflare/package.json>
- <https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/package.json>

## 3. Monorepo Worker entry

Plugin resolves `configPath` relative to Vite root and Worker `main` relative to Wrangler config directory:

```text
apps/eliotr-web/vite.config.ts
  cloudflare({ configPath: "../eliotr-core/wrangler.jsonc" })

apps/eliotr-core/wrangler.jsonc
  main: "src/index.ts"
```

Worker entry need not be copied. U1 executes exact graph on Windows/Linux including workspace imports,
Wasm/modules and restart. Source support is not Eliot compatibility proof.

## 4. Input Wrangler semantics

| Input | Vite behavior | Required proof |
|---|---|---|
| `main` | resolved from config directory | module graph/entry digest |
| legacy `assets.directory` | output points to Vite assets | output manifest/directory digest |
| `minify:true` | replaced by Vite `build.minify` | explicit setting + Worker size/behavior |
| `build/rules/tsconfig/site/no_bundle` if present | non-applicable | fail/warn on reliance |
| compatibility/bindings/routes/migrations/observability | remain authority subject to support | normalized input/output parity |

Input config and output `wrangler.json` are separate identities. U1 retains both digests and field parity;
planning assumes no permanent literal output path.

## 5. Local binding safety

Plugin `remoteBindings` defaults true. Ordinary integrated work uses:

```text
CLOUDFLARE_ENV=test
remoteBindings:false
```

Environment and remote policy are independent. Cross-platform wrapper rejects wrong env, `remote:true`,
production resources/routes/domains, Workers AI/Browser effects and unapproved provider destinations.

| Binding | Local simulation | Remote binding | U1 disposition |
|---|---:|---:|---|
| Assets | yes | no | generated assets |
| D1 | yes | yes | local test DB |
| R2 | yes | yes | local test buckets |
| Queues | yes | yes | local producer/consumer; deployed semantics staging |
| DO | yes | no | local class/state |
| Workflows | yes | no | local tests; deployed retry/resume staging |
| Service bindings | yes | yes | declared test Workers only |
| Analytics | yes | no | local test where needed |
| Workers AI | no | yes | fixture ordinarily |
| Vectorize | no | yes | not baseline; never prod fallback |
| AI Search | no ordinary local authority in test config | remote/platform-dependent | fixture or dedicated nonprod |

Vite plugin has no equivalent of full `wrangler dev --remote`; selected remote bindings still run code
locally. Unsupported binding is `FIXTURE`, `REMOTE_NONPROD` or `PENDING`, never fake local conformance.

## 6. Exact compatibility probes

Before owner endpoint connection:

- frozen install, peers/licenses/duplicates;
- B-U root registration and unknown-package negative;
- sibling configPath/Worker/workspace import resolution;
- dev/HMR/interruption/restart/build/preview;
- output config/non-applicable fields;
- explicit minification and Worker/module manifest;
- local D1/R2/Queue/DO/Workflow state/reset;
- API/SPA separation: API errors never become SPA HTML;
- wrong-env/remote/production binding rejection;
- Windows/Linux paths/signals/cleanup;
- JS/CSS/font/Worker budgets;
- no second build/deploy authority.

Matrix remains `PENDING`.

## 7. Deployment bridge

Current orchestrator builds legacy PWA, pins `wrangler.deploy.jsonc`, dry-runs/attests entrypoint and deploys
`--no-bundle --config`. It bypasses Vite redirected config, so unchanged orchestrator cannot follow Vite build.

U6 chooses exactly one:

### A. Attest/deploy Vite output directly

Bind output config, Worker modules and assets, deploy exact graph without rebuild.

### B. Wrangler redirected deployment

Run from exact Vite build root without overriding redirect, pin output/modules/assets before deploy.

Both preserve migration/schema/capability/resource/authority checks. Required negatives: stale/missing redirect,
wrong cwd, environment mismatch, explicit legacy config, automatic configuration mutation, post-attestation
rebuild, mixed graph and rollback after worker retirement.

## 8. Router, Query and React execution

React Router is client library; URL identity grants no authority. TanStack Query defaults:

```text
networkMode: online
refetchOnWindowFocus: false
refetchOnReconnect: false
refetchOnMount: false unless safe class opts in
retry: false
persistent cache: forbidden
```

Protected keys include session/principal/deployment epochs. Authority/lifecycle loss cancels/removes data.
Mutation retry is explicit same-identity reconciliation.

Strict Mode enabled; render pure/effects restartable. Mutation/operation ID begins only from explicit command.
Production-only suppression of dev replay failure is prohibited.

### 8.1 Progressive Research

Baseline: one accepted run identity, durable status/history/report authority, bounded polling, public stages/
tool events/receipts/limitations only.

Future channel requires ER-21/24 contract:

```text
run + deployment/session/generation identity
versioned event + monotonic sequence/resume cursor
bounded frame/total/frequency/history
snapshot/readback after gap/reconnect
public disclosure class
no mutation/operation-ID/paid replay on reconnect
```

Duplicate/reordered/missing/late events cannot advance completion. Disconnect is `DEGRADED`/`UNKNOWN` until
readback. UI may coalesce rendering but retain canonical stages/receipts.

`@ai-sdk/react` only after accepted contract, measured value and proof of Eliot semantics.

### 8.2 Exact byte representation

A valid `Content-Range` alone is insufficient. U3-D/ER-48 range reads require:

- exact admitted revision/object;
- strong ETag or exact digest/version validator from authorized metadata;
- endpoint-approved conditional (`If-Match` or equivalent);
- one range, no multipart;
- no transformed/compressed representation unless explicit equivalence contract;
- numeric total and delivered-byte arithmetic;
- feature digest/coordinate/lifecycle/generation recheck;
- typed 412/416/currentness failure, never silent full fallback.

Browser cannot force forbidden transport headers. Server must expose stable untransformed bytes or client uses
bounded whole-object read.

## 9. Primitive, Material and visual-direction decision

Native semantics are first choice. Base UI is starting external composite candidate; React Aria bounded
comparison. U1 locks one external family after keyboard/focus/screen-reader/touch/CSP/browser qualification.
`react-resizable-panels` remains behind `@eliotr/ui`; non-resizable layout accepted.

MUI v9 is current, not obsolete. It is not selected because Emotion/`sx` adds second styling authority, Eliot
still needs its own M3 layer, governance duplicates and source-owned primitives tighten CSP/bundle/behavior.
Advanced MUI X is unnecessary/commercial/alpha for baseline.

U1-R is mandatory before token/shell decisions: inspect the current live NotebookLM and current official
Material 3 / M3 Expressive in a browser. U1-D then accepts one coherent 1440/390, light/dark, long RU/EN Eliot
composition internally. Generic shadcn/admin layout, copied NotebookLM chrome or auto-approved pixels do not
pass. U2-X is a fresh-context no-hint audit. The manager fixes failures and continues; the owner reviews the
complete U5-X interface.

## 10. Static-SPA CSP

Static Assets cannot assume unique per-response nonce. Actual primitive/pane/Markdown/editor output runs under:

- no script `unsafe-inline`;
- injected style disabled/externalized where supported;
- narrow `style-src-attr` for reviewed computed values only;
- no imaginary nonce;
- browser-collected CSP violations;
- reject modes requiring broad weakening.

Source lint is not dependency-output proof.

## 11. U1 exit checklist

Before U2/API wiring:

- [ ] exact dependency tuple/peers/licenses retained;
- [ ] no duplicate Wrangler/React/composite/styling authority;
- [ ] B-U/root boundary/unknown-package gates pass;
- [ ] sibling Worker/workspace graph builds Windows/Linux;
- [ ] normalized config parity and budgets measured;
- [ ] test environment/remote-resource rejection passes;
- [ ] honest binding capability receipt;
- [ ] Local Explorer only after preflight;
- [ ] no service worker; security/cache headers pass;
- [ ] primitive/pane/Markdown CSP/a11y passes;
- [ ] Strict Mode/Query/lifecycle negatives pass;
- [ ] native-first M3 foundation and one composite family approved;
- [ ] deterministic harness works without MCP;
- [ ] U1-R live reference exists and U1-D has manager-recorded internal acceptance;
- [ ] U6 bridge has selected executable design;
- [ ] source stop explicitly lifted for named checkpoint.

## 12. Uncertainty

No package install or Vite/Worker/browser matrix ran in this documentation pass. Official source supports Vite
8/sibling config topology and exposes binding/deploy constraints. Exact peers, module graph, output, CSP,
U1-D/U2-X, immutable range contract, progress transport, attestation and budgets remain `PENDING`.
