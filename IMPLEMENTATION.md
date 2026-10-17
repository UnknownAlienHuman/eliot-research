# Implementation

Start at [docs/START-HERE.md](docs/START-HERE.md). The current bounded task list is
[backend-entrypoints.md](docs/implementation/backend-entrypoints.md); product boundaries and agent procedure
are in [AGENTS.md](AGENTS.md).

[ADR-0019](docs/adr/0019-compact-refactoring.md) reconciles the refactor with the owner's
[#377 decision](https://github.com/UnknownAlienHuman/eliot-research/issues/377), the
[#380 audit](https://github.com/UnknownAlienHuman/eliot-research/issues/380) and the selected
[OWNER_SINGLE profile](docs/adr/0018-owner-single-function-first-profile.md).

Implement one observable product outcome in one manager checkout/worktree. Assign disjoint exact paths
to leaves and serialize shared files. No claim JSON, ancestry gate, ER-49 prerequisite or replacement
scheduler is required. Use existing application owners and native platform mechanisms.

The target owner UI is React/Vite. Astro is only the existing served compatibility path until the
integrated cutover. Rust pure decisions remain a capability-by-capability migration and do not block
the five owner paths. S52 custom index/generation/target/promotion machinery is canceled.

During the code phase use scoped TypeScript/ESLint or Rust compilation/Clippy; verify changed SQL with the
existing depth compiler. Tests and full product/platform acceptance follow assembly. Record unexecuted
checks as pending. Documentation changes do not promote implementation/live status.

Detailed product contracts, preserved execution evidence and final acceptance sources are linked from
START-HERE. Do not use the historical 44-PR program as a second active queue.
