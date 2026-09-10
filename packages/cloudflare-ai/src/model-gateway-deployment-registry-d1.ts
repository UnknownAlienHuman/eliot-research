import type { ModelGatewayDeploymentRegistryPort } from "./model-gateway-execution-contract.js";
import {
  decodeDynamicRouteDeploymentForProvisioning,
  dynamicRouteJsonArtifact,
  providerDynamicRouteName,
} from "./dynamic-route-provisioning-codec.js";
import {
  dynamicRouteProvisioningFailure,
  type DynamicRouteActiveGeneration,
  type DynamicRouteCandidate,
  type DynamicRouteCandidateWriteReceipt,
  type DynamicRoutePromotionCommand,
  type DynamicRoutePromotionWriteReceipt,
  type DynamicRouteProvisioningErrorCode,
  type DynamicRouteRegistryPort,
} from "./dynamic-route-provisioning-contract.js";
import { modelGatewaySha256 } from "./model-gateway-request.js";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CANDIDATE_KEYS = new Set([
  "control_plane_receipt_ref",
  "control_plane_readback_ref",
  "execution_probe_ref",
  "provider_route_id",
  "provider_route_name",
  "provider_snapshot_sha256",
  "qualification_expires_at",
  "qualification_tier",
  "route_definition_sha256",
  "schema",
  "deployment",
]);
const CANDIDATE_ROW_KEYS = new Set([
  "candidate_json",
  "candidate_ref",
  "candidate_sha256",
  "route_ref",
  "route_version",
  "staged_at",
]);
const ACTIVE_ROW_KEYS = new Set([
  "candidate_ref",
  "candidate_sha256",
  "promotion_ref",
  "promoted_at",
  "route_ref",
  "route_version",
]);

interface CandidateRow {
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly candidate_json: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly staged_at: unknown;
}

interface ActiveRow {
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly promotion_ref: unknown;
  readonly promoted_at: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
}

function failure(
  code: DynamicRouteProvisioningErrorCode,
  message: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): never {
  dynamicRouteProvisioningFailure(code, message, options);
}

function plainObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failure("DYNAMIC_ROUTE_PROMOTION_FAILED", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failure("DYNAMIC_ROUTE_PROMOTION_FAILED", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) {
      failure("DYNAMIC_ROUTE_PROMOTION_FAILED", `${label} contains unsupported field ${key}`);
    }
  }
  return record;
}

function inputObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failure("DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failure("DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) {
      failure("DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED", `${label} contains unsupported field ${key}`);
    }
  }
  return record;
}

function identifier(value: unknown, label: string, code: DynamicRouteProvisioningErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    failure(code, `${label} is not a bounded identifier`);
  }
  return value;
}

function digest(value: unknown, label: string, code: DynamicRouteProvisioningErrorCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    failure(code, `${label} is not a canonical SHA-256`);
  }
  return value;
}

function timestamp(value: unknown, label: string, code: DynamicRouteProvisioningErrorCode): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    failure(code, `${label} is not canonical UTC time`);
  }
  return value;
}

function candidateFromJson(raw: unknown, code: DynamicRouteProvisioningErrorCode): DynamicRouteCandidate {
  const value = plainObject(raw, CANDIDATE_KEYS, "dynamic route candidate");
  if (value.schema !== "eliotr.dynamic-route-candidate.v1") {
    failure(code, "dynamic route candidate schema is unsupported");
  }
  const deployment = decodeDynamicRouteDeploymentForProvisioning(value.deployment, code);
  const qualificationTier = value.qualification_tier;
  if (qualificationTier !== "FIXTURE" && qualificationTier !== "LIVE") {
    failure(code, "dynamic route candidate qualification tier is invalid");
  }
  return Object.freeze({
    schema: "eliotr.dynamic-route-candidate.v1",
    deployment,
    provider_route_id: identifier(value.provider_route_id, "candidate provider route ID", code),
    provider_route_name: providerDynamicRouteName(value.provider_route_name, "candidate provider route name", code),
    route_definition_sha256: digest(value.route_definition_sha256, "candidate route definition digest", code),
    provider_snapshot_sha256: digest(value.provider_snapshot_sha256, "candidate provider snapshot digest", code),
    control_plane_receipt_ref: identifier(value.control_plane_receipt_ref, "candidate control-plane receipt", code),
    qualification_tier: qualificationTier,
    control_plane_readback_ref: identifier(value.control_plane_readback_ref, "candidate control-plane readback", code),
    execution_probe_ref: identifier(value.execution_probe_ref, "candidate execution probe", code),
    qualification_expires_at: timestamp(value.qualification_expires_at, "candidate qualification expiry", code),
  });
}

