import { modelGatewayExecutionFailure, type PreparedModelGatewayHttpRequest } from "./model-gateway-execution-contract.js";
import type { ModelGatewayTransportPolicyV1 } from "./model-gateway-transport-policy.js";
import { modelGatewayProviderNativePath } from "./model-gateway-provider-native-request.js";
import { openCodePolicyMetadata, planOpenCodeModelRoute, type ReadOpenCodeRegisteredProvider } from "./opencode-model-routing.js";

/** Replaces only the URL of an already compiled request. No body, hash, header,
 * credential, timeout or persisted policy is changed. Namespace code is reused. */
export async function resolveOpenCodePreparedRequest(request: PreparedModelGatewayHttpRequest,
  policy: ModelGatewayTransportPolicyV1 | undefined, readProvider: ReadOpenCodeRegisteredProvider | undefined,
): Promise<PreparedModelGatewayHttpRequest> {
  if (policy === undefined || (policy.provider !== "custom-opencode-go" && policy.provider !== "custom-opencode-zen")) return request;
  const metadata = openCodePolicyMetadata(policy.provider, policy.api);
  if (metadata === null || readProvider === undefined || policy.billing.mode !== "byok" || policy.billing.alias === "default") {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "OpenCode routing metadata is unavailable");
  }
  const plan = planOpenCodeModelRoute({ provider_id: policy.provider.slice("custom-".length), provider_slug: policy.provider,
    model_id: policy.model, advertised_sdk: metadata.sdk, advertised_api_base: metadata.base,
    registered_provider: await readProvider(policy.provider) });
  if (plan.status !== "eligible_unverified" || plan.api !== policy.api) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "OpenCode registered base is incompatible with the qualified API");
  }
  const url = new URL(request.url);
  const oldPath = modelGatewayProviderNativePath(policy.api, policy.provider);
  const gateway = url.pathname.slice(0, -oldPath.length);
  if (url.origin !== "https://gateway.ai.cloudflare.com" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
      !url.pathname.endsWith(oldPath) || !/^\/v1\/[a-f0-9]{32}\/eliotr-reasoning$/u.test(gateway)) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "OpenCode request does not identify the configured Gateway");
  }
  return Object.freeze({ ...request, url: `${url.origin}${gateway}${plan.gateway_path}` });
}
