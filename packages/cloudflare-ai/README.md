# @eliotr/cloudflare-ai

Bounded Cloudflare AI Search generation governance and related provider-neutral AI policy primitives. The package performs no live Cloudflare mutation.

The package contains deterministic immutable-generation governance and a narrow namespace-instance
provisioner. The provisioner can list, get, create and verify built-in instances, but intentionally owns
no update or delete capability and performs no implicit in-place reconfiguration.
