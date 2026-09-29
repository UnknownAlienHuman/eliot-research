export type ProviderConfigRestEffect = "NONE" | "CREATE";

export type ProviderConfigRestErrorCode =
  | "PROVIDER_CONFIG_INPUT_INVALID"
  | "PROVIDER_CONFIG_CREDENTIAL_INVALID"
  | "PROVIDER_CONFIG_TRANSPORT_FAILED"
  | "PROVIDER_CONFIG_HTTP_FAILED"
  | "PROVIDER_CONFIG_API_FAILED"
  | "PROVIDER_CONFIG_RESPONSE_TOO_LARGE"
  | "PROVIDER_CONFIG_RESPONSE_INVALID"
  | "PROVIDER_CONFIG_EXISTING_CONFLICT"
  | "PROVIDER_CONFIG_CREATE_UNCERTAIN"
  | "PROVIDER_CONFIG_READBACK_MISMATCH";

export class ProviderConfigRestError extends Error {
  public readonly code: ProviderConfigRestErrorCode;
  public readonly retryable: boolean;
  public readonly effect: ProviderConfigRestEffect;
  public readonly http_status?: number;

  public constructor(
    code: ProviderConfigRestErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly effect?: ProviderConfigRestEffect;
      readonly http_status?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderConfigRestError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.effect = options.effect ?? "NONE";
    if (options.http_status !== undefined) this.http_status = options.http_status;
  }
}

export function providerConfigRestFailure(
  code: ProviderConfigRestErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly effect?: ProviderConfigRestEffect;
    readonly http_status?: number;
    readonly cause?: unknown;
  } = {},
): never {
  throw new ProviderConfigRestError(code, message, options);
}

export interface ProviderConfigDesired {
  readonly protocol: "eliotr.provider-config.v1";
  readonly provider_slug: string;
  readonly alias: string;
  readonly default_config: boolean;
  readonly rate_limit?: number;
  readonly rate_limit_period?: number;
}

export interface ProviderConfigSecretReference {
  readonly secret_id: string;
  readonly secret_name: string;
}

export interface ProviderConfigCredentialPort {
  readApiToken(): Promise<unknown>;
}

export interface ProviderConfigSecretPort {
  readSecretReference(): Promise<unknown>;
}

export interface ProviderConfigFetchPort {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface CloudflareProviderConfigDependencies {
  readonly account_id: unknown;
  readonly gateway_id: unknown;
  readonly credentials: ProviderConfigCredentialPort;
  readonly secret: ProviderConfigSecretPort;
  readonly fetch: ProviderConfigFetchPort;
}

export interface ObservedProviderConfig {
  readonly id: string;
  readonly alias: string;
  readonly default_config: boolean;
  readonly gateway_id: string;
  readonly modified_at: string;
  readonly provider_slug: string;
  readonly secret_id: string;
  readonly rate_limit: number | null;
  readonly rate_limit_period: number | null;
}

export type ProviderConfigProvisioningDisposition =
  | "EXISTING_MATCH"
  | "CREATED"
  | "CREATE_RECONCILED";

export interface ProviderConfigProvisioningReceipt {
  readonly protocol: "eliotr.provider-config-provisioning-receipt.v1";
  readonly disposition: ProviderConfigProvisioningDisposition;
  readonly account_id: string;
  readonly gateway_id: string;
  readonly provider_config_id: string;
  readonly provider_slug: string;
  readonly alias: string;
  readonly default_config: boolean;
  readonly secret_id: string;
  readonly secret_name: string;
  readonly rate_limit: number | null;
  readonly rate_limit_period: number | null;
  readonly config_sha256: string;
  readonly observed_modified_at: string;
}
