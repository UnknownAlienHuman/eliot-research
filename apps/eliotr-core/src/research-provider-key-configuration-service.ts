import {
  RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
  ResearchProviderKeyConfigurationCreateRequestSchema,
  type ResearchProviderKeyConfigurationCreateReceipt,
  type ResearchProviderKeyConfigurationEntry,
  type ResearchProviderKeyConfigurationList,
} from "@eliotr/contracts";
import { OpenRouterProviderKeyRestError, type OpenRouterProviderKeyErrorCode } from "@eliotr/cloudflare-ai";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const ACCOUNT_ID = /^[A-Fa-f0-9]{32}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_ALIAS = /^eliotr-[0-9a-f]{48}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CREATE_PROTOCOL = "eliotr.openrouter-provider-key-create.v1" as const;
const READBACK_PROTOCOL = "eliotr.openrouter-provider-key-configured.v1" as const;
const PROVIDER_ID = "openrouter" as const;
const MAX_HISTORY = 50;
const MANAGEMENT_DEADLINE_MS = 30_000;

export type AssertCurrentResearchProviderKeyProjectAuthority = (
  context: AuthenticatedRequestContext,
  projectId: string,
) => Promise<void>;

/** Raw provider credentials exist only in this call and the adapter's request body. */
export interface ResearchProviderKeyManagementPort {
  readonly account_id: string;
  readonly gateway_id: string;
  /** Local execution controls; these are never serialized into a provider request. */
  create(input: {
    readonly protocol: typeof CREATE_PROTOCOL;
    readonly alias: string;
    readonly secret: string;
  }, context?: {
    readonly signal?: AbortSignal;
    /** Absolute Unix milliseconds, shared by preflight, write, and readback. */
    readonly deadline_ms?: number;
  }): Promise<unknown>;
}

export class ResearchProviderKeyConfigurationError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyConfigurationError";
  }
}

function fail(code: string, status: number, message: string, retryable = false, cause?: unknown): never {
  throw new ResearchProviderKeyConfigurationError(code, status, message, retryable, cause);
}

interface ProjectAuthority {
  readonly owner_id: string;
  readonly project_generation: number;
}

interface OperationRow {
  readonly owner_id: unknown;
  readonly project_id: unknown;
  readonly provider_id: unknown;
  readonly operation_id: unknown;
  readonly account_id: unknown;
  readonly gateway_id: unknown;
  readonly request_sha256: unknown;
  readonly alias: unknown;
  readonly state: unknown;
  readonly provider_config_id: unknown;
  readonly metadata_sha256: unknown;
  readonly failure_code: unknown;
  readonly provider_http_status: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface SafeConfiguredReadback {
  readonly account_id: string;
  readonly gateway_id: string;
  readonly provider_config_id: string;
  readonly secret_id: string;
  readonly observed_modified_at: string;
}

/** Internal server-to-server metadata used by a later explicit check-and-use action. */
export interface ConfiguredResearchProviderKeyOperation {
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly provider_id: "openrouter";
  readonly account_id: string;
  readonly gateway_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly status: "configured_not_qualified";
  readonly created_at: string;
}

function validIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}

function ownerPrincipal(context: AuthenticatedRequestContext, now: () => number): string {
  const accessExpires = context.access === undefined ? Number.POSITIVE_INFINITY : Date.parse(context.access.expires_at);
  if (context.client_class !== "owner_pwa" || !IDENTIFIER.test(context.principal_ref) ||
      !IDENTIFIER.test(context.credential_generation) || context.request.signal.aborted ||
      !Number.isFinite(accessExpires) && context.access !== undefined || accessExpires <= now() ||
      (context.access !== undefined && (context.access.principal_ref !== context.principal_ref ||
        context.access.credential_generation !== context.credential_generation ||
        context.access.authentication_method === "service_token"))) {
    fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OWNER_REQUIRED", 403,
      "An active directly authenticated owner project context is required");
  }
  return context.principal_ref;
}

function utcNow(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_CLOCK_INVALID", 503,
      "Provider key configuration clock is unavailable", true);
  }
  return new Date(value).toISOString();
}

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  const exact = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(exact).set(encoded);
  return exact;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes(value));
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

