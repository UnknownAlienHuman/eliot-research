# S74 — Show truthful Connections for the selected profile

Baseline: `a2aca127`; ER-25/36. Selected profile: gemini-mcp. Reuse grant UI S31/#223, MCP tools #205, Workspace #250/#251, proof readiness #226, and diagnostics #263.

## 1. Problem

MCP connectivity, model readiness, project authorization, and verified Google actions are distinct states. An audit's unused-route list does not require enabling legacy OAuth for the selected Workspace profile.

## 2. Required change

Use one Connections screen with separate cards for server, model/route, actual agent principal/project grant, and selected Workspace transport/last verified action. Provide an appropriate corrective action for each failure rather than requiring users to paste a large instruction into chat.

## 3. Documentation and exact search anchors

[Architecture profile applicability](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md).

```sh
git grep -n -F '## Profile applicability — ADR-0006' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Use existing health/capabilities/client-diagnostic/model-readiness APIs and S31 grant CRUD. A connection check does not pay for model qualification or mark Google readback completed. Clearly distinguish refresh/read/authorize/revoke controls.

In gemini-mcp, ERC revocation revokes ERC grants only. Google consent belongs to the external client that holds it; do not falsely claim Google has been disconnected. Do not create OAuth clients/projects or invoke endpoints of unselected drive-exchange. For missing Run/Read secrets, show the parameter name/purpose, never its value. Keep technical schema/generation/proof details here instead of cluttering Research.

## 5. Acceptance criteria

- [ ] A configured agent passes an actual scoped check; wrong actor/project cannot get a verified green state. Show observation time and the checked operation.
- [ ] Expired proof, missing credential, revoked grant, unconfigured transport, and external OAuth failure are distinct; permitted saved-report reads remain available.
- [ ] ERC revocation prevents subsequent ERC use without claiming revocation of an external OAuth session; reconnect creates no duplicate transport/backend.
- [ ] Selected/unselected-profile fixtures, accessible controls, desktop/mobile screenshots, and actual HTTP/browser tests pass.
- [ ] Record exact SHA/results with no exposed secrets or unnecessary paid checks.
