# External agent operation — Muse or another client

[ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md) defines the provider-neutral design.
Muse may be the only external agent; Spark/Google are not prerequisites. This is an operating procedure,
not a claim that a live connection or every adapter already exists.

## Connect and work

Use a supported HTTP/MCP/CLI connector or browser session. Check the actual client's authentication,
tools, file transfer and background/cancellation support. The current MCP adapter has one legacy
Gemini identity; use the existing independently authorized HTTP path or implement the registry change
named in ADR-0007. A provider API key configures inference, not an agent's browser or subscription.

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
