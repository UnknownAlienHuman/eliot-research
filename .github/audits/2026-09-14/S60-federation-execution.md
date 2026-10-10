# S60 — Execute authorized work after federation submission

Baseline: `a2aca127`; ER-22/41/24. federation-service.ts already provides reservation/read/cancel and manifest/bundle/change interfaces. Do not call all seven operations fictitious; complete and demonstrate their execution side.

## 1. Problem

An accepted job and implemented storage ports do not prove execution of research.pack/run/report. External transport completion must not strengthen the internal research disposition.

## 2. Required change

Connect existing federation reservation/outbox → dispatcher → existing retrieval/Research executor → immutable evidence/result bundle → terminal receipt → status/result/range reading. Cancellation must reach the canonical run, not only update transport status. No new Workflow engine or dependency on the client's database.

## 3. Documentation and exact search anchors

[Architecture, sections 11–11.1 and 19.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 11.1. Execution choices' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 19.11. Federation' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse FederationSubmission/AuthorityBinding, D1 jobs/manifests, and R2 bundle stores. Settle job/outbox atomically; duplicate delivery reconciles one deterministic execution identity. Pin requester/server/bridge/client fence/scope/disclosure/retention in the manifest. A URL or authenticated connection alone is not source authorization.

research.pack does not perform unnecessary synthesis; any required audited-pack procedure remains explicit. Reuse common delegated query/run authorization where appropriate, but do not replace federation-specific fences/manifests with a generic project grant. Return model output as synthesis_candidate without mutating the client's canonical memory. Transport state and the existing nine CompletionDisposition values are independent; preserve cancellation, partial results, and uncertainty. Distinguish missing configuration from missing implementation.

## 5. Acceptance criteria

- [ ] Independent HTTP submission against admitted sources executes a real internal job whose result references/bytes/disposition agree with the returned bundle.
- [ ] Duplicate/lost submit ACK, Queue redelivery, and restart do not duplicate work.
- [ ] Cancellation/completion races and revoked manifests remain safe.
- [ ] A source-only pack incurs no synthesis charge; the public result is no stronger than the internal outcome.
- [ ] Record actual D1/R2/executor tests and exact SHA. Independent live-peer qualification is handled by S61 and final acceptance.
