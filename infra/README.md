# infra

Declarative resource definitions and migrations. No secrets, no account identifiers, no tokens.

| Directory | Contents |
|---|---|
| `d1/` | Schema migrations and named query registry for the metadata database. Core schema is not disposable; the search projection is rebuildable. |
| `r2/` | Object storage layout: evidence and work buckets, storage and erasure domain prefixes, retention rules. |
| `ai-search/` | Managed retrieval instance profiles: tokenizer, fusion, metadata budget, capacity plan and embedding generation records. |
| `workflows/` | Durable workflow stage definitions for deep research, audit, report, exhaustive scan, reindex and restore verification. |

Every mutation follows one operational contract: intent, attempt, receipt, readback, reconciliation.
A timeout is not proof of failure.
