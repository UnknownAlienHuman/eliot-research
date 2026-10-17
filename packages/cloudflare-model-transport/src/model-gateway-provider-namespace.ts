import { modelGatewayExecutionFailure } from "./model-gateway-execution-contract.js";

const CUSTOM_PROVIDER = /^custom-[a-z0-9][a-z0-9-]{0,62}$/u;

/** The saved credential namespace is the raw custom-provider slug. Cloudflare
 * adds a separate custom- transport prefix to that slug in URLs/observations. */
export function modelGatewayCustomProviderRoutingId(canonicalProvider: string): string {
  if (!CUSTOM_PROVIDER.test(canonicalProvider)) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "Custom provider routing requires the exact saved credential namespace");
  }
  return `custom-${canonicalProvider}`;
}

/** Never normalize a model ID. Legacy provider spelling is accepted only when
 * reading an already failed request, never as positive execution evidence. */
export function modelGatewayObservedProviderMatches(
  observedProvider: unknown,
  canonicalProvider: string,
  mode: "execution" | "failed-history" = "execution",
): boolean {
  if (typeof observedProvider !== "string") return false;
  if (!canonicalProvider.startsWith("custom-")) return observedProvider === canonicalProvider;
  if (!CUSTOM_PROVIDER.test(canonicalProvider)) return false;
  return observedProvider === modelGatewayCustomProviderRoutingId(canonicalProvider) ||
    (mode === "failed-history" && observedProvider === canonicalProvider);
}
