# S61 — Verify federation with an independent client and bounded ranges/cursors

Baseline: `a2aca127`; ER-22/27/41. Execution dependency: #252. Generic wire conformance does not require another client repository to be finished.

## 1. Problem

Two test endpoints using the same serializer can share the same bug. All federation operations need an independent HTTP client and byte/schema oracle.

## 2. Required change

Extend the existing integration harness with a client that imports no server services/codecs. Exercise submit/status/result/cancel, bundle manifest/range reads, and changes. Retain ERC-owned versioned wire fixtures and a separate optional ELIOT compatibility-adapter test without importing another repository's DTOs into runtime.

## 3. Documentation and exact search anchors

[Architecture, sections 11 and 19.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'ERC29-DEC-012' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Use native fetch/JSON with independently retained expected fields/bytes and adversarial mutations. Check authenticated principal/issuer/audience, request/bridge generations, current client fence, AllowedReferenceManifest, listed verifiers/tools, disclosure, and retention. Bind cursors to principal/job/scope/revision and ranges to canonical length.

Invalid ranges, expired cursors, corrupt/truncated R2 objects, and unsupported load-bearing fields return typed refusal, not empty success. Exercise declared reauthentication/credential-rotation compatibility without unpinning bridge generations to pass tests. Timeouts reconcile the same job. Optional leaf-adapter mappings preserve disposition and evidence lineage. An unselected peer does not block generic local tests, but missing selected-peer qualification cannot count as passed.

## 5. Acceptance criteria

- [ ] All operations pass through the actual local Worker/D1/R2 using the independent client.
- [ ] Forged/out-of-scope/verifier-substitution and purge-during-stream cases prevent forbidden disclosure.
- [ ] Dispositions are no stronger than internal results; synthesized text remains candidate output.
- [ ] Lost ACK, cursor recovery, and restart neither lose nor duplicate jobs; intentional server-encoding defects are caught independently.
- [ ] After authorized staging, record a separate mutually authenticated deployed-peer run with exact receipts. Local fixtures are not live qualification.
