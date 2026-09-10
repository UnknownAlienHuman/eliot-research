import {
  prepareModelGatewayCall,
  type ModelGatewayCallPolicy,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import {
  modelGatewayExecutionFailure,
  type CompiledModelGatewayPrompt,
  type ModelCallInput,
  type PreparedModelGatewayHttpRequest,
} from "./model-gateway-execution-contract.js";
import {
  modelGatewaySha256,
  validateModelGatewayRequestBody,
} from "./model-gateway-request.js";

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

function reasoningEndpoint(baseUrl: string): string {
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
  return `${url.origin}/v1/${parts[1]}/eliotr-reasoning/compat/chat/completions`;
}

function gatewayToken(value: unknown): string {
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

function validatePolicy(policy: ModelGatewayCallPolicy): void {
  if (
    policy.gateway_id !== "eliotr-reasoning" ||
    policy.provider !== "compat" ||
    policy.endpoint !== "chat/completions"
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

export async function prepareModelGatewayHttpRequest(
  input: ModelCallInput,
  deployment: ModelRouteDeployment,
  compiled: CompiledModelGatewayPrompt,
  baseUrl: string,
  rawToken: unknown,
): Promise<PreparedModelGatewayHttpRequest> {
  let policy: ModelGatewayCallPolicy;
  try {
    policy = prepareModelGatewayCall(input, deployment);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model route deployment or call input failed policy validation",
      { cause },
    );
  }
  validatePolicy(policy);
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
  const validated = await validateModelGatewayRequestBody(
    compiled.request_body,
    deployment,
    maximumInputBytes,
    maximumOutputBytes,
  );
  if (!SHA256.test(compiled.request_body_sha256)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "compiled model request digest is not canonical SHA-256",
    );
  }
  const bodySha256 = await modelGatewaySha256(validated.body);
  if (bodySha256 !== compiled.request_body_sha256) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "compiled model request digest does not match canonical request bytes",
    );
  }
  if (validated.parameters_sha256 !== deployment.parameters_digest) {
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
  const token = gatewayToken(rawToken);
  return Object.freeze({
    url: reasoningEndpoint(baseUrl),
    method: "POST",
    headers: Object.freeze({
      Accept: "application/json",
      "Content-Type": "application/json",
      "cf-aig-authorization": `Bearer ${token}`,
      ...policy.headers,
      "cf-aig-request-timeout": String(requestTimeout),
      "cf-aig-max-attempts": "1",
    }),
    body: validated.body,
    body_sha256: bodySha256,
    parameters_sha256: validated.parameters_sha256,
    request_timeout_ms: requestTimeout,
  });
}
