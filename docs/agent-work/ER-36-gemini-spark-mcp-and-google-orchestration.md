# ER-36: Gemini Spark MCP and Google orchestration

**Slice:** 0–1 bridge
**Depends on:** ER-17, ER-18, ER-20, ER-21, ER-24, ER-26
**Live gate:** deployed Access service-token initialize/tools/list/tools/call plus disposable Google
Workspace and gcloud action/readback; otherwise `NOT_EXECUTED`

## Objective

Expose a minimal, read-only ELIOT MCP surface to Gemini Spark / Gemini CLI and define the safe
orchestration boundary for official Google Workspace and gcloud extensions. Do not create a reverse
authority channel and do not let a Google transport result promote itself into ELIOT state.

## Owned paths

- `apps/eliotr-core/src/gemini-mcp.ts`
- `apps/eliotr-core/src/gemini-mcp-protocol.ts`
- `apps/eliotr-core/src/gemini-mcp-tool-common.ts`
- `apps/eliotr-core/src/gemini-mcp-google-sync.ts`
- `apps/eliotr-core/src/gemini-mcp-tools.ts`
- `apps/eliotr-core/src/gemini-mcp.test.ts`
- `integrations/gemini-spark/**`
- `docs/implementation/gemini-spark-mcp.md`

## Shared integration paths

- `apps/eliotr-core/src/index.ts` — ER-24
- `apps/eliotr-core/src/env.ts` — ER-24
- `apps/eliotr-core/wrangler.jsonc` — ER-24
- `package.json` — ER-00

## Acceptance

- only the configured Cloudflare Access service-token Client ID reaches JSON-RPC dispatch;
- the external Client ID is mapped to the internal logical principal `gemini-spark` only after exact
  signed JWT verification;
- a human-readable token name cannot substitute for the signed Client ID in `common_name`;
- MCP 2025-06-18 initialization and protocol-header enforcement work without server session state;
- tool discovery exposes exactly four product-level tools;
- ELIOT MCP cannot select providers, models, databases, buckets, indexes, credentials, or arbitrary URLs;
- no ELIOT tool can directly mutate Google;
- mutating Google plans require confirmation and exact readback;
- a valid transport receipt remains candidate-only;
- the setup script is atomic, idempotent, secret-free, and pins reviewed Google extension refs;
- Drive Exchange and Gemini direct orchestration cannot simultaneously own the transport.

## Mandatory negative boundary

Request `dry_run=false`, send a browser Origin, use an owner JWT, present the token name instead of the
configured Client ID, and present a Google readback with a different payload digest. The server must deny
the first four and return `OBSERVED_MISMATCH` for the last without changing canonical ELIOT state.
