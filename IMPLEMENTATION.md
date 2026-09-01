# Implementation entry point

This overlay converts the normative architecture into an implementation scaffold. The architecture
remains authoritative for product intent; the files below are authoritative for day-to-day agent work.

1. Claim one packet from [`docs/agent-work/`](docs/agent-work/README.md).
2. Read its owned paths, input contracts, acceptance cases, and named architecture sections only.
3. Read the language owner for the capability in
   [`LANGUAGE_RUNTIME_CONTRACT.md`](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md).
4. Implement behind existing ports. Do not redesign cross-package contracts inside a leaf packet.
5. Follow [`branch-discipline.md`](docs/implementation/branch-discipline.md): one task/branch/worktree,
   maximum five non-default branches, and 24-hour TTL without an open PR.
6. Run `pnpm check:affected`; after the Cargo workspace lands, run the Rust gates required by the
   language/runtime contract. Integration and live gates remain explicit rather than simulated.

Primary maps:

- [`docs/architecture/ELIOT_RESEARCH.md`](docs/architecture/ELIOT_RESEARCH.md)
- [`docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md)
- [`docs/implementation/branch-discipline.md`](docs/implementation/branch-discipline.md)
- [`docs/implementation/toolchain.md`](docs/implementation/toolchain.md)
- [`docs/implementation/dependency-map.md`](docs/implementation/dependency-map.md)
- [`docs/implementation/contract-index.md`](docs/implementation/contract-index.md)
- [`docs/implementation/runtime-contract.md`](docs/implementation/runtime-contract.md)
- [`docs/implementation/slice-gates.md`](docs/implementation/slice-gates.md)
- [`docs/implementation/cloudflare-runbook.md`](docs/implementation/cloudflare-runbook.md)
- [`docs/agent-work/manifest.json`](docs/agent-work/manifest.json)

The repository starts fail-closed. A type-compatible placeholder is not a completed slice. Every slice
must cross its real platform boundary and retain the resulting receipt.
