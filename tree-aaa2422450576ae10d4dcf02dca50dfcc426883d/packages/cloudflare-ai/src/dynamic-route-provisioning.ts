import {
  DYNAMIC_ROUTE_GATEWAY_ID,
  DynamicRouteProvisioningError,
  dynamicRouteProvisioningFailure,
  type DynamicRouteAmbiguousEffect,
  type DynamicRouteCompiledDesired,
  type DynamicRouteControlPlanePort,
  type DynamicRoutePromotionOptions,
  type DynamicRoutePromotionReceipt,
  type DynamicRouteProvisioner,
  type DynamicRouteProvisioningDisposition,
  type DynamicRouteProvisioningInput,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
  type DynamicRouteRegistryPort,
  type VerifiedDynamicRouteProviderSnapshot,
} from "./dynamic-route-provisioning-contract.js";
import {
  boundedDynamicRouteIdentifier,
  compileDynamicRouteDesired,
  decodeAndVerifyDynamicRouteSnapshot,
  decodeDynamicRouteCreateHandle,
  decodeDynamicRouteList,
  dynamicRouteJsonArtifact,
} from "./dynamic-route-provisioning-codec.js";
import {
  buildDynamicRouteCandidate,
  decodeDynamicRouteActive,
  decodeDynamicRouteCandidateWriteReceipt,
  decodeDynamicRoutePromotionWriteReceipt,
  decodeDynamicRouteProvisioningReceipt,
  validateDynamicRouteQualification,
} from "./dynamic-route-promotion-codec.js";

async function listControlPlaneRoutes(
  controlPlane: DynamicRouteControlPlanePort,
  ambiguousEffect: DynamicRouteAmbiguousEffect = "NONE",
) {
  let raw: unknown;
  try {
    raw = await controlPlane.list(DYNAMIC_ROUTE_GATEWAY_ID);
  } catch (cause) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_CONTROL_PLANE_FAILED",
      "dynamic route control-plane list failed",
      {
        retryable: true,
        ambiguous_effect: ambiguousEffect,
        cause,
      },
    );
  }
  return decodeDynamicRouteList(raw);
}

async function readVerifiedSnapshot(
  controlPlane: DynamicRouteControlPlanePort,
  desired: DynamicRouteCompiledDesired,
  providerRouteId: string,
  mismatchCode:
    | "DYNAMIC_ROUTE_PROVIDER_NAME_COLLISION"
    | "DYNAMIC_ROUTE_READBACK_MISMATCH",
  ambiguousEffect: DynamicRouteAmbiguousEffect,
): Promise<VerifiedDynamicRouteProviderSnapshot> {
  let raw: unknown;
  try {
    raw = await controlPlane.get(DYNAMIC_ROUTE_GATEWAY_ID, providerRouteId);
  } catch (cause) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_CONTROL_PLANE_FAILED",
      "dynamic route control-plane readback failed",
      {
        retryable: true,
        ambiguous_effect: ambiguousEffect,
        cause,
      },
    );
  }
  const verified = await decodeAndVerifyDynamicRouteSnapshot(
    raw,
    desired,
    mismatchCode,
  );
  if (verified.snapshot.provider_route_id !== providerRouteId) {
    dynamicRouteProvisioningFailure(
      mismatchCode,
      "dynamic route readback returned a different provider identity",
      { ambiguous_effect: ambiguousEffect },
    );
  }
  return verified;
}

async function buildProvisioningReceipt(
  desired: DynamicRouteCompiledDesired,
  verified: VerifiedDynamicRouteProviderSnapshot,
  disposition: DynamicRouteProvisioningDisposition,
): Promise<DynamicRouteProvisioningReceipt> {
  const identity = await dynamicRouteJsonArtifact({
    disposition,
    deployment: desired.deployment,
    provider_route_id: verified.snapshot.provider_route_id,
    provider_route_name: desired.provider_route_name,
    route_definition_sha256: desired.route_definition_sha256,
    provider_snapshot_sha256: verified.snapshot_sha256,
  });
  return Object.freeze({
    disposition,
    deployment: desired.deployment,
    provider_route_id: verified.snapshot.provider_route_id,
    provider_route_name: desired.provider_route_name,
    route_definition_sha256: desired.route_definition_sha256,
    provider_snapshot_sha256: verified.snapshot_sha256,
    control_plane_receipt_ref: `dynamic-route-provision-${identity.sha256.slice(0, 48)}`,
  });
}

