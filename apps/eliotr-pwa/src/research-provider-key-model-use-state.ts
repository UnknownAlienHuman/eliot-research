import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import type { ResearchProviderKeyConfiguration } from "./research-provider-key-api.js";
import type {
  ResearchProviderKeyModelUseFailureCode,
  ResearchProviderKeyModelUseOperation,
  ResearchProviderKeyModelUsePhase,
  ResearchProviderKeyModelUseState,
  ResearchProviderKeyModelUseSelection,
} from "./research-provider-key-model-use-api.js";

export interface ResearchProviderKeyModelUsePanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
  readonly ownerSessionScopeEpoch: () => number | undefined;
}

export type RecoveryRecord = Readonly<{
  protocol: "eliotr.research-provider-key-model-use-recovery.v1";
  project_id: string;
  project_scope_ref: string;
  deployment_generation: string;
  operation_id: string;
  key_operation_id: string;
}>;

export type Tone = "unknown" | "pending" | "configured" | "selected" | "blocked";

export const RECOVERY_PROTOCOL = "eliotr.research-provider-key-model-use-recovery.v1" as const;
const RECOVERY_PREFIX = "eliotr.provider-key.model-use.v1:";
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function currentGeneration(options: ResearchProviderKeyModelUsePanelOptions): string | undefined {
  const value = options.deploymentGeneration();
  return value === undefined || value === "" || value === "unreachable" ? undefined : value;
}

export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function storageKey(projectId: string): string {
  return `${RECOVERY_PREFIX}${encodeURIComponent(projectId)}`;
}

function decodeRecovery(value: unknown, projectId: string): RecoveryRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const keys = ["protocol", "project_id", "project_scope_ref", "deployment_generation", "operation_id", "key_operation_id"];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)) ||
      keys.some((key) => !keys.includes(key)) || raw.protocol !== RECOVERY_PROTOCOL || raw.project_id !== projectId ||
      raw.project_scope_ref !== `project:${projectId}` || typeof raw.deployment_generation !== "string" ||
      raw.deployment_generation.length === 0 || raw.deployment_generation.length > 256 ||
      !OPERATION_ID.test(String(raw.operation_id)) || !OPERATION_ID.test(String(raw.key_operation_id))) return undefined;
  return Object.freeze({ protocol: RECOVERY_PROTOCOL, project_id: projectId, project_scope_ref: `project:${projectId}`,
    deployment_generation: raw.deployment_generation, operation_id: raw.operation_id as string,
    key_operation_id: raw.key_operation_id as string });
}

export function readRecovery(projectId: string): RecoveryRecord | undefined {
  try {
    const text = window.sessionStorage.getItem(storageKey(projectId));
    if (text === null) return undefined;
    const record = decodeRecovery(JSON.parse(text) as unknown, projectId);
    if (record === undefined) window.sessionStorage.removeItem(storageKey(projectId));
    return record;
  } catch {
    return undefined;
  }
}

