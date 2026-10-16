import type { ResearchModelConfigurationRevision, ResearchProjectModelConfiguration, ServiceModelCatalogPage } from "@eliotr/owner-api-client";
import { researchModelCatalogAdapterForRouteProvider } from "@eliotr/owner-api-client";
import type { ServiceModelCatalogPreferences, ServiceModelProviderConnectionV2 } from "./globalModelSettings";
import { isModelCatalogEntryVisible, modelCatalogEntryKey, type ModelCatalogEntry } from "./modelCatalog";
import { configurationMatchesChatModel } from "./chatModelSelection";

export type ChatModelCatalogSlice = Readonly<{
  /** Request selector; the response retains its canonical catalog adapter identity. */
  readonly catalogProviderId: string;
  readonly preferenceProviderId: string;
  readonly providerLabel?: string;
  readonly connection?: ServiceModelProviderConnectionV2;
  readonly catalog?: ServiceModelCatalogPage;
  readonly preferences?: ServiceModelCatalogPreferences;
  readonly builtin?: Readonly<{ bindingAvailable: boolean; defaultModelId: string }>;
}>;

export type ChatModelOption = Readonly<{
  readonly model: ModelCatalogEntry;
  readonly providerLabel: string;
  readonly key: string;
  readonly canRun: boolean;
  readonly unavailableReason?: "project-configuration" | "qualification" | "builtin-default";
  readonly candidate?: ResearchModelConfigurationRevision;
  readonly builtin: boolean;
  /** Existing global connection operation; null is the built-in Workers AI binding. */
  readonly providerOperationId?: string | null;
  readonly availabilityCheckRequired?: boolean;
}>;

function projectCandidates(
  configuration: ResearchProjectModelConfiguration | undefined,
  model: ModelCatalogEntry,
): readonly ResearchModelConfigurationRevision[] {
  if (!configuration) return [];
  const revisions = new Map<string, ResearchModelConfigurationRevision>();
  for (const revision of [...configuration.revisions, ...(configuration.selected ? [configuration.selected] : [])]) {
    if (configurationMatchesChatModel(revision, model)) revisions.set(revision.configuration_ref, revision);
  }
  return [...revisions.values()];
}

function bestProjectCandidate(
  candidates: readonly ResearchModelConfigurationRevision[],
  selected: ResearchModelConfigurationRevision | null | undefined,
): ResearchModelConfigurationRevision | undefined {
  return [...candidates].sort((left, right) => {
    const preferenceRank = (revision: ResearchModelConfigurationRevision) => {
      if (revision.configuration_ref === selected?.configuration_ref && revision.qualification_state === "qualified") return 0;
      if (revision.qualification_state === "qualified") return 1;
      if (revision.configuration_ref === selected?.configuration_ref) return 2;
      return 3;
    };
    return preferenceRank(left) - preferenceRank(right) ||
      right.created_at.localeCompare(left.created_at) || left.configuration_ref.localeCompare(right.configuration_ref);
  })[0];
}

/**
 * Intersects the public service catalog with saved owner visibility and exact project model
 * configurations. An exact configured connection allows one selected-model preparation; its
 * qualification is still decided server-side before a run is admitted. Cloudflare's built-in
 * choices require the native binding. The server checks the exact selected model before admitting a run.
 */
export function buildChatModelOptions(input: {
  readonly slices: readonly ChatModelCatalogSlice[];
  readonly configuration?: ResearchProjectModelConfiguration;
}): readonly ChatModelOption[] {
  const options = new Map<string, ChatModelOption>();
  for (const slice of input.slices) {
    const { catalog, preferences } = slice;
    if (!catalog || !preferences || preferences.provider_id !== slice.preferenceProviderId ||
        catalog.provider_id !== researchModelCatalogAdapterForRouteProvider(slice.catalogProviderId)) continue;
    if (slice.builtin === undefined && (slice.connection?.provider_id !== slice.preferenceProviderId ||
        slice.connection.status !== "configured")) continue;

    for (const model of catalog.models) {
      if (model.provider_id !== catalog.provider_id) continue;
      if (!isModelCatalogEntryVisible(preferences.visibility, model.model_id)) continue;
      const key = modelCatalogEntryKey(model);
      const providerLabel = slice.providerLabel ?? model.provider_id;
      if (slice.builtin !== undefined) {
        const canRun = slice.builtin.bindingAvailable;
        const candidate = bestProjectCandidate(projectCandidates(input.configuration, model), input.configuration?.selected);
        options.set(key, Object.freeze({ model, providerLabel, key, canRun, builtin: true, providerOperationId: null,
          ...(candidate?.qualification_state === "qualified" ? { candidate } : { availabilityCheckRequired: true }),
          ...(!canRun ? { unavailableReason: "builtin-default" as const } : {}) }));
        continue;
      }

      const candidates = projectCandidates(input.configuration, model);
      const candidate = bestProjectCandidate(candidates, input.configuration?.selected);
      const connection = slice.connection;
      // 0158 records fresh consent for this exact catalog pair against the saved connection.
      // Legacy registrations remain unchanged; their allowlist is not the consent for this new flow.
      const canRun = connection?.operation_id !== undefined;
      options.set(key, Object.freeze({ model, providerLabel, key, canRun, builtin: false,
        ...(candidate === undefined ? {} : { candidate }),
        ...(connection?.operation_id === undefined ? {} : { providerOperationId: connection.operation_id }),
        ...(candidate?.qualification_state === "qualified" ? {} : { availabilityCheckRequired: true }),
        ...(canRun ? {} : { unavailableReason: "qualification" as const }) }));
    }
  }
  return Object.freeze([...options.values()]);
}

export function hasOpenRouterQualificationCandidate(configuration: ResearchProjectModelConfiguration | undefined): boolean {
  if (!configuration) return false;
  return [...configuration.revisions, ...(configuration.selected ? [configuration.selected] : [])]
    .some(revision => revision.qualification_state === "qualification_required" &&
      revision.model_selections.some(selection => selection.stage === "SYNTHESIZE" && selection.provider_id === "openrouter"));
}

export function latestConfiguredOpenRouterKeyOperationId(input: {
  readonly configurations: readonly Readonly<{ operation_id: string; status: string; updated_at: string }>[];
  readonly truncated: boolean;
}): string | undefined {
  if (input.truncated) return undefined;
  return [...input.configurations]
    .filter(configuration => configuration.status === "configured_not_qualified")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.operation_id.localeCompare(right.operation_id))[0]
    ?.operation_id;
}
