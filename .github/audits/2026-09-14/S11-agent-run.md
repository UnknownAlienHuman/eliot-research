# S11 — Machine query → run → status through the existing API

Baseline: `a2aca127`; finding F09. Technical dependency: S10/#202 project-scoped authorization. Do not wait for unrelated project themes.

## 1. Problem

ROUTES declares owner_or_service for query/run, but `requireOwner` and semantic-server composition reject trusted_agent. Changing route labels alone is insufficient.

## 2. Required change

Connect S10 to the existing POST query/run and GET run-status operations. Complete machine launch and observation in this task; artifact readers and MCP are separate tasks.

## 3. Documentation and exact search anchors

[Architecture, sections 0 and 7.7.2](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'Trusted agents and optional client adapters use the direct semantic API.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'requireOwner' -- apps/eliotr-core/src/research-session.ts
```

## 4. Implementation approach

Trace actual HTTP → scope/orientation → semantic preparation → Workflow. Use the shared S10 authorization decision at the relevant boundaries rather than copying owner-only checks. Scope, operation attribution, and spend policy must refer to the actual service principal. Preserve existing QueryRequest, idempotency, and budget contracts; add fields only when necessary and with explicit compatibility. Do not write a second Research engine or automate a browser as the machine interface.

## 5. Acceptance criteria

- [ ] A service token with project permission performs query, starts a run, and obtains status/operation ID through HTTP.
- [ ] Repeated POST requests retain one run; conflicting input returns a conflict.
- [ ] Requests outside the project/budget, revoked requests, and invalid identities cause no model calls.
- [ ] Existing owner-flow tests pass; service tests do not merely inject owner_pwa context.
- [ ] An end-to-end client without cookies/DOM passes against local Worker/D1/R2 with an explicitly controlled external provider. Record exact SHA and results.
