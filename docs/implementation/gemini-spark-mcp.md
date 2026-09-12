# Gemini Spark and Antigravity MCP implementation

## Status

`IMPLEMENTED_NOT_LIVE` after deterministic protocol, authorization, setup, and negative fixtures pass.
Live qualification is profile-specific: the selected Workspace profile requires a deployed dedicated
Cloudflare Access round trip plus real Google Workspace action/readback receipts. The MCP auth profile
is selected by `MCP_ACCESS_AUTH_PROFILE` (`service-token` or `managed-oauth`); managed-oauth remains
pending client compatibility, deployment and exact Access/readback receipts. The optional Cloud profile
additionally requires its gcloud action/readback receipts when explicitly selected; gcloud is not a
Workspace readiness dependency.

## Relation to the canonical ChatGPT transport

ELIOT_RESEARCH v29.1 §§12.3–12.12 and ADR-0003 describe the historical Day-0 ChatGPT **Google Drive
Exchange** profile. Those requirements apply to that separate custom server-owned profile; they are
not a prerequisite for the active Workspace MCP selection recorded on 2026-09-09.
ER-36 is an optional Gemini service integration, not a replacement ADR or that custom Drive adapter.
`GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp` currently enables only this no-effect helper. The existing
mutual-exclusion check still disables its sync tools in `drive-exchange` mode; that flag alone does
not implement Drive. Do not activate a second ChatGPT write transport. Missing Drive OAuth, leased
cursor, freeze/reconciliation and delivery implementations remain open for the separate, unfinished
server-owned ChatGPT Drive Exchange profile; they are not prerequisites for the selected Workspace
MCP profile.

The active 2026-09-09 user scope is Workspace/Google Drive through Gemini Spark Connected Apps and
Google Antigravity MCP. Spark uses its web Connected Apps URL flow; Antigravity uses the project-local
profile described in [`integrations/antigravity/README.md`](../../integrations/antigravity/README.md).
Neither path installs Gemini CLI extensions. The legacy Gemini CLI setup is retained for existing
operators but is explicitly unselected. This profile does not require ELIOT to provision or own a
Google Cloud project, Cloud OAuth client, Vertex route, or Gemini API key. gcloud and Google AI
Studio/Gemini API are optional future profiles and are not live-qualified here. The unfinished
server-owned ChatGPT Drive Exchange remains a separate unselected product path.

## Client references checked 2026-09-09

