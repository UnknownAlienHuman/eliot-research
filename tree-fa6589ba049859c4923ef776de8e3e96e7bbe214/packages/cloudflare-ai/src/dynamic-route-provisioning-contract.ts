import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";

export const DYNAMIC_ROUTE_GATEWAY_ID = "eliotr-reasoning";
export const DYNAMIC_ROUTE_DEFINITION_MAX_BYTES = 192 * 1024;
export const DYNAMIC_ROUTE_ARTIFACT_MAX_BYTES = 256 * 1024;
export const DYNAMIC_ROUTE_QUALIFICATION_MAX_AGE_MS = 60 * 60 * 1000;

export type DynamicRouteAmbiguousEffect =
  | "NONE"
  | "PROVIDER_CREATE"
  | "REGISTRY_STAGE"
  | "REGISTRY_PROMOTION";

export type DynamicRouteProvisioningErrorCode =
  | "DYNAMIC_ROUTE_INPUT_INVALID"
  | "DYNAMIC_ROUTE_CONTROL_PLANE_FAILED"
  | "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID"
  | "DYNAMIC_ROUTE_PROVIDER_NAME_COLLISION"
  | "DYNAMIC_ROUTE_CREATE_UNCERTAIN"
  | "DYNAMIC_ROUTE_READBACK_MISMATCH"
  | "DYNAMIC_ROUTE_QUALIFICATION_INVALID"
  | "DYNAMIC_ROUTE_LIVE_GATE_REQUIRED"
  | "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED"
  | "DYNAMIC_ROUTE_PROMOTION_CONFLICT"
  | "DYNAMIC_ROUTE_PROMOTION_FAILED";

export class DynamicRouteProvisioningError extends Error {
  public readonly code: DynamicRouteProvisioningErrorCode;
  public readonly retryable: boolean;
  public readonly ambiguous_effect: DynamicRouteAmbiguousEffect;

  public constructor(
    code: DynamicRouteProvisioningErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly ambiguous_effect?: DynamicRouteAmbiguousEffect;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "DynamicRouteProvisioningError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous_effect = options.ambiguous_effect ?? "NONE";
  }
}

export function dynamicRouteProvisioningFailure(
  code: DynamicRouteProvisioningErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly ambiguous_effect?: DynamicRouteAmbiguousEffect;
    readonly cause?: unknown;
  } = {},
): never {
  throw new DynamicRouteProvisioningError(code, message, options);
}

export interface DynamicRouteProvisioningInput {
  readonly deployment: unknown;
  readonly route_definition: unknown;
  readonly route_definition_sha256: string;
}

export interface DynamicRouteProviderMetadata {
  readonly route_ref: string;
  readonly route_version: string;
  readonly prompt_generation: string;
  readonly schema_generation: string;
  readonly parameters_digest: string;
  readonly pricing_snapshot_ref: string;
  readonly route_definition_sha256: string;
}

export interface DynamicRouteCreateRequest {
  readonly gateway_id: typeof DYNAMIC_ROUTE_GATEWAY_ID;
  readonly name: string;
  readonly route_definition: unknown;
  readonly metadata: DynamicRouteProviderMetadata;
}

export interface DynamicRouteCompiledDesired {
  readonly deployment: ModelRouteDeployment;
  readonly route_definition: unknown;
  readonly route_definition_sha256: string;
  readonly provider_route_name: string;
  readonly create_request: DynamicRouteCreateRequest;
}

export interface DynamicRouteListEntry {
  readonly provider_route_id: string;
  readonly name: string;
}

export interface DynamicRouteProviderSnapshot {
  readonly provider_route_id: string;
  readonly gateway_id: typeof DYNAMIC_ROUTE_GATEWAY_ID;
  readonly name: string;
  readonly route_definition: unknown;
  readonly metadata: DynamicRouteProviderMetadata;
}

export interface VerifiedDynamicRouteProviderSnapshot {
  readonly snapshot: DynamicRouteProviderSnapshot;
  readonly snapshot_sha256: string;
}

