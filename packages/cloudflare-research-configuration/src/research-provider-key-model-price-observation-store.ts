import { canonicalJson, decodeCanonicalBase64Bytes, encodeCanonicalBase64Bytes } from "@eliotr/platform-cloudflare";
import type { ResearchProviderKeyModelUseStage, ResearchProviderKeyModelUseRow } from "./research-provider-key-model-use-store.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROUTE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_RESPONSE_BYTES = 32_768;
const MODEL_ID = "stealth/space-bunny-alpha" as const;
const SOURCE_URL = "https://openrouter.ai/api/v1/models/stealth/space-bunny-alpha/endpoints" as const;

export interface ResearchProviderKeyModelPriceObservationIdentity {
  readonly observation_ref: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly stage: ResearchProviderKeyModelUseStage;
  readonly route_ref: string;
  readonly route_version: string;
}

export interface ResearchProviderKeyModelPriceObservationReceipt extends ResearchProviderKeyModelPriceObservationIdentity {
  readonly key_operation_id: string;
  readonly request_sha256: string;
  readonly owner_credential_generation: string;
  readonly project_generation: number;
  readonly deployment_generation: string;
  readonly account_id: string;
  readonly gateway_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly configuration_metadata_sha256: string;
  readonly provider: "openrouter";
  readonly exact_model_id: typeof MODEL_ID;
  readonly source_url: typeof SOURCE_URL;
  readonly source_response_sha256: string;
  readonly readback_sha256: string;
  readonly byte_length: number;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly approval_receipt_ref: string;
}

export interface ResearchProviderKeyModelPriceObservationWrite {
  readonly observation_ref: string;
  readonly operation: ResearchProviderKeyModelUseRow;
  readonly stage: ResearchProviderKeyModelUseStage;
  readonly route_ref: string;
  readonly route_version: string;
  readonly provider: "openrouter";
  readonly exact_model_id: typeof MODEL_ID;
  readonly source_url: typeof SOURCE_URL;
  readonly response_bytes: Uint8Array;
  readonly source_response_sha256: string;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly approval_receipt_ref: string;
}

export interface ResearchProviderKeyModelPricingObservationStore {
  read(identity: ResearchProviderKeyModelPriceObservationIdentity): Promise<ResearchProviderKeyModelPriceObservationReceipt | null>;
  readByStage(input: {
    readonly owner_id: string;
    readonly project_id: string;
    readonly operation_id: string;
    readonly stage: ResearchProviderKeyModelUseStage;
    readonly route_ref: string;
    readonly route_version: string;
  }): Promise<{ readonly receipt: ResearchProviderKeyModelPriceObservationReceipt; readonly response_bytes: Uint8Array } | null>;
  putImmutable(input: ResearchProviderKeyModelPriceObservationWrite): Promise<ResearchProviderKeyModelPriceObservationReceipt>;
}

export class ResearchProviderKeyModelPriceObservationStoreError extends Error {
  public constructor(public readonly code: "INPUT_INVALID" | "READBACK_CORRUPT" | "IDENTITY_CONFLICT" | "STORAGE_UNAVAILABLE",
    message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyModelPriceObservationStoreError";
  }
}

