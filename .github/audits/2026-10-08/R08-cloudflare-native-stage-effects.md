# R08 — Cloudflare-native stage effects

Date: 2026-10-08  
Source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`  
Scope: backend only. This is an implementation passport, not a runtime patch.

## 1. Problem

The production Research path already runs each canonical stage inside Cloudflare Workflows:

```ts
step.do(stepName, { retries: { limit: 0, delay: 0 }, timeout }, executeStage)
```

Inside that native step, `createWorkflowCheckpointExecutor` implements another general-purpose execution engine for every stage:

```text
ensure run
→ reserve attempt
→ budget lease
→ STARTED state
→ execute handler
→ record output descriptor
→ write R2 object
→ commit stage receipt
→ recovery/readback
```

The extra boundary is necessary for a model/provider/computer action whose external effect can succeed without a confirmed response. It is not automatically necessary for deterministic computation, authorized reads, or a write that already has a provider-supported idempotency/CAS/readback contract.

Current code disables native retries for all 18 stages, even though Cloudflare Workflows already provides durable step replay, bounded retries, timeouts, dynamic retry delay functions and `waitForEvent`.

This creates three costs:

1. Two durable execution abstractions must agree on stage identity, retry, timeout, recovery and terminal state.
2. Safe stages pay D1/R2/lease/readback complexity designed for uncertain external effects.
3. Every new handler tends to inherit `WORKFLOW_EFFECT_UNCERTAIN`, even when its actual operation never left Eliot-controlled storage.

This PR must reduce those duplicate semantics without weakening exact evidence, authority, first-cause or external-effect safety.

## 2. Existing code to read first

Required project documentation:

```text
docs/START-HERE.md
docs/implementation/backend-delivery-plan.md
docs/implementation/failure-model.md
docs/implementation/scoped-verification.md
docs/implementation/workflow-checkpoints.md
docs/architecture/ELIOT_RESEARCH.md §§7.7–7.9
```

CODE entry points:

```text
packages/domain/src/investigation.ts
  RESEARCH_WORKFLOW_STAGES

packages/cloudflare-workflows/src/research-workflow-step-execution.ts
  executeResearchWorkflowNativeSteps
  createResearchWorkflowServerPorts

packages/cloudflare-workflows/src/executor.ts
  createWorkflowCheckpointExecutor
  createMonotoneStageExecutor

packages/cloudflare-research-runtime/src/research-stage-handlers.ts
  createResearchStageHandlerFactory
  recoverStartedAttempt wiring

packages/cloudflare-research-runtime/src/research-workflow-application.ts
apps/eliotr-core/src/research-workflow.ts
apps/eliotr-core/src/research-session.ts
```

Read the actual handler implementations before assigning an effect class. A stage name is not proof of its effects.

## 3. Cloudflare owns the generic workflow runtime

Use native Cloudflare Workflows for:

- durable step checkpoints;
- replay of completed step results;
- bounded retry count;
- static or dynamic retry delays;
- step timeout;
- sleep/scheduling;
- waiting for an external event;
- Workflow instance status and lifecycle.

Official references checked for this task:

- [Workflows](https://developers.cloudflare.com/workflows/)
- [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
- [Dynamic retry delays, 2026-07-09](https://developers.cloudflare.com/changelog/post/2026-07-09-dynamic-retry-delays/)
- [Wait for events](https://developers.cloudflare.com/workflows/build/events-and-parameters/)

Do not build a second generic scheduler, timer, retry queue, wait loop or opaque Workflow checkpoint store.

## 4. Eliot still owns domain authority

Cloudflare's durable step result is not sufficient for:

- principal / credential / deployment currentness;
- frozen scope identity;
- exact EvidenceHandle verification;
- source purge/revocation;
- provider/model request identity;
- unknown external effect settlement;
- first-cause and consequence retention;
- canonical artifact and publication state;
- claim audit, citation resolution and coverage semantics.

These remain explicit Eliot contracts.

## 5. Introduce one effect classification

Add one internal/versioned policy owned by the workflow composition layer, not by UI code and not by the model:

```ts
type StageEffectClass =
  | "PURE_COMPUTE"
  | "AUTHORIZED_READ"
  | "IDEMPOTENT_WRITE"
  | "EXTERNAL_UNKNOWN_EFFECT"
  | "HUMAN_OR_AGENT_WAIT";

