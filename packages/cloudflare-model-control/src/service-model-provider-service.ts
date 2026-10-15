import {
  SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
  ServiceModelProviderConnectionSchema,
  ServiceModelProviderCreateRequestSchema,
  ServiceModelProviderFailureCodeSchema,
  type ServiceModelProviderConnection,
  type ServiceModelProviderCreateReceipt,
  type ServiceModelProviderCreateRequest,
  type ServiceModelProviderFailureCode,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const KNOWN_NATIVE_PROVIDER_IDS = new Set(["openrouter", "openai", "anthropic"]);
const MAX_HISTORY = 50;
const MANAGEMENT_DEADLINE_MS = 30_000;

export type ServiceModelProviderOperationEffect = "NONE" | "UNKNOWN" | "CREATED";

export const SERVICE_MODEL_PROVIDER_MANAGEMENT_UNAVAILABLE =
  "SERVICE_MODEL_PROVIDER_MANAGEMENT_UNAVAILABLE" as const;

export type ServiceModelProviderOperationErrorCode =
  | "SERVICE_MODEL_PROVIDER_OWNER_REQUIRED"
  | "SERVICE_MODEL_PROVIDER_INPUT_INVALID"
  | "SERVICE_MODEL_PROVIDER_MANAGEMENT_UNAVAILABLE"
  | "SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE"
  | "SERVICE_MODEL_PROVIDER_OPERATION_NOT_FOUND"
  | "SERVICE_MODEL_PROVIDER_OPERATION_CONFLICT"
  | "SERVICE_MODEL_PROVIDER_OPERATION_IN_PROGRESS"
  | "SERVICE_MODEL_PROVIDER_OUTCOME_UNKNOWN"
  | "SERVICE_MODEL_PROVIDER_PROVIDER_REJECTED"
  | "SERVICE_MODEL_PROVIDER_CLOCK_INVALID";

export class ServiceModelProviderOperationError extends Error {
  public constructor(
    public readonly code: ServiceModelProviderOperationErrorCode,
    public readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    message: string,
    public readonly retryable: boolean,
    public readonly effect: ServiceModelProviderOperationEffect = "NONE",
    public readonly failure_code?: ServiceModelProviderFailureCode,
    public readonly provider_http_status?: number,
  ) {
    super(message);
    this.name = "ServiceModelProviderOperationError";
  }
}

/** The only input crossing the management boundary that may contain the raw key. */
export interface ServiceModelProviderManagementPort {
  /** False means that no provider intent may be created. */
  readonly available?: boolean;
  create(
    input: {
      readonly protocol: typeof SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL;
      readonly operation_id: string;
      readonly provider_id: string;
      readonly display_name: string;
      readonly base_url: string | null;
      readonly model_ids: readonly string[];
      readonly alias: string;
      readonly api_key: string;
    },
    context?: {
      readonly signal?: AbortSignal;
      readonly deadline_ms?: number;
    },
  ): Promise<{
    readonly provider_config_id: string;
    readonly provider_slug: string;
    readonly alias: string;
  }>;
  /** Read-only control-plane reconciliation; it never accepts a provider key. */
  read(
    input: ServiceModelProviderManagementReadInput,
    context?: {
      readonly signal?: AbortSignal;
      readonly deadline_ms?: number;
    },
  ): Promise<ServiceModelProviderManagementReadback | null>;
}

export interface ServiceModelProviderManagementReadInput {
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly alias: string;
  readonly provider_config_id: string | null;
}

export interface ServiceModelProviderManagementReadback {
  readonly provider_config_id: string;
  readonly provider_slug: string;
  readonly alias: string;
}

export interface ServiceModelProviderService {
  list(context: AuthenticatedRequestContext): Promise<{
    readonly connections: readonly ServiceModelProviderConnection[];
    readonly truncated: boolean;
  }>;
  create(
    context: AuthenticatedRequestContext,
    input: ServiceModelProviderCreateRequest,
  ): Promise<{
    readonly receipt: ServiceModelProviderCreateReceipt;
    readonly replayed: boolean;
  }>;
  readOperation(
    context: AuthenticatedRequestContext,
    operationId: string,
  ): Promise<ServiceModelProviderConnection | null>;
}

interface ServiceModelProviderOperationRow {
  readonly owner_id: unknown;
  readonly operation_id: unknown;
  readonly provider_id: unknown;
  readonly display_name: unknown;
  readonly base_url: unknown;
  readonly model_ids_json: unknown;
  readonly request_sha256: unknown;
  readonly alias: unknown;
  readonly state: unknown;
  readonly provider_config_id: unknown;
  readonly provider_slug: unknown;
  readonly metadata_sha256: unknown;
  readonly failure_code: unknown;
  readonly provider_http_status: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ManagementFailure {
  readonly effect: ServiceModelProviderOperationEffect;
  readonly failure_code: ServiceModelProviderFailureCode | null;
  readonly provider_http_status: number | null;
}

function fail(
  code: ServiceModelProviderOperationErrorCode,
  status: 400 | 403 | 404 | 409 | 502 | 503,
  message: string,
  retryable: boolean,
  effect: ServiceModelProviderOperationEffect = "NONE",
  failureCode?: ServiceModelProviderFailureCode,
  providerHttpStatus?: number,
): never {
  throw new ServiceModelProviderOperationError(
    code,
    status,
    message,
    retryable,
    effect,
    failureCode,
    providerHttpStatus,
  );
}

function isSafeHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function validNow(now: () => number): string {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("SERVICE_MODEL_PROVIDER_CLOCK_INVALID", 503,
      "Service model provider clock is unavailable", true);
  }
  return new Date(value).toISOString();
}

function ownerPrincipal(context: AuthenticatedRequestContext, now: () => number): string {
  const access = context.access;
  const accessExpires = access === undefined ? Number.POSITIVE_INFINITY : Date.parse(access.expires_at);
  const invalidAccess = access !== undefined &&
    (!Number.isFinite(accessExpires) || accessExpires <= now() ||
      access.principal_ref !== context.principal_ref ||
      access.credential_generation !== context.credential_generation ||
      access.authentication_method === "service_token");
  if (context.client_class !== "owner_pwa" ||
      !IDENTIFIER.test(context.principal_ref) ||
      !IDENTIFIER.test(context.credential_generation) ||
      context.request.signal.aborted || invalidAccess) {
    fail("SERVICE_MODEL_PROVIDER_OWNER_REQUIRED", 403,
      "An active directly authenticated owner context is required", false);
  }
  return context.principal_ref;
}

function validOperationId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Service model provider operation ID is invalid", false);
  }
  return value;
}

