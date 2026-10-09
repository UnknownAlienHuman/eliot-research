# Native external-task wait integration

Source mapping checked October 9, 2026 against the shared main checkout. This is
the implementation sequence for [#326](https://github.com/UnknownAlienHuman/eliot-research/pull/326)
and donor playbook B7, not native acceptance or an owner-decision blocker.
Historical runs and their manual recovery path remain compatible.

## Existing authority and integration seams

- ER-09 owns `cloudflare-workflows` and the research Workflow application. The
  integrator separately coordinates the callback, Worker Queue and any SQL
  handoffs; a handler-local patch cannot complete this cutover.
- `research-external-branch-analysis.ts:executeOrRecover` already validates
  grant/route/current scope, publishes exact task payload and task row, reads
  the recorded result, and uses `consumeResult` for exact evidence readback.
  Missing immediate result currently produces `WORKFLOW_EFFECT_UNCERTAIN`.
- `research-workflow-step-execution.ts` calls the W2 executor inside an outer
  `step.do`. `WorkflowStageHandler` receives request/principal/input/attempt/
  budget/signal; it has no native `step`. The new topology must durably prepare
  the same W2 attempt/task, wait at the Workflow orchestration level, then settle
  through the existing known-result executor. Do not inject an invented handler
  field or assume nested native steps are supported.
- `ExternalAgentTaskStore.recordResult/#reconcileResult` commits and reads the
  exact immutable result before returning its receipt. The event's
  `result_digest` must bind the stored `result_sha256`; it is a locator hint,
  not evidence, completion or grant authority.
- `readRecordedResultReadback` now returns the existing strictly decoded result
  together with its original stored `result_sha256`, preserving the schema gate
  and exact binding validator. It rejects foreign tuple components and
  noncanonical bytes. The old result-only API remains compatible. Currentness,
  grant, route, cancellation and settlement checks still belong to the consumer;
  the structural reader does not establish those permissions.
- The new-generation callback reuses `prepareIntentWithOutboxMutation` in the
  same batch as the canonical result UPDATE. Hashes are computed before the
  batch; migration 0131 fences the existing intent/outbox inserts against the
  exact recorded result and 0130 settlement authority. Final-insert failure
  rolls back the result; absent/replaced/expired leases cannot leave an orphan
  wake. Reconciliation checks the original saved digest/timestamp and exact
  outbox readback after validating result bytes, including after a lost ACK.
  Legacy generations retain the original callback path. Seven focused cases,
  exact source review, compile/lint and depth-100 actual Core schema/owning
  query compilation pass; the focused fixture supplies upstream currentness
  explicitly, so native callback/Queue acceptance remains pending.
- The branch adapter now separates `prepareTask` from `readRecordedResult`.
  Its legacy handler/recovery sequence remains compatible; read-only consumption
  returns null for an absent result without publishing a task. The expected digest
  is checked against original stored-byte readback before existing `consumeResult`.
  The W2 executor's separate preparation seam uses the same durable attempt and
  original deadline, returning WAIT, SETTLE or a committed receipt for orchestration.
  These source-accepted ports do not activate the native topology.
- `native-external-task-step.ts` provides deterministic sibling prepare, wait
  and settle steps with strict persisted metadata and receipt validation. WAIT
  visits the cached wait step on resume; a transport error permits one canonical
  reread, and foreign/malformed events fail. Its exact source review,
  compile and lint pass. The helper is still unimported; it supplies no new
  result, grant or budget authority and does not qualify native execution.
- `handleScheduled` delivers existing outbox messages through `JOB_QUEUE`.
  `handleQueue` currently composes only the projection delivery handler. A wake
  topic needs explicit dispatch and canonical result/currentness readback before
  `RESEARCH_WORKFLOW.get(operation_id).sendEvent`. Queue/inbox deduplication
  accelerates delivery and never substitutes for canonical task/result identity.

## Lease and timeout composition

The current model-stage W2 lease is capped at 600,000 ms by the runtime duration
adapter and executor. Migration 0085's `research_external_agent_task_current`
requires that lease to remain current; its update guard also caps task leases by
both grant expiry and W2 budget expiry. The payload's separate maximum lifetime
does not extend callback authority.

When the W2 budget has expired, `WorkflowCheckpointStore.requireRecoveryAuthorization`
and the checkpoint guard require `research_workflow_recovery_authorized`. Its
current definition in migration 0105 depends on the existing recovery intent and
checkpointed/succeeded action. `recoverResearchRun` returns early for active
native states before creating that action. Calling the compatibility recovery
API while the new Workflow is waiting therefore does not establish an expired
attempt's settlement authority.

Migration 0130 preserves that exact legacy predicate and adds a separate native
known-result settlement view for `research-handlers.exploratory.external-wait.v1`.
It requires the current active run/grant/project scope and exact stage-8 tuple,
with the recorded timestamp strictly before both original lease and budget expiry.
The existing output/checkpoint fences still own the ledger mutation. Its depth-100
schema and focused view-predicate checks pass; native integration/currentness,
exact result consumption and delayed-wake acceptance remain pending. The new
generation is not yet admitted or selected by runtime composition.

The migration must explicitly handle a result committed before expiry whose
wake is delayed across expiry. Preserve current grant/route/scope/cancellation
checks and the distinction between settling a known result and authorizing a
new external effect. Do not extend a budget, bypass the SQL fence, mint a
financial permission from a digest, or invoke a native restart as the normal
wake path. Missing result at timeout remains unconfirmed; reread it exactly once
before choosing the documented versioned timeout behavior. Native wait must not
create a new logical task or automatically repeat UNKNOWN external dispatch.

## Locator and topology prerequisites

The prepared internal locator has exactly protocol/version, task ID, operation
ID, stage index, attempt reference, request SHA-256 and result digest. Event type
must include the complete operation/stage/attempt/request identity through an
unambiguous full SHA-256 preimage, fit the native type bound, and be available
before the result exists. No result body, excerpt, provider payload or secret
belongs in the event.

Introduce one persisted handler generation and deterministic prepare/wait/settle
step names together with admission, handler selection and recovery compatibility.
Existing generations retain their old step graph. On resume, validate the
persisted kind, generation, stage, locator, deadline, operations and bounds again;
return state from durable steps rather than depending on in-memory mutations.

Cloudflare's current documentation was retrieved on October 9; the Rules of
Workflows page is dated October 8, 2026. The documented event type maximum is
100 characters; an event sent after instance creation but before its matching
wait is buffered. The rules require deterministic names and warn that effects
outside durable steps can repeat. No retrieved passage establishes that nested
steps are supported.

References: [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/),
[events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/),
[Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).

## Remaining acceptance

Source codec checks alone are preparatory. The coherent implementation still
requires native early/duplicate/late/foreign events, lost result/send ACK,
event-before-result, timeout/result-boundary, restart/completed-predecessor,
revoked/cancelled authority, old generation and malformed persisted event cases.
The new path must retain exact `consumeResult` and W2 settlement. Live/staging and
release receipts remain pending. No #326, Issue, PR or Goal closure follows from
this mapping or the locator pair.
