> **Legacy (pre-replacement).** This file describes the old system, kept only as donor and data-import material.
> It is not an instruction for current work — see [AGENTS.md](../../AGENTS.md) and `docs/`.

# interfaces

Client-facing surfaces: the owner API, the private agent surface and the federation endpoint.

The agent surface stays deliberately small: catalog, orient, query, open, verify, run, artifact,
propose, trace and changes. An agent never selects a database, an index, a tokenizer or a model
provider directly.

Large payloads are never returned inline. Clients receive a manifest, a stable artifact handle, a
section or range API, hashes and a cursor.
