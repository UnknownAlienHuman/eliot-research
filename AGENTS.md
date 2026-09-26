# Eliot Research implementation rules

**New here? Read [`docs/START-HERE.md`](docs/START-HERE.md) first.** It is the single entry point:
read order, how to orient by running commands instead of trusting prose, how to claim work, the
verification gates and the branch discipline. This file states the boundaries; that one states the
procedure.

This repository is governed by:

- `docs/architecture/ELIOT_RESEARCH.md` for product and authority architecture;
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md` for language and runtime ownership;
- `docs/implementation/branch-discipline.md` for branch/worktree lifecycle.

Agents should not reread the whole architecture for normal work. Start from the work packet in
`docs/agent-work/`, then read only the contracts and neighboring modules named by that packet.

## Non-negotiable boundaries

1. One deployable Worker (`apps/eliotr-core`) + static PWA assets; packages are libraries, not services.
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

1. TypeScript permanently owns the Cloudflare control plane: Worker routing, Access, D1/R2/Queues,
   Workflows, Durable Objects, AI Search, Workers AI/AI Gateway, Analytics Engine, MCP transport,
   Google orchestration, PWA, Wrangler, and provisioning.
2. Rust owns pure deterministic domain authority: canonicalization, stable IDs, state machines, scope,
   policy/residency invariants, qualification, evidence/coverage dispositions, and algorithmic cores.
3. SQL owns D1 migrations, constraints, indexes, and executable transaction fixtures.
4. Pure Rust crates receive explicit bytes/state and perform no network, filesystem, clock, randomness,
   environment, process, or Cloudflare binding access.
5. The TypeScript↔Rust/Wasm boundary is versioned canonical UTF-8 bytes in and canonical bytes or typed
   errors out. Cloudflare handles never cross it.
6. TypeScript may reject malformed/oversized transport input earlier but may not strengthen a promoted
   Rust result.
7. Permanent duplicate TypeScript/Rust authority is prohibited. Differential shadow mode is temporary
   and must converge to one owner.
8. A new production language or a change to this ownership matrix requires a normative ADR.

## Swarm edit protocol

The owner's current code-delivery phase is defined in [backend-delivery-plan.md](docs/implementation/backend-delivery-plan.md).
Its compilation/scoped-lint-first procedure overrides routine test-first/full-suite-per-push defaults
below until assembly. Preserve all negative/final acceptance criteria and report unexecuted checks as pending.

- Claim exactly one work packet. Edit only its `owned_paths`.
- Owner-directed implementation is on `main` only, without additional worktrees or task branches.
- One agent holds one checkpoint; finish or explicitly hand it off before taking another.
- Publish tested commits without rewriting history; preserve concurrent main changes.
- Branch count, age, and a closed PR never authorize deletion. Automated cleanup requires the exact
  head already in main, no open PR, no protection, and an expected-head conditional deletion.
- Do not edit another agent's barrel file, package manifest, migration, or shared fixture unless the
  packet grants ownership.
- Add implementation behind existing interfaces; do not rename public fields or enums.
- Source-maintainability heuristics: at most 600 physical lines/file and 10,000 lines/package for
  `.ts/.tsx/.js/.mjs` under `src`, including colocated tests. Raw Worker/PWA source-byte ceilings are
  600 KiB/2 MiB. `scripts/check-budgets.mjs` defines the counted paths and exclusions. Split by
  capability, not arbitrary line count; never remove tests or move files merely to game the count.
  These are not emitted-artifact or platform limits. S90 separately measures the release targets
  (compressed Worker <= 4 MiB; initial PWA JavaScript <= 600 KiB gzip) and runtime resources.
- Every mutation implements Intent → Attempt → Receipt → Readback → Reconciliation.
- Every expensive or retryable operation accepts an idempotency identity and cancellation/budget
  context.
- Tests must cover the negative case named in the packet, not only the happy path.
- Finish by running `pnpm check:affected`; after the Cargo workspace lands, Rust changes also run the
  complete Cargo gate defined by `LANGUAGE_RUNTIME_CONTRACT.md`.
- Record commands and results in the PR body.

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
apps/eliotr-pwa        → contracts + HTTPS API only

Rust pure crates       → no Cloudflare/runtime dependency
eliotr-kernel-wasm     → Rust pure crates only
TypeScript Worker      → versioned Wasm ABI + Cloudflare bindings
```

The automated boundary check is authoritative for allowed package imports.

## Implementation-state gate

Before claiming packet, inspect `docs/implementation/implementation-status.json` and
`docs/implementation/gap-register.md`. A compiling port or final-shaped DTO is not an implemented feature.
Remove fail-closed sentinel only with its negative acceptance case + required live receipt; update status
registry same commit.
