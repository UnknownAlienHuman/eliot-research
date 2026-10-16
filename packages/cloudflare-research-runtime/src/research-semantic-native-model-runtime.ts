import {
  canonicalModelGatewayJson,
  type ModelGatewayPricingPort,
} from "@eliotr/cloudflare-ai";
import {
  createProviderNativeModelZeroPricePort,
  decodeProviderNativeModelSelection,
  type ProviderNativeModelAuthorityPort,
  type ProviderNativeModelSelectionV1,
  type ResolvedProviderNativeModelSelectionV1,
} from "@eliotr/cloudflare-native-models";
import {
  decodeProviderNativeModelCatalogSelectionV2,
  type ProviderNativeModelCatalogSelectionV2,
  type ProviderNativeModelCatalogV2AuthorityPort,
  type ResolvedProviderNativeModelCatalogV2,
} from "@eliotr/cloudflare-native-models";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { PinnedModelSelection } from "@eliotr/cloudflare-model-control";
import type {
  ResearchRunConfigurationModeWithLegacy,
  ResearchRunModelSelection,
} from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";

type NativeStage = ProviderNativeModelSelectionV1["stage"];
type NativeSelection = ProviderNativeModelSelectionV1 | ProviderNativeModelCatalogSelectionV2;
type ResolvedNativeSelection = ResolvedProviderNativeModelSelectionV1 | ResolvedProviderNativeModelCatalogV2;

export interface ResearchSemanticNativeModelRunConfiguration {
  readonly mode: ResearchRunConfigurationModeWithLegacy;
  readonly configuration_ref?: string | null;
  readonly configuration_sha256?: string | null;
  readonly project_owner_ref?: string | null;
  readonly project_id?: string | null;
  readonly model_selections?: readonly ResearchRunModelSelection[];
}

export interface ResearchSemanticNativeModelRunContext {
  readonly project_owner_ref: string;
  readonly project_id: string;
  readonly selections: ReadonlyMap<NativeStage, NativeSelection>;
}

export interface ResearchSemanticRouteAuthority {
  resolve(routeRef: string): Promise<unknown | null>;
  resolvePinned?(
    deployment: ModelRouteDeployment,
    selection: PinnedModelSelection,
    options?: Readonly<{ allow_expired_qualification?: boolean }>,
  ): Promise<unknown | null>;
}

type RouteAuthorityPinnedResolver = NonNullable<ResearchSemanticRouteAuthority["resolvePinned"]>;

function selectionsByStage(
  raw: readonly ResearchRunModelSelection[] | undefined,
): ReadonlyMap<NativeStage, NativeSelection> {
  const result = new Map<NativeStage, NativeSelection>();
  for (const item of raw ?? []) {
    if (item.candidate_kind !== "provider-native-v1" && item.candidate_kind !== "provider-native-v2") continue;
    const selection = item.candidate_kind === "provider-native-v1"
      ? decodeProviderNativeModelSelection(item) : decodeProviderNativeModelCatalogSelectionV2(item);
    if (result.has(selection.stage)) throw new Error("run configuration repeats a Native model stage");
    result.set(selection.stage, selection);
  }
  return result;
}

/** Decode Native pins and validate the immutable snapshot binding before Core constructs authority. */
export function prepareResearchSemanticNativeModelRunContext(input: {
  readonly run_configuration: ResearchSemanticNativeModelRunConfiguration | undefined;
  readonly owner_ref: string;
}): ResearchSemanticNativeModelRunContext | undefined {
  const selections = selectionsByStage(input.run_configuration?.model_selections);
  if (selections.size === 0) return undefined;
  const run = input.run_configuration;
  if (run?.mode !== "snapshot-v2" || typeof run.project_owner_ref !== "string" ||
      run.project_owner_ref !== input.owner_ref || typeof run.project_id !== "string" ||
      run.project_id.length === 0) {
    throw new Error("Native model selection lacks its captured snapshot-v2 owner/project binding");
  }
  return Object.freeze({
    project_owner_ref: run.project_owner_ref,
    project_id: run.project_id,
    selections,
  });
}

function sameDynamicPin(dynamic: PinnedModelSelection, native: NativeSelection): boolean {
  return dynamic.route_ref === native.route_ref && dynamic.route_version === native.route_version &&
    dynamic.candidate_ref === native.candidate_ref && dynamic.candidate_sha256 === native.candidate_sha256 &&
    dynamic.qualification_ref === native.qualification_ref &&
    dynamic.qualification_sha256 === native.qualification_sha256;
}

/**
 * Composes the captured Native selections into the existing server-owned model
 * path. Core supplies the live authority; legacy and DynamicRoute selections
 * continue to use their original ports.
 */
