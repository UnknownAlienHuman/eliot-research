import type { ComputerAgentConnection } from "@eliotr/contracts";
import {
  readCurrentComputerAgentConnection,
} from "@eliotr/cloudflare-computer-agent/computer-agent-connection-store";
import {
  readComputerAgentQualificationStatusForConnection,
} from "@eliotr/cloudflare-computer-agent/computer-agent-qualification-store";

const SINK_REF = "github-issue";
const LEASE_MS = 120_000;
const REPOSITORY_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/u;
const HEALTH_CODES = new Set([
  "REQUIRED_CONNECTOR_UNAVAILABLE", "OPTIONAL_CONNECTOR_DEGRADED", "PROJECTION_LAG",
  "OUTBOX_STALLED", "DLQ_NONEMPTY", "BUDGET_WARNING", "BUDGET_BLOCKED", "OPEN_INCIDENT",
]);

export type DoctorMcpSinkState = "UNCONFIGURED" | "READY" | "UNAVAILABLE";

export interface DoctorDeliveryLeaseIdentity {
  readonly connection_id: string;
  readonly connection_revision: number;
  readonly worker_slot: string;
  readonly generation: number;
  readonly expires_at: string;
}

export type DoctorDeliveryPullResult =
  | { readonly protocol: "eliotr.doctor-delivery-pull.v1"; readonly state: "EMPTY" }
  | {
      readonly protocol: "eliotr.doctor-delivery-pull.v1";
      readonly state: "LEASED";
      readonly item: {
        readonly delivery_id: string;
        readonly incident_id: string;
        readonly marker: string;
        readonly health_code: string;
        readonly severity: "INFO" | "WARNING" | "CRITICAL";
        readonly diagnosis?: string;
        readonly created_at: string;
        readonly target_repository: string;
        readonly lease: DoctorDeliveryLeaseIdentity;
      };
    };

export interface DoctorDeliveryReceiptResult {
  readonly protocol: "eliotr.doctor-delivery-receipt.v1";
  readonly state: "DELIVERED" | "ALREADY_DELIVERED";
  readonly delivery_id: string;
  readonly issue_number: number;
  readonly issue_url: string;
  readonly lease: Omit<DoctorDeliveryLeaseIdentity, "expires_at">;
}

export type DoctorDeliveryErrorCode =
  | "DOCTOR_DELIVERY_INPUT_INVALID"
  | "DOCTOR_DELIVERY_TARGET_UNAVAILABLE"
  | "DOCTOR_DELIVERY_CONNECTION_MISMATCH"
  | "DOCTOR_DELIVERY_STORAGE_UNAVAILABLE"
  | "DOCTOR_DELIVERY_STORAGE_CORRUPT"
  | "DOCTOR_DELIVERY_LEASE_STALE"
  | "DOCTOR_DELIVERY_IDEMPOTENCY_CONFLICT"
  | "DOCTOR_DELIVERY_SETTLEMENT_UNCERTAIN";

export class DoctorDeliveryError extends Error {
  readonly code: DoctorDeliveryErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: DoctorDeliveryErrorCode, status: number, message: string, retryable = false) {
    super(message);
    this.name = "DoctorDeliveryError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function fail(code: DoctorDeliveryErrorCode, status: number, message: string, retryable = false): never {
  throw new DoctorDeliveryError(code, status, message, retryable);
}

function repository(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() !== value) {
    return fail("DOCTOR_DELIVERY_TARGET_UNAVAILABLE", 503, "Doctor issue target is not configured");
  }
  const parts = value.split("/");
  const owner = parts[0];
  const name = parts[1];
  if (parts.length !== 2 || owner === undefined || name === undefined ||
      !REPOSITORY_OWNER.test(owner) || !REPOSITORY_NAME.test(name) || name === "." || name === "..") {
    return fail("DOCTOR_DELIVERY_TARGET_UNAVAILABLE", 503, "Doctor issue target is not configured");
  }
  return value;
}

function agentConnectionId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() !== value ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) {
    return fail("DOCTOR_DELIVERY_TARGET_UNAVAILABLE", 503, "Doctor MCP connection target is invalid");
  }
  return value;
}

