import { researchModelCatalogAdapterForRouteProvider, type ResearchModelConfigurationRevision,
  type ResearchRunBuiltinCloudflareSelectionV4, type ResearchRunProjectConfigurationPinV4, type ResearchRunV4Request } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { ModelCatalogEntry } from "./modelCatalog";

type ModelApi = BoundWorkspaceApis["connections"]["models"];
type RunsApi = BoundWorkspaceApis["research"]["runs"];

export class ChatModelSelectionClosedError extends Error {}
export class ChatModelSelectionUnconfirmedError extends Error {}
export class ChatModelQualificationRequiredError extends Error {}
export class ChatModelQualificationUnconfirmedError extends Error {
  constructor(public readonly keyOperationId: string, public readonly operationId: string) {
    super("Selected model qualification is not confirmed");
  }
}

const assertCurrent = (signal: AbortSignal, isCurrent: () => boolean) => {
  if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
};

function matchesCandidate(
  configuration: Awaited<ReturnType<ModelApi["readResearchProjectModelConfiguration"]>>,
  projectId: string,
  candidate: ResearchModelConfigurationRevision,
): boolean {
  return configuration.project_id === projectId && configuration.selected?.qualification_state === "qualified" &&
    configuration.selected.configuration_ref === candidate.configuration_ref &&
    configuration.selected.configuration_sha256 === candidate.configuration_sha256;
}

function sameStageModels(left: ResearchModelConfigurationRevision, right: ResearchModelConfigurationRevision): boolean {
  const identity = (revision: ResearchModelConfigurationRevision) => revision.model_selections
    .map(selection => `${selection.stage}\u0000${selection.provider_id}\u0000${selection.model_id}`).sort();
  const leftModels = identity(left), rightModels = identity(right);
  return leftModels.length === rightModels.length && leftModels.every((model, index) => model === rightModels[index]);
}

export function configurationMatchesChatModel(
  configuration: ResearchModelConfigurationRevision,
  model: Pick<ModelCatalogEntry, "provider_id" | "model_id">,
): boolean {
  const synthesis = configuration.model_selections.filter(selection => selection.stage === "SYNTHESIZE");
  return synthesis.length === 1 && synthesis[0]?.model_id === model.model_id &&
    synthesis[0]?.provider_id !== undefined &&
    researchModelCatalogAdapterForRouteProvider(synthesis[0].provider_id) === model.provider_id;
}

/**
 * Select one saved model configuration and build the strict v4 run body only after readback proves
 * the exact synthesis candidate, qualified configuration digest, and selection revision. An
 * unqualified configuration can run only through the caller's existing protected model-use API.
 */
