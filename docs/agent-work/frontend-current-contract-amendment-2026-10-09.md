# Frontend current-main contract amendment — 2026-10-09

**Status:** normative amendment for PR #329 and the checkpoints named below.
**Reviewed main:** `00c85244d362aa89b2f146286a31dffc10a8ed98`.
**Applies to:** B-C, B-U, U1.1b, C0/C1, C2-I, C2-D, C3-RR, C3-RP, C3-EC, C3-R,
C3-E, U2-S, U2-R, U3-I, U3-X, U4-R, U4-E, U4-X, U6 and their manager handoffs.
**Does not block:** ER-49, U1.1a, U1.2, U1.3 or fixture-only visual exploration before U1.4.
**Implementation state:** documentation reconciliation only. No frontend source, dependency, lockfile, Worker,
database, deployment or Cloudflare-account mutation is authorized by this file.

This file reconciles dated frontend inventories with backend contracts published afterward. It creates no
browser-local API, state machine or product feature. Exact current TypeScript, SQL, Worker configuration and
accepted server behavior remain authoritative.

## 1. Citation-resolution receipts remain strict and versioned

The owner client strictly decodes retained V1 and V2 receipt families. V1 remains immutable. V2 contains one
outcome for every requested handle and cannot be reconstructed from compatibility projections.

V2 requirements:

- `outcomes` covers each requested handle exactly once and in requested order;
- `resolved` is the exact ordered projection of `RESOLVED` outcomes;
- `rejected` contains only `INVALID_REFERENCE`, `AUTHORITY_REVOKED` and `CONTENT_MISMATCH`;
- counts, identity and completion derive from outcomes;
- duplicate, missing, foreign, reordered, unknown or projection-drifted members fail closed.

Closed vocabulary:

```text
RESOLVED
INVALID_REFERENCE
AUTHORITY_REVOKED
SOURCE_QUARANTINED
CONTENT_MISMATCH
VERIFY_UNAVAILABLE
STORAGE_UNAVAILABLE
EFFECT_UNKNOWN
```

Quarantine, verification/storage unavailability and effect uncertainty are not rejection, semantic
contradiction or lack of claim support. Citation resolution and claim audit remain independent.

## 2. Research failure cause is immutable

`ResearchRunStatus.failure` contains one safe first cause. Later native/recovery failures are consequences and
cannot replace or relabel it.

The browser preserves:

```text
code
stage
phase: PREPARATION | STAGE | RECOVERY
retryable observation
protocol: eliotr.workflow-failure-outcome.v1
dispatch_state: NOT_STARTED | OUTCOME_UNKNOWN | RESPONSE_RECEIVED
references_intact: INTACT | UNKNOWN
recovery_action: NONE | READBACK | RECONCILE
consequence / consequences
```

`OUTCOME_UNKNOWN` never authorizes a new run, operation identity or provider effect. Readback/reconciliation
uses existing identity. Raw runtime/provider messages, prompts, payloads, secrets and stacks never enter UI.

## 3. ResearchSession is a strict read-only RPC snapshot

Current main defines `eliotr.research-session-projection.v1` as `IMPLEMENTED_NOT_LIVE`.

The exact client contract is:

```text
transport: official agents/client AgentClient callable RPC
callable: readResearchSessionProjection()
arguments: none
successful output: one strict versioned snapshot
proactive progress: none
chat/state/history/MCP/other frames: rejected
GET get-messages: 410 SESSION_CHAT_HISTORY_DISABLED
```

The server suppresses default protocol/state messages and accepts only the no-argument projection RPC.
ResearchSession is not chat, transcript, event stream, run admission, cancellation, completion or provider-
effect authority.

Strict snapshot union:

```text
ACTIVE
  session_id
  operation_id
  investigation_ref
  run_status.execution_state = ACTIVE
  run_status.engine_status
  run_status.next_stage_index

CANCELLED
  session_id
  operation_id
  investigation_ref
  cancellation_receipt_ref

ENGINE_COMPLETED
  session_id
  operation_id
  investigation_ref
  completion_receipt_ref
  output_manifest_ref
```

No unknown field is accepted. Snapshot deliberately omits answer/report content, failure detail, prompt,
provider payload, transcript and other receipts.

Frontend rules:

- ER-48 owns one exact framework-free `AgentClient` adapter and strict decoder;
- ER-47 components/hooks never import `agents/client` or open the socket directly;
- only `readResearchSessionProjection()` with zero arguments is sent;
- `get-messages` 410 is expected behavior, not a retry/fallback-to-chat signal;
- projection is snapshot-on-request, not streaming or proactive Workflow progress;
- canonical HTTP status/history/readback owns detailed progress, failure and report reconciliation;
- missing/stale/unknown/inconsistent projection remains `UNKNOWN`/degraded until HTTP readback;
- `ENGINE_COMPLETED` is not report acceptance/publication;
- disconnect, disposal and hibernation never cancel work;
- reconnect creates no run, mutation, operation ID, transcript or paid effect;
- old principal/session/credential/deployment/lifecycle output cannot restore protected state.

