# Selective /agents routing — local acceptance, 2026-10-10

Issue: [#333](https://github.com/UnknownAlienHuman/eliot-research/issues/333).
Local routing acceptance: **PASS**. Live/staging readback: **PENDING**.

The exact integrated Worker/config/client pair was produced from published
`053112190807449f44437c65a958241035dd9b52`. The native run started
`2026-10-10T21:43:22.768Z` and ended `2026-10-10T21:44:01.811Z`; PID 72756,
exit 0, no process error or signal. All fourteen required cases passed.
The later frontend source at `4d0d8a46796d37bd0ecffc8d4ef585a9bdc642ad`
is a separate artifact frontier and has no implied integrated qualification.

## Scope and issue criteria

Input Wrangler and the actual Vite-generated configuration contain the exact
nine selective rules, including `/agents` and `/agents/*`; no global
`run_worker_first: true` is used. Native conversion retains the user Worker,
the three original emitted ESModules and SPA handling. Ordinary root, index,
emitted JS/CSS and navigation fallback retain the produced static bytes.

Unknown `/agents` and `/agents/*` requests with
`Sec-Fetch-Mode: navigate` return bounded Worker JSON 404 instead of SPA HTML.
Authenticated history reaches the real Session DO and returns the existing
410 gate. A current signed local Access JWT establishes HTTP 101; read-only
projection RPC returns through the actual ResearchSession class. Missing,
foreign and stale authority and wrong methods retain their asserted status,
JSON media, no-store, nosniff and CSP policy. The selected Core run/grant and
original Work object readback is unchanged; this is not a whole database audit.

Source parity, changed-source syntax, scoped lint and existing focused Session
verification were retained. The R2 source precheck passed eight syntax files
and eighteen paired pins without creating Miniflare. The single native run used
Miniflare `5.20260926.1-alpha`, Wrangler
`4.143.1`, Node `v25.6.1`.
Scoped published routing/config `git diff --check` passed.

| Case | Result | Observation |
| --- | --- | --- |
| ordinary-static-index | 200 | exact artifact/policy assertions passed |
| ordinary-static-root | 200 | exact artifact/policy assertions passed |
| ordinary-emitted-assets-js-and-css | 200 | exact artifact/policy assertions passed |
| unknown-navigation-spa-fallback | 200 | exact artifact/policy assertions passed |
| selective-agents-worker-first | 404 | ROUTE_NOT_FOUND |
| selective-agents-root-worker-first | 404 | ROUTE_NOT_FOUND |
| agents-missing-auth | 401 | ACCESS_JWT_MISSING |
| agents-method-not-allowed | 405 | METHOD_NOT_ALLOWED |
| agents-foreign-authority | 404 | exact artifact/policy assertions passed |
| generated-worker-do-get-messages | 410 | SESSION_CHAT_HISTORY_DISABLED |
| authenticated-native-http-projection-gate | 410 | SESSION_PROJECTION_PROTOCOL_REQUIRED |
| stale-native-websocket-authority | 409 | RESEARCH_AUTHORITY_STALE |
| authenticated-native-websocket-upgrade | 101 | exact artifact/policy assertions passed |
| generated-worker-do-session-projection-rpc | read-only RPC | read-only projection returned through the real ResearchSession Durable Object |

## Exact evidence

- Worker entry SHA256: `79b59c9d4f030b4e2f687e09fda0681bbe01b9bfb06024b726dad8b7c6701cf2` (7735819 bytes).
- Generated config SHA256: `a1464b4127a595a0eb1243c2ac1e75729741b4669251b5b57fe58a321867c36e`.
- Client index SHA256: `e913b890dea2134c5380ae5b978c3ca413bc1712f538f3a53b71d1b2801ac4f4`.
- Native proof SHA256: `8a3699fcd242b6e23f5d8f93307fd202469e704d2f73259b24a6bc0fd904f208`.
- Process receipt SHA256: `7ac9c6f343d4112f5e2a6f5b46b61920274026795cd357062ef025089465203a`.
- Frozen R2 source SHA256: `c26b3a46d8674f554e951363f8ce83787aaa0ed61c3cdd4c718008719729ce29`.
- Independent source/root binding SHA256: `4ae4f1328b263473e690138c702c5f32a73d53f9faf04a5ed09f1ac4b3f56cee`.
- Upload measurement SHA256: `693b9bf1959752c8d146b452c278b0749869bd5ec0927dedb5813d274e02d70e`; original no-bundle upload raw 7,972,541 bytes / gzip 1,580,051 bytes.

The local evidence directory is
`.eliotr-state/backend-full-20261008/session-policy-integrated-routing-oracle-r2-root-20261010`.
The earlier failed run and reports remain intact. Its one wrong stale-token
oracle expected SESSION_AUTHORITY_STALE; the existing preflight Research
authority returns RESEARCH_AUTHORITY_STALE409 before SDK routing. R2 changes
only that exact expected literal, preserving strict409 and all policy assertions.
The production Session JSON header repair is already published in the tested53
source; R2 changes no production API, schema, config, build or emitted artifact.

## Remaining qualification

Issue #333 explicitly permits live/staging readback to be left PENDING.
No deployment, account mutation or remote provider operation was performed.
Current frontend pairing, browser/reconnect, release and full-project acceptance
remain separate. Complete filesystem input closure, global network closure and
native descendant cleanup were not established. Goal remains ACTIVE.