export function writeRecovery(record: RecoveryRecord): boolean {
  try {
    window.sessionStorage.setItem(storageKey(record.project_id), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearRecovery(projectId: string | undefined): void {
  if (projectId === undefined) return;
  try {
    window.sessionStorage.removeItem(storageKey(projectId));
  } catch {
    // The panel still clears in-memory private state when browser storage is unavailable.
  }
}

export function clearAllRecoveries(): void {
  try {
    const keys = Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(RECOVERY_PREFIX));
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // The owner transition still clears all in-memory operation state.
  }
}

export function phaseLabel(phase: ResearchProviderKeyModelUsePhase): string {
  switch (phase) {
    case "intent": return "request recorded";
    case "native_prepare": return "preparing the exact route";
    case "free_price_check": return "checking the free-price policy";
    case "native_qualify": return "checking exact route qualification";
    case "configuration_import": return "importing the qualified configuration";
    case "selection_readback": return "checking selected-configuration readback";
    case "complete": return "server workflow complete";
  }
}

export function stateLabel(state: ResearchProviderKeyModelUseState): string {
  switch (state) {
    case "accepted": return "Accepted";
    case "preparing": return "Preparing";
    case "qualifying": return "Qualifying";
    case "importing": return "Importing configuration";
    case "selected": return "Selection reported";
    case "blocked": return "Blocked; previous selection retained";
    case "uncertain": return "Outcome uncertain; do not retry";
    case "conflict": return "Selection conflict; previous selection retained";
  }
}

export function failureCopy(code: ResearchProviderKeyModelUseFailureCode): string {
  switch (code) {
    case "NO_SELECTED_CONFIGURATION": return "No compatible trusted baseline was available. Nothing was selected.";
    case "FREE_PRICE_NOT_PROVEN": return "The server could not prove a free price. No paid fallback was attempted.";
    case "FREE_PRICE_NOT_ZERO": return "The server found a nonzero price. No paid fallback was attempted.";
    case "PREPARATION_REJECTED": return "The exact route could not be prepared. The prior selection was retained.";
    case "QUALIFICATION_NO_EFFECT": return "Qualification did not complete. The prior selection was retained.";
    case "QUALIFICATION_OUTCOME_UNCERTAIN": return "Qualification may have been dispatched. Do not retry; refresh this exact operation.";
    case "NATIVE_RECEIPT_INVALID": return "The server could not verify the provider receipt. The prior selection was retained.";
    case "SELECTION_CAS_CONFLICT": return "The project selection changed during this operation. Refresh current selection before another action.";
    case "AUTHORITY_CHANGED": return "Project authority changed. Reverify the owner session before reading this operation.";
    case "STORAGE_UNAVAILABLE": return "The operation could not be durably recorded. Its outcome needs an exact status check.";
    case "SERVER_POLICY_UNAVAILABLE": return "No compatible trusted server-side model configuration is available. Nothing was selected.";
  }
}

export function errorCopy(error: unknown, action: "read" | "start" | "status"): Readonly<{ summary: string; detail: string }> {
  if (error instanceof ApiRequestError && isAuthorizationLoss(error)) return {
    summary: "Verify the owner session before using this key.",
    detail: action === "start" ? "The exact operation was not automatically retried. Reverify access before checking its status." :
      "The current session cannot read this project's provider-key operation.",
  };
  if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") return {
    summary: "The server deployment changed during this request.",
    detail: action === "start" ? "Do not start another operation. Refresh the exact status after the current deployment is ready." :
      "Refresh this exact operation using the current server before making another selection.",
  };
  if (action === "start") return {
    summary: "The check-and-use result is not confirmed.",
    detail: "Refresh this exact operation. The page will not submit it again or send the key to this endpoint.",
  };
  if (action === "status") return {
    summary: "The exact check-and-use status is unavailable.",
    detail: "The operation ID is retained for another explicit status read. No model request was sent by this refresh.",
  };
  return {
    summary: "Provider-key or selected-model status could not be read.",
    detail: "Reconnect and verify the owner session, then refresh status. No check-and-use request was sent.",
  };
}

export function keyStatusLabel(status: ResearchProviderKeyConfiguration["status"]): string {
  switch (status) {
    case "configured_not_qualified": return "Key saved · model not qualified";
    case "pending": return "Key setup pending";
    case "not_configured": return "Key not saved";
    case "outcome_unknown": return "Key setup outcome unknown";
  }
}

export function useIsActive(operation: ResearchProviderKeyModelUseOperation | undefined): boolean {
  return operation !== undefined && (operation.state === "accepted" || operation.state === "preparing" ||
    operation.state === "qualifying" || operation.state === "importing" || operation.state === "uncertain");
}

export function selectionLabel(selection: ResearchProviderKeyModelUseSelection | undefined): string {
  if (selection === undefined) return "Current project model selection has not been checked.";
  if (selection.selection_revision === null) {
    return "No project model is selected. The server may use a trusted installed baseline if available; the page does not create or send a model configuration.";
  }
  return selection.qualification_state === "qualified"
    ? `Current project selection revision ${selection.selection_revision} remains in place until exact server readback confirms a change.`
    : `Current project selection revision ${selection.selection_revision} needs qualification; this action does not imply it is ready.`;
}
