# ER-36: Gemini Spark / Antigravity MCP and Google orchestration

**Slice:** 0–1 bridge
**Depends on:** ER-17, ER-18, ER-20, ER-21, ER-24, ER-26
**Live gate:** the selected authentication profile must have deployed Access
initialize/tools/list/tools/call plus its own exact readback receipt: signed Client ID for `service-token`,
or the managed OAuth client flow with its dedicated audience for `managed-oauth`. The default Workspace profile
qualifies Drive/Docs/Sheets/Slides/Gmail/Calendar; Google Cloud/gcloud is an independent optional
profile. A missing optional profile is `NOT_EXECUTED`, not a Drive blocker.

## Objective

Expose a minimal, read-only ELIOT MCP surface to Gemini Spark and Google Antigravity and define the
safe client orchestration boundary. The active client profiles use Spark Connected Apps or Antigravity
project-local MCP configuration; the retained Gemini CLI installer is legacy and unselected. Do not
create a reverse authority channel and do not let a Google transport result promote itself into ELIOT state.

## Owned paths

- `packages/cloudflare-workspace-mcp/**`
- `integrations/gemini-spark/**`
- `integrations/antigravity/**`
- `docs/implementation/gemini-spark-mcp.md`
- `apps/eliotr-core/src/http-special-routes.ts`
- `apps/eliotr-core/src/composition-root.ts`
- `apps/eliotr-core/src/index.test.ts`
- `apps/eliotr-core/test/google-oauth-begin-http.test.ts`
- `apps/eliotr-core/test/google-oauth-callback-http.test.ts`
- `scripts/check-launch-code.mjs`
- `scripts/test-launch-code.mjs`
- `scripts/deploy-cloudflare.mjs`
- `scripts/lib/deployment-verification.mjs`
- `scripts/test-deployment-verification.mjs`
- `scripts/test-deployment-orchestration.mjs`
- `scripts/test-deployment-apply-ordering.mjs`
- `docs/adr/0006-google-external-transport-profiles.md`
- `docs/implementation/implementation-status.json`

## Shared integration paths

- `apps/eliotr-core/src/index.ts` — ER-24
- `apps/eliotr-core/src/env.ts` — ER-24
- `apps/eliotr-core/wrangler.jsonc` — ER-24
- `package.json` — ER-00

The package exposes a narrow runtime interface and receives readiness through an injected callback.
It imports no core application module. ER-17 owns the shared `@eliotr/cloudflare-access` verifier;
the Worker keeps the same `/mcp` route and passes its existing configuration into this library.
Root integrates package manifests, TypeScript references, dependency boundaries, CI and lockfile.

## Acceptance

- only the configured Cloudflare Access service-token Client ID reaches JSON-RPC dispatch in the
  `service-token` profile; the `managed-oauth` profile admits only a verified human Access identity
  through its dedicated audience;
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
- the retained Gemini CLI setup is atomic, idempotent, secret-free, and pins reviewed extension refs;
- the active Antigravity setup creates only a disabled, no-secret project-local template, preserves
  unrelated MCP servers, refuses conflicts, and never installs a client or extension;
- the Spark profile documents URL-based Connected Apps separately from the Antigravity profile;
- the default Workspace profile does not provision or require a Google Cloud project, Cloud OAuth
  client, Vertex route, or Gemini API key; gcloud is explicit opt-in;
- Drive Exchange and Gemini direct orchestration cannot simultaneously own the transport.
- the validated `GOOGLE_EXTERNAL_TRANSPORT` profile selects the applicable gate; unknown, mixed and
  explicitly disabled deployment profiles fail closed, and no launch-check argument can override it;
- `MCP_ACCESS_AUTH_PROFILE` selects `service-token` or `managed-oauth`; managed-oauth uses the existing
  signed Access verifier, a dedicated audience and a domain-separated hashed actor binding, while
  rejecting service-token credentials and mixed profile configuration;
- `gemini-mcp` retains a pending authenticated Workspace candidate-admission/readback gate, while
  `drive-exchange` retains the server-owned legacy OAuth/Exchange gate; common product gates are unchanged;
- legacy Google OAuth routes reject requests unless `GOOGLE_EXTERNAL_TRANSPORT=drive-exchange`.

## User scope decision — 2026-09-09

The active user scope is Google Drive/Workspace through Gemini Spark Connected Apps or Google
Antigravity MCP. ELIOT configures and validates the bounded MCP plan/receipt surface; the selected
client owns the Google action. Google Cloud/gcloud and Google AI Studio/Gemini API are optional future contours and remain
unimplemented unless separately selected and qualified. The unfinished server-owned ChatGPT Drive
Exchange is a separate legacy product path, not authorization or a prerequisite to create a Google
Cloud project/client for this Workspace profile.

## Mandatory negative boundary

For the `service-token` profile, request `dry_run=false`, send a browser Origin, use an owner JWT, present
the token name instead of the configured Client ID, and present a Google readback with a different payload
digest. The server must deny the first four and return `OBSERVED_MISMATCH` for the last without changing
canonical ELIOT state. For `managed-oauth`, a valid human JWT with the dedicated audience is accepted and
an ordinary-audience JWT or service-token JWT is denied.