- [Gemini Spark Connected Apps](https://support.google.com/gemini/answer/17209137) documents adding a
  custom app by MCP server URL in the Gemini web app; it does not document CLI extension installation.
- [Google Antigravity MCP](https://antigravity.google/docs/mcp/) documents project-local
  `.agents/mcp_config.json`, remote `serverUrl`, OAuth/DCR and custom headers. This repository's
  template remains disabled until its Cloudflare Access authentication is qualified.
- [Google's Gemini CLI transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
  is dated 2026-05-19 and records the 2026-06-18 consumer transition. Enterprise and API-key exceptions
  remain outside the selected client scope; the legacy installer is retained only for compatibility.

The canonical deployment profile is selected by the validated `GOOGLE_EXTERNAL_TRANSPORT` value. In
`gemini-mcp` mode the legacy `/oauth/google/*` and `/api/v1/google/connection/*` routes are unavailable;
they are reserved for the explicitly selected `drive-exchange` profile. This selection does not make the
Workspace candidate helper a backend Drive authority or waive its pending authenticated admission and
exact action/readback gate.

## Runtime contour

```text
Spark Connected App or Antigravity remote MCP client POST https://<MCP_HOSTNAME>/mcp
→ dedicated hostname Cloudflare Access application
→ dedicated MCP Access audience
→ signed Access JWT verification through the existing verifier
→ service-token: exact Client ID from JWT common_name → logical principal gemini-spark
→ managed-oauth: verified JWT subject → domain-separated SHA-256 actor principal
→ MCP protocol/version/body validation
→ authorized subset of the configured tool allow-list
→ bounded result
```

Cloudflare's service-token JWT uses the token Client ID as `common_name`; the human-readable service
token name is not an authenticated principal. The Worker therefore requires the exact Client ID through
`MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID`, verifies that signed value, and only then maps it to the internal
logical principal `gemini-spark`. The managed-oauth profile accepts only the existing verifier's
`cloudflare_access` identity and hashes the verified issuer, dedicated audience, subject and profile under
`eliot.mcp.managed-actor.v1`; raw subject values never enter the MCP context or result.

The MCP hostname and Access audience are separate from the owner/API hostname and audience. The ordinary
API `ACCESS_SERVICE_PRINCIPALS` must not contain the dedicated MCP Client ID; the dedicated MCP verifier
has an exact one-Client-ID allow-list. A service token that reaches one Access application therefore
cannot be reinterpreted as an ordinary trusted-agent credential by application routing.
For managed-oauth, `MCP_ACCESS_AUDIENCE` must differ from `ACCESS_AUDIENCE`, service-token credentials
are rejected, and the dedicated host/team/audience configuration is validated before JSON-RPC dispatch.

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
eliotr_confirm_client_diagnostic
```

Discovery includes only wired, authorized tools. The catalog remains withheld until service-scope
read authority is composed. Sync plans do not execute Google actions; v2 plans and observations use
the existing candidate ledger. Receipt validation does not claim that ELIOT performed Google readback.
Client confirmation writes only the diagnostic observation described below.

## Client connection check

The owner API issues a challenge through `POST /api/v1/system/mcp-diagnostics` with an empty JSON
object, a same-origin request and `x-eliotr-csrf: 1`. Its 201 response contains the one-time
`challenge_id` and `challenge_token`. The deployment must explicitly select `MCP_ACCESS_AUTH_PROFILE`.
The token expires after five minutes and is stored only as a SHA-256 digest in D1.

Pass the issued fields to `eliotr_confirm_client_diagnostic` through the configured MCP client.
The client authenticates on the dedicated MCP hostname and audience. Owner and MCP identities may
differ; possession of the challenge never replaces MCP authentication. Confirmation is a single
guarded transition with exact readback. Ordinary replay is rejected.

`GET /api/v1/system/mcp-diagnostics` returns the latest challenge for the current owner credential
and deployment generation, or typed `MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND`. GET supports browser reads
without an Origin header and rejects a supplied foreign Origin or Referer. Responses are `no-store`;
status readback contains no challenge token or verified actor credentials.

A confirmed observation records a past authenticated call. It does not identify an individual
client/model, establish continuing availability, prove document access or complete a research run.
An unused expired challenge cannot be confirmed; an already confirmed observation remains historical.
Connections exposes manual Start client check, Copy instruction and Check result actions. Challenge
material stays in page memory, clears after expiry or access/deployment loss and is never polled or
persisted in browser storage. Confirmed call time is visible; technical readback stays in Details.
Local acceptance includes signed owner/MCP HTTP through the real Worker and migrated D1, plus the
built PWA in Chromium with controlled HTTP responses. Live client compatibility remains unqualified.

## Google integration

The active client setup does not install a Google extension. Antigravity's project-local template uses
the current `serverUrl` field and stays disabled until authentication and ELIOT live qualification are
complete. See [`integrations/antigravity/README.md`](../../integrations/antigravity/README.md). The older
Gemini CLI setup retains a pinned source commit for existing operators only:

```text
gemini-cli-extensions/workspace  089927ead01433f38c65c12cdcd2ed9a18165277 (legacy/unselected)
```

The pinned `gemini-cli-extensions/gcloud` ref remains available only through the explicit optional
Cloud profile; it is not a default or Drive readiness dependency.

Update these only after reviewing upstream changes and rerunning deterministic setup/security fixtures.
Antigravity documents remote `serverUrl`, OAuth/DCR and custom headers, but this repository does not
infer a secret-reference mechanism for Cloudflare Access credentials. Spark documents URL-based
Connected Apps and optional credentials, but does not document Cloudflare Access header injection.
The exact Access-to-client authentication path remains pending qualification. A Gemini subscription
does not imply Google Cloud project billing, IAM, API enablement, OAuth consent, or Workspace
permissions; those remain independent live preconditions.

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
- an unknown or mixed `MCP_ACCESS_AUTH_PROFILE` configuration fails closed;
- managed-oauth rejects service-token credentials and ordinary-audience reuse;
- distinct verified managed subjects produce distinct actor bindings without exposing raw subject PII;
- the selected Workspace profile rejects `google_product=cloud` and never invokes gcloud.


### Service catalog authorization

The Worker advertises its configured status, Google sync and receipt tools. The diagnostic tool is
included only when the explicit selected Access profile and trusted Core callback are configured.
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
