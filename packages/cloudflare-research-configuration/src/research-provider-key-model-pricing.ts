import type {
  ResearchModelPricingSnapshot,
  ResearchModelPricingSnapshotIdentity,
  ResearchModelPricingSnapshotDocument,
} from "@eliotr/cloudflare-model-control/research-model-pricing-store.js";
import { createD1ResearchModelPricingSnapshotStore } from "@eliotr/cloudflare-model-control/research-model-pricing-store.js";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import {
  assertVerifiedZeroPriceCatalogBytes,
  readVerifiedZeroPriceCatalog,
  ResearchProviderKeyModelPricingCatalogError,
  RESEARCH_PROVIDER_KEY_MODEL_PRICING_SOURCE_URL,
} from "./research-provider-key-model-pricing-catalog.js";
import type {
  ResearchProviderKeyModelUseRow,
  ResearchProviderKeyModelUseStage,
} from "./research-provider-key-model-use-store.js";
import {
  createResearchProviderKeyModelPriceObservationRef,
  ResearchProviderKeyModelPriceObservationStoreError,
} from "./research-provider-key-model-price-observation-store.js";

const PROVIDER = "openrouter" as const;
const EXACT_MODEL_ID = "stealth/space-bunny-alpha" as const;
const SOURCE_URL = RESEARCH_PROVIDER_KEY_MODEL_PRICING_SOURCE_URL;
const PRICING_PROTOCOL = "eliotr.research-model-pricing.v1" as const;
const PRICING_BASIS = "EXACT_TOKEN_RATES_V1" as const;
const ROUTE_KEYS = new Set(["stage", "route_ref", "route_version", "provider", "exact_model_id"]);
const STAGES = new Set(["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"]);
const CONTEXT_KEYS = new Set(["operation", "route"]);
function exactPropertyNames<T>() {
  return <const Keys extends readonly (keyof T)[]>(
    keys: Keys & (Exclude<keyof T, Keys[number]> extends never ? unknown : never),
  ): Keys => keys;
}
const OPERATION_KEYS = new Set<string>(exactPropertyNames<ResearchProviderKeyModelUseRow>()([
  "owner_id", "project_id", "provider_id", "operation_id", "key_operation_id", "account_id", "gateway_id",
  "alias", "provider_config_id", "configuration_metadata_sha256", "request_sha256", "owner_credential_generation",
  "configuration_basis_json",
  "project_generation", "deployment_generation", "deadline_at", "expected_selection_revision",
  "source_configuration_ref", "source_configuration_sha256", "planned_stage_set_sha256", "plan_sha256",
  "state", "phase", "active_stage", "target_configuration_ref", "target_configuration_sha256",
  "target_configuration_json",
  "selected_configuration_ref", "selection_revision", "failure_code", "created_at", "updated_at",
] as const));
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ResearchProviderKeyModelPricingFailureCode =
  | "FREE_PRICE_NOT_PROVEN"
  | "FREE_PRICE_NOT_ZERO"
  | "SERVER_POLICY_UNAVAILABLE"
  | "AUTHORITY_CHANGED"
  | "STORAGE_UNAVAILABLE";

export class ResearchProviderKeyModelPricingError extends Error {
  public readonly code: ResearchProviderKeyModelPricingFailureCode;
  public readonly retryable: boolean;

