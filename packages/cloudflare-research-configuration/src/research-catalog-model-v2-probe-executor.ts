import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  prepareCatalogModelQualificationHttpRequest,
  ModelGatewayExecutionError,
} from "@eliotr/cloudflare-ai";
import {
  PROVIDER_NATIVE_MODEL_PROBE_MAX_TOKENS,
  PROVIDER_NATIVE_MODEL_PROBE_PROMPT,
  PROVIDER_NATIVE_MODEL_PROBE_TEMPERATURE,
  type ProviderNativeModelCatalogObservationV2,
  type ProviderNativeModelCatalogPreparationV2,
} from "@eliotr/cloudflare-native-models";
import { decodeModelGatewayProviderNativeResponse } from "@eliotr/cloudflare-model-transport/model-gateway-provider-native-response.js";
import { rejectModelGatewayHttpFailure } from "@eliotr/cloudflare-model-transport/model-gateway-http-failure.js";

const MAX_REQUEST_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_TIMEOUT_MS = 30_000;
const MAX_QUALIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_BYTES = 16_384;

/** A bounded digest is diagnostic evidence, never proof that the provider had no effects. */
export async function summarizeCatalogModelProbeHttpFailure(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (reader === undefined) return { response_digest_scope: "UNAVAILABLE", response_bytes_captured: 0,
    error_code: "HTTP_ERROR_BODY_UNAVAILABLE", upstream_error_codes: [] as number[] };
  const chunks: Uint8Array[] = [];
  let length = 0, complete = false;
  let abortRead: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortRead = () => reject(new Error("bounded diagnostic read aborted"));
    signal.addEventListener("abort", abortRead, { once: true });
  });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) { complete = true; break; }
      const remaining = MAX_ERROR_BYTES - length;
      if (next.value.byteLength > remaining) {
        chunks.push(next.value.slice(0, remaining)); length = MAX_ERROR_BYTES; break;
      }
      chunks.push(next.value); length += next.value.byteLength;
    }
  } catch { /* Preserve a labeled prefix; never parse an incomplete error body. */ }
  finally {
    if (abortRead !== undefined) signal.removeEventListener("abort", abortRead);
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let code = "HTTP_ERROR_BODY_INCOMPLETE";
  let codes: number[] = [];
  if (complete) {
    code = "HTTP_RESPONSE_UNVERIFIED";
    try {
      // Reuse the established Gateway numeric-code semantics. No Go-specific
      // interpretation is inferred from an arbitrary provider message/string.
      await rejectModelGatewayHttpFailure(new Response(bytes, { status: response.status, headers: response.headers }));
    } catch (error) {
      if (error instanceof ModelGatewayExecutionError) {
        code = error.code;
        const cause = error.cause;
        if (typeof cause === "object" && cause !== null && "upstream_error_codes" in cause && Array.isArray(cause.upstream_error_codes)) {
          codes = cause.upstream_error_codes.filter((value): value is number =>
            typeof value === "number" && Number.isSafeInteger(value) && value >= 0).slice(0, 8);
        }
      }
    }
  }
  return { response_digest_scope: complete ? "FULL" : "PREFIX", response_bytes_captured: length,
    response_sha256: await modelGatewaySha256(bytes), error_code: code, upstream_error_codes: codes };
}

export class ResearchCatalogModelV2ProbeExecutorError extends Error {
  public constructor(public readonly code: "AUTHORITY_CHANGED" | "SERVER_POLICY_UNAVAILABLE" | "PROBE_UNVERIFIED",
    message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchCatalogModelV2ProbeExecutorError";
  }
}

