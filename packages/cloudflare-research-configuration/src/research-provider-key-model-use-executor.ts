import {
  PROVIDER_NATIVE_MODEL_PROBE_PROMPT,
  providerNativeModelProbeZeroPriceQuoteRef,
  type ProviderNativeModelPreparationV1,
  type ProviderNativeModelProbeExecutionV1,
} from "@eliotr/cloudflare-native-models";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { prepareNativeQualificationHttpRequest } from "@eliotr/cloudflare-model-transport/model-gateway-http-request.js";
import { decodeModelGatewayProviderNativeResponse } from "@eliotr/cloudflare-model-transport/model-gateway-provider-native-response.js";
import type { ResearchProviderKeyModelUseRow, ResearchProviderKeyModelUseStageRow } from "./research-provider-key-model-use-store.js";

const MAX_REQUEST_BYTES = 32_768;
const MAX_PROBE_TIMEOUT_MS = 30_000;

export class ResearchProviderKeyModelProbeExecutorError extends Error {
  public constructor(public readonly code: "PROVIDER_KEY_MODEL_USE_AUTHORITY_CHANGED" | "PROVIDER_KEY_MODEL_USE_SERVER_POLICY_UNAVAILABLE" | "PROVIDER_KEY_MODEL_USE_PROBE_NO_EFFECT", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyModelProbeExecutorError";
  }
}

export interface ResearchProviderKeyModelProbeCurrentAuthority {
  readonly operation: ResearchProviderKeyModelUseRow;
  readonly stage: ResearchProviderKeyModelUseStageRow;
}