function baseUrl(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function expectedProviderSlug(providerId: string, baseUrlValue: string | null): string {
  return KNOWN_NATIVE_PROVIDER_IDS.has(providerId) && baseUrlValue === null
    ? providerId
    : `custom-${providerId}`;
}

function parsedModelIds(value: unknown): string[] {
  if (typeof value !== "string") {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
      "Stored service model provider model IDs are invalid", true);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
    "Stored service model provider model IDs are invalid", true); }
  if (!Array.isArray(parsed) || parsed.some((model) => typeof model !== "string")) {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
      "Stored service model provider model IDs are invalid", true);
  }
  return [...parsed];
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
      "Stored service model provider timestamp is invalid", true);
  }
  return value;
}

function failureCode(value: unknown): ServiceModelProviderFailureCode | null {
  if (value === null) return null;
  const parsed = ServiceModelProviderFailureCodeSchema.safeParse(value);
  if (!parsed.success) {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
      "Stored service model provider failure code is invalid", true);
  }
  return parsed.data;
}

function rowString(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503, message, true);
  }
  return value;
}

function mapConnection(row: ServiceModelProviderOperationRow): ServiceModelProviderConnection {
  const operationId = rowString(row.operation_id, UUID, "Stored service model provider operation ID is invalid");
  const providerId = rowString(row.provider_id, PROVIDER_ID, "Stored service model provider ID is invalid");
  const displayName = rowString(row.display_name, /^.{1,128}$/u, "Stored service model provider display name is invalid");
  const storedAlias = row.alias === null ? null : rowString(row.alias, SAFE_ALIAS, "Stored service model provider alias is invalid");
  const storedBaseUrl = row.base_url === null ? null : rowString(row.base_url, /^https:\/\//u, "Stored service model provider URL is invalid");
  const storedProviderSlug = row.provider_slug === null
    ? null
    : rowString(row.provider_slug, PROVIDER_ID, "Stored Cloudflare provider slug is invalid");
  const requestSha = rowString(row.request_sha256, SHA256, "Stored service model provider request digest is invalid");
  const modelIds = parsedModelIds(row.model_ids_json);
  const createdAt = exactTimestamp(row.created_at);
  const updatedAt = exactTimestamp(row.updated_at);
  const storedFailureCode = failureCode(row.failure_code);
  const providerHttpStatus = row.provider_http_status === null ? null : row.provider_http_status;
  if (providerHttpStatus !== null && !isSafeHttpStatus(providerHttpStatus)) {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
      "Stored service model provider HTTP status is invalid", true);
  }
  const state = row.state;
  let status: ServiceModelProviderConnection["status"];
  let providerConfigId: string | null = null;
  let connectionAlias: string | null = null;
  if (state === "CONFIGURED") {
    providerConfigId = rowString(row.provider_config_id, SAFE_ID,
      "Stored service model provider configuration ID is invalid");
    if (storedProviderSlug !== expectedProviderSlug(providerId, storedBaseUrl) ||
        storedAlias === null || row.metadata_sha256 === null ||
        !SHA256.test(String(row.metadata_sha256)) || storedFailureCode !== null || providerHttpStatus !== null) {
      fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
        "Stored service model provider receipt is invalid", true);
    }
    status = "configured";
    connectionAlias = storedAlias;
  } else if (state === "PENDING" || state === "SUBMITTING" || state === "UNCERTAIN") {
    if (providerConfigId !== null || storedProviderSlug !== null ||
        row.metadata_sha256 !== null || storedFailureCode !== null || providerHttpStatus !== null) {
      fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
        "Stored uncertain service model provider receipt is invalid", true);
    }
    status = "uncertain";
  } else if (state === "FAILED_NO_EFFECT") {
    if (providerConfigId !== null || storedProviderSlug !== null ||
        row.metadata_sha256 !== null || storedFailureCode === null) {
      fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
        "Stored failed service model provider receipt is invalid", true);
    }
    status = "failed_no_effect";
  } else {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
      "Stored service model provider state is invalid", true);
  }
  const connection = {
    operation_id: operationId,
    provider_id: providerId,
    display_name: displayName,
    model_ids: modelIds,
    base_url: storedBaseUrl,
    status,
    provider_config_id: providerConfigId,
    alias: connectionAlias,
    failure_code: storedFailureCode,
    provider_http_status: providerHttpStatus,
    created_at: createdAt,
    updated_at: updatedAt,
  } as const;
  if (!ServiceModelProviderConnectionSchema.safeParse(connection).success) {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
      "Stored service model provider connection is invalid", true);
  }
  void requestSha;
  return Object.freeze(connection);
}