function mapOperation(row: OperationRow): ResearchProviderKeyConfigurationEntry {
  if (typeof row.operation_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(row.operation_id) ||
      typeof row.account_id !== "string" || !ACCOUNT_ID.test(row.account_id) ||
      typeof row.gateway_id !== "string" || !GATEWAY_ID.test(row.gateway_id) ||
      typeof row.request_sha256 !== "string" || !SHA256.test(row.request_sha256) ||
      row.provider_id !== PROVIDER_ID || typeof row.alias !== "string" || !SAFE_ALIAS.test(row.alias) ||
      typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
      typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) {
    fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
      "Stored provider key configuration metadata is invalid", true);
  }
  let status: ResearchProviderKeyConfigurationEntry["status"];
  let providerConfigId: string | null = null;
  let failureCode: ResearchProviderKeyConfigurationEntry["failure_code"] = null;
  let providerHttpStatus: number | null = null;
  if (row.state === "PENDING" && row.failure_code === null && row.provider_http_status === null) status = "pending";
  else if ((row.state === "SUBMITTING" || row.state === "UNCERTAIN") &&
      row.failure_code === null && row.provider_http_status === null) status = "outcome_unknown";
  else if (row.state === "CONFIGURED" && typeof row.provider_config_id === "string" &&
      /^[A-Za-z0-9._:-]{1,128}$/u.test(row.provider_config_id) &&
      typeof row.metadata_sha256 === "string" && SHA256.test(row.metadata_sha256) &&
      row.failure_code === null && row.provider_http_status === null) {
    status = "configured_not_qualified";
    providerConfigId = row.provider_config_id;
  } else if (row.state === "FAILED_NO_EFFECT" && row.provider_config_id === null && row.metadata_sha256 === null &&
      isNoEffectErrorCode(row.failure_code) && (row.provider_http_status === null ||
        (typeof row.provider_http_status === "number" && Number.isSafeInteger(row.provider_http_status) &&
          row.provider_http_status >= 100 && row.provider_http_status <= 599))) {
    status = "not_configured";
    failureCode = row.failure_code;
    providerHttpStatus = row.provider_http_status as number | null;
  } else {
    fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
      "Stored provider key configuration receipt is invalid", true);
  }
  return Object.freeze({ operation_id: row.operation_id, provider_id: PROVIDER_ID, alias: row.alias,
    provider_config_id: providerConfigId, status, failure_code: failureCode,
    provider_http_status: providerHttpStatus, created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString() });
}

function isNoEffectErrorCode(value: unknown): value is NonNullable<ResearchProviderKeyConfigurationEntry["failure_code"]> {
  return value === "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID" ||
    value === "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED" ||
    value === "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT" ||
    value === "OPENROUTER_PROVIDER_KEY_INPUT_INVALID";
}

function noEffectFailureCode(value: OpenRouterProviderKeyErrorCode):
  NonNullable<ResearchProviderKeyConfigurationEntry["failure_code"]> | null {
  return isNoEffectErrorCode(value) ? value : null;
}

function readback(value: unknown, alias: string, expectedAccount: string, expectedGateway: string): SafeConfiguredReadback {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_READBACK_INVALID", 503,
      "Provider configuration readback is unavailable", true);
  }
  const item = value as Record<string, unknown>;
  if (item.protocol !== READBACK_PROTOCOL || item.disposition !== "configured_not_qualified" ||
      item.provider_slug !== PROVIDER_ID || item.alias !== alias || item.default_config !== false ||
      item.account_id !== expectedAccount || item.gateway_id !== expectedGateway || typeof item.provider_config_id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(item.provider_config_id) || typeof item.secret_id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(item.secret_id) ||
      typeof item.observed_modified_at !== "string" || !Number.isFinite(Date.parse(item.observed_modified_at))) {
    fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_READBACK_INVALID", 503,
      "Provider configuration did not match the requested OpenRouter alias", true);
  }
  return Object.freeze({ account_id: expectedAccount, gateway_id: expectedGateway, provider_config_id: item.provider_config_id,
    secret_id: item.secret_id, observed_modified_at: new Date(item.observed_modified_at).toISOString() });
}

export interface ResearchProviderKeyConfigurationService {
  read(context: AuthenticatedRequestContext, projectId: string, operationId?: string): Promise<ResearchProviderKeyConfigurationList>;
  readConfiguredOperation(context: AuthenticatedRequestContext, projectId: string,
    operationId: string): Promise<ConfiguredResearchProviderKeyOperation>;
  create(context: AuthenticatedRequestContext, projectId: string, input: unknown): Promise<{
    readonly receipt: ResearchProviderKeyConfigurationCreateReceipt;
    readonly replayed: boolean;
  }>;
}

