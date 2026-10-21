# Historical managed-registry transaction qualification — 2026-10-11

This file qualified local compare-and-swap behavior for the application-managed AI Search generation registry. The
current architecture selects native managed search as a disposable projection and removes the generation/promotion
registry after caller migration. Therefore this is regression history for a predecessor, not a requirement to finish
S91/S52 or preserve the registry.

Current search decisions live in the [implementation plan](backend-entrypoints.md),
[source lifecycle](source-lifecycle.md) and [native Cloudflare path](cloudflare-native-path.md). Preserve real
revision-to-provider mapping, observable item status, exact D1/R2 readback and acknowledged effects while replacing
the old registry; do not recreate its CAS/qualification platform elsewhere.

The original seven-case checkpoint remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/79a38b379eb7410413a2f9f615a9e681228cafd9/docs/implementation/s91-managed-registry-transaction-qualification-2026-10-11.md).
