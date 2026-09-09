# ER-36: Gemini Spark MCP and Google orchestration

**Slice:** 0–1 bridge
**Depends on:** ER-17, ER-18, ER-20, ER-21, ER-24, ER-26
**Live gate:** the selected profile must have deployed Access service-token
initialize/tools/list/tools/call plus its own exact readback receipt. The default Workspace profile
qualifies Drive/Docs/Sheets/Slides/Gmail/Calendar; Google Cloud/gcloud is an independent optional
profile. A missing optional profile is `NOT_EXECUTED`, not a Drive blocker.

## Objective

Expose a minimal, read-only ELIOT MCP surface to Gemini Spark / Gemini CLI and define the safe
orchestration boundary for the official Google Workspace extension, with optional gcloud support. Do not create a reverse
authority channel and do not let a Google transport result promote itself into ELIOT state.

## Owned paths

- `apps/eliotr-core/src/gemini-mcp.ts`
- `apps/eliotr-core/src/gemini-mcp-protocol.ts`
- `apps/eliotr-core/src/gemini-mcp-tool-common.ts`
- `apps/eliotr-core/src/gemini-mcp-google-sync.ts`
- `apps/eliotr-core/src/gemini-mcp-tools.ts`
- `apps/eliotr-core/src/gemini-mcp.test.ts`
- `apps/eliotr-core/src/gemini-mcp-service-token.test.ts`
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
- tool definitions retain four product-level contracts, but real discovery exposes only authorized implementations;
- `eliotr_catalog` stays withheld until an explicit service-scope read-policy adapter exists; direct calls fail before D1;
- ELIOT MCP cannot select providers, models, databases, buckets, indexes, credentials, or arbitrary URLs;
- no ELIOT tool can directly mutate Google;
- mutating Google plans require confirmation and exact readback;
- a valid transport receipt remains candidate-only;
- the setup script is atomic, idempotent, secret-free, and pins reviewed Google extension refs;
- the default setup profile is Workspace-only and does not provision or require a Google Cloud
  project, Cloud OAuth client, Vertex route, or Gemini API key; gcloud is explicit opt-in;
- Drive Exchange and Gemini direct orchestration cannot simultaneously own the transport.

## User scope decision — 2026-09-09

The active user scope is Google Drive/Workspace through Gemini Spark MCP. ELIOT configures and
validates the bounded MCP plan/receipt surface; the external Workspace extension owns the Google
action. Google Cloud/gcloud and Google AI Studio/Gemini API are optional future contours and remain
unimplemented unless separately selected and qualified. The unfinished server-owned ChatGPT Drive
Exchange is a separate legacy product path, not authorization or a prerequisite to create a Google
Cloud project/client for this Workspace profile.

## Mandatory negative boundary

Request `dry_run=false`, send a browser Origin, use an owner JWT, present the token name instead of the
configured Client ID, and present a Google readback with a different payload digest. The server must deny
the first four and return `OBSERVED_MISMATCH` for the last without changing canonical ELIOT state.
