# Cloudflare erasure package

This package owns the generic contracts, authority and location composition for
`erc.privacy.erasure.v1`. `cloudflare-erasure-operations` owns execution coordination and the
physical backup D1/R2 inventory, closure and purge adapters, injected through these contracts.
The generic package must not import the Operations package. Erasure may enumerate only exact,
typed dependencies. It must quarantine before physical deletion, preserve generation fences, require
absence readback for every requested PurgeLocation, and return `BLOCKED` whenever provider, backup,
retention, hold, inventory, or readback authority is incomplete. Queue acceptance, delete acceptance,
and a subset of locations are never completion evidence.
