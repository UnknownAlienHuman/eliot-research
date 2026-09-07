# Eliot Research implementation rules

Governed by `docs/architecture/ELIOT_RESEARCH.md`. Normal work: start with `docs/agent-work/`; read
only packet-named contracts/neighbors; do not reread architecture.

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

## Swarm edit protocol

- Claim exactly one work packet; edit only `owned_paths`.
- Do not edit another agent's barrel file, package manifest, migration, or shared fixture unless packet
  grants ownership.
- Implement behind existing interfaces; no public field/enum renames.
- Keep source files <600 lines and packages <10,000 source lines; split by capability, not arbitrary count.
- Every mutation: Intent → Attempt → Receipt → Readback → Reconciliation.
- Every expensive/retryable operation accepts idempotency identity and cancellation/budget context.
- Tests cover the packet's named negative case, not only happy path.
- Finish `pnpm check:affected`; record commands/results in PR body.

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
apps/eliotr-core       → composition root only
apps/eliotr-pwa        → contracts + HTTPS API only
```

The automated boundary check is authoritative for allowed package imports.

## Implementation-state gate

Before claiming packet, inspect `docs/implementation/implementation-status.json` and
`docs/implementation/gap-register.md`. A compiling port or final-shaped DTO is not an implemented feature.
Remove fail-closed sentinel only with its negative acceptance case + required live receipt; update status
registry same commit.
