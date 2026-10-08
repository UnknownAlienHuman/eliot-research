# Computer-agent web inbox

Status: implemented in source, not deployed or live-qualified. Common task semantics remain in
[the computer-agent runbook](muse-operator-runbook.md); this document covers the browser transport only.

## Deployment contour

Build `@eliotr/pwa` normally. Its pre-build step compiles:

```text
src/agent-inbox.ts  -> public/agent-inbox/app.js
src/agent-inbox.css -> public/agent-inbox/app.css
```

The generated directory is ignored by Git and copied into the static build. The resulting public files
are confined to:

```text
/agent-inbox/
/agent-inbox/app.js
/agent-inbox/app.css
```

Configure Cloudflare Access so only `/agent-inbox/*` bypasses login. Do not bypass `/_astro/*`,
`/api/*`, `/mcp`, evidence, recovery or the owner application. The shell has no embedded identity or
secret and is useless without a separately issued service token and project grant.

The Worker enforces `Cache-Control: no-store`, CSP with `frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, same-origin opener/resource/referrer
policies, a restrictive Permissions-Policy and `X-Robots-Tag` for `/agent-inbox/*` only. Other static
assets keep their existing response bytes and headers.

## Agent credentials

Give each Spark, Muse, Dot or other contour its own:

- Cloudflare Access service-token Client ID and Client Secret;
- owner-issued project-grant locator;
- exact allowed operations and expiry;
- stable worker-slot name when lost-response recovery is required.

For delegated explicit-protocol v8 Research, the same immutable grant revision must include `run`,
`recover` and `evidence`. The inbox never stores or discovers these values. Enter them into the visible
form after opening the page; `pagehide` and the Clear button erase the credential fields.

The page deliberately sends no browser cookies. A valid owner session is not accepted by the new task
routes, and knowing a grant locator is not authentication. Before every protected request, the page also
refuses operation if an existing service worker controls it; use a dedicated clean browser profile rather
than sharing the owner PWA profile. The inbox never registers a worker or writes browser caches/storage.

## Browser workflow

1. Enter the Access Client ID/Secret, project grant and a stable worker slot.
2. Pull a task. A successful response fills task, lease and workflow IDs and creates a strict result
   template from the immutable payload.
3. Select an admitted handle and open a byte range. The range is limited to 64 KiB and uses the existing
   `/api/v1/research/open/:ref` authority.
4. Append progress using the exact next cursor. Reuse identical cursor content only for lost-ack
   reconciliation.
5. Edit the strict result JSON. Canonical role records contain only role, status and admitted handle refs;
   browser/local discoveries remain `candidate_findings` with `admission_state=NOT_ADMITTED`.
6. Submit the result with one stable idempotency key. After durable result readback, Core invokes the
   existing recovery path using `agent-recover-<first 24 request_sha256 hex>`.
7. If result/wake acknowledgement is uncertain, repeat the exact result. Use the manual recovery control only
   as a fallback with that same deterministic key; a different key conflicts with the durable recovery journal.
8. Read task status to reconcile delivery and canonical settlement.

`workflow_settled` remains false while the same workflow is merely active. It becomes true only after the
stage-specific consumer reopens selected evidence, validates the callback and advances W2/W1.

## HTTP contract

Every new task request is a same-origin `POST` with:

```text
CF-Access-Client-Id: <client ID>
CF-Access-Client-Secret: <client secret>
X-Eliotr-Agent-Inbox: eliotr.agent-inbox.v1
X-Eliotr-Client-Grant: <grant locator>
Content-Type: application/json
```

The JSON body also contains the exact same `client_grant_id`. The server rejects missing/foreign Origin,
a foreign `/agent-inbox/` Referer, invalid Fetch Metadata mode/destination, Cookie-bearing requests and
header/body grant mismatch before task mutation.

The recovery call additionally uses `Idempotency-Key`; evidence opening is a protected `GET` and includes
the same Access and grant headers. Redirects are rejected so credentials cannot follow an authentication
or application redirect.

## Non-goals and pending qualification

This slice does not implement:

- Access-policy mutation or service-token issuance;
- automatic Spark/Muse/Dot selection, failover or lease transfer;
- multiple agents racing one exclusive lease;
- deployment/live qualification of automatic Workflow wake-up after callback;
- automatic admission of new browser/local material;
- offline caching, credential persistence or background browser execution;
- live Dot, Muse or Spark verification.

Qualification must check the actual agent/browser because computer-use products can differ in custom
header support, password-field handling, file transfer, browser isolation, cancellation and local-computer
capabilities.

## Register the browser contour

Before using the inbox, the owner creates `/api/v1/system/computer-agents/<connection_id>` with a stable
Idempotency-Key and an exact service-token actor. Include `WEB_INBOX` and task kind
`RESEARCH_BRANCH_ANALYSIS`; list cloud/local/browser capabilities honestly. Updating capabilities appends
a revision. DELETE appends `DISABLED` and does not revoke the Cloudflare token or project grant by itself.
Those remain separate reconciled authorities.

## Configure the project route

For each project, PUT the owner-only route at
`/api/v1/research/projects/<project_id>/computer-agent-routes/RESEARCH_BRANCH_ANALYSIS`. Use strategy
`ORIGINATING_MATCH` and order exact current `{connection_id, connection_revision}` records by preference.
A service actor may start a delegated explicit-protocol run only when its own current connection appears
in the active route; its priority and exact revisions are frozen into the run. Updating the list does not
move existing tasks or leases. DELETE appends a disabled revision and blocks new delegated runs.

## Qualify the exact web-inbox credential

The owner POSTs `{}` with `X-Eliotr-Csrf: 1` to
`/api/v1/system/computer-agents/<connection_id>/qualifications/WEB_INBOX`, then passes the returned one-shot
challenge ID/token to the intended agent. The agent opens `/agent-inbox/`, enters its Access Client ID/Secret
and the challenge, and confirms once. Owner GET on the same qualification URL reports `ISSUED`, `READY`,
`EXPIRED`, `ACTOR_MISMATCH` or `STALE` without returning the token. Task calls fail until the exact current
credential generation is READY.

## Inspect readiness without dispatch

Use the owner-only route readiness GET endpoint with `WEB_INBOX` to see ordered Spark/Muse/Dot entries,
exact revisions, declared capabilities, latest qualification state and the first currently eligible entry.
`UNQUALIFIED`, `EXPIRED`, `ACTOR_MISMATCH`, `STALE`, unsupported capability and stale connection revisions
remain distinct. Reading the report does not select an agent or reserve work.

## Dispatch before task delivery

For owner-selected computer-agent runs, first create an immutable dispatch through the owner API. In the
clean service-token inbox, use **Pull dispatch** and then **Accept dispatch**. Acceptance returns the exact
workflow ID. The workflow may need to advance before Stage 8 publishes an agent task; use the existing task
pull after that point. Repeating accept with the same dispatch is idempotent and returns the same workflow.
A rotated credential, newer route/grant revision or newer qualification requires a new dispatch.

## Deliberate reassignment

For an unaccepted dispatch that should not run, call the owner endpoint
`POST /api/v1/research/projects/:project_id/computer-agent-dispatches/:dispatch_id/abandon` with a stable
`Idempotency-Key` and `{ "reason": "OWNER_REASSIGNMENT" }` or another declared reason. Then read route
readiness and create a new dispatch with a new idempotency key for the chosen READY entry. Do not give the
replacement actor the old dispatch ID, task ID, lease ID or credential generation. Accepted dispatches
must be cancelled through the existing Research run controls.

### Declining an offer

Before acceptance, the exact selected credential generation may submit one stable decline key and reason.
Retry the same key and body after an uncertain response. `DECLINED` means no workflow was created. The
owner must create another dispatch explicitly; an accepted run instead uses normal cancel/recover controls.

### Owner reassignment API

The Web Inbox remains a target-agent surface. Owner automation uses
`POST /api/v1/research/projects/:project_id/computer-agent-dispatches/:dispatch_id/reassign` after reading
an `ABANDONED` or `DECLINED` predecessor. The body names the exact expected predecessor state and frozen
request digest plus the newly selected route/connection/grant/transport. The successor is a new offer;
no browser secret, accepted run, task lease or credential authority is copied from the predecessor.

## Owner-authorized FIRST_READY creation

An owner can create a new offer without manually copying the preferred connection from readiness:

```text
POST /api/v1/research/projects/<project>/computer-agent-dispatches/preferred
Idempotency-Key: <stable owner action key>

{
  "transport": "WEB_INBOX",
  "expected_route_revision": 4,
  "client_grant_id": "<exact target grant>",
  "client_grant_revision": 2,
  "expires_in_seconds": 900,
  "run_request": { "...": "explicit v2 PROJECT Research request" }
}
```

Core records an immutable FIRST_READY selection before creating the ordinary exact dispatch. Repeating the
same owner key/body returns that selection and dispatch even if readiness ordering later changes. A different
body under the same key conflicts. This endpoint does not reassign a declined/abandoned offer and never moves
an accepted dispatch or task lease; use the explicit reassignment endpoint for terminal offers.
