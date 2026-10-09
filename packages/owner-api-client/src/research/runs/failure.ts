/** C3-RR research-run failure decoder, moved mechanically and aligned to the current contract.
 *
 * The authoritative shapes are `ResearchRunFailureContext` and `ResearchRunFailure` in
 * `packages/interfaces/src/semantic-api.ts`: the immutable first cause, optional `protocol` /
 * `dispatch_state` / `references_intact` / `recovery_action` outcome tuple, a terminal
 * `consequence` and the ordered `consequences` list. This module decodes exactly that shape and
 * imports no backend package, so no raw provider or runtime payload can reach the browser.
 */

import { ResearchWorkflowStageSchema, type ResearchWorkflowStage } from "@eliotr/contracts";
import type { LegacyErrorFactory } from "../../legacy/http";
import { createResearchRunWire, type ResearchRunWire } from "./wire";

export type ResearchEngineStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";

export type ResearchRunDispatchState = "NOT_STARTED" | "OUTCOME_UNKNOWN" | "RESPONSE_RECEIVED";
export type ResearchRunReferencesIntact = "INTACT" | "UNKNOWN";
export type ResearchRunRecoveryAction = "NONE" | "READBACK" | "RECONCILE";

export const RESEARCH_RUN_OUTCOME_PROTOCOL = "eliotr.workflow-failure-outcome.v1";

const RESEARCH_ENGINE_STATUSES: readonly ResearchEngineStatus[] = [
  "queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause", "unknown",
];
const DISPATCH_STATES: readonly ResearchRunDispatchState[] = ["NOT_STARTED", "OUTCOME_UNKNOWN", "RESPONSE_RECEIVED"];
const REFERENCES_INTACT: readonly ResearchRunReferencesIntact[] = ["INTACT", "UNKNOWN"];
const RECOVERY_ACTIONS: readonly ResearchRunRecoveryAction[] = ["NONE", "READBACK", "RECONCILE"];
const PHASES: readonly string[] = ["PREPARATION", "STAGE", "RECOVERY"];
const MAX_CONSEQUENCES = 16;


/** The published failure code vocabulary, kept as the closed transport set. */
export const RESEARCH_RUN_FAILURE_CODES = [
  "WORKFLOW_INPUT_INVALID",
  "WORKFLOW_CONFLICT",
  "WORKFLOW_AUTHORITY_STALE",
  "WORKFLOW_STAGE_OUT_OF_ORDER",
  "WORKFLOW_CANCELLED",
  "WORKFLOW_BUDGET_STOP",
  "WORKFLOW_EFFECT_UNCERTAIN",
  "WORKFLOW_OUTPUT_UNAVAILABLE",
  "WORKFLOW_OUTPUT_CORRUPT",
  "WORKFLOW_CONFIGURATION_MISSING",
  "WORKFLOW_CONFIGURATION_INVALID",
  "WORKFLOW_CREDENTIALS_MISSING",
  "WORKFLOW_CREDENTIALS_INVALID",
  "WORKFLOW_STORAGE_UNAVAILABLE",
  "WORKFLOW_QUALIFICATION_STALE",
  "WORKFLOW_PREPARATION_FAILED",
  "RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
  "RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE",
  "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE",
  "RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE",
  "MODEL_ATTEMPT_INPUT_INVALID",
  "MODEL_ATTEMPT_AUTHORITY_STALE",
  "MODEL_ATTEMPT_IDENTITY_CONFLICT",
  "MODEL_ATTEMPT_BUDGET_EXPIRED",
  "MODEL_ATTEMPT_CONFLICT",
  "MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN",
  "MODEL_ATTEMPT_READBACK_CORRUPT",
  "MODEL_GATEWAY_DEPLOYMENT_MISSING",
  "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
  "MODEL_GATEWAY_REQUEST_INVALID",
  "MODEL_GATEWAY_CREDENTIAL_INVALID",
  "MODEL_GATEWAY_TRANSPORT_FAILED",
  "MODEL_GATEWAY_AUTH_REJECTED",
  "MODEL_GATEWAY_LIMIT_REJECTED",
  "MODEL_GATEWAY_POLICY_REJECTED",
  "MODEL_GATEWAY_UPSTREAM_REJECTED",
  "MODEL_GATEWAY_RESPONSE_INVALID",
  "MODEL_GATEWAY_OUTPUT_TRUNCATED",
  "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
  "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
  "MODEL_GATEWAY_PRICING_FAILED",
  "MODEL_PROFILE_BINDING_INPUT_INVALID",
  "MODEL_PROFILE_BINDING_CONFIG_MISSING",
  "MODEL_PROFILE_BINDING_CONFIG_INVALID",
  "MODEL_PROFILE_BINDING_AUTHORITY_STALE",
  "MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING",
  "MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH",
  "MODEL_PROFILE_BINDING_EXPIRED",
  "REFERENCE_MANIFEST_INPUT_INVALID",
  "REFERENCE_MANIFEST_SCOPE_STALE",
  "REFERENCE_MANIFEST_EVIDENCE_INVALID",
  "REFERENCE_MANIFEST_POLICY_INVALID",
  "REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN",
  "EVIDENCE_INPUT_INVALID",
  "EVIDENCE_SCOPE_NOT_FOUND",
  "EVIDENCE_SCOPE_INVALIDATED",
  "EVIDENCE_SCOPE_EXPIRED",
  "EVIDENCE_AUTHORIZATION_DENIED",
  "EVIDENCE_SOURCE_NOT_FOUND",
  "EVIDENCE_SOURCE_NOT_LIVE",
  "EVIDENCE_OWNER_GENERATION_MISMATCH",
  "EVIDENCE_SCOPE_MISMATCH",
  "EVIDENCE_LOCATOR_NOT_RESOLVABLE",
  "EVIDENCE_PRECISION_UNSUPPORTED",
  "EVIDENCE_OBJECT_NOT_FOUND",
  "EVIDENCE_OBJECT_INTEGRITY",
  "EVIDENCE_RANGE_INVALID",
  "EVIDENCE_HANDLE_NOT_FOUND",
  "EVIDENCE_HANDLE_NOT_LIVE",
  "EVIDENCE_IDENTITY_CONFLICT",
  "EVIDENCE_SETTLEMENT_UNCERTAIN",
  "CITATION_SET_INVALID",
  "EVIDENCE_FREEZE_INPUT_INVALID",
  "EVIDENCE_FREEZE_SCOPE_STALE",
  "EVIDENCE_FREEZE_EVIDENCE_INVALID",
  "EVIDENCE_FREEZE_AUTHORITY_INVALID",
  "EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN",
] as const;

