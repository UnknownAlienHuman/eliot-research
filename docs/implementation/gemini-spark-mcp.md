# Gemini Spark and Antigravity MCP implementation

## Status

`IMPLEMENTED_NOT_LIVE`. Earlier protocol/setup fixtures do not qualify the new S13 service-token
Research adapters: that checkpoint has compilation/static review only, with behavioral acceptance pending.
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
`GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp` selects the bounded MCP transport. Google helpers remain
candidate-only; the separately authorized Research tools may persist canonical read/search state. The existing
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
cannot authenticate the ordinary HTTP routes. After dedicated MCP verification, only the internal
application adapter carries the actual signed service identity into the same project-grant authorizer;
it does not forward the dedicated JWT or bypass either Access audience.
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
eliotr_query
eliotr_report
eliotr_section
eliotr_citations
eliotr_verify
eliotr_open
eliotr_create_google_sync_plan
eliotr_validate_google_sync_receipt
eliotr_confirm_client_diagnostic
```

Discovery includes only wired tools for the authenticated profile, not a promise that its client has
every operation granted. Catalog and the six Research tools require `service-token` and the actual
application callbacks; `managed-oauth` does not advertise or execute them. Every call rechecks
owner-issued project rights and exact source/artifact authority before disclosing data. Sync plans do not execute Google actions; v2 plans and observations use
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

`eliotr_catalog` is composed through the S10 project grant authorizer. It requires an explicit project
and `catalog` permission from its current owner. A signed Client ID or shared source is not a grant.
Without the callback it stays withheld and direct calls fail with `MCP_CATALOG_SCOPE_REQUIRED`.
Managed-oauth catalog remains unimplemented; its verified human subject is not a service identity.

### Service-token Research tools (S13 code checkpoint)

These tools invoke the same application handlers used by HTTP; no loopback request, new search engine
or second permission store is introduced. The actual verified service actor, credential generation,
expiry and deployment are retained. A non-secret `client_grant_id` is required on each tool and must
agree with any supplied `X-Eliotr-Client-Grant` header. It selects a delegation, never authenticates.

| Tool | Required permission | Result / boundary |
| --- | --- | --- |
| `eliotr_query` | `query` | Original FAST_SEARCH evidence pack and trace reference; no synthesized answer or exhaustive-coverage claim. |
| `eliotr_run_status` | `status`; additionally `report` for a DRAFT result reference | Existing run-status DTO for a known grantor-authored explicit-project run; never starts/resumes execution. |
| `eliotr_cancel` | `cancel` | Stop a known owner run or the same client's machine run under its original grant revision; existing run-status DTO only after durable cancellation. Requires an action key. |
| `eliotr_recover` | `recover` plus pinned owner spend approval | Resume/recover the same owner-project run and checkpoints; may continue authorized paid stages. Requires an action key; never creates a new run. |
| `eliotr_report` | `report` | Existing versioned report-reauthorization envelope, with original artifact metadata and freshness. Known reference required; not report discovery. |
| `eliotr_section` | `report` | Exact saved section bytes in the transport wrapper below. |
| `eliotr_citations` | `report` and `evidence` | Existing reauthorization envelope pairing original citations with fresh authorized handles. |
| `eliotr_verify` | `evidence` | Existing handle resolution against its exact snapshot and original delegation revision. Locator-candidate submission is not exposed by this tool. |
| `eliotr_open` | `evidence` | Exact excerpt or a strict UTF-8 byte range `[start,end)`, with the original verification/identity headers. |

Only grantor-authored DRAFT reports originally scoped to one explicit PROJECT are currently eligible.
A different author's report, compound/GLOBAL scope, or matching source in another project grants no
report access. Permission to read does not grant publication, erasure, source writes or model spend.
Regrant never revives an earlier query/handle scope; historical report bytes/references are unchanged.

Tool names and schemas live once in `gemini-mcp-research-tools.ts`. Scope and reference descriptions
are derived from existing contract schemas; the adapter uses the existing HTTP query parser and
reference validators, not its own scope evaluator. New query requests retain all seven HTTP fields.
The query's exact `idempotency_key` must agree with an incoming Idempotency-Key header. JSON-RPC `id`
is only response correlation, not a mutation key. Retrying an uncertain query must keep the same key,
request and authority; it cannot silently replace the input or adopt a new grant revision.

Example tool call after normal initialize/notifications/initialized, with the negotiated
`MCP-Protocol-Version` header. Replace project/grant references with actual owner-issued values:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"eliotr_query","arguments":{"client_grant_id":"grant-example","idempotency_key":"query-example-1","request":{"query":"Which source documents the decision?","product":"FAST_SEARCH","scope_expression":{"kind":"PROJECT","project_id":"project-example"},"literals":[],"evidence_grade":"E0","budget_ref":"retrieval-fast-v1","max_results":8}}}}
```

For subsequent calls, pass the returned versioned references verbatim; do not build citation IDs or
substitute a new source head. `eliotr_citations` requires `artifact_ref` and `section_ref`; its fresh
handle/snapshot references supply `eliotr_verify`, and `eliotr_open` accepts the same `handle_ref`.
`client_grant_id` must authorize the handle's original delegation revision.

