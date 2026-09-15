# S14 — Confirmed cancellation of an ordinary Research run

Baseline: `a2aca127`; ER-09/21/24. Proposed API, not an existing endpoint. Do not change EXHAUSTIVE_JOB cancellation.

## 1. Problem

Closing a tab or calling an internal DO cancellation method does not provide a complete public research.run cancellation lifecycle. Native engine termination is not the canonical cancellation decision.

## 2. Required change

Add POST `/api/v1/research/run/:workflow_id/cancel` with the existing Idempotency-Key header and an empty JSON body `{}`; reject unknown fields. Target identity is path+verified principal+action+key. Return existing ResearchRunStatus with HTTP 200 only after persisted CANCELLED; return HTTP 409 if canonical ENGINE_COMPLETED already won, and retryable HTTP 503 when settlement is unconfirmed. Existing GET status is the reconciliation path. Repeating cancellation of an already CANCELLED run returns 200 without new effects. Do not add a CompletionDisposition value.

## 3. Documentation and exact search anchors

[Architecture, sections 7.7.2 and 7.11](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'Each stage checks cancellation and budget' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F '## 7.11. Terminal dispositions and reopen' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

ROUTES/HTTP/the Research service use existing monotone executor.cancel and W2 receipt readback. Do not add a second cancellation ledger when current authority already records the outcome. Access requires the run's owner or an explicit cancel delegation under #202. Foreign and nonexistent runs share the same 404 behavior; malformed body is 400 and revoked authorization is 403 under the existing error policy.

D1 serializes cancel versus completion; the winning terminal outcome is immutable. After canonical CANCELLED, attempt native termination and retain safe diagnostics. A native timeout does not undo a confirmed D1 outcome. If the D1 acknowledgement is lost, read back the same receipt before claiming cancellation. Late model output may be retained for attempt accounting, but cannot publish or start a subsequent stage. Check canonical cancellation before each dispatch.

S15/#207 uses the adjacent POST `/api/v1/research/run/:workflow_id/recover` with the same empty-body/idempotency/status conventions. Recovery is denied after canonical cancellation. Neither endpoint creates a replacement run. S32 provides UI/MCP controls over these same operations.

## 5. Acceptance criteria

- [ ] Before-start, between-stage, and in-flight-model cancellation returns 200 with persisted CANCELLED and prevents new provider effects. Do not claim an already dispatched call was physically stopped without proof.
- [ ] Completion-first returns 409; cancellation-first remains CANCELLED. Replay/restart/lost ACK creates no duplicate cancellation effect and cannot revive the run.
- [ ] GET status agrees with the durable outcome; native termination failure does not erase canonical cancellation.
- [ ] Foreign, expired, revoked, and CSRF requests fail before effects. A body-supplied principal is rejected as an unknown field, not silently ignored.
- [ ] Record actual local HTTP/D1/R2 race tests, exact SHA, commands, and results. Native termination is separately checked on an authorized live target.
