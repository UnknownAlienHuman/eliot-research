# @eliotr/cloudflare-ai

Bounded Cloudflare AI Search generation governance and related provider-neutral AI policy primitives. The package performs no live Cloudflare mutation.

The package contains deterministic immutable-generation governance and a narrow namespace-instance
provisioner. The provisioner can list, get, create and verify built-in instances, but intentionally owns
no update or delete capability and performs no implicit in-place reconfiguration.

## Provisioning qualification

The strict provisioning boundary is fixture-qualified against the repository's pinned Cloudflare runtime
types and provider create limits. Targeted run `33714787976` passed contract, boundary, source-budget,
work-packet, lint, typecheck, 28 package tests, 108 related platform/projection tests and Worker dry-run
checks on the materialized source. No live namespace, instance, item or provider operation was executed.
