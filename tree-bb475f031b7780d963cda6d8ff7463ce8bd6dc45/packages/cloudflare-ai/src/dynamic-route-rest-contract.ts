import type {
  DynamicRouteControlPlanePort,
  DynamicRouteCreateRequest,
  DynamicRouteProviderMetadata,
} from "./dynamic-route-provisioning-contract.js";

export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
export const DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES = 512 * 1024;
export const DYNAMIC_ROUTE_REST_LIST_MAX_PAGES = 100;
export const DYNAMIC_ROUTE_REST_LIST_PER_PAGE = 100;

export type DynamicRouteRestAmbiguousEffect =
  | "NONE"
  | "ROUTE_CREATE"
  | "DEPLOYMENT_CREATE"
  | "BINDING_WRITE";

export type DynamicRouteRestErrorCode =
  | "DYNAMIC_ROUTE_REST_INPUT_INVALID"
  | "DYNAMIC_ROUTE_REST_CREDENTIAL_INVALID"
  | "DYNAMIC_ROUTE_REST_TRANSPORT_FAILED"
  | "DYNAMIC_ROUTE_REST_HTTP_FAILED"
  | "DYNAMIC_ROUTE_REST_API_FAILED"
  | "DYNAMIC_ROUTE_REST_RESPONSE_INVALID"
  | "DYNAMIC_ROUTE_REST_RESPONSE_TOO_LARGE"
  | "DYNAMIC_ROUTE_REST_BINDING_MISSING"
  | "DYNAMIC_ROUTE_REST_BINDING_FAILED"
  | "DYNAMIC_ROUTE_REST_BINDING_CONFLICT"
  | "DYNAMIC_ROUTE_REST_READBACK_MISMATCH";

export class DynamicRouteRestError extends Error {
  public readonly code: DynamicRouteRestErrorCode;
  public readonly retryable: boolean;
  public readonly ambiguous_effect: DynamicRouteRestAmbiguousEffect;

  public constructor(
    code: DynamicRouteRestErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly ambiguous_effect?: DynamicRouteRestAmbiguousEffect;
    } = {},
  ) {
    super(message);
    this.name = "DynamicRouteRestError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous_effect = options.ambiguous_effect ?? "NONE";
  }
}

export interface DynamicRouteRestHeaders {
  get(name: string): string | null;
}

export interface DynamicRouteRestBodyReader {
  read(): Promise<Readonly<{ done: boolean; value?: Uint8Array }>>;
  cancel(reason?: unknown): Promise<void>;
}

export interface DynamicRouteRestResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: DynamicRouteRestHeaders;
  readonly body: Readonly<{ getReader(): DynamicRouteRestBodyReader }> | null;
  text(): Promise<string>;
}

export interface DynamicRouteRestFetchPort {
  fetch(
    url: string,
    init: Readonly<{
      method: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ): Promise<DynamicRouteRestResponse>;
}

export interface DynamicRouteRestCredentialPort {
  readApiToken(): Promise<string>;
}

export interface DynamicRouteRestBinding {
  readonly protocol: "eliotr.dynamic-route-rest-binding.v1";
  readonly account_id: string;
  readonly gateway_id: string;
  readonly provider_route_id: string;
  readonly provider_route_name: string;
  readonly provider_version_id: string;
  readonly provider_deployment_id: string;
  readonly route_definition_sha256: string;
  readonly metadata: DynamicRouteProviderMetadata;
}

export interface DynamicRouteRestBindingWriteReceipt {
  readonly binding: DynamicRouteRestBinding;
  readonly readback_sha256: string;
}

export interface DynamicRouteRestBindingStorePort {
  get(providerRouteId: string): Promise<unknown | null>;
  putImmutable(
    binding: DynamicRouteRestBinding,
    expectedSha256: string,
  ): Promise<unknown>;
}

export interface DynamicRouteRestControlPlaneDependencies {
  readonly account_id: string;
  readonly fetch: DynamicRouteRestFetchPort;
  readonly credentials: DynamicRouteRestCredentialPort;
  readonly bindings: DynamicRouteRestBindingStorePort;
}

export interface DynamicRouteRestControlPlane
  extends DynamicRouteControlPlanePort {
  readonly gateway_id: "eliotr-reasoning";
}

export interface DecodedDynamicRouteVersion {
  readonly id: string;
  readonly route_id: string;
  readonly elements: readonly unknown[];
}

export interface DecodedDynamicRouteDeployment {
  readonly id: string;
  readonly route_id: string;
  readonly version_id: string;
}

export interface DecodedDynamicRoute {
  readonly id: string;
  readonly name: string;
  readonly version: DecodedDynamicRouteVersion;
  readonly deployment: DecodedDynamicRouteDeployment | null;
}

export interface DynamicRouteRestCreateState {
  readonly request: DynamicRouteCreateRequest;
  readonly route: DecodedDynamicRoute;
  readonly deployment: DecodedDynamicRouteDeployment;
}
