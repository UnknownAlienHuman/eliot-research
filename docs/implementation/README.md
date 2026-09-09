# Implementation guide

New to the repository? Read [`docs/START-HERE.md`](../START-HERE.md) first.

This directory is the compressed implementation view of `docs/architecture/ELIOT_RESEARCH.md` v29.1.
It exists so an implementation agent can work from a bounded packet without rereading the entire
normative document.

The guide does not weaken the master contract. When a packet and architecture conflict, stop the
packet, identify the exact conflict, and change the shared contract through ER-01/ER-00 before leaf
implementation continues.

## Documents

Complete index. `node scripts/check-docs-index.mjs` fails if a document in this directory is missing
from the tables below, so an unlisted file is a bug, not an omission you may ignore.

### Where the project actually stands

| Document | Purpose |
|---|---|
| [implementation-status.md](implementation-status.md) | What the four states mean and why a compiling port is not an implemented feature. |
| [implementation-status.json](implementation-status.json) | The machine-readable registry. `pnpm check:implementation-status` validates it. |
| [gap-register.md](gap-register.md) | Prioritized list of what is genuinely missing, with the closure evidence each gap requires. |
| [production-readiness-plan.md](production-readiness-plan.md) | The only accepted definition of production-ready, and the ordered path to it. |
| [slice-gates.md](slice-gates.md) | Vertical delivery order and the real completion evidence each slice owes. |
| [release-checklist.md](release-checklist.md) | Promotion and production release gate. |
| [canonical-alignment.md](canonical-alignment.md) | Recorded divergences between implementation and the canonical contracts. |

### Contracts and structure

| Document | Purpose |
|---|---|
| [dependency-map.md](dependency-map.md) | Package direction, owners and state authority. |
| [contract-index.md](contract-index.md) | Canonical schemas and the code file that owns each one. |
| [runtime-contract.md](runtime-contract.md) | Bounded Worker, DO, Workflow, Queue, D1, R2 and AI Search behaviour. |
| [failure-model.md](failure-model.md) | Retries, lost ACKs, tampering, stale generations, partial failure. |
| [security-checklist.md](security-checklist.md) | Executable disclosure, taint, erasure and secret boundaries. |

### Process — read before you edit anything

| Document | Purpose |
|---|---|
| [branch-discipline.md](branch-discipline.md) | Branch and worktree lifecycle, the five-branch ceiling, the 24-hour TTL, naming. |
| [toolchain.md](toolchain.md) | Pinned bootstrap tools. Leaf agents must not upgrade these; toolchain changes are ER-00. |
| [launch-prs/README.md](launch-prs/README.md) | Theme map and the checkpoint dependency graph. |
| [launch-prs/agent-start.md](launch-prs/agent-start.md) | How to select a checkpoint and the claim block to post before editing. |
| [launch-prs/execution-contract.md](launch-prs/execution-contract.md) | Mandatory reading, claim procedure, implementation order, required tests and commands. |
| [launch-prs/cloudflare-handoff.md](launch-prs/cloudflare-handoff.md) | Execution contract for account work; currently blocked by unfinished application code. |
| [launch-prs/01-library.md](launch-prs/01-library.md) | Launch 01 plan — source ingest and owner Library. |
| [launch-prs/09-rust.md](launch-prs/09-rust.md) | Launch 09 plan — Rust family parity, Wasm promotion, TS-authority removal. |

### Operating the platform

| Document | Purpose |
|---|---|
| [cloudflare-runbook.md](cloudflare-runbook.md) | Provision, migrate, dry-run, deploy, verify, roll back. |
| [cloudflare-usage-envelope.md](cloudflare-usage-envelope.md) | Usage envelope (80% guard), preflight admission receipt, SEALED/BLOCKED discipline. |
| [local-launch.md](local-launch.md) | The owner loop that runs locally today, and its current limits. |
| [audit-2026-09-09.md](audit-2026-09-09.md) | Dated merged-work and Cloudflare OAuth readback audit, with the remaining launch blockers. |
| [audit-2026-09-08.md](audit-2026-09-08.md) | Dated whole-repository audit against the documentation: what is consistent, what drifted, what is left. |
| [deployment-audit-2026-09-04.md](deployment-audit-2026-09-04.md) | Dated readiness audit for a local-to-Cloudflare product trial. |

### Subsystem notes

| Document | Purpose |
|---|---|
| [workflow-checkpoints.md](workflow-checkpoints.md) | W2a durable research stage checkpoints; the public `ResearchWorkflow` stays fail-closed. |
| [drive-rest.md](drive-rest.md) | Bounded Drive Sheet/changes REST subset — not the complete connector. |
| [drive-credentials.md](drive-credentials.md) | Encrypted credential storage, refresh and rotation. |
| [drive-oauth-admission.md](drive-oauth-admission.md) | Initial Google OAuth admission. |
| [gemini-spark-mcp.md](gemini-spark-mcp.md) | Spark/Antigravity MCP protocol, client orchestration and live gates. |
