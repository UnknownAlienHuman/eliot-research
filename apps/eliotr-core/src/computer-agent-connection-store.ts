import {
  ComputerAgentConnectionDisableSchema,
  ComputerAgentConnectionPutSchema,
  ComputerAgentConnectionSchema,
  type ComputerAgentConnection,
  type ComputerAgentConnectionList,
  type ComputerAgentTaskKind,
  type ComputerAgentTransportCapability,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";

const SCHEMA_GENERATION = "computer-agent-connection-v1";
const MAX_RECORD_BYTES = 24_576;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;

export type ComputerAgentConnectionErrorCode =
  | "COMPUTER_AGENT_CONNECTION_SCHEMA_NOT_READY"
  | "COMPUTER_AGENT_CONNECTION_OWNER_REQUIRED"
  | "COMPUTER_AGENT_CONNECTION_INPUT_INVALID"
  | "COMPUTER_AGENT_CONNECTION_NOT_FOUND"
  | "COMPUTER_AGENT_CONNECTION_DENIED"
  | "COMPUTER_AGENT_CONNECTION_IDENTITY_CONFLICT"
  | "COMPUTER_AGENT_CONNECTION_REVISION_CONFLICT"
  | "COMPUTER_AGENT_CONNECTION_STORAGE_CORRUPT"
  | "COMPUTER_AGENT_CONNECTION_STORAGE_UNAVAILABLE"
  | "COMPUTER_AGENT_CONNECTION_SETTLEMENT_UNCERTAIN";

export class ComputerAgentConnectionError extends Error {
  readonly code: ComputerAgentConnectionErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: ComputerAgentConnectionErrorCode, status: number, message: string, retryable = false) {
    super(message);
    this.name = "ComputerAgentConnectionError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
function fail(code: ComputerAgentConnectionErrorCode, status: number, message: string, retryable = false): never {
  throw new ComputerAgentConnectionError(code, status, message, retryable);
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}
function idempotency(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value)) {
    fail("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 400, "Idempotency-Key is required and invalid");
  }
  return value;
}
function instant(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_CONNECTION_STORAGE_UNAVAILABLE", 503, "Computer-agent clock is unavailable", true);
  }
  return value;
}
function owner(context: AuthenticatedRequestContext, now: () => number): string {
  const current = instant(now);
  if (context.client_class !== "owner_pwa" || context.request.signal.aborted) {
    fail("COMPUTER_AGENT_CONNECTION_OWNER_REQUIRED", 403, "A current owner request is required");
  }
  if (context.access && (context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= current)) {
    fail("COMPUTER_AGENT_CONNECTION_OWNER_REQUIRED", 403, "Owner session is no longer current");
  }
  return identifier(context.principal_ref, "owner principal");
}
function serviceActor(context: AuthenticatedRequestContext, now: () => number): { issuer: string; subject: string } {
  const current = instant(now);
  const access = context.access;
  if ((context.client_class !== "trusted_agent" && context.client_class !== "named_api_client") ||
      access === undefined || access.authentication_method !== "service_token" ||
      typeof access.issuer !== "string" || access.principal_ref !== context.principal_ref ||
      access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(access.expires_at)) || Date.parse(access.expires_at) <= current ||
      context.request.signal.aborted) {
    fail("COMPUTER_AGENT_CONNECTION_DENIED", 403, "A current verified service-token actor is required");
  }
  return { issuer: access.issuer, subject: context.principal_ref };
}
async function requireSchema(db: D1Database): Promise<void> {
  let value: string | null;
  try {
    value = await db.prepare("SELECT value FROM schema_state WHERE key='computer_agent_connection_generation'")
      .first<string>("value");
  } catch {
    fail("COMPUTER_AGENT_CONNECTION_SCHEMA_NOT_READY", 503,
      "Computer-agent connection migration 0087 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_CONNECTION_SCHEMA_NOT_READY", 503,
      "Computer-agent connection migration 0087 is required", true);
  }
}

interface ConnectionRow {
  connection_id: string;
  revision: number;
  owner_principal_ref: string;
  actor_issuer: string;
  actor_method: string;
  actor_subject: string;
  state: string;
  idempotency_key: string;
  request_sha256: string;
  record_json: string;
  record_sha256: string;
}
async function decode(row: ConnectionRow): Promise<ComputerAgentConnection> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_CONNECTION_STORAGE_CORRUPT", 500, "Connection record is not valid JSON"); }
  const parsed = ComputerAgentConnectionSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.connection_id !== row.connection_id || parsed.data.revision !== row.revision ||
      parsed.data.owner_principal_ref !== row.owner_principal_ref ||
      parsed.data.actor.issuer !== row.actor_issuer || parsed.data.actor.authentication_method !== row.actor_method ||
      parsed.data.actor.subject !== row.actor_subject || parsed.data.state !== row.state) {
    fail("COMPUTER_AGENT_CONNECTION_STORAGE_CORRUPT", 500, "Connection record identity is corrupt");
  }
  return parsed.data;
}
async function currentById(db: D1Database, connectionId: string): Promise<ConnectionRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_connection_current WHERE connection_id=?1 LIMIT 1")
      .bind(connectionId).first<ConnectionRow>();
  } catch {
    fail("COMPUTER_AGENT_CONNECTION_STORAGE_UNAVAILABLE", 503, "Connection read is unavailable", true);
  }
}
async function replay(db: D1Database, principal: string, key: string): Promise<ConnectionRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_connection WHERE owner_principal_ref=?1 AND idempotency_key=?2 LIMIT 1")
      .bind(principal, key).first<ConnectionRow>();
  } catch {
    fail("COMPUTER_AGENT_CONNECTION_STORAGE_UNAVAILABLE", 503, "Connection replay read is unavailable", true);
  }
}

