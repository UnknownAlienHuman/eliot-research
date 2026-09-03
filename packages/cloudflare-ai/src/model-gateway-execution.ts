import {
  decodeModelCallReceipt,
  decodeModelRouteDeployment,
  prepareModelGatewayCall,
  type ModelGatewayAdapter,
  type RouteFingerprint,
} from "@eliotr/platform-cloudflare";
import {
  modelGatewayExecutionFailure,
  type ModelCallInput,
  type ModelCallReceipt,
  type ModelGatewayExecutionDependencies,
  type ModelGatewayExecutionObservation,
  type ModelGatewayPricingQuote,
} from "./model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  prepareModelGatewayHttpRequest,
} from "./model-gateway-request.js";
import { decodeModelGatewayResponse } from "./model-gateway-response.js";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} is not a bounded identifier`,
    );
  }
  return value;
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} is not canonical SHA-256`,
    );
  }
  return value;
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

function classifyHttpFailure(status: number): never {
  if (status === 401 || status === 403) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_AUTH_REJECTED",
      "AI Gateway rejected the authenticated request",
      { http_status: status },
    );
  }
  if (status === 429) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_LIMIT_REJECTED",
      "AI Gateway rejected the request because a rate or spend limit was reached",
      { http_status: status },
    );
  }
  modelGatewayExecutionFailure(
    "MODEL_GATEWAY_UPSTREAM_REJECTED",
    "AI Gateway returned a non-success status",
    { http_status: status },
  );
}

async function persistFingerprint(
  dependencies: ModelGatewayExecutionDependencies,
  fingerprint: RouteFingerprint,
): Promise<string> {
  const expectedDigest = await modelGatewaySha256(
    canonicalModelGatewayJson(fingerprint),
  );
  let persisted: Awaited<
    ReturnType<ModelGatewayExecutionDependencies["fingerprints"]["putImmutable"]>
  >;
  try {
    persisted = await dependencies.fingerprints.putImmutable(
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
  const fingerprintRef = boundedIdentifier(
    persisted.fingerprint_ref,
    "route fingerprint reference",
  );
  if (
    exactSha256(
      persisted.readback_sha256,
      "route fingerprint readback digest",
    ) !== expectedDigest
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
      "route fingerprint readback digest differs from the persisted fingerprint",
    );
  }
  return fingerprintRef;
}

async function persistOutput(
  dependencies: ModelGatewayExecutionDependencies,
  input: ModelCallInput,
  bytes: Uint8Array,
  expectedDigest: string,
): Promise<void> {
  let persisted: Awaited<
    ReturnType<ModelGatewayExecutionDependencies["outputs"]["putImmutable"]>
  >;
  try {
    persisted = await dependencies.outputs.putImmutable(
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
  if (persisted.object_ref !== input.output_object_ref) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
      "model output store returned a different object reservation",
    );
  }
  if (
    exactSha256(persisted.readback_sha256, "model output readback digest") !==
    expectedDigest
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
      "model output readback digest differs from the gateway response",
    );
  }
}

async function quotePrice(
  dependencies: ModelGatewayExecutionDependencies,
  fingerprint: RouteFingerprint,
  inputTokens: number,
  outputTokens: number,
): Promise<ModelGatewayPricingQuote> {
  let quote: ModelGatewayPricingQuote;
  try {
    quote = await dependencies.pricing.quote({
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
  boundedIdentifier(quote.quote_ref, "model pricing quote reference");
  if (quote.pricing_snapshot_ref !== fingerprint.pricing_snapshot_ref) {
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
  return quote;
}

async function executeObservedModelGatewayCall(
  dependencies: ModelGatewayExecutionDependencies,
  input: ModelCallInput,
): Promise<ModelGatewayExecutionObservation> {
  let rawDeployment: unknown | null;
  try {
    rawDeployment = await dependencies.deployments.resolve(input.route_ref);
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

  let deployment;
  let policy;
  try {
    deployment = decodeModelRouteDeployment(rawDeployment);
    policy = prepareModelGatewayCall(input, deployment);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model route deployment or call input failed policy validation",
      { cause },
    );
  }

  let compiled;
  try {
    compiled = await dependencies.prompts.compile(input, deployment);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
      "trusted model prompt compiler failed",
      { cause },
    );
  }

  let token: string;
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
    policy,
    compiled,
    dependencies.reasoning_gateway_base_url,
    token,
  );

  let response: Response;
  try {
    response = await dependencies.transport.fetch(request.url, {
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
  if (!(response instanceof Response)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway transport returned a non-Response value",
    );
  }
  if (!response.ok) classifyHttpFailure(response.status);

  const decoded = await decodeModelGatewayResponse(
    response,
    deployment,
    input.max_output_bytes,
  );
  const fingerprintRef = await persistFingerprint(
    dependencies,
    decoded.fingerprint,
  );
  await persistOutput(
    dependencies,
    input,
    decoded.body_bytes,
    decoded.body_sha256,
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
      route_fingerprint_ref: fingerprintRef,
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
    response_body_sha256: decoded.body_sha256,
  });
}

export function createModelGatewayFetchAdapter(
  dependencies: ModelGatewayExecutionDependencies,
): ModelGatewayAdapter {
  return Object.freeze({
    async execute(input): Promise<ModelCallReceipt> {
      const observation = await executeObservedModelGatewayCall(
        dependencies,
        input,
      );
      return observation.receipt;
    },
    async resolveFingerprint(routeRef): Promise<RouteFingerprint> {
      let fingerprint: RouteFingerprint | null;
      try {
        fingerprint = await dependencies.fingerprints.getLatest(routeRef);
      } catch (cause) {
        modelGatewayExecutionFailure(
          "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
          "latest route fingerprint could not be read",
          { cause },
        );
      }
      if (fingerprint === null) {
        modelGatewayExecutionFailure(
          "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
          "latest route fingerprint is not available",
        );
      }
      return fingerprint;
    },
  });
}

export { executeObservedModelGatewayCall };
