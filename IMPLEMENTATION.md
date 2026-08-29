# Implementation entry point

This overlay converts the normative architecture into an implementation scaffold. The architecture
remains authoritative for product intent; the files below are authoritative for day-to-day agent work.

1. Claim one packet from [`docs/agent-work/`](docs/agent-work/README.md).
2. Read its owned paths, input contracts, acceptance cases, and named architecture sections only.
3. Implement behind existing ports. Do not redesign cross-package contracts inside a leaf packet.
4. Run `pnpm check:affected`; integration and live gates remain explicit rather than simulated.

Primary maps:

- [`docs/implementation/toolchain.md`](docs/implementation/toolchain.md)
- [`docs/implementation/dependency-map.md`](docs/implementation/dependency-map.md)
- [`docs/implementation/contract-index.md`](docs/implementation/contract-index.md)
- [`docs/implementation/runtime-contract.md`](docs/implementation/runtime-contract.md)
- [`docs/implementation/slice-gates.md`](docs/implementation/slice-gates.md)
- [`docs/implementation/cloudflare-runbook.md`](docs/implementation/cloudflare-runbook.md)
- [`docs/agent-work/manifest.json`](docs/agent-work/manifest.json)

The repository starts fail-closed. A type-compatible placeholder is not a completed slice. Every slice
must cross its real platform boundary and retain the resulting receipt.
