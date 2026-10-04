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
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { PinnedModelSelection } from "@eliotr/cloudflare-model-control";
import { createResearchProviderNativeModelAuthority } from "./research-provider-native-model-authority.js";
import { createResearchProviderNativeModelCurrentScopeReader } from "./research-provider-native-model-current-scope.js";
import type { Env } from "./env.js";
import type { ResearchRunModelSelection } from "./research-run-configuration.js";

type NativeStage = ProviderNativeModelSelectionV1["stage"];

interface NativeRunConfiguration {
  readonly mode: "legacy-installed" | "snapshot-v1" | "snapshot-v2";
  readonly configuration_ref?: string | null;
  readonly configuration_sha256?: string | null;
  readonly project_owner_ref?: string | null;
  readonly project_id?: string | null;
  readonly model_selections?: readonly ResearchRunModelSelection[];
}

interface RouteAuthority {
  resolve(routeRef: string): Promise<unknown | null>;
  resolvePinned?(
    deployment: ModelRouteDeployment,
    selection: PinnedModelSelection,
    options?: Readonly<{ allow_expired_qualification?: boolean }>,
  ): Promise<unknown | null>;
}
type RouteAuthorityPinnedResolver = NonNullable<RouteAuthority["resolvePinned"]>;

function selectionsByStage(raw: readonly ResearchRunModelSelection[] | undefined): ReadonlyMap<NativeStage, ProviderNativeModelSelectionV1> {
  const result = new Map<NativeStage, ProviderNativeModelSelectionV1>();
  for (const item of raw ?? []) {
    if (item.candidate_kind !== "provider-native-v1") continue;
    const selection = decodeProviderNativeModelSelection(item);
    if (result.has(selection.stage)) throw new Error("run configuration repeats a Native model stage");
    result.set(selection.stage, selection);
  }
  return result;
}

function sameDynamicPin(dynamic: PinnedModelSelection, native: ProviderNativeModelSelectionV1): boolean {
  return dynamic.route_ref === native.route_ref && dynamic.route_version === native.route_version &&
    dynamic.candidate_ref === native.candidate_ref && dynamic.candidate_sha256 === native.candidate_sha256 &&
    dynamic.qualification_ref === native.qualification_ref &&
    dynamic.qualification_sha256 === native.qualification_sha256;
}

/**
 * Composes the captured Native selections into the existing server-owned model
 * path. Legacy and DynamicRoute selections continue to use their original ports.
 */
export function createResearchSemanticNativeModelRuntime(input: {
  readonly env: Pick<Env, "CORE_DB" | "AI_GATEWAY_REASONING_URL">;
  readonly run_configuration: NativeRunConfiguration | undefined;
  readonly owner_ref: string;
}): Readonly<{
  readonly selections: ReadonlyMap<NativeStage, ProviderNativeModelSelectionV1>;
  readonly authority: Pick<ProviderNativeModelAuthorityPort, "resolvePinned"> | undefined;
  resolvePinned(stage: NativeStage): Promise<ResolvedProviderNativeModelSelectionV1 | undefined>;
  pricingForStage(stage: NativeStage): Promise<ModelGatewayPricingPort | undefined>;
  profileRouteAuthority(routeAuthority: RouteAuthority): RouteAuthority;
}> {
  const selections = selectionsByStage(input.run_configuration?.model_selections);
  if (selections.size === 0) {
    return Object.freeze({
      selections,
      authority: undefined,
      async resolvePinned() { return undefined; },
      async pricingForStage() { return undefined; },
      profileRouteAuthority(routeAuthority) { return routeAuthority; },
    });
  }
  const run = input.run_configuration;
  if (run?.mode !== "snapshot-v2" || typeof run.project_owner_ref !== "string" ||
      run.project_owner_ref !== input.owner_ref || typeof run.project_id !== "string" ||
      run.project_id.length === 0) {
    throw new Error("Native model selection lacks its captured snapshot-v2 owner/project binding");
  }
  const authority = createResearchProviderNativeModelAuthority({
    env: input.env,
    current_scope: createResearchProviderNativeModelCurrentScopeReader({
      database: input.env.CORE_DB,
      owner_ref: run.project_owner_ref,
      project_id: run.project_id,
      model_selections: [...selections.values()],
    }),
  });
  const resolvePinned = async (stage: NativeStage): Promise<ResolvedProviderNativeModelSelectionV1 | undefined> => {
    const selection = selections.get(stage);
    if (selection === undefined) return undefined;
    return authority.resolvePinned({ selection, owner_ref: run.project_owner_ref as string,
      project_id: run.project_id as string, allow_expired_snapshot_v2: true });
  };
  return Object.freeze({
    selections,
    authority,
    resolvePinned,
    async pricingForStage(stage) {
      const resolved = await resolvePinned(stage);
      return resolved === undefined ? undefined : createProviderNativeModelZeroPricePort(
        resolved.candidate.candidate.preparation,
        resolved.pricing_snapshot,
      );
    },
    profileRouteAuthority(routeAuthority) {
      return Object.freeze({
        resolve: (routeRef: string) => routeAuthority.resolve(routeRef),
        async resolvePinned(
          deployment: Parameters<RouteAuthorityPinnedResolver>[0],
          selection: Parameters<RouteAuthorityPinnedResolver>[1],
          options?: Parameters<RouteAuthorityPinnedResolver>[2],
        ) {
          const native = selections.get("SYNTHESIZE");
          if (native === undefined) {
            return routeAuthority.resolvePinned?.(deployment, selection, options) ?? null;
          }
          if (!sameDynamicPin(selection, native)) {
            throw new Error("model-profile pin differs from the captured Native synthesis selection");
          }
          const resolved = await resolvePinned("SYNTHESIZE");
          if (resolved === undefined || canonicalModelGatewayJson(resolved.candidate.candidate.preparation.deployment) !==
              canonicalModelGatewayJson(deployment)) {
            throw new Error("Native synthesis deployment differs from the model-profile pin");
          }
          return resolved.candidate.candidate.preparation.deployment;
        },
      });
    },
  });
}