export interface ComputerAgentConnectionServiceOptions {
  readonly database: D1Database;
  readonly trusted_issuers: readonly string[];
  readonly now?: () => number;
}

export function createComputerAgentConnectionService(options: ComputerAgentConnectionServiceOptions) {
  const db = options.database;
  const now = options.now ?? Date.now;
  const issuers = new Set(options.trusted_issuers);

  async function list(context: AuthenticatedRequestContext, after = ""): Promise<ComputerAgentConnectionList> {
    await requireSchema(db);
    const principal = owner(context, now);
    if (after !== "") identifier(after, "after_connection_id");
    let rows: ConnectionRow[];
    try {
      const result = await db.prepare("SELECT * FROM computer_agent_connection_current " +
        "WHERE owner_principal_ref=?1 AND connection_id>?2 ORDER BY connection_id LIMIT 21")
        .bind(principal, after).all<ConnectionRow>();
      rows = result.results ?? [];
    } catch {
      fail("COMPUTER_AGENT_CONNECTION_STORAGE_UNAVAILABLE", 503, "Connection listing is unavailable", true);
    }
    const decoded = await Promise.all(rows.slice(0, 20).map((row) => decode(row)));
    owner(context, now);
    return {
      protocol: "eliotr.computer-agent-connections.v1",
      connections: decoded,
      ...(rows.length > 20 ? { next_connection_id: decoded[decoded.length - 1]?.connection_id ?? "" } : {}),
    };
  }

  async function mutate(context: AuthenticatedRequestContext, rawId: string, rawInput: unknown,
    operation: "PUT" | "DELETE"): Promise<ComputerAgentConnection> {
    await requireSchema(db);
    const principal = owner(context, now);
    const connectionId = identifier(rawId, "connection_id");
    const key = idempotency(context.request.headers.get("Idempotency-Key"));
    const parsed = operation === "PUT"
      ? ComputerAgentConnectionPutSchema.safeParse(rawInput)
      : ComputerAgentConnectionDisableSchema.safeParse(rawInput);
    if (!parsed.success) {
      fail("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 400,
        "Connection mutation contains unknown or invalid fields");
    }
    const normalized = operation === "PUT" ? (() => {
      const value = ComputerAgentConnectionPutSchema.parse(parsed.data);
      return {
        ...value,
        transport_capabilities: [...value.transport_capabilities].sort(),
        computer_capabilities: [...value.computer_capabilities].sort(),
        task_kinds: [...value.task_kinds].sort(),
      };
    })() : parsed.data;
    const requestDigest = await sha256Utf8(canonicalJson({
      protocol: "eliotr.computer-agent-connection-mutation.v1",
      operation,
      connection_id: connectionId,
      owner_principal_ref: principal,
      input: normalized,
    }));
    const priorReplay = await replay(db, principal, key);
    if (priorReplay !== null) {
      if (priorReplay.request_sha256 !== requestDigest) {
        fail("COMPUTER_AGENT_CONNECTION_REVISION_CONFLICT", 409,
          "Idempotency-Key is already bound to another connection mutation");
      }
      owner(context, now);
      return decode(priorReplay);
    }
    const previousRow = await currentById(db, connectionId);
    const previous = previousRow === null ? null : await decode(previousRow);
    const expected = parsed.data.expected_revision;
    if ((previous?.revision ?? 0) !== expected || (operation === "DELETE" && previous === null)) {
      fail("COMPUTER_AGENT_CONNECTION_REVISION_CONFLICT", 409, "Connection revision changed");
    }
    if (previous !== null && previous.owner_principal_ref !== principal) {
      fail("COMPUTER_AGENT_CONNECTION_DENIED", 403, "Connection belongs to another owner");
    }
    const timestamp = new Date(instant(now)).toISOString();
    let result: ComputerAgentConnection;
    if (operation === "PUT") {
      const input = ComputerAgentConnectionPutSchema.parse(normalized);
      if (!issuers.has(input.actor.issuer)) {
        fail("COMPUTER_AGENT_CONNECTION_DENIED", 403,
          "Connection actor issuer is not a configured Access issuer");
      }
      if (previous !== null && canonicalJson(previous.actor) !== canonicalJson(input.actor)) {
        fail("COMPUTER_AGENT_CONNECTION_IDENTITY_CONFLICT", 409,
          "A logical connection cannot be reassigned to another Access actor");
      }
      result = ComputerAgentConnectionSchema.parse({
        protocol: "eliotr.computer-agent-connection.v1",
        connection_id: connectionId,
        revision: expected + 1,
        owner_principal_ref: principal,
        state: "ENABLED",
        display_name: input.display_name,
        contour: input.contour,
        actor: input.actor,
        transport_capabilities: input.transport_capabilities,
        computer_capabilities: input.computer_capabilities,
        task_kinds: input.task_kinds,
        created_at: previous?.created_at ?? timestamp,
        updated_at: timestamp,
      });
    } else {
      if (previous === null) {
        fail("COMPUTER_AGENT_CONNECTION_NOT_FOUND", 404, "Connection does not exist");
      }
      result = ComputerAgentConnectionSchema.parse({
        ...previous,
        revision: expected + 1,
        state: "DISABLED",
        updated_at: timestamp,
      });
    }
    const record = canonicalJson(result);
    const digest = await sha256Utf8(record);
    if (new TextEncoder().encode(record).byteLength > MAX_RECORD_BYTES) {
      fail("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 413, "Connection exceeds its byte envelope");
    }
    owner(context, now);
    try {
      await db.prepare("INSERT INTO computer_agent_connection(" +
        "connection_id,revision,owner_principal_ref,actor_issuer,actor_method,actor_subject,state," +
        "display_name,contour,transport_capabilities_json,computer_capabilities_json,task_kinds_json," +
        "idempotency_key,request_sha256,record_json,record_sha256,created_at,updated_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)")
        .bind(result.connection_id, result.revision, result.owner_principal_ref,
          result.actor.issuer, result.actor.authentication_method, result.actor.subject,
          result.state, result.display_name, result.contour,
          canonicalJson(result.transport_capabilities), canonicalJson(result.computer_capabilities),
          canonicalJson(result.task_kinds), key, requestDigest, record, digest,
          result.created_at, result.updated_at).run();
    } catch { /* Reconcile lost acknowledgements and CAS conflicts below. */ }
    const settled = await replay(db, principal, key);
    if (settled !== null) {
      if (settled.request_sha256 !== requestDigest) {
        fail("COMPUTER_AGENT_CONNECTION_REVISION_CONFLICT", 409,
          "Idempotency-Key settled another connection mutation");
      }
      const decoded = await decode(settled);
      if (canonicalJson(decoded) !== record) {
        fail("COMPUTER_AGENT_CONNECTION_STORAGE_CORRUPT", 500,
          "Connection receipt differs from the intended revision");
      }
      owner(context, now);
      return decoded;
    }
    const current = await currentById(db, connectionId);
    if ((current?.revision ?? 0) !== expected) {
      fail("COMPUTER_AGENT_CONNECTION_REVISION_CONFLICT", 409,
        "Connection changed before commit");
    }
    fail("COMPUTER_AGENT_CONNECTION_SETTLEMENT_UNCERTAIN", 503,
      "No exact connection receipt; retry with the same Idempotency-Key", true);
  }

  return {
    list,
    put: (context: AuthenticatedRequestContext, connectionId: string, input: unknown) =>
      mutate(context, connectionId, input, "PUT"),
    disable: (context: AuthenticatedRequestContext, connectionId: string, input: unknown) =>
      mutate(context, connectionId, input, "DELETE"),
  };
}

export async function requireComputerAgentConnectionForTask(
  database: D1Database,
  context: AuthenticatedRequestContext,
  transport: ComputerAgentTransportCapability,
  taskKind: ComputerAgentTaskKind,
  now: () => number = Date.now,
): Promise<ComputerAgentConnection> {
  await requireSchema(database);
  const identity = serviceActor(context, now);
  let rows: ConnectionRow[];
  try {
    const result = await database.prepare("SELECT * FROM computer_agent_connection_current " +
      "WHERE actor_issuer=?1 AND actor_subject=?2 LIMIT 2")
      .bind(identity.issuer, identity.subject).all<ConnectionRow>();
    rows = result.results ?? [];
  } catch {
    fail("COMPUTER_AGENT_CONNECTION_STORAGE_UNAVAILABLE", 503,
      "Computer-agent connection authority is unavailable", true);
  }
  if (rows.length === 0) {
    fail("COMPUTER_AGENT_CONNECTION_DENIED", 403,
      "The service actor has no owner-enabled computer-agent connection");
  }
  if (rows.length !== 1) {
    fail("COMPUTER_AGENT_CONNECTION_STORAGE_CORRUPT", 500,
      "The service actor resolves to multiple computer-agent connections");
  }
  const connection = await decode(rows[0]!);
  if (connection.state !== "ENABLED" ||
      !connection.transport_capabilities.includes(transport) ||
      !connection.task_kinds.includes(taskKind)) {
    fail("COMPUTER_AGENT_CONNECTION_DENIED", 403,
      "The computer-agent connection is disabled or lacks the required capability");
  }
  return connection;
}