The exact adapter binds stored session, operation, investigation, handler generation, principal, credential
generation, deployment generation and authority expiry. A future push/event protocol requires a new versioned
contract; it cannot silently broaden this adapter.

## 4. Research branch, leg, finding and budget semantics

Query-leg state:

```text
status: COMPLETED | FAILED
stop_reason:
  LEG_COMPLETED
  NO_HITS
  CANDIDATE_BUDGET
  SCAN_BUDGET
  EVIDENCE_BUDGET
  CANCELLED
  LEG_FAILED
```

Overall branch state:

```text
PLAN_COMPLETED
FIRST_ADMISSIBLE_EVIDENCE
NO_HITS
BUDGET_EXHAUSTED
ALL_LEGS_FAILED

failure_disposition: NONE | PARTIAL | ALL_FAILED
```

`NO_HITS` is not proof of absence. First evidence is not exhaustive coverage. Plan completion is not artifact
acceptance. Partial leg failure is not all-failed.

Current retrieval applies aggregate remaining candidate cap before provider reads and records omissions/usage.
Current prompt composition treats derived candidates as untrusted, uses server-owned mandatory evidence refs
and byte-measures the exact provider-native request envelope. Oversized context candidates may be omitted while
later admissible candidates fill remaining budget.

The UI keeps distinct:

- retrieval candidate budget;
- scan/evidence budget;
- prompt-context byte budget;
- citation-resolution outcome;
- finding support/counterevidence state;
- artifact acceptance/publication.

Candidate prompt context never appears as accepted truth/evidence. Raw prompt envelopes and provider-native
request bodies never enter UI. A context-budget omission is not invalid citation, contradiction, purge or
corpus absence. Only an accepted public receipt may justify a bounded limitation message.

## 5. Workflow capture/admission remains explicit and scope-safe

Current main composes owner-bound Workflow capture and normalized admission through existing D1 authority, R2
staging, promotion verifier and current policy/expiry checks. Rechecks bind operation, principal, credential
generation, deployment generation, ACTIVE run and held scope. Existing backend compatibility value remains
`client_class: "owner_pwa"`; browser code cannot locally rename wire vocabulary.

Normalized admission requires explicit `conversion_profile_generation` and the same authority tuple for
capture, conversion readback and admission. It does not:

- select conversion byte/token/timeout/options bounds;
- authorize automatic conversion without a selected `RawMarkdownConversionRequest`;
- extend the active run's frozen scope;
- replace an uncertain historical run;
- infer source logical identity from filename, URL or capture ID.

Automatic conversion remains input-pending. A later Research run needs new idempotency identity and explicit
scope whose frozen revision matches admitted revision.

C2-I/U2-S/U3-I/U3-X therefore keep capture, conversion, admission, search readiness and evidence readiness
separate; never auto-select or auto-add admitted source to current/historical scope.

## 6. Owner-mutation request security

Owner mutations retain endpoint-specific evidence including same-origin `Origin`, `x-eliotr-csrf: 1`, accepted
`Sec-Fetch-Site`, correct media type and current owner context. ER-48 normalizes every `HeadersInit` through
`Headers`, preserves required CSRF/idempotency/media values and rejects hostile overrides.

## 7. Worker-first routing exists in source but still needs generated/live qualification

Current Worker-first families:

```text
/healthz
/mcp
/agent-inbox
/agent-inbox/*
/agents
/agents/*
/api/*
/federation/*
/oauth/*
```

Source parity is present. U1.1b/U6 still proves generated Vite output preserves route precedence and that:

- Agent upgrade and projection RPC reach Worker;
- `get-messages` returns typed 410, never SPA HTML;
- forbidden frames close/fail as protocol dictates;
- API/agent errors never fall through to SPA HTML;
- static routing files are not assumed to govern Worker responses;
- local workerd/native-edge/browser/staging results bind exact build identity.

## 8. Existing emitted/deployment evidence is the only build authority

Main already has emitted-budget receipts and deployment evidence covering source/build inputs, entrypoint,
generated config, Worker bundle, application schema and assets. Current asset schema remains legacy-PWA-
specific.

B-U/U6 extends this authority rather than creating a second frontend receipt:

