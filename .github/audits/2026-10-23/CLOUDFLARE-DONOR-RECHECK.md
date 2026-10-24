# Cloudflare release and donor recheck

**Reviewed:** 2026-10-23. **PR baseline:**
[`4b812daa`](https://github.com/UnknownAlienHuman/eliot-research/tree/4b812daa7206527c24d3bd1b80bcdfb2b82c82ef).

This pass rechecks the canonical documentation against the newest available Cloudflare changelog entries, upstream
package releases and the exact selected donor files. It records source evidence and handoff corrections; it is not
installed-SDK, live-service, performance or migration evidence.

## Findings

| # | Rechecked evidence | Consequence and correction |
|---|---|---|
| 53 | `@cloudflare/vite-plugin` `1.65.0` removed `experimental.newConfig` from stable v1. V1 now accepts Wrangler configuration only; `cloudflare.config.ts` requires v2 beta. Wrangler `4.150.0+` and Vite plugin `1.64.0+` also generate/upload Worker source maps by default. | The existing `wrangler.jsonc` choice is correct. DONORS now makes the stable-v1 boundary explicit and requires stage 0 to set and inspect source-map policy instead of inheriting a moving default. No beta config migration is introduced. |
| 54 | On 2026-10-23 Cloudflare limited D1 undelete requests to databases deleted within seven days. | Time Travel/undelete/PITR remain same-resource recovery only. Portable D1/R2/chat export and rehearsed import remain required; no architecture change is needed. |
| 55 | Strict Access service-token mode returns `401`/`403`, permits only Service Auth policies, ignores `CF_Authorization` cookies and does not mint one. New organizations created on or after 2026-10-05 cannot disable it. | The two-host Access design and distinct Service Auth identities remain correct. Integration must resend service-token headers and must not expect browser redirects/cookies for headless MCP clients. |
| 56 | AI Search became GA on 2026-10-01; usage billing starts 2026-11-01. Managed embedding/reranking is accounted in AI Search rather than Workers AI/Gateway logs. OCR/file-size limits are now explicit. | Search remains a paid disposable projection. Cost reporting must keep Search, generation and external-provider usage separate. OCR still cannot become canonical evidence without retained ordered text/mapping. |
| 57 | New Paid Workflows default to seven-day completed/error retention; steps and storage are billable, and sleep/event waits count as steps. | Product results must settle in D1/R2 before native completion. Keep Workflow steps coarse and avoid progress/polling fan-out. Longer native retention is optional diagnostics, not history. |
| 58 | New upstream patches appeared after the previous candidate: `agents 0.30.1`, `ai 7.0.152` and `@ai-sdk/react 4.0.156`; `@cloudflare/ai-chat 0.12.2`, provider `4.0.33`, MCP packages and Wrangler/Vite candidate remain compatible on paper. The Agents patch is PiHarness-specific. | DONORS now distinguishes latest source-reviewed patches from the stage-0 installed lockfile. No automatic bulk upgrade or Pi adoption follows from a newer version number. |
| 59 | Cloudflare product MCP servers retired `/sse` on 2026-10-22. | Eliot continues to expose one stateless `/mcp` handler. Existing configured Cloudflare endpoints are updated/reauthorized; no compatibility proxy is added. |
| 60 | Current Cloudflare OS source adds durable queued text steering, streamed Drive-PDF Markdown conversion and best-effort withdrawal after denial. | Useful conclusions are narrower: instructions can be queued durably; conversion can stream; denial cannot guarantee reversal after a provider effect. Eliot does not import the OS/gatekeeper platform or add mid-run steering without a measured need. |
| 61 | The selected Dify, RAGFlow agent, Docling, LightRAG, SurfSense, OpenNotebook, EdgeQuake and PipesHub files remain identical at current main/default branches. WeKnora still contains the selected transactional expected-version writer. Recent WeKnora/RAGFlow/PipesHub commits add replacement-safe cleanup, explicit reparse/config scope and bounded scoped reads. | Existing donor mechanisms remain valid. DONORS records the new lifecycle/scope lessons without repinning unrelated files or widening Eliot's architecture. |

## Canonical-document result

Architecture still correctly owns the product invariants: retained canonical evidence, explicit scope, bounded execution,
one Worker, one search projection and no compatibility/proof platform. Implementation already selects `wrangler.jsonc`,
separate Access identities, D1/R2 product storage, Search cost separation, Workflow result settlement and portable export.
MAP still correctly starts with the root-package/tooling/CI cut-in and postpones live-data retirement until verified
migration.

Therefore this pass changes the active donor/platform handoff and review register, not Architecture, Implementation or
MAP. Adding release facts to those documents would duplicate volatile evidence and turn platform defaults into product
requirements. Stage 0 must still compile the selected versions and inspect actual generated types/config output.

## Donor verification

The exact selected mechanism was compared with current source, rather than trusting repository feature lists:

- Dify parent/child processor: unchanged;
- RAGFlow budget-stop agent: unchanged; separate recent config/reparse fixes were reviewed;
- Docling HybridChunker: unchanged;
- LightRAG purge/recovery contract: unchanged;
- SurfSense citation/no-source prompt: unchanged;
- WeKnora transactional Wiki update: invariant remains; current lifecycle cleanup was reviewed separately;
- OpenNotebook chat and context builder: unchanged;
- EdgeQuake batch hydration: unchanged on its `edgequake-main` default branch;
- PipesHub redirect-safe fetcher: unchanged; current scope/bounds work was reviewed separately.

No donor application was installed, run or benchmarked. Cloud Notebook's inspected pin still has no root `LICENSE` file;
this remains unresolved copying permission, not a legal conclusion.

## Verification boundary

The official Cloudflare changelog/docs, GitHub release manifests and exact donor source/commit diffs were inspected.
The current canonical documents and review register were reread against those facts. No dependency installation,
TypeScript build, Clippy, product test, live Access/Search/Workflow/model request, production query, migration or
deployment was performed. The next implementation action remains MAP stage 0.