  public constructor(
    code: ResearchProviderKeyModelPricingFailureCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyModelPricingError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ResearchProviderKeyModelPricingRouteAuthority {
  readonly stage: ResearchProviderKeyModelUseStage;
  readonly route_ref: string;
  readonly route_version: string;
  readonly provider: typeof PROVIDER;
  readonly exact_model_id: typeof EXACT_MODEL_ID;
}

/**
 * A current, request-bound owner-use read. The composition callback must
 * recheck owner, project, credential and deployment generations on every call.
 */
export interface ResearchProviderKeyModelPricingCurrentAuthority {
  readonly operation: ResearchProviderKeyModelUseRow;
  readonly route: ResearchProviderKeyModelPricingRouteAuthority;
}

export interface ResearchProviderKeyModelPricingObservationIdentity {
  readonly observation_ref: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly stage: ResearchProviderKeyModelUseStage;
  readonly route_ref: string;
  readonly route_version: string;
}

export interface ResearchProviderKeyModelPricingObservationWrite {
  readonly observation_ref: string;
  readonly operation: ResearchProviderKeyModelUseRow;
  readonly stage: ResearchProviderKeyModelUseStage;
  readonly route_ref: string;
  readonly route_version: string;
  readonly provider: typeof PROVIDER;
  readonly exact_model_id: typeof EXACT_MODEL_ID;
  readonly source_url: typeof SOURCE_URL;
  readonly response_bytes: Uint8Array;
  readonly source_response_sha256: string;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly approval_receipt_ref: string;
}

export interface ResearchProviderKeyModelPricingObservationReceipt
  extends ResearchProviderKeyModelPricingObservationIdentity {
  readonly key_operation_id: string;
  readonly account_id: string;
  readonly gateway_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly configuration_metadata_sha256: string;
  readonly request_sha256: string;
  readonly owner_credential_generation: string;
  readonly project_generation: number;
  readonly deployment_generation: string;
  readonly provider: typeof PROVIDER;
  readonly exact_model_id: typeof EXACT_MODEL_ID;
  readonly source_url: typeof SOURCE_URL;
  readonly source_response_sha256: string;
  readonly readback_sha256: string;
  readonly byte_length: number;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly approval_receipt_ref: string;
}

/**
 * Implemented by Core D1 control-plane storage. It stores exact bounded UTF-8
 * response bytes and verifies their SHA/readback; it is not a corpus Evidence
 * object and must not use invented residency domains.
 */
export interface ResearchProviderKeyModelPricingObservationStore {
  read(identity: ResearchProviderKeyModelPricingObservationIdentity): Promise<ResearchProviderKeyModelPricingObservationReceipt | null>;
  readByStage(identity: Omit<ResearchProviderKeyModelPricingObservationIdentity, "observation_ref">): Promise<{
    readonly receipt: ResearchProviderKeyModelPricingObservationReceipt;
    readonly response_bytes: Uint8Array;
  } | null>;
  putImmutable(input: ResearchProviderKeyModelPricingObservationWrite): Promise<ResearchProviderKeyModelPricingObservationReceipt>;
}

export interface ResearchProviderKeyModelPricingReceipt {
  readonly pricing_snapshot_ref: string;
  readonly snapshot_sha256: string;
  readonly route_ref: string;
  readonly route_version: string;
  readonly provider: typeof PROVIDER;
  readonly exact_model_id: typeof EXACT_MODEL_ID;
  readonly effective_at: string;
  readonly expires_at: string;
}

export interface ResearchProviderKeyModelPricingObserverInput {
  readonly database: D1Database;
  readonly observation_store: ResearchProviderKeyModelPricingObservationStore;
  readonly readCurrentOperation: (operation_id: string) => Promise<ResearchProviderKeyModelPricingCurrentAuthority | null>;
}

export interface ObserveResearchProviderKeyModelFreePriceRequest {
  readonly operation_id: string;
  readonly route_ref: string;
  readonly route_version: string;
}

function fail(
  code: ResearchProviderKeyModelPricingFailureCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchProviderKeyModelPricingError(code, message, retryable, cause);
}

function rethrowObservationConflict(cause: unknown): void {
  if (cause instanceof ResearchProviderKeyModelPriceObservationStoreError && cause.code === "IDENTITY_CONFLICT") {
    fail("FREE_PRICE_NOT_PROVEN", "price metadata conflicts with the immutable owner-use stage observation", false, cause);
  }
}

function exactRecord(value: unknown, label: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("FREE_PRICE_NOT_PROVEN", `${label} is not an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("FREE_PRICE_NOT_PROVEN", `${label} is not a plain object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    fail("FREE_PRICE_NOT_PROVEN", `${label} contains unsupported fields`);
  }
  return record;
}

function exactKeys(record: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    fail("FREE_PRICE_NOT_PROVEN", `${label} has an unsupported shape`);
  }
}

function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail("SERVER_POLICY_UNAVAILABLE", `${label} is not a canonical timestamp`);
  }
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertFreshWindow(effectiveAt: string, expiresAt: string, now: string): void {
  const effective = Date.parse(effectiveAt);
  const expiry = Date.parse(expiresAt);
  const current = Date.parse(now);
  if (effective > current || expiry <= effective || expiry <= current) {
    fail("FREE_PRICE_NOT_PROVEN", "pricing observation is stale or outside its trusted validity window");
  }
}

