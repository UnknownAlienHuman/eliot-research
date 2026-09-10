import { ModelGatewayExecutionError, resolveModelGatewayReasoningEndpoint } from "@eliotr/cloudflare-ai";

/** Native Worker capability; acquisition and authentication stay inside Cloudflare. */
export interface ResearchModelGatewayBinding {
  gateway(gatewayId: string): Pick<AiGateway, "getUrl" | "run">;
}

function invalid(message: string): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_REQUEST_INVALID", message);
}

export function createResearchModelGatewayBindingFetch(
  binding: ResearchModelGatewayBinding,
  endpoint: string,
): (url: string, init: RequestInit) => Promise<Response> {
  if (binding === null || typeof binding !== "object" || typeof binding.gateway !== "function") {
    invalid("reasoning gateway Worker binding is unavailable");
  }
  const gateway = binding.gateway("eliotr-reasoning");
  if (gateway === null || typeof gateway !== "object" || typeof gateway.getUrl !== "function" || typeof gateway.run !== "function") {
    invalid("reasoning gateway Worker binding is invalid");
  }
  return async (url, init) => {
    if (url !== endpoint || typeof init.body !== "string") invalid("bound gateway request is invalid");
    const headers = new Headers(init.headers);
    if (headers.has("authorization") || headers.has("cf-aig-authorization")) {
      invalid("bound gateway authentication must not use a request credential");
    }
    // getUrl binds the configured account as well as the fixed reasoning gateway.
    const actualBase = await gateway.getUrl();
    if (resolveModelGatewayReasoningEndpoint(actualBase) !== endpoint) {
      invalid("reasoning gateway Worker binding belongs to another account");
    }
    init.signal?.throwIfAborted();
    let query: unknown;
    try { query = JSON.parse(init.body) as unknown; }
    catch { invalid("bound gateway request body is not JSON"); }
    if (query === null || typeof query !== "object" || Array.isArray(query)) invalid("bound gateway request body is invalid");
    // Preserve canonical cache/logging/timeout/single-attempt headers on the
    // gateway request. Provider headers contain no separate gateway credential.
    return gateway.run({
      provider: "compat", endpoint: "chat/completions",
      headers: { "Content-Type": "application/json", Accept: "application/json" }, query,
    }, { extraHeaders: Object.fromEntries(headers), ...(init.signal == null ? {} : { signal: init.signal }) });
  };
}
