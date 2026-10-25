> **Legacy (pre-replacement).** This file describes the old system, kept only as donor and data-import material.
> It is not an instruction for current work — see [AGENTS.md](../../AGENTS.md) and `docs/`.

# Workflow implementation boundary

Every stage reads input manifests by handle and writes output objects before returning. Step results
contain handles/receipts only. Retry identity is `(investigation, revision, stage, input manifest digest)`.
Cancellation, policy, purge ledger, and budget are checked at each durable boundary. Parallel branch
fanout defaults to two, caps at four, and never nests.
