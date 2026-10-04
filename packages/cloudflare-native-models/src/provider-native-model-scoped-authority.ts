import {
  ConfiguredProviderKeyOperationReadError,
  createD1ResearchModelPricingSnapshotStore,
  readConfiguredProviderKeyOperation,
  type ConfiguredResearchProviderKeyOperation,
  type ResearchModelPricingSnapshotStore,
} from "@eliotr/cloudflare-model-control";
import {
  ProviderNativeModelAuthorityError,
  providerNativeModelFailure,
} from "./provider-native-model-candidate.js";
import {
  createD1ProviderNativeModelAuthority,
  type ProviderNativeModelAuthorityPort,
} from "./provider-native-model-runtime.js";
import type {
  ProviderNativeModelKeyBindingReadRequestV1,
  ProviderNativeModelProviderScopeV1,
} from "./provider-native-model-key-binding.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface ProviderNativeModelCurrentScopeV1 {
  readonly owner_ref: string;
  readonly project_id: string;
  readonly owner_operation_id: string;
  readonly stage: ProviderNativeModelKeyBindingReadRequestV1["stage"];
  readonly project_generation: number;
  /** Exact immutable 0110 owner-use plan digest. */
  readonly scope_sha256: string;
}

export type ReadProviderNativeModelCurrentScope = (
  input: ProviderNativeModelKeyBindingReadRequestV1,
) => Promise<ProviderNativeModelCurrentScopeV1 | null>;

export type ReadProviderNativeModelConfiguredOperation = (
  input: ProviderNativeModelKeyBindingReadRequestV1,
) => Promise<ConfiguredResearchProviderKeyOperation | null>;

export interface ProviderNativeModelScopedAuthorityOptions {
  readonly database: D1Database;
  readonly provider_scope: ProviderNativeModelProviderScopeV1;
  /** Rechecks the exact live owner-use/scope state; null means authority changed. */
  readonly current_scope: ReadProviderNativeModelCurrentScope;
  /** Owner callers bind this to the configured-key reader using their authenticated request context. */
  readonly readConfiguredOperation?: ReadProviderNativeModelConfiguredOperation;
  /** Durable trusted-run callers use the one shared sanitized D1 reader by default. */
  readonly pricing_snapshots?: ResearchModelPricingSnapshotStore;
  readonly now?: () => string;
}

function assertScope(
  raw: unknown,
  request: ProviderNativeModelKeyBindingReadRequestV1,
): ProviderNativeModelCurrentScopeV1 {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "current owner-use scope is unavailable");
  }
  const scope = raw as ProviderNativeModelCurrentScopeV1;
  if (scope.owner_ref !== request.owner_ref || scope.project_id !== request.project_id ||
      scope.owner_operation_id !== request.owner_operation_id || scope.stage !== request.stage ||
      !Number.isSafeInteger(scope.project_generation) || scope.project_generation < 1 ||
      typeof scope.scope_sha256 !== "string" || !SHA256.test(scope.scope_sha256)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "current owner-use scope does not match the selected native stage");
  }
  return scope;
}

function sameScope(left: ProviderNativeModelCurrentScopeV1, right: ProviderNativeModelCurrentScopeV1): boolean {
  return left.owner_ref === right.owner_ref && left.project_id === right.project_id &&
    left.owner_operation_id === right.owner_operation_id && left.stage === right.stage &&
    left.project_generation === right.project_generation && left.scope_sha256 === right.scope_sha256;
}

/**
 * Composes the Native authority from server-selected provider scope and typed
 * owner-use/configured-key readers. It brackets every key metadata read with
 * exact current-scope equality and never constructs an authenticated context.
 */
export function createProviderNativeModelScopedAuthority(
  options: ProviderNativeModelScopedAuthorityOptions,
): ProviderNativeModelAuthorityPort {
  if (options === null || typeof options !== "object" || typeof options.database?.prepare !== "function" ||
      typeof options.current_scope !== "function") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "Core native-model authority dependencies are incomplete");
  }
  const providerScope = options.provider_scope;
  if (providerScope === undefined) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "the installed Cloudflare AI Gateway identity is unavailable");
  }
  const pricingSnapshots = options.pricing_snapshots ?? createD1ResearchModelPricingSnapshotStore(options.database);
  const readConfiguredOperation: ReadProviderNativeModelConfiguredOperation = options.readConfiguredOperation ??
    (async (request) => {
      const result = await readConfiguredProviderKeyOperation(
        options.database, request.owner_ref, request.project_id, request.operation_id,
      );
      return result.status === "configured" ? result.operation : null;
    });

  const keyReader = Object.freeze({
    async readConfigured(request: ProviderNativeModelKeyBindingReadRequestV1) {
      let beforeRaw: ProviderNativeModelCurrentScopeV1 | null;
      try { beforeRaw = await options.current_scope(request); }
      catch (cause) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "current native-model scope readback is unavailable", cause);
      }
      if (beforeRaw === null) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "current native-model scope is no longer admitted");
      const before = assertScope(beforeRaw, request);

      let configured: ConfiguredResearchProviderKeyOperation | null;
      try {
        configured = await readConfiguredOperation(request);
      } catch (cause) {
        if (cause instanceof ConfiguredProviderKeyOperationReadError && cause.code === "READBACK_INVALID") {
          providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "configured provider-key metadata is invalid", cause);
        }
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "configured provider-key readback is unavailable", cause);
      }

      let afterRaw: ProviderNativeModelCurrentScopeV1 | null;
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
      database: options.database,
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
