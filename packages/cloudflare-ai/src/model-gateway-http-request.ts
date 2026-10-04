import {
  prepareModelGatewayCall,
  type ModelGatewayCallPolicy,
  type ModelGatewayCallTarget,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import {
  modelGatewayExecutionFailure,
  type CompiledModelGatewayPrompt,
  type ModelCallInput,
  type PreparedModelGatewayHttpRequest,
} from "./model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewayBodyForCapabilities,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  validateModelGatewayTransportPolicy,
  validateModelGatewayRequestBody,
  type ModelGatewayTransportPolicyV1,
} from "./model-gateway-request.js";
import {
  modelGatewayProviderNativePath,
  modelGatewayProviderNativeRequest,
} from "./model-gateway-provider-native-request.js";
import type { ModelGatewayApi } from "./model-gateway-transport-policy.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const POLICY_HEADER_KEYS = new Set([
  "cf-aig-collect-log",
  "cf-aig-collect-log-payload",
  "cf-aig-metadata",
  "cf-aig-skip-cache",
]);
const MAX_REQUEST_BYTES = 256 * 1024;

function exactObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `${label} must be a plain object`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `${label} is outside its allowed range`,
    );
  }
  return value;
}

export function reasoningEndpoint(
  baseUrl: string,
  api: ModelGatewayApi = "compat-chat-completions",
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "reasoning gateway base URL is invalid",
      { cause },
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "gateway.ai.cloudflare.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "reasoning gateway base URL must use the authenticated Cloudflare gateway host",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    !ACCOUNT_ID.test(parts[1] ?? "") ||
    parts[2] !== "eliotr-reasoning"
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "reasoning gateway base URL must identify the exact account and eliotr-reasoning gateway",
    );
  }
  return `${url.origin}/v1/${parts[1]}/eliotr-reasoning${modelGatewayProviderNativePath(api)}`;
}

export function gatewayToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4096 ||
    value !== value.trim() ||
    /\s/u.test(value) ||
    value.toLowerCase().startsWith("bearer")
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_CREDENTIAL_INVALID",
      "reasoning gateway token is invalid",
    );
  }
  return value;
}

function validatePolicy(
  policy: ModelGatewayCallPolicy,
  target: ModelGatewayCallTarget,
): void {
  if (
    policy.gateway_id !== "eliotr-reasoning" ||
    policy.provider !== target.provider ||
    policy.endpoint !== target.endpoint
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway policy selected an unsupported gateway endpoint",
    );
  }
  const headers = exactObject(
    policy.headers,
    POLICY_HEADER_KEYS,
    "model gateway policy headers",
  );
  if (
    headers["cf-aig-collect-log"] !== "true" ||
    headers["cf-aig-collect-log-payload"] !== "false" ||
    headers["cf-aig-skip-cache"] !== "true" ||
    typeof headers["cf-aig-metadata"] !== "string" ||
    utf8Bytes(headers["cf-aig-metadata"]) > 8192
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway policy headers violate logging or cache requirements",
    );
  }
}

function callTarget(api: ModelGatewayApi | undefined): ModelGatewayCallTarget {
  if (api === undefined || api === "compat-chat-completions") {
    return { provider: "compat", endpoint: "chat/completions" };
  }
  if (api === "openai-chat-completions") return { provider: "openai", endpoint: "chat/completions" };
  if (api === "openrouter-chat-completions") return { provider: "openrouter", endpoint: "chat/completions" };
  if (api === "openai-responses") return { provider: "openai", endpoint: "responses" };
  return { provider: "anthropic", endpoint: "v1/messages" };
}

export async function prepareModelGatewayBindingRequest(
  input: ModelCallInput,
  deployment: ModelRouteDeployment,
  compiled: CompiledModelGatewayPrompt,
  baseUrl: string,
  rawTransportPolicy?: ModelGatewayTransportPolicyV1,
): Promise<PreparedModelGatewayHttpRequest> {
  const request = await prepareModelGatewayRequest(
    input,
    deployment,
    compiled,
    baseUrl,
    rawTransportPolicy,
    true,
  );
  return request;
}

