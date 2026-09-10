# Antigravity MCP client profile

This profile is for Google Antigravity 2.0, Antigravity IDE, and Antigravity CLI. It prepares a
project-local `.agents/mcp_config.json` entry using Antigravity's current `serverUrl` schema. It does
not install Antigravity, import legacy extensions, change global settings, create Google resources, or
write credentials.

## Prepare a local template

Preview the exact no-mutation result:

```bash
node integrations/antigravity/setup.mjs \
  --endpoint https://mcp.example.com/mcp \
  --dry-run
```

To write the project-local template explicitly:

```bash
node integrations/antigravity/setup.mjs \
  --endpoint https://mcp.example.com/mcp \
  --write
```

The generated `eliot-research` entry is deliberately `disabled: true`. It contains only the remote
`serverUrl`; it has no headers, OAuth object, environment interpolation, token, or secret. The entry
remains pending operator authentication and ELIOT live qualification. The setup preserves unrelated
MCP servers and refuses to overwrite an existing `eliot-research` entry unless it is the exact same
disabled template.

Antigravity's documented config locations are global `~/.gemini/config/mcp_config.json` and project
local `.agents/mcp_config.json`. Its remote schema uses `serverUrl`; legacy `url` and `httpUrl` fields
are unsupported. Antigravity documents OAuth/DCR and custom headers, but this repository does not
infer a safe secret-reference mechanism for a Cloudflare Access service token. The ELIOT endpoint still
requires its dedicated Access JWT/service-token Client ID contract; the remaining prerequisite is an
Antigravity auth binding followed by the deployed Access round trip. Complete authentication through a
supported client flow only after that contract is qualified.

## Gemini Spark is a separate client

Gemini Spark connects a custom app through Gemini web Connected Apps by entering the MCP server URL.
This project-local file is not a Spark configuration and does not install anything into Spark. Spark's
availability, account eligibility, and authentication/readback remain separate client concerns; the
exact mapping of Spark credentials to ELIOT's Cloudflare Access headers is unverified.

## Legacy Gemini CLI material

`../gemini-spark/setup.mjs` and its `gemini-extension.json` remain as an explicitly unselected legacy
Gemini CLI path for existing operators. They are not invoked by this profile and are not a setup path
for Spark or Antigravity.
