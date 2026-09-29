# Muse external operator runbook

Design: [ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md).
Status: procedure only, **NOT LIVE-QUALIFIED**. No Muse session or NotebookLM benchmark was executed
in the 2026-09-29 architecture review. Start from [START-HERE](../START-HERE.md) for development work;
this procedure does not replace the active S37 checkpoint or grant permission to spend/deploy.

## 1. Required task inputs

The owner supplies or approves one task manifest with:

- exact ERC code/deployment version, environment and approved origin;
- task ID, project/scope, allowed actions, permitted data disclosure and retention;
- deadline, spend/call/retry ceilings and cancellation route;
- source manifest and expected checks; destination for sanitized observations;
- authentication mode and permitted human takeover; **never credentials in the manifest**.

Missing deployment or credentials blocks only live work. Prepare public/synthetic tasks and connector
code against documented contracts without requesting production secrets or changing the backend queue.

## 2. Qualify this account and session

Record observed product/version (or explicitly unknown), date, platform, environment and capability
results. Use `observed`, `unavailable` or `not checked` as report labels, not new ERC wire enums.

Check separately: browser navigation/screenshot or export, user takeover/login, file upload/download,
terminal/Python availability and package versions, custom API/CLI connector execution, approved host
access and credential surrogation, scheduling/cancellation, and any actual MCP negotiation. Do not infer
one result from another. Never capture real passwords/tokens while checking secret handling; use
synthetic credentials in a controlled endpoint before connecting private data.

Meta's built-in browser does not expose page JavaScript, raw DOM or DevTools to the agent. Record
those unavailable capabilities; do not fabricate console output, HAR, selectors or bounding boxes.
A separately installed Playwright/browser runner is an independent capability with its own setup,
permissions and receipts, not a way to bypass the built-in browser's controls.

Use public/synthetic fixtures first. Before private material is used, record owner-approved provider
disclosure and verified training/privacy settings. Secure VM does not imply provider-inaccessible data.
Routine low-risk actions may run within a narrow preapproved task; spend, wider disclosure and
production administration must not be silently added to that permission.

## 3. Choose one access lane

### Human UI observation

Use an isolated staging owner account/session and an approved PWA URL. The human signs in using
Muse's secure credential/takeover flow. Do not store cookie jars or share owner cookies with a connector.
An owner session is not a project-limited machine grant; keep it away from production for unattended QA.

### Machine connector

Prefer the existing HTTPS application surface when its authenticated principal and project grant are
qualified. Reuse [owner grant management](../../apps/eliotr-core/src/client-grant-http.ts); the client
cannot issue or expand its grant. Use the existing bounded request schemas and response readers.

The current [MCP runtime](../../packages/cloudflare-workspace-mcp/src/gemini-mcp.ts) has a single
Gemini-specific service identity. Do not reuse its token, call Muse `gemini-spark`, change the Google
transport selection or assume generic multi-client MCP exists. A necessary identity generalization is
separate product code under the existing owners, not a setting documented as already implemented.
After it exists, reuse [discovery and diagnostic challenge/readback](gemini-spark-mcp.md#client-connection-check),
then test the actual requested operation. Connection success alone does not qualify document access,
research execution, ongoing availability or model/vendor identity.

Start with permitted discovery/status and project metadata. Enable query/report operations only after
verifying their real authority and side effects; “query” and HTTP GET/POST are not spend/permission
classes. Candidate admission and paid research require explicit existing capabilities. Recheck expiry,
revocation and cancellation on every operation. On timeout, read the stored run/attempt before retrying.

## 4. Run a bounded user-journey check

On synthetic staging data, exercise only implemented surfaces selected by the current task:
Library/project/source navigation; a scoped query; opening an exact citation; saved-report readback;
refresh/reconnect; and cancellation or candidate ingestion only when separately granted.

For each defect record task/case ID, build/environment, safe reproduction steps, expected and observed
behavior, source revision/scope where relevant, typed error and available trace/run/attempt identifiers.
Attach only authorized sanitized screenshots or artifact references. Missing browser internals remain
missing; corroborate with workerd/Playwright or redacted backend diagnostics instead of guessing.

Distinguish product defect, client permission/capability limit, expired login, unsupported input and
external service failure. Turn reproducible defects into the existing task/fixture, not duplicate audit
queues. Never turn “Muse could not click it” into proof the backend is broken.

## 5. Paired NotebookLM comparison

Before running, freeze one comparison manifest. This is a QA artifact, not a newly installed API schema:

```text
comparison/task/case IDs; track and scoring rubric
ERC exact SHA/deployment and visible NotebookLM product/settings/date
source IDs, revisions, SHA-256, byte lengths, allowed disclosure, inclusion/exclusion reasons
prompts/questions and expected source locations; scope and allowed external tools
session reset policy, run order, repetitions, retry/deadline/spend ceilings
raw authorized output/artifact refs; citation targets; start/end times; failure reasons
judge identity/method; adjudication; observations separated from conclusions
```

Keep three tracks separate: (A) closed-corpus retrieval/answering with no additional browsing;
(B) acquisition-enabled research with explicitly recorded tools and newly frozen sources;
(C) human usability. Do not compare ERC plus Muse's web search to NotebookLM restricted to uploaded
sources and attribute the difference to retrieval quality.

Use the same admitted source content in both products. Record format support, ingestion failures,
page/table/image losses, truncation and indexing readiness. If equivalent input cannot be established,
report that limitation and a separate common-input subset, not an apparently matched score.

Choose cases before observing answers: exact passage/number/table-cell lookup; contradictions and
chronology; cross-source synthesis; absent-answer abstention; duplicate-origin independence; malformed
or adversarial source content. Score source support/citation correctness, answer correctness and
coverage, unsupported assertions, honest abstention and useful organization separately from latency,
manual interventions and measured cost. Do not invent a token price for a subscription; unknown cost
is unknown, and rejected/timed-out runs remain in the denominator.

Use source-grounded human or independent review, with blinded/anonymized outputs where feasible.
Muse may collect and propose scores but must not alone certify its own research or decide ERC
acceptance. Preserve disagreements and raw authorized output references. Predeclare repetitions and
run order; do not report only the best trial or claim statistical superiority from one session.

## 6. Final receipt and cleanup

Report exact task/build/corpus, actions actually attempted, observations, canonical ERC readback refs,
remaining unknowns, skipped checks and resource usage. No completed benchmark means no benchmark score.
An agent report or trace cannot upgrade evidence grade, complete a research run or grant live status.

Cancel outstanding client schedules for this task, verify ERC-side cancellation/settlement separately,
revoke temporary grants and sessions through the owner, and remove authorized temporary copies under
the agreed retention policy. A disconnected browser does not prove backend work stopped. Do not delete
canonical evidence or production records as a cleanup shortcut. Store private artifacts only in their
approved location; public GitHub comments receive sanitized reproduction details, never corpus bytes
or credentials.