function routeIdentity(value: unknown, request: ObserveResearchProviderKeyModelFreePriceRequest): ResearchProviderKeyModelPricingRouteAuthority {
  const route = exactRecord(value, "current route authority", ROUTE_KEYS);
  exactKeys(route, ROUTE_KEYS, "current route authority");
  if (typeof route.stage !== "string" || !STAGES.has(route.stage) ||
      typeof route.route_ref !== "string" || !IDENTIFIER.test(route.route_ref) ||
      typeof route.route_version !== "string" || !IDENTIFIER.test(route.route_version) ||
      route.route_ref !== request.route_ref || route.route_version !== request.route_version ||
      route.provider !== PROVIDER || route.exact_model_id !== EXACT_MODEL_ID) {
    fail("AUTHORITY_CHANGED", "current selected route does not match the approved pricing request");
  }
  return Object.freeze({
    stage: route.stage as ResearchProviderKeyModelUseStage,
    route_ref: route.route_ref,
    route_version: route.route_version,
    provider: PROVIDER,
    exact_model_id: EXACT_MODEL_ID,
  });
}

function assertOperation(operation: ResearchProviderKeyModelUseRow, request: ObserveResearchProviderKeyModelFreePriceRequest): void {
  if (operation.operation_id !== request.operation_id || operation.provider_id !== PROVIDER ||
      operation.state !== "PREPARING" || operation.phase !== "FREE_PRICE_CHECK" ||
      operation.failure_code !== null || operation.selected_configuration_ref !== null ||
      operation.selection_revision !== null || operation.active_stage === null) {
    fail("AUTHORITY_CHANGED", "owner model-use operation is not current for its free-price check");
  }
  const deadline = canonicalIso(operation.deadline_at, "owner model-use deadline");
  if (Date.parse(deadline) <= Date.now()) fail("AUTHORITY_CHANGED", "owner model-use deadline has elapsed");
}

async function observationIdentity(
  operation: ResearchProviderKeyModelUseRow,
  route: ResearchProviderKeyModelPricingRouteAuthority,
  sourceResponseSha256: string,
): Promise<ResearchProviderKeyModelPricingObservationIdentity> {
  const observationRef = await createResearchProviderKeyModelPriceObservationRef({
    owner_id: operation.owner_id,
    project_id: operation.project_id,
    operation_id: operation.operation_id,
    stage: route.stage,
    route_ref: route.route_ref,
    route_version: route.route_version,
    source_response_sha256: sourceResponseSha256,
  });
  return {
    observation_ref: observationRef,
    owner_id: operation.owner_id,
    project_id: operation.project_id,
    operation_id: operation.operation_id,
    stage: route.stage,
    route_ref: route.route_ref,
    route_version: route.route_version,
  };
}

function sameObservationReceipt(
  receipt: ResearchProviderKeyModelPricingObservationReceipt,
  authority: ResearchProviderKeyModelPricingCurrentAuthority,
  responseBytes: Uint8Array,
  sourceResponseSha256: string,
  observationRef: string,
): boolean {
  const { operation, route } = authority;
  return receipt.observation_ref === observationRef &&
    receipt.owner_id === operation.owner_id && receipt.project_id === operation.project_id &&
    receipt.operation_id === operation.operation_id && receipt.key_operation_id === operation.key_operation_id &&
    receipt.account_id === operation.account_id && receipt.gateway_id === operation.gateway_id &&
    receipt.alias === operation.alias && receipt.provider_config_id === operation.provider_config_id &&
    receipt.configuration_metadata_sha256 === operation.configuration_metadata_sha256 &&
    receipt.request_sha256 === operation.request_sha256 &&
    receipt.owner_credential_generation === operation.owner_credential_generation &&
    receipt.project_generation === operation.project_generation &&
    receipt.deployment_generation === operation.deployment_generation &&
    receipt.stage === route.stage && receipt.route_ref === route.route_ref &&
    receipt.route_version === route.route_version && receipt.provider === PROVIDER &&
    receipt.exact_model_id === EXACT_MODEL_ID && receipt.source_url === SOURCE_URL &&
    receipt.source_response_sha256 === sourceResponseSha256 &&
    receipt.readback_sha256 === sourceResponseSha256 &&
    receipt.byte_length === responseBytes.byteLength &&
    receipt.observed_at === canonicalIso(receipt.observed_at, "stored price observation time") &&
    receipt.expires_at === operation.deadline_at &&
    receipt.approval_receipt_ref === operation.operation_id;
}

