# ADR-0008: Narrow web inbox for computer agents without write-capable MCP

- Status: accepted implementation direction; live deployment and agent qualification remain pending.
- Date: 2026-09-30.
- Amends: [ADR-0007](0007-external-agents-and-cloudflare-evolution.md).
- Baseline: `70dc0965693d1b35e63621b9a26611e84937b437`.

## Decision

Expose the existing external-task authority through a small static web inbox for OpenAI Dot Pro and
other computer agents that can operate a browser but cannot call write-capable custom MCP tools.

The inbox is a transport facade only:

```text
computer agent browser
  -> static /agent-inbox/ shell
  -> Cloudflare Access service-token headers
  -> existing project grant
  -> existing 0085/0086 task, evidence and run-recovery services
  -> existing W2/W1 settlement
```

It does not create a second scheduler, browser-session principal, owner-session substitute, model
provider, evidence authority or completion path. Spark, Muse, Dot and later computer agents use the
same task identities and callbacks when their available transport differs.

## Security boundary

The static shell contains no credential, grant, task or deployment value. The operator configures a
Cloudflare Access bypass only for `/agent-inbox/*`; every API, evidence and recovery request remains
inside the existing protected Access application.

Astro normally emits shared assets under `/_astro/*`. Opening that prefix would expose the owner PWA
bundle. Therefore typed inbox source is compiled separately into `app.js` and `app.css` under the same
`/agent-inbox/` prefix. The build rejects imports, dynamic imports, source maps, persistence APIs and
output outside that dedicated directory.

The browser supplies its own Access Client ID/Secret and exact project-grant locator. The shell refuses
to transmit credentials while an existing service worker controls the page; use a dedicated clean
computer-agent browser profile. Requests:

- use `credentials: omit`, `redirect: error`, `mode: same-origin` and `cache: no-store`;
- require the exact page origin, optional same-origin `/agent-inbox/` referrer and a versioned inbox marker;
- reject Cookie-bearing task requests so an owner browser session cannot substitute for a service actor;
- reconcile `X-Eliotr-Client-Grant` with the JSON `client_grant_id`;
- remove Access service-token headers before the request context reaches task/grant services.

Client Secrets are never written to Web Storage, IndexedDB, cookies, URLs, durable state, response
bodies or application logs. Access verification remains the authentication authority; a self-reported
`OPENAI_DOT`, `META_MUSE` or `GEMINI_SPARK` label remains diagnostic metadata only.

## API contour

The facade adds four same-origin POST routes:

| Path | Existing authority |
|---|---|
| `/api/v1/research/agent-tasks/pull` | `eliotr_task_pull` |
| `/api/v1/research/agent-tasks/progress` | `eliotr_task_progress` |
| `/api/v1/research/agent-tasks/result` | `eliotr_task_result` |
| `/api/v1/research/agent-tasks/status` | `eliotr_task_status` |

All require a verified service token and an exact current grant with `run`. The existing evidence-open
route still requires `evidence`; the existing recovery route still requires `recover` and an
idempotency key. The inbox does not widen either permission.

The UI can pull one task, inspect status, open bounded admitted evidence ranges, append progress,
submit one idempotent callback and invoke canonical recovery. It does not automatically ingest browser
discoveries, select another agent, renew grants, wake a Workflow in the background or promote callback
prose into evidence.

## Operational consequences

OpenAI Dot Pro can use the UI even while its custom MCP contour is read/fetch-only. Business,
Enterprise/Edu, Muse, Spark or another agent may continue using MCP/API directly. Both transports
share the same D1 task rows, lease rules, callback digest and W2/W1 settlement.

Deployment must explicitly:

1. build the PWA so the dedicated inbox assets are generated;
2. configure a path-scoped bypass for `/agent-inbox/*` only;
3. keep `/api/*`, evidence and recovery paths protected; the Worker adds no-store, CSP, anti-frame,
   no-sniff, same-origin isolation and restrictive Permissions-Policy headers only to the inbox prefix;
4. issue one distinct service token and project grant per computer-agent contour;
5. qualify the actual browser's custom-header, redirect, cancellation and no-persistence behavior.

No live Access policy, service token, deployment or agent account is changed by this ADR.

## Connection registry requirement

The service-token actor must also have an owner-enabled current computer-agent connection revision with
`WEB_INBOX` and `RESEARCH_BRANCH_ANALYSIS`. The registry stores no Client Secret. It binds transport and
computer capabilities to the exact Access issuer/subject and prevents a self-reported contour selector
from becoming authority. Disabling the connection blocks new inbox task operations without deleting task,
lease, callback or project-grant history.

## Project route binding

An enabled `WEB_INBOX` connection is necessary but not sufficient for a delegated v8 run. The project
owner must also publish an active `RESEARCH_BRANCH_ANALYSIS` route containing that exact current
connection revision. The run records the chosen route/connection/grant revisions before Workflow start,
and Stage 8 verifies that immutable origin before exposing a task. Priority order is not browser-supplied
and does not permit the inbox to claim another connection's run.

## Web-inbox qualification

Before task access, the owner issues a `WEB_INBOX` challenge for the exact current connection revision.
The agent enters the one-shot challenge ID/token in the no-persistence inbox. Confirmation uses the same
service-token Access actor as later task calls, omits cookies, clears the token after success, and writes only
the existing diagnostic observation plus immutable connection binding. A changed credential generation,
connection revision, deployment, expiry or disabled connection requires a new qualification.

## Route readiness preview

Owners may inspect
`/api/v1/research/projects/<project_id>/computer-agent-routes/RESEARCH_BRANCH_ANALYSIS/readiness/WEB_INBOX`
before starting work. The report preserves route priority but marks an entry eligible only when the exact
connection revision is still current/enabled, declares `WEB_INBOX` and the task kind, and has READY
qualification for the current deployment. `preferred_ready_connection` is advisory observation only.

## Owner-authorized dispatch acceptance

The isolated inbox may call the service-token dispatch pull and accept endpoints in addition to task,
evidence and recovery endpoints. Pull is read-only and returns only an unexpired intent addressed to the
page's exact Access actor, current grant, route, connection and WEB_INBOX qualification. Accept starts the
existing delegated Research workflow with the dispatch's frozen request. Neither action persists secrets,
creates a second scheduler, selects another actor or transfers a task lease.

### Reassignment after a declined or unavailable target

The web inbox never silently advances to the next route entry. For an unaccepted offer, the owner records
an explicit abandonment, observes current readiness again, and creates another exact dispatch. This
preserves actor, credential-generation and grant boundaries. Accepted work uses the existing Research
cancellation/recovery flow instead of reassignment.
