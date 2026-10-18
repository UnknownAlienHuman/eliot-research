# Start here

The task is a compact single-owner research product, not completion of the historical 44-PR programme.
Astro is rejected. Use the existing React/Vite application and one Cloudflare Worker.

Read [current architecture](architecture/ELIOT_RESEARCH.md), [working rules](../AGENTS.md), then one
bounded result in [the implementation plan](implementation/backend-entrypoints.md). Read specialist
contracts only for that result. Old numbered ERC/S/ER requirements do not restore canceled scope.

## Current sources

| Need | Read |
|---|---|
| Product, storage, source/citation and integration boundaries | [Architecture](architecture/ELIOT_RESEARCH.md) |
| What to change and delete next | [Implementation plan](implementation/backend-entrypoints.md) |
| Why old requirements were retired | [ADR-0019](adr/0019-compact-refactoring.md) |
| TS/Rust/SQL integration | [Language boundary](architecture/LANGUAGE_RUNTIME_CONTRACT.md) |
| Ordinary answer and context integration | [Answer contract](implementation/research-full-answer-v1.md) |
| Existing/deleted executor boundaries | [Workflow notes](implementation/workflow-checkpoints.md) |
| Rendered UI work | [Material playbook](agent-work/frontend-material-agent-playbook.md), [execution map](agent-work/frontend-owner-execution-map.md) |
| Recorded source findings, not another queue | [October 17 audit](../.github/audits/2026-10-17/README.md) |

Implement first; scoped compilation/lint and minimal Clippy during development. Tests/product acceptance
follow assembly. Preserve actual user data and concurrent work, not every abandoned implementation.
Publish a coherent change to the existing PR/branch and report only checks actually executed.
