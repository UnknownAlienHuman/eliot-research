import {
  createD1ProviderNativeModelAuthority,
  ProviderNativeModelAuthorityError,
  providerNativeModelFailure,
  type ProviderNativeModelAuthorityPort,
  type ProviderNativeModelKeyBindingReadRequestV1,
  type ProviderNativeModelStage,
} from "@eliotr/cloudflare-native-models";
import {
  createD1ResearchModelPricingSnapshotStore,
  type ResearchModelPricingSnapshotStore,
} from "@eliotr/cloudflare-model-control";
import {
  ConfiguredProviderKeyOperationReadError,
  readConfiguredProviderKeyOperation,
  type ConfiguredResearchProviderKeyOperation,
} from "./research-provider-key-configured-operation.js";
import { installedGatewayIdentity } from "./research-provider-key-configuration-composition.js";
import type { Env } from "./env.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createResearchProviderKeyConfigurationService } from "./research-provider-key-configuration-service.js";
import { readResearchProviderKeyModelUseNativeScope } from "./research-provider-key-model-use-current-scope.js";
import type { ResearchProviderKeyModelUseDbPhase } from "./research-provider-key-model-use-store.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface ResearchProviderNativeModelCurrentScopeV1 {
  readonly owner_ref: string;
  readonly project_id: string;
  readonly owner_operation_id: string;
  readonly stage: ProviderNativeModelStage;
  readonly project_generation: number;
  /** Exact immutable 0110 owner-use plan digest. */
  readonly scope_sha256: string;
}

export type ReadResearchProviderNativeModelCurrentScope = (
  input: ProviderNativeModelKeyBindingReadRequestV1,
) => Promise<ResearchProviderNativeModelCurrentScopeV1 | null>;

export type ReadResearchProviderNativeModelConfiguredOperation = (
  input: ProviderNativeModelKeyBindingReadRequestV1,
) => Promise<ConfiguredResearchProviderKeyOperation | null>;

export interface ResearchProviderNativeModelAuthorityOptions {
  readonly env: Pick<Env, "CORE_DB" | "AI_GATEWAY_REASONING_URL">;
  /** Rechecks the exact live owner-use/scope state; null means authority changed. */
  readonly current_scope: ReadResearchProviderNativeModelCurrentScope;
  /** Owner callers bind this to readConfiguredOperation with their real request context. */
  readonly readConfiguredOperation?: ReadResearchProviderNativeModelConfiguredOperation;
  /** Durable trusted-run callers use the one shared sanitized D1 reader by default. */
  readonly pricing_snapshots?: ResearchModelPricingSnapshotStore;
  readonly now?: () => string;
};

function assertScope(
  raw: unknown,
  request: ProviderNativeModelKeyBindingReadRequestV1,
): ResearchProviderNativeModelCurrentScopeV1 {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "current owner-use scope is unavailable");
  }
  const scope = raw as ResearchProviderNativeModelCurrentScopeV1;
  if (scope.owner_ref !== request.owner_ref || scope.project_id !== request.project_id ||
      scope.owner_operation_id !== request.owner_operation_id || scope.stage !== request.stage ||
      !Number.isSafeInteger(scope.project_generation) || scope.project_generation < 1 ||
      typeof scope.scope_sha256 !== "string" || !SHA256.test(scope.scope_sha256)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "current owner-use scope does not match the selected native stage");
  }
  return scope;
}

function sameScope(
  left: ResearchProviderNativeModelCurrentScopeV1,
  right: ResearchProviderNativeModelCurrentScopeV1,
): boolean {
  return left.owner_ref === right.owner_ref && left.project_id === right.project_id &&
    left.owner_operation_id === right.owner_operation_id && left.stage === right.stage &&
    left.project_generation === right.project_generation && left.scope_sha256 === right.scope_sha256;
}

/**
 * Shared Core composition for project validation, owner preparation/qualification,
 * and durable run/COW resolution. It binds the Native authority to the installed
 * Gateway identity and requires a live operation-scope read around every current
 * provider-key metadata read. It never constructs an owner_pwa context.
 */
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
  const pricingSnapshots = options.pricing_snapshots ?? createD1ResearchModelPricingSnapshotStore(options.env.CORE_DB);

  const keyReader = Object.freeze({
    async readConfigured(request: ProviderNativeModelKeyBindingReadRequestV1) {
      let beforeRaw: ResearchProviderNativeModelCurrentScopeV1 | null;
      try { beforeRaw = await options.current_scope(request); }
      catch (cause) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "current native-model scope readback is unavailable", cause);
      }
      if (beforeRaw === null) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "current native-model scope is no longer admitted");
      const before = assertScope(beforeRaw, request);

      let configured: ConfiguredResearchProviderKeyOperation | null;
      try {
        configured = options.readConfiguredOperation === undefined
          ? await readConfiguredProviderKeyOperation(options.env.CORE_DB, request.owner_ref, request.project_id,
            request.operation_id).then((result) => result.status === "configured" ? result.operation : null)
          : await options.readConfiguredOperation(request);
      } catch (cause) {
        if (cause instanceof ConfiguredProviderKeyOperationReadError && cause.code === "READBACK_INVALID") {
          providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "configured provider-key metadata is invalid", cause);
        }
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "configured provider-key readback is unavailable", cause);
      }

      let afterRaw: ResearchProviderNativeModelCurrentScopeV1 | null;
      try { afterRaw = await options.current_scope(request); }
      catch (cause) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "current native-model scope readback is unavailable", cause);
      }
      if (afterRaw === null) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "current native-model scope changed during provider-key readback");
      const after = assertScope(afterRaw, request);
      if (!sameScope(before, after)) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "owner-use scope changed during provider-key readback");
      }
      if (configured === null) return null;
      if (configured.owner_id !== request.owner_ref || configured.project_id !== request.project_id ||
          configured.operation_id !== request.operation_id || configured.provider_id !== "openrouter" ||
          configured.account_id !== providerScope.account_id || configured.gateway_id !== providerScope.gateway_id ||
          configured.status !== "configured_not_qualified") {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "configured key metadata differs from the installed provider scope");
      }
      return Object.freeze({
        protocol: "eliotr.research-provider-key-configuration.v1" as const,
        owner_ref: configured.owner_id,
        project_id: configured.project_id,
        operation_id: configured.operation_id,
        provider_id: configured.provider_id,
        account_id: configured.account_id,
        gateway_id: configured.gateway_id,
        alias: configured.alias,
        provider_config_id: configured.provider_config_id,
        configuration_metadata_sha256: configured.metadata_sha256,
      });
    },
  });

  try {
    return createD1ProviderNativeModelAuthority({
      database: options.env.CORE_DB,
      key_configurations: keyReader,
      provider_scope: providerScope,
      pricing_snapshots: pricingSnapshots,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (cause) {
    if (cause instanceof ProviderNativeModelAuthorityError) throw cause;
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "Core native-model authority could not be created", cause);
  }
}

/**
 * Owner project reads retain the actual authenticated request context for the
 * configured-key read and restrict operation scope to import/readback/complete.
 */
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
    current_scope: (request) => readResearchProviderKeyModelUseNativeScope(env.CORE_DB, request, {
      allowed_phases: allowedPhases,
    }),
    readConfiguredOperation: (request) => keyConfiguration.readConfiguredOperation(
      context, projectId, request.operation_id),
  });
}
