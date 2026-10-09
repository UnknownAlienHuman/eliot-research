# Eliot Research implementation rules

**New here? Read [`docs/START-HERE.md`](docs/START-HERE.md) first.** It is the single entry point for read
order, orientation, claim procedure, verification and branch discipline. This file states boundaries.

This repository is governed by:

- `docs/architecture/ELIOT_RESEARCH.md` for product/authority architecture;
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md` for language/runtime ownership;
- [ADR-0007](docs/adr/0007-external-agents-and-cloudflare-evolution.md) for external-agent/platform amendments;
- [ADR-0016](docs/adr/0016-react-cloudflare-owner-ui.md) for owner-web platform/design migration;
- [ADR-0017](docs/adr/0017-owner-web-browser-runtime-and-tooling.md) for browser cutover/security/caching;
- [Material UI agent playbook](docs/agent-work/frontend-material-agent-playbook.md) for the exact UI tool, source, implementation and browser-verification procedure;
- `docs/implementation/branch-discipline.md` for branch/worktree lifecycle.

Start from the work packet, then read only contracts/modules named by exact checkpoint.

## Non-negotiable boundaries

1. One deployable Worker (`apps/eliotr-core`) + static owner-web assets; packages are libraries, not services.
2. D1 Core/R2 Evidence/Work canonical; D1 Search/AI Search rebuildable projections.
3. Index results are locators; evidence follows `EvidenceHandle` resolution against exact admitted revision,
   scope snapshot, owner generation, purge state, coordinate map, byte length and excerpt digest.
4. One mutable owner per source namespace; transfer requires valid `source.owner-cutover.v1` receipt.
5. `ObjectResidencyKey` includes policy/lifecycle/key/content identity; equal bytes do not permit cross-residency
   deduplication.
6. Never make model, HTTP or R2 calls inside D1 transactions. Commit canonical mutation + outbox intent;
   Queue accelerates, not authorizes.
7. Worker forbids native binaries, child processes, local filesystem, embedded indexes, whole-corpus loads,
   OCR/PDF engines, large provider SDKs, LangChain/LlamaIndex and Prisma.
8. Google Drive Exchange is untrusted candidate transport; frozen R2 bytes/D1 receipts are authoritative.
9. Unknown load-bearing wire fields fail closed; public schemas are strict/versioned.
10. Never invent a tenth `CompletionDisposition`; transport and Research completion remain separate.

## Language and runtime ownership

1. TypeScript currently owns Cloudflare control plane: Worker routing, Access, D1/R2/Queues, Workflows, DO,
   AI Search, Workers AI/Gateway, Analytics, MCP, Google orchestration, owner web, Wrangler and provisioning.
   ADR-0007 permits incremental Rust platform adapters; preserve behavior and record cutover.
2. Rust owns pure deterministic domain authority: canonicalization, IDs, state machines, scope, policy/
   residency invariants, qualification, evidence/coverage dispositions and algorithmic cores.
3. SQL owns D1 migrations, constraints, indexes and transaction fixtures.
4. Pure Rust receives explicit bytes/state and performs no network/filesystem/clock/randomness/env/process/
   Cloudflare access.
5. TypeScript↔Rust/Wasm pure-kernel ABI is versioned canonical UTF-8 bytes in and canonical bytes/typed errors
   out. Platform I/O stays in adapters.
6. TypeScript may reject malformed/oversized transport earlier but may not strengthen a promoted Rust result.
7. Permanent duplicate TypeScript/Rust authority is prohibited.
8. Additional production language outside approved roles requires normative ADR.

## Owner web migration

ADR-0016/0017 change presentation/browser runtime without changing backend authority.

- ER-25 retains served `apps/eliotr-pwa` until cutover. No new design system, shell, layout controller, global
  CSS layer or feature renderer belongs there.
- ER-47 owns `apps/eliotr-web`, `packages/ui`, bounded UI tests/scripts and
  `docs/agent-work/frontend-owner-claims/ER-47/**`; not root manifests/lock/Worker/CI/contracts/legacy.
- ER-48 owns mixed browser client packages, extracts side-effect-free `@eliotr/owner-api-client`, preserves
  ER-25 adapters and owns `frontend-owner-claims/ER-48/**`. React never imports legacy browser roots or copies
  decoders.
- ER-49 owns static checkpoint registry/checker/tests. It validates structure/scope/Git ancestry but never
  edits claims, grants product/root ownership or decides whether human approval/test evidence is truthful.
- ER-47/48/49 have empty coarse dependencies. Exact C/U/B prerequisites/handoffs are in
  `docs/agent-work/frontend-owner-execution-map.md`; autonomous tranche continuation is governed by
  `docs/agent-work/frontend-autonomous-manager-runbook.md`.
- New workspace directories are not integrated because globs see them. ER-00 B-C/B-U register manifests in
  lockfile/root TS/fail-closed boundaries/tests/budgets before C1 or Vite probe.
- Browser code calls strict same-origin owner API and receives no Cloudflare binding/credential.
- React does not weaken currentness, evidence, disclosure, cancellation or idempotency.
- No application `innerHTML`, selector/MutationObserver product state, live DOM reparenting, arbitrary design
  literals or mixed composite primitive stacks. Prefer native semantics for ordinary controls.
- Protected Query data is removed after authority/generation loss; mutations never auto-retry.
- Exact range bytes require admitted revision, strong validator/conditional, one untransformed representation
  and post-read digest/currentness checks; otherwise use bounded whole read.
- Progressive Research may use polling or accepted versioned public-event reader. Events cannot allocate/
  repeat run, invent completion or expose hidden reasoning/prompts/provider payloads.
- React registers no service worker. Non-claiming retirement, controller-null inbox recovery, synchronous
  first-paint mask, permanent inert `/sw.js` and retirement-safe rollback are cutover gates.
- Normal Vite development disables remote bindings; Local Explorer follows binding preflight.
- Storybook/shadcn/DevTools MCP are optional accelerators; repository source/stories/manifests/CLI/artifacts
  remain sufficient.
- U1-R requires a live-browser NotebookLM and current Material 3 / M3 Expressive reference study before
  token/shell decisions. U1-D and U2-X are internal manager quality gates under the current owner authorization;
  they do not interrupt F1-F4. The owner reviews the finished integrated interface after U5-X and before any
  final merge, deployment or cutover.

Read the Material UI agent playbook first for every rendered UI checkpoint, then the autonomous-manager
runbook and live NotebookLM/Material reference protocol. Leaves read the exact execution-map checkpoint and only
the specialist source/contracts named by it.

## External models and agents

Model providers, agent clients and Google tools are independent choices; no vendor is mandatory. The owner may
grant required production writes/administration; no blanket QA-only restriction applies. Reuse authorization,
evidence and attempt semantics. See ADR-0007 and operator runbook.

Cloudflare Agents SDK is capability-scoped. It may support approved durable realtime/chat/RPC; it does not
replace owner API, canonical D1, Workflows or MCP.

## Swarm edit protocol

Current code-delivery phase is defined in `backend-delivery-plan.md`; its scoped compile/lint-first procedure
applies until assembly. Preserve final negatives and mark unexecuted checks pending.

- Claim exactly one ordinary packet, owner-authorized ER-47/48 manager packet, or bounded ER-49 packet. Edit
  only `owned_paths`.
- Direct main is default. Owner may authorize exactly one manager worktree/review branch for named packet/PR.
  Leaves use manager context and create no branch/worktree.
- Before ER-49, at most one frontend manager + one leaf. After ER-49:
  - claim commit is a strict ancestor of covered source edits;
  - each source-edit commit has exactly one active covering claim in parent tree;
  - same-commit claim+source, unclaimed/out-of-scope edit and overlap fail;
  - one active claim per checkpoint and one active manager context per packet;
  - predecessor refs name checkpoint + reachable ancestor commit; manager/external gates include approval ref.
- ER-49 validates mechanics, not substantive correctness of approval/evidence. Manager/operator review remains
  authoritative.
- Manager branch/claim does not lift stop, expand ownership, complete dependencies or authorize merge/deploy/
  account mutation.
- One leaf holds one checkpoint; finish/handoff before another. A manager with a tranche authorization
  immediately selects the next dependency-ready checkpoint and does not request routine continuation approval.
- Publish tested commits without history rewrite; preserve concurrent main changes.
- Branch count/age/closed PR never authorizes deletion. Cleanup requires exact head already in main, no open
  PR/protection and expected-head conditional deletion.
- Do not edit another agent's barrel, manifest, migration, claim directory or shared fixture unless granted.
- Add behind existing interfaces; do not rename public fields/enums.
- Maintainability: ≤600 physical lines/file and ≤10,000 source lines/package under `src`; Worker/PWA raw source
  ceilings 600 KiB/2 MiB. ER-00 B-U deliberately adds new source/emitted gates. Split by capability, never
  game counts. Initial owner-web JS release ceiling remains ≤600 KiB gzip.
- Mutations implement Intent → Attempt → Receipt → Readback → Reconciliation.
- Expensive/retryable operations accept idempotency identity and cancellation/budget context.
- Tests cover packet negative case, not only happy path.
- Finish with `pnpm check:full`; Rust changes also run complete Cargo gate when applicable.
- Record commands/results in PR body.

## Dependency direction

```text
contracts → domain → policy → retrieval → research
platform-cloudflare → application ports
google-drive-exchange → contracts/domain/policy
interfaces → application services
apps/eliotr-core → composition root + Cloudflare control plane only
owner-api-client → contracts + injected HTTPS transport; no DOM/global events
apps/eliotr-web → @eliotr/ui + owner-api-client + React query adapters
packages/ui → tokens/primitives/patterns; no network/backend authority
apps/eliotr-pwa → ER-25 compatibility until cutover
legacy browser packages → ER-48 adapters over owner-api-client
Rust pure crates → no Cloudflare/runtime dependency
eliotr-kernel-wasm → Rust pure crates only
TypeScript Worker → versioned Wasm ABI + Cloudflare bindings
```

Automated boundary gate is authoritative and must fail closed for unknown workspace source packages.
ADR-0015's proposed `pwa-knowledge-workspace` is absent and must not be created to satisfy stale prose.

## Implementation-state gate

Before claiming, inspect `implementation-status.json` and `gap-register.md`. A compiling port, DTO, claim,
package-local build, attractive story or screenshot is not implemented/live-qualified behavior. Remove
fail-closed sentinel only with negative acceptance and required live/human evidence; update status same commit.