export interface DynamicRouteControlPlanePort {
  list(gatewayId: typeof DYNAMIC_ROUTE_GATEWAY_ID): Promise<unknown>;
  get(
    gatewayId: typeof DYNAMIC_ROUTE_GATEWAY_ID,
    providerRouteId: string,
  ): Promise<unknown>;
  create(request: DynamicRouteCreateRequest): Promise<unknown>;
}

export type DynamicRouteProvisioningDisposition =
  | "EXISTING_MATCH"
  | "CREATED"
  | "CREATE_RECONCILED";

export interface DynamicRouteProvisioningReceipt {
  readonly disposition: DynamicRouteProvisioningDisposition;
  readonly deployment: ModelRouteDeployment;
  readonly provider_route_id: string;
  readonly provider_route_name: string;
  readonly route_definition_sha256: string;
  readonly provider_snapshot_sha256: string;
  readonly control_plane_receipt_ref: string;
}

export type DynamicRouteQualificationTier = "FIXTURE" | "LIVE";

export interface DynamicRouteQualificationEvidence {
  readonly tier: DynamicRouteQualificationTier;
  readonly gateway_id: typeof DYNAMIC_ROUTE_GATEWAY_ID;
  readonly route_ref: string;
  readonly route_version: string;
  readonly prompt_generation: string;
  readonly schema_generation: string;
  readonly parameters_digest: string;
  readonly pricing_snapshot_ref: string;
  readonly provider_route_id: string;
  readonly provider_route_name: string;
  readonly route_definition_sha256: string;
  readonly provider_snapshot_sha256: string;
  readonly control_plane_readback_ref: string;
  readonly execution_probe_ref: string;
  readonly verified_at: string;
  readonly expires_at: string;
}

export interface DynamicRouteCandidate {
  readonly schema: "eliotr.dynamic-route-candidate.v1";
  readonly deployment: ModelRouteDeployment;
  readonly provider_route_id: string;
  readonly provider_route_name: string;
  readonly route_definition_sha256: string;
  readonly provider_snapshot_sha256: string;
  readonly control_plane_receipt_ref: string;
  readonly qualification_tier: DynamicRouteQualificationTier;
  readonly control_plane_readback_ref: string;
  readonly execution_probe_ref: string;
  readonly qualification_expires_at: string;
}

export interface DynamicRouteCandidateWriteReceipt {
  readonly candidate_ref: string;
  readonly readback_sha256: string;
}

export interface DynamicRouteActiveGeneration {
  readonly route_ref: string;
  readonly route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
}

export interface DynamicRoutePromotionCommand {
  readonly route_ref: string;
  readonly expected_active_route_version: string | null;
  readonly target_route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
}

export interface DynamicRoutePromotionWriteReceipt {
  readonly promotion_ref: string;
  readonly active: DynamicRouteActiveGeneration;
}

export interface DynamicRouteRegistryPort {
  stageCandidate(
    candidate: DynamicRouteCandidate,
    expectedSha256: string,
  ): Promise<unknown>;
  getActive(routeRef: string): Promise<unknown | null>;
  promote(command: DynamicRoutePromotionCommand): Promise<unknown>;
}

export interface DynamicRoutePromotionOptions {
  readonly environment: "TEST" | "PRODUCTION";
  readonly expected_active_route_version: string | null;
  readonly now: string;
}

export interface DynamicRoutePromotionReceipt {
  readonly promotion_ref: string;
  readonly route_ref: string;
  readonly previous_route_version: string | null;
  readonly active_route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification_tier: DynamicRouteQualificationTier;
  readonly receipt_ref: string;
}

export interface DynamicRouteProvisioner {
  provision(
    input: DynamicRouteProvisioningInput,
  ): Promise<DynamicRouteProvisioningReceipt>;
  promote(
    receipt: DynamicRouteProvisioningReceipt,
    qualification: DynamicRouteQualificationEvidence,
    options: DynamicRoutePromotionOptions,
  ): Promise<DynamicRoutePromotionReceipt>;
}
