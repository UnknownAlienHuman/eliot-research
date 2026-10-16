import type { ResearchCatalogModelUseRequest, ResearchCatalogModelUseReceipt, ResearchProjectModelConfiguration,
  ResearchRunProjectConfigurationPinV4 } from "@eliotr/owner-api-client";
import { isWorkspaceRequestError, type BoundWorkspaceApis } from "../app/runtime";
import type { ModelCatalogEntry } from "./modelCatalog";
import { ChatModelSelectionClosedError, configurationMatchesChatModel } from "./chatModelSelection";

type ModelsApi = BoundWorkspaceApis["connections"]["models"];
type CatalogUseApi = BoundWorkspaceApis["connections"]["catalogModelUse"];
export type ChatCatalogModelUseProblem = "unsupported" | "unavailable" | "conflict" | "blocked";
export interface ChatCatalogModelUseIntent {
  readonly projectId: string;
  readonly request: ResearchCatalogModelUseRequest;
  readonly phase: "pending" | "unknown" | "selected" | "blocked" | "conflict";
  readonly receipt?: ResearchCatalogModelUseReceipt;
  readonly problem?: ChatCatalogModelUseProblem;
}
export class ChatCatalogModelUseUnconfirmedError extends Error {}
export class ChatCatalogModelUseDiscoveredError extends Error {
  constructor(public readonly receipt: ResearchCatalogModelUseReceipt) { super('An existing catalog model operation must be reconciled'); }
}
export class ChatCatalogModelUseUnavailableError extends Error {
  constructor(public readonly problem: ChatCatalogModelUseProblem) { super("Selected model is unavailable"); }
}

export function chatCatalogModelUseNeedsReadback(intent: ChatCatalogModelUseIntent | undefined): boolean {
  return intent?.phase === "pending" || intent?.phase === "unknown";
}
export function chatCatalogModelUseMatches(intent: ChatCatalogModelUseIntent,
  choice: Pick<ModelCatalogEntry, "provider_id" | "model_id">, providerOperationId: string | null): boolean {
  return intent.request.provider_id === choice.provider_id && intent.request.model_id === choice.model_id &&
    intent.request.provider_operation_id === providerOperationId;
}

export const catalogModelUseReceiptProblem = (receipt: ResearchCatalogModelUseReceipt): ChatCatalogModelUseProblem =>
  receipt.failure_code === "MODEL_NOT_SUPPORTED" ? "unsupported" : receipt.state === "conflict" ? "conflict"
    : receipt.failure_code === "SERVER_POLICY_UNAVAILABLE" || receipt.failure_code === "PROVIDER_NOT_CONFIGURED"
      ? "unavailable" : "blocked";

function configurationPin(configuration: ResearchProjectModelConfiguration, projectId: string,
  model: Pick<ModelCatalogEntry, 'provider_id' | 'model_id'>, receipt?: ResearchCatalogModelUseReceipt): ResearchRunProjectConfigurationPinV4 {
  const selected = configuration.selected, revision = configuration.selection_revision;
  if (configuration.project_id !== projectId || !selected || selected.qualification_state !== 'qualified' ||
      !configurationMatchesChatModel(selected, model) || revision === null || !Number.isSafeInteger(revision) || revision < 1 ||
      selected.configuration_ref !== `rpmc-${selected.configuration_sha256}` || (receipt && (
        selected.configuration_ref !== receipt.selected_configuration_ref || selected.configuration_sha256 !== receipt.selected_configuration_sha256 ||
        revision !== receipt.selection_revision))) throw new ChatCatalogModelUseUnconfirmedError();
  return Object.freeze({ configuration_project_id: projectId, configuration_ref: selected.configuration_ref,
    configuration_sha256: selected.configuration_sha256, selection_revision: revision });
}

export interface ChatCatalogModelOperationReadback {
  readonly receipt: ResearchCatalogModelUseReceipt;
  readonly selection: ResearchRunProjectConfigurationPinV4 | null;
}