- owner-web eager/static/lazy assets plus existing Worker modules;
- exact Vite output config and routing-policy digest;
- source/lock/config/build-input identity and post-build mutation checks;
- historical receipt compatibility;
- retirement-safe legacy rollback and permanent inert `/sw.js`;
- no rebuild after attestation;
- no React assets combined with separately rebuilt Worker.

Initial eager owner-web JavaScript ceiling remains `<= 600 KiB gzip`. Source lines, Vite directory size or
Lighthouse score are not emitted-build evidence.

Internal managed projection/Items rows are not owner-web readiness until a versioned owner API exposes them.

## 9. Golden corpus and unresolved backend decisions

Local Golden fixture integrity cannot satisfy provider/live qualification, manager-recorded U1-D rendered
acceptance, fresh-context U2-X usability acceptance or production promotion.

Until authoritative decisions are accepted, UI must not present as fact:

- proposal/query-plan model-call cardinality;
- fixed LEX/SEM execution order;
- automatic conversion request bounds;
- automatic current-run scope expansion after admission;
- proactive ResearchSession progress;
- retry/cost expectations derived from unresolved contours.

## 10. Checkpoint amendments

| Checkpoint | Current-main amendment |
|---|---|
| U1.1a | Add no Agents/chat dependency to React app; any exact `agents/client` use belongs to ER-48 adapter proposal |
| B-U | Extend existing emitted/deployment authority and prove one React/Vite/Wrangler/Agents graph |
| U1.1b | Preserve Worker-first routes; test projection RPC, forbidden frames, expected history 410 and SPA-fallback negatives |
| C0.1/C0.3 | Inventory exact projection RPC/union/410, branch/finding DTOs, prompt limits, admission seams and mutation guards |
| C1 | Preserve HTTP security/currentness and old-epoch removal; no generic chat transport helper |
| C2-I | Preserve explicit capture/conversion/admission/recovery; no invented conversion request or scope expansion |
| C2-D | Preserve immutable-representation byte rules |
| C3-RR | Preserve run identity, immutable first failure and canonical HTTP readback |
| C3-RP | Implement only strict no-arg projection callable; no history/chat/state/proactive events |
| C3-R | Prove HTTP owns progress/details and projection is read-only snapshot accelerator |
| C3-EC/C3-E | Strict citation V1/V2 outcomes and exact projections |
| U2-S | Fixture separate capture/conversion/admission/readiness and explicit post-admission scope |
| U2-R | Fixture strict ACTIVE/CANCELLED/ENGINE_COMPLETED snapshots, history 410 and degraded HTTP reconciliation |
| U3-I/U3-X | No automatic conversion or active-scope mutation without accepted server contract |
| U4-R | Polling/readback owns progress; projection is explicit refresh only; no transcript or hidden reasoning |
| U4-E | Resolution remains separate from semantic support |
| U4-X | Prove strict union/410/forbidden-frame/no-replay/readback behavior and protected-state clearing |
| U6 | Attest Worker-first routing, Agent RPC, assets/modules/schema/rollback/routing/tombstone as one graph |

## 11. Mandatory negative cases

- React component imports `agents/client` or opens ResearchSession directly;
- projection call sends arguments or another RPC method;
- chat/history/state/MCP frame is accepted;
- `get-messages` 410 is treated as transient failure, transcript source or SPA route;
- projection is presented as proactive streaming progress;
- reconnect creates/repeats run, mutation, operation ID or effect;
- old authority projection restores protected state;
- `ENGINE_COMPLETED` appears as accepted/published report;
- citation outcome/projection drift is accepted;
- quarantine/unavailability/uncertainty appears as proven invalid/unsupported;
- later failure consequence replaces first cause;
- no-hit, retrieval budget, context budget, first evidence and complete coverage collapse;
- candidate prompt context appears as accepted evidence or raw prompt text is exposed;
- capture/conversion/admission/readiness collapse;
- admission silently changes current/historical scope;
- automatic conversion proceeds without selected bounds/options;
- CSRF/idempotency/origin headers disappear or are overridden;
- B-U/U6 forks emitted/deployment receipt authority;
- internal managed state appears as owner-visible readiness;
- local Golden result or screenshot becomes owner/product promotion.

## 12. Honest verification status

This amendment is static current-main inspection. It does not claim execution of:

```text
pnpm work-packets:check
node scripts/check-docs-index.mjs
frozen install / peer resolution
TypeScript / ESLint / Vitest
ResearchSession browser reconnect / two-tab / hibernation
Vite/workerd Agent RPC and routing parity
Storybook / Playwright / CSP / accessibility / performance
U1-D manager-recorded internal acceptance
U2-X fresh-context internal usability audit
pnpm check:full
staging or live acceptance
```

Every unsupported result stays `PENDING`. Each affected checkpoint claim records exact main/contract SHA and
confirms this amendment has not been superseded.