function validServiceClientConfiguration(input: {
  readonly auth_profile?: string | undefined;
  readonly client_id?: string | undefined;
  readonly client_ids?: readonly string[] | string | undefined;
}): boolean {
  const profile = input.auth_profile ?? "service-token";
  if (profile !== "service-token" && profile !== "hybrid") return false;
  const configured = new Set<string>();
  if (typeof input.client_id === "string" && input.client_id.trim() === input.client_id && input.client_id.length > 0) {
    configured.add(input.client_id);
  }
  let additional: unknown = input.client_ids;
  if (typeof additional === "string") {
    try { additional = JSON.parse(additional) as unknown; }
    catch { return false; }
  }
  if (additional !== undefined) {
    if (!Array.isArray(additional) || additional.some((item) => typeof item !== "string" ||
        item.length === 0 || item.trim() !== item)) return false;
    for (const item of additional) configured.add(item);
  }
  return configured.size > 0;
}

export async function readDoctorMcpSinkState(input: {
  readonly database: D1Database;
  readonly deployment_generation: string;
  readonly repository: unknown;
  readonly agent_connection_id: unknown;
  readonly mcp_auth_profile?: string | undefined;
  readonly mcp_service_client_id?: string | undefined;
  readonly mcp_service_client_ids?: readonly string[] | string | undefined;
  readonly now_ms: number;
}): Promise<DoctorMcpSinkState> {
  let target: string | null;
  let connectionId: string | null;
  try {
    target = repository(input.repository);
    connectionId = agentConnectionId(input.agent_connection_id);
  }
  catch { return "UNAVAILABLE"; }
  if (target === null || connectionId === null || !validServiceClientConfiguration({
    auth_profile: input.mcp_auth_profile,
    client_id: input.mcp_service_client_id,
    client_ids: input.mcp_service_client_ids,
  })) return "UNCONFIGURED";

  let connection: ComputerAgentConnection | null;
  try {
    connection = await readCurrentComputerAgentConnection(input.database, connectionId);
  } catch {
    return "UNAVAILABLE";
  }
  if (connection === null || connection.connection_id !== connectionId || connection.state !== "ENABLED" ||
      !connection.transport_capabilities.includes("MCP_WRITE")) return "UNAVAILABLE";
  try {
    const qualification = await readComputerAgentQualificationStatusForConnection({
      database: input.database,
      connection_id: connection.connection_id,
      connection_revision: connection.revision,
      transport: "MCP_WRITE",
      now: () => input.now_ms,
    });
    return qualification?.status === "READY" && qualification.transport === "MCP_WRITE" &&
      qualification.deployment_generation === input.deployment_generation &&
      typeof qualification.verified_credential_generation === "string" &&
      typeof qualification.ready_until === "string" && Date.parse(qualification.ready_until) > input.now_ms
      ? "READY" : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

interface DeliveryRow {
  readonly delivery_id: unknown;
  readonly incident_id: unknown;
  readonly marker: unknown;
  readonly state: unknown;
  readonly diagnosis_state: unknown;
  readonly diagnosis: unknown;
  readonly created_at: unknown;
  readonly lease_owner: unknown;
  readonly lease_until: unknown;
  readonly lease_generation: unknown;
  readonly incident_kind: unknown;
  readonly incident_severity: unknown;
  readonly incident_state: unknown;
  readonly external_issue_number: unknown;
  readonly external_issue_url: unknown;
}

interface DecodedDelivery {
  readonly delivery_id: string;
  readonly incident_id: string;
  readonly marker: string;
  readonly state: "PENDING" | "UNKNOWN" | "DELIVERED";
  readonly diagnosis: string | null;
  readonly created_at: string;
  readonly lease_owner: string | null;
  readonly lease_until: number | null;
  readonly lease_generation: number;
  readonly health_code: string;
  readonly severity: "INFO" | "WARNING" | "CRITICAL";
  readonly incident_state: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  readonly external_issue_number: number | null;
  readonly external_issue_url: string | null;
}

const DELIVERY_SELECT =
  "SELECT d.delivery_id,d.incident_id,d.marker,d.state,d.diagnosis_state,d.diagnosis,d.created_at," +
  "d.lease_owner,d.lease_until,d.lease_generation,d.external_issue_number,d.external_issue_url," +
  "i.kind AS incident_kind,i.severity AS incident_severity,i.state AS incident_state " +
  "FROM doctor_delivery_outbox d JOIN incident i ON i.incident_id=d.incident_id ";

function decodeDelivery(row: DeliveryRow): DecodedDelivery {
  const code = typeof row.incident_kind === "string" && row.incident_kind.startsWith("DOCTOR_HEALTH_")
    ? row.incident_kind.slice("DOCTOR_HEALTH_".length) : null;
  if (typeof row.delivery_id !== "string" || !/^doctor-[a-f0-9]{64}$/u.test(row.delivery_id) ||
      typeof row.incident_id !== "string" || !/^doctor-health-[a-f0-9]{64}$/u.test(row.incident_id) ||
      row.incident_id !== `doctor-health-${row.delivery_id.slice("doctor-".length)}` ||
      typeof row.marker !== "string" || row.marker !== `[eliotr-doctor:${row.delivery_id.slice("doctor-".length)}]` ||
      (row.state !== "PENDING" && row.state !== "UNKNOWN" && row.state !== "DELIVERED") ||
      typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
      !Number.isSafeInteger(row.lease_generation) || (row.lease_generation as number) < 0 ||
      (row.lease_owner !== null && typeof row.lease_owner !== "string") ||
      (row.lease_until !== null && (!Number.isSafeInteger(row.lease_until) || (row.lease_until as number) < 0)) ||
      code === null || !HEALTH_CODES.has(code) ||
      (row.incident_severity !== "INFO" && row.incident_severity !== "WARNING" && row.incident_severity !== "CRITICAL") ||
      (row.incident_state !== "OPEN" && row.incident_state !== "ACKNOWLEDGED" && row.incident_state !== "RESOLVED") ||
      (row.diagnosis_state !== "NOT_STARTED" && row.diagnosis_state !== "UNKNOWN" &&
        row.diagnosis_state !== "COMPLETE" && row.diagnosis_state !== "UNAVAILABLE") ||
      (row.diagnosis !== null && typeof row.diagnosis !== "string") ||
      (row.external_issue_number !== null && (!Number.isSafeInteger(row.external_issue_number) ||
        (row.external_issue_number as number) < 1)) ||
      (row.external_issue_url !== null && typeof row.external_issue_url !== "string")) {
    return fail("DOCTOR_DELIVERY_STORAGE_CORRUPT", 500, "Doctor delivery row is corrupt");
  }
  return {
    delivery_id: row.delivery_id,
    incident_id: row.incident_id,
    marker: row.marker,
    state: row.state,
    diagnosis: row.diagnosis_state === "COMPLETE" && typeof row.diagnosis === "string"
      ? row.diagnosis.slice(0, 320) : null,
    created_at: row.created_at,
    lease_owner: row.lease_owner,
    lease_until: row.lease_until as number | null,
    lease_generation: row.lease_generation as number,
    health_code: code,
    severity: row.incident_severity,
    incident_state: row.incident_state,
    external_issue_number: row.external_issue_number as number | null,
    external_issue_url: row.external_issue_url as string | null,
  };
}

function leaseOwner(connection: ComputerAgentConnection, workerSlot: string): string {
  return `mcp-doctor:${connection.connection_id.length}:${connection.connection_id}:` +
    `${connection.revision}:${workerSlot.length}:${workerSlot}`;
}

function currentMcpConnectionExists(firstParameter: number): string {
  const connectionId = firstParameter;
  const revision = firstParameter + 1;
  const owner = firstParameter + 2;
  const issuer = firstParameter + 3;
  const method = firstParameter + 4;
  const subject = firstParameter + 5;
  return "EXISTS (SELECT 1 FROM computer_agent_connection_current c " +
    `WHERE c.connection_id=?${connectionId} AND c.revision=?${revision} ` +
    `AND c.owner_principal_ref=?${owner} AND c.actor_issuer=?${issuer} ` +
    `AND c.actor_method=?${method} AND c.actor_subject=?${subject} AND c.state='ENABLED' ` +
    "AND EXISTS (SELECT 1 FROM json_each(c.transport_capabilities_json) " +
    "WHERE type='text' AND value='MCP_WRITE'))";
}

function currentMcpConnectionValues(connection: ComputerAgentConnection): readonly unknown[] {
  return [connection.connection_id, connection.revision, connection.owner_principal_ref,
    connection.actor.issuer, connection.actor.authentication_method, connection.actor.subject];
}

function validateWorkerSlot(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(value)) {
    return fail("DOCTOR_DELIVERY_INPUT_INVALID", 400, "Doctor delivery worker_slot is invalid");
  }
  return value;
}

function validLeaseConnection(connection: ComputerAgentConnection): void {
  if (connection.state !== "ENABLED" || !connection.transport_capabilities.includes("MCP_WRITE") ||
      !Number.isSafeInteger(connection.revision) || connection.revision < 1) {
    fail("DOCTOR_DELIVERY_LEASE_STALE", 403, "Current MCP_WRITE connection authority is required");
  }
}

function pullResult(
  delivery: DecodedDelivery,
  connection: ComputerAgentConnection,
  workerSlot: string,
  target: string,
): DoctorDeliveryPullResult {
  if (delivery.lease_owner !== leaseOwner(connection, workerSlot) || delivery.lease_until === null ||
      delivery.lease_generation < 1 || delivery.state !== "UNKNOWN" ||
      delivery.incident_state !== "OPEN" && delivery.incident_state !== "ACKNOWLEDGED") {
    return fail("DOCTOR_DELIVERY_STORAGE_CORRUPT", 500, "Doctor delivery lease readback is inconsistent");
  }
  return {
    protocol: "eliotr.doctor-delivery-pull.v1",
    state: "LEASED",
    item: {
      delivery_id: delivery.delivery_id,
      incident_id: delivery.incident_id,
      marker: delivery.marker,
      health_code: delivery.health_code,
      severity: delivery.severity,
      ...(delivery.diagnosis === null ? {} : { diagnosis: delivery.diagnosis }),
      created_at: delivery.created_at,
      target_repository: target,
      lease: {
        connection_id: connection.connection_id,
        connection_revision: connection.revision,
        worker_slot: workerSlot,
        generation: delivery.lease_generation,
        expires_at: new Date(delivery.lease_until).toISOString(),
      },
    },
  };
}

export async function pullDoctorDelivery(input: {
  readonly database: D1Database;
  readonly connection: ComputerAgentConnection;
  readonly target_repository: unknown;
  readonly worker_slot: unknown;
  readonly now?: () => number;
}): Promise<DoctorDeliveryPullResult> {
  const connection = input.connection;
  validLeaseConnection(connection);
  const workerSlot = validateWorkerSlot(input.worker_slot);
  const target = repository(input.target_repository);
  if (target === null) return { protocol: "eliotr.doctor-delivery-pull.v1", state: "EMPTY" };
  const now = input.now ?? Date.now;
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery clock is unavailable", true);
  }
  const owner = leaseOwner(connection, workerSlot);
  let replay: DeliveryRow | null;
  try {
    replay = await input.database.prepare(
      `${DELIVERY_SELECT}WHERE d.sink_ref=?1 AND d.state='UNKNOWN' AND d.lease_owner=?2 ` +
      `AND d.lease_until>?3 AND i.state IN ('OPEN','ACKNOWLEDGED') AND ${currentMcpConnectionExists(4)} LIMIT 1`,
    ).bind(SINK_REF, owner, nowMs, ...currentMcpConnectionValues(connection)).first<DeliveryRow>();
  } catch {
    return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery lease read is unavailable", true);
  }
  if (replay !== null) {
    return pullResult(decodeDelivery(replay), connection, workerSlot, target);
  }

  let candidates: readonly DeliveryRow[];
  try {
    const result = await input.database.prepare(
      `${DELIVERY_SELECT}WHERE d.sink_ref=?1 AND d.state IN ('PENDING','UNKNOWN') ` +
      "AND (d.lease_until IS NULL OR d.lease_until<=?2) AND i.state IN ('OPEN','ACKNOWLEDGED') " +
      "ORDER BY CASE WHEN d.state='UNKNOWN' THEN 0 ELSE 1 END,d.created_at,d.delivery_id LIMIT 8",
    ).bind(SINK_REF, nowMs).all<DeliveryRow>();
    if (result.success !== true || !Array.isArray(result.results)) {
      return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery queue read is unavailable", true);
    }
    candidates = result.results;
  } catch {
    return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery queue read is unavailable", true);
  }
  for (const raw of candidates) {
    const candidate = decodeDelivery(raw);
    const updatedAt = new Date(nowMs).toISOString();
    let update: D1Result;
    try {
      update = await input.database.prepare(
        "UPDATE doctor_delivery_outbox SET state='UNKNOWN',lease_owner=?1,lease_until=?2," +
        "lease_generation=lease_generation+1,last_error_code='MCP_DELIVERY_IN_FLIGHT',updated_at=?3 " +
        "WHERE delivery_id=?4 AND sink_ref=?5 AND state IN ('PENDING','UNKNOWN') " +
        "AND (lease_until IS NULL OR lease_until<=?6) " +
        "AND incident_id IN (SELECT incident_id FROM incident WHERE state IN ('OPEN','ACKNOWLEDGED')) " +
        `AND ${currentMcpConnectionExists(7)}`,
      ).bind(owner, nowMs + LEASE_MS, updatedAt, candidate.delivery_id, SINK_REF, nowMs,
        ...currentMcpConnectionValues(connection)).run();
    } catch {
      return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery lease could not be acquired", true);
    }
    if (update.success !== true) {
      return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery lease could not be acquired", true);
    }
    if (update.meta.changes !== 1) continue;
    let claimed: DeliveryRow | null;
    try {
      claimed = await input.database.prepare(
        `${DELIVERY_SELECT}WHERE d.delivery_id=?1 AND ${currentMcpConnectionExists(2)} LIMIT 1`,
      ).bind(candidate.delivery_id, ...currentMcpConnectionValues(connection)).first<DeliveryRow>();
    } catch {
      return fail("DOCTOR_DELIVERY_SETTLEMENT_UNCERTAIN", 503,
        "Doctor delivery lease was written but readback is unavailable", true);
    }
    if (claimed === null) {
      return fail("DOCTOR_DELIVERY_SETTLEMENT_UNCERTAIN", 503,
        "Doctor delivery lease was written but its row is missing", true);
    }
    return pullResult(decodeDelivery(claimed), connection, workerSlot, target);
  }
  return { protocol: "eliotr.doctor-delivery-pull.v1", state: "EMPTY" };
}

