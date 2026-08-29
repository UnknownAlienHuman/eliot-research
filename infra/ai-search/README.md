# AI Search generation

`instances.json` is desired state, not evidence authority. Instance identity includes tokenizer,
index method, embedding model, chunking/configuration, and generation. An immutable-field mismatch
never updates production in place: create a new generation, shadow-index, run T2/T3, verify item counts,
activate by CAS, and retain the prior generation for rollback.

Five custom metadata fields are the application ceiling. Project membership beyond that lives in the
projection text/header and D1. All hits remain locator candidates until exact EvidenceHandle resolution.
