# Cloudflare research stage adapters

This package owns the later governed research-stage adapters for ER-09. It sits
above the existing `@eliotr/cloudflare-research` and `@eliotr/cloudflare-workflows`
boundaries and is composed directly by the Worker.

Reuse the existing checkpoint, D1/R2, evidence, and governed model-attempt
authorities. Do not add a second checkpoint authority, import this package from a
lower-level package, infer research completion, or bypass output/currentness
readback. Keep semantic stage results handle-only and bound to their committed
predecessor lineage.