export type ResearchRunFailureCode = (typeof RESEARCH_RUN_FAILURE_CODES)[number];

export interface ResearchRunFailureContext {
  readonly code: ResearchRunFailureCode;
  readonly stage?: ResearchWorkflowStage;
  readonly phase?: "PREPARATION" | "STAGE" | "RECOVERY";
  /** True only for a known pre-dispatch transient preparation read, never permission to replay an effect. */
  readonly retryable?: boolean;
  readonly protocol?: typeof RESEARCH_RUN_OUTCOME_PROTOCOL;
  readonly dispatch_state?: ResearchRunDispatchState;
  readonly references_intact?: ResearchRunReferencesIntact;
  readonly recovery_action?: ResearchRunRecoveryAction;
}

export interface ResearchRunFailureView extends ResearchRunFailureContext {
  /** A later native or recovery failure can never overwrite the first retained cause. */
  readonly consequence?: ResearchRunFailureContext;
  /** Append-only ordered consequences bounded by the published maximum. */
  readonly consequences?: readonly ResearchRunFailureContext[];
}

export interface ResearchRunFailureDecoder {
  engineStatus: (value: unknown) => ResearchEngineStatus;
  researchRunFailure: (value: unknown, diagnostic?: boolean) => ResearchRunFailureView;
}