async function reconcileUncertainCreate(
  controlPlane: DynamicRouteControlPlanePort,
  desired: DynamicRouteCompiledDesired,
  originalCause: unknown,
): Promise<DynamicRouteProvisioningReceipt> {
  let routes;
  try {
    routes = await listControlPlaneRoutes(controlPlane, "PROVIDER_CREATE");
  } catch (cause) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_CREATE_UNCERTAIN",
      "dynamic route create outcome could not be reconciled by list readback",
      {
        retryable: false,
        ambiguous_effect: "PROVIDER_CREATE",
        cause: new AggregateError([originalCause, cause]),
      },
    );
  }
  const existing = routes.find(
    (route) => route.name === desired.provider_route_name,
  );
  if (existing === undefined) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_CREATE_UNCERTAIN",
      "dynamic route create outcome remains unknown after exact list readback",
      {
        retryable: false,
        ambiguous_effect: "PROVIDER_CREATE",
        cause: originalCause,
      },
    );
  }
  let verified: VerifiedDynamicRouteProviderSnapshot;
  try {
    verified = await readVerifiedSnapshot(
      controlPlane,
      desired,
      existing.provider_route_id,
      "DYNAMIC_ROUTE_PROVIDER_NAME_COLLISION",
      "PROVIDER_CREATE",
    );
  } catch (cause) {
    if (
      cause instanceof DynamicRouteProvisioningError &&
      cause.code === "DYNAMIC_ROUTE_PROVIDER_NAME_COLLISION"
    ) {
      dynamicRouteProvisioningFailure(
        "DYNAMIC_ROUTE_PROVIDER_NAME_COLLISION",
        "provider route name exists but is not the requested immutable generation",
        {
          ambiguous_effect: "PROVIDER_CREATE",
          cause,
        },
      );
    }
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_CREATE_UNCERTAIN",
      "dynamic route create readback could not be qualified",
      {
        retryable: false,
        ambiguous_effect: "PROVIDER_CREATE",
        cause: new AggregateError([originalCause, cause]),
      },
    );
  }
  return buildProvisioningReceipt(desired, verified, "CREATE_RECONCILED");
}

export async function provisionDynamicRouteGeneration(
  controlPlane: DynamicRouteControlPlanePort,
  input: DynamicRouteProvisioningInput,
): Promise<DynamicRouteProvisioningReceipt> {
  const desired = await compileDynamicRouteDesired(input);
  const routes = await listControlPlaneRoutes(controlPlane);
  const existing = routes.find(
    (route) => route.name === desired.provider_route_name,
  );
  if (existing !== undefined) {
    const verified = await readVerifiedSnapshot(
      controlPlane,
      desired,
      existing.provider_route_id,
      "DYNAMIC_ROUTE_PROVIDER_NAME_COLLISION",
      "NONE",
    );
    return buildProvisioningReceipt(desired, verified, "EXISTING_MATCH");
  }

  let providerRouteId: string;
  try {
    const rawHandle = await controlPlane.create(desired.create_request);
    providerRouteId = decodeDynamicRouteCreateHandle(rawHandle);
  } catch (cause) {
    return reconcileUncertainCreate(controlPlane, desired, cause);
  }
  const verified = await readVerifiedSnapshot(
    controlPlane,
    desired,
    providerRouteId,
    "DYNAMIC_ROUTE_READBACK_MISMATCH",
    "PROVIDER_CREATE",
  );
  return buildProvisioningReceipt(desired, verified, "CREATED");
}

function expectedActiveRouteVersion(options: DynamicRoutePromotionOptions) {
  if (options.expected_active_route_version === null) return null;
  return boundedDynamicRouteIdentifier(
    options.expected_active_route_version,
    "expected active route version",
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
  );
}