function snapshotMatches(
  snapshot: ResearchModelPricingSnapshot,
  identity: ResearchModelPricingSnapshotIdentity,
  document: ResearchModelPricingSnapshotDocument,
  operation: ResearchProviderKeyModelUseRow,
): void {
  if (snapshot.pricing_snapshot_ref !== identity.pricing_snapshot_ref ||
      snapshot.route_ref !== identity.route_ref || snapshot.route_version !== identity.route_version ||
      snapshot.provider !== PROVIDER || snapshot.exact_model_id !== EXACT_MODEL_ID ||
      snapshot.pricing_basis !== PRICING_BASIS || snapshot.input_rate_usd_per_1k_tokens !== "0" ||
      snapshot.output_rate_usd_per_1k_tokens !== "0" || snapshot.provenance_ref !== document.provenance_ref ||
      snapshot.approval_receipt_ref !== document.approval_receipt_ref ||
      snapshot.effective_at !== document.effective_at ||
      snapshot.effective_at !== canonicalIso(snapshot.effective_at, "stored pricing effective_at") ||
      snapshot.expires_at !== canonicalIso(snapshot.expires_at, "stored pricing expires_at") ||
      snapshot.expires_at !== operation.deadline_at || snapshot.expires_at !== document.expires_at ||
      !SHA256.test(snapshot.snapshot_sha256) ||
      snapshot.created_at !== canonicalIso(snapshot.created_at, "stored pricing created_at")) {
    fail("STORAGE_UNAVAILABLE", "pricing snapshot readback is not bound to the current owner-use observation");
  }
  assertFreshWindow(snapshot.effective_at, snapshot.expires_at, nowIso());
}

