# Code integrity audit — 2026-10-08

Source baseline `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`. Additionally reviewed source PR #328 at `8e0970cfba1ada48f61ce53d858e1170c3f73be0`.

This is a bounded source audit, not implementation or a competing delivery queue. No runtime, SQL, main, deployment, provider calls or discussion comments changed. Use START-HERE/backend-delivery-plan for execution ownership. No full repository call graph or production profile was produced; absence of an indexed caller is not permission to delete a deployed class.

## C01 — P1: payload immutability is not atomic

CODE: [research-session-application.ts — persistResearchSessionRunPayload](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-runtime/src/research-session-application.ts).

`head(key).catch(() => null)` followed by unconditional `put` equates failed observation with absence. Later exact GET verifies the replacement, not the overwritten original. The HEAD/PUT pair also has no atomic absent-key condition. Lost PUT ACK exits before reconciliation.

Locally executed extracted function body with controlled R2 double: mismatched existing object + successful HEAD => CONFLICT, zero PUT; same object + HEAD error => one PUT, success, original bytes replaced. Committed PUT + lost ACK => zero GET attempts. This is not a production R2 incident reproduction.

Repair: conditional PUT `onlyIf: { etagDoesNotMatch: "*" }`, exact bounded readback on conditional conflict/lost ACK, no overwrite of incompatible bytes. Reuse the pattern from [createR2EvidenceObjectStore().putImmutable](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/platform-cloudflare/src/r2.ts), preserving existing payload metadata compatibility. Do not call writeWorkflowObject blindly: it requires an existing D1 output intent, unlike this pre-ledger payload. [Cloudflare conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations) already supply the atomic primitive.

DOCS: failure-model/workflow-checkpoints must distinguish absent/read-unavailable/conflicting-bytes/write-ACK-unknown. Result: immutable original preserved; saved result recoverable without another effect. One admission owner, coordinated with #233 but independent of ASK/BRIEF redesign.

## C02 — P2: expected hash substituted for missing observation

Same file, `persistResearchSessionRunApplication`, local `handles.digestFor`: missing checksum returns `payloadHash`, regardless of requested ref. This is expected data, not a fresh stored observation. `has` and `digestFor` separately read HEAD.

Boundary: the normal caller has just checked exact payload bytes, and portfolio/payload currently share the key. Therefore this is an unsafe adapter fallback, not a demonstrated evidence bypass.

Repair: bind to exact payload key; use actual checksum or independently hash bounded bytes; preserve unavailable/integrity failure rather than returning expected hash. Do not introduce a persistent permission cache. DOCS: distinguish expected digest, previously verified snapshot and new observation.

## C03 — P1: receipt limit also caps the persistent input object

CODE: [types.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-workflows/src/types.ts) defines receipt 65536 bytes and object output 8388608 bytes. The payload writer above and [research-protocol-freeze.ts: parsePayload](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research-branches/src/research-protocol-freeze.ts) both apply the receipt limit to query plus complete planning manifest stored in R2. [Research HTTP envelope](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/contracts/src/research.ts) is separately 262144 bytes.

Local extracted-writer example: an ASCII question yields 82095-byte HTTP JSON, but payload fails RESEARCH_INPUT_LIMIT before storage. This does not promise every input below the HTTP ceiling is valid. It proves a narrower internal envelope; full source_portfolio also consumes it. A persisted 4096-member scope is not evidence that its planning payload can launch. No universal claim that every 299-source input fails.

Repair under #291 and run-codec ownership: separate HTTP/R2 payload/planning metadata/receipt bounds. Prefer immutable planning object plus digest-bound descriptor, or an explicitly qualified bounded R2 input profile. Update writer and all consumers/version identities together; never only raise one constant. DOCS: acceptance includes freeze -> payload -> protocol freeze -> actual retrieval. Legacy runs retain their codec.

## C04 — P1: copied stream readers have different guarantees

CODE: [provider-config-rest-response.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-ai/src/provider-config-rest-response.ts), [custom-provider-rest-response.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-ai/src/custom-provider-rest-response.ts), functions readJson/readStream/cancelQuietly.

Both copies: byte-only cap, retained mutable chunks, no releaseLock, awaited cleanup before error, no body cancellation for rejected Content-Length. Common [readStreamWithinBytes/readBodyWithinBytes](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/platform-cloudflare/src/runtime-limits.ts) already has chunk count, slice-copy and finally/releaseLock; #321 addresses its separate cancellation wait.

Extracted provider reader on native Node streams: successful read leaves locked=true; reused chunk buffer yields bb instead of ab; 5000 zero-byte chunks accepted; overflow error remains pending until a controlled cancellation promise is released. Not a measured native memory leak, exploit or performance benchmark.

Also inspect [readWorkflowObject](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-workflows/src/objects.ts) and [content-store.ts: locateLines/openRange](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-evidence/src/content-store.ts): awaited cancellation persists outside #321, including a finally on successful line location.

Repair: integrate #321, reuse bounded byte-read primitives with explicit profile chunk bounds, keep domain error/effect mapping. Specialized line/hash streaming reuses cleanup, not whole-document buffering. Do not build a permissive universal JSON decoder. [Cloudflare reader primitives](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreamdefaultreader/). DOCS: one transport-reading owner; no new leaf-local copies.

## C05 — P1: frontend rejects valid large freshness responses

[readSourceRevisionFreshness](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-navigation/src/source-revision-freshness.ts) returns every changed source in the supported snapshot. [createArtifactDraftReadService.reopen](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-artifacts/src/artifact-draft-read-service.ts) forwards it. [research-run-api.ts: sourceFreshness](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/pwa-research-workspace/src/research-run-api.ts) rejects more than 64 entries.

