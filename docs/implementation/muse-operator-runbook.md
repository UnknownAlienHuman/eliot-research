# External agent operation — Muse or another client

[ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md) defines the provider-neutral design.
Muse may be the only external agent; Spark/Google are not prerequisites. This is an operating procedure,
not a claim that a live connection or every adapter already exists.

## Connect and work

Use a supported HTTP/MCP/CLI connector or browser session. Check actual authentication, tools, file
transfer and cancellation support. A provider API key configures inference, not a browser subscription.
With `GOOGLE_EXTERNAL_TRANSPORT=disabled`, Research tools remain available and Google sync tools are hidden.

For service-token MCP, each external client needs its own Cloudflare Access service token. Configure
additional clients for the provisioner as one JSON array; IDs are not secrets, but Client Secrets stay
only in the corresponding client:

```text
ELIOTR_MCP_ACCESS_AUTH_PROFILE=service-token
ELIOTR_MCP_ACCESS_ENABLED=1
ELIOTR_MCP_ACCESS_SERVICE_TOKENS=[
  {"token_id":"<Access service-token UUID>","client_id":"<signed Client ID>.access"},
  {"token_id":"<second UUID>","client_id":"<second Client ID>.access"}
]
```

`ELIOTR_MCP_ACCESS_ENABLED=1` is optional when the profile or bindings already select MCP. It is an
enable-only signal: removal/revocation is a separate reviewed operation, not `=0`. The legacy
`ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID` plus `..._CLIENT_ID` pair remains compatible and identifies the
old `gemini-spark` actor. Omit that pair when Spark is unused. Do not duplicate a Client ID or token UUID
between the legacy pair and the array.

The Access provisioner reads back every exact UUID/Client-ID pairing before mutation, installs one
non-identity policy containing the declared token selectors, and records order-independent digests.
Generated Worker configuration retains the optional legacy Client ID and writes all additional Client IDs
to `MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS`. The Worker independently verifies the signed Client ID and
creates a stable actor for each non-legacy client. Issue project grants against those actual actor/client
identities; Access admission alone does not grant a project or an operation.

Managed OAuth remains a distinct profile and cannot be combined with service-token bindings. A dedicated
MCP application, AUD and `/mcp` path remain separate from ordinary owner Access. Connection configuration
is independent of Google transport selection; Google-free operation does not require pretending Muse is
Gemini.

The owner selects environment, permissions, data scope, task and budget. Production work, writes and
administration are allowed when authorized; routine actions reuse those permissions. Credentials belong
in the client's supported secret mechanism, not prompts or repository files. Missing capabilities are
reported per operation; they do not require abandoning other useful work. `system_status` reports wired
capabilities; successful calls still require their existing per-project grants.

Reuse run/attempt IDs across refresh and reconnect. Read existing results before retrying an uncertain
submission. Record build, task, steps, observed result, error/trace IDs and useful screenshots. Use an
appropriate browser/runtime instrument for internals the client's built-in browser does not expose.

## Compare with NotebookLM

Use the same frozen source bytes and questions; separate closed-corpus answers, web-assisted research
and usability. Record versions/date, ingestion losses, failures, time and available usage/cost. Check
answers and citations against the sources, with independent review rather than only the agent judging
itself. Keep unknowns explicit; save reusable cases and defects in the existing tasks. No comparison
has been run by this documentation change.
