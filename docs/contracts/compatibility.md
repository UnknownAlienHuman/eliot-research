> **Legacy (pre-replacement).** This file describes the old system, kept only as donor and data-import material.
> It is not an instruction for current work — see [AGENTS.md](../../AGENTS.md) and `docs/`.

# Legacy contract compatibility record

This path documents the predecessor contract registry. Its complete reviewed policy remains preserved at
[`main@7c034569/docs/contracts/compatibility.md`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/contracts/compatibility.md),
alongside the exact generated schemas, fixtures and compatibility history that still exist in this directory.

It does **not** govern the replacement application. Current product and implementation decisions live in
[Architecture](../ARCHITECTURE.md), [Implementation](../IMPLEMENTATION.md), [MAP](../MAP.md) and
[Donors](../DONORS.md). Historical registry generations, M2/T-level gates, qualification packets and the requirement to
append an entry for every schema-byte change are predecessor rules, not the target development process.

Until [MAP stage 0](../MAP.md#delivery-order) removes the final old workspace/CI consumers:

- preserve the committed generated artifacts for decoding, migration and differential checks;
- do not add replacement schemas or roadmap state to the legacy registry;
- when an unavoidable pre-cutover predecessor wire fix is made, follow the pinned historical policy and update the old
  package, registry and fixtures consistently;
- do not treat a passing legacy contract check as evidence that the replacement compiles or works.

After the last consumer is traced and retired, remove this fixture set coherently rather than carrying the registry into
the new root application.