export function createResearchProviderKeyModelPricingObserver(input: ResearchProviderKeyModelPricingObserverInput) {
  if (typeof input?.database?.prepare !== "function" ||
      typeof input?.observation_store?.read !== "function" ||
      typeof input?.observation_store?.readByStage !== "function" ||
      typeof input?.observation_store?.putImmutable !== "function" ||
      typeof input?.readCurrentOperation !== "function") {
    fail("SERVER_POLICY_UNAVAILABLE", "pricing observation server dependencies are incomplete");
  }
  const snapshots = createD1ResearchModelPricingSnapshotStore(input.database);

  async function currentAuthority(
    request: ObserveResearchProviderKeyModelFreePriceRequest,
  ): Promise<ResearchProviderKeyModelPricingCurrentAuthority> {
    let raw: ResearchProviderKeyModelPricingCurrentAuthority | null;
    try {
      raw = await input.readCurrentOperation(request.operation_id);
    } catch (cause) {
      fail("STORAGE_UNAVAILABLE", "current owner-use authority could not be read", true, cause);
    }
    if (raw === null) fail("AUTHORITY_CHANGED", "owner-use operation is not current for this request");
    const context = exactRecord(raw, "current owner-use authority", CONTEXT_KEYS);
    exactKeys(context, CONTEXT_KEYS, "current owner-use authority");
    const operationRecord = exactRecord(context.operation, "current owner-use operation", OPERATION_KEYS);
    exactKeys(operationRecord, OPERATION_KEYS, "current owner-use operation");
    const operation = operationRecord as unknown as ResearchProviderKeyModelUseRow;
    assertOperation(operation, request);
    const route = routeIdentity(context.route, request);
    if (route.stage !== operation.active_stage) fail("AUTHORITY_CHANGED", "current route stage does not match the owner-use operation");
    return Object.freeze({ operation, route });
  }

  function sameAuthority(
    left: ResearchProviderKeyModelPricingCurrentAuthority,
    right: ResearchProviderKeyModelPricingCurrentAuthority,
  ): boolean {
    return canonicalJson({ operation: left.operation, route: left.route }) ===
      canonicalJson({ operation: right.operation, route: right.route });
  }

  async function readValidatedStageObservation(
    authority: ResearchProviderKeyModelPricingCurrentAuthority,
  ): Promise<{ readonly receipt: ResearchProviderKeyModelPricingObservationReceipt; readonly response_bytes: Uint8Array } | null> {
    const { operation, route } = authority;
    let stored: Awaited<ReturnType<ResearchProviderKeyModelPricingObservationStore["readByStage"]>>;
    try {
      stored = await input.observation_store.readByStage({
        owner_id: operation.owner_id,
        project_id: operation.project_id,
        operation_id: operation.operation_id,
        stage: route.stage,
        route_ref: route.route_ref,
        route_version: route.route_version,
      });
    } catch (cause) {
      rethrowObservationConflict(cause);
      fail("STORAGE_UNAVAILABLE", "pricing stage observation readback is unavailable", true, cause);
    }
    if (stored === null) return null;

    const { receipt, response_bytes: responseBytes } = stored;
    let sourceResponseSha256: string;
    try { sourceResponseSha256 = await modelGatewaySha256(responseBytes); }
    catch (cause) { fail("STORAGE_UNAVAILABLE", "stored pricing observation digest could not be recomputed", true, cause); }
    let observationRef: string;
    try {
      observationRef = await createResearchProviderKeyModelPriceObservationRef({
        owner_id: operation.owner_id,
        project_id: operation.project_id,
        operation_id: operation.operation_id,
        stage: route.stage,
        route_ref: route.route_ref,
        route_version: route.route_version,
        source_response_sha256: sourceResponseSha256,
      });
    } catch (cause) {
      fail("STORAGE_UNAVAILABLE", "stored pricing observation identity could not be verified", true, cause);
    }
    if (!sameObservationReceipt(receipt, authority, responseBytes, sourceResponseSha256, observationRef)) {
      fail("STORAGE_UNAVAILABLE", "stored pricing observation is not bound to the current owner-use authority");
    }
    try { assertVerifiedZeroPriceCatalogBytes(responseBytes); }
    catch (cause) {
      if (cause instanceof ResearchProviderKeyModelPricingCatalogError) {
        fail(cause.code, cause.message, false, cause);
      }
      fail("FREE_PRICE_NOT_PROVEN", "stored pricing response failed exact catalog validation", false, cause);
    }
    assertFreshWindow(receipt.observed_at, receipt.expires_at, nowIso());
    return stored;
  }

  async function observeAndPersistFreePrice(
    rawRequest: ObserveResearchProviderKeyModelFreePriceRequest,
  ): Promise<ResearchProviderKeyModelPricingReceipt> {
    const requestRecord = exactRecord(rawRequest, "free-price request", new Set(["operation_id", "route_ref", "route_version"]));
    exactKeys(requestRecord, new Set(["operation_id", "route_ref", "route_version"]), "free-price request");
    const request = Object.freeze({
      operation_id: requestRecord.operation_id as string,
      route_ref: requestRecord.route_ref as string,
      route_version: requestRecord.route_version as string,
    });
    if (typeof request.operation_id !== "string" || !OPERATION_ID.test(request.operation_id) ||
        typeof request.route_ref !== "string" || !IDENTIFIER.test(request.route_ref) ||
        typeof request.route_version !== "string" || !IDENTIFIER.test(request.route_version)) {
      fail("FREE_PRICE_NOT_PROVEN", "free-price request identity is invalid");
    }
    const before = await currentAuthority(request);
    let stagedObservation = await readValidatedStageObservation(before);
    if (stagedObservation === null) {
      const beforeFetch = await currentAuthority(request);
      if (!sameAuthority(before, beforeFetch)) {
        fail("AUTHORITY_CHANGED", "owner-use authority changed before pricing metadata request", true);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readVerifiedZeroPriceCatalog();
      } catch (cause) {
        if (cause instanceof ResearchProviderKeyModelPricingError) throw cause;
        if (cause instanceof ResearchProviderKeyModelPricingCatalogError) {
          fail(cause.code, cause.message, cause.retryable, cause);
        }
        fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing metadata could not be read", true, cause);
      }
      const sourceResponseSha256 = await modelGatewaySha256(bytes);
      const effectiveAt = nowIso();
      const expiresAt = canonicalIso(beforeFetch.operation.deadline_at, "owner model-use deadline");
      assertFreshWindow(effectiveAt, expiresAt, nowIso());

      const afterFetch = await currentAuthority(request);
      if (!sameAuthority(beforeFetch, afterFetch)) {
        fail("AUTHORITY_CHANGED", "owner-use authority changed during pricing observation", true);
      }
      stagedObservation = await readValidatedStageObservation(afterFetch);
      if (stagedObservation === null) {
        const observationKey = await observationIdentity(afterFetch.operation, afterFetch.route, sourceResponseSha256);
        const write: ResearchProviderKeyModelPricingObservationWrite = Object.freeze({
          observation_ref: observationKey.observation_ref,
          operation: afterFetch.operation,
          stage: afterFetch.route.stage,
          route_ref: afterFetch.route.route_ref,
          route_version: afterFetch.route.route_version,
          provider: PROVIDER,
          exact_model_id: EXACT_MODEL_ID,
          source_url: SOURCE_URL,
          response_bytes: bytes,
          source_response_sha256: sourceResponseSha256,
          observed_at: effectiveAt,
          expires_at: expiresAt,
          approval_receipt_ref: afterFetch.operation.operation_id,
        });
        let writeError: unknown;
        try { await input.observation_store.putImmutable(write); }
        catch (cause) { writeError = cause; }
        stagedObservation = await readValidatedStageObservation(afterFetch);
        if (stagedObservation === null) {
          if (writeError !== undefined) rethrowObservationConflict(writeError);
          fail("STORAGE_UNAVAILABLE", "pricing observation persistence is uncertain", true, writeError);
        }
      }
    }

    const observationReceipt = stagedObservation.receipt;
    const afterObservation = await currentAuthority(request);
    if (!sameAuthority(before, afterObservation)) fail("AUTHORITY_CHANGED", "owner-use authority changed during observation persistence", true);

    const pricingSnapshotRef = `pricing-${await modelGatewaySha256(canonicalJson({
      protocol: PRICING_PROTOCOL,
      observation_ref: observationReceipt.observation_ref,
      route_ref: before.route.route_ref,
      route_version: before.route.route_version,
      provider: PROVIDER,
      exact_model_id: EXACT_MODEL_ID,
    }))}`;
    const identity: ResearchModelPricingSnapshotIdentity = Object.freeze({
      pricing_snapshot_ref: pricingSnapshotRef,
      route_ref: before.route.route_ref,
      route_version: before.route.route_version,
      provider: PROVIDER,
      exact_model_id: EXACT_MODEL_ID,
    });
    const document: ResearchModelPricingSnapshotDocument = Object.freeze({
      protocol: PRICING_PROTOCOL,
      ...identity,
      pricing_basis: PRICING_BASIS,
      input_rate_usd_per_1k_tokens: "0",
      output_rate_usd_per_1k_tokens: "0",
      effective_at: observationReceipt.observed_at,
      expires_at: observationReceipt.expires_at,
      provenance_ref: observationReceipt.observation_ref,
      approval_receipt_ref: before.operation.operation_id,
    });

    let snapshot: ResearchModelPricingSnapshot | null;
    try {
      snapshot = await snapshots.read(identity);
    } catch (cause) {
      fail("STORAGE_UNAVAILABLE", "pricing snapshot readback is unavailable", true, cause);
    }
    if (snapshot === null) {
      try {
        snapshot = await snapshots.putImmutable({ identity, snapshot: document });
      } catch (cause) {
        let recovered: ResearchModelPricingSnapshot | null = null;
        try { recovered = await snapshots.read(identity); } catch { /* Preserve write uncertainty. */ }
        if (recovered === null) fail("STORAGE_UNAVAILABLE", "pricing snapshot persistence is uncertain", true, cause);
        snapshot = recovered;
      }
    }
    snapshotMatches(snapshot, identity, document, before.operation);
    const readback = await snapshots.read(identity);
    if (readback === null || readback.snapshot_sha256 !== snapshot.snapshot_sha256) {
      fail("STORAGE_UNAVAILABLE", "pricing snapshot canonical SHA readback is missing or changed", true);
    }
    snapshotMatches(readback, identity, document, before.operation);

    const afterSnapshot = await currentAuthority(request);
    if (!sameAuthority(before, afterSnapshot)) fail("AUTHORITY_CHANGED", "owner-use authority changed during snapshot persistence", true);
    return Object.freeze({
      pricing_snapshot_ref: readback.pricing_snapshot_ref,
      snapshot_sha256: readback.snapshot_sha256,
      route_ref: readback.route_ref,
      route_version: readback.route_version,
      provider: PROVIDER,
      exact_model_id: EXACT_MODEL_ID,
      effective_at: readback.effective_at,
      expires_at: readback.expires_at,
    });
  }

  return Object.freeze({ observeAndPersistFreePrice });
}
