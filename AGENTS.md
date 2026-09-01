# Eliot Research implementation rules

This repository is governed by:

- `docs/architecture/ELIOT_RESEARCH.md` for product and authority architecture;
- `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md` for language and runtime ownership;
- `docs/implementation/branch-discipline.md` for branch/worktree lifecycle.

Agents should not reread the whole architecture for normal work. Start from the work packet in
`docs/agent-work/`, then read only the contracts and neighboring modules named by that packet.

## Non-negotiable boundaries

1. One deployable Worker (`apps/eliotr-core`) plus static PWA assets. Packages are libraries, not
   services.
2. D1 Core and R2 Evidence/Work are canonical. D1 Search and AI Search are rebuildable projections.
3. An index result is a locator. It becomes evidence only after `EvidenceHandle` resolution against
   the exact admitted source revision, scope snapshot, owner generation, purge state, coordinate map,
   byte length, and excerpt digest.
4. One mutable owner per source namespace. Ownership transfer requires a valid
   `source.owner-cutover.v1` receipt; no flag or unilateral action is sufficient.
5. Equal bytes do not permit cross-residency deduplication. `ObjectResidencyKey` includes policy,
   lifecycle, encryption-key, and content identity.
6. Model calls, HTTP calls, and R2 reads never occur inside D1 transactions. Canonical mutation and
   outbox intent are committed together; Queue delivery is acceleration, not authority.
7. Worker code is bounded: no native binaries, child processes, local filesystem, embedded indexes,
   whole-corpus loads, OCR/PDF engines, large provider SDKs, LangChain/LlamaIndex, or Prisma.
8. Google Drive Exchange is untrusted, candidate-only transport. Frozen R2 bytes and D1 receipts are
   authoritative. IDs/hashes, never row positions, identify rows.
9. Unknown load-bearing wire fields fail closed. Public schemas are strict and versioned.
10. Never invent a tenth `CompletionDisposition`; transport completion and research completion are
    separate.

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

- Claim exactly one work packet. Edit only its `owned_paths`.
- One agent = one worktree = one branch = one task.
- Do not start another task while the current worktree or branch remains open.
- Merge, quarantine, or delete the branch immediately on completion.
- At most five non-default branches may exist; a branch without an open PR expires after 24 hours.
- Do not edit another agent's barrel file, package manifest, migration, or shared fixture unless the
  packet grants ownership.
- Add implementation behind existing interfaces; do not rename public fields or enums.
- Keep a source file below 600 lines and a package below 10,000 source lines. Split by capability,
  not by arbitrary line count.
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

Before claiming a packet, inspect `docs/implementation/implementation-status.json` and
`docs/implementation/gap-register.md`. A compiling port or final-shaped DTO is not an implemented
feature. Remove a fail-closed sentinel only together with its negative acceptance case and required
live receipt; update the status registry in the same commit.