function fail(code: ResearchProviderKeyModelPriceObservationStoreError["code"], message: string, cause?: unknown): never {
  throw new ResearchProviderKeyModelPriceObservationStoreError(code, message, cause);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail("INPUT_INVALID", `${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function bytes(value: unknown, code: ResearchProviderKeyModelPriceObservationStoreError["code"]): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return fail(code, "stored price response bytes are invalid");
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function identifier(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) fail("INPUT_INVALID", `${label} is invalid`);
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

const COLUMNS = [
  "owner_id", "project_id", "operation_id", "stage", "key_operation_id", "account_id", "gateway_id", "alias",
  "provider_config_id", "configuration_metadata_sha256", "request_sha256", "owner_credential_generation",
  "project_generation", "deployment_generation", "route_ref", "route_version", "provider_id", "exact_model_id",
  "source_url", "observation_ref", "source_response_sha256", "response_base64", "byte_length", "readback_sha256",
  "observed_at", "expires_at", "approval_receipt_ref", "created_at",
].join(",");

interface ObservationRow {
  readonly owner_id: unknown;
  readonly project_id: unknown;
  readonly operation_id: unknown;
  readonly stage: unknown;
  readonly key_operation_id: unknown;
  readonly account_id: unknown;
  readonly gateway_id: unknown;
  readonly alias: unknown;
  readonly provider_config_id: unknown;
  readonly configuration_metadata_sha256: unknown;
  readonly request_sha256: unknown;
  readonly owner_credential_generation: unknown;
  readonly project_generation: unknown;
  readonly deployment_generation: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly provider_id: unknown;
  readonly exact_model_id: unknown;
  readonly source_url: unknown;
  readonly observation_ref: unknown;
  readonly source_response_sha256: unknown;
  readonly response_base64: unknown;
  readonly byte_length: unknown;
  readonly readback_sha256: unknown;
  readonly observed_at: unknown;
  readonly expires_at: unknown;
  readonly approval_receipt_ref: unknown;
  readonly created_at: unknown;
}

function byteCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_RESPONSE_BYTES) {
    fail("READBACK_CORRUPT", `${label} is invalid`);
  }
  return value;
}

export function createResearchProviderKeyModelPriceObservationRef(input: {
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly stage: ResearchProviderKeyModelUseStage;
  readonly route_ref: string;
  readonly route_version: string;
  readonly source_response_sha256: string;
}): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalJson([
    "eliotr.research.provider-key-model-price-observation.v1", input.owner_id, input.project_id,
    input.operation_id, input.stage, input.route_ref, input.route_version, input.source_response_sha256,
  ]))).then((digest) => `rkpo-${digest}`);
}

export function createD1ResearchProviderKeyModelPriceObservationStore(database: D1Database): ResearchProviderKeyModelPricingObservationStore {
  if (typeof database?.prepare !== "function") fail("STORAGE_UNAVAILABLE", "Core D1 binding is unavailable");

  async function readRaw(ref: string): Promise<ObservationRow | null> {
    try {
      return await database.prepare(
        `SELECT ${COLUMNS} FROM research_provider_key_model_price_observation WHERE observation_ref=?1 LIMIT 1`,
      ).bind(ref).first<ObservationRow>();
    } catch (cause) {
      fail("STORAGE_UNAVAILABLE", "price observation readback is unavailable", cause);
    }
  }

  async function readStageRaw(input: Pick<ResearchProviderKeyModelPriceObservationIdentity,
    "owner_id" | "project_id" | "operation_id" | "stage">): Promise<ObservationRow | null> {
    try {
      return await database.prepare(
        `SELECT ${COLUMNS} FROM research_provider_key_model_price_observation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 AND stage=?4 LIMIT 1`,
      ).bind(input.owner_id, input.project_id, input.operation_id, input.stage).first<ObservationRow>();
    } catch (cause) {
      fail("STORAGE_UNAVAILABLE", "price observation stage readback is unavailable", cause);
    }
  }

  async function readObservation(identity: ResearchProviderKeyModelPriceObservationIdentity): Promise<ResearchProviderKeyModelPriceObservationReceipt | null> {
    const row = await readRaw(identifier(identity.observation_ref, "observation_ref", /^rkpo-[0-9a-f]{64}$/u));
    if (row === null) return null;
    const receipt = (await decode(row)).receipt;
    if (receipt.owner_id !== identity.owner_id || receipt.project_id !== identity.project_id ||
        receipt.operation_id !== identity.operation_id || receipt.stage !== identity.stage ||
        receipt.route_ref !== identity.route_ref || receipt.route_version !== identity.route_version ||
        receipt.observation_ref !== identity.observation_ref) {
      fail("IDENTITY_CONFLICT", "price observation reference is bound to another owner operation or route");
    }
    return receipt;
  }

  async function decode(row: ObservationRow): Promise<{ receipt: ResearchProviderKeyModelPriceObservationReceipt; response_bytes: Uint8Array }> {
    const ownerId = identifier(row.owner_id, "owner_id", /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
    const projectId = identifier(row.project_id, "project_id", /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
    const operationId = identifier(row.operation_id, "operation_id", OPERATION_ID);
    const stage = identifier(row.stage, "stage", /^(ANALYZE_BRANCHES|COUNTER_SEARCH|SYNTHESIZE|AUDIT_CLAIMS)$/u) as ResearchProviderKeyModelUseStage;
    const routeRef = identifier(row.route_ref, "route_ref", /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
    const routeVersion = identifier(row.route_version, "route_version", ROUTE_VERSION);
    let responseBytes: Uint8Array;
    try {
      responseBytes = decodeCanonicalBase64Bytes(row.response_base64 as string, {
        max_bytes: MAX_RESPONSE_BYTES,
        expected_bytes: byteCount(row.byte_length, "byte_length"),
      });
    } catch (cause) {
      fail("READBACK_CORRUPT", "stored price observation response bytes are invalid", cause);
    }
    const byteLength = byteCount(row.byte_length, "byte_length");
    const sourceSha = identifier(row.source_response_sha256, "source_response_sha256", SHA256);
    const readbackSha = identifier(row.readback_sha256, "readback_sha256", SHA256);
    const projectGeneration = row.project_generation;
    if (responseBytes.byteLength !== byteLength || await sha256(responseBytes) !== readbackSha || sourceSha !== readbackSha ||
        typeof projectGeneration !== "number" || !Number.isSafeInteger(projectGeneration) || projectGeneration < 1 ||
        row.provider_id !== "openrouter" || row.exact_model_id !== MODEL_ID ||
        typeof row.observation_ref !== "string" || !/^rkpo-[0-9a-f]{64}$/u.test(row.observation_ref)) {
      fail("READBACK_CORRUPT", "stored price observation bytes or fixed provider identity are corrupt");
    }
    const sourceUrl = identifier(row.source_url, "source_url", /^https:\/\/openrouter\.ai\//u);
    if (sourceUrl !== SOURCE_URL) fail("READBACK_CORRUPT", "price observation source URL is not the fixed endpoint");
    const receipt: ResearchProviderKeyModelPriceObservationReceipt = Object.freeze({
      observation_ref: row.observation_ref,
      owner_id: ownerId,
      project_id: projectId,
      operation_id: operationId,
      stage,
      route_ref: routeRef,
      route_version: routeVersion,
      key_operation_id: identifier(row.key_operation_id, "key_operation_id", OPERATION_ID),
      request_sha256: identifier(row.request_sha256, "request_sha256", SHA256),
      owner_credential_generation: identifier(row.owner_credential_generation, "owner_credential_generation", /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u),
      project_generation: projectGeneration,
      deployment_generation: identifier(row.deployment_generation, "deployment_generation", /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u),
      account_id: identifier(row.account_id, "account_id", /^[A-Fa-f0-9]{32}$/u),
      gateway_id: identifier(row.gateway_id, "gateway_id", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
      alias: identifier(row.alias, "alias", /^eliotr-[0-9a-f]{48}$/u),
      provider_config_id: identifier(row.provider_config_id, "provider_config_id", /^[A-Za-z0-9._:-]{1,128}$/u),
      configuration_metadata_sha256: identifier(row.configuration_metadata_sha256, "configuration_metadata_sha256", SHA256),
      provider: "openrouter",
      exact_model_id: MODEL_ID,
      source_url: SOURCE_URL,
      source_response_sha256: sourceSha,
      readback_sha256: readbackSha,
      byte_length: byteLength,
      observed_at: canonicalTimestamp(row.observed_at, "observed_at"),
      expires_at: canonicalTimestamp(row.expires_at, "expires_at"),
      approval_receipt_ref: identifier(row.approval_receipt_ref, "approval_receipt_ref", OPERATION_ID),
    });
    if (receipt.approval_receipt_ref !== operationId || receipt.source_url !== SOURCE_URL ||
        Date.parse(receipt.expires_at) <= Date.parse(receipt.observed_at)) {
      fail("READBACK_CORRUPT", "price observation authority or validity is corrupt");
    }
    return { receipt, response_bytes: responseBytes };
  }

  return Object.freeze({
    read: readObservation,
    async readByStage(input: {
      readonly owner_id: string;
      readonly project_id: string;
      readonly operation_id: string;
      readonly stage: ResearchProviderKeyModelUseStage;
      readonly route_ref: string;
      readonly route_version: string;
    }) {
      const row = await readStageRaw(input);
      if (row === null) return null;
      const decoded = await decode(row);
      const receipt = decoded.receipt;
      if (receipt.owner_id !== input.owner_id || receipt.project_id !== input.project_id ||
          receipt.operation_id !== input.operation_id || receipt.stage !== input.stage ||
          receipt.route_ref !== input.route_ref || receipt.route_version !== input.route_version) {
        fail("IDENTITY_CONFLICT", "price observation stage is bound to another owner operation or route");
      }
      return Object.freeze({ receipt, response_bytes: new Uint8Array(decoded.response_bytes) });
    },
    async putImmutable(input: ResearchProviderKeyModelPriceObservationWrite) {
      const operation = input.operation;
      const responseBytes = bytes(input.response_bytes, "INPUT_INVALID");
      if (responseBytes.byteLength < 1 || responseBytes.byteLength > MAX_RESPONSE_BYTES) {
        fail("INPUT_INVALID", "official price response exceeds its byte bound");
      }
      const sourceSha = identifier(input.source_response_sha256, "source_response_sha256", SHA256);
      if (await sha256(responseBytes) !== sourceSha || input.provider !== "openrouter" || input.exact_model_id !== MODEL_ID ||
          input.approval_receipt_ref !== operation.operation_id ||
          input.expires_at !== operation.deadline_at ||
          operation.state !== "PREPARING" || operation.phase !== "FREE_PRICE_CHECK" || operation.active_stage !== input.stage) {
        fail("INPUT_INVALID", "price observation does not match the authorized current owner check/use operation");
      }
      const stageRow = await database.prepare(
        "SELECT stage,route_ref,route_version FROM research_provider_key_model_use_stage_operation " +
        "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 AND stage=?4 LIMIT 1",
      ).bind(operation.owner_id, operation.project_id, operation.operation_id, input.stage)
        .first<{ stage: unknown; route_ref: unknown; route_version: unknown }>();
      if (stageRow === null || stageRow.stage !== input.stage || stageRow.route_ref !== input.route_ref || stageRow.route_version !== input.route_version) {
        fail("IDENTITY_CONFLICT", "price observation route does not match its durable stage plan");
      }
      const observedAt = canonicalTimestamp(input.observed_at, "observed_at");
      const expiresAt = canonicalTimestamp(input.expires_at, "expires_at");
      const deadlineAt = canonicalTimestamp(operation.deadline_at, "operation deadline");
      if (expiresAt !== deadlineAt || Date.parse(expiresAt) <= Date.parse(observedAt)) {
        fail("INPUT_INVALID", "price observation must use the finite operation deadline as its expiry");
      }
      const sourceUrl = identifier(input.source_url, "source_url", /^https:\/\/openrouter\.ai\//u);
      if (sourceUrl !== SOURCE_URL) fail("INPUT_INVALID", "official price source URL is not the fixed endpoint");
      const computedObservationRef = await createResearchProviderKeyModelPriceObservationRef({
        owner_id: operation.owner_id, project_id: operation.project_id, operation_id: operation.operation_id,
        stage: input.stage, route_ref: input.route_ref, route_version: input.route_version,
        source_response_sha256: sourceSha,
      });
      const observationRef = identifier(input.observation_ref, "observation_ref", /^rkpo-[0-9a-f]{64}$/u);
      if (observationRef !== computedObservationRef) fail("IDENTITY_CONFLICT", "price observation reference does not match exact operation and raw bytes");
      const identity = { observation_ref: observationRef, owner_id: operation.owner_id,
        project_id: operation.project_id, operation_id: operation.operation_id,
        stage: input.stage, route_ref: input.route_ref, route_version: input.route_version };
      const existing = await readObservation(identity);
      if (existing !== null) {
        if (existing.source_response_sha256 !== sourceSha || existing.byte_length !== responseBytes.byteLength ||
            existing.key_operation_id !== operation.key_operation_id || existing.account_id !== operation.account_id ||
            existing.gateway_id !== operation.gateway_id || existing.alias !== operation.alias ||
            existing.provider_config_id !== operation.provider_config_id ||
            existing.configuration_metadata_sha256 !== operation.configuration_metadata_sha256 ||
            existing.request_sha256 !== operation.request_sha256 ||
            existing.owner_credential_generation !== operation.owner_credential_generation ||
            existing.project_generation !== operation.project_generation ||
            existing.deployment_generation !== operation.deployment_generation ||
            existing.source_url !== sourceUrl || existing.stage !== input.stage) {
          fail("IDENTITY_CONFLICT", "existing price observation differs from exact operation metadata");
        }
        const existingRow = await readRaw(observationRef);
        let existingBytes: Uint8Array | undefined;
        try {
          if (existingRow !== null) existingBytes = decodeCanonicalBase64Bytes(existingRow.response_base64 as string, {
            max_bytes: MAX_RESPONSE_BYTES, expected_bytes: byteCount(existingRow.byte_length, "byte_length"),
          });
        } catch (cause) { fail("READBACK_CORRUPT", "stored price observation response bytes are invalid", cause); }
        if (existingBytes === undefined || !sameBytes(existingBytes, responseBytes)) {
          fail("IDENTITY_CONFLICT", "existing price observation response bytes differ");
        }
        return existing;
      }
      const bindValues = [operation.owner_id, operation.project_id, operation.operation_id, input.stage,
        operation.key_operation_id, operation.account_id, operation.gateway_id, operation.alias,
        operation.provider_config_id, operation.configuration_metadata_sha256, operation.request_sha256,
        operation.owner_credential_generation, operation.project_generation, operation.deployment_generation,
        input.route_ref, input.route_version, input.provider, input.exact_model_id, sourceUrl,
        observationRef, sourceSha, encodeCanonicalBase64Bytes(responseBytes, MAX_RESPONSE_BYTES), responseBytes.byteLength, sourceSha,
        observedAt, expiresAt, input.approval_receipt_ref, operation.created_at];
      try {
        await database.prepare(
          "INSERT INTO research_provider_key_model_price_observation (" + COLUMNS + ") " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28) " +
          "ON CONFLICT(owner_id,project_id,operation_id,stage) DO NOTHING",
        ).bind(...bindValues).run();
      } catch (cause) {
        const stageExisting = await readStageRaw(identity).catch(() => null);
        if (stageExisting !== null) fail("IDENTITY_CONFLICT", "a different immutable price observation already exists for this operation stage", cause);
        fail("STORAGE_UNAVAILABLE", "immutable price observation could not be recorded", cause);
      }
      const written = await readRaw(observationRef);
      if (written === null) {
        const stageExisting = await readStageRaw(identity);
        if (stageExisting !== null) {
          const existingDecoded = await decode(stageExisting);
          if (existingDecoded.receipt.observation_ref !== observationRef ||
              !sameBytes(existingDecoded.response_bytes, responseBytes)) {
            fail("IDENTITY_CONFLICT", "a different immutable price observation already exists for this operation stage");
          }
          return existingDecoded.receipt;
        }
        fail("STORAGE_UNAVAILABLE", "immutable price observation readback is missing");
      }
      const readback = await decode(written);
      if (readback.receipt.observation_ref !== observationRef || readback.receipt.source_response_sha256 !== sourceSha ||
          !sameBytes(readback.response_bytes, responseBytes) || readback.receipt.byte_length !== responseBytes.byteLength ||
          readback.receipt.owner_id !== operation.owner_id || readback.receipt.project_id !== operation.project_id ||
          readback.receipt.operation_id !== operation.operation_id || readback.receipt.stage !== input.stage ||
          readback.receipt.key_operation_id !== operation.key_operation_id || readback.receipt.account_id !== operation.account_id ||
          readback.receipt.gateway_id !== operation.gateway_id || readback.receipt.alias !== operation.alias ||
          readback.receipt.provider_config_id !== operation.provider_config_id ||
          readback.receipt.configuration_metadata_sha256 !== operation.configuration_metadata_sha256 ||
          readback.receipt.request_sha256 !== operation.request_sha256 ||
          readback.receipt.owner_credential_generation !== operation.owner_credential_generation ||
          readback.receipt.project_generation !== operation.project_generation ||
          readback.receipt.deployment_generation !== operation.deployment_generation ||
          readback.receipt.route_ref !== input.route_ref ||
          readback.receipt.route_version !== input.route_version || readback.receipt.key_operation_id !== operation.key_operation_id ||
          readback.receipt.provider !== input.provider || readback.receipt.exact_model_id !== input.exact_model_id ||
          readback.receipt.source_url !== sourceUrl || readback.receipt.approval_receipt_ref !== input.approval_receipt_ref ||
          readback.receipt.observed_at !== observedAt || readback.receipt.expires_at !== expiresAt) {
        fail("IDENTITY_CONFLICT", "immutable price observation readback differs from its exact request");
      }
      return readback.receipt;
    },
  });
}