65 actually changed sources therefore invalidate that browser response; merely having 65 project members does not. Static writer/reader mismatch, browser not executed.

Repair #291/#267: one versioned view codec, compatible member/byte limits; alternatively count + bounded sample + explicit truncation/cursor. No silent slice masquerading as full changes. Preserve historical reauthorization v2. Result: saved report remains readable with honest freshness information.

## C06 — P2: section size is checked after paid verification

[createArtifactCowSectionProducer().compileSection](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/cloudflare-research/src/artifact-cow-section-producer.ts) calls INDEPENDENT_VERIFY before encoding/comparing section_text with contract.maximum_utf8_bytes. Trusted-audit-input cardinality is also checked after the call despite depending on existing claims/pack.

Repair #233/Artifact COW owner: encode once immediately after normalization; perform local contract/claim-binding checks before extra reads/verifier call; reuse body bytes. Retain independent semantic verification, current authority checks, recorded synthesis output and attempt identity. DOCS: cheap validation before effect. No measured cost saving is claimed.

## C07 — P1: Golden gate lacks the expected case set

[Main golden.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/testkit/src/golden.ts) and [#328 golden.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/8e0970cfba1ada48f61ce53d858e1170c3f73be0/packages/testkit/src/golden.ts), assertGoldenPromotionGate: locally both accept empty results and duplicate successful case IDs. Neither can distinguish a complete one-case run from a truncated multi-case run.

Repair #285: receive expected IDs/manifest identity, require nonempty mandatory suite and exact one-to-one membership, then individual hard failures. evaluateGoldenRun handles missing observations only for the case set it is actually given. Do not treat a boolean from an external result as canonical adjudication. This is not evidence that a bad generation was promoted in production.

## C08 — P2: #328 observation-container boundary remains incomplete

adjudicateObservedUnknowns reads observed.unknowns.length before Array.isArray and has no array-cardinality cap. Missing/null can throw TypeError; a string is iterated as characters. This is an internal testkit API, not a public HTTP finding.

Repair: one bounded observation decoder before adjudication; typed missing/non-array/oversized outcomes. Do not default missing observation to empty unknowns. Allowed unknowns need not be present; required-unknown semantics must be separately explicit.

Correction to earlier audit: runCollapsingExtractor returning passed:true beside a collapse can be an intentional dishonest-producer fixture. That combination alone was not a demonstrated runtime bug. Keep an adversarial passed:true + hard-failure case after #328; an honestly failing extractor does not test that independent gate guarantee.

## C09 — P2: ResearchSession retains a second executor

[research-session.ts](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/apps/eliotr-core/src/research-session.ts), ResearchSession.execute combines identity, deployment, ledger, source authorization, handler selection, createMonotoneStageExecutor, W1 settlement and DO update in a single long method. Public run separately dispatches native RESEARCH_WORKFLOW.

Drift: start replay compares only investigation/operation/idempotency/principal, not full manifest/handler/revision/credential/deployment; execute returns cached ENGINE_COMPLETED before deployment check while read checks it. portsFor(database, operationId) never uses database: a proved dead parameter, not a durable D1 spend check. This does not demonstrate bypass of the actual W3 spend ledger.

Binding/types/tests exist; no production caller of the legacy DO-run was found in the reviewed path. External bindings and historical instances were not inventoried. Do not delete the class from search absence.

Repair #264: one execution owner, session transport over application run/status/recovery; classify retained runner active/historical/removable first. #268 formats separately. Remove unused database argument without new package. [InvestigationService](https://github.com/UnknownAlienHuman/eliot-research/blob/3e6c25660c1ae515760e19d5f9e6b8a735795c4c/packages/research/src/investigation-service.ts) is another interface-only candidate: symbol search found declaration, not implementation. Mark target scaffolding vs actual caller contract; type-only deletion is not runtime optimization.

## C10 — P2: redundant quadratic freshness membership check

source-revision-freshness.ts already reconciles each page using expected Set/delete. It then calls refs.includes(savedRevisionRef) for every collected row. Use one full Set or remove that redundant check after preserving exact page reconciliation; retain duplicate detection. No new cache, SQL batching rewrite or concurrent fan-out. Static O(N²) pattern, no production speedup measured. Owner #291.

## C11 — P2: R2 read-unavailable mapped to permanent conflict

platform-cloudflare/src/r2.ts, reconcileConditionalWrite maps every R2IntegrityError except R2_READBACK_MISSING to nonretryable IMMUTABLE_KEY_CONFLICT. Yet defaultSha256Sink can throw retryable R2_DIGEST_STREAM_UNAVAILABLE: inability to verify is not observed byte mismatch.

Repair: allowlist actual size/digest/metadata mismatches; preserve verifier/read availability errors and first cause. Do not make all errors retryable. Native missing DigestStream was not observed. Review this helper before reusing it for C01.

## Verification and boundaries

Read source paths/consumers and official R2/stream APIs. Ran extracted production function bodies with supplied dependencies on Node 22.16.0, TypeScript 5.8.3 syntax transpilation. R2 was a controlled in-memory double; streams were native Node Web Streams. No full-file Git byte verification, workspace typecheck, Vitest, browser, workerd, actual D1/R2, model/quality/cost tests or native acceptance. Source archive retrieval failed tool URL validation and then DNS; connector reads were used instead.

Implementation order: payload integrity; #291 input/response compatibility; shared reading integration after #321; COW preflight; #285/#328 gate; #264 session ownership. Preserve original acceptance criteria and code-first scoped compilation/lint, SQL depth/Clippy only for corresponding changes. Backups remain disabled. No new frameworks, registries, queues or blind deletion of old code.
