# External agent operation — Muse or another client

[ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md) defines the provider-neutral design.
Muse may be the only external agent; Spark/Google are not prerequisites. This is an operating procedure,
not a claim that a live connection or every adapter already exists.

## Connect and work

Use a supported HTTP/MCP/CLI connector or browser session. Check actual authentication, tools, file
transfer and cancellation support. For service-token MCP, set Worker `MCP_ACCESS_AUTH_PROFILE=service-token`
and `MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS` to a JSON array (or JSON-encoded string), for example
`["muse-client.access", "other-client.access"]`, replacing both examples with real Access Client IDs.
Authorize those tokens in the dedicated Access application too, and issue the required project grants
against each actual signed Client ID/issuer. The IDs are configuration; Client Secrets stay in the client.
`MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID` is optional and preserves the old Gemini actor only; omit it when
Spark is unused, and do not repeat it in the new list. Generic clients get separate stable actor hashes.
Existing automated Access provisioning still configures one legacy token; this checkpoint adds Worker
runtime support, not a multi-client provisioning UI or a live Muse connection. Managed OAuth Research
delegation remains separate. A provider API key configures inference, not a browser or subscription.
With `GOOGLE_EXTERNAL_TRANSPORT=disabled`, Research tools remain available and Google sync tools are hidden.
`system_status` reports wired capabilities; successful calls still require their existing per-project grants.

The owner selects environment, permissions, data scope, task and budget. Production work, writes and
administration are allowed when authorized; routine actions reuse those permissions. Credentials belong
in the client's supported secret mechanism, not prompts or repository files. Missing capabilities are
reported per operation; they do not require abandoning other useful work.

Reuse run/attempt IDs across refresh and reconnect. Read existing results before retrying an uncertain
submission. Record build, task, steps, observed result, error/trace IDs and useful screenshots. Use an
appropriate browser/runtime instrument for internals the client's built-in browser does not expose.

## Compare with NotebookLM

Use the same frozen source bytes and questions; separate closed-corpus answers, web-assisted research
and usability. Record versions/date, ingestion losses, failures, time and available usage/cost. Check
answers and citations against the sources, with independent review rather than only the agent judging
itself. Keep unknowns explicit; save reusable cases and defects in the existing tasks. No comparison
has been run by this documentation change.