export async function promoteDynamicRouteGeneration(
  registry: DynamicRouteRegistryPort,
  rawReceipt: DynamicRouteProvisioningReceipt,
  rawQualification: DynamicRouteQualificationEvidence,
  options: DynamicRoutePromotionOptions,
): Promise<DynamicRoutePromotionReceipt> {
  const receipt = decodeDynamicRouteProvisioningReceipt(rawReceipt);
  const qualification = validateDynamicRouteQualification(
    rawQualification,
    receipt,
    options,
  );
  const expectedActive = expectedActiveRouteVersion(options);
  const candidate = buildDynamicRouteCandidate(receipt, qualification);
  const candidateArtifact = await dynamicRouteJsonArtifact(candidate);

  let rawCandidateWrite: unknown;
  try {
    rawCandidateWrite = await registry.stageCandidate(
      candidate,
      candidateArtifact.sha256,
    );
  } catch (cause) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
      "dynamic route candidate staging failed",
      {
        retryable: true,
        ambiguous_effect: "REGISTRY_STAGE",
        cause,
      },
    );
  }
  const candidateWrite = decodeDynamicRouteCandidateWriteReceipt(
    rawCandidateWrite,
    candidateArtifact.sha256,
  );

  let rawActive: unknown | null;
  try {
    rawActive = await registry.getActive(receipt.deployment.route_ref);
  } catch (cause) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
      "active dynamic route generation could not be read",
      {
        retryable: true,
        ambiguous_effect: "REGISTRY_STAGE",
        cause,
      },
    );
  }
  const active = decodeDynamicRouteActive(rawActive);
  if (active !== null && active.route_ref !== receipt.deployment.route_ref) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
      "active route registry returned a foreign route",
      { ambiguous_effect: "REGISTRY_STAGE" },
    );
  }
  const actualActiveVersion = active?.route_version ?? null;
  if (actualActiveVersion !== expectedActive) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_PROMOTION_CONFLICT",
      "active dynamic route generation changed before promotion",
      { ambiguous_effect: "REGISTRY_STAGE" },
    );
  }

  const command = Object.freeze({
    route_ref: receipt.deployment.route_ref,
    expected_active_route_version: expectedActive,
    target_route_version: receipt.deployment.route_version,
    candidate_ref: candidateWrite.candidate_ref,
    candidate_sha256: candidateArtifact.sha256,
  });
  let rawPromotion: unknown;
  try {
    rawPromotion = await registry.promote(command);
  } catch (cause) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
      "dynamic route registry promotion failed",
      {
        retryable: false,
        ambiguous_effect: "REGISTRY_PROMOTION",
        cause,
      },
    );
  }
  const promotion = decodeDynamicRoutePromotionWriteReceipt(rawPromotion);
  if (
    promotion.active.route_ref !== command.route_ref ||
    promotion.active.route_version !== command.target_route_version ||
    promotion.active.candidate_ref !== command.candidate_ref ||
    promotion.active.candidate_sha256 !== command.candidate_sha256
  ) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
      "dynamic route promotion readback differs from the requested candidate",
      { ambiguous_effect: "REGISTRY_PROMOTION" },
    );
  }
  const identity = await dynamicRouteJsonArtifact({
    promotion_ref: promotion.promotion_ref,
    route_ref: command.route_ref,
    previous_route_version: actualActiveVersion,
    active_route_version: command.target_route_version,
    candidate_ref: command.candidate_ref,
    candidate_sha256: command.candidate_sha256,
    qualification_tier: qualification.tier,
  });
  return Object.freeze({
    promotion_ref: promotion.promotion_ref,
    route_ref: command.route_ref,
    previous_route_version: actualActiveVersion,
    active_route_version: command.target_route_version,
    candidate_ref: command.candidate_ref,
    candidate_sha256: command.candidate_sha256,
    qualification_tier: qualification.tier,
    receipt_ref: `dynamic-route-promotion-${identity.sha256.slice(0, 48)}`,
  });
}

export function createDynamicRouteProvisioner(
  controlPlane: DynamicRouteControlPlanePort,
  registry: DynamicRouteRegistryPort,
): DynamicRouteProvisioner {
  return Object.freeze({
    provision(input: DynamicRouteProvisioningInput) {
      return provisionDynamicRouteGeneration(controlPlane, input);
    },
    promote(
      receipt: DynamicRouteProvisioningReceipt,
      qualification: DynamicRouteQualificationEvidence,
      options: DynamicRoutePromotionOptions,
    ) {
      return promoteDynamicRouteGeneration(
        registry,
        receipt,
        qualification,
        options,
      );
    },
  });
}
