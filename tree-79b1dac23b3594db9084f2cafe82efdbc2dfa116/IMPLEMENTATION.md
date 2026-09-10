# Implementation entry point

The repository is under active implementation and is not production-ready. The architecture remains
authoritative for product intent; the language/runtime contract owns responsibility boundaries; the
readiness plan owns the ordered path to a production declaration; and the files below are authoritative
for day-to-day agent work.

1. Read [`docs/implementation/production-readiness-plan.md`](docs/implementation/production-readiness-plan.md)
   and identify the earliest incomplete phase that owns the requested result.
2. Inspect [`docs/implementation/implementation-status.json`](docs/implementation/implementation-status.json)
   and [`docs/implementation/gap-register.md`](docs/implementation/gap-register.md).
3. Claim one packet from [`docs/agent-work/`](docs/agent-work/README.md).
4. Read its owned paths, input contracts, acceptance cases, and named architecture sections only.
5. Read the language owner for the capability in
   [`LANGUAGE_RUNTIME_CONTRACT.md`](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
6. Implement behind existing ports. Do not redesign cross-package contracts inside a leaf packet.
7. Follow [`branch-discipline.md`](docs/implementation/branch-discipline.md): one task/branch/worktree,
   maximum five non-default branches, and 24-hour TTL without an open PR.
8. Run `pnpm check:affected`; Rust packets also run the Cargo gates required by the language/runtime
   contract.
9. Record deterministic, live, recovery and workload evidence separately. No omitted live gate becomes
   `PASS` by implication.

Primary maps:

- [`docs/implementation/production-readiness-plan.md`](docs/implementation/production-readiness-plan.md)
- [`docs/architecture/ELIOT_RESEARCH.md`](docs/architecture/ELIOT_RESEARCH.md)
- [`docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md)
- [`docs/implementation/branch-discipline.md`](docs/implementation/branch-discipline.md)
- [`docs/implementation/toolchain.md`](docs/implementation/toolchain.md)
- [`docs/implementation/dependency-map.md`](docs/implementation/dependency-map.md)
- [`docs/implementation/contract-index.md`](docs/implementation/contract-index.md)
- [`docs/implementation/runtime-contract.md`](docs/implementation/runtime-contract.md)
- [`docs/implementation/slice-gates.md`](docs/implementation/slice-gates.md)
- [`docs/implementation/cloudflare-runbook.md`](docs/implementation/cloudflare-runbook.md)
- [`docs/implementation/release-checklist.md`](docs/implementation/release-checklist.md)
- [`docs/implementation/security-checklist.md`](docs/implementation/security-checklist.md)
- [`docs/agent-work/manifest.json`](docs/agent-work/manifest.json)

The system starts and remains fail-closed. A type-compatible placeholder is not an implemented feature;
a local fixture is not a live platform receipt; Workflow or transport completion is not research
completion. A production declaration requires every mandatory condition in the readiness plan.