export function createResearchFailureDecoder(errors: LegacyErrorFactory): ResearchRunFailureDecoder {
  const wire = createResearchRunWire(errors);
  const invalid: ResearchRunWire["invalid"] = wire.invalid;
  const { record } = wire;

  function engineStatus(value: unknown): ResearchEngineStatus {
    if (typeof value !== "string" || !RESEARCH_ENGINE_STATUSES.includes(value as ResearchEngineStatus)) invalid("research engine status is invalid");
    return value as ResearchEngineStatus;
  }

  function readCode(value: unknown): ResearchRunFailureCode {
    if (typeof value !== "string" || !(RESEARCH_RUN_FAILURE_CODES as readonly string[]).includes(value)) invalid("research run failure code is invalid");
    return value as ResearchRunFailureCode;
  }

  function readStage(value: unknown): ResearchWorkflowStage {
    const parsed = ResearchWorkflowStageSchema.safeParse(value);
    if (!parsed.success) invalid("research run failure stage is invalid");
    return parsed.data;
  }

  function readOutcomeTuple(recordValue: Record<string, unknown>): {
    protocol?: typeof RESEARCH_RUN_OUTCOME_PROTOCOL;
    dispatch_state?: ResearchRunDispatchState;
    references_intact?: ResearchRunReferencesIntact;
    recovery_action?: ResearchRunRecoveryAction;
  } {
    const hasProtocol = Object.hasOwn(recordValue, "protocol");
    const hasDispatch = Object.hasOwn(recordValue, "dispatch_state");
    const hasReferences = Object.hasOwn(recordValue, "references_intact");
    const hasRecovery = Object.hasOwn(recordValue, "recovery_action");
    // The versioned outcome tuple is all-or-nothing; a partial tuple is a contract drift.
    if (hasProtocol !== hasDispatch || hasDispatch !== hasReferences || hasReferences !== hasRecovery) {
      invalid("research failure outcome tuple is incomplete");
    }
    if (!hasProtocol) return {};
    const protocol = recordValue.protocol;
    if (protocol !== RESEARCH_RUN_OUTCOME_PROTOCOL) invalid("research failure outcome protocol is invalid");
    const dispatch = recordValue.dispatch_state;
    if (typeof dispatch !== "string" || !DISPATCH_STATES.includes(dispatch as ResearchRunDispatchState)) invalid("research failure dispatch state is invalid");
    const references = recordValue.references_intact;
    if (typeof references !== "string" || !REFERENCES_INTACT.includes(references as ResearchRunReferencesIntact)) invalid("research failure references state is invalid");
    const recovery = recordValue.recovery_action;
    if (typeof recovery !== "string" || !RECOVERY_ACTIONS.includes(recovery as ResearchRunRecoveryAction)) invalid("research failure recovery action is invalid");
    if (dispatch === "OUTCOME_UNKNOWN" && (references !== "UNKNOWN" || recovery === "NONE")) {
      invalid("unknown outcome must stay unknown and reconcile or read back");
    }
    return {
      protocol: RESEARCH_RUN_OUTCOME_PROTOCOL,
      dispatch_state: dispatch as ResearchRunDispatchState,
      references_intact: references as ResearchRunReferencesIntact,
      recovery_action: recovery as ResearchRunRecoveryAction,
    };
  }

  function researchFailureContext(value: unknown, diagnostic: boolean): ResearchRunFailureContext {
    const failure = record(value, ["code"], diagnostic
      ? ["stage", "phase", "retryable", "protocol", "dispatch_state", "references_intact", "recovery_action"]
      : ["stage"]);
    const code = readCode(failure.code);
    let stage: ResearchWorkflowStage | undefined;
    if (Object.hasOwn(failure, "stage")) stage = readStage(failure.stage);
    const phase = failure.phase;
    if (Object.hasOwn(failure, "phase") && (typeof phase !== "string" || !PHASES.includes(phase))) invalid("research failure phase is invalid");
    if (phase === "PREPARATION" ? stage !== undefined : phase !== undefined && stage === undefined) invalid("research failure phase and stage do not match");
    if (Object.hasOwn(failure, "retryable") && typeof failure.retryable !== "boolean") invalid("research failure retryability is invalid");
    const retryable = failure.retryable;
    if (retryable === true && (phase !== "PREPARATION" || code !== "WORKFLOW_STORAGE_UNAVAILABLE")) invalid("research failure cannot authorize replay");
    return {
      code,
      ...(stage === undefined ? {} : { stage }),
      ...(phase === undefined ? {} : { phase: phase as NonNullable<ResearchRunFailureContext["phase"]> }),
      ...(retryable === undefined ? {} : { retryable: retryable as boolean }),
      ...readOutcomeTuple(failure),
    };
  }

  function sameContext(left: ResearchRunFailureContext, right: ResearchRunFailureContext): boolean {
    return left.code === right.code && left.stage === right.stage && left.phase === right.phase &&
      left.retryable === right.retryable && left.protocol === right.protocol &&
      left.dispatch_state === right.dispatch_state && left.references_intact === right.references_intact &&
      left.recovery_action === right.recovery_action;
  }

  function researchRunFailure(value: unknown, diagnostic = false): ResearchRunFailureView {
    if (!diagnostic) return researchFailureContext(value, false);
    const failure = record(value, ["code"], [
      "stage", "phase", "retryable",
      "protocol", "dispatch_state", "references_intact", "recovery_action",
      "consequence", "consequences",
    ]);
    const { consequence, consequences, ...initial } = failure;
    const first = researchFailureContext(initial, true);
    if (Object.hasOwn(failure, "consequences")) {
      if (!Array.isArray(consequences) || consequences.length > MAX_CONSEQUENCES) invalid("research failure consequences are invalid");
      const ordered: ResearchRunFailureContext[] = consequences.map((item) => researchFailureContext(item, true));
      if (first.retryable === true) invalid("a later failure prevents automatic replay");
      const terminal = Object.hasOwn(failure, "consequence")
        ? researchFailureContext(consequence, true)
        : ordered[ordered.length - 1];
      const last = ordered[ordered.length - 1];
      if (terminal !== undefined && last !== undefined && !sameContext(terminal, last)) {
        invalid("terminal consequence does not match the ordered history");
      }
      return ordered.length === 0 ? first : { ...first, ...(terminal === undefined ? {} : { consequence: terminal }), consequences: ordered };
    }
    if (Object.hasOwn(failure, "consequence")) {
      const second = researchFailureContext(consequence, true);
      if (first.retryable === true) invalid("a later failure prevents automatic replay");
      return { ...first, consequence: second, consequences: [second] };
    }
    return first;
  }

  return { engineStatus, researchRunFailure };
}
