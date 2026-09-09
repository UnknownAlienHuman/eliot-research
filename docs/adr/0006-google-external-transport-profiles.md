# ADR-0006: Explicit Google external transport profiles

**Status:** accepted

**Date:** 2026-09-09

## Decision

The deployment selects one value of the existing `GOOGLE_EXTERNAL_TRANSPORT` setting:
`gemini-mcp`, `drive-exchange`, or `disabled`. The value is validated from the canonical deployment
configuration and must agree with the implementation release profile. Unknown or mixed values fail closed;
there is no launch-check override argument.

`gemini-mcp` is the selected Workspace profile. Gemini Spark Connected Apps and Google Antigravity own
Google Drive, Docs and Sheets actions on the client side. ELIOT's MCP surface only supplies bounded plans
and candidate readback validation. It does not receive Google credentials, perform Google I/O, or promote
a caller-supplied receipt into canonical D1 state. Workspace selection therefore does not require a Google
Cloud project, custom OAuth client, Vertex configuration, or Gemini API key. The legacy Gemini CLI
extension installer remains retained but is explicitly unselected; it is not a Spark or Antigravity setup.

Antigravity uses a project-local `.agents/mcp_config.json` with remote `serverUrl` entries. Spark uses
Gemini web Connected Apps and an MCP server URL. The exact Cloudflare Access authentication path for
these clients remains pending qualification; no token or secret is written by the client setup.

The client distinction follows the [Gemini Spark Connected Apps guidance](https://support.google.com/gemini/answer/17209137)
and [Antigravity MCP configuration](https://antigravity.google/docs/mcp/) checked on 2026-09-09.
The [Google transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
dated 2026-05-19 records the 2026-06-18 consumer Gemini CLI transition; enterprise/API-key exceptions
do not change this selected client profile.

`drive-exchange` is the separate legacy server-owned ChatGPT Drive Exchange profile. Its encrypted OAuth,
fixed exchange Sheet, cursor/reconciliation, publication and live qualification requirements remain
mandatory whenever that profile is selected. Those requirements do not authorize Cloud setup for the
Workspace profile. `disabled` cannot qualify a release that requires a Google external integration.

## Consequences

The common product launch gates for Retrieval, Research, Federation, Wiki and Erasure remain unchanged.
The Workspace profile has its own pending candidate-admission and exact Google action/readback gate;
removing `DRIVE_EXCHANGE` from that profile alone cannot produce a passing release. The legacy OAuth HTTP
routes are selectable only under `drive-exchange`, so inactive legacy credentials cannot auto-activate.

This decision does not claim that the current Workspace candidate helper is a canonical backend Drive
integration. A future authenticated ELIOT admission/reconciliation contract and real HTTP/D1/readback
qualification are required before Workspace observations can affect canonical state.
