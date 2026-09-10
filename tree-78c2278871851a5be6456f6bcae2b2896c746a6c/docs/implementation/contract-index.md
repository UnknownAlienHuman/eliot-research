# Canonical contract index

Public wire contracts live only in `packages/contracts/src`. Leaf packages may add internal types but
must not publish alternate wire shapes.

| Contract family | Canonical file | Key invariants |
|---|---|---|
| common IDs/digests/refs | `common.ts` | bounded strings, strict SHA-256, positive revisions |
| source ownership/admission/revisions | `source.ts` | one mutable owner; candidate has no effect |
| source-owner cutover | `owner-cutover.ts` | bilateral exact receipt; old fenced, new active |
| complete residency identity | `residency.ts` | all policy/security/lifecycle domains participate |
| project/library/readiness | `library.ts` | global source, many-to-many membership, channel readiness |
| scope algebra/snapshot | `scope.ts` | immutable resolved set + generations + purge revision |
| normalized bundle | `normalized-bundle.ts` | exact `eliotr.normalized.v1`; mappings bound precision |
| evidence handles | `evidence.ts` | pinned revision, anchor, digest, length, residency, terminal state |
| retrieval | `retrieval.ts` | lanes/products/traces; locator is not evidence |
| navigation | `navigation.ts` | SourceCard/DocumentMap/Atlas are derived navigation |
| controlled research | `research.ts` | protocol, lane, freeze, audit, debts, exact nine dispositions |
| publication | `publication.ts` | statement labels, copy-on-write sections, Wiki revisions |
| model generations | `model.ts` | routes/models/prompts/schemas are immutable generations |
| policies/security | `policy.ts`, `security.ts` | independent axes, taint/effect ceiling, strict manifests |
| mutation lifecycle | `operations.ts` | Intent → Attempt → Receipt → Readback → Reconciliation |
| federation | `federation.ts` | generic candidate-only boundary; transport state is separate |
| Drive exchange | `drive-exchange.ts` | fixed schema, append-only IDs/hashes, candidate-only |
| privacy erasure | `erasure.ts` | exact closure; subset never returns complete |
| backup/restore | `backup.ts` | purge ledger restored before payload exposure |

## Schema change protocol

1. Determine whether the field is wire-visible and load-bearing.
2. Change the contract owner, not a leaf adapter.
3. Update strict schema, generated JSON schema, canonical fixture, compatibility mapping, and negative
   unknown-field fixture.
4. Create a new protocol or generation when old readers cannot interpret the change safely.
5. Run T0/T1; model/retrieval/parser-visible changes also run T2/T3 and relevant T4/T5.
