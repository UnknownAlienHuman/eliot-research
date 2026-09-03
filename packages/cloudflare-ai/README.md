# @eliotr/cloudflare-ai

Bounded Cloudflare AI Search generation governance and strict AI Gateway execution adapters. Live provider authority is supplied only through injected ports.

The package contains deterministic immutable-generation governance and a narrow namespace-instance
provisioner. The provisioner can list, get, create and verify built-in instances, but intentionally owns
no update or delete capability and performs no implicit in-place reconfiguration.

## Provisioning qualification

The strict provisioning boundary is fixture-qualified against the repository's pinned Cloudflare runtime
types and provider create limits. Targeted run `33714787976` passed contract, boundary, source-budget,
work-packet, lint, typecheck, 28 package tests, 108 related platform/projection tests and Worker dry-run
checks on the materialized source. No live namespace, instance, item or provider operation was executed.

## Reasoning-gateway fetch boundary

The reasoning-gateway fetch adapter:

- resolves only registered `dynamic/eliotr-*` deployments;
- validates the call policy before invoking the trusted prompt compiler;
- calls only `eliotr-reasoning/compat/chat/completions`;
- authenticates `gateway.ai.cloudflare.com` through `cf-aig-authorization`, never through the provider
  `Authorization` header;
- binds canonical request bytes and the deployed parameter generation with SHA-256 digests;
- disables response caching and generic gateway retries for the request while retaining fallbacks inside
  the deployed Dynamic Route;
- requires exact provider/model/log metadata and reconciled token usage;
- rejects truncated, refused, cache-hit, Guardrail-blocked, or DLP-flagged/blocked output;
- persists the exact response and selected route fingerprint through immutable readback-verified ports;
- prices observed usage against the deployment's pinned pricing snapshot before emitting a compact
  `ModelCallReceipt`.

Targeted qualification run `33721052502` passed normative contracts, package boundaries and their
negative gate, source budgets, the work-packet DAG, ESLint, the complete TypeScript build, all 141
Cloudflare AI/platform tests, Worker deployment dry-run and diff hygiene on the finalized source.

The adapter itself never retries an ambiguous transport outcome. Durable call-level idempotency and
reconciliation across Workflow retries belong to the research-workflow execution packet. Live model,
provider, billing, Guardrail, DLP, fallback, and spend-limit receipts remain `NOT EXECUTED`.
