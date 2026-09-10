# ADR 0005: protect the hostname, not the Worker, with Cloudflare Access

- Status: accepted
- Date: 2026-08-28
- Scope: production and staging ingress

## Context

`ResearchSession` uses Durable Object WebSockets for connected clients, cursors and pending approvals.
Cloudflare's Worker-level Access destination protects every route for a Worker, but the current platform
explicitly rejects WebSocket upgrades for that mode. A Worker-level policy would therefore make the
research session transport unavailable even though ordinary HTTP requests appeared healthy.

## Decision

Provision one hostname-based self-hosted Access application for the exact Eliot Research hostname. The
application owns one required owner-email policy. Any additional service policy must be explicitly
allow-listed by policy ID in `ELIOTR_ALLOWED_ADDITIONAL_ACCESS_POLICY_IDS`; undeclared policies fail the
provisioning gate because they may broaden access.

`ELIOTR_ACCESS_HOSTNAME` contains only the exact hostname. `ELIOTR_CUSTOM_DOMAIN=1` asks the generated
Wrangler deploy config to attach that hostname as a Custom Domain and disable `workers.dev`. Without the
flag, the hostname may be a pre-existing route or the Worker's `workers.dev` hostname.

The Worker must still fail closed when `ctx.access` is absent in staging/production. Access configuration
is an outer authentication boundary; domain authorization, disclosure policy and scope algebra remain
inside Eliot Research.

## Consequences

- WebSocket upgrades stay compatible with the Access contour.
- Access follows one hostname rather than every possible Worker route; adding another hostname requires
  an explicit desired-state change.
- Automated HTTP smoke needs an authenticated Access session or a separately reviewed service policy.
- Worker-level Access must not be enabled for this Worker while `ResearchSession` uses WebSockets.
