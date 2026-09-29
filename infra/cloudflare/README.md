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

The MCP Access application is independent of Google transport selection. The historical
`ELIOTR_GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp` profile still selects it, but a Google-free deployment may
set the canonical transport to `disabled` and explicitly configure MCP clients. `drive-exchange` does not
select MCP by itself.

MCP uses the existing Access hostname with the exact `/mcp` path; `ELIOTR_MCP_HOSTNAME`, when provided,
must equal `ELIOTR_ACCESS_HOSTNAME`. For service-token authentication, provide either the compatible
legacy pair:

```text
ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID=<Access service-token UUID>
ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID=<signed Client ID>.access
```

or independent client bindings:

```text
ELIOTR_MCP_ACCESS_SERVICE_TOKENS=[
  {"token_id":"<UUID>","client_id":"<Client ID>.access"},
  {"token_id":"<UUID>","client_id":"<Client ID>.access"}
]
```

`ELIOTR_MCP_ACCESS_ENABLED=1` is an optional enable-only signal. Do not use `=0` as removal: revoking an
existing connection requires a separate reconciled policy/token operation. The provisioner accepts at
most 64 unique token UUIDs and Client IDs, confirms every exact pairing by live service-token readback,
and creates one `non_identity` policy containing those selectors. Client Secrets never enter environment
configuration, generated Worker vars or receipts.

The generated Worker keeps the optional legacy ID in `MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID` and writes
non-legacy IDs as a JSON array in `MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS`. For managed OAuth, set
`ELIOTR_MCP_ACCESS_AUTH_PROFILE=managed-oauth`; every service-token input is rejected and the dedicated
app must read back `oauth_configuration.enabled=true` with `path_cookie_attribute=true`.

MCP application and policy compatibility is checked before the owner application is created. Cloudflare
generates the dedicated AUD during application creation; the receipt accepts it only from a fresh
application readback and verifies that it differs from the ordinary AUD. Receipts contain resource IDs,
counts and order-independent digests, but never Client ID values, tokens, cookies or other secrets.
