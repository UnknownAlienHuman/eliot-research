# Computer-agent operation — Gemini Spark, Meta Muse, OpenAI Dot or another client

[ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md) defines the provider-neutral design.
Spark, Muse and Dot are separate computer-agent contours. Any one may be the only connected agent. This
is an operating procedure, not a claim that a live connection or every adapter has already qualified.

## Capabilities and transport

Record the agent's real capabilities separately:

- cloud computer, browser, network and desktop/application interaction;
- optional local-computer files, shell, local skills and local browser;
- MCP/API/CLI support and whether it can write or only read/fetch;
- connected apps, messaging channels, scheduled/proactive work and memory;
- cancellation, file-transfer and screenshot/trace support.

OpenAI Dot has its own cloud computer. Local-computer access is optional and separately enabled; it can
then work with local files and commands, local skills and browser fallback, and can create Work or Codex
tasks. Enterprise controls separately gate cloud browser, network, desktop, password manager, local
computer, Slack/Teams and custom rules. Do not assume Dot Pro has write-capable custom MCP: full MCP
write/modify is currently a Business/Enterprise/Edu capability, while Pro custom MCP is read/fetch-only.
Use the shared MCP/API contour when supported and the source-implemented
[computer-agent web inbox](computer-agent-web-inbox.md) when only computer/UI interaction is available.
Its Access policy, deployment and real-agent qualification remain pending.

A provider API key configures inference, not a browser subscription or computer agent. With
`GOOGLE_EXTERNAL_TRANSPORT=disabled`, Research tools remain available and Google sync tools are hidden.

## Access identities

Each external client needs its own Cloudflare Access service token and its own owner-issued project-grant
revision. Computer-agent Research requires that same revision to authorize `run`, `recover` and `evidence`. Never reuse Spark's identity for Muse or Dot. Configure additional clients as one JSON array;
IDs are not secrets, but Client Secrets stay only in the corresponding client:

```text
ELIOTR_MCP_ACCESS_AUTH_PROFILE=service-token
ELIOTR_MCP_ACCESS_ENABLED=1
ELIOTR_MCP_ACCESS_SERVICE_TOKENS=[
  {"token_id":"<Spark token UUID>","client_id":"<Spark Client ID>.access"},
  {"token_id":"<Muse token UUID>","client_id":"<Muse Client ID>.access"},
  {"token_id":"<Dot token UUID>","client_id":"<Dot Client ID>.access"}
]
```

`ELIOTR_MCP_ACCESS_ENABLED=1` is optional when the profile or bindings already select MCP. It is an
enable-only signal: removal/revocation is a separate reviewed operation, not `=0`. The legacy
`ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID` plus `..._CLIENT_ID` pair remains compatible and identifies the
old `gemini-spark` actor. Omit that pair when Spark is unused. Do not duplicate a Client ID or token UUID.

The provisioner reads back every UUID/Client-ID pairing before mutation, installs one bounded
non-identity policy, and records order-independent digests. Generated Worker configuration writes
additional IDs to `MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS`. The Worker verifies each signed Client ID and
creates a stable actor. Issue project grants against those real actors. Access admission alone does not
grant a project or operation, and a self-reported `OPENAI_DOT`/`META_MUSE`/`GEMINI_SPARK` label is never
a credential.

Managed OAuth remains a distinct profile and cannot be combined with service-token bindings. A dedicated
MCP application, AUD and `/mcp` path remain separate from ordinary owner Access. Connection configuration
is independent of Google transport selection.

## Pull tasks and return results

Migrations `0085_external_agent_task_delivery.sql` and `0086_external_agent_task_payload.sql` plus four
MCP tools provide the delivery channel. Newly admitted delegated explicit-protocol runs use handler
generation `research-handlers.exploratory.v8`; the first live consumer is `ANALYZE_BRANCHES`.

1. Start `eliotr_run` under the agent's exact project grant. The same immutable grant revision must authorize
   `run`, `recover` and `evidence`. At Stage 8 the workflow publishes a `RESEARCH_BRANCH_ANALYSIS` payload
   bound to the exact W2 attempt, request digest, project and historical grant revision. The initial workflow
   execution intentionally remains STARTED/uncertain while the agent works.
2. Call `eliotr_task_pull` with that `client_grant_id` and reuse a stable `worker_slot` (default: `default`).
   The response includes `task_kind`, `task_expires_at`, `payload_sha256` and the bounded handle-first payload.
   Reopen exact evidence with `eliotr_open` in bounded byte ranges; do not expect task pull to duplicate large
   excerpts. Pull returns the slot's same unexpired lease after an uncertain response or reconnect, and
   `task: null` when none is available. Independent slots may claim distinct tasks. A lease is pinned to the
   credential generation that claimed it; rotated credentials cannot inherit it.
3. Analyse the supplied frozen questions and **already-admitted evidence**. Browser/app/cloud/local-computer
   work may discover other material, but return it only in `candidate_findings` with
   `admission_state=NOT_ADMITTED`. Never invent an evidence handle. New material requires a separate
   ingest/admission flow before any future investigation can use it canonically.
4. Call `eliotr_task_progress` only with the next cursor. Exact same-cursor content can reconcile while the
   same lease remains current; gaps, changed content, replacement leases and cancellation fail closed.