async function prepareModelGatewayRequest(
  input: ModelCallInput,
  deployment: ModelRouteDeployment,
  compiled: CompiledModelGatewayPrompt,
  baseUrl: string,
  rawTransportPolicy: ModelGatewayTransportPolicyV1 | undefined,
  bindingTransport: boolean,
): Promise<PreparedModelGatewayHttpRequest> {
  const transportPolicy = rawTransportPolicy === undefined
    ? undefined
    : validateModelGatewayTransportPolicy(rawTransportPolicy);
  if (bindingTransport && transportPolicy?.billing.mode === "byok") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "BYOK aliases require direct AI Gateway passthrough transport",
    );
  }
  let policy: ModelGatewayCallPolicy;
  const target = callTarget(transportPolicy?.api);
  try {
    policy = prepareModelGatewayCall(input, deployment, target);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model route deployment or call input failed policy validation",
      { cause },
    );
  }
  validatePolicy(policy, target);
  const byokHeaders = transportPolicy?.billing.mode === "byok"
    ? {
        "cf-aig-no-wholesale": "true",
        ...(transportPolicy.billing.alias === "default"
          ? {}
          : { "cf-aig-byok-alias": transportPolicy.billing.alias }),
      }
    : {};
  const maximumInputBytes = safeInteger(
    input.max_input_bytes,
    "reserved input byte budget",
    1,
    MAX_REQUEST_BYTES,
  );
  const maximumOutputBytes = safeInteger(
    input.max_output_bytes,
    "reserved output byte budget",
    1,
    MAX_REQUEST_BYTES,
  );
  const compiledCanonical = canonicalModelGatewayJson(compiled.request_body);
  if (await modelGatewaySha256(compiledCanonical) !== compiled.request_body_sha256) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "compiled model request digest does not match canonical compiler output",
    );
  }
  const requestBody = transportPolicy === undefined
    ? compiled.request_body
    : modelGatewayBodyForCapabilities(
        compiled.request_body,
        transportPolicy.capabilities,
      );
  const validated = await validateModelGatewayRequestBody(
    requestBody,
    deployment,
    maximumInputBytes,
    maximumOutputBytes,
    transportPolicy?.capabilities,
  );
  const internalBody = JSON.parse(validated.body) as unknown;
  const wireBody = transportPolicy === undefined ||
      transportPolicy.api === "compat-chat-completions"
    ? internalBody
    : modelGatewayProviderNativeRequest(internalBody, transportPolicy);
  const canonicalWireBody = canonicalModelGatewayJson(wireBody);
  const wireBodyBytes = utf8Bytes(canonicalWireBody);
  if (wireBodyBytes > MAX_REQUEST_BYTES || wireBodyBytes > maximumInputBytes) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "canonical provider request exceeds the reserved input byte budget",
    );
  }
  const parametersSha256 = transportPolicy === undefined
    ? validated.parameters_sha256
    : await modelGatewayRequestParametersSha256(
        internalBody,
        transportPolicy.capabilities,
        transportPolicy.api,
      );
  if (!SHA256.test(compiled.request_body_sha256)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "compiled model request digest is not canonical SHA-256",
    );
  }
  if (parametersSha256 !== deployment.parameters_digest) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "compiled model parameters differ from the deployed parameter generation",
    );
  }
  const requestTimeout = safeInteger(
    compiled.request_timeout_ms,
    "model request timeout",
    1,
    300_000,
  );
  const bodySha256 = await modelGatewaySha256(canonicalWireBody);
  return Object.freeze({
    url: reasoningEndpoint(baseUrl, transportPolicy?.api),
    method: "POST",
    headers: Object.freeze({
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(transportPolicy?.api === "anthropic-messages"
        ? { "anthropic-version": "2023-06-01" }
        : {}),
      ...policy.headers,
      ...byokHeaders,
      "cf-aig-request-timeout": String(requestTimeout),
      "cf-aig-max-attempts": "1",
    }),
    body: canonicalWireBody,
    body_sha256: bodySha256,
    parameters_sha256: parametersSha256,
    request_timeout_ms: requestTimeout,
  });
}

export async function prepareModelGatewayHttpRequest(
  input: ModelCallInput,
  deployment: ModelRouteDeployment,
  compiled: CompiledModelGatewayPrompt,
  baseUrl: string,
  rawToken: unknown,
  transportPolicy?: ModelGatewayTransportPolicyV1,
): Promise<PreparedModelGatewayHttpRequest> {
  const request = await prepareModelGatewayRequest(
    input,
    deployment,
    compiled,
    baseUrl,
    transportPolicy,
    false,
  );
  const token = gatewayToken(rawToken);
  return Object.freeze({ ...request, headers: Object.freeze({ ...request.headers, "cf-aig-authorization": `Bearer ${token}` }) });
}