export function createResearchProviderKeyConfigurationService(options: {
  readonly database: D1Database;
  /** This authority is separate from owner authentication and must be server-only. */
  readonly managementPort?: ResearchProviderKeyManagementPort;
  readonly assertCurrentProjectAuthority?: AssertCurrentResearchProviderKeyProjectAuthority;
  readonly now?: () => number;
}): ResearchProviderKeyConfigurationService {
  if (options === null || typeof options !== "object" || options.database === null ||
      typeof options.database?.prepare !== "function") {
    fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
      "Core D1 binding is unavailable", true);
  }
  const now = options.now ?? (() => Date.now());

  async function authorize(context: AuthenticatedRequestContext, projectRaw: string): Promise<ProjectAuthority> {
    const project = validIdentifier(projectRaw, "project_id");
    const owner = ownerPrincipal(context, now);
    let row: { readonly project_generation: number } | null;
    try {
      row = await options.database.prepare(
        "SELECT p.generation AS project_generation FROM project p JOIN project_owner o " +
        "ON o.project_id=p.project_id WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1",
      ).bind(project, owner).first<{ readonly project_generation: number }>();
    } catch (cause) {
      fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
        "Current project owner authority is unavailable", true, cause);
    }
    if (row === null) {
      fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_PROJECT_NOT_FOUND", 404,
        "Project was not found for this owner");
    }
    if (!Number.isSafeInteger(row.project_generation) || row.project_generation < 1) {
      fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
        "Current project generation is unavailable", true);
    }
    if (options.assertCurrentProjectAuthority !== undefined) {
      try { await options.assertCurrentProjectAuthority(context, project); }
      catch (cause) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED", 409,
          "Current project authority changed during provider key configuration", false, cause);
      }
    }
    return Object.freeze({ owner_id: owner, project_generation: row.project_generation });
  }

  async function operation(owner: string, project: string, operationId: string): Promise<OperationRow | null> {
    try {
      return await options.database.prepare(
        "SELECT owner_id,project_id,provider_id,operation_id,account_id,gateway_id,request_sha256,alias,state," +
        "provider_config_id,metadata_sha256,failure_code,provider_http_status,created_at,updated_at " +
        "FROM research_provider_key_configuration_operation " +
        "WHERE owner_id=?1 AND project_id=?2 AND provider_id=?3 AND operation_id=?4 LIMIT 1",
      ).bind(owner, project, PROVIDER_ID, operationId).first<OperationRow>();
    } catch (cause) {
      fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
        "Provider key operation readback is unavailable", true, cause);
    }
  }

  async function markUncertain(owner: string, project: string, operationId: string, timestamp: string): Promise<void> {
    try {
      await options.database.prepare(
        "UPDATE research_provider_key_configuration_operation SET state='UNCERTAIN',updated_at=?1 " +
        "WHERE owner_id=?2 AND project_id=?3 AND provider_id=?4 AND operation_id=?5 AND state='SUBMITTING'",
      ).bind(timestamp, owner, project, PROVIDER_ID, operationId).run();
    } catch {
      // SUBMITTING has the same safe public interpretation if D1 cannot record UNKNOWN.
    }
  }

  async function markFailedNoEffect(
    owner: string,
    project: string,
    operationId: string,
    account: string,
    gateway: string,
    code: NonNullable<ResearchProviderKeyConfigurationEntry["failure_code"]>,
    providerHttpStatus: number | null,
    timestamp: string,
  ): Promise<boolean> {
    try {
      const result = await options.database.prepare(
        "UPDATE research_provider_key_configuration_operation SET state='FAILED_NO_EFFECT',failure_code=?1," +
        "provider_http_status=?2,updated_at=?3 WHERE owner_id=?4 AND project_id=?5 AND provider_id=?6 " +
        "AND operation_id=?7 AND state='SUBMITTING' AND account_id=?8 AND gateway_id=?9",
      ).bind(code, providerHttpStatus, timestamp, owner, project, PROVIDER_ID, operationId, account, gateway).run();
      return result.meta.changes === 1;
    } catch {
      return false;
    }
  }

  async function configurationReceipt(
    owner: string,
    project: string, operationId: string, alias: string, readbackValue: SafeConfiguredReadback, createdAt: string,
  ): Promise<ResearchProviderKeyConfigurationCreateReceipt> {
    const metadataSha = await sha256(JSON.stringify([
      READBACK_PROTOCOL, readbackValue.gateway_id, readbackValue.provider_config_id,
      readbackValue.account_id, PROVIDER_ID, alias, false, readbackValue.secret_id, readbackValue.observed_modified_at,
    ]));
    const timestamp = utcNow(now);
    let result: D1Result;
    try {
      result = await options.database.prepare(
        "UPDATE research_provider_key_configuration_operation SET state='CONFIGURED',provider_config_id=?1," +
        "metadata_sha256=?2,updated_at=?3 WHERE owner_id=?4 AND project_id=?5 AND provider_id=?6 " +
        "AND operation_id=?7 AND state='SUBMITTING' AND account_id=?8 AND gateway_id=?9",
      ).bind(readbackValue.provider_config_id, metadataSha, timestamp, owner, project,
        PROVIDER_ID, operationId, readbackValue.account_id, readbackValue.gateway_id).run();
    } catch (cause) {
      await markUncertain(owner, project, operationId, timestamp);
      fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OUTCOME_UNKNOWN", 503,
        "Provider key outcome is unknown; use the operation status before starting another request", false, cause);
    }
    if (result.meta.changes !== 1) {
      await markUncertain(owner, project, operationId, timestamp);
      fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OUTCOME_UNKNOWN", 503,
        "Provider key outcome is unknown; use the operation status before starting another request", false);
    }
    return Object.freeze({ protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
      project_id: project, provider_id: PROVIDER_ID, operation_id: operationId, alias,
      provider_config_id: readbackValue.provider_config_id, status: "configured_not_qualified",
      created_at: createdAt });
  }

  return Object.freeze({
    async readConfiguredOperation(context: AuthenticatedRequestContext, projectRaw: string, operationIdRaw: string) {
      const before = await authorize(context, projectRaw);
      const project = validIdentifier(projectRaw, "project_id");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationIdRaw)) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 400,
          "Provider key operation ID is invalid");
      }
      const row = await operation(before.owner_id, project, operationIdRaw);
      if (row === null) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OPERATION_NOT_FOUND", 404,
          "Configured provider key operation was not found");
      }
      const safe = mapOperation(row);
      if (safe.status !== "configured_not_qualified" || safe.provider_config_id === null ||
          typeof row.account_id !== "string" || typeof row.gateway_id !== "string") {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_NOT_CONFIGURED", 409,
          "This provider key operation has no acknowledged configuration");
      }
      const after = await authorize(context, project);
      if (after.owner_id !== before.owner_id || after.project_generation !== before.project_generation) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED", 409,
          "Current project authority changed while reading configured provider metadata");
      }
      return Object.freeze({ owner_id: before.owner_id, project_id: project,
        operation_id: operationIdRaw, provider_id: PROVIDER_ID, account_id: row.account_id,
        gateway_id: row.gateway_id, alias: safe.alias, provider_config_id: safe.provider_config_id,
        status: "configured_not_qualified", created_at: safe.created_at });
    },

    async read(context: AuthenticatedRequestContext, projectRaw: string, operationId?: string) {
      const authority = await authorize(context, projectRaw);
      const project = validIdentifier(projectRaw, "project_id");
      let selectedRows: readonly OperationRow[];
      let truncated = false;
      if (operationId !== undefined) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) {
          fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 400,
            "Provider key operation ID is invalid");
        }
        const row = await operation(authority.owner_id, project, operationId);
        selectedRows = row === null ? [] : [row];
      } else {
        let rows: { readonly results?: readonly OperationRow[] };
        try {
          rows = await options.database.prepare(
            "SELECT owner_id,project_id,provider_id,operation_id,account_id,gateway_id,request_sha256,alias,state," +
            "provider_config_id,metadata_sha256,failure_code,provider_http_status,created_at,updated_at " +
            "FROM research_provider_key_configuration_operation " +
            "WHERE owner_id=?1 AND project_id=?2 AND provider_id=?3 ORDER BY created_at DESC,operation_id DESC LIMIT ?4",
          ).bind(authority.owner_id, project, PROVIDER_ID, MAX_HISTORY + 1).all<OperationRow>();
        } catch (cause) {
          fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
            "Provider key configuration status is unavailable", true, cause);
        }
        selectedRows = (rows.results ?? []).slice(0, MAX_HISTORY);
        truncated = (rows.results?.length ?? 0) > MAX_HISTORY;
      }
      const after = await authorize(context, project);
      if (after.owner_id !== authority.owner_id || after.project_generation !== authority.project_generation) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED", 409,
          "Current project authority changed while reading provider key status");
      }
      return Object.freeze({ protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
        project_id: project, provider_id: PROVIDER_ID,
        configurations: Object.freeze(selectedRows.map(mapOperation)),
        truncated });
    },

    async create(context: AuthenticatedRequestContext, projectRaw: string, rawInput: unknown) {
      const input = ResearchProviderKeyConfigurationCreateRequestSchema.safeParse(rawInput);
      if (!input.success) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 400,
          "Provider key configuration request is invalid");
      }
      const current = await authorize(context, projectRaw);
      const project = validIdentifier(projectRaw, "project_id");
      if (options.managementPort === undefined || !ACCOUNT_ID.test(options.managementPort.account_id) ||
          !GATEWAY_ID.test(options.managementPort.gateway_id)) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_MANAGEMENT_UNAVAILABLE", 503,
          "Provider key management is not configured", true);
      }
      const owner = current.owner_id;
      const operationId = input.data.operation_id;
      const account = options.managementPort.account_id;
      const gateway = options.managementPort.gateway_id;
      const keyFingerprint = await sha256(input.data.provider_key);
      const requestSha = await sha256(JSON.stringify([
        RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL, owner, project, PROVIDER_ID,
        operationId, account, gateway, keyFingerprint,
      ]));
      const aliasMaterial = await sha256(JSON.stringify([
        "eliotr-openrouter-provider-key-alias.v1", owner, project, account, gateway, operationId,
      ]));
      const alias = `eliotr-${aliasMaterial.slice(0, 48)}`;
      const createdAt = utcNow(now);
      try {
        await options.database.prepare(
          "INSERT INTO research_provider_key_configuration_operation " +
          "(owner_id,project_id,provider_id,operation_id,account_id,gateway_id,request_sha256,alias,state," +
          "provider_config_id,metadata_sha256,created_at,updated_at) " +
          "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'PENDING',NULL,NULL,?9,?9 FROM project p " +
          "JOIN project_owner o ON o.project_id=p.project_id WHERE p.project_id=?2 AND o.principal_ref=?1 " +
          "AND p.generation=?10 ON CONFLICT(owner_id,project_id,provider_id,operation_id) DO NOTHING",
        ).bind(owner, project, PROVIDER_ID, operationId, account, gateway, requestSha, alias, createdAt,
          current.project_generation).run();
      } catch (cause) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
          "Provider key operation intent could not be recorded", true, cause);
      }
      const existing = await operation(owner, project, operationId);
      if (existing === null) {
        await authorize(context, project);
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED", 409,
          "Project authority changed before provider key configuration began");
      }
      if (existing.account_id !== account || existing.gateway_id !== gateway ||
          existing.alias !== alias || existing.request_sha256 !== requestSha) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OPERATION_CONFLICT", 409,
          "This operation ID is already bound to a different provider key request");
      }
      if (existing.state === "CONFIGURED") {
        const safe = mapOperation(existing);
        if (safe.provider_config_id === null) {
          fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
            "Provider key configuration receipt is unavailable", true);
        }
        return Object.freeze({ replayed: true, receipt: Object.freeze({
          protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL, project_id: project,
          provider_id: PROVIDER_ID, operation_id: operationId, alias,
          provider_config_id: safe.provider_config_id, status: "configured_not_qualified" as const,
          created_at: safe.created_at,
        }) });
      }
      if (existing.state === "FAILED_NO_EFFECT") {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_PROVIDER_REJECTED", 502,
          "Cloudflare did not create this provider key configuration; read its exact operation status", false);
      }
      if (existing.state === "SUBMITTING" || existing.state === "UNCERTAIN") {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OUTCOME_UNKNOWN", 503,
          "Provider key outcome is unknown; use the operation status before starting another request", false);
      }
      if (existing.state !== "PENDING") {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
          "Provider key operation state is invalid", true);
      }

      const claimTime = utcNow(now);
      let claim: D1Result;
      try {
        claim = await options.database.prepare(
          "UPDATE research_provider_key_configuration_operation SET state='SUBMITTING',updated_at=?1 " +
          "WHERE owner_id=?2 AND project_id=?3 AND provider_id=?4 AND operation_id=?5 AND state='PENDING' " +
          "AND account_id=?6 AND gateway_id=?7 AND request_sha256=?8 AND EXISTS (SELECT 1 FROM project p JOIN project_owner o " +
          "ON o.project_id=p.project_id WHERE p.project_id=?3 AND o.principal_ref=?2 AND p.generation=?9)",
        ).bind(claimTime, owner, project, PROVIDER_ID, operationId, account, gateway, requestSha,
          current.project_generation).run();
      } catch (cause) {
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
          "Provider key operation could not be claimed", true, cause);
      }
      if (claim.meta.changes !== 1) {
        const afterClaim = await operation(owner, project, operationId);
        if (afterClaim?.state === "CONFIGURED") {
          const safe = mapOperation(afterClaim);
          if (safe.provider_config_id !== null) {
            return Object.freeze({ replayed: true, receipt: Object.freeze({
              protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL, project_id: project,
              provider_id: PROVIDER_ID, operation_id: operationId, alias,
              provider_config_id: safe.provider_config_id, status: "configured_not_qualified" as const,
              created_at: safe.created_at,
            }) });
          }
        }
        if (afterClaim?.state === "FAILED_NO_EFFECT") {
          fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_PROVIDER_REJECTED", 502,
            "Cloudflare did not create this provider key configuration; read its exact operation status", false);
        }
        if (afterClaim?.state === "SUBMITTING" || afterClaim?.state === "UNCERTAIN") {
          fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OUTCOME_UNKNOWN", 503,
            "Provider key outcome is unknown; use the operation status before starting another request", false);
        }
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OPERATION_IN_PROGRESS", 409,
          "This provider key operation is already in progress; check its status", true);
      }

      try {
        const deadlineMs = now() + MANAGEMENT_DEADLINE_MS;
        if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
          fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_CLOCK_INVALID", 503,
            "Provider key configuration deadline is unavailable", true);
        }
        const response = readback(await options.managementPort.create({
          protocol: CREATE_PROTOCOL, alias, secret: input.data.provider_key,
        }, { signal: context.request.signal, deadline_ms: deadlineMs }), alias, account, gateway);
        let authorityCheck: ProjectAuthority | undefined;
        let authorityFailure: unknown;
        try { authorityCheck = await authorize(context, project); }
        catch (cause) { authorityFailure = cause; }
        const receipt = await configurationReceipt(owner, project, operationId, alias, response, createdAt);
        if (authorityFailure !== undefined) throw authorityFailure;
        if (authorityCheck === undefined || authorityCheck.owner_id !== current.owner_id ||
            authorityCheck.project_generation !== current.project_generation) {
          fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED", 409,
            "Project authority changed during provider key configuration");
        }
        const currentAuthority = await authorize(context, project);
        if (currentAuthority.owner_id !== current.owner_id ||
            currentAuthority.project_generation !== current.project_generation) {
          fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED", 409,
            "Project authority changed before provider key configuration was acknowledged");
        }
        return Object.freeze({ replayed: false, receipt });
      } catch (cause) {
        const timestamp = utcNow(now);
        if (cause instanceof OpenRouterProviderKeyRestError && cause.effect === "NONE") {
          let afterFailure: unknown;
          let afterNoEffect: ProjectAuthority | undefined;
          try { afterNoEffect = await authorize(context, project); }
          catch (authorityError) { afterFailure = authorityError; }
          const failureCode = noEffectFailureCode(cause.code);
          const providerHttpStatus = cause.http_status !== undefined && Number.isSafeInteger(cause.http_status) &&
            cause.http_status >= 100 && cause.http_status <= 599 ? cause.http_status : null;
          const recordedNoEffect = failureCode !== null && await markFailedNoEffect(owner, project, operationId,
            account, gateway, failureCode, providerHttpStatus, timestamp);
          if (afterFailure !== undefined) throw afterFailure;
          if (afterNoEffect === undefined || afterNoEffect.owner_id !== current.owner_id ||
              afterNoEffect.project_generation !== current.project_generation) {
            fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED", 409,
              "Project authority changed during provider key configuration");
          }
          if (recordedNoEffect) {
            fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_PROVIDER_REJECTED", 502,
              "Cloudflare did not create this provider key configuration; read its exact operation status", false);
          }
        }
        await markUncertain(owner, project, operationId, timestamp);
        if (cause instanceof ResearchProviderKeyConfigurationError &&
            cause.code !== "RESEARCH_PROVIDER_KEY_CONFIGURATION_READBACK_INVALID") throw cause;
        fail("RESEARCH_PROVIDER_KEY_CONFIGURATION_OUTCOME_UNKNOWN", 503,
          "Provider key outcome is unknown; use the operation status before starting another request", false);
      }
    },
  });
}
