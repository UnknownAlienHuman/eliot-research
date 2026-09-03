import {
  decodeModelCallReceipt,
  decodeModelRouteDeployment,
  prepareModelGatewayCall,
  type ModelGatewayAdapter,
  type ModelRouteDeployment,
  type RouteFingerprint,
} from "@eliotr/platform-cloudflare";
import {
  modelGatewayExecutionFailure,
  type CompiledModelGatewayPrompt,
  type ModelCallInput,
  type ModelCallReceipt,
  type ModelGatewayExecutionDependencies,
  type ModelGatewayExecutionErrorCode,
  type ModelGatewayExecutionObservation,
  type ModelGatewayPricingQuote,
} from "./model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  prepareModelGatewayHttpRequest,
} from "./model-gateway-request.js";
import {
  decodeModelGatewayResponse,
  rejectModelGatewayHttpFailure,
} from "./model-gateway-response.js";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMPILED_PROMPT_KEYS = new Set([
  "request_body",
  "request_body_sha256",
  "request_timeout_ms",
]);
const OUTPUT_STORE_RESULT_KEYS = new Set(["object_ref", "readback_sha256"]);
const FINGERPRINT_STORE_RESULT_KEYS = new Set([
  "fingerprint_ref",
  "readback_sha256",
]);
const PRICING_QUOTE_KEYS = new Set([
  "billed_usd",
  "pricing_snapshot_ref",
  "quote_ref",
]);
const ROUTE_FINGERPRINT_KEYS = new Set([
  "exact_model_id",
  "parameters_digest",
  "pricing_snapshot_ref",
  "prompt_generation",
  "provider",
  "route_ref",
  "route_version",
  "schema_generation",
]);

function exactObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  code: ModelGatewayExecutionErrorCode,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    modelGatewayExecutionFailure(code, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    modelGatewayExecutionFailure(code, `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      modelGatewayExecutionFailure(
        code,
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

function boundedIdentifier(
  value: unknown,
  label: string,
  code: ModelGatewayExecutionErrorCode = "MODEL_GATEWAY_RESPONSE_INVALID",
): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    modelGatewayExecutionFailure(code, `${label} is not a bounded identifier`);
  }
  return value;
}

function exactSha256(
  value: unknown,
  label: string,
  code: ModelGatewayExecutionErrorCode = "MODEL_GATEWAY_RESPONSE_INVALID",
): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    modelGatewayExecutionFailure(code, `${label} is not canonical SHA-256`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  code: ModelGatewayExecutionErrorCode,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    modelGatewayExecutionFailure(code, `${label} is outside its allowed range`);
  }
  return value;
}

function requestedRouteRef(input: ModelCallInput): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model call input must be a plain object",
    );
  }
  return boundedIdentifier(
    (input as ModelCallInput).route_ref,
    "requested model route",
    "MODEL_GATEWAY_REQUEST_INVALID",
  );
}

function decodeCompiledPrompt(raw: unknown): CompiledModelGatewayPrompt {
  const value = exactObject(
    raw,
    COMPILED_PROMPT_KEYS,
    "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
    "compiled model prompt",
  );
  return Object.freeze({
    request_body: value.request_body,
    request_body_sha256: exactSha256(
      value.request_body_sha256,
      "compiled request body digest",
      "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
    ),
    request_timeout_ms: safeInteger(
      value.request_timeout_ms,
      "compiled request timeout",
      1,
      300_000,
      "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
    ),
  });
}

function decodeRouteDeployment(raw: unknown): ModelRouteDeployment {
  try {
    return decodeModelRouteDeployment(raw);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "registered model route deployment is invalid",
      { cause },
    );
  }
}

function decodeStoredFingerprint(
  raw: unknown,
  expectedRouteRef?: string,
): RouteFingerprint {
  const value = exactObject(
    raw,
    ROUTE_FINGERPRINT_KEYS,
    "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    "stored route fingerprint",
  );
  const deployment = decodeRouteDeployment({
    route_ref: value.route_ref,
    route_version: value.route_version,
    prompt_generation: value.prompt_generation,
    schema_generation: value.schema_generation,
    parameters_digest: value.parameters_digest,
    pricing_snapshot_ref: value.pricing_snapshot_ref,
  });
  if (
    expectedRouteRef !== undefined &&
    deployment.route_ref !== expectedRouteRef
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
      "stored route fingerprint belongs to a different route",
    );
  }
  return Object.freeze({
    ...deployment,
    provider: boundedIdentifier(
      value.provider,
      "stored route fingerprint provider",
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    ),
    exact_model_id: boundedIdentifier(
      value.exact_model_id,
      "stored route fingerprint model",
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    ),
  });
}

function responseStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const retained = bytes.slice();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(retained);
      controller.close();
    },
  });
}

async function persistOutput(
  dependencies: ModelGatewayExecutionDependencies,
  input: ModelCallInput,
  bytes: Uint8Array,
  expectedDigest: string,
): Promise<void> {
  let rawPersisted: unknown;
  try {
    rawPersisted = await dependencies.outputs.putImmutable(
      input.output_object_ref,
      responseStream(bytes),
      expectedDigest,
    );
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
      "model output could not be persisted immutably",
      { cause },
    );
  }
  const persisted = exactObject(
    rawPersisted,
    OUTPUT_STORE_RESULT_KEYS,
    "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
    "model output store result",
  );
  if (
    boundedIdentifier(
      persisted.object_ref,
      "model output object reference",
      "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
    ) !== input.output_object_ref
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
      "model output store returned a different object reservation",
    );
  }
  if (
    exactSha256(
      persisted.readback_sha256,
      "model output readback digest",
      "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
    ) !== expectedDigest
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
      "model output readback digest differs from the gateway response",
    );
  }
}

async function persistFingerprint(
  dependencies: ModelGatewayExecutionDependencies,
  fingerprint: RouteFingerprint,
): Promise<string> {
  const expectedDigest = await modelGatewaySha256(
    canonicalModelGatewayJson(fingerprint),
  );
  let rawPersisted: unknown;
  try {
    rawPersisted = await dependencies.fingerprints.putImmutable(
      fingerprint,
      expectedDigest,
    );
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
      "route fingerprint could not be persisted immutably",
      { cause },
    );
  }
  const persisted = exactObject(
    rawPersisted,
    FINGERPRINT_STORE_RESULT_KEYS,
    "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    "route fingerprint store result",
  );
  const fingerprintRef = boundedIdentifier(
    persisted.fingerprint_ref,
    "route fingerprint reference",
    "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
  );
  if (
    exactSha256(
      persisted.readback_sha256,
      "route fingerprint readback digest",
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    ) !== expectedDigest
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
      "route fingerprint readback digest differs from the persisted fingerprint",
    );
  }
  return fingerprintRef;
}

function decodePricingQuote(
  raw: unknown,
  expectedSnapshotRef: string,
): ModelGatewayPricingQuote {
  const value = exactObject(
    raw,
    PRICING_QUOTE_KEYS,
    "MODEL_GATEWAY_PRICING_FAILED",
    "model pricing quote",
  );
  const quote = Object.freeze({
    quote_ref: boundedIdentifier(
      value.quote_ref,
      "model pricing quote reference",
      "MODEL_GATEWAY_PRICING_FAILED",
    ),
    pricing_snapshot_ref: boundedIdentifier(
      value.pricing_snapshot_ref,
      "model pricing snapshot reference",
      "MODEL_GATEWAY_PRICING_FAILED",
    ),
    billed_usd: value.billed_usd,
  });
  if (quote.pricing_snapshot_ref !== expectedSnapshotRef) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_PRICING_FAILED",
      "model pricing quote used a different pricing snapshot",
    );
  }
  if (
    typeof quote.billed_usd !== "number" ||
    !Number.isFinite(quote.billed_usd) ||
    quote.billed_usd < 0
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_PRICING_FAILED",
      "model pricing quote is not a finite non-negative estimate",
    );
  }
  return quote as ModelGatewayPricingQuote;
}

async function quotePrice(
  dependencies: ModelGatewayExecutionDependencies,
  fingerprint: RouteFingerprint,
  inputTokens: number,
  outputTokens: number,
): Promise<ModelGatewayPricingQuote> {
  let rawQuote: unknown;
  try {
    rawQuote = await dependencies.pricing.quote({
      fingerprint,
      pricing_snapshot_ref: fingerprint.pricing_snapshot_ref,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_PRICING_FAILED",
      "model usage could not be priced against the pinned snapshot",
      { cause },
    );
  }
  return decodePricingQuote(rawQuote, fingerprint.pricing_snapshot_ref);
}

async function executeObservedModelGatewayCall(
  dependencies: ModelGatewayExecutionDependencies,
  input: ModelCallInput,
): Promise<ModelGatewayExecutionObservation> {
  const routeRef = requestedRouteRef(input);
  let rawDeployment: unknown | null;
  try {
    rawDeployment = await dependencies.deployments.resolve(routeRef);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_DEPLOYMENT_MISSING",
      "model route deployment registry could not be read",
      { cause },
    );
  }
  if (rawDeployment === null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_DEPLOYMENT_MISSING",
      "model route deployment is not registered",
    );
  }
  const deployment = decodeRouteDeployment(rawDeployment);
  try {
    prepareModelGatewayCall(input, deployment);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model route deployment or call input failed policy validation",
      { cause },
    );
  }

  let rawCompiled: unknown;
  try {
    rawCompiled = await dependencies.prompts.compile(input, deployment);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
      "trusted model prompt compiler failed",
      { cause },
    );
  }
  const compiled = decodeCompiledPrompt(rawCompiled);

  let token: unknown;
  try {
    token = await dependencies.credentials.readGatewayToken();
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_CREDENTIAL_INVALID",
      "reasoning gateway credential could not be read",
      { cause },
    );
  }
  const request = await prepareModelGatewayHttpRequest(
    input,
    deployment,
    compiled,
    dependencies.reasoning_gateway_base_url,
    token,
  );

  let rawResponse: unknown;
  try {
    rawResponse = await dependencies.transport.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
    });
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_TRANSPORT_FAILED",
      "AI Gateway transport failed with an unknown upstream execution outcome",
      { cause },
    );
  }
  if (!(rawResponse instanceof Response)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway transport returned a non-Response value",
    );
  }
  if (!rawResponse.ok) await rejectModelGatewayHttpFailure(rawResponse);

  const decoded = await decodeModelGatewayResponse(
    rawResponse,
    deployment,
    input.max_output_bytes,
  );
  await persistOutput(
    dependencies,
    input,
    decoded.body_bytes,
    decoded.body_sha256,
  );
  const fingerprintRef = await persistFingerprint(
    dependencies,
    decoded.fingerprint,
  );
  const pricingQuote = await quotePrice(
    dependencies,
    decoded.fingerprint,
    decoded.usage.input_tokens,
    decoded.usage.output_tokens,
  );

  const receiptDigest = await modelGatewaySha256(
    canonicalModelGatewayJson({
      gateway_log_id: decoded.log_id,
      output_object_ref: input.output_object_ref,
      output_sha256: decoded.body_sha256,
      pricing_quote_ref: pricingQuote.quote_ref,
      request_body_sha256: request.body_sha256,
      request_parameters_sha256: request.parameters_sha256,
      response_model: decoded.response_model,
      route_fingerprint_ref: fingerprintRef,
      successful_step: decoded.successful_step,
    }),
  );
  const rawReceipt = {
    receipt_ref: `model-call-${receiptDigest.slice(0, 48)}`,
    route_fingerprint_ref: fingerprintRef,
    output_object_ref: input.output_object_ref,
    output_sha256: decoded.body_sha256,
    input_tokens: decoded.usage.input_tokens,
    output_tokens: decoded.usage.output_tokens,
    billed_usd: pricingQuote.billed_usd,
  };
  const receipt = decodeModelCallReceipt(input, fingerprintRef, rawReceipt);
  return Object.freeze({
    receipt,
    route_fingerprint: decoded.fingerprint,
    gateway_log_id: decoded.log_id,
    pricing_quote_ref: pricingQuote.quote_ref,
    request_body_sha256: request.body_sha256,
    request_parameters_sha256: request.parameters_sha256,
    response_body_sha256: decoded.body_sha256,
    response_model: decoded.response_model,
    ...(decoded.successful_step === undefined
      ? {}
      : { successful_step: decoded.successful_step }),
  });
}

export function createModelGatewayFetchAdapter(
  dependencies: ModelGatewayExecutionDependencies,
): ModelGatewayAdapter {
  return Object.freeze({
    async execute(input: ModelCallInput): Promise<ModelCallReceipt> {
      const observation = await executeObservedModelGatewayCall(
        dependencies,
        input,
      );
      return observation.receipt;
    },
    async resolveFingerprint(routeRef: string): Promise<RouteFingerprint> {
      const requested = boundedIdentifier(
        routeRef,
        "requested route fingerprint",
        "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
      );
      let rawFingerprint: unknown | null;
      try {
        rawFingerprint = await dependencies.fingerprints.getLatest(requested);
      } catch (cause) {
        modelGatewayExecutionFailure(
          "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
          "latest route fingerprint could not be read",
          { cause },
        );
      }
      if (rawFingerprint === null) {
        modelGatewayExecutionFailure(
          "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
          "latest route fingerprint is not available",
        );
      }
      return decodeStoredFingerprint(rawFingerprint, requested);
    },
  });
}

export { executeObservedModelGatewayCall };