/** Restore a server-identified operation after private browser memory is gone. This capability has
 * no start method and cannot manufacture the original CAS revision or a replacement request.
 * The caller must present/hold this operation before offering any new model-selection mutation.
 */
export async function readDiscoveredCatalogModelOperation(input: {
  readonly api: Pick<CatalogUseApi, 'readResearchCatalogModelUse'>;
  readonly models: Pick<ModelsApi, 'readResearchProjectModelConfiguration'>;
  readonly projectId: string; readonly generation: string; readonly operationId: string;
  readonly signal: AbortSignal; readonly isCurrent: () => boolean;
}): Promise<ChatCatalogModelOperationReadback> {
  const assertCurrent = () => { if (input.signal.aborted || !input.isCurrent()) throw new ChatModelSelectionClosedError(); };
  assertCurrent();
  const receipt = await input.api.readResearchCatalogModelUse(input.projectId, input.generation, input.operationId, input.signal);
  assertCurrent();
  const builtin = receipt.provider_id === 'cloudflare-workers-ai';
  if (receipt.project_id !== input.projectId || receipt.operation_id !== input.operationId ||
      builtin !== (receipt.provider_operation_id === null) || (builtin && !receipt.model_id.startsWith('@cf/'))) {
    throw new ChatCatalogModelUseUnconfirmedError();
  }
  if (receipt.state !== 'selected') return Object.freeze({ receipt, selection: null });
  const configuration = await input.models.readResearchProjectModelConfiguration(input.projectId, input.generation,
    { limit: 1 }, input.signal);
  assertCurrent();
  return Object.freeze({ receipt, selection: configurationPin(configuration, input.projectId, receipt, receipt) });
}

/** Prepare one catalog choice using the existing global connection, then prove its exact project selection.
 * The caller persists the frozen request before dispatch. Held intents are GET-only, including uncertain
 * qualifications: no remount, status check or retry generates another operation or repeats qualification.
 */
