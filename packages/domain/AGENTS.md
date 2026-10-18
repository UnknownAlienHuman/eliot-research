# Domain logic

Use direct, deterministic functions for selected product behavior. No network, provider/Cloudflare bindings,
database types or hidden clock/randomness in pure decisions; pass only values the operation actually needs.
Keep illegal transitions explicit without inventing a universal state-machine or proof framework.
Move changed callers together and remove superseded variants. Rust promotion requires a real caller,
not a second implementation kept for parity. Follow root rules for scoped compilation/lint and check timing;
read [the current plan](../../docs/implementation/backend-entrypoints.md), not the obsolete packet queue.