function requestReceipt(row: ServiceModelProviderOperationRow): ServiceModelProviderCreateReceipt {
  const connection = mapConnection(row);
  if (connection.status !== "configured" || connection.provider_config_id === null || connection.alias === null) {
    fail("SERVICE_MODEL_PROVIDER_OUTCOME_UNKNOWN", 503,
      "Service model provider operation has no acknowledged configuration", false, "UNKNOWN");
  }
  const providerSlug = rowString(row.provider_slug, PROVIDER_ID,
    "Stored Cloudflare provider slug is invalid");
  return Object.freeze({
    protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
    operation_id: connection.operation_id,
    provider_id: connection.provider_id,
    display_name: connection.display_name,
    model_ids: connection.model_ids,
    base_url: connection.base_url,
    alias: connection.alias,
    provider_config_id: connection.provider_config_id,
    provider_slug: providerSlug,
    status: "configured",
    created_at: connection.created_at,
  });
}

function managementFailure(error: unknown): ManagementFailure {
  const value = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const rawEffect = value.effect;
  const effect: ServiceModelProviderOperationEffect = rawEffect === "NONE" ? "NONE" : "UNKNOWN";
  const rawCode = value.failure_code ?? value.code;
  let mapped: ServiceModelProviderFailureCode | null = null;
  if (rawCode === "SERVICE_MODEL_PROVIDER_CREDENTIAL_INVALID" ||
      rawCode === "CUSTOM_PROVIDER_CREDENTIAL_INVALID" ||
      rawCode === "PROVIDER_CONFIG_CREDENTIAL_INVALID" ||
      rawCode === "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID") mapped = "SERVICE_MODEL_PROVIDER_CREDENTIAL_INVALID";
  else if (rawCode === "SERVICE_MODEL_PROVIDER_INPUT_INVALID" ||
      rawCode === "CUSTOM_PROVIDER_INPUT_INVALID" ||
      rawCode === "PROVIDER_CONFIG_INPUT_INVALID" ||
      rawCode === "OPENROUTER_PROVIDER_KEY_INPUT_INVALID") mapped = "SERVICE_MODEL_PROVIDER_INPUT_INVALID";
  else if (rawCode === "SERVICE_MODEL_PROVIDER_ALIAS_CONFLICT" ||
      rawCode === "CUSTOM_PROVIDER_EXISTING_CONFLICT" ||
      rawCode === "PROVIDER_CONFIG_EXISTING_CONFLICT" ||
      rawCode === "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT") mapped = "SERVICE_MODEL_PROVIDER_ALIAS_CONFLICT";
  else if (typeof rawCode === "string" &&
      (rawCode.includes("PREFLIGHT") || rawCode.includes("TRANSPORT") || rawCode.includes("HTTP") || rawCode.includes("API"))) {
    mapped = "SERVICE_MODEL_PROVIDER_PREFLIGHT_FAILED";
  }
  return Object.freeze({
    effect,
    failure_code: mapped,
    provider_http_status: isSafeHttpStatus(value.http_status) ? value.http_status : null,
  });
}

