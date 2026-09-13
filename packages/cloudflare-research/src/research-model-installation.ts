import {
  compileDynamicRouteDesired,
  promoteDynamicRouteGeneration,
  provisionDynamicRouteGeneration,
  type DynamicRouteControlPlanePort,
  type DynamicRoutePromotionOptions,
  type DynamicRoutePromotionReceipt,
  type DynamicRouteProvisioningInput,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
} from "@eliotr/cloudflare-ai";
import {
  canonicalJson,
  decodeModelRouteDeployment,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import {
  createD1DynamicRouteRegistry,
  createD1ModelGatewayDeploymentRegistry,
} from "./model-gateway-deployment-registry-d1.js";
import {
  createD1ResearchModelPricingSnapshotStore,
  type PutResearchModelPricingSnapshotInput,
  type ResearchModelPricingSnapshot,
} from "./research-model-pricing-store.js";

const PREPARATION_PROTOCOL = "eliotr.research-model-preparation.v1" as const;
const INSTALLATION_PROTOCOL = "eliotr.research-model-installation.v1" as const;

export type ResearchModelInstallationErrorCode =
  | "MODEL_INSTALLATION_INPUT_INVALID"
  | "MODEL_INSTALLATION_PRICING_MISSING"
  | "MODEL_INSTALLATION_READBACK_FAILED";

export class ResearchModelInstallationError extends Error {
  public readonly code: ResearchModelInstallationErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: ResearchModelInstallationErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchModelInstallationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ResearchModelInstallationServiceDependencies {
  readonly database: D1Database;
  /** A real Cloudflare AI Gateway control-plane adapter; no test fallback. */
  readonly control_plane: DynamicRouteControlPlanePort;
  readonly now?: () => string;
}

export interface ResearchModelInstallationRequest {
  readonly provisioning: DynamicRouteProvisioningInput;
  readonly pricing_snapshot: PutResearchModelPricingSnapshotInput;
  readonly qualification: DynamicRouteQualificationEvidence;
  readonly promotion: DynamicRoutePromotionOptions;
}

export interface ResearchModelPreparationRequest {
  readonly provisioning: DynamicRouteProvisioningInput;
  readonly pricing_snapshot: PutResearchModelPricingSnapshotInput;
}

export interface ResearchModelPreparationReceipt {
  readonly protocol: typeof PREPARATION_PROTOCOL;
  readonly deployment: ModelRouteDeployment;
  readonly pricing_snapshot: ResearchModelPricingSnapshot;
  readonly provisioning: DynamicRouteProvisioningReceipt;
}

export interface ResearchModelInstallationReceipt {
  readonly protocol: typeof INSTALLATION_PROTOCOL;
  readonly deployment: ModelRouteDeployment;
  readonly pricing_snapshot: ResearchModelPricingSnapshot;
  readonly provisioning: DynamicRouteProvisioningReceipt;
  readonly promotion: DynamicRoutePromotionReceipt;
  readonly active_deployment: ModelRouteDeployment;
}

export interface ResearchModelInstallationService {
  prepare(input: ResearchModelPreparationRequest): Promise<ResearchModelPreparationReceipt>;
  install(input: ResearchModelInstallationRequest): Promise<ResearchModelInstallationReceipt>;
}

function fail(
  code: ResearchModelInstallationErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchModelInstallationError(code, message, retryable, cause);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MODEL_INSTALLATION_INPUT_INVALID", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("MODEL_INSTALLATION_INPUT_INVALID", `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function installationRequest(value: unknown): ResearchModelInstallationRequest {
  const request = object(value, "model installation request");
  const keys = new Set(["provisioning", "pricing_snapshot", "qualification", "promotion"]);
  for (const key of Object.keys(request)) {
    if (!keys.has(key)) fail("MODEL_INSTALLATION_INPUT_INVALID", "model installation request contains unsupported fields");
  }
  if (!("provisioning" in request) || !("pricing_snapshot" in request) ||
      !("qualification" in request) || !("promotion" in request)) {
    fail("MODEL_INSTALLATION_INPUT_INVALID", "model installation request is incomplete");
  }
  const qualification = object(request.qualification, "model route qualification");
  const promotion = object(request.promotion, "model route promotion");
  if (qualification.tier !== "LIVE") {
    fail("MODEL_INSTALLATION_INPUT_INVALID", "production model installation requires LIVE qualification evidence");
  }
  if (promotion.environment !== "PRODUCTION") {
    fail("MODEL_INSTALLATION_INPUT_INVALID", "model installation requires PRODUCTION promotion options");
  }
  if (!Object.hasOwn(promotion, "expected_active_route_version") ||
      (promotion.expected_active_route_version !== null &&
       typeof promotion.expected_active_route_version !== "string")) {
    fail("MODEL_INSTALLATION_INPUT_INVALID", "model installation promotion version is invalid");
  }
  return value as ResearchModelInstallationRequest;
}

function preparationRequest(value: unknown): ResearchModelPreparationRequest {
  const request = object(value, "model preparation request");
  const keys = new Set(["provisioning", "pricing_snapshot"]);
  for (const key of Object.keys(request)) {
    if (!keys.has(key)) fail("MODEL_INSTALLATION_INPUT_INVALID", "model preparation request contains unsupported fields");
  }
  if (!("provisioning" in request) || !("pricing_snapshot" in request)) {
    fail("MODEL_INSTALLATION_INPUT_INVALID", "model preparation request is incomplete");
  }
  return value as ResearchModelPreparationRequest;
}

function canonicalClock(source: () => string): () => string {
  return () => {
    let value: string;
    try {
      value = source();
    } catch (cause) {
      fail("MODEL_INSTALLATION_INPUT_INVALID", "model installation clock is unavailable", false, cause);
    }
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
        new Date(Date.parse(value)).toISOString() !== value) {
      fail("MODEL_INSTALLATION_INPUT_INVALID", "model installation clock must return canonical UTC time");
    }
    return value;
  };
}

function assertPricingMatchesDeployment(
  pricing: PutResearchModelPricingSnapshotInput,
  deployment: ModelRouteDeployment,
): void {
  const identity = object(pricing.identity, "pricing snapshot identity");
  const snapshot = object(pricing.snapshot, "pricing snapshot");
  if (identity.pricing_snapshot_ref !== deployment.pricing_snapshot_ref ||
      identity.route_ref !== deployment.route_ref ||
      identity.route_version !== deployment.route_version ||
      snapshot.pricing_snapshot_ref !== deployment.pricing_snapshot_ref ||
      snapshot.route_ref !== deployment.route_ref ||
      snapshot.route_version !== deployment.route_version) {
    fail("MODEL_INSTALLATION_PRICING_MISSING", "explicit pricing snapshot does not bind the requested deployment");
  }
}

function assertPricingWindow(
  pricing: PutResearchModelPricingSnapshotInput,
  current: string,
): void {
  const snapshot = object(pricing.snapshot, "pricing snapshot");
  const effectiveAt = snapshot.effective_at;
  const expiresAt = snapshot.expires_at;
  if (typeof effectiveAt !== "string" || typeof expiresAt !== "string") {
    fail("MODEL_INSTALLATION_PRICING_MISSING", "pricing snapshot window is incomplete");
  }
  const nowMs = Date.parse(current);
  const effectiveMs = Date.parse(effectiveAt);
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(effectiveMs) || !Number.isFinite(expiresMs) ||
      effectiveMs > nowMs || expiresMs <= nowMs) {
    fail("MODEL_INSTALLATION_PRICING_MISSING", "pricing snapshot is not effective for the current installation");
  }
}

