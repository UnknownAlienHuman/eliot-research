# Documentation

Read [Architecture](ARCHITECTURE.md) for the product, [Implementation](IMPLEMENTATION.md) for the design,
[MAP](MAP.md) for build order and [DONORS](DONORS.md) for selected reusable solutions.
[Working rules](../AGENTS.md) govern development; [audits](../.github/audits/README.md) preserve evidence.
[Review status](../.github/audits/REVIEW-REGISTER.md) records the handoff and remaining checks;
[MAP stage 0](MAP.md#delivery-order) is the next implementation step.

`implementation/implementation-status.json` is a legacy build/check fixture, not runtime data or the replacement backlog.
Retire it with its final checker/script/CI consumers at the root-tooling transition. `contracts/` contains legacy schema
exports and compatibility fixtures; trace their separate build/protocol consumers before retirement. Neither defines the
replacement architecture. Keep needed legacy source available through migration; do not replace either with a new status system.
