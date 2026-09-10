# Implementation guide

This directory is the compressed implementation view of `docs/architecture/ELIOT_RESEARCH.md` v29.1.
It exists so an implementation agent can work from a bounded packet without rereading the entire
normative document.

The guide does not weaken the master contract. When a packet and architecture conflict, stop the
packet, identify the exact conflict, and change the shared contract through ER-01/ER-00 before leaf
implementation continues.

## Documents

| Document | Purpose |
|---|---|
| `dependency-map.md` | package direction, owners, and state authority |
| `contract-index.md` | canonical schemas and the code file that owns each one |
| `runtime-contract.md` | bounded Worker, DO, Workflow, Queue, D1, R2, AI Search behavior |
| `failure-model.md` | retries, lost ACKs, tampering, stale generations, partial failure |
| `security-checklist.md` | executable disclosure, taint, erasure, and secret boundaries |
| `slice-gates.md` | vertical delivery order and real completion evidence |
| `release-checklist.md` | promotion and production release gate |
| `cloudflare-runbook.md` | provision, migrate, dry-run, deploy, verify, roll back |
| `gemini-spark-mcp.md` | Gemini MCP protocol, Google extension orchestration, and live gates |