export function createServiceModelProviderService(options: {
  readonly database: D1Database;
  readonly managementPort?: ServiceModelProviderManagementPort;
  readonly now?: () => number;
}): ServiceModelProviderService {
  if (options === null || typeof options !== "object" || options.database === null ||
      typeof options.database?.prepare !== "function") {
    fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
      "Core D1 binding is unavailable", true);
  }
  const now = options.now ?? (() => Date.now());

  async function readRow(ownerId: string, operationId: string): Promise<ServiceModelProviderOperationRow | null> {
    try {
      return await options.database.prepare(
        "SELECT owner_id,operation_id,provider_id,display_name,base_url,model_ids_json,request_sha256,alias,state," +
        "provider_config_id,provider_slug,metadata_sha256,failure_code,provider_http_status,created_at,updated_at " +
        "FROM service_model_provider_operation WHERE owner_id=?1 AND operation_id=?2 LIMIT 1",
      ).bind(ownerId, operationId).first<ServiceModelProviderOperationRow>();
    } catch {
      fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
        "Service model provider operation readback is unavailable", true);
    }
  }

  async function markUncertain(ownerId: string, operationId: string, timestamp: string): Promise<boolean> {
    try {
      const result = await options.database.prepare(
        "UPDATE service_model_provider_operation SET state='UNCERTAIN',updated_at=?1 " +
        "WHERE owner_id=?2 AND operation_id=?3 AND state='SUBMITTING'",
      ).bind(timestamp, ownerId, operationId).run();
      return result.meta.changes === 1;
    } catch {
      return false;
    }
  }

  async function markFailedNoEffect(
    ownerId: string,
    operationId: string,
    timestamp: string,
    failure: ManagementFailure,
  ): Promise<boolean> {
    if (failure.failure_code === null) return false;
    try {
      const result = await options.database.prepare(
        "UPDATE service_model_provider_operation SET state='FAILED_NO_EFFECT',failure_code=?1," +
        "provider_http_status=?2,updated_at=?3 WHERE owner_id=?4 AND operation_id=?5 AND state='SUBMITTING'",
      ).bind(failure.failure_code, failure.provider_http_status, timestamp, ownerId, operationId).run();
      return result.meta.changes === 1;
    } catch {
      return false;
    }
  }

  async function failUnknown(ownerId: string, operationId: string, cause?: unknown): Promise<never> {
    const changed = await markUncertain(ownerId, operationId, validNow(now));
    void cause;
    if (!changed) {
      fail("SERVICE_MODEL_PROVIDER_OUTCOME_UNKNOWN", 503,
        "Service model provider outcome is unknown; read the operation before another request", false, "UNKNOWN");
    }
    fail("SERVICE_MODEL_PROVIDER_OUTCOME_UNKNOWN", 503,
      "Service model provider outcome is unknown; read the operation before another request", false, "UNKNOWN");
  }

  async function readList(ownerId: string): Promise<{
    readonly connections: readonly ServiceModelProviderConnection[];
    readonly truncated: boolean;
  }> {
    let rows: { readonly results?: readonly ServiceModelProviderOperationRow[] };
    try {
      rows = await options.database.prepare(
        "SELECT owner_id,operation_id,provider_id,display_name,base_url,model_ids_json,request_sha256,alias,state," +
        "provider_config_id,provider_slug,metadata_sha256,failure_code,provider_http_status,created_at,updated_at " +
        "FROM service_model_provider_operation WHERE owner_id=?1 " +
        "ORDER BY created_at DESC,operation_id DESC LIMIT ?2",
      ).bind(ownerId, MAX_HISTORY + 1).all<ServiceModelProviderOperationRow>();
    } catch {
      fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
        "Service model provider status is unavailable", true);
    }
    const selected = rows.results ?? [];
    return Object.freeze({
      connections: Object.freeze(selected.slice(0, MAX_HISTORY).map(mapConnection)),
      truncated: selected.length > MAX_HISTORY,
    });
  }

  async function resolveExisting(
    row: ServiceModelProviderOperationRow,
    requestSha: string,
  ): Promise<{ readonly receipt: ServiceModelProviderCreateReceipt; readonly replayed: boolean } | null> {
    if (row.request_sha256 !== requestSha) {
      fail("SERVICE_MODEL_PROVIDER_OPERATION_CONFLICT", 409,
        "This operation ID is already bound to a different provider request", false);
    }
    if (row.state === "CONFIGURED") return Object.freeze({ receipt: requestReceipt(row), replayed: true });
    if (row.state === "FAILED_NO_EFFECT") {
      const connection = mapConnection(row);
      fail("SERVICE_MODEL_PROVIDER_PROVIDER_REJECTED", 502,
        "Cloudflare did not create this service model provider", false, "NONE",
        connection.failure_code ?? undefined, connection.provider_http_status ?? undefined);
    }
    if (row.state === "SUBMITTING" || row.state === "UNCERTAIN") {
      fail("SERVICE_MODEL_PROVIDER_OUTCOME_UNKNOWN", 503,
        "Service model provider outcome is unknown; read the operation before another request", false, "UNKNOWN");
    }
    if (row.state !== "PENDING") {
      fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
        "Stored service model provider operation state is invalid", true);
    }
    return null;
  }

  async function reconcileUncertain(
    context: AuthenticatedRequestContext,
    owner: string,
    row: ServiceModelProviderOperationRow,
  ): Promise<ServiceModelProviderConnection> {
    const current = mapConnection(row);
    const management = options.managementPort;
    if (management === undefined || management.available === false) return current;
    const read = management.read;
    if (read === undefined) return current;
    const providerId = rowString(row.provider_id, PROVIDER_ID,
      "Stored service model provider ID is invalid");
    const operationId = rowString(row.operation_id, UUID,
      "Stored service model provider operation ID is invalid");
    const storedBaseUrl = row.base_url === null ? null : rowString(row.base_url, /^https:\/\//u,
      "Stored service model provider URL is invalid");
    const providerSlug = expectedProviderSlug(providerId, storedBaseUrl);
    const alias = rowString(row.alias, SAFE_ALIAS, "Stored service model provider alias is invalid");
    const deadline = now() + MANAGEMENT_DEADLINE_MS;
    if (!Number.isSafeInteger(deadline) || deadline <= 0) return current;

    let readback: ServiceModelProviderManagementReadback | null;
    try {
      readback = await read({
        provider_id: providerId,
        provider_slug: providerSlug,
        alias,
        provider_config_id: null,
      }, { signal: context.request.signal, deadline_ms: deadline });
    } catch {
      return current;
    }
    ownerPrincipal(context, now);
    if (readback === null || !SAFE_ID.test(readback.provider_config_id) ||
        readback.provider_slug !== providerSlug || readback.alias !== alias) {
      return current;
    }
    const metadataSha = await sha256(JSON.stringify([
      SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, operationId, providerId,
      readback.provider_slug, readback.provider_config_id, alias,
    ]));
    let updated;
    try {
      updated = await options.database.prepare(
        "UPDATE service_model_provider_operation SET state='CONFIGURED',provider_config_id=?1," +
        "provider_slug=?2,metadata_sha256=?3,updated_at=?4 " +
        "WHERE owner_id=?5 AND operation_id=?6 AND state IN ('UNCERTAIN','SUBMITTING') AND request_sha256=?7",
      ).bind(readback.provider_config_id, readback.provider_slug, metadataSha, validNow(now),
        owner, operationId, row.request_sha256).run();
    } catch {
      fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
        "Service model provider reconciliation could not be recorded", true);
    }
    if (updated.meta.changes !== 1) {
      const latest = await readRow(owner, operationId);
      if (latest === null) {
        fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
          "Service model provider reconciliation row disappeared", true);
      }
      return mapConnection(latest);
    }
    const acknowledged = await readRow(owner, operationId);
    if (acknowledged === null) {
      fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
        "Service model provider reconciliation readback is unavailable", true);
    }
    return mapConnection(acknowledged);
  }

  return Object.freeze({
    async list(context: AuthenticatedRequestContext) {
      const owner = ownerPrincipal(context, now);
      return readList(owner);
    },

    async readOperation(context: AuthenticatedRequestContext, operationIdRaw: string) {
      const owner = ownerPrincipal(context, now);
      const operationId = validOperationId(operationIdRaw);
      const row = await readRow(owner, operationId);
      if (row === null) return null;
      if (row.state === "UNCERTAIN" || row.state === "SUBMITTING") {
        return reconcileUncertain(context, owner, row);
      }
      return mapConnection(row);
    },

    async create(context: AuthenticatedRequestContext, rawInput: ServiceModelProviderCreateRequest) {
      const parsed = ServiceModelProviderCreateRequestSchema.safeParse(rawInput);
      if (!parsed.success) {
        fail("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400,
          "Service model provider request is invalid", false);
      }
      const owner = ownerPrincipal(context, now);
      if (options.managementPort === undefined || options.managementPort.available === false) {
        fail(SERVICE_MODEL_PROVIDER_MANAGEMENT_UNAVAILABLE, 503,
          "Service model provider management is not configured", true);
      }
      const managementPort = options.managementPort;
      const input = parsed.data;
      const operationId = input.operation_id;
      const normalizedBaseUrl = baseUrl(input.base_url);
      const actualProviderSlug = expectedProviderSlug(input.provider_id, normalizedBaseUrl);
      if (actualProviderSlug.length > 63) {
        fail("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400,
          "Service model provider ID cannot form a valid Cloudflare provider slug", false);
      }
      const keyFingerprint = await sha256(input.api_key);
      const requestSha = await sha256(JSON.stringify([
        SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, owner, operationId, input.provider_id,
        input.display_name, normalizedBaseUrl, input.model_ids, keyFingerprint,
      ]));
      const aliasDigest = await sha256(JSON.stringify([
        "eliotr.service-model-provider-alias.v1", owner, operationId, input.provider_id,
      ]));
      const alias = `eliotr-${aliasDigest.slice(0, 48)}`;
      const createdAt = validNow(now);

      let row = await readRow(owner, operationId);
      if (row !== null) {
        const replay = await resolveExisting(row, requestSha);
        if (replay !== null) return replay;
      } else {
        try {
          await options.database.prepare(
            "INSERT INTO service_model_provider_operation " +
            "(owner_id,operation_id,provider_id,display_name,base_url,model_ids_json,request_sha256,alias,state," +
            "provider_config_id,provider_slug,metadata_sha256,failure_code,provider_http_status,created_at,updated_at) " +
            "VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'PENDING',NULL,NULL,NULL,NULL,NULL,?9,?9) " +
            "ON CONFLICT(owner_id,operation_id) DO NOTHING",
          ).bind(owner, operationId, input.provider_id, input.display_name, normalizedBaseUrl,
            JSON.stringify(input.model_ids), requestSha, alias, createdAt).run();
        } catch {
          fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
            "Service model provider operation intent could not be recorded", true);
        }
        row = await readRow(owner, operationId);
        if (row === null) {
          fail("SERVICE_MODEL_PROVIDER_OPERATION_CONFLICT", 409,
            "Service model provider operation could not be claimed", false);
        }
        const replay = await resolveExisting(row, requestSha);
        if (replay !== null) return replay;
      }

      let claim;
      try {
        claim = await options.database.prepare(
          "UPDATE service_model_provider_operation SET state='SUBMITTING',updated_at=?1 " +
          "WHERE owner_id=?2 AND operation_id=?3 AND state='PENDING' AND request_sha256=?4",
        ).bind(validNow(now), owner, operationId, requestSha).run();
      } catch {
        fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
          "Service model provider operation could not be claimed", true);
      }
      if (claim.meta.changes !== 1) {
        const afterClaim = await readRow(owner, operationId);
        if (afterClaim === null) {
          fail("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503,
            "Service model provider operation claim disappeared", true);
        }
        const replay = await resolveExisting(afterClaim, requestSha);
        if (replay !== null) return replay;
        fail("SERVICE_MODEL_PROVIDER_OPERATION_IN_PROGRESS", 409,
          "This service model provider operation is already in progress; read its status", true);
      }

      let managed: Awaited<ReturnType<ServiceModelProviderManagementPort["create"]>> | undefined;
      try {
        const deadline = now() + MANAGEMENT_DEADLINE_MS;
        if (!Number.isSafeInteger(deadline) || deadline <= 0) {
          fail("SERVICE_MODEL_PROVIDER_CLOCK_INVALID", 503,
            "Service model provider deadline is unavailable", true);
        }
        managed = await managementPort.create({
          protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
          operation_id: operationId,
          provider_id: input.provider_id,
          display_name: input.display_name,
          base_url: normalizedBaseUrl,
          model_ids: Object.freeze([...input.model_ids]),
          alias,
          api_key: input.api_key,
        }, { signal: context.request.signal, deadline_ms: deadline });
      } catch (error) {
        const failure = managementFailure(error);
        const timestamp = validNow(now);
        if (failure.effect === "NONE" && failure.failure_code !== null &&
            await markFailedNoEffect(owner, operationId, timestamp, failure)) {
          fail("SERVICE_MODEL_PROVIDER_PROVIDER_REJECTED", 502,
            "Cloudflare did not create this service model provider", false, "NONE",
            failure.failure_code, failure.provider_http_status ?? undefined);
        }
        await failUnknown(owner, operationId, error);
      }

      if (managed === undefined) return await failUnknown(owner, operationId);

      if (typeof managed.provider_config_id !== "string" || !SAFE_ID.test(managed.provider_config_id) ||
          managed.provider_slug !== expectedProviderSlug(input.provider_id, normalizedBaseUrl) ||
          managed.alias !== alias) {
        return await failUnknown(owner, operationId);
      }
      const metadataSha = await sha256(JSON.stringify([
        SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, operationId, input.provider_id,
        managed.provider_slug, managed.provider_config_id, alias,
      ]));
      let completed: D1Result<unknown> | undefined;
      try {
        completed = await options.database.prepare(
          "UPDATE service_model_provider_operation SET state='CONFIGURED',provider_config_id=?1," +
          "provider_slug=?2,metadata_sha256=?3,updated_at=?4 " +
          "WHERE owner_id=?5 AND operation_id=?6 AND state='SUBMITTING' AND request_sha256=?7",
        ).bind(managed.provider_config_id, managed.provider_slug, metadataSha, validNow(now),
          owner, operationId, requestSha).run();
      } catch {
        await failUnknown(owner, operationId);
      }
      if (completed === undefined) return await failUnknown(owner, operationId);
      if (completed.meta.changes !== 1) await failUnknown(owner, operationId);
      const acknowledged = await readRow(owner, operationId);
      if (acknowledged === null) return await failUnknown(owner, operationId);
      return Object.freeze({ receipt: requestReceipt(acknowledged), replayed: false });
    },
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}
