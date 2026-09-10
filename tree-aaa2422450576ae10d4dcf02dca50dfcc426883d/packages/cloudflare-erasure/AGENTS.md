# Cloudflare erasure package

This package is the sole executable adapter for `erc.privacy.erasure.v1`. It may enumerate only exact,
typed dependencies. It must quarantine before physical deletion, preserve generation fences, require
absence readback for every requested PurgeLocation, and return `BLOCKED` whenever provider, backup,
retention, hold, inventory, or readback authority is incomplete. Queue acceptance, delete acceptance,
and a subset of locations are never completion evidence.
