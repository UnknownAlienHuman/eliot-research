import {
  DYNAMIC_ROUTE_GATEWAY_ID,
  DYNAMIC_ROUTE_QUALIFICATION_MAX_AGE_MS,
  dynamicRouteProvisioningFailure,
  type DynamicRouteActiveGeneration,
  type DynamicRouteCandidate,
  type DynamicRouteCandidateWriteReceipt,
  type DynamicRoutePromotionOptions,
  type DynamicRoutePromotionWriteReceipt,
  type DynamicRouteProvisioningErrorCode,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
} from "./dynamic-route-provisioning-contract.js";
import {
  boundedDynamicRouteIdentifier,
  decodeDynamicRouteDeploymentForProvisioning,
  exactDynamicRouteObject,
  exactDynamicRouteSha256,
  providerDynamicRouteName,
} from "./dynamic-route-provisioning-codec.js";

const PROVISIONING_RECEIPT_KEYS = new Set([
  "control_plane_receipt_ref",
  "deployment",
  "disposition",
  "provider_route_id",
  "provider_route_name",
  "provider_snapshot_sha256",
  "route_definition_sha256",
]);
const QUALIFICATION_KEYS = new Set([
  "control_plane_readback_ref",
  "execution_probe_ref",
  "expires_at",
  "gateway_id",
  "parameters_digest",
  "pricing_snapshot_ref",
  "prompt_generation",
  "provider_route_id",
  "provider_route_name",
  "provider_snapshot_sha256",
  "route_definition_sha256",
  "route_ref",
  "route_version",
  "schema_generation",
  "tier",
  "verified_at",
]);
const CANDIDATE_WRITE_KEYS = new Set(["candidate_ref", "readback_sha256"]);
const ACTIVE_KEYS = new Set([
  "candidate_ref",
  "candidate_sha256",
  "route_ref",
  "route_version",
]);
const PROMOTION_WRITE_KEYS = new Set(["active", "promotion_ref"]);

