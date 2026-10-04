import {
  createProviderNativeModelScopedAuthority,
  providerNativeModelFailure,
  type ProviderNativeModelAuthorityPort,
  type ProviderNativeModelCurrentScopeV1,
  type ProviderNativeModelKeyBindingReadRequestV1,
  type ReadProviderNativeModelConfiguredOperation,
  type ReadProviderNativeModelCurrentScope,
} from "@eliotr/cloudflare-native-models";
import type { ResearchModelPricingSnapshotStore } from "@eliotr/cloudflare-model-control";
import { installedGatewayIdentity } from "./research-provider-key-configuration-composition.js";
import type { Env } from "./env.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createResearchProviderKeyConfigurationService } from "./research-provider-key-configuration-service.js";
import { readResearchProviderKeyModelUseNativeScope } from "./research-provider-key-model-use-current-scope.js";
import type { ResearchProviderKeyModelUseDbPhase } from "./research-provider-key-model-use-store.js";

export type ResearchProviderNativeModelCurrentScopeV1 = ProviderNativeModelCurrentScopeV1;
export type ReadResearchProviderNativeModelCurrentScope = ReadProviderNativeModelCurrentScope;
export type ReadResearchProviderNativeModelConfiguredOperation = ReadProviderNativeModelConfiguredOperation;

export interface ResearchProviderNativeModelAuthorityOptions {
  readonly env: Pick<Env, "CORE_DB" | "AI_GATEWAY_REASONING_URL">;
  /** Rechecks the exact live owner-use/scope state; null means authority changed. */
  readonly current_scope: ReadResearchProviderNativeModelCurrentScope;
  /** Owner callers bind this to the configured-key reader using their authenticated request context. */
  readonly readConfiguredOperation?: ReadResearchProviderNativeModelConfiguredOperation;
  /** Durable trusted-run callers use the one shared sanitized D1 reader by default. */
  readonly pricing_snapshots?: ResearchModelPricingSnapshotStore;
  readonly now?: () => string;
}

/** Core binds Env and installed gateway identity to the reusable Native authority application. */
export function createResearchProviderNativeModelAuthority(
  options: ResearchProviderNativeModelAuthorityOptions,
): ProviderNativeModelAuthorityPort {
  if (options === null || typeof options !== "object" || options.env?.CORE_DB === undefined ||
      typeof options.current_scope !== "function") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "Core native-model authority dependencies are incomplete");
  }
  const providerScope = installedGatewayIdentity(options.env.AI_GATEWAY_REASONING_URL);
  if (providerScope === undefined) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "the installed Cloudflare AI Gateway identity is unavailable");
  }
  return createProviderNativeModelScopedAuthority({
    database: options.env.CORE_DB,
    provider_scope: providerScope,
    current_scope: options.current_scope,
    ...(options.readConfiguredOperation === undefined ? {} : {
      readConfiguredOperation: options.readConfiguredOperation,
    }),
    ...(options.pricing_snapshots === undefined ? {} : { pricing_snapshots: options.pricing_snapshots }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** Owner project reads retain the authenticated request context for the configured-key read. */
export function createOwnerResearchProviderNativeModelAuthority(
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  allowedPhases: readonly ResearchProviderKeyModelUseDbPhase[],
): ProviderNativeModelAuthorityPort {
  if (context.client_class !== "owner_pwa" || context.request.signal.aborted) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "an active owner project context is required");
  }
  const keyConfiguration = createResearchProviderKeyConfigurationService({ database: env.CORE_DB });
  return createResearchProviderNativeModelAuthority({
    env,
    current_scope: (request: ProviderNativeModelKeyBindingReadRequestV1) =>
      readResearchProviderKeyModelUseNativeScope(env.CORE_DB, request, { allowed_phases: allowedPhases }),
    readConfiguredOperation: (request) => keyConfiguration.readConfiguredOperation(
      context, projectId, request.operation_id),
  });
}
