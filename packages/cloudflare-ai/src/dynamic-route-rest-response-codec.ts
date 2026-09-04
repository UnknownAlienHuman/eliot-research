import { canonicalModelGatewayJson } from "./model-gateway-request.js";
import {
  DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES,
  type DynamicRouteRestAmbiguousEffect,
  type DynamicRouteRestResponse,
} from "./dynamic-route-rest-contract.js";
import {
  boundedStatus,
  dynamicRouteRestFailure,
  exactObject,
  responseInvalid,
} from "./dynamic-route-rest-codec.js";

const MAX_API_MESSAGES = 100;
const MAX_API_MESSAGE_BYTES = 4 * 1024;
const ENVELOPE_KEYS = new Set([
  "errors",
  "messages",
  "result",
  "result_info",
  "success",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function readDynamicRouteRestJson(
  response: DynamicRouteRestResponse,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      dynamicRouteRestFailure(
        "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
        "Cloudflare response contains a malformed content-length",
        { ambiguous_effect: ambiguousEffect },
      );
    }
    if (Number(declaredLength) > DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES) {
      dynamicRouteRestFailure(
        "DYNAMIC_ROUTE_REST_RESPONSE_TOO_LARGE",
        "Cloudflare response exceeds the byte envelope",
        { ambiguous_effect: ambiguousEffect },
      );
    }
  }

  let bytes: Uint8Array;
  if (response.body === null) {
    const text = await response.text();
    bytes = encoder.encode(text);
    if (bytes.byteLength > DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES) {
      dynamicRouteRestFailure(
        "DYNAMIC_ROUTE_REST_RESPONSE_TOO_LARGE",
        "Cloudflare response exceeds the byte envelope",
        { ambiguous_effect: ambiguousEffect },
      );
    }
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        await reader.cancel("invalid response chunk");
        dynamicRouteRestFailure(
          "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
          "Cloudflare response stream returned a non-byte chunk",
          { ambiguous_effect: ambiguousEffect },
        );
      }
      total += chunk.value.byteLength;
      if (total > DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES) {
        await reader.cancel("response byte envelope exceeded");
        dynamicRouteRestFailure(
          "DYNAMIC_ROUTE_REST_RESPONSE_TOO_LARGE",
          "Cloudflare response exceeds the byte envelope",
          { ambiguous_effect: ambiguousEffect },
        );
      }
      chunks.push(chunk.value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      "Cloudflare response is not valid UTF-8",
      { ambiguous_effect: ambiguousEffect },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      "Cloudflare response is not valid JSON",
      { ambiguous_effect: ambiguousEffect },
    );
  }
}

export function decodeCloudflareApiEnvelope(
  raw: unknown,
  response: DynamicRouteRestResponse,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect,
): Readonly<{ result: unknown; result_info: unknown }> {
  const root = exactObject(
    raw,
    ENVELOPE_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare API envelope",
    ambiguousEffect,
  );
  if (typeof root.success !== "boolean") {
    responseInvalid("Cloudflare API success flag is malformed", ambiguousEffect);
  }
  decodeMessageArray(root.errors, "errors", ambiguousEffect);
  decodeMessageArray(root.messages, "messages", ambiguousEffect);
  if (!response.ok) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_HTTP_FAILED",
      `Cloudflare control plane returned HTTP ${boundedStatus(response.status)}`,
      {
        retryable: response.status >= 500,
        ambiguous_effect: ambiguousEffect,
      },
    );
  }
  if (root.success !== true || (root.errors as readonly unknown[]).length !== 0) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_API_FAILED",
      "Cloudflare control plane rejected the request",
      { ambiguous_effect: ambiguousEffect },
    );
  }
  if (!("result" in root)) {
    responseInvalid("Cloudflare API result is missing", ambiguousEffect);
  }
  return Object.freeze({
    result: root.result,
    result_info: root.result_info,
  });
}

function decodeMessageArray(
  raw: unknown,
  label: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect,
): void {
  if (!Array.isArray(raw) || raw.length > MAX_API_MESSAGES) {
    responseInvalid(`Cloudflare API ${label} is malformed`, ambiguousEffect);
  }
  for (const entry of raw) {
    const json = canonicalModelGatewayJson(entry);
    if (encoder.encode(json).byteLength > MAX_API_MESSAGE_BYTES) {
      responseInvalid(
        `Cloudflare API ${label} exceeds its bound`,
        ambiguousEffect,
      );
    }
  }
}
