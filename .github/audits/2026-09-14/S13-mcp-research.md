# S13 — Thin Research tools in the existing MCP server

Baseline: `a2aca127`; finding F09. Dependencies: S11/#203 and S12/#204 provide the working service API.

## 1. Problem

The current MCP surface exposes status/diagnostics and Google candidate plans, not a complete Research workflow. A successful connection check does not establish that an agent can work with the corpus.

## 2. Required change

Add minimal adapters for the authorized project catalog, query/run/status, and report/citation reads. They expose existing application operations; they are not another backend or a separate transport service.

## 3. Documentation and exact search anchors

[Architecture, sections 1.1 and 0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md); [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md).

```sh
git grep -n -F 'private agent MCP' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'GEMINI_MCP_TOOLS' -- packages/cloudflare-workspace-mcp/src
```

## 4. Implementation approach

Use the existing JSON-RPC dispatcher and verified actor context. Delegate handlers to the same application services used by HTTP. Long-running operations return a handle; status is read separately. The catalog needs real scoped authorization, not removal of `MCP_CATALOG_SCOPE_REQUIRED`. Preserve Google candidate semantics. Define tool names and schemas once in the existing contract and derive their behavior from the corresponding application DTOs; annotations must reflect actual side effects. Keep the later S32 control tools in this same namespace/dispatcher.

## 5. Acceptance criteria

- [ ] initialize → tools/list → scoped catalog → run → status → report → citation works headlessly.
- [ ] HTTP and MCP return the same durable IDs, hashes, and dispositions for the same logical request.
- [ ] Read-only tools invoke no model; run is not marked readOnly. Malformed, foreign, and revoked inputs fail.
- [ ] Retrying after a lost response creates no second run.
- [ ] One MCP server remains; clients need no browser cookies or provider keys. Record exact tests/SHA and secret-free request examples.
