import type {
  ModelGatewayAdapter,
  ModelRouteDeployment,
  RouteFingerprint,
} from "@eliotr/platform-cloudflare";

export type ModelCallInput = Parameters<ModelGatewayAdapter["execute"]>[0];
export type ModelCallReceipt = Awaited<ReturnType<ModelGatewayAdapter["execute"]>>;

export type ModelGatewayExecutionErrorCode =
  | "MODEL_GATEWAY_DEPLOYMENT_MISSING"
  | "MODEL_GATEWAY_PROMPT_COMPILE_FAILED"
  | "MODEL_GATEWAY_REQUEST_INVALID"
  | "MODEL_GATEWAY_CREDENTIAL_INVALID"
  | "MODEL_GATEWAY_TRANSPORT_FAILED"
  | "MODEL_GATEWAY_AUTH_REJECTED"
  | "MODEL_GATEWAY_LIMIT_REJECTED"
  | "MODEL_GATEWAY_POLICY_REJECTED"
  | "MODEL_GATEWAY_UPSTREAM_REJECTED"
  | "MODEL_GATEWAY_RESPONSE_INVALID"
  | "MODEL_GATEWAY_OUTPUT_TRUNCATED"
  | "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED"
  | "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED"
  | "MODEL_GATEWAY_PRICING_FAILED";

export class ModelGatewayExecutionError extends Error {
  public readonly code: ModelGatewayExecutionErrorCode;
  public readonly retryable: boolean;
  public readonly http_status?: number;

  public constructor(
    code: ModelGatewayExecutionErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly http_status?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ModelGatewayExecutionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.http_status !== undefined) {
      this.http_status = options.http_status;
    }
  }
}

export function modelGatewayExecutionFailure(
  code: ModelGatewayExecutionErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly http_status?: number;
    readonly cause?: unknown;
  } = {},
): never {
  throw new ModelGatewayExecutionError(code, message, options);
}

export interface CompiledModelGatewayPrompt {
  readonly request_body: unknown;
  readonly request_body_sha256: string;
  readonly request_timeout_ms: number;
}

export interface ModelGatewayDeploymentRegistryPort {
  resolve(routeRef: string): Promise<unknown | null>;
}

export interface ModelGatewayPromptCompilerPort {
  compile(
    input: ModelCallInput,
    deployment: ModelRouteDeployment,
  ): Promise<unknown>;
}

export interface ModelGatewayCredentialPort {
  readGatewayToken(): Promise<unknown>;
}

export interface ModelGatewayFetchPort {
  fetch(url: string, init: RequestInit): Promise<unknown>;
}

export interface ModelGatewayOutputStorePort {
  putImmutable(
    ref: string,
    body: ReadableStream<Uint8Array>,
    expectedSha256: string,
  ): Promise<unknown>;
}

export interface ModelGatewayFingerprintStorePort {
  putImmutable(
    fingerprint: RouteFingerprint,
    expectedSha256: string,
  ): Promise<unknown>;
  getLatest(routeRef: string): Promise<unknown | null>;
}

export interface ModelGatewayPricingQuoteInput {
  readonly fingerprint: RouteFingerprint;
  readonly pricing_snapshot_ref: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface ModelGatewayPricingQuote {
  readonly quote_ref: string;
  readonly pricing_snapshot_ref: string;
  readonly billed_usd: number;
}

export interface ModelGatewayPricingPort {
  quote(input: ModelGatewayPricingQuoteInput): Promise<unknown>;
}

export interface ModelGatewayExecutionDependencies {
  readonly reasoning_gateway_base_url: string;
  readonly deployments: ModelGatewayDeploymentRegistryPort;
  readonly prompts: ModelGatewayPromptCompilerPort;
  readonly credentials: ModelGatewayCredentialPort;
  readonly transport: ModelGatewayFetchPort;
  readonly outputs: ModelGatewayOutputStorePort;
  readonly fingerprints: ModelGatewayFingerprintStorePort;
  readonly pricing: ModelGatewayPricingPort;
}

export interface PreparedModelGatewayHttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly body_sha256: string;
  readonly parameters_sha256: string;
  readonly request_timeout_ms: number;
}

export interface ModelGatewayUsageObservation {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

export interface DecodedModelGatewayResponse {
  readonly body_bytes: Uint8Array;
  readonly body_sha256: string;
  readonly assistant_content: string;
  readonly response_model: string;
  readonly usage: ModelGatewayUsageObservation;
  readonly fingerprint: RouteFingerprint;
  readonly log_id: string;
  readonly cache_status?: "MISS";
  readonly successful_step?: string;
}

export interface ModelGatewayExecutionObservation {
  readonly receipt: ModelCallReceipt;
  readonly route_fingerprint: RouteFingerprint;
  readonly gateway_log_id: string;
  readonly pricing_quote_ref: string;
  readonly request_body_sha256: string;
  readonly request_parameters_sha256: string;
  readonly response_body_sha256: string;
  readonly response_model: string;
  readonly successful_step?: string;
}
