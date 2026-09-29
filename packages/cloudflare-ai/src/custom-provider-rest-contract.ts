export type CustomProviderRestEffect = "NONE" | "CREATE";

export type CustomProviderRestErrorCode =
  | "CUSTOM_PROVIDER_INPUT_INVALID"
  | "CUSTOM_PROVIDER_CREDENTIAL_INVALID"
  | "CUSTOM_PROVIDER_TRANSPORT_FAILED"
  | "CUSTOM_PROVIDER_HTTP_FAILED"
  | "CUSTOM_PROVIDER_API_FAILED"
  | "CUSTOM_PROVIDER_RESPONSE_TOO_LARGE"
  | "CUSTOM_PROVIDER_RESPONSE_INVALID"
  | "CUSTOM_PROVIDER_EXISTING_CONFLICT"
  | "CUSTOM_PROVIDER_CREATE_UNCERTAIN"
  | "CUSTOM_PROVIDER_READBACK_MISMATCH";

export class CustomProviderRestError extends Error {
  public readonly code: CustomProviderRestErrorCode;
  public readonly retryable: boolean;
  public readonly effect: CustomProviderRestEffect;
  public readonly http_status?: number;

  public constructor(
    code: CustomProviderRestErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly effect?: CustomProviderRestEffect;
      readonly http_status?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CustomProviderRestError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.effect = options.effect ?? "NONE";
    if (options.http_status !== undefined) {
      this.http_status = options.http_status;
    }
  }
}

export function customProviderRestFailure(
  code: CustomProviderRestErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly effect?: CustomProviderRestEffect;
    readonly http_status?: number;
    readonly cause?: unknown;
  } = {},
): never {
  throw new CustomProviderRestError(code, message, options);
}

export interface CloudflareCustomProviderSpec {
  readonly protocol: "eliotr.custom-provider.v1";
  readonly name: string;
  readonly slug: string;
  readonly base_url: string;
  readonly description?: string;
  readonly link?: string;
  readonly enable: boolean;
  readonly beta: boolean;
}

export interface NormalizedCustomProviderSpec {
  readonly protocol: "eliotr.custom-provider.v1";
  readonly name: string;
  readonly slug: string;
  readonly base_url: string;
  readonly description: string | null;
  readonly link: string | null;
  readonly enable: boolean;
  readonly beta: boolean;
}

export interface ObservedCustomProvider extends NormalizedCustomProviderSpec {
  readonly id: string;
  readonly created_at: string;
  readonly modified_at: string;
  /** Custom Provider inline headers may contain credentials; retain presence only. */
  readonly inline_headers_configured: boolean;
}

export interface CustomProviderCredentialPort {
  readApiToken(): Promise<unknown>;
}

export interface CustomProviderFetchPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface CloudflareCustomProviderDependencies {
  readonly account_id: unknown;
  readonly credentials: CustomProviderCredentialPort;
  readonly fetch: CustomProviderFetchPort;
}

export type CustomProviderProvisioningDisposition =
  | "EXISTING_MATCH"
  | "CREATED"
  | "CREATE_RECONCILED";

export interface CustomProviderProvisioningReceipt {
  readonly protocol: "eliotr.custom-provider-provisioning-receipt.v1";
  readonly disposition: CustomProviderProvisioningDisposition;
  readonly account_id: string;
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly gateway_provider: string;
  readonly model_reference_prefix: string;
  readonly base_url: string;
  readonly config_sha256: string;
  readonly observed_modified_at: string;
}

export interface CustomProviderRestEnvelope {
  readonly result: unknown;
  readonly result_info: unknown;
}

export interface CustomProviderListPage {
  readonly providers: readonly ObservedCustomProvider[];
  readonly page: number;
  readonly per_page: number;
  readonly total_count: number;
  readonly total_pages: number;
}
