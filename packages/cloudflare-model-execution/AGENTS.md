# Cloudflare model execution adapter

This package owns the D1/R2 adapter for governed model execution, durable attempt
readback, stage execution, and model-spend admission/observation. It consumes
model-control configuration through `@eliotr/cloudflare-model-control`; it must
not import the higher-level `@eliotr/cloudflare-research` package.

Keep reservation/claim behavior separate from settlement/readback behavior while
preserving the existing `createModelAttemptStore` facade and SQL/effect ordering.
Unknown writes remain uncertain; never repeat a provider call or mint a new
identity to recover a lost acknowledgement.

The service is a library, not another Worker. Do not add browser authority,
environment access, provider credentials, network calls beyond existing ports,
or deployment composition here.
