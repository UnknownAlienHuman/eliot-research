# Historical managed-generation promotion programme

This document accumulated shadow-generation, target-wide required-set, writer-hold, cross-D1 recovery and promotion
acceptance work under the former AI Search architecture. The selected product does not need an application-owned
index-generation/promotion platform.

Use the [implementation plan](backend-entrypoints.md), [source lifecycle](source-lifecycle.md) and
[native Cloudflare path](cloudflare-native-path.md). Keep canonical source/revision/membership/deletion in D1,
canonical bytes in R2 and one native search ingestion/query path. A provider item remains a derived locator; native
status plus exact application readback is enough. Do not finish or port `ai_search_generation_registry`, shadow
promotion, target-required-set manifests, writer leases or T2/T3 receipts solely because this programme exists.

Before deletion, trace real deployed registry/target rows and active writer effects. Preserve/reconcile acknowledged
provider work and active runs; unapplied/test-only generations need no compatibility reader. Remove registry,
promotion/fence reads, duplicate lanes/copies, migrations and exclusive fixtures with their last caller.

The original programme remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/79a38b379eb7410413a2f9f615a9e681228cafd9/docs/implementation/managed-generation-promotion-fence.md).