/** Calls the generic provider-native qualification helper with the exact saved alias and physical provider slug. */
export function createResearchCatalogModelV2ProbeExecutor(input: Readonly<{
  gateway_base_url: string;
  gateway_token: string | undefined;
  signal: AbortSignal;
  maximum_input_bytes: number;
  maximum_output_bytes: number;
  assert_current_authority: (preparation: ProviderNativeModelCatalogPreparationV2) => Promise<void>;
  now?: () => number;
  fetcher?: typeof fetch;
}>) {
  const now = input.now ?? (() => Date.now());
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis);

  return Object.freeze({
    async executeOnce(preparation: ProviderNativeModelCatalogPreparationV2) {
      const policy = preparation.transport_policy;
      if (typeof input.gateway_token !== "string" || input.gateway_token.trim() === "" || input.signal.aborted ||
          typeof input.gateway_base_url !== "string" || policy.api === "compat-chat-completions" ||
          policy.billing.mode !== "byok" || policy.billing.alias === "default" ||
          policy.billing.alias !== preparation.key_binding.alias || policy.provider !== preparation.provider_slug ||
          policy.model !== preparation.model_id) {
        throw new ResearchCatalogModelV2ProbeExecutorError("SERVER_POLICY_UNAVAILABLE",
          "Exact provider-native catalog transport or Worker Gateway credential is unavailable");
      }
      const tokenField = policy.capabilities.max_output_tokens_field;
      const compiledBody = Object.freeze({
        model: preparation.model_id,
        messages: Object.freeze([Object.freeze({ role: "user", content: PROVIDER_NATIVE_MODEL_PROBE_PROMPT })]),
        [tokenField]: PROVIDER_NATIVE_MODEL_PROBE_MAX_TOKENS,
        temperature: PROVIDER_NATIVE_MODEL_PROBE_TEMPERATURE,
        response_format: Object.freeze({ type: "json_object" }),
        stream: false,
      });
      const compiledJson = canonicalModelGatewayJson(compiledBody);
      const compiledSha = await modelGatewaySha256(compiledJson);
      const remaining = Date.parse(preparation.preparation_expires_at) - now();
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.floor(remaining));
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || input.signal.aborted) {
        throw new ResearchCatalogModelV2ProbeExecutorError("AUTHORITY_CHANGED",
          "Owner consent or catalog preparation expired before qualification");
      }
      const prepared = await prepareCatalogModelQualificationHttpRequest({
        deployment: preparation.probe_deployment,
        transport_policy: policy,
        compiled: Object.freeze({ request_body: compiledBody, request_body_sha256: compiledSha, request_timeout_ms: timeoutMs }),
        gateway_base_url: input.gateway_base_url,
        gateway_token: input.gateway_token,
        maximum_input_bytes: input.maximum_input_bytes,
        maximum_output_bytes: input.maximum_output_bytes,
        gateway_metadata: Object.freeze({ operation_id: preparation.consent_operation_id, stage_id: preparation.stage }),
      });
      if (prepared.parameters_sha256 !== preparation.probe_parameters_sha256 ||
          prepared.parameters_sha256 !== preparation.probe_deployment.parameters_digest) {
        throw new ResearchCatalogModelV2ProbeExecutorError("SERVER_POLICY_UNAVAILABLE",
          "Catalog probe parameters differ from the immutable v2 preparation");
      }
      await input.assert_current_authority(preparation);
      if (input.signal.aborted || Date.parse(preparation.preparation_expires_at) - now() < prepared.request_timeout_ms) {
        throw new ResearchCatalogModelV2ProbeExecutorError("AUTHORITY_CHANGED",
          "Owner or provider authority changed before the provider call");
      }

      const controller = new AbortController();
      const propagateAbort = () => controller.abort(input.signal.reason);
      input.signal.addEventListener("abort", propagateAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException("Catalog model probe timed out", "TimeoutError")),
        prepared.request_timeout_ms);
      try {
        const requestBodyBytes = new TextEncoder().encode(prepared.body);
        if (requestBodyBytes.byteLength > MAX_REQUEST_BYTES || input.signal.aborted) {
          throw new ResearchCatalogModelV2ProbeExecutorError("AUTHORITY_CHANGED", "Catalog model probe was cancelled or oversized");
        }
        const response = await fetcher(prepared.url, { method: prepared.method, headers: prepared.headers,
          body: prepared.body, signal: controller.signal, redirect: "manual" });
        if (response.status !== 200 || response.redirected || (response.url !== "" && response.url !== prepared.url)) {
          const logId = response.headers.get("cf-aig-log-id");
          const redirected = response.redirected || (response.url !== "" && response.url !== prepared.url) ||
            (response.status >= 300 && response.status < 400);
          const failure = redirected ? { error_code: "REDIRECT_REJECTED", response_digest_scope: "UNAVAILABLE",
            response_bytes_captured: 0, upstream_error_codes: [] } : await summarizeCatalogModelProbeHttpFailure(response, controller.signal);
          console.warn(JSON.stringify({ event: "eliotr.catalog_native_v2_probe.http_rejected",
            operation_id: preparation.consent_operation_id, stage: preparation.stage, http_status: response.status,
            classification: redirected ? "REDIRECT_REJECTED" : response.status >= 500 ? "HTTP_SERVER_AMBIGUOUS" :
              response.status >= 400 ? "HTTP_CLIENT_REJECTED" : "HTTP_RESPONSE_UNVERIFIED",
            ...(logId !== null && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(logId) ? { gateway_log_id: logId } : {}),
            ...failure,
          }));
          if (redirected) await response.body?.cancel();
          throw new ResearchCatalogModelV2ProbeExecutorError("PROBE_UNVERIFIED",
            "The selected provider did not acknowledge the one-shot qualification request");
        }
        const decoded = await decodeModelGatewayProviderNativeResponse(response, preparation.probe_deployment,
          Math.min(input.maximum_output_bytes, MAX_RESPONSE_BYTES), policy);
        let output: unknown;
        try { output = JSON.parse(decoded.assistant_content) as unknown; }
        catch (cause) { throw new ResearchCatalogModelV2ProbeExecutorError("PROBE_UNVERIFIED",
          "Provider response did not match the structured connectivity probe", cause); }
        if (output === null || typeof output !== "object" || Array.isArray(output) ||
            Object.getPrototypeOf(output) !== Object.prototype || Object.keys(output).length !== 2 ||
            (output as Record<string, unknown>).connected !== true ||
            (output as Record<string, unknown>).qualification_purpose !== "structured-output-connectivity") {
          throw new ResearchCatalogModelV2ProbeExecutorError("PROBE_UNVERIFIED",
            "Provider response did not match the exact structured connectivity schema");
        }
        const observedAtMs = now();
        const expiresAtMs = Math.min(observedAtMs + MAX_QUALIFICATION_TTL_MS,
          Date.parse(preparation.pricing_snapshot_expires_at));
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= observedAtMs) {
          throw new ResearchCatalogModelV2ProbeExecutorError("SERVER_POLICY_UNAVAILABLE",
            "Trusted pricing expires before catalog qualification can be retained");
        }
        const observation: ProviderNativeModelCatalogObservationV2 = Object.freeze({
          protocol: "eliotr.provider-native-model-observation.v2",
          qualification_purpose: "structured-output-connectivity",
          api: policy.api,
          provider_id: preparation.provider_id,
          provider_slug: preparation.provider_slug,
          model_id: preparation.model_id,
          consent_request_sha256: preparation.request_sha256,
          request_body_sha256: prepared.body_sha256,
          response_body_sha256: await modelGatewaySha256(decoded.body_bytes),
          response_model: decoded.response_model,
          gateway_log_id: decoded.log_id,
          input_tokens: decoded.usage.input_tokens,
          output_tokens: decoded.usage.output_tokens,
          verified_at: new Date(observedAtMs).toISOString(),
          expires_at: new Date(expiresAtMs).toISOString(),
        });
        return Object.freeze({ ...observation, request_body_bytes: requestBodyBytes,
          response_body_bytes: new Uint8Array(decoded.body_bytes) });
      } catch (cause) {
        if (cause instanceof ResearchCatalogModelV2ProbeExecutorError) throw cause;
        if (cause instanceof ModelGatewayExecutionError) {
          console.warn(JSON.stringify({ event: "eliotr.catalog_native_v2_probe.rejected", stage: preparation.stage,
            code: cause.code, safe_response_reason: cause.safe_response_reason ?? "UNCLASSIFIED" }));
        }
        throw new ResearchCatalogModelV2ProbeExecutorError("PROBE_UNVERIFIED",
          "The selected provider call did not produce a verified one-shot qualification result", cause);
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", propagateAbort);
      }
    },
  });
}