async function candidateArtifact(candidate: DynamicRouteCandidate): Promise<Readonly<{ json: string; sha256: string }>> {
  const artifact = await dynamicRouteJsonArtifact(candidate);
  return Object.freeze({ json: artifact.json, sha256: artifact.sha256 });
}

async function decodeCandidateRow(raw: unknown, label: string): Promise<{
  readonly row: CandidateRow;
  readonly candidate: DynamicRouteCandidate;
  readonly json: string;
  readonly sha256: string;
}> {
  const value = plainObject(raw, CANDIDATE_ROW_KEYS, label);
  const candidateRef = identifier(value.candidate_ref, `${label}.candidate_ref`, "DYNAMIC_ROUTE_PROMOTION_FAILED");
  const rowSha = digest(value.candidate_sha256, `${label}.candidate_sha256`, "DYNAMIC_ROUTE_PROMOTION_FAILED");
  const routeRef = identifier(value.route_ref, `${label}.route_ref`, "DYNAMIC_ROUTE_PROMOTION_FAILED");
  const routeVersion = identifier(value.route_version, `${label}.route_version`, "DYNAMIC_ROUTE_PROMOTION_FAILED");
  const stagedAt = timestamp(value.staged_at, `${label}.staged_at`, "DYNAMIC_ROUTE_PROMOTION_FAILED");
  if (typeof value.candidate_json !== "string") {
    failure("DYNAMIC_ROUTE_PROMOTION_FAILED", `${label}.candidate_json must be a string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.candidate_json) as unknown;
  } catch (cause) {
    failure("DYNAMIC_ROUTE_PROMOTION_FAILED", `${label}.candidate_json is invalid JSON`, { cause });
  }
  const candidate = candidateFromJson(parsed, "DYNAMIC_ROUTE_PROMOTION_FAILED");
  const artifact = await candidateArtifact(candidate);
  if (artifact.json !== value.candidate_json || artifact.sha256 !== rowSha) {
    failure("DYNAMIC_ROUTE_PROMOTION_FAILED", `${label} bytes do not match its stored digest`);
  }
  if (candidate.deployment.route_ref !== routeRef || candidate.deployment.route_version !== routeVersion) {
    failure("DYNAMIC_ROUTE_PROMOTION_FAILED", `${label} route identity differs from candidate bytes`);
  }
  return Object.freeze({
    row: Object.freeze({
      candidate_ref: candidateRef,
      candidate_sha256: rowSha,
      candidate_json: value.candidate_json,
      route_ref: routeRef,
      route_version: routeVersion,
      staged_at: stagedAt,
    }),
    candidate,
    json: artifact.json,
    sha256: artifact.sha256,
  });
}

function decodeActiveRow(raw: unknown, label: string): ActiveRow {
  const value = plainObject(raw, ACTIVE_ROW_KEYS, label);
  return Object.freeze({
    candidate_ref: identifier(value.candidate_ref, `${label}.candidate_ref`, "DYNAMIC_ROUTE_PROMOTION_FAILED"),
    candidate_sha256: digest(value.candidate_sha256, `${label}.candidate_sha256`, "DYNAMIC_ROUTE_PROMOTION_FAILED"),
    promotion_ref: identifier(value.promotion_ref, `${label}.promotion_ref`, "DYNAMIC_ROUTE_PROMOTION_FAILED"),
    promoted_at: timestamp(value.promoted_at, `${label}.promoted_at`, "DYNAMIC_ROUTE_PROMOTION_FAILED"),
    route_ref: identifier(value.route_ref, `${label}.route_ref`, "DYNAMIC_ROUTE_PROMOTION_FAILED"),
    route_version: identifier(value.route_version, `${label}.route_version`, "DYNAMIC_ROUTE_PROMOTION_FAILED"),
  });
}

const candidateSelect = "candidate_ref, candidate_sha256, candidate_json, route_ref, route_version, staged_at";
const activeSelect = "candidate_ref, candidate_sha256, promotion_ref, promoted_at, route_ref, route_version";

async function readCandidate(database: D1Database, candidateRef: string) {
  const row = await database.prepare(`SELECT ${candidateSelect} FROM dynamic_route_candidate WHERE candidate_ref = ?1 LIMIT 1`).bind(candidateRef).first<CandidateRow>();
  return row === null ? null : decodeCandidateRow(row, "stored dynamic route candidate");
}

async function readActive(database: D1Database, routeRef: string): Promise<{
  readonly row: ActiveRow;
  readonly candidate: Awaited<ReturnType<typeof readCandidate>>;
} | null> {
  const raw = await database.prepare(`SELECT ${activeSelect} FROM dynamic_route_active_generation WHERE route_ref = ?1 LIMIT 1`).bind(routeRef).first<ActiveRow>();
  if (raw === null) return null;
  const row = decodeActiveRow(raw, "stored active dynamic route");
  if (row.route_ref !== routeRef) failure("DYNAMIC_ROUTE_PROMOTION_FAILED", "active dynamic route belongs to another route");
  const candidate = await readCandidate(database, String(row.candidate_ref));
  if (candidate === null) failure("DYNAMIC_ROUTE_PROMOTION_FAILED", "active dynamic route references a missing candidate");
  if (candidate.sha256 !== row.candidate_sha256 || candidate.row.route_ref !== row.route_ref || candidate.row.route_version !== row.route_version) {
    failure("DYNAMIC_ROUTE_PROMOTION_FAILED", "active dynamic route digest or identity differs from its candidate");
  }
  return Object.freeze({ row, candidate });
}

function candidateRefForSha(sha256: string): string {
  return `dynamic-route-candidate-${sha256}`;
}

function activeValue(active: ActiveRow): DynamicRouteActiveGeneration {
  return Object.freeze({
    route_ref: String(active.route_ref),
    route_version: String(active.route_version),
    candidate_ref: String(active.candidate_ref),
    candidate_sha256: String(active.candidate_sha256),
  });
}

function stageFailure(message: string, cause?: unknown): never {
  return failure("DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED", message, cause === undefined ? {} : { cause });
}

function promotionFailure(message: string, cause?: unknown): never {
  return failure("DYNAMIC_ROUTE_PROMOTION_FAILED", message, cause === undefined ? {} : { cause });
}

const COMMAND_KEYS = new Set([
  "candidate_ref",
  "candidate_sha256",
  "expected_active_route_version",
  "route_ref",
  "target_route_version",
]);

function decodePromotionCommand(raw: DynamicRoutePromotionCommand): DynamicRoutePromotionCommand {
  const value = inputObject(raw, COMMAND_KEYS, "dynamic route promotion command");
  const expected = value.expected_active_route_version;
  if (expected !== null && (typeof expected !== "string" || !IDENTIFIER.test(expected))) {
    promotionFailure("expected active route version is invalid");
  }
  return Object.freeze({
    route_ref: identifier(value.route_ref, "promotion route_ref", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    expected_active_route_version: expected as string | null,
    target_route_version: identifier(value.target_route_version, "promotion target route_version", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    candidate_ref: identifier(value.candidate_ref, "promotion candidate_ref", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    candidate_sha256: digest(value.candidate_sha256, "promotion candidate_sha256", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
  });
}

export interface D1DynamicRouteRegistryOptions {
  readonly now?: () => string;
}

export function createD1DynamicRouteRegistry(
  database: D1Database,
  options: D1DynamicRouteRegistryOptions = {},
): DynamicRouteRegistryPort {
  if (typeof database !== "object" || database === null || typeof database.prepare !== "function") {
    stageFailure("dynamic route registry database binding is invalid");
  }
  const now = options.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async stageCandidate(rawCandidate: DynamicRouteCandidate, expectedSha256: string): Promise<DynamicRouteCandidateWriteReceipt> {
      const candidate = candidateFromJson(rawCandidate, "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED");
      const artifact = await candidateArtifact(candidate);
      const expected = digest(expectedSha256, "expected candidate digest", "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED");
      if (artifact.sha256 !== expected) stageFailure("candidate bytes differ from expected digest");
      const candidateRef = candidateRefForSha(artifact.sha256);
      const existing = await readCandidate(database, candidateRef);
      if (existing !== null) {
        if (existing.sha256 !== artifact.sha256 || existing.json !== artifact.json) stageFailure("candidate reference is bound to different bytes");
        return Object.freeze({ candidate_ref: candidateRef, readback_sha256: existing.sha256 });
      }
      const sameVersion = await database.prepare(`SELECT ${candidateSelect} FROM dynamic_route_candidate WHERE route_ref = ?1 AND route_version = ?2 LIMIT 1`).bind(candidate.deployment.route_ref, candidate.deployment.route_version).first<CandidateRow>();
      if (sameVersion !== null) {
        const decoded = await decodeCandidateRow(sameVersion, "existing dynamic route version");
        if (decoded.sha256 !== artifact.sha256) stageFailure("route version is already bound to different candidate bytes");
      }
      let inserted: CandidateRow | null;
      try {
        inserted = await database.prepare("INSERT INTO dynamic_route_candidate(candidate_ref, route_ref, route_version, candidate_sha256, candidate_json, staged_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(candidate_ref) DO NOTHING RETURNING " + candidateSelect).bind(candidateRef, candidate.deployment.route_ref, candidate.deployment.route_version, artifact.sha256, artifact.json, timestamp(now(), "candidate staged_at", "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED")).first<CandidateRow>();
      } catch (cause) {
        stageFailure("dynamic route candidate staging failed", cause);
      }
      if (inserted === null) {
        const reconciled = await readCandidate(database, candidateRef);
        if (reconciled === null || reconciled.sha256 !== artifact.sha256 || reconciled.json !== artifact.json) stageFailure("candidate staging write is uncertain");
        return Object.freeze({ candidate_ref: candidateRef, readback_sha256: reconciled.sha256 });
      }
      const readback = await decodeCandidateRow(inserted, "staged dynamic route candidate");
      if (readback.sha256 !== artifact.sha256 || readback.row.candidate_ref !== candidateRef) stageFailure("candidate staging readback differs from requested bytes");
      return Object.freeze({ candidate_ref: candidateRef, readback_sha256: readback.sha256 });
    },

    async getActive(routeRef: string): Promise<DynamicRouteActiveGeneration | null> {
      const bounded = identifier(routeRef, "active route_ref", "DYNAMIC_ROUTE_PROMOTION_FAILED");
      const active = await readActive(database, bounded);
      return active === null ? null : activeValue(active.row);
    },

    async promote(rawCommand: DynamicRoutePromotionCommand): Promise<DynamicRoutePromotionWriteReceipt> {
      const command = decodePromotionCommand(rawCommand);
      const candidate = await readCandidate(database, command.candidate_ref);
      if (candidate === null) promotionFailure("promotion references a missing candidate");
      if (candidate.sha256 !== command.candidate_sha256 || candidate.row.route_ref !== command.route_ref || candidate.row.route_version !== command.target_route_version) promotionFailure("promotion candidate does not match the requested route identity");
      const current = await readActive(database, command.route_ref);
      const targetActive = current === null ? null : current.row;
      if (targetActive !== null && targetActive.route_version === command.target_route_version && targetActive.candidate_ref === command.candidate_ref && targetActive.candidate_sha256 === command.candidate_sha256) {
        return Object.freeze({ promotion_ref: String(targetActive.promotion_ref), active: activeValue(targetActive) });
      }
      if ((targetActive?.route_version ?? null) !== command.expected_active_route_version) promotionFailure("active route changed before promotion");
      const promotionIdentity = await modelGatewaySha256(JSON.stringify(command));
      const promotionRef = `dynamic-route-promotion-${promotionIdentity}`;
      const promotedAt = timestamp(now(), "promotion promoted_at", "DYNAMIC_ROUTE_PROMOTION_FAILED");
      let applied: ActiveRow | null;
      try {
        if (command.expected_active_route_version === null) {
          applied = await database.prepare("INSERT INTO dynamic_route_active_generation(route_ref, route_version, candidate_ref, candidate_sha256, promotion_ref, promoted_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(route_ref) DO NOTHING RETURNING " + activeSelect).bind(command.route_ref, command.target_route_version, command.candidate_ref, command.candidate_sha256, promotionRef, promotedAt).first<ActiveRow>();
        } else {
          applied = await database.prepare("UPDATE dynamic_route_active_generation SET route_version = ?2, candidate_ref = ?3, candidate_sha256 = ?4, promotion_ref = ?5, promoted_at = ?6 WHERE route_ref = ?1 AND route_version = ?7 RETURNING " + activeSelect).bind(command.route_ref, command.target_route_version, command.candidate_ref, command.candidate_sha256, promotionRef, promotedAt, command.expected_active_route_version).first<ActiveRow>();
        }
      } catch (cause) {
        promotionFailure("dynamic route promotion failed", cause);
      }
      if (applied === null) {
        const observed = await readActive(database, command.route_ref);
        if (observed !== null && observed.row.route_version === command.target_route_version && observed.row.candidate_ref === command.candidate_ref && observed.row.candidate_sha256 === command.candidate_sha256) {
          return Object.freeze({ promotion_ref: String(observed.row.promotion_ref), active: activeValue(observed.row) });
        }
        promotionFailure("dynamic route promotion write did not reach the requested active state");
      }
      const readback = decodeActiveRow(applied, "promoted dynamic route");
      if (readback.route_ref !== command.route_ref || readback.route_version !== command.target_route_version || readback.candidate_ref !== command.candidate_ref || readback.candidate_sha256 !== command.candidate_sha256 || readback.promotion_ref !== promotionRef) {
        promotionFailure("dynamic route promotion readback differs from requested active state");
      }
      return Object.freeze({ promotion_ref: readback.promotion_ref, active: activeValue(readback) });
    },
  });
}

export function createD1ModelGatewayDeploymentRegistry(
  database: D1Database,
): ModelGatewayDeploymentRegistryPort {
  if (typeof database !== "object" || database === null || typeof database.prepare !== "function") {
    failure("DYNAMIC_ROUTE_PROMOTION_FAILED", "model gateway deployment registry database binding is invalid");
  }
  return Object.freeze({
    async resolve(routeRef: string): Promise<unknown | null> {
      const bounded = identifier(routeRef, "deployment route_ref", "DYNAMIC_ROUTE_PROMOTION_FAILED");
      const active = await readActive(database, bounded);
      if (active === null) return null;
      if (active.candidate === null) failure("DYNAMIC_ROUTE_PROMOTION_FAILED", "active route candidate is missing");
      return Object.freeze(active.candidate.candidate.deployment);
    },
  });
}