5. Call `eliotr_task_result` with one stable idempotency key and the strict
   `eliotr.external-branch-analysis.v1` output. Each role record contains only `role`, `status` and selected
   admitted `evidence_handle_refs`; arbitrary role prose is rejected and cannot enter the canonical checkpoint.
   Report the observed contour/computer/interface honestly; it is diagnostic metadata, not authority.
   Use `SUBSCRIPTION`, `API_METERED` or `UNKNOWN` usage honestly; never invent token counts or cost. A strict
   `FAILED` callback is converted server-side into blocked branch records with quarantined diagnostics, rather
   than authorizing replacement evidence or silently retrying another agent.
6. After the result receipt (`workflow_settled=false`), call the existing `eliotr_recover` for the same
   workflow ID and grant. Recovery reads the exact callback, re-resolves every selected handle under current
   scope/evidence authority, derives the canonical branch checkpoint server-side, and settles through W2/W1.
7. Use `eliotr_task_status` to inspect delivery state, lease, progress digest, callback digest and workflow
   cancellation. It does not renew a lease or settle the stage.

The task deadline can outlive the original short W2 execution reservation so an agent can complete GUI
work, but it is still bounded by the exact grant and current workflow authority. If publication loses its ACK
after staging the payload but before creating the task row, the exact task may still bind before that original
immutable deadline; replay never extends it. Revocation, regrant, project/scope drift or cancellation fail
closed. Owner explicit-protocol runs use deterministic v7;
historical generations retain their previous semantics.

There is no arbitrary shell inbox and no permission derived from knowing a `client_grant_id`. The isolated
`/agent-inbox/` source implementation is a no-persistence facade over this same backend contract, not a
second scheduler or weaker authorization path. It is not live until the path-scoped Access policy and the
actual Spark/Muse/Dot browser are qualified.

## Operational recording

Reuse run, task, attempt, lease and idempotency IDs across refresh and reconnect. Read existing status/results
before retrying an uncertain submission. Record agent build, task, steps, cloud/local computer mode,
interfaces used, observed result, error/trace IDs and useful screenshots. Credentials belong in the
client's supported secret mechanism, not prompts or repository files.

## Compare with NotebookLM

Use the same frozen source bytes and questions; separate closed-corpus answers, web-assisted research and
usability. Record versions/date, ingestion losses, failures, time and available usage/cost. Check answers
and citations against the sources, with independent review rather than only the agent judging itself.
Keep unknowns explicit; save reusable cases and defects in the existing tasks. No comparison has been run
by this documentation change.

## Official Dot references

- https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
- https://help.openai.com/en/articles/20001554-manage-dots-in-chatgpt-workspaces
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

## Register each computer-agent connection

Register Spark, Muse and Dot separately through the owner-only computer-agent connection API. Bind each
logical connection to its exact Access issuer and Client ID, then declare only observed transport and
computer capabilities. MCP task callbacks require `MCP_WRITE`; the browser inbox requires `WEB_INBOX`.
The contour label is descriptive only. The same actor still needs an exact current project grant with
`run`, `recover` and `evidence`. Disabling a registry entry blocks task access but does not silently revoke
Access credentials or rewrite historical grants and leases.

## Bind connections to a project route

After registering Spark, Muse or Dot, the project owner publishes an ordered
`RESEARCH_BRANCH_ANALYSIS` route containing the exact current connection revisions. The initial strategy
is `ORIGINATING_MATCH`: the agent that starts the delegated run must itself appear in the route. The
recorded priority is preparation for later owner-directed routing; it does not let a lower- or higher-
priority agent inherit another actor's grant, task or lease. Update the route after changing a connection
revision, and use a new Idempotency-Key for each distinct route revision.

## Qualify each transport

Capability declarations are not readiness. The owner issues a qualification challenge for the exact current
connection revision and transport. An MCP client confirms the challenge with the existing
`eliotr_confirm_client_diagnostic` tool; a UI-only Dot/Muse/Spark contour confirms `WEB_INBOX` in the
no-persistence page. Requalify after credential rotation, connection revision changes, deployment changes,
expiry or freshness timeout. Never copy one contour's challenge token to another actor.

## Preview the preferred ready contour

Before manual dispatch, the owner can read the project route readiness report for `MCP_WRITE` or
`WEB_INBOX`. The first eligible ordered entry is returned as `preferred_ready_connection`, while every
other entry retains its exact reason for ineligibility. This is a planning signal only: the agent that starts
a delegated run must still be the verified originating actor present in the active route.

## Owner-selected dispatch flow

1. Confirm the intended Muse/Spark/Dot connection and transport is READY in the route-readiness report.
2. Create a dispatch naming that exact connection revision and exact project-grant revision, with the
   explicit v2 PROJECT Research request and a TTL of at most 3600 seconds.
3. In the target agent's own authenticated contour, pull the dispatch using the exact grant locator.
4. Accept it under that same credential generation. The returned workflow ID is the existing Research run,
   not a wrapper job.
5. Pull the Stage 8 task only after the workflow publishes it, submit the callback, then recover through the
   existing W2/W1 path.

Do not accept another actor's dispatch, copy a lease between agents, or interpret an empty pull as permission
to start a replacement run. Route/grant/qualification changes require a fresh owner intent.
