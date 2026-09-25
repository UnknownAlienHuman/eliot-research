import { ResearchWorkflowStageSchema, type ResearchWorkflowStage } from "@eliotr/contracts";
import { invalid, record } from "./research-run-wire.js";

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

export type ResearchRunFailureCode = typeof RESEARCH_RUN_FAILURE_CODES[number];

export interface ResearchRunFailureContext {
  readonly code: ResearchRunFailureCode;
  readonly stage?: ResearchWorkflowStage;
  readonly phase?: "PREPARATION" | "STAGE" | "RECOVERY";
  /** True only for known pre-dispatch transient preparation reads, never for a possibly paid effect. */
  readonly retryable?: boolean;
}
export interface ResearchRunFailureView extends ResearchRunFailureContext {
  /** A later native/recovery error cannot overwrite the first retained cause. */
  readonly consequence?: ResearchRunFailureContext;
}

const RESEARCH_ENGINE_STATUSES: readonly ResearchEngineStatus[] = [
  "queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause", "unknown",
];
const RESEARCH_RUN_FAILURE_CODES = [
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
] as const;

export function engineStatus(value: unknown): ResearchEngineStatus {
  if (typeof value !== "string" || !RESEARCH_ENGINE_STATUSES.includes(value as ResearchEngineStatus)) invalid("research engine status is invalid");
  return value as ResearchEngineStatus;
}

function researchFailureContext(value: unknown, diagnostic: boolean): ResearchRunFailureContext {
  const failure = record(value, ["code"], diagnostic ? ["stage", "phase", "retryable"] : ["stage"]);
  if (typeof failure.code !== "string" || !RESEARCH_RUN_FAILURE_CODES.includes(failure.code as ResearchRunFailureCode)) invalid("research run failure code is invalid");
  let stage: ResearchWorkflowStage | undefined;
  if (Object.hasOwn(failure, "stage")) {
    const parsed = ResearchWorkflowStageSchema.safeParse(failure.stage);
    if (!parsed.success) invalid("research run failure stage is invalid");
    stage = parsed.data;
  }
  const phase = failure.phase;
  if (Object.hasOwn(failure, "phase") && phase !== "PREPARATION" && phase !== "STAGE" && phase !== "RECOVERY") invalid("research failure phase is invalid");
  if (phase === "PREPARATION" ? stage !== undefined : phase !== undefined && stage === undefined) invalid("research failure phase and stage do not match");
  if (Object.hasOwn(failure, "retryable") && typeof failure.retryable !== "boolean") invalid("research failure retryability is invalid");
  if (failure.retryable === true && (phase !== "PREPARATION" || failure.code !== "WORKFLOW_STORAGE_UNAVAILABLE")) invalid("research failure cannot authorize replay");
  return { code: failure.code as ResearchRunFailureCode, ...(stage === undefined ? {} : { stage }),
    ...(phase === undefined ? {} : { phase: phase as NonNullable<ResearchRunFailureContext["phase"]> }),
    ...(failure.retryable === undefined ? {} : { retryable: failure.retryable as boolean }) };
}
export function researchRunFailure(value: unknown, diagnostic = false): ResearchRunFailureView {
  if (!diagnostic) return researchFailureContext(value, false);
  const failure = record(value, ["code"], ["stage", "phase", "retryable", "consequence"]);
  const { consequence, ...initial } = failure;
  const first = researchFailureContext(initial, true);
  if (Object.hasOwn(failure, "consequence")) {
    if (first.retryable === true) invalid("a later failure prevents automatic replay");
    return { ...first, consequence: researchFailureContext(consequence, true) };
  }
  return first;
}