export async function prepareChatModelRunV4(input: {
  readonly models: ModelApi;
  readonly runs: RunsApi;
  readonly projectId: string;
  readonly generation: string;
  readonly candidate: ResearchModelConfigurationRevision;
  readonly modelChoice: Pick<ModelCatalogEntry, "provider_id" | "model_id">;
  readonly request: Omit<ResearchRunV4Request, "selection">;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly mintSelectionOperation: () => string;
  readonly modelUse?: {
    readonly api: Pick<BoundWorkspaceApis["connections"]["modelUse"],
      "startResearchProviderKeyModelUse" | "readResearchProviderKeyModelUse">;
    readonly keyOperationId: string;
    readonly mintOperationId: () => string;
  };
}): Promise<{ readonly body: string; readonly selection: ResearchRunProjectConfigurationPinV4 }> {
  assertCurrent(input.signal, input.isCurrent);
  if (!configurationMatchesChatModel(input.candidate, input.modelChoice)) throw new ChatModelSelectionUnconfirmedError();
  if (input.candidate.qualification_state !== "qualified" && input.modelUse === undefined) {
    throw new ChatModelQualificationRequiredError();
  }

  const readback = async () => {
    assertCurrent(input.signal, input.isCurrent);
    const configuration = await input.models.readResearchProjectModelConfiguration(input.projectId,
      input.generation, { limit: 1 }, input.signal);
    assertCurrent(input.signal, input.isCurrent);
    return configuration;
  };

  let observed = await readback();
  if (observed.project_id !== input.projectId) throw new ChatModelSelectionUnconfirmedError();
  const candidateAlreadySelected = observed.selected?.configuration_ref === input.candidate.configuration_ref &&
    observed.selected.configuration_sha256 === input.candidate.configuration_sha256;
  if (!candidateAlreadySelected) {
    const expectedRevision = observed.selection_revision;
    const operationId = input.mintSelectionOperation();
    try {
      const receipt = await input.models.selectResearchProjectModelConfiguration(input.projectId, input.generation,
        expectedRevision, input.candidate.configuration_ref, operationId, input.signal);
      assertCurrent(input.signal, input.isCurrent);
      if (receipt.project_id !== input.projectId || receipt.selected.configuration_ref !== input.candidate.configuration_ref ||
          receipt.selected.configuration_sha256 !== input.candidate.configuration_sha256 ||
          !Number.isSafeInteger(receipt.selection_revision) || receipt.selection_revision < 1) {
        throw new ChatModelSelectionUnconfirmedError();
      }
    } catch (error) {
      if (error instanceof ChatModelSelectionClosedError) throw error;
      assertCurrent(input.signal, input.isCurrent);
      // One exact readback reconciles a lost acknowledgement or CAS race; the write is never retried.
    }
    observed = await readback();
    if (observed.project_id !== input.projectId || observed.selected?.configuration_ref !== input.candidate.configuration_ref ||
        observed.selected.configuration_sha256 !== input.candidate.configuration_sha256) {
      throw new ChatModelSelectionUnconfirmedError();
    }
  }

  let qualifiedConfigurationRef = input.candidate.configuration_ref;
  let qualifiedConfigurationSha256 = input.candidate.configuration_sha256;
  if (observed.selected?.qualification_state !== "qualified") {
    if (input.modelUse === undefined || observed.selection_revision === null || observed.selection_revision < 1) {
      throw new ChatModelQualificationRequiredError();
    }
    const operationId = input.modelUse.mintOperationId();
    let operation: Awaited<ReturnType<BoundWorkspaceApis["connections"]["modelUse"]["startResearchProviderKeyModelUse"]>>;
    try {
      operation = await input.modelUse.api.startResearchProviderKeyModelUse(input.projectId, input.generation,
        input.modelUse.keyOperationId, operationId, observed.selection_revision, input.signal);
      assertCurrent(input.signal, input.isCurrent);
    } catch (error) {
      if (error instanceof ChatModelSelectionClosedError) throw error;
      assertCurrent(input.signal, input.isCurrent);
      try {
        operation = await input.modelUse.api.readResearchProviderKeyModelUse(input.projectId, input.generation,
          input.modelUse.keyOperationId, operationId, input.signal);
        assertCurrent(input.signal, input.isCurrent);
      } catch {
        assertCurrent(input.signal, input.isCurrent);
        throw new ChatModelQualificationUnconfirmedError(input.modelUse.keyOperationId, operationId);
      }
    }
    if (operation.state !== "selected") {
      try {
        operation = await input.modelUse.api.readResearchProviderKeyModelUse(input.projectId, input.generation,
          input.modelUse.keyOperationId, operationId, input.signal);
        assertCurrent(input.signal, input.isCurrent);
      } catch {
        assertCurrent(input.signal, input.isCurrent);
        throw new ChatModelQualificationUnconfirmedError(input.modelUse.keyOperationId, operationId);
      }
    }
    if (operation.state !== "selected" || operation.selected_configuration_ref === null || operation.selection_revision === null) {
      throw new ChatModelQualificationUnconfirmedError(input.modelUse.keyOperationId, operationId);
    }
    observed = await readback();
    if (observed.project_id !== input.projectId || observed.selection_revision !== operation.selection_revision ||
        observed.selected?.configuration_ref !== operation.selected_configuration_ref ||
        observed.selected.qualification_state !== "qualified" || !sameStageModels(input.candidate, observed.selected) ||
        !configurationMatchesChatModel(observed.selected, input.modelChoice)) {
      throw new ChatModelQualificationUnconfirmedError(input.modelUse.keyOperationId, operationId);
    }
    qualifiedConfigurationRef = observed.selected.configuration_ref;
    qualifiedConfigurationSha256 = observed.selected.configuration_sha256;
  } else if (!matchesCandidate(observed, input.projectId, input.candidate)) {
    throw new ChatModelSelectionUnconfirmedError();
  }

  const selectionRevision = observed.selection_revision;
  const selected = observed.selected;
  if (selected === null || selectionRevision === null || !Number.isSafeInteger(selectionRevision) || selectionRevision < 1 ||
      selected.qualification_state !== "qualified" || selected.configuration_ref !== qualifiedConfigurationRef ||
      selected.configuration_sha256 !== qualifiedConfigurationSha256) {
    throw new ChatModelSelectionUnconfirmedError();
  }
  const selection: ResearchRunProjectConfigurationPinV4 = {
    configuration_project_id: input.projectId,
    configuration_ref: selected.configuration_ref,
    configuration_sha256: selected.configuration_sha256,
    selection_revision: selectionRevision,
  };
  assertCurrent(input.signal, input.isCurrent);
  const body = input.runs.researchRunBodyV4({ ...input.request, selection });
  assertCurrent(input.signal, input.isCurrent);
  return Object.freeze({ body, selection: Object.freeze(selection) });
}

/** Build the no-key Cloudflare run only for the exact installed model observed in owner Settings. */
export function prepareBuiltinChatModelRunV4(input: {
  readonly runs: RunsApi;
  readonly request: Omit<ResearchRunV4Request, "selection">;
  readonly modelChoice: Pick<ModelCatalogEntry, "provider_id" | "model_id">;
  readonly bindingAvailable: boolean;
  readonly defaultModelId: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}): { readonly body: string; readonly selection: ResearchRunBuiltinCloudflareSelectionV4 } {
  assertCurrent(input.signal, input.isCurrent);
  if (input.modelChoice.provider_id !== researchModelCatalogAdapterForRouteProvider("workers-ai") || !input.bindingAvailable ||
      input.defaultModelId !== input.modelChoice.model_id) {
    throw new ChatModelSelectionUnconfirmedError();
  }
  const selection: ResearchRunBuiltinCloudflareSelectionV4 = Object.freeze({
    kind: "builtin",
    expected_model_id: input.modelChoice.model_id,
  });
  const body = input.runs.researchRunBodyV4({ ...input.request, selection });
  assertCurrent(input.signal, input.isCurrent);
  return Object.freeze({ body, selection });
}
