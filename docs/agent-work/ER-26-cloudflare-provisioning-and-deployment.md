# ER-26: Cloudflare provisioning and deployment

**Slice:** 0
**Depends on:** ER-00, ER-13, ER-16, ER-24
**Live gate:** Cloudflare resource create/readback and authenticated HTTP/WebSocket smoke when credentials are supplied; otherwise `NOT_EXECUTED`

## Objective

Turn the account-neutral repository configuration into one reproducible Cloudflare deployment without
allowing account identifiers, secrets, mutable vendor state, or an unverified success claim to enter
the source tree. This packet owns provisioning and release mechanics only; it does not own research,
retrieval, authentication semantics, or database schemas.

## Owned paths

- `scripts/provision-cloudflare-core.mjs`
- `scripts/provision-cloudflare-access.mjs`
- `scripts/provision-ai-search.mjs`
- `scripts/lib/cloudflare-d1-http.mjs`
- `scripts/manage-ai-search-generation.mjs`
- `scripts/run-provisioner-tests.mjs`
- `scripts/test-ai-search-generation-operator.mjs`
- `scripts/test-ai-search-provisioning-readback.mjs`
- `scripts/provision-ai-gateways.mjs`
- `scripts/deploy-cloudflare.mjs`
- `scripts/test-cloudflare-provisioners.mjs`
- `infra/cloudflare/resources.json`
- `infra/cloudflare/access.json`
- `infra/cloudflare/foundation-receipt.schema.json`
- `infra/cloudflare/access-receipt.schema.json`
- `infra/cloudflare/deployment-receipt.schema.json`
- `infra/cloudflare/README.md`
- `docs/implementation/cloudflare-runbook.md`
- `docs/adr/0005-hostname-access-for-websocket.md`

## Read only

- `apps/eliotr-core/wrangler.jsonc`
- `apps/eliotr-core/src/index.ts`
- `packages/platform-cloudflare/src/access.ts`
- `infra/d1/core/migrations/`
- `infra/d1/search/migrations/`

## Architecture extracts

- §1.3, §1.4, §1.7
- §12.1, §13.2, §15
- §17.3, §18 Slice 0
- §19.7, §19.12

## Required implementation

1. Load the versioned desired-state manifests and validate them before contacting Cloudflare.
2. Perform a **cross-product read-only preflight** for D1, R2, Queue/DLQ, AI Search, AI Gateways and
   hostname-based Access. Do not create one product while another already has incompatible state.
3. Create only absent compatible resources. Exact-name duplicates, immutable-profile drift, unexpected
   Access policies, missing stable resource IDs, or ambiguous API responses fail closed.
4. Generate `apps/eliotr-core/wrangler.deploy.jsonc` locally from canonical `wrangler.jsonc`, the
   read-back resource IDs, and validated Access JWT inputs (`team_domain`, application `aud`, and the
   service-principal allow-list). The generated file is ignored and must never become source authority.
5. Use **hostname-based Cloudflare Access** for the deployment hostname. Do not enable Worker-level
   Access because `ResearchSession` requires WebSocket upgrades.
6. Before deployment run repository checks, PWA build, generated binding types, and a minified Wrangler
   dry run. Apply additive Core/Search D1 migrations, then deploy the Worker exactly once.
7. Read the deployed Worker through the Cloudflare API and verify the expected export/binding surface.
   Execute authenticated HTTP and WebSocket smoke only when explicit smoke credentials are supplied.
8. Write non-secret receipts under ignored `.eliotr-state/`; every unexecuted live gate remains
   `NOT_EXECUTED`.

## Acceptance

- Any incompatible existing D1 jurisdiction, R2 jurisdiction/storage class, Queue identity, AI Search
  immutable profile, AI Gateway profile, or Access application/policy fails before the first mutation.
- `--check-only` performs zero mutating HTTP methods against mocked Cloudflare APIs.
- Invalid Access issuer origins, AUD tags, duplicate/oversized service principals, or missing required
  live values fail before the first Cloudflare read or mutation.
- Canonical `wrangler.jsonc` remains account-neutral; generated `wrangler.deploy.jsonc` contains the
  exact provisioned D1 IDs and validated Access team-domain/AUD/principal values and is ignored.
- A second foundation provisioning run is idempotent and creates no duplicate resources.
- Worker-level Access is absent; hostname Access protects the exact hostname with an explicit owner
  policy and rejects undeclared extra policies.
- Deployment does not claim Google Drive, ingestion, retrieval-quality, erasure, or workload live gates
  that were not executed.
- Rollback preserves the previous Worker deployment and AI Search generation until their declared
  rollback horizons expire.

## Mandatory negative boundary

Seed mocked Cloudflare APIs with both an incompatible immutable AI Search profile and an unexpected
Access policy. Run check-only and apply paths and prove that each exits nonzero **before any**
POST/PUT/PATCH/DELETE request.

## Handoff contract

Produce:

- versioned Cloudflare desired-state manifests;
- foundation, AI Search, AI Gateway, and Access provisioners;
- deployment orchestrator and generated deploy-config contract;
- mock Cloudflare API conformance suite;
- resource, Access, and deployment receipts plus rollback runbook.

The PR must state desired-state generation impact, migration/backfill impact, exact commands, mocked
negative-case result, real receipts (or `NOT_EXECUTED`), and any follow-up packet. Do not mark this
packet complete with placeholders, committed account IDs, TODO authority paths, mocked live gates, or a
stronger disposition than observed.
