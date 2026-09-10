# platform-cloudflare

Thin adapters over managed platform primitives: metadata database, object storage, queues, durable
coordination, workflows, managed retrieval, model gateways, access and analytics.

- **Owns:** binding access, retry and idempotency mechanics, size and streaming limits.
- **Must not own:** research semantics, evidence meaning, disclosure decisions.

The platform is used where it is already better than a self-built stack. Anything the platform does
not provide as a managed product is written here as first-party code, not approximated with a second
database.
