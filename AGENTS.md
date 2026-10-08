# Eliot Research implementation rules

**New here? Read [`docs/START-HERE.md`](docs/START-HERE.md) first.** It is the single repository entry
point. Backend managers then use
[`docs/implementation/backend-entrypoints.md`](docs/implementation/backend-entrypoints.md) for the
current wave, one-worktree-per-manager protocol, integration order and review checklist.

This repository is governed by:

- `docs/architecture/ELIOT_RESEARCH.md` for product and authority architecture;
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md` for language and runtime ownership;
- [ADR-0007](docs/adr/0007-external-agents-and-cloudflare-evolution.md) for the scoped 2026-09-29
  external-agent and platform-evolution amendments;
- `docs/implementation/branch-discipline.md` for branch/worktree lifecycle.

Agents should not reread the whole architecture for normal work. Start from the active PR/passport and
owning work packet, then read only the contracts and neighboring modules named by that packet.

## Non-negotiable boundaries

1. One deployable Worker (`apps/eliotr-core`) + static owner assets; packages are libraries, not services.
2. D1 Core/R2 Evidence/Work canonical; D1 Search/AI Search rebuildable projections.
3. Index results are locators; evidence only after `EvidenceHandle` resolution against exact admitted source
   revision, scope snapshot, owner generation, purge state, coordinate map, byte length, excerpt digest.
4. One mutable owner per source namespace; transfer requires valid `source.owner-cutover.v1` receipt; no
   flag/unilateral action suffices.
5. `ObjectResidencyKey` includes policy, lifecycle, encryption-key, content identity; equal bytes do not
   permit cross-residency deduplication.
6. Never make model, HTTP, or R2 calls inside D1 transactions. Commit canonical mutation + outbox intent
   together; Queue delivery accelerates, not authority.
7. Worker forbids native binaries, child processes, local filesystem, embedded indexes, whole-corpus loads,
   OCR/PDF engines, large provider SDKs, LangChain/LlamaIndex, Prisma.
8. Google Drive Exchange untrusted, candidate-only transport; frozen R2 bytes/D1 receipts authoritative;
   IDs/hashes, never row positions, identify rows.
9. Unknown load-bearing wire fields fail closed; public schemas strict/versioned.
10. Never invent a tenth `CompletionDisposition`; transport/research completion separate.

## Language and runtime ownership

1. TypeScript currently owns the Cloudflare control plane: Worker routing, Access, D1/R2/Queues,
   Workflows, Durable Objects, AI Search, Workers AI/AI Gateway, Analytics Engine, MCP transport,
   Google orchestration, owner web, Wrangler, and provisioning. ADR-0007 permits incremental Rust platform
   adapters, including a Rust-authored backend; preserve behavior and record each ownership cutover.
2. Rust owns pure deterministic domain authority: canonicalization, stable IDs, state machines, scope,
   policy/residency invariants, qualification, evidence/coverage dispositions, and algorithmic cores.
3. SQL owns D1 migrations, constraints, indexes, and executable transaction fixtures.
4. Pure Rust crates receive explicit bytes/state and perform no network, filesystem, clock, randomness,
   environment, process, or Cloudflare binding access.
5. The pure-kernel TypeScript↔Rust/Wasm ABI is versioned canonical UTF-8 bytes in and canonical bytes
   or typed errors out. Platform I/O belongs to separate adapters, not that kernel ABI.
6. TypeScript may reject malformed/oversized transport input earlier but may not strengthen a promoted
   Rust result.
7. Permanent duplicate TypeScript/Rust authority is prohibited. Differential shadow mode is temporary
   and must converge to one owner.
8. Record TypeScript/Rust capability ownership under ADR-0007. An additional production language
   outside the approved runtime roles requires a normative ADR.

## External models and agents

Model providers, agent clients and Google tools are independent choices. Muse may replace Spark;
no vendor is mandatory. The owner grants the required actions, including production writes or
administration; no blanket QA-only/staging-only restriction applies. Reuse existing authorization,
evidence and attempt semantics. See [ADR-0007](docs/adr/0007-external-agents-and-cloudflare-evolution.md)
for current adapter gaps and the [short runbook](docs/implementation/muse-operator-runbook.md).

## Manager and swarm protocol

The current backend execution phase is defined by
[backend-entrypoints.md](docs/implementation/backend-entrypoints.md). The older
`backend-delivery-plan.md` is a paused October 6 checkpoint and historical evidence, not the current queue.

- One manager owns one worktree and one bounded checkpoint at a time.
- Subagents do not create extra worktrees. They work inside the manager-owned tree under disjoint exact
  paths or remain read-only.
- One named integrator serializes shared contracts, composition roots, public routes, migrations,
  manifests, barrels, package/Cargo manifests, lockfiles, generated bindings and CI.
- Claim exact paths, base SHA, dependencies and build gates in the active PR before editing.
- Finish or explicitly hand off before taking another checkpoint.
- Never force-push over concurrent work. Reconcile a refreshed expected head and preserve history.
- Branch count, age and PR closure never authorize deletion. Automated cleanup requires the exact head
  already in main, no open PR, no protection and an expected-head conditional deletion.
- Do not edit another manager's shared file, package manifest, migration or fixture without the named
  integrator handoff.
- Add implementation behind existing interfaces; do not rename public fields or enums.
- Source-maintainability heuristics: at most 600 physical lines/file and 10,000 lines/package for
  `.ts/.tsx/.js/.mjs` under `src`, including colocated tests. Raw Worker/web source-byte ceilings are
  600 KiB/2 MiB. `scripts/check-budgets.mjs` defines the counted paths and exclusions. Split by
  capability, not arbitrary line count; never remove tests or move files merely to game the count.
  These are not emitted-artifact or platform limits. S90 separately measures the release targets
  (compressed Worker <= 4 MiB; initial owner-web JavaScript <= 600 KiB gzip) and runtime resources.
- Every mutation implements Intent → Attempt → Receipt → Readback → Reconciliation.
- Every expensive or retryable operation accepts an idempotency identity and cancellation/budget
  context.
- Tests must cover the negative case named in the packet, not only the happy path.

The owner's current phase is code first. During assembly run TypeScript compilation and scoped lint;
Rust changes also get compilation and minimal Clippy; SQL changes run the installed D1 depth/target
compiler. Execute narrow reproductions required by the active PR. Broad unit/browser/native/mutation/live
suites run after assembled product code. Report unexecuted checks as `PENDING`.

Final repository acceptance still runs `pnpm check:full`; after the Cargo workspace lands, Rust changes
also run the complete Cargo gate defined by `LANGUAGE_RUNTIME_CONTRACT.md`.

## Dependency direction

```text
contracts
  ↓
domain
  ↓
policy
  ↓
retrieval
  ↓
research

platform-cloudflare  → application ports

google-drive-exchange → contracts/domain/policy
interfaces            → application services
apps/eliotr-core       → composition root and Cloudflare control plane only
owner web              → contracts + browser feature libs + HTTPS API only
browser feature libs  → contracts + owner-api-client; Research UI → Source UI

Rust pure crates       → no Cloudflare/runtime dependency
eliotr-kernel-wasm     → Rust pure crates only
TypeScript Worker      → versioned Wasm ABI + Cloudflare bindings
```

The automated boundary check is authoritative for allowed package imports.

[ADR-0015](docs/adr/0015-browser-capability-libraries.md) permits the finite browser-only
libraries and the replacement owner-web architecture defined by the current UI owner. Static assets
receive no Worker bindings, provider credentials, backend authority or additional deployment. The
isolated agent inbox retains its standalone build and session rules.

## Implementation-state gate

Before claiming a checkpoint, inspect `docs/implementation/implementation-status.json` and
`docs/implementation/gap-register.md`. A compiling port or final-shaped DTO is not an implemented feature.
Remove a fail-closed sentinel only with its negative acceptance case and required live receipt; update the
status registry in the same accepted change.
