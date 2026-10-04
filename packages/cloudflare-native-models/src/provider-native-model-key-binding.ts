import {
  ProviderNativeModelAuthorityError,
  decodeProviderNativeModelKeyBinding,
  providerNativeModelFailure,
  type ProviderNativeModelKeyBindingV1,
  type ProviderNativeModelStage,
} from "./provider-native-model-candidate.js";

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STAGES = new Set(["ANALYZE_BRANCHES", "AUDIT_CLAIMS", "COUNTER_SEARCH", "SYNTHESIZE"]);

export interface ProviderNativeModelKeyBindingReadRequestV1 {
  readonly owner_ref: string;
  readonly project_id: string;
  readonly owner_operation_id: string;
  readonly stage: ProviderNativeModelStage;
  readonly operation_id: string;
}

export interface ProviderNativeModelKeyConfigurationReaderPort {
  /** The Core adapter uses the current-owner checked provider-key operation reader. */
  readConfigured(input: ProviderNativeModelKeyBindingReadRequestV1): Promise<ProviderNativeModelKeyBindingV1 | null>;
}

export interface ProviderNativeModelProviderScopeV1 {
  readonly account_id: string;
  readonly gateway_id: string;
}

/** Revalidates Core's safe internal readback at the model-authority boundary. */
export function validateProviderNativeModelKeyBinding(
  raw: unknown,
  request: ProviderNativeModelKeyBindingReadRequestV1,
  scope: ProviderNativeModelProviderScopeV1,
): ProviderNativeModelKeyBindingV1 {
  let binding: ProviderNativeModelKeyBindingV1;
  try { binding = decodeProviderNativeModelKeyBinding(raw); }
  catch (cause) {
    if (cause instanceof ProviderNativeModelAuthorityError) throw cause;
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "configured provider key operation is malformed", cause);
  }
  if (request.owner_ref !== binding.owner_ref || request.project_id !== binding.project_id ||
      request.operation_id !== binding.operation_id || !OPERATION_ID.test(request.owner_operation_id) ||
      !STAGES.has(request.stage) || scope.account_id.toLowerCase() !== binding.account_id ||
      scope.gateway_id !== binding.gateway_id || binding.provider_id !== "openrouter") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "configured provider key operation differs from the current server scope");
  }
  return binding;
}
