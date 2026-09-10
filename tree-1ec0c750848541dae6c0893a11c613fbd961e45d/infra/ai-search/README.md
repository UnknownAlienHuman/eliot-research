# AI Search generation

`instances.json` is desired state, not evidence authority. Instance identity includes tokenizer,
index method, embedding model, chunking/configuration, and generation. An immutable-field mismatch
never updates production in place: create a new generation, shadow-index, run T2/T3, verify item counts,
activate by CAS, and retain the prior generation for rollback.

Five custom metadata fields are the application ceiling. Project membership beyond that lives in the
projection text/header and D1. All hits remain locator candidates until exact EvidenceHandle resolution.

The generation registry is one canonical bounded artifact in SEARCH_DB. Migration
`infra/d1/search/migrations/0004_ai_search_generation_registry.sql` defines the strict authority row;
`createD1AiSearchGenerationRegistryStore` performs one revision-and-digest-fenced D1 mutation and the
registry service requires exact authoritative readback. This is implemented but not live: applying the
migration, composing the Worker, mutating an AI Search instance, promoting a generation, and retaining
live golden-set receipts remain separate operations.
