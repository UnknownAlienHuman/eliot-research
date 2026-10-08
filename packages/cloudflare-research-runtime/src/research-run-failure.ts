import {
  parseWorkflowCheckpointErrorMessage,
  WORKFLOW_FAILURE_CODES,
  type WorkflowFailure,
  type WorkflowRunStatus,
} from "@eliotr/cloudflare-workflows";
import type { ResearchEngineStatus, ResearchRunFailure, ResearchRunFailureContext, ResearchRunFailureCode } from "@eliotr/interfaces";

const RESEARCH_ENGINE_STATUSES = new Set<ResearchEngineStatus>([
  "queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause", "unknown",
]);
const RESEARCH_NATIVE_FAILURE_CODES = new Set<string>(WORKFLOW_FAILURE_CODES);
export interface ResearchEngineObservation {
  readonly status: ResearchEngineStatus;
  readonly failure_code?: ResearchRunFailureCode;
  readonly failure?: WorkflowFailure;
}
export interface ResearchEngineObservationPorts {
  readonly get_workflow: (operationId: string) => Promise<WorkflowInstance>;
}
function readResearchEngineStatusValue(value: unknown): ResearchEngineStatus {
  return typeof value === "string" && RESEARCH_ENGINE_STATUSES.has(value as ResearchEngineStatus) ? value as ResearchEngineStatus : "unknown";
}
function readResearchNativeFailure(value: unknown): {
  readonly failure_code?: ResearchRunFailureCode;
  readonly failure?: WorkflowFailure;
} | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = (value as { readonly error?: unknown }).error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return undefined;
  const name = Object.getOwnPropertyDescriptor(error, "name")?.value;
  const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
  if (typeof name !== "string" || typeof message !== "string") return undefined;
  const renewalPrefix = "ResearchQualificationRenewalError: ";
  if (name === "ResearchQualificationRenewalError" && message.startsWith(renewalPrefix)) {
    const code = message.slice(renewalPrefix.length);
    return RESEARCH_NATIVE_FAILURE_CODES.has(code) ? { failure_code: code as ResearchRunFailureCode } : undefined;
  }
  if (name !== "WorkflowCheckpointError") return undefined;
  const nativeMessage = parseWorkflowCheckpointErrorMessage(message);
  if (nativeMessage !== null) {
    return {
      failure_code: nativeMessage.outer_code,
      ...(nativeMessage.failure === undefined ? {} : { failure: nativeMessage.failure }),
    };
  }
  const legacyCode = message.startsWith("WorkflowCheckpointError: ")
    ? message.slice("WorkflowCheckpointError: ".length) : message;
  return RESEARCH_NATIVE_FAILURE_CODES.has(legacyCode)
    ? { failure_code: legacyCode as ResearchRunFailureCode } : undefined;
}
export async function readResearchEngineStatus(
  ports: ResearchEngineObservationPorts,
  operationId: string,
): Promise<ResearchEngineObservation> {
  try {
    const instance = await ports.get_workflow(operationId);
    if (instance.id !== operationId) return { status: "unknown" };
    const observed: unknown = await instance.status();
    const status = readResearchEngineStatusValue((observed as { readonly status?: unknown }).status);
    const nativeFailure = status === "errored" ? readResearchNativeFailure(observed) : undefined;
    return {
      status,
      ...(nativeFailure?.failure_code === undefined ? {} : { failure_code: nativeFailure.failure_code }),
      ...(nativeFailure?.failure === undefined ? {} : { failure: nativeFailure.failure }),
    };
  } catch {
    return { status: "unknown" };
  }
}

function failureContext(value: WorkflowFailure): ResearchRunFailureContext {
  return { code: value.code, phase: value.phase, retryable: value.retryable,
    ...(value.stage === undefined ? {} : { stage: value.stage }) };
}

/** Historical diagnostics do not turn an active, recovered or completed run into a failed run. */
export function researchRunFailure(status: WorkflowRunStatus,
  engine: ResearchEngineObservation | undefined): ResearchRunFailure | undefined {
  if (engine?.status !== "errored") return undefined;
  const native: ResearchRunFailureContext | undefined = engine.failure === undefined
    ? engine.failure_code === undefined ? undefined : { code: engine.failure_code }
    : failureContext(engine.failure);
  const first = status.first_failure;
  if (first === null) return native;
  const latest = status.latest_failure;
  const nativeConsequence = native?.code !== first.code && native?.code !== "WORKFLOW_EFFECT_UNCERTAIN" &&
    native?.code !== "WORKFLOW_PREPARATION_FAILED" ? native : undefined;
  const consequence = latest !== null && JSON.stringify(latest) !== JSON.stringify(first)
    ? failureContext(latest) : nativeConsequence;
  return { ...failureContext(first),
    retryable: first.retryable && consequence === undefined && native?.code === first.code,
    ...(consequence === undefined ? {} : { consequence }),
  };
}
