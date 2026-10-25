> **Legacy (pre-replacement).** This file describes the old system, kept only as donor and data-import material.
> It is not an instruction for current work — see [AGENTS.md](../../AGENTS.md) and `docs/`.

# platform-cloudflare

Thin adapters over managed platform primitives: metadata database, object storage, queues, durable
coordination, workflows, managed retrieval, model gateways, access and analytics.

- **Owns:** binding access, retry and idempotency mechanics, size and streaming limits.
- **Must not own:** research semantics, evidence meaning, disclosure decisions.

The platform is used where it is already better than a self-built stack. Anything the platform does
not provide as a managed product is written here as first-party code, not approximated with a second
database.
