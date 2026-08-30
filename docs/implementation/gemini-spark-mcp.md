# Gemini Spark MCP implementation

## Status

`IMPLEMENTED_NOT_LIVE` after deterministic protocol, authorization, setup, and negative fixtures pass.
Live qualification requires a deployed Cloudflare Access service-token round trip plus real Google
Workspace and gcloud action/readback receipts.

## Runtime contour

```text
Gemini CLI Streamable HTTP POST /mcp
→ hostname Cloudflare Access policy
→ signed Access JWT verification
→ exact service-token common_name = gemini-spark
→ MCP protocol/version/body validation
→ four-tool allow-list
→ bounded result
```

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

- owner Access identity cannot use MCP;
- service principal other than `gemini-spark` cannot use MCP;
- browser `Origin` is rejected;
- request body above 128 KiB is rejected;
- JSON-RPC batch is rejected;
- unsupported protocol version/header is rejected;
- provider/database/index selection is absent from every tool schema;
- `dry_run=false` is rejected;
- direct Gemini sync is rejected while Drive Exchange owns the transport;
- digest-mismatching readback remains `OBSERVED_MISMATCH`;
- settings/setup output cannot contain service-token values.
