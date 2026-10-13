# ResearchSession projection: local emitted-browser acceptance

- **Date:** 2026-10-13
- **Result:** `PASS_LOCAL_EMITTED_WORKER_BRANDED_CHROME_ONLY`
- **Run:** `8b1530a8-c3c5-4104-b2a6-c00d4868228e`
- **Receipt:** [original qualification JSON](../../../../.eliotr-state/research-session-projection-emitted-browser/8b1530a8-c3c5-4104-b2a6-c00d4868228e.json), SHA-256 `8d423bd2c12d1ccaa54443bace1371079259803855ee97c3ff1a5a774ade6d26`. Its bytes are preserved.

This is one local emitted-runtime qualification. The retained Worker graph from `release-7e4668ad` ran without a rebuild, with real D1 migrations, local R2, the actual `RESEARCH_SESSION` Durable Object, and a seeded investigation/scope/grant/run prepared through `prepareHistoricalV2Workflow` and `/session/start`. The product runtime source is `d4cdb8bf9adc0915920f898711473dd7e8594a21`; emitted Worker SHA-256 is `09fa55cc549ec0390fca32fd29b89354120919de8f9ea891a08502d586ac59d5`, and emitted graph SHA-256 is `8ec18c18e7da05552e705e5af9d92fcb941715fa31421a3db3f14c267a42034c`.

Branded Google Chrome used the official owner API adapter and `agents/client` against `/agents/research-session/<session>`. The real Worker/DO route returned the expected initial HTTP 410 `SESSION_PROJECTION_PROTOCOL_REQUIRED`; the browser then established the supported WebSocket/RPC projection on that route. Repeated snapshots, disposal/reconnect, two tabs with the peer remaining usable, and canonical HTTP reconciliation all passed. Reconciliation returned HTTP 200 with the same operation/workflow ID and `ACTIVE` execution state. Disposal closed cleanly with code 1000 and reason `owner-client-disposed`.

D1’s 211 tables and 49 rows retained the same before/after digest. The 390-byte R2 input retained the same digest. The stable Durable Object snapshot was unchanged; the sole allowed delta was `research-session-chat-binding:v1` connection metadata (0 to 1 entry). Workflow reads were 1 before and 22 after; `Workflow.create` remained 0. Provider execution was `NOT_RUN`, remote effects were 0, and the browser made no non-loopback requests. The ephemeral JWKS verifier was loopback-only. Miniflare and Chrome were disposed and port 6172 was released. The runner PID/Miniflare host PID was 32332 and Chrome PID was 131092; Miniflare did not expose a separate Workerd PID.

## Test-only boundaries

The qualification Worker wrapper reads the test `CF_Authorization` cookie and maps that value to `cf-access-jwt-assertion` before forwarding to the emitted Worker (`worker-entry.mjs:73-79, 140-144`). This is a local cookie adapter; it does not qualify public Cloudflare Access ingress. The wrapper also controls Workflow status: `get()` returns `waiting`, while `create()` throws and increments a counter (`worker-entry.mjs:82-96`). The observed projection therefore proves the real emitted Worker and Durable Object read path under this controlled status seam; it does not prove provider execution or Workflow progression. The diagnostic endpoints and binding injection are harness-only.

## Versions and dependency record

The retained receipt records Node `v25.6.1`, Miniflare `5.20260926.1-alpha`, and Chrome `155.0.8059.40`. It omits Playwright from its `browser` object even though the current runner reads and reports `playwright_core_version` (`qualify.mjs:431-436`). The linked [dependency attestation](./DEPENDENCY-ATTESTATION-20261013.json) records `POST_RUN_VERIFIED` for `playwright-core@1.63.0` from the runner’s projection-worktree module resolution, with the resolved path and package/manifest/lock hashes. The receipt does not establish the exact module path during execution, so that historical field remains `UNKNOWN`.

The harness delivery commit is `2cdf56b41f012106418e88a6fdaa009253335cac`; it contains the qualification harness. The receipt identifies the emitted product source and emitted-byte hashes, not an in-run harness tree hash.

Staging/live, public Access ingress, provider execution, production deployment, and whole-product release gates were `NOT_RUN`. This note does not claim full release acceptance. #334 remains pending root readback of this note, the linked attestation, and the preserved receipt; the owner authorized closure after that readback.
