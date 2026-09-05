# Gemini Spark MCP implementation

## Status

`IMPLEMENTED_NOT_LIVE` after deterministic protocol, authorization, setup, and negative fixtures pass.
Live qualification requires a deployed dedicated Cloudflare Access service-token round trip plus real
Google Workspace and gcloud action/readback receipts.

## Relation to the canonical ChatGPT transport

ELIOT_RESEARCH v29.1 §§12.3–12.12 and ADR-0003 require Day-0 ChatGPT **Google Drive Exchange**.
ER-36 is an optional Gemini service integration, not a replacement ADR or the Drive adapter.
`GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp` currently enables only this no-effect helper. The existing
mutual-exclusion check still disables its sync tools in `drive-exchange` mode; that flag alone does
not implement Drive. Do not activate a second ChatGPT write transport. Missing Drive OAuth, leased
cursor, freeze/reconciliation and delivery implementations remain mandatory Launch 07 work.

## Runtime contour

```text
Gemini CLI Streamable HTTP POST https://<MCP_HOSTNAME>/mcp
→ dedicated hostname Cloudflare Access application
→ dedicated MCP Access audience
→ signed Access JWT verification
→ exact service-token Client ID from JWT common_name
→ internal logical principal gemini-spark
→ MCP protocol/version/body validation
→ authorized subset of the four-tool contract allow-list
→ bounded result
```

Cloudflare's service-token JWT uses the token Client ID as `common_name`; the human-readable service
token name is not an authenticated principal. The Worker therefore requires the exact Client ID through
`MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID`, verifies that signed value, and only then maps it to the internal
logical principal `gemini-spark`.

The MCP hostname and Access audience are separate from the owner/API hostname and audience. The ordinary
API `ACCESS_SERVICE_PRINCIPALS` must not contain the dedicated MCP Client ID; the dedicated MCP verifier
has an exact one-Client-ID allow-list. A service token that reaches one Access application therefore
cannot be reinterpreted as an ordinary trusted-agent credential by application routing.

Supported protocol revisions:

```text
2025-06-18
2025-03-26
```

The server is stateless, omits `Mcp-Session-Id`, rejects JSON-RPC batching, does not expose resources or
prompts, and returns JSON rather than an SSE stream. `GET /mcp` returns 405 because server-to-client
notifications are not required by this contour.

## Tools

```text
eliotr_system_status
eliotr_catalog
eliotr_create_google_sync_plan
eliotr_validate_google_sync_receipt
```

All four are read-only from ELIOT's perspective. The planning tool has an executable
`NO_EXTERNAL_EFFECT` ceiling. Receipt validation never states that ELIOT performed the Google readback
or changed canonical state.

## Google integration

The setup pins reviewed source commits for:

```text
gemini-cli-extensions/workspace  089927ead01433f38c65c12cdcd2ed9a18165277
gemini-cli-extensions/gcloud     ec545cd8252d33c83f02b97939690b8ae16888ef
```

Update these only after reviewing upstream changes and rerunning deterministic setup/security fixtures.
A Gemini subscription does not imply Google Cloud project billing, IAM, API enablement, OAuth consent,
or Workspace permissions; those remain independent live preconditions.

## Mandatory negative cases

- a request on the ordinary owner/API hostname cannot reach MCP;
- owner Access identity cannot use MCP;
- a service token whose signed Client ID differs cannot use MCP;
- the human-readable token name cannot substitute for its signed Client ID;
- browser `Origin` is rejected;
- request body above 128 KiB is rejected;
- JSON-RPC batch is rejected;
- unsupported protocol version/header is rejected;
- provider/database/index selection is absent from every tool schema;
- `dry_run=false` is rejected;
- direct Gemini sync is rejected while Drive Exchange owns the transport;
- digest-mismatching readback remains `OBSERVED_MISMATCH`;
- settings/setup output cannot contain service-token values.


### Service catalog authorization

The real Worker currently advertises three tools: status, Google sync planning and receipt validation.
The `eliotr_catalog` contract remains defined, but it is not advertised or executable without an explicit
service-scope read-policy adapter. Direct calls return `MCP_CATALOG_SCOPE_REQUIRED` before D1 access.
A signed Client ID alone is not a namespace grant; mapping it to `owner_pwa` is prohibited. Launch 07
must implement and test service-scope authorization before restoring catalog discovery.

## v1 observation validation limits

Both plan and receipt are caller-supplied. The stable plan ID binds declared request inputs to the
MCP principal/deployment, but is not a signed issuance record: in particular it cannot prove when the
original plan was issued, that consent occurred, or that Google was called. `OBSERVED_MATCH` means
internal consistency of supported self-reported fields only. Canonical admission/T4 cannot consume it
as effect proof; `candidate_only=true`, `google_readback_performed_by_eliotr=false` and authority
reconciliation remain mandatory. There are no Google calls or persistent writes in this validator.

The supported exact-object comparison requires `target_ref` to equal the normalized native resource
ID/name in `resource_id`, not a folder, title, URL or inferred alias. Missing identity or expected file
payload digest is unverified. Read `expected_revision` must equal the observed revision. For mutations,
that value is a pre-write condition, not a predicted post-write version; v1 has no CAS evidence and
returns `REVISION_PRECONDITION_UNVERIFIED`. New-resource/search observations need a specific adapter.
Cloud/Calendar/Gmail typed state is not represented by v1; arbitrary status strings remain
`PRODUCT_STATE_UNVERIFIED`, not a successful resource-state check. Planning those actions still has
NO_EXTERNAL_EFFECT and does not imply executable or qualified synchronization.

Strict input checks require canonical ISO timestamps, a 15-minute declared lifetime, current time
within [created_at, expires_at), and `created_at <= observed_at <= now` with `observed_at < expires_at`. Declared connector, confirmation flag,
readback-field list and instructions must equal the planner's output. Non-boolean readback flags and
altered descriptors fail decoding. Expired/future/resource/revision/digest mismatches return an explicit
negative candidate observation; raw provider payloads and errors are never reflected.

Valid v1 plan identity preimages and response fields are unchanged by these checks. Future authenticated
issuance or operation-specific evidence requires a reviewed versioned contract, not extra implicit
trust in this generic envelope. See `canonical-alignment.md` for remaining implementation gaps.
