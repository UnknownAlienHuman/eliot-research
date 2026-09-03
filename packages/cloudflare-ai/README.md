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
Targeted correction run `33721742215` additionally proved that a malformed persisted route fingerprint
is classified as `MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED`, not as caller request failure, while all
boundary, budget, lint, typecheck and Cloudflare AI/platform tests remained green.

The adapter itself never retries an ambiguous transport outcome. Durable call-level idempotency and
reconciliation across Workflow retries belong to the research-workflow execution packet. Live model,
provider, billing, Guardrail, DLP, fallback, and spend-limit receipts remain `NOT EXECUTED`.

## Versioned Dynamic Route provisioning

Dynamic Route generations are create-only. A deterministic provider name is bound to the decoded
`ModelRouteDeployment` identity, while the complete route definition and deployment metadata are
independently SHA-256 bound. The provisioner exposes only `list`, `get`, and `create`; it owns no provider
update or delete operation.

A failed create is never replayed blindly. The adapter performs one exact list/get reconciliation and
returns `CREATE_RECONCILED` only when the immutable provider snapshot matches. Otherwise it reports
`DYNAMIC_ROUTE_CREATE_UNCERTAIN` with `PROVIDER_CREATE` as the unresolved effect.

Promotion is a separate authority transition. The provider snapshot is staged as an immutable candidate,
then activated through expected-active-version CAS. Production promotion requires fresh `LIVE`
qualification bound to the exact gateway, deployment generations, provider identity, definition digest,
snapshot digest, control-plane readback, and execution probe. Fixture evidence can promote only in the
`TEST` environment.
