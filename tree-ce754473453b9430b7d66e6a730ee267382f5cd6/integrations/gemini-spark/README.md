# Gemini Spark / Gemini CLI integration

This integration gives Gemini Spark, Gemini CLI, or Gemini Code Assist a bounded ELIOT Research MCP
surface and installs the official Google Workspace and gcloud extensions for Google-side actions.

The authority split is deliberate:

```text
ELIOT MCP                    status, catalog, plan, receipt validation
Google Workspace extension  Drive, Docs, Sheets, Slides, Gmail, Calendar effects
Gcloud extension            Google Cloud inspection and effects
ELIOT admission path         any later canonical ELIOT mutation
```

ELIOT MCP never receives Google OAuth tokens, ADC credentials, service-account keys, or Google content
as authority. A Google tool result remains a candidate observation until exact readback and a separate
ELIOT admission/reconciliation receipt.

## Cloudflare Access prerequisite

Create a dedicated MCP hostname and a separate Cloudflare Access application for it. Create one
dedicated service token, preferably named `gemini-spark`, and retain its exact Client ID and one-time
Client Secret.

Cloudflare signs the service-token **Client ID** into the Access JWT `common_name`; it does not sign the
human-readable token name there. Configure the Worker with the exact Client ID:

```text
ELIOTR_MCP_HOSTNAME
ELIOTR_MCP_ACCESS_TEAM_DOMAIN
ELIOTR_MCP_ACCESS_AUDIENCE
ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID
```

`ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID` normally ends in `.access`. `ELIOTR_MCP_HOSTNAME` must
differ from `ELIOTR_ACCESS_HOSTNAME`. Do not add the dedicated Client ID to the ordinary
`ELIOTR_ACCESS_SERVICE_PRINCIPALS` list.

The Gemini client sends the same dedicated service token through environment references:

```text
ELIOTR_CF_ACCESS_CLIENT_ID
ELIOTR_CF_ACCESS_CLIENT_SECRET
```

`ELIOTR_CF_ACCESS_CLIENT_ID` must equal the Worker deployment value
`ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID`. Do not place either credential value in this repository or
in Gemini settings JSON.

## Setup

Dry run:

```bash
node integrations/gemini-spark/setup.mjs \
  --endpoint https://mcp.example.com/mcp \
  --install-extensions \
  --consent \
  --dry-run
```

Apply user-level Gemini settings and install the ELIOT extension plus pinned official Google
extensions:

```bash
node integrations/gemini-spark/setup.mjs \
  --endpoint https://mcp.example.com/mcp \
  --install-extensions \
  --consent
```

PowerShell:

```powershell
$env:ELIOTR_CF_ACCESS_CLIENT_ID = "<service-token client id>"
$env:ELIOTR_CF_ACCESS_CLIENT_SECRET = "<service-token client secret>"
node integrations/gemini-spark/setup.mjs `
  --endpoint https://mcp.example.com/mcp `
  --install-extensions `
  --consent
```

The script preserves unrelated Gemini settings, writes only environment references for secrets, uses
an atomic settings-file replacement, and pins the external extension source refs. Re-run with newer
reviewed refs explicitly when updating them.

## Verify

```text
gemini mcp list
```

Expected MCP servers include:

```text
eliot-research
google-workspace
gcloud
```

Then ask Gemini to call `eliotr_system_status`. Google mutations must follow the plan → confirmation →
official Google tool → exact readback → receipt-validation sequence in the extension context file.

## Transport exclusivity

Set Worker `GOOGLE_EXTERNAL_TRANSPORT` to exactly one of:

```text
disabled
gemini-mcp
drive-exchange
```

When `drive-exchange` owns the external transport, ELIOT rejects Gemini Google sync plans. The two
transports must never be active for the same state family.