export function createResearchSemanticNativeModelRuntime(input: Readonly<{
  context: ResearchSemanticNativeModelRunContext | undefined;
  authority: Pick<ProviderNativeModelAuthorityPort, "resolvePinned"> | undefined;
  catalog_authority: Pick<ProviderNativeModelCatalogV2AuthorityPort, "resolvePinned"> | undefined;
}>): Readonly<{
  readonly selections: ReadonlyMap<NativeStage, NativeSelection>;
  readonly authority: Pick<ProviderNativeModelAuthorityPort, "resolvePinned"> | undefined;
  readonly catalog_authority: Pick<ProviderNativeModelCatalogV2AuthorityPort, "resolvePinned"> | undefined;
  resolvePinned(stage: NativeStage): Promise<ResolvedNativeSelection | undefined>;
  pricingForStage(stage: NativeStage): Promise<ModelGatewayPricingPort | undefined>;
  profileRouteAuthority(routeAuthority: ResearchSemanticRouteAuthority): ResearchSemanticRouteAuthority;
}> {
  if (input.context === undefined && (input.authority !== undefined || input.catalog_authority !== undefined)) {
    throw new Error("Native model authorities require a captured run context");
  }
  const context = input.context;
  if (context === undefined) {
    const selections: ReadonlyMap<NativeStage, NativeSelection> = new Map();
    return Object.freeze({
      selections,
      authority: undefined,
      catalog_authority: undefined,
      async resolvePinned() { return undefined; },
      async pricingForStage() { return undefined; },
      profileRouteAuthority(routeAuthority) { return routeAuthority; },
    });
  }

  const authority = input.authority;
  const catalogAuthority = input.catalog_authority;
  const hasV1 = [...context.selections.values()].some((selection) => selection.candidate_kind === "provider-native-v1");
  const hasV2 = [...context.selections.values()].some((selection) => selection.candidate_kind === "provider-native-v2");
  if ((hasV1 && authority === undefined) || (hasV2 && catalogAuthority === undefined)) {
    throw new Error("A selected provider-native model authority is unavailable");
  }
  const resolvePinned = async (stage: NativeStage): Promise<ResolvedNativeSelection | undefined> => {
    const selection = context.selections.get(stage);
    if (selection === undefined) return undefined;
    if (selection.candidate_kind === "provider-native-v1") {
      if (authority === undefined) throw new Error("Provider-native v1 authority is unavailable");
      return authority.resolvePinned({ selection, owner_ref: context.project_owner_ref,
        project_id: context.project_id, allow_expired_snapshot_v2: true });
    }
    if (catalogAuthority === undefined) throw new Error("Provider-native v2 authority is unavailable");
    return catalogAuthority.resolvePinned({ selection, owner_ref: context.project_owner_ref,
      project_id: context.project_id, allow_expired_snapshot_v2: true });
  };
  return Object.freeze({
    selections: context.selections,
    authority,
    catalog_authority: catalogAuthority,
    resolvePinned,
    async pricingForStage(stage) {
      const resolved = await resolvePinned(stage);
      if (resolved === undefined) return undefined;
      return resolved.candidate.candidate.candidate_kind === "provider-native-v1"
        ? createProviderNativeModelZeroPricePort(resolved.candidate.candidate.preparation,
          (resolved as ResolvedProviderNativeModelSelectionV1).pricing_snapshot)
        : (resolved as ResolvedProviderNativeModelCatalogV2).pricing_port;
    },
    profileRouteAuthority(routeAuthority) {
      return Object.freeze({
        resolve: (routeRef: string) => routeAuthority.resolve(routeRef),
        async resolvePinned(
          deployment: Parameters<RouteAuthorityPinnedResolver>[0],
          selection: Parameters<RouteAuthorityPinnedResolver>[1],
          options?: Parameters<RouteAuthorityPinnedResolver>[2],
        ) {
          const native = context.selections.get("SYNTHESIZE");
          if (native === undefined) {
            return routeAuthority.resolvePinned?.(deployment, selection, options) ?? null;
          }
          if (!sameDynamicPin(selection, native)) {
            throw new Error("model-profile pin differs from the captured Native synthesis selection");
          }
          const resolved = await resolvePinned("SYNTHESIZE");
          const resolvedDeployment = resolved?.candidate.candidate.preparation.deployment;
          if (resolved === undefined || resolvedDeployment === undefined || canonicalModelGatewayJson(resolvedDeployment) !==
              canonicalModelGatewayJson(deployment)) {
            throw new Error("Native synthesis deployment differs from the model-profile pin");
          }
          return resolvedDeployment;
        },
      });
    },
  });
}