export function decodeDynamicRouteProvisioningReceipt(
  raw: unknown,
): DynamicRouteProvisioningReceipt {
  const value = exactDynamicRouteObject(
    raw,
    PROVISIONING_RECEIPT_KEYS,
    "DYNAMIC_ROUTE_INPUT_INVALID",
    "dynamic route provisioning receipt",
  );
  if (
    value.disposition !== "EXISTING_MATCH" &&
    value.disposition !== "CREATED" &&
    value.disposition !== "CREATE_RECONCILED"
  ) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route provisioning disposition is invalid",
    );
  }
  return Object.freeze({
    disposition: value.disposition,
    deployment: decodeDynamicRouteDeploymentForProvisioning(value.deployment, "DYNAMIC_ROUTE_INPUT_INVALID"),
    provider_route_id: boundedDynamicRouteIdentifier(
      value.provider_route_id,
      "provisioning provider route ID",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
    provider_route_name: providerDynamicRouteName(
      value.provider_route_name,
      "provisioning provider route name",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
    route_definition_sha256: exactDynamicRouteSha256(
      value.route_definition_sha256,
      "provisioning route definition digest",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
    provider_snapshot_sha256: exactDynamicRouteSha256(
      value.provider_snapshot_sha256,
      "provisioning provider snapshot digest",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
    control_plane_receipt_ref: boundedDynamicRouteIdentifier(
      value.control_plane_receipt_ref,
      "control-plane receipt reference",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
  });
}

function canonicalTimestamp(
  value: unknown,
  label: string,
  code: DynamicRouteProvisioningErrorCode,
): Readonly<{ text: string; epoch_ms: number }> {
  if (typeof value !== "string") {
    dynamicRouteProvisioningFailure(code, `${label} must be a timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    dynamicRouteProvisioningFailure(code, `${label} is not canonical UTC time`);
  }
  return Object.freeze({ text: value, epoch_ms: epoch });
}

export function validateDynamicRouteQualification(
  raw: unknown,
  receipt: DynamicRouteProvisioningReceipt,
  options: DynamicRoutePromotionOptions,
): DynamicRouteQualificationEvidence {
  const value = exactDynamicRouteObject(
    raw,
    QUALIFICATION_KEYS,
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    "dynamic route qualification evidence",
  );
  if (value.tier !== "FIXTURE" && value.tier !== "LIVE") {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "dynamic route qualification tier is invalid",
    );
  }
  if (options.environment !== "TEST" && options.environment !== "PRODUCTION") {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "dynamic route promotion environment is invalid",
    );
  }
  const verifiedAt = canonicalTimestamp(
    value.verified_at,
    "qualification verified_at",
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
  );
  const expiresAt = canonicalTimestamp(
    value.expires_at,
    "qualification expires_at",
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
  );
  const now = canonicalTimestamp(
    options.now,
    "promotion clock",
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
  );
  if (
    expiresAt.epoch_ms <= verifiedAt.epoch_ms ||
    expiresAt.epoch_ms - verifiedAt.epoch_ms >
      DYNAMIC_ROUTE_QUALIFICATION_MAX_AGE_MS ||
    now.epoch_ms < verifiedAt.epoch_ms ||
    now.epoch_ms > expiresAt.epoch_ms
  ) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "dynamic route qualification evidence is stale or has an invalid window",
    );
  }
  if (options.environment === "PRODUCTION" && value.tier !== "LIVE") {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_LIVE_GATE_REQUIRED",
      "production route promotion requires live qualification evidence",
    );
  }
  const deployment = receipt.deployment;
  const qualification: DynamicRouteQualificationEvidence = Object.freeze({
    tier: value.tier,
    gateway_id:
      value.gateway_id === DYNAMIC_ROUTE_GATEWAY_ID
        ? DYNAMIC_ROUTE_GATEWAY_ID
        : dynamicRouteProvisioningFailure(
            "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
            "qualification belongs to another AI Gateway",
          ),
    route_ref: boundedDynamicRouteIdentifier(
      value.route_ref,
      "qualification route_ref",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    route_version: boundedDynamicRouteIdentifier(
      value.route_version,
      "qualification route_version",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    prompt_generation: boundedDynamicRouteIdentifier(
      value.prompt_generation,
      "qualification prompt_generation",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    schema_generation: boundedDynamicRouteIdentifier(
      value.schema_generation,
      "qualification schema_generation",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    parameters_digest: exactDynamicRouteSha256(
      value.parameters_digest,
      "qualification parameters_digest",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    pricing_snapshot_ref: boundedDynamicRouteIdentifier(
      value.pricing_snapshot_ref,
      "qualification pricing_snapshot_ref",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    provider_route_id: boundedDynamicRouteIdentifier(
      value.provider_route_id,
      "qualification provider route ID",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    provider_route_name: providerDynamicRouteName(
      value.provider_route_name,
      "qualification provider route name",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    route_definition_sha256: exactDynamicRouteSha256(
      value.route_definition_sha256,
      "qualification route definition digest",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    provider_snapshot_sha256: exactDynamicRouteSha256(
      value.provider_snapshot_sha256,
      "qualification provider snapshot digest",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    control_plane_readback_ref: boundedDynamicRouteIdentifier(
      value.control_plane_readback_ref,
      "qualification control-plane readback reference",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    execution_probe_ref: boundedDynamicRouteIdentifier(
      value.execution_probe_ref,
      "qualification execution probe reference",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    verified_at: verifiedAt.text,
    expires_at: expiresAt.text,
  });
  if (
    qualification.route_ref !== deployment.route_ref ||
    qualification.route_version !== deployment.route_version ||
    qualification.prompt_generation !== deployment.prompt_generation ||
    qualification.schema_generation !== deployment.schema_generation ||
    qualification.parameters_digest !== deployment.parameters_digest ||
    qualification.pricing_snapshot_ref !== deployment.pricing_snapshot_ref ||
    qualification.provider_route_id !== receipt.provider_route_id ||
    qualification.provider_route_name !== receipt.provider_route_name ||
    qualification.route_definition_sha256 !== receipt.route_definition_sha256 ||
    qualification.provider_snapshot_sha256 !==
      receipt.provider_snapshot_sha256
  ) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "dynamic route qualification is not bound to the provisioned generation",
    );
  }
  return qualification;
}

export function buildDynamicRouteCandidate(
  receipt: DynamicRouteProvisioningReceipt,
  qualification: DynamicRouteQualificationEvidence,
): DynamicRouteCandidate {
  return Object.freeze({
    schema: "eliotr.dynamic-route-candidate.v1",
    deployment: receipt.deployment,
    provider_route_id: receipt.provider_route_id,
    provider_route_name: receipt.provider_route_name,
    route_definition_sha256: receipt.route_definition_sha256,
    provider_snapshot_sha256: receipt.provider_snapshot_sha256,
    control_plane_receipt_ref: receipt.control_plane_receipt_ref,
    qualification_tier: qualification.tier,
    control_plane_readback_ref: qualification.control_plane_readback_ref,
    execution_probe_ref: qualification.execution_probe_ref,
    qualification_expires_at: qualification.expires_at,
  });
}

export function decodeDynamicRouteCandidateWriteReceipt(
  raw: unknown,
  expectedSha256: string,
): DynamicRouteCandidateWriteReceipt {
  const value = exactDynamicRouteObject(
    raw,
    CANDIDATE_WRITE_KEYS,
    "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
    "dynamic route candidate write receipt",
  );
  const receipt = Object.freeze({
    candidate_ref: boundedDynamicRouteIdentifier(
      value.candidate_ref,
      "dynamic route candidate reference",
      "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
    ),
    readback_sha256: exactDynamicRouteSha256(
      value.readback_sha256,
      "dynamic route candidate readback digest",
      "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
    ),
  });
  if (receipt.readback_sha256 !== expectedSha256) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
      "dynamic route candidate readback differs from staged bytes",
      { ambiguous_effect: "REGISTRY_STAGE" },
    );
  }
  return receipt;
}

export function decodeDynamicRouteActive(
  raw: unknown,
): DynamicRouteActiveGeneration | null {
  if (raw === null) return null;
  const value = exactDynamicRouteObject(
    raw,
    ACTIVE_KEYS,
    "DYNAMIC_ROUTE_PROMOTION_FAILED",
    "active dynamic route generation",
  );
  return Object.freeze({
    route_ref: boundedDynamicRouteIdentifier(
      value.route_ref,
      "active route_ref",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
    route_version: boundedDynamicRouteIdentifier(
      value.route_version,
      "active route_version",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
    candidate_ref: boundedDynamicRouteIdentifier(
      value.candidate_ref,
      "active candidate_ref",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
    candidate_sha256: exactDynamicRouteSha256(
      value.candidate_sha256,
      "active candidate digest",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
  });
}

export function decodeDynamicRoutePromotionWriteReceipt(
  raw: unknown,
): DynamicRoutePromotionWriteReceipt {
  const value = exactDynamicRouteObject(
    raw,
    PROMOTION_WRITE_KEYS,
    "DYNAMIC_ROUTE_PROMOTION_FAILED",
    "dynamic route promotion write receipt",
  );
  const active = decodeDynamicRouteActive(value.active);
  if (active === null) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
      "promotion receipt cannot contain a null active generation",
    );
  }
  return Object.freeze({
    promotion_ref: boundedDynamicRouteIdentifier(
      value.promotion_ref,
      "dynamic route promotion reference",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
    active,
  });
}