function assertQualificationWindow(
  qualification: DynamicRouteQualificationEvidence,
  pricing: ResearchModelPricingSnapshot,
  current: string,
): void {
  const value = object(qualification, "model route qualification");
  if (typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at)) ||
      Date.parse(value.expires_at) <= Date.parse(current) ||
      Date.parse(value.expires_at) > Date.parse(pricing.expires_at)) {
    fail("MODEL_INSTALLATION_PRICING_MISSING", "pricing snapshot does not cover the qualification window");
  }
}

function assertActiveDeployment(
  rawActual: unknown,
  expected: ModelRouteDeployment,
): ModelRouteDeployment {
  let actual: ModelRouteDeployment | null;
  try {
    actual = rawActual === null ? null : decodeModelRouteDeployment(rawActual);
  } catch (cause) {
    fail("MODEL_INSTALLATION_READBACK_FAILED", "active model route readback is malformed", false, cause);
  }
  if (actual === null || canonicalJson(actual) !== canonicalJson(expected)) {
    fail("MODEL_INSTALLATION_READBACK_FAILED", "active model route readback differs from the installed deployment");
  }
  return Object.freeze({ ...actual });
}

export function createResearchModelInstallationService(
  dependencies: ResearchModelInstallationServiceDependencies,
): ResearchModelInstallationService {
  object(dependencies, "model installation dependencies");
  if (typeof dependencies.database?.prepare !== "function" ||
      typeof dependencies.control_plane?.list !== "function" ||
      typeof dependencies.control_plane?.get !== "function" ||
      typeof dependencies.control_plane?.create !== "function") {
    fail("MODEL_INSTALLATION_INPUT_INVALID", "model installation dependencies are invalid");
  }
  if (dependencies.now !== undefined && typeof dependencies.now !== "function") {
    fail("MODEL_INSTALLATION_INPUT_INVALID", "model installation clock is invalid");
  }
  const now = canonicalClock(dependencies.now ?? (() => new Date().toISOString()));
  const pricingStore = createD1ResearchModelPricingSnapshotStore(dependencies.database, { now });
  const registry = createD1DynamicRouteRegistry(dependencies.database, {
    environment: "PRODUCTION",
    now,
  });
  const deploymentRegistry = createD1ModelGatewayDeploymentRegistry(dependencies.database, {
    environment: "PRODUCTION",
    now,
  });

  async function prepareRoute(rawInput: ResearchModelPreparationRequest): Promise<ResearchModelPreparationReceipt> {
    const input = preparationRequest(rawInput);
    // Compile only validates/canonicalizes the explicit route input. It has
    // no provider or D1 effect and lets pricing be checked before creation.
    const desired = await compileDynamicRouteDesired(input.provisioning);
    const provisioningInput: DynamicRouteProvisioningInput = Object.freeze({
      deployment: desired.deployment,
      route_definition: desired.route_definition,
      route_definition_sha256: desired.route_definition_sha256,
    });
    assertPricingMatchesDeployment(input.pricing_snapshot, desired.deployment);
    assertPricingWindow(input.pricing_snapshot, now());
    const pricingSnapshot = await pricingStore.putImmutable(input.pricing_snapshot);
    const provisioning = await provisionDynamicRouteGeneration(
      dependencies.control_plane,
      provisioningInput,
    );
    if (canonicalJson(provisioning.deployment) !== canonicalJson(desired.deployment)) {
      fail("MODEL_INSTALLATION_READBACK_FAILED", "provider provisioning deployment differs from the requested deployment");
    }
    return Object.freeze({
      protocol: PREPARATION_PROTOCOL,
      deployment: desired.deployment,
      pricing_snapshot: pricingSnapshot,
      provisioning,
    });
  }

  return Object.freeze({
    prepare(rawInput: ResearchModelPreparationRequest): Promise<ResearchModelPreparationReceipt> {
      return prepareRoute(rawInput);
    },
    async install(rawInput: ResearchModelInstallationRequest): Promise<ResearchModelInstallationReceipt> {
      const input = installationRequest(rawInput);
      const prepared = await prepareRoute({
        provisioning: input.provisioning,
        pricing_snapshot: input.pricing_snapshot,
      });
      const desired = prepared.deployment;
      const qualification = Object.freeze({ ...input.qualification });
      assertQualificationWindow(qualification, prepared.pricing_snapshot, now());
      const promotion = await promoteDynamicRouteGeneration(
        registry,
        prepared.provisioning,
        qualification,
        { ...input.promotion, environment: "PRODUCTION", now: now() },
      );
      const active = assertActiveDeployment(
        await deploymentRegistry.resolve(desired.route_ref),
        desired,
      );
      return Object.freeze({
        protocol: INSTALLATION_PROTOCOL,
        deployment: desired,
        pricing_snapshot: prepared.pricing_snapshot,
        provisioning: prepared.provisioning,
        promotion,
        active_deployment: active,
      });
    },
  });
}