export function createResearchProviderKeyModelNativeProbeExecutor(input: {
  readonly gateway_base_url: string;
  readonly gateway_token: string | undefined;
  readonly signal: AbortSignal;
  readonly maximum_input_bytes: number;
  readonly maximum_output_bytes: number;
  readonly readCurrentAuthority: (preparation: ProviderNativeModelPreparationV1) => Promise<ResearchProviderKeyModelProbeCurrentAuthority | null>;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
}) {
  const now = input.now ?? (() => Date.now());
  const fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis);

  async function executeOnce(args: {
    readonly preparation_ref: string;
    readonly preparation_sha256: string;
    readonly preparation: ProviderNativeModelPreparationV1;
  }): Promise<ProviderNativeModelProbeExecutionV1> {
    const preparation = args.preparation;
    if (typeof input.gateway_token !== "string" || input.gateway_token.trim() === "" ||
        input.signal.aborted || typeof input.gateway_base_url !== "string" ||
        preparation.transport_policy.api !== "openrouter-chat-completions" ||
        preparation.transport_policy.provider !== "openrouter" ||
        preparation.transport_policy.model !== "stealth/space-bunny-alpha" ||
        preparation.transport_policy.billing.mode !== "byok" ||
        preparation.transport_policy.billing.free_only !== true ||
        preparation.transport_policy.billing.alias !== preparation.key_binding.alias) {
      throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_SERVER_POLICY_UNAVAILABLE",
        "The exact free-only OpenRouter Gateway policy or server credential is unavailable");
    }
    const compiledBody = Object.freeze({
      model: preparation.transport_policy.model,
      messages: Object.freeze([Object.freeze({ role: "user", content: PROVIDER_NATIVE_MODEL_PROBE_PROMPT })]),
      max_tokens: 32,
      response_format: Object.freeze({ type: "json_object" }),
      stream: false,
    });
    const bodySha = await modelGatewaySha256(canonicalModelGatewayJson(compiledBody));
    const currentMilliseconds = now();
    const remaining = Math.min(Date.parse(preparation.preparation_expires_at), Date.parse(inputDeadline(preparation, await input.readCurrentAuthority(preparation)))) - currentMilliseconds;
    if (!Number.isFinite(remaining) || remaining < 5_000 || input.signal.aborted) {
      throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_AUTHORITY_CHANGED",
        "The owner check/use operation or native preparation expired before qualification");
    }
    const timeoutMs = Math.min(MAX_PROBE_TIMEOUT_MS, Math.floor(remaining));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_AUTHORITY_CHANGED",
        "The bounded native qualification window expired");
    }
    const prepared = await prepareNativeQualificationHttpRequest({
      deployment: preparation.probe_deployment,
      transport_policy: preparation.transport_policy,
      compiled: Object.freeze({
        request_body: compiledBody,
        request_body_sha256: bodySha,
        request_timeout_ms: timeoutMs,
      }),
      gateway_base_url: input.gateway_base_url,
      gateway_token: input.gateway_token,
      maximum_input_bytes: input.maximum_input_bytes,
      maximum_output_bytes: input.maximum_output_bytes,
      gateway_metadata: Object.freeze({ operation_id: preparation.owner_operation_id, stage_id: preparation.stage }),
    });
    if (prepared.parameters_sha256 !== preparation.probe_parameters_sha256 ||
        prepared.parameters_sha256 !== preparation.probe_deployment.parameters_digest) {
      throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_SERVER_POLICY_UNAVAILABLE",
        "The exact server-owned connectivity probe does not match its prepared parameters");
    }

    // The native authority has already made its durable one-shot claim. Re-read
    // owner, project, key and stage immediately before the one allowed fetch.
    const current = await input.readCurrentAuthority(preparation);
    if (current === null || current.operation.owner_id !== preparation.owner_ref ||
        current.operation.project_id !== preparation.project_id ||
        current.operation.operation_id !== preparation.owner_operation_id ||
        current.operation.key_operation_id !== preparation.key_binding.operation_id ||
        current.operation.account_id !== preparation.key_binding.account_id ||
        current.operation.gateway_id !== preparation.key_binding.gateway_id ||
        current.operation.alias !== preparation.key_binding.alias ||
        current.operation.provider_config_id !== preparation.key_binding.provider_config_id ||
        current.operation.configuration_metadata_sha256 !== preparation.key_binding.configuration_metadata_sha256 ||
        current.operation.state !== "QUALIFYING" || current.operation.phase !== "NATIVE_QUALIFY" ||
        current.operation.active_stage !== preparation.stage || current.stage.stage !== preparation.stage ||
        current.stage.state !== "QUALIFYING" || current.stage.preparation_ref !== args.preparation_ref ||
        current.stage.preparation_sha256 !== args.preparation_sha256 || input.signal.aborted) {
      throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_AUTHORITY_CHANGED",
        "Owner, project, key or native qualification stage changed before the provider call");
    }
    const finalNow = now();
    const finalRemaining = Math.min(Date.parse(preparation.preparation_expires_at), Date.parse(current.operation.deadline_at)) - finalNow;
    if (!Number.isFinite(finalRemaining) || finalRemaining < prepared.request_timeout_ms || input.signal.aborted) {
      throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_AUTHORITY_CHANGED",
        "Owner authority or native preparation expired before the provider call");
    }

    const controller = new AbortController();
    const propagateAbort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", propagateAbort, { once: true });
    if (input.signal.aborted) controller.abort(input.signal.reason);
    const timer = setTimeout(() => controller.abort(new DOMException("Native probe timed out", "TimeoutError")), prepared.request_timeout_ms);
    try {
      const requestBodyBytes = new TextEncoder().encode(prepared.body);
      if (requestBodyBytes.byteLength > MAX_REQUEST_BYTES) {
        throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_SERVER_POLICY_UNAVAILABLE",
          "Prepared free-only OpenRouter request exceeds its fixed byte bound");
      }
      if (controller.signal.aborted || input.signal.aborted) {
        throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_AUTHORITY_CHANGED",
          "Owner request was cancelled before the provider call");
      }
      const response = await fetcher(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status !== 200) {
        throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_PROBE_NO_EFFECT",
          "OpenRouter Gateway did not acknowledge the connectivity probe with HTTP 200");
      }
      const decoded = await decodeModelGatewayProviderNativeResponse(
        response,
        preparation.probe_deployment,
        input.maximum_output_bytes,
        preparation.transport_policy,
      );
      const routeFingerprint = Object.freeze({
        ...preparation.probe_deployment,
        provider: preparation.transport_policy.provider,
        exact_model_id: preparation.transport_policy.model,
      });
      const pricingQuoteRef = await providerNativeModelProbeZeroPriceQuoteRef(
        preparation,
        routeFingerprint,
        decoded.usage.input_tokens,
        decoded.usage.output_tokens,
      );
      return Object.freeze({
        protocol: "eliotr.provider-native-model-probe-execution.v1",
        qualification_purpose: "structured-output-connectivity",
        api: "openrouter-chat-completions",
        provider: "openrouter",
        exact_model_id: preparation.transport_policy.model,
        route_fingerprint: routeFingerprint,
        gateway_log_id: decoded.log_id,
        request_body_bytes: requestBodyBytes,
        response_body_bytes: new Uint8Array(decoded.body_bytes),
        response_model: decoded.response_model,
        input_tokens: decoded.usage.input_tokens,
        output_tokens: decoded.usage.output_tokens,
        billed_usd: 0,
        pricing_quote_ref: pricingQuoteRef,
        ...(decoded.successful_step === undefined ? {} : { successful_step: decoded.successful_step }),
      });
    } catch (cause) {
      if (cause instanceof ResearchProviderKeyModelProbeExecutorError) throw cause;
      throw new ResearchProviderKeyModelProbeExecutorError("PROVIDER_KEY_MODEL_USE_PROBE_NO_EFFECT",
        "The one-shot native connectivity request did not produce an acknowledged response", cause);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", propagateAbort);
    }
  }

  return Object.freeze({ executeOnce });
}

function inputDeadline(
  preparation: ProviderNativeModelPreparationV1,
  current: ResearchProviderKeyModelProbeCurrentAuthority | null,
): string {
  if (current === null || current.operation.operation_id !== preparation.owner_operation_id ||
      current.operation.owner_id !== preparation.owner_ref || current.operation.project_id !== preparation.project_id ||
      current.operation.key_operation_id !== preparation.key_binding.operation_id) return "";
  return current.operation.deadline_at;
}