To read a known owner's project run, call:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"eliotr_run_status","arguments":{"client_grant_id":"grant-example","workflow_instance_id":"run-example"}}}
```

Use the actual run ID verbatim. The service must have `status`; `report` independently permits the
returned DRAFT artifact reference after exact historical readback. Pass that reference to
`eliotr_report`. Without `report`, `answer.availability` is `unavailable`. This is known-run result
discovery, not an enumeration endpoint, a service-created investigation or a spending permission.
Expired original sessions do not become current execution authority. Revocation/current source
checks remain enforced on every request; managed-oauth does not inherit these service tools.

Section/open responses use transport envelope `eliotr.mcp.http-body.v1`:
`{ protocol, status, headers, body: { encoding: "utf-8", text, byte_length, sha256 } }`.
The body digest identifies exactly the returned bytes, including a requested range. Original section,
excerpt and verification headers are retained separately, with their existing HTTP URI encoding.
The transport digest is not a new EvidenceHandle or proof of a claim. UTF-8 decoding is strict and
preserves a leading BOM; malformed bytes and split-codepoint ranges are rejected, never repaired.
Other tools return their application DTO unchanged inside the normal MCP result.

The existing 128-KiB request and 512-KiB **complete JSON response** limits still apply. MCP includes
both text and structuredContent, so escaping and duplication may exceed the limit before a raw body
reaches 512 KiB. Overflow is an explicit error, not truncation; use a smaller result set/evidence range
or the existing authorized HTTP section endpoint for a section too large for MCP. Persisted work may
already exist when output cannot be delivered. Errors do not claim that canonical state was unchanged.

All nine Research-tool annotations use `readOnlyHint=false`: search can persist scope/result/trace; report reopening
and completed run-result discovery can issue read grants/handles; evidence resolution can record a verification receipt.
Query, cancel and recover have `idempotentHint=true` under their stable keys. Cancellation alone has
`destructiveHint=true`: it changes durable run state, although it deletes no source/report content.
Recovery alone has `openWorldHint=true`: resuming the workflow can continue authorized model stages.
Query/read/cancel tools do not dispatch models; cancellation does not promise reversal of an already dispatched call.

Apply Core migrations through **0075** before deploying sponsored recovery and grant mutations.
The public grant DTO is unchanged; the existing optional spend-policy field now has an installed,
fingerprint-bound approval check. Machine run admission remains code work, not a successful stub. S13 does not qualify a full Research lifecycle or either live
client. No behavioral test suite, remote service call, deployment or paid call was executed here.

### Stop a known project run

After the owner grants `cancel`, use the same known run ID and one persistent action key:

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"eliotr_cancel","arguments":{"client_grant_id":"grant-example","workflow_instance_id":"run-example","idempotency_key":"stop-example-1"}}}
```

An uncertain response must retain that run, grant and key. The durable action is attributed to the
signed client and bound to its original delegation revision; a regrant cannot repurpose the old key.
`status` is not required for the cancellation command, but is separately required for later polling.
A completed run returns a conflict. Success confirms canonical cancellation, not instantaneous native
termination or a provider refund. Invalid authority or unavailable readback is never reported as
successful cancellation. Sponsored recovery is a separate command below. See
[the cancellation contract](workflow-checkpoints.md#delegated-cancellation-of-a-known-owner-run-s32).

### Recover the same owner-project run

The owner first issues `recover` with an explicit installed spend-policy reference through Connections
or the grant API. The current template fingerprint/deployment/expiry and original execution authority
must still match; a policy locator alone is not approval. Then the actual service can call:

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"eliotr_recover","arguments":{"client_grant_id":"grant-example","workflow_instance_id":"run-example","idempotency_key":"recover-example-1"}}}
```

This can resume remaining paid stages, not renew an expired execution or create a machine-authored
run. Keep the same action key after a lost response; the occupied run/stage slot cannot be repurposed
by regrant or a different caller. Result-read permissions remain separate. The original owner budgets
and saved stage outputs remain authoritative. See the
[recovery contract](workflow-checkpoints.md#delegated-recovery-with-explicit-spend-approval-s32).

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


### Machine Research admission: `eliotr_run`

The service-token dispatcher now composes `eliotr_run` with the existing HTTP run service.
It requires `client_grant_id`, a stable `idempotency_key`, and `request` with product RESEARCH,
explicit PROJECT, the existing `research-budget-v1` locator and existing result/byte bounds.
The grant must separately contain `run` and an exact approved installed spend-template binding;
the budget locator itself conveys no spending authority. Discovery marks this operation
non-read-only and open-world. Retry the same key and request after an uncertain response;
never replace a run ID or infer that a failed response means no work was recorded.

Use `eliotr_run_status` with `status` permission; completed artifact discovery additionally
requires `report`, and exact citation/open calls require `evidence`. This code checkpoint
supports original-credential, active-scope machine status/report reads only. Existing cancel
and recover tools also control that same client's machine run under its original grant revision
(migration 0077). A refreshed signed token can issue controls without renewing execution;
historical status/report reads and owner management remain separate unfinished code. Select
cancel/recover on the grant before creating the run: regrant cannot take over old machine runs.
Recovery retains the original active execution and explicit spend approval; cancellation does
not require a sponsor-template lookup. Apply migrations through 0077 before deployment.
No behavioral or live provider acceptance is implied by tool discovery or compilation.