interface StageExecutionPolicy {
  readonly effect_class: StageEffectClass;
  readonly policy_generation: string;
  readonly timeout_ms: number;
  readonly native_retry_limit: number;
  readonly native_retry_delay: string | number | "DYNAMIC";
  readonly requires_eliot_attempt_ledger: boolean;
  readonly requires_exact_readback: boolean;
  readonly output_storage: "NATIVE_STEP" | "R2_CANONICAL_OBJECT";
}
```

Names may be adjusted to existing project conventions, but the five semantic classes must remain distinct.

### 5.1 `PURE_COMPUTE`

Examples: deterministic parsing of already-frozen bytes, schema validation, deterministic obligation/plan compilation.

Rules:

- Native `step.do` may retry.
- No external request.
- No custom STARTED attempt reservation.
- Result either fits native step persistence or is written as an intentional canonical artifact, not merely to imitate a checkpoint.
- Handler must be deterministic for the same frozen input and generation.

### 5.2 `AUTHORIZED_READ`

Examples: D1/R2 reads, currentness checks, retrieval of already-addressed immutable objects.

Rules:

- Native retry is allowed for typed transient I/O.
- Authority/currentness is rechecked on each attempt.
- Denial, stale scope, purge and content mismatch are not retryable transport failures.
- A read result is not silently converted to an empty set.

### 5.3 `IDEMPOTENT_WRITE`

Examples: D1 mutation with a unique operation identity and exact readback, conditional immutable R2 create, existing outbox intent insertion.

Rules:

- Native retry is allowed only when the write has a stable idempotency/CAS key.
- Lost acknowledgement is resolved by exact readback.
- A new random operation key on retry is forbidden.
- The domain receipt remains in D1/R2 where required.
- `retryable` means retrying the same logical operation is safe; it does not mean minting a new effect.

### 5.4 `EXTERNAL_UNKNOWN_EFFECT`

Examples: provider model request without authoritative idempotency/readback, externally dispatched computer action, provider operation that can bill/commit after the connection is lost.

Rules:

- Native retry limit remains zero.
- Keep the full Eliot attempt ledger and recovery/readback contract.
- STARTED is durable before dispatch.
- Timeout/abort after dispatch remains `EFFECT_UNKNOWN` unless an exact provider/result readback proves an outcome.
- No automatic second paid call.

### 5.5 `HUMAN_OR_AGENT_WAIT`

Examples: external agent task awaiting a callback.

Rules:

- Use native `waitForEvent` under R05/#326.
- D1 result remains authoritative; event is a locator/hint.
- Do not implement normal waiting through repeated Workflow failure/recovery.

## 6. Compile policy before execution

Add one server-owned compiler near the native Workflow composition:

```ts
compileResearchStageExecutionPolicy({
  stage,
  handler_generation,
  handler_capabilities,
  product_plan_generation,
}): StageExecutionPolicy
```

Requirements:

1. Exhaustive over all 18 stages.
2. Unknown handler generation fails closed before execution.
3. Policy generation enters Workflow/attempt identity.
4. Historical runs retain the old policy/topology and are not reinterpreted.
5. A handler cannot self-declare a weaker effect class than the installed server profile.
6. Tests compare every registered handler to its installed policy.

Do not infer the class from arbitrary error messages or function names.

## 7. Change `executeResearchWorkflowNativeSteps`

Current behavior:

```text
all stages
→ native retries=0
→ execute full custom checkpoint executor
```

Target behavior:

```text
policy = compile policy(stage, generation)

PURE_COMPUTE / AUTHORIZED_READ
→ native step.do with bounded retries
→ direct handler / minimal domain readback

