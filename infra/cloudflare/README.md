# Cloudflare desired state

This directory is the versioned, account-neutral desired state for the Cloudflare contour. It contains
names, immutable profiles and safety invariants, but never account IDs, resource UUIDs, secrets, Access
cookies, provider keys or live receipts.

## Manifests

- `resources.json` — one Worker name, two D1 databases, two R2 buckets, the primary Queue and DLQ.
- `access.json` — the hostname-based Access application and owner-policy shape.
- `ai-gateways.json` — the retrieval and reasoning gateway profiles.
- `../ai-search/instances.json` — the namespace and generation-pinned managed retrieval instances.

All provisioners implement **create or verify**, not create or silently update. Existing immutable profile
drift is an error. Each script supports `--check-only`; the deployment orchestrator runs every remote
check before the first remote create.

## Local generated state

`provision-cloudflare-core.mjs` resolves account-specific D1 UUIDs and writes:

- `apps/eliotr-core/wrangler.deploy.jsonc`
- `.eliotr-state/cloudflare-foundation-receipt.json`

Access and deployment scripts add receipts under `.eliotr-state/`. All of these paths are ignored by Git.
The canonical `apps/eliotr-core/wrangler.jsonc` remains account-neutral and is never rewritten by a
provisioner.

## Access boundary

Use hostname-based Access. Do not enable Worker-level Access while `ResearchSession` uses WebSockets;
the current Worker-level Access mode rejects WebSocket upgrades. Because hostname Access protects only
one exact URL, release configuration must choose exactly one public contour: Custom Domain only
(`workers_dev=false`) or the exact `eliotr-core.<account-subdomain>.workers.dev` hostname only. One
owner-email policy is mandatory. Additional service policies are accepted only when their exact IDs are
declared through `ELIOTR_ALLOWED_ADDITIONAL_ACCESS_POLICY_IDS`.

## Mutation order

1. Local compile/test/budget/dry-run gates.
2. Remote `--check-only` for foundation, AI Search, AI Gateways and Access.
3. Create or verify named resources and generate the local deploy config.
4. Apply additive Core/Search D1 migrations by exact binding and database ID.
5. Deploy the Worker once.
6. Read back the Worker export and record explicit live-gate states.

A successful deployment is not research conformance. D1/R2/Queue/DO/Workflow/AI Search/Drive live gates
remain `NOT_EXECUTED` until the dedicated integration harness records real receipts.

## MCP Access operator inputs

The selected transport must be passed explicitly to the Access provisioner and must match the canonical
Core config: `ELIOTR_GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp`. An omitted transport cannot issue an
owner-only receipt when the canonical profile selects Gemini MCP. `drive-exchange` retains the legacy
owner contour and does not create the MCP application.

Gemini MCP uses the existing Access hostname with the exact `/mcp` path; `ELIOTR_MCP_HOSTNAME`, when
provided, must equal `ELIOTR_ACCESS_HOSTNAME`. For `service-token`, provide
`ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID` (the Access policy selector UUID) and
`ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID` (the signed verifier Client ID ending in `.access`). These
are different identifiers; the provisioner confirms their pairing by reading the exact service-token
record. For `managed-oauth`, set `ELIOTR_MCP_ACCESS_AUTH_PROFILE=managed-oauth`; service-token inputs
are rejected and the dedicated app must read back `oauth_configuration.enabled=true` with
`path_cookie_attribute=true`.

MCP application and policy compatibility is checked before the owner application is created. Cloudflare
generates the dedicated AUD during application creation; the receipt accepts it only from a fresh
application readback and verifies that it differs from the ordinary AUD. Receipts contain IDs, digests,
profile and contour fields, but never Client ID values, tokens, cookies or other secrets.
