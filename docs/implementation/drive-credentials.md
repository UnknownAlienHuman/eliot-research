# Historical Drive Exchange credential checkpoint

This document described credential encryption/refresh for the unselected Drive Exchange connector. It is not current
product or security authority. Current boundaries live in the [implementation plan](backend-entrypoints.md),
[security checklist](security-checklist.md) and [release/schema transitions](production-readiness-plan.md).

Do not complete browser OAuth, provisioning, generation/cursor machinery or another credential platform merely
because dormant code and migrations exist. Before removing the predecessor, inventory whether any deployed
configuration or retained credential rows actually exist; preserve or deliberately revoke real secrets/data through
an explicit authorized transition. Unapplied/test-only rows need no compatibility layer.

If a future selected integration needs Google credentials, reuse only the smallest verified operation after current
API/security review. Do not restore v29.1/ER ownership, plaintext-token shortcuts, global token caching or the full
Drive Exchange programme.

The original checkpoint remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/5dec2fae1a86b2a7cf7bb00703b6976665aab847/docs/implementation/drive-credentials.md).