IDEMPOTENT_WRITE
→ native step.do with bounded retries
→ same logical key + exact readback

EXTERNAL_UNKNOWN_EFFECT
→ native retries=0
→ existing createWorkflowCheckpointExecutor boundary

HUMAN_OR_AGENT_WAIT
→ waitForEvent path from #326
```

Use Cloudflare dynamic delay functions only for allowlisted transient classes such as rate limit / temporary network failure. Do not branch on arbitrary provider message substrings; use typed error metadata where available.

## 8. Reduce `createWorkflowCheckpointExecutor`, do not delete its unique guarantees

After callers are migrated:

- retain it for `EXTERNAL_UNKNOWN_EFFECT` and any idempotent write that still genuinely requires its exact business settlement;
- rename or narrow the API so it no longer appears to be the required wrapper for all stages;
- remove generic use from pure/read stages;
- preserve existing historical codecs and started-attempt recovery;
- retain `recordWorkflowFailure`, first-cause handling and exact output readback where required.

Do not delete the attempt store merely because Workflows persists step state. It remains necessary at the unknown external-effect boundary.

## 9. Resolve the second executor in `ResearchSession`

`ResearchSession.execute` still invokes `createMonotoneStageExecutor`, while the public run path dispatches `RESEARCH_WORKFLOW`.

Required decision:

- `ResearchWorkflow` is the single execution owner.
- `ResearchSession` becomes presentation/session transport and read/cancel coordination only.
- New sessions must not execute the 18-stage workflow inside the DO.
- Existing historical session records must remain readable/cancellable according to their installed generation.
- Once all production/test callers migrate, move `createMonotoneStageExecutor` to a test-only compatibility helper or remove it.

Coordinate this part with S72/#264; do not edit the same class in parallel.

## 10. Suggested initial effect audit

This table is a review starting point, not authority. Confirm by reading handlers:

| Stage | Likely class | Notes |
|---|---|---|
| FREEZE_PROTOCOL_AND_SCOPE | IDEMPOTENT_WRITE | immutable/canonical binding with CAS/readback |
| ORIENT | AUTHORIZED_READ | unless materializing orientation artifact |
| INTERPRET | PURE_COMPUTE or EXTERNAL_UNKNOWN_EFFECT | depends on installed handler/model use |
| COMPILE_OBLIGATIONS | PURE_COMPUTE | deterministic contract compilation |
| PLAN | PURE_COMPUTE or EXTERNAL_UNKNOWN_EFFECT | model planner requires external class |
| RETRIEVE_BRANCHES | AUTHORIZED_READ | managed provider query may require special external-call policy; do not auto-retry paid search unless qualified |
| ACQUIRE_AND_CAPTURE | EXTERNAL_UNKNOWN_EFFECT | web/provider fetch can have unknown/billed outcome |
| READ_AND_EXTRACT | AUTHORIZED_READ / PURE_COMPUTE | current evidence reads and deterministic extraction |
| ANALYZE_BRANCHES | EXTERNAL_UNKNOWN_EFFECT / HUMAN_OR_AGENT_WAIT | native model vs delegated agent |
| COUNTER_SEARCH | AUTHORIZED_READ + possible external model | split physical steps if effect classes differ |
| RECONCILE | PURE_COMPUTE / IDEMPOTENT_WRITE | derived checkpoint settlement |
| FREEZE_EVIDENCE | IDEMPOTENT_WRITE | canonical frozen record |
| SYNTHESIZE | EXTERNAL_UNKNOWN_EFFECT | model call |
| VERIFY | EXTERNAL_UNKNOWN_EFFECT | independent verifier model/provider |
| AUDIT_CLAIMS | EXTERNAL_UNKNOWN_EFFECT or PURE_COMPUTE | depends on verifier implementation |
| RESOLVE_CITATIONS | AUTHORIZED_READ | exact resolver; unavailable is not invalid |
| CALCULATE_COVERAGE | PURE_COMPUTE / AUTHORIZED_READ | deterministic over frozen receipts |
| MATERIALIZE | IDEMPOTENT_WRITE | Artifact COW and exact readback |

A stage that mixes classes should be split at the physical effect boundary rather than assigned the most expensive class forever.

## 11. Donors

Primary donor is Cloudflare Workflows itself.

Secondary donors provide invariants only:

- RAGFlow crash/resume tests: completed nodes do not rerun after process restart.
- Dify pause state: persisted resume state includes the exact stream cursor/filter when replaying streamed output.
- LightRAG storage outcome: failures declare whether references remain intact or are uncertain.

Do not import LangGraph, Temporal, Dify, RAGFlow or another workflow runtime.

## 12. CODE ownership

Primary files:

```text
packages/cloudflare-workflows/src/research-workflow-step-execution.ts
packages/cloudflare-workflows/src/executor.ts
packages/cloudflare-research-runtime/src/research-stage-handlers.ts
packages/cloudflare-research-runtime/src/research-workflow-application.ts
apps/eliotr-core/src/research-workflow.ts
```

Potential contract location:

```text
packages/cloudflare-workflows/src/stage-execution-policy.ts
```

Coordinated files, one integrator only:

```text
apps/eliotr-core/src/research-session.ts        # #264
external task wait/callback                     # #326
shared failure vocabulary                       # #209
```

## 13. Acceptance

### Policy completeness

- every canonical stage has exactly one installed policy;
- unregistered handler generation fails before stage execution;
- policy generation is durable and visible in diagnostics;
- old runs preserve old policy/topology.

### Native retry correctness

- deterministic transient failure retries through Workflows and succeeds;
- stale authority/revocation is not retried as transport;
- dynamic delay obeys allowlisted typed error class;
- retry reuses exact stage identity.

### Unknown-effect safety

- provider dispatch followed by lost response invokes the provider at most once;
- retry/restart enters recovery/readback, not a second paid call;
- exact existing receipt completes the stage;
- unavailable readback remains `EFFECT_UNKNOWN`.

### Idempotent writes

- lost D1/R2 acknowledgement converges by exact readback;
- concurrent same-key writers do not create two logical effects;
- new random key on retry is rejected.

### Crash/restart

- completed native steps are not rerun;
- Workflow restart resumes at the correct step;
- prior pure/read results remain valid only under the same installed generation/current authority;
- session DO does not execute a second copy of the workflow.

### Code reduction

The implementation PR must list:

```text
removed full-checkpoint callers
removed duplicate recovery branches
moved/deleted monotone executor callers
retained unknown-effect boundary
net production LOC and bundle delta
```

A new policy wrapper over both unchanged execution engines is not completion.

## 14. Verification commands

During implementation:

```sh
pnpm --filter @eliotr/cloudflare-workflows typecheck
pnpm exec eslint \
  packages/cloudflare-workflows/src/research-workflow-step-execution.ts \
  packages/cloudflare-workflows/src/executor.ts \
  packages/cloudflare-workflows/src/stage-execution-policy.ts
pnpm exec vitest run \
  apps/eliotr-core/test/research-workflow.test.ts \
  apps/eliotr-core/test/research-workflow-recovery.test.ts \
  apps/eliotr-core/test/research-deployment-compatibility.test.ts
```

Run native Workflows acceptance only after scoped unit/type checks. Do not use `remote:true` or paid providers merely to prove local policy compilation.

## 15. Out of scope

- UI redesign;
- AIChatAgent / session transport (#264);
- retrieval semantics (#242);
- Web acquisition (#231);
- Queue/DLQ (#256);
- provider/model quality benchmarking;
- deployment, live replay or historical uncertain-run execution.

## 16. Completion result

The task is complete only when:

1. Cloudflare Workflows is the sole generic durable workflow runtime.
2. Eliot's full attempt ledger wraps only explicitly classified business effects.
3. `ResearchSession` no longer runs a parallel 18-stage engine for new sessions.
4. Native retry/wait features are used where they are semantically safe.
5. Exact evidence, authority, first cause and unknown external-effect safety remain intact.
