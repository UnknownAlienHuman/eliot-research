const SHA256 = /^[0-9a-f]{64}$/u;

/** Internal server-to-server metadata for an acknowledged provider-key configuration. */
export interface ConfiguredResearchProviderKeyOperation {
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly provider_id: "openrouter";
  readonly account_id: string;
  readonly gateway_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly metadata_sha256: string;
  readonly status: "configured_not_qualified";
  readonly created_at: string;
}

export type ConfiguredProviderKeyOperationReadResult =
  | Readonly<{ status: "missing" | "not-configured" }>
  | Readonly<{ status: "configured"; operation: ConfiguredResearchProviderKeyOperation }>;

export class ConfiguredProviderKeyOperationReadError extends Error {
  public constructor(public readonly code: "STORAGE_UNAVAILABLE" | "READBACK_INVALID", cause?: unknown) {
    super("Configured provider-key metadata readback is unavailable", cause === undefined ? undefined : { cause });
    this.name = "ConfiguredProviderKeyOperationReadError";
  }
}

interface ConfiguredProviderKeyRow {
  readonly state: unknown;
  readonly provider_config_id: unknown;
  readonly metadata_sha256: unknown;
}

/** Narrows the exact persisted D1 readback fields after the row decoder accepts CONFIGURED. */
export function configuredProviderKeyReadback(row: ConfiguredProviderKeyRow): {
  readonly provider_config_id: string;
  readonly metadata_sha256: string;
} | null {
  if (row.state !== "CONFIGURED") return null;
  if (typeof row.provider_config_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(row.provider_config_id) ||
      typeof row.metadata_sha256 !== "string" || !SHA256.test(row.metadata_sha256)) return null;
  return Object.freeze({ provider_config_id: row.provider_config_id, metadata_sha256: row.metadata_sha256 });
}

interface ConfiguredProviderKeyOperationRow extends ConfiguredProviderKeyRow {
  readonly owner_id: unknown;
  readonly project_id: unknown;
  readonly provider_id: unknown;
  readonly operation_id: unknown;
  readonly account_id: unknown;
  readonly gateway_id: unknown;
  readonly alias: unknown;
  readonly failure_code: unknown;
  readonly provider_http_status: unknown;
  readonly created_at: unknown;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_ALIAS = /^eliotr-[0-9a-f]{48}$/u;

/**
 * The single D1 readback decoder shared by owner-authenticated configuration
 * reads and trusted, current-run native-model resolution. It never selects or
 * returns provider secrets, secret IDs, or control-plane credentials.
 */
export async function readConfiguredProviderKeyOperation(
  database: D1Database,
  ownerRef: string,
  projectId: string,
  operationId: string,
): Promise<ConfiguredProviderKeyOperationReadResult> {
  if (!IDENTIFIER.test(ownerRef) || !IDENTIFIER.test(projectId) || !UUID.test(operationId)) {
    throw new ConfiguredProviderKeyOperationReadError("READBACK_INVALID");
  }
  let row: ConfiguredProviderKeyOperationRow | null;
  try {
    row = await database.prepare(
      "SELECT owner_id,project_id,provider_id,operation_id,account_id,gateway_id,alias,state," +
      "provider_config_id,metadata_sha256,failure_code,provider_http_status,created_at " +
      "FROM research_provider_key_configuration_operation " +
      "WHERE owner_id=?1 AND project_id=?2 AND provider_id='openrouter' AND operation_id=?3 LIMIT 1",
    ).bind(ownerRef, projectId, operationId).first<ConfiguredProviderKeyOperationRow>();
  } catch (cause) {
    throw new ConfiguredProviderKeyOperationReadError("STORAGE_UNAVAILABLE", cause);
  }
  if (row === null) return Object.freeze({ status: "missing" });
  if (row.owner_id !== ownerRef || row.project_id !== projectId || row.operation_id !== operationId ||
      row.provider_id !== "openrouter") {
    throw new ConfiguredProviderKeyOperationReadError("READBACK_INVALID");
  }
  if (row.state !== "CONFIGURED") return Object.freeze({ status: "not-configured" });
  const configured = configuredProviderKeyReadback(row);
  if (configured === null || typeof row.account_id !== "string" || !ACCOUNT_ID.test(row.account_id) ||
      typeof row.gateway_id !== "string" || !GATEWAY_ID.test(row.gateway_id) ||
      typeof row.alias !== "string" || !SAFE_ALIAS.test(row.alias) ||
      row.failure_code !== null || row.provider_http_status !== null ||
      typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
      new Date(Date.parse(row.created_at)).toISOString() !== row.created_at) {
    throw new ConfiguredProviderKeyOperationReadError("READBACK_INVALID");
  }
  return Object.freeze({ status: "configured", operation: Object.freeze({
    owner_id: ownerRef,
    project_id: projectId,
    operation_id: operationId,
    provider_id: "openrouter",
    account_id: row.account_id,
    gateway_id: row.gateway_id,
    alias: row.alias,
    provider_config_id: configured.provider_config_id,
    metadata_sha256: configured.metadata_sha256,
    status: "configured_not_qualified",
    created_at: row.created_at,
  }) });
}
