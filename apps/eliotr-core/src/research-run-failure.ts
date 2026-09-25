import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { WORKFLOW_FAILURE_CODES, type WorkflowFailure, type WorkflowRunStatus } from "@eliotr/cloudflare-workflows";
import type { ResearchEngineStatus, ResearchRunFailure, ResearchRunFailureContext, ResearchRunFailureCode } from "@eliotr/interfaces";
import type { Env } from "./env.js";

const RESEARCH_ENGINE_STATUSES = new Set<ResearchEngineStatus>([
  "queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause", "unknown",
]);
const RESEARCH_NATIVE_FAILURE_CODES = new Set<string>(WORKFLOW_FAILURE_CODES);
export interface ResearchEngineObservation {
  readonly status: ResearchEngineStatus;
  readonly failure_code?: ResearchRunFailureCode;
}
function readResearchEngineStatusValue(value: unknown): ResearchEngineStatus {
  return typeof value === "string" && RESEARCH_ENGINE_STATUSES.has(value as ResearchEngineStatus) ? value as ResearchEngineStatus : "unknown";
}
function readResearchNativeFailureCode(value: unknown): ResearchRunFailureCode | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = (value as { readonly error?: unknown }).error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return undefined;
  const message = (error as { readonly message?: unknown }).message;
  if (typeof message !== "string") return undefined;
  const workflowPrefix = "WorkflowCheckpointError: ";
  const renewalPrefix = "ResearchQualificationRenewalError: ";
  const code = message.startsWith(workflowPrefix)
    ? message.slice(workflowPrefix.length)
    : message.startsWith(renewalPrefix)
      ? message.slice(renewalPrefix.length)
      : message;
  return RESEARCH_NATIVE_FAILURE_CODES.has(code) ? code as ResearchRunFailureCode : undefined;
}
export async function readResearchEngineStatus(env: Env, operationId: string): Promise<ResearchEngineObservation> {
  try {
    const instance = await env.RESEARCH_WORKFLOW.get(operationId);
    if (instance.id !== operationId) return { status: "unknown" };
    const observed: unknown = await instance.status();
    const status = readResearchEngineStatusValue((observed as { readonly status?: unknown }).status);
    const failureCode = status === "errored" ? readResearchNativeFailureCode(observed) : undefined;
    return { status, ...(failureCode === undefined ? {} : { failure_code: failureCode }) };
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
  const nativeStage = engine.failure_code?.startsWith("RESEARCH_QUALIFICATION_RENEWAL_")
    ? undefined : RESEARCH_WORKFLOW_STAGES[status.next_stage_index];
  const native = engine.failure_code === undefined ? undefined : {
    code: engine.failure_code, ...(nativeStage === undefined ? {} : { stage: nativeStage }),
  };
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
