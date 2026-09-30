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
6. Submit the result with one stable idempotency key.
7. Invoke recovery with the existing workflow ID and one stable recovery idempotency key.
8. Read task status to reconcile uncertain responses.

The result receipt remains `workflow_settled=false` until the existing recovery path validates the callback,
reopens selected evidence and commits the W2/W1 checkpoint.

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
- owner-selected Spark/Muse/Dot routing or failover;
- multiple agents racing one exclusive lease;
- automatic Workflow wake-up after callback;
- automatic admission of new browser/local material;
- offline caching, credential persistence or background browser execution;
- live Dot, Muse or Spark verification.

Qualification must check the actual agent/browser because computer-use products can differ in custom
header support, password-field handling, file transfer, browser isolation, cancellation and local-computer
capabilities.
