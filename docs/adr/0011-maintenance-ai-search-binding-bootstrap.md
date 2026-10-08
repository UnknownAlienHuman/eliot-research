# ADR-0011: Bounded AI Search binding bootstrap during maintenance

- Status: accepted for the owner-directed S1 functional checkpoint.
- Date: 2026-10-03.
- Scope: one existing Worker gaining its already provisioned private AI Search namespace binding.

## Context

The active Worker has no `AI_SEARCH` binding. The canonical configuration names
the private `eliotr` namespace, so preserving the absent binding prevents the
managed retrieval adapter from being composed. Namespace and instance creation
are separate provisioning effects; their existence alone does not establish
indexed content, retrieval readiness or evidence admission.

ADR-0009 maintenance normally preserves the active capability profile and
resource-binding presence. This amendment permits only the explicit missing
AI Search binding transition needed by S1. It does not enable retrieval or erasure
slices and does not qualify a full release.

## Decision

1. The operator supplies a versioned intent for an absent `AI_SEARCH` binding
   to the exact private `eliotr` namespace. The intent pins the account, active
   Worker deployment/version/generation and full configuration digest, candidate
   source head/generation and generated configuration digest, and exact AI Search
   manifest bytes. No other binding transition is covered.
2. Baseline verification requires the binding to be absent. Candidate verification
   requires exactly one `AI_SEARCH` binding to the pinned namespace. All other
   resource, identity, authorization, configuration and safety checks remain in
   force. `RETRIEVAL` and `ERASURE` remain disabled.
3. Normal AI Search provisioning checks run before upload: `--check-only` and
   GET-only `--verify-existing`. Missing or drifted resources stop deployment.
   This operation neither creates resources nor uploads items, starts indexing,
   executes retrieval queries or invokes a model.
4. The operation rereads its pinned local inputs and the full active baseline
   immediately before upload. Strict candidate binding and capability readback
   precede deployment-authority synchronization and are repeated afterward.
   A failed or uncertain effect retains the existing recovery semantics.
5. A separately validated exact owner-route update intent may accompany this
   binding intent. Neither intent authorizes the other's changes. Preserving an
   absent AI Search binding is incompatible with the bootstrap intent.

## Acceptance boundary

The binding transition is an infrastructure prerequisite. S1 acceptance still
requires actual indexed-item and generation readback, a managed locator result,
and resolution into an exact admitted `EvidenceHandle` with current source,
scope, owner, purge, coordinate and digest checks. Local tests and a successful
Worker deployment do not replace that functional receipt.