export async function prepareCatalogChatModelSelection(input: {
  readonly api: CatalogUseApi; readonly models: ModelsApi; readonly projectId: string; readonly generation: string;
  readonly modelChoice: Pick<ModelCatalogEntry, "provider_id" | "model_id">;
  readonly providerOperationId: string | null;
  readonly signal: AbortSignal; readonly isCurrent: () => boolean; readonly readOnly?: boolean;
  readonly mintOperationId: () => string;
  readonly readIntent: () => ChatCatalogModelUseIntent | undefined;
  readonly writeIntent: (intent: ChatCatalogModelUseIntent) => void;
}): Promise<ResearchRunProjectConfigurationPinV4> {
  const assertCurrent = () => { if (input.signal.aborted || !input.isCurrent()) throw new ChatModelSelectionClosedError(); };
  assertCurrent();
  const held = input.readIntent();
  if (held && (held.projectId !== input.projectId || !chatCatalogModelUseMatches(held, input.modelChoice, input.providerOperationId))) {
    throw new ChatCatalogModelUseUnconfirmedError();
  }
  if (held?.phase === "blocked" || held?.phase === "conflict") {
    throw new ChatCatalogModelUseUnavailableError(held.problem ?? "blocked");
  }
  const readConfiguration = async () => {
    assertCurrent();
    const result = await input.models.readResearchProjectModelConfiguration(input.projectId, input.generation,
      { limit: 1 }, input.signal);
    assertCurrent();
    if (result.project_id !== input.projectId) throw new ChatCatalogModelUseUnconfirmedError();
    return result;
  };
  const pin = (configuration: ResearchProjectModelConfiguration, receipt?: ResearchCatalogModelUseReceipt) =>
    configurationPin(configuration, input.projectId, input.modelChoice, receipt);
  let intent: ChatCatalogModelUseIntent;
  if (held) intent = held;
  else {
    if (input.readOnly) throw new ChatCatalogModelUseUnconfirmedError();
    const configuration = await readConfiguration();
    if (configuration.selected?.qualification_state === "qualified" && configurationMatchesChatModel(configuration.selected, input.modelChoice)) {
      return pin(configuration);
    }
    const current = await input.api.readCurrentResearchCatalogModelUse(input.projectId, input.generation, input.signal);
    assertCurrent();
    if (current !== null) throw new ChatCatalogModelUseDiscoveredError(current);
    intent = Object.freeze({ projectId: input.projectId, phase: "pending", request: Object.freeze({
      protocol: "eliotr.research.catalog-model-use-request.v1", operation_id: input.mintOperationId(),
      expected_selection_revision: configuration.selection_revision, provider_id: input.modelChoice.provider_id,
      model_id: input.modelChoice.model_id, provider_operation_id: input.providerOperationId,
    }) });
    assertCurrent(); input.writeIntent(intent); assertCurrent();
    if (JSON.stringify(input.readIntent()?.request) !== JSON.stringify(intent.request)) throw new ChatModelSelectionClosedError();
  }
  const publish = (update: Omit<ChatCatalogModelUseIntent, "projectId" | "request">) => {
    assertCurrent();
    input.writeIntent(Object.freeze({ projectId: intent.projectId, request: intent.request, ...update }));
  };
  let startError: unknown;
  if (!held) {
    try {
      await input.api.startResearchCatalogModelUse(input.projectId, input.generation, intent.request, input.signal);
      assertCurrent();
    } catch (error) { assertCurrent(); startError = error; }
  }
  if (isWorkspaceRequestError(startError) && startError.status === 409 && startError.code === 'RESEARCH_CATALOG_MODEL_USE_UNRESOLVED') {
    let current: ResearchCatalogModelUseReceipt | null = null;
    try { current = await input.api.readCurrentResearchCatalogModelUse(input.projectId, input.generation, input.signal); }
    catch { assertCurrent(); }
    assertCurrent();
    if (current !== null) {
      publish({ phase: 'conflict', problem: 'conflict' });
      throw new ChatCatalogModelUseDiscoveredError(current);
    }
  }
  let receipt: ResearchCatalogModelUseReceipt;
  try {
    receipt = await input.api.readResearchCatalogModelUse(input.projectId, input.generation, intent.request.operation_id, input.signal);
    assertCurrent();
  } catch {
    assertCurrent();
    const problem = isWorkspaceRequestError(startError) && startError.status < 500
      ? startError.code === "RESEARCH_CATALOG_MODEL_USE_MODEL_UNSUPPORTED" ? "unsupported"
        : startError.code === "RESEARCH_CATALOG_MODEL_USE_PROVIDER_UNAVAILABLE" ? "unavailable"
          : startError.code === "RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID" && startError.status === 409 ? "conflict" : undefined
      : undefined;
    if (problem) { publish({ phase: problem === "conflict" ? "conflict" : "blocked", problem }); throw new ChatCatalogModelUseUnavailableError(problem); }
    publish({ phase: "unknown" }); throw new ChatCatalogModelUseUnconfirmedError();
  }
  if (receipt.project_id !== input.projectId || receipt.operation_id !== intent.request.operation_id ||
      receipt.provider_id !== intent.request.provider_id || receipt.model_id !== intent.request.model_id ||
      receipt.provider_operation_id !== intent.request.provider_operation_id) {
    publish({ phase: "unknown" }); throw new ChatCatalogModelUseUnconfirmedError();
  }
  if (receipt.state === "blocked" || receipt.state === "conflict") {
    const problem = catalogModelUseReceiptProblem(receipt);
    publish({ phase: receipt.state, receipt, problem }); throw new ChatCatalogModelUseUnavailableError(problem);
  }
  if (receipt.state !== "selected") {
    publish({ phase: "unknown", receipt }); throw new ChatCatalogModelUseUnconfirmedError();
  }
  try {
    const selection = pin(await readConfiguration(), receipt);
    publish({ phase: "selected", receipt });
    return selection;
  } catch (error) {
    assertCurrent(); publish({ phase: "unknown", receipt }); throw error;
  }
}
