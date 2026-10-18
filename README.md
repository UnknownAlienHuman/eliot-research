# ELIOT Research

A single-owner cloud research application: source Library, search/Lens, cited answers and reports,
Wiki/Inbox, and connected-agent tasks. One Cloudflare Worker, D1/R2, native search and the existing React/Vite UI.

**Implementation is in progress.** The compact architecture is the selected target, not proof of completed
runtime refactoring or production readiness. Astro is rejected; the served legacy assets still need the
integrated React cutover. This documentation change switches no deployment or data.

Start with [current architecture](docs/architecture/ELIOT_RESEARCH.md),
[implementation/removal plan](docs/implementation/backend-entrypoints.md) and [AGENTS.md](AGENTS.md).
[ADR-0019](docs/adr/0019-compact-refactoring.md) explains which old requirements are retired.

## Product paths

Project/sources → question → saved report with exact citations → reopen; project upload to managed search;
draft review/publication through Inbox; agent connection; task assignment/result. Library, Lens, Wiki,
ordinary file/report downloads and explicitly requested deep research remain.

## Development direction

One current implementation per behavior. Change internal APIs with callers and remove obsolete code,
wrappers, decoders, fixtures and docs. Actual user data/results need preservation or conversion;
historical executors and hypothetical clients do not. Git history is the archive.

Use platform authentication, secrets, R2/D1 operations and Workflows rather than bespoke crypto/proof,
index-generation, distributed-ownership, backup or agent-framework layers. One owner client and UI;
no permanent parallel Astro product. TS/Rust/SQL responsibilities are described in the
[language boundary](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), without an all-family Rust port programme.

One manager checkout, bounded disjoint assignments. Implement first with scoped compile/lint and minimal
Clippy for changed Rust. Tests and product acceptance follow assembly; existing automatic CI runs under
its configured triggers. No unrun check is PASS and no source-size number is proof of runtime performance.

[Source audit and earlier inventory](.github/audits/2026-10-17/README.md) are dated evidence, not a new queue.
[Owner decision #377](https://github.com/UnknownAlienHuman/eliot-research/issues/377) archives the former 44-PR
programme; [#380](https://github.com/UnknownAlienHuman/eliot-research/issues/380) tracks the refactoring audit.

MIT. See [LICENSE](LICENSE).