function validateIssueUrl(value: unknown, targetRepository: string, issueNumber: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    return fail("DOCTOR_DELIVERY_INPUT_INVALID", 400, "GitHub issue URL is invalid");
  }
  let url: URL;
  try { url = new URL(value); }
  catch { return fail("DOCTOR_DELIVERY_INPUT_INVALID", 400, "GitHub issue URL is invalid"); }
  const expectedPath = `/${targetRepository}/issues/${issueNumber}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username !== "" ||
      url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "" ||
      url.pathname.toLowerCase() !== expectedPath.toLowerCase() || url.href !== value) {
    return fail("DOCTOR_DELIVERY_INPUT_INVALID", 400, "GitHub issue URL does not match the configured target");
  }
  return value;
}

export async function recordDoctorDeliveryReceipt(input: {
  readonly database: D1Database;
  readonly connection: ComputerAgentConnection;
  readonly target_repository: unknown;
  readonly delivery_id: unknown;
  readonly lease_generation: unknown;
  readonly worker_slot: unknown;
  readonly issue_number: unknown;
  readonly issue_url: unknown;
  readonly now?: () => number;
}): Promise<DoctorDeliveryReceiptResult> {
  const connection = input.connection;
  validLeaseConnection(connection);
  const target = repository(input.target_repository);
  if (target === null) return fail("DOCTOR_DELIVERY_TARGET_UNAVAILABLE", 503, "Doctor issue target is not configured");
  const workerSlot = validateWorkerSlot(input.worker_slot);
  if (typeof input.delivery_id !== "string" || !/^doctor-[a-f0-9]{64}$/u.test(input.delivery_id) ||
      !Number.isSafeInteger(input.lease_generation) || (input.lease_generation as number) < 1 ||
      (input.lease_generation as number) > 2_147_483_647 || !Number.isSafeInteger(input.issue_number) ||
      (input.issue_number as number) < 1 || (input.issue_number as number) > 2_147_483_647) {
    return fail("DOCTOR_DELIVERY_INPUT_INVALID", 400, "Doctor delivery receipt identity is invalid");
  }
  const issueNumber = input.issue_number as number;
  const generation = input.lease_generation as number;
  const issueUrl = validateIssueUrl(input.issue_url, target, issueNumber);
  const owner = leaseOwner(connection, workerSlot);
  const nowMs = (input.now ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery clock is unavailable", true);
  }
  let row: DeliveryRow | null;
  try {
    row = await input.database.prepare(
      `${DELIVERY_SELECT}WHERE d.delivery_id=?1 AND ${currentMcpConnectionExists(2)} LIMIT 1`,
    ).bind(input.delivery_id, ...currentMcpConnectionValues(connection)).first<DeliveryRow>();
  } catch {
    return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery receipt read is unavailable", true);
  }
  if (row === null) return fail("DOCTOR_DELIVERY_LEASE_STALE", 409, "Doctor delivery item is no longer available");
  const current = decodeDelivery(row);
  const receipt = (state: DoctorDeliveryReceiptResult["state"]): DoctorDeliveryReceiptResult => ({
    protocol: "eliotr.doctor-delivery-receipt.v1",
    state,
    delivery_id: current.delivery_id,
    issue_number: issueNumber,
    issue_url: issueUrl,
    lease: {
      connection_id: connection.connection_id,
      connection_revision: connection.revision,
      worker_slot: workerSlot,
      generation,
    },
  });
  if (current.state === "DELIVERED") {
    if (current.lease_owner === owner && current.lease_generation === generation &&
        current.external_issue_number === issueNumber && current.external_issue_url === issueUrl) {
      return receipt("ALREADY_DELIVERED");
    }
    return fail("DOCTOR_DELIVERY_IDEMPOTENCY_CONFLICT", 409,
      "Doctor delivery already has a different committed receipt");
  }
  if (current.state !== "UNKNOWN" || current.lease_owner !== owner ||
      current.lease_generation !== generation || current.lease_until === null || current.lease_until <= nowMs) {
    return fail("DOCTOR_DELIVERY_LEASE_STALE", 409, "Doctor delivery lease is stale or belongs to another agent");
  }
  let update: D1Result;
  try {
    // DELIVERED closes the lease; retain its owner and generation as the receipt replay identity.
    update = await input.database.prepare(
      "UPDATE doctor_delivery_outbox SET state='DELIVERED',external_issue_number=?1," +
      "external_issue_url=?2,last_error_code=NULL,updated_at=?3 " +
      "WHERE delivery_id=?4 AND sink_ref=?5 AND state='UNKNOWN' AND lease_owner=?6 " +
      "AND lease_generation=?7 AND lease_until>?8 AND external_issue_number IS NULL AND external_issue_url IS NULL " +
      `AND ${currentMcpConnectionExists(9)}`,
    ).bind(issueNumber, issueUrl, new Date(nowMs).toISOString(), input.delivery_id, SINK_REF,
      owner, generation, nowMs, ...currentMcpConnectionValues(connection)).run();
  } catch {
    return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery receipt could not be committed", true);
  }
  if (update.success !== true) {
    return fail("DOCTOR_DELIVERY_STORAGE_UNAVAILABLE", 503, "Doctor delivery receipt could not be committed", true);
  }
  if (update.meta.changes === 1) return receipt("DELIVERED");

  let readback: DeliveryRow | null;
  try {
    readback = await input.database.prepare(
      `${DELIVERY_SELECT}WHERE d.delivery_id=?1 AND ${currentMcpConnectionExists(2)} LIMIT 1`,
    ).bind(input.delivery_id, ...currentMcpConnectionValues(connection)).first<DeliveryRow>();
  } catch {
    return fail("DOCTOR_DELIVERY_SETTLEMENT_UNCERTAIN", 503,
      "Doctor delivery receipt outcome is uncertain; retry the identical receipt", true);
  }
  if (readback === null) return fail("DOCTOR_DELIVERY_LEASE_STALE", 409,
    "Current owner-selected MCP connection changed before receipt readback");
  const settled = decodeDelivery(readback);
  if (settled.state === "DELIVERED" && settled.lease_owner === owner &&
      settled.lease_generation === generation && settled.external_issue_number === issueNumber &&
      settled.external_issue_url === issueUrl) return receipt("ALREADY_DELIVERED");
  if (settled.state === "DELIVERED") return fail("DOCTOR_DELIVERY_IDEMPOTENCY_CONFLICT", 409,
    "Doctor delivery already has a different committed receipt");
  return fail("DOCTOR_DELIVERY_LEASE_STALE", 409, "Doctor delivery lease changed before receipt commit");
}
