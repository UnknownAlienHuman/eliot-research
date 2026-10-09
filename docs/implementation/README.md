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
| [backend-entrypoints.md](backend-entrypoints.md) | Current backend router, dependency-ready cards, donor decisions and shared integration boundaries. |
| [backend-delivery-plan.md](backend-delivery-plan.md) | Owner-resumed checkpoint, historical October 6 evidence and separate assembled-product acceptance. |
| [backend-checkpoint-2026-10-08.md](backend-checkpoint-2026-10-08.md) | Published backend slices, scoped verification and remaining acceptance. |
| [backend-contract-conflicts.md](backend-contract-conflicts.md) | Concrete contract conflicts and missing inputs for owner review. |
| [frontend-platform-migration.md](frontend-platform-migration.md) | React/Vite executable migration route. |
| [frontend-stack-validation-2026-10-08.md](frontend-stack-validation-2026-10-08.md) | Stack, Cloudflare, primitive, binding and compatibility validation. |
| [frontend-agent-harness.md](frontend-agent-harness.md) | Component catalog, fixtures, visual evidence and UI-agent workflow. |
| [frontend-performance-acceptance.md](frontend-performance-acceptance.md) | Bundle/render/progressive/list/report/pane/lifecycle performance contract. |
| [frontend-transport-audit-2026-10-08.md](frontend-transport-audit-2026-10-08.md) | Existing browser transport audit and ER-48 test requirements. |
| [frontend-client-extraction-inventory-2026-10-08.md](frontend-client-extraction-inventory-2026-10-08.md) | File-level owner-client extraction inventory. |
| [frontend-feature-parity-inventory-2026-10-08.md](frontend-feature-parity-inventory-2026-10-08.md) | Capability destination, visibility, ownership and negative map. |
| [frontend-cutover-inventory-2026-10-08.md](frontend-cutover-inventory-2026-10-08.md) | Build, deploy, rollback, service-worker and browser cutover inventory. |
| [frontend-preflight-2026-10-09.md](frontend-preflight-2026-10-09.md) | Current-main bootstrap, routing, projection and deployment preflight. |
| [product-resume-2026-10-02.md](product-resume-2026-10-02.md) | Dated product integration checkpoint with preserved decisions and pending acceptance. |
| [product-resume-2026-10-03.md](product-resume-2026-10-03.md) | Owner configuration, immutable Research capture and functional integration checkpoint. |
| [audit-2026-09-25-review.md](audit-2026-09-25-review.md) | Independent review of audit PR303: reproduced SQL/lint/CI findings, corrections, issue mapping and verification limits. |
| [gap-register.md](gap-register.md) | Prioritized list of what is genuinely missing, with the closure evidence each gap requires. |
| [2026-09-10 saved work](checkpoints/2026-09-10/README.md) | Inactive snapshots of unfinished local work, push verification and cleanup inventory. |
| [2026-09-10 cleanup receipt](checkpoints/2026-09-10/cleanup-receipt.json) | Exact removed build paths, recovered Git objects, preserved state, and cleanup exclusions. |
| [production-readiness-plan.md](production-readiness-plan.md) | The only accepted definition of production-ready, and the ordered path to it. |
| [slice-gates.md](slice-gates.md) | Vertical delivery order and the real completion evidence each slice owes. |
| [release-checklist.md](release-checklist.md) | Promotion and production release gate. |
| [canonical-alignment.md](canonical-alignment.md) | Recorded divergences between implementation and the canonical contracts. |

### Contracts and structure

| Document | Purpose |
|---|---|
| [dependency-map.md](dependency-map.md) | Package direction, owners and state authority. |
| [contract-index.md](contract-index.md) | Canonical schemas and the code file that owns each one. |
| [read-extract-proposal-cutover.md](read-extract-proposal-cutover.md) | READ proposal cardinality and stage-admission conflict before activation. |
| [branch-query-budget-selection.md](branch-query-budget-selection.md) | Missing immutable branch-query budget selection and denial without explicit limits. |
| [workflow-conversion-admission-cutover.md](workflow-conversion-admission-cutover.md) | Required selected conversion inputs, current authority and explicit scope cutover. |
| [managed-generation-promotion-fence.md](managed-generation-promotion-fence.md) | Shadow key cutover, complete required-set evidence and existing pointer authority. |
| [research-session-projection-protocol.md](research-session-projection-protocol.md) | Strict read-only Agent RPC snapshot contract and pending lifecycle qualification. |
| [rust-kernel-abi-versioning.md](rust-kernel-abi-versioning.md) | Versioned Rust/Wasm ABI and the consumer-newer compatibility guard. |
| [runtime-contract.md](runtime-contract.md) | Bounded Worker, DO, Workflow, Queue, D1, R2 and AI Search behaviour. |
| [failure-model.md](failure-model.md) | Retries, lost ACKs, tampering, stale generations, partial failure. |
| [security-checklist.md](security-checklist.md) | Executable disclosure, taint, erasure and secret boundaries. |

### Process — read before you edit anything

| Document | Purpose |
|---|---|
| [branch-discipline.md](branch-discipline.md) | Main-only implementation and exact-head, integration-proven branch cleanup. |
| [scoped-verification.md](scoped-verification.md) | Focused verification commands and the distinction between scoped checks and the full chain. |
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
| [issue-319-cookie-and-log-verification.md](issue-319-cookie-and-log-verification.md) | Source findings and pending browser/event evidence for cookie and URL-log policy. |
| [http-cache-semantics-advisory.md](http-cache-semantics-advisory.md) | Current dependency advisory, absent patch evidence and permitted mitigation boundary. |
| [cloudflare-usage-envelope.md](cloudflare-usage-envelope.md) | Usage envelope (80% guard), preflight admission receipt, SEALED/BLOCKED discipline. |
| [local-launch.md](local-launch.md) | The owner loop that runs locally today, and its current limits. |
| [owner-workspace-setup.md](owner-workspace-setup.md) | Operator-provisioned namespace bootstrap and first owner workspace setup. |
| [research-runtime-configuration.md](research-runtime-configuration.md) | Server-owned Research configuration envelope, provenance and local/deployment input validation. |
| [live-document-project-acceptance-2026-09-14.md](live-document-project-acceptance-2026-09-14.md) | Deployed owner login, PDF/DOCX intake, project save, research draft, claim audit and citation readbacks. |
| [audit-2026-09-14.md](audit-2026-09-14.md) | Consolidated deep audit: coordinator pass, Antigravity Opus 4.6 swarm pass and independent re-verification — authority model, D1 triggers and test-harness depth limits, AI Gateway and canon, UI against NotebookLM, refuted claims. |
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
| [muse-operator-runbook.md](muse-operator-runbook.md) | Computer-agent operation — capabilities, transport and operating procedure per ADR-0007. |
| [computer-agent-web-inbox.md](computer-agent-web-inbox.md) | Browser transport for the computer-agent web inbox; common task semantics live in the operator runbook. |
