import {
  ComputerAgentTaskKindSchema,
  ProjectComputerAgentRouteDisableSchema,
  ProjectComputerAgentRoutePutSchema,
  ProjectComputerAgentRouteSchema,
  ResearchComputerAgentRouteBindingSchema,
  type ComputerAgentRouteEntry,
  type ComputerAgentTaskKind,
  type ProjectClientGrant,
  type ProjectComputerAgentRoute,
  type ResearchComputerAgentRouteBinding,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  readComputerAgentConnectionRevision,
  readCurrentComputerAgentConnection,
  requireEnabledComputerAgentConnectionForTask,
} from "./computer-agent-connection-store.js";

const SCHEMA_GENERATION = "project-computer-agent-route-v1";
const MAX_RECORD_BYTES = 24_576;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;

export type ComputerAgentRouteErrorCode =
  | "COMPUTER_AGENT_ROUTE_SCHEMA_NOT_READY"
  | "COMPUTER_AGENT_ROUTE_OWNER_REQUIRED"
  | "COMPUTER_AGENT_ROUTE_INPUT_INVALID"
  | "COMPUTER_AGENT_ROUTE_NOT_FOUND"
  | "COMPUTER_AGENT_ROUTE_DENIED"
  | "COMPUTER_AGENT_ROUTE_IDENTITY_CONFLICT"
  | "COMPUTER_AGENT_ROUTE_REVISION_CONFLICT"
  | "COMPUTER_AGENT_ROUTE_AUTHORITY_STALE"
  | "COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT"
  | "COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE"
  | "COMPUTER_AGENT_ROUTE_SETTLEMENT_UNCERTAIN";

export class ComputerAgentRouteError extends Error {
  readonly code: ComputerAgentRouteErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: ComputerAgentRouteErrorCode, status: number, message: string, retryable = false) {
    super(message);
    this.name = "ComputerAgentRouteError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
function fail(code: ComputerAgentRouteErrorCode, status: number, message: string, retryable = false): never {
  throw new ComputerAgentRouteError(code, status, message, retryable);
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value)) {
    fail("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 400, "Idempotency-Key is required and invalid");
  }
  return value;
}
function taskKind(value: unknown): ComputerAgentTaskKind {
  const parsed = ComputerAgentTaskKindSchema.safeParse(value);
  if (!parsed.success) fail("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 400, "task_kind is invalid");
  return parsed.data;
}
function instant(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE", 503, "Computer-agent route clock is unavailable", true);
  }
  return value;
}
function owner(context: AuthenticatedRequestContext, now: () => number): string {
  const current = instant(now);
  if (context.client_class !== "owner_pwa" || context.request.signal.aborted) {
    fail("COMPUTER_AGENT_ROUTE_OWNER_REQUIRED", 403, "A current owner request is required");
  }
  if (context.access && (context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= current)) {
    fail("COMPUTER_AGENT_ROUTE_OWNER_REQUIRED", 403, "Owner session is no longer current");
  }
  return identifier(context.principal_ref, "owner principal");
}
async function requireSchema(db: D1Database): Promise<void> {
  let value: string | null;
  try {
    value = await db.prepare("SELECT value FROM schema_state WHERE key='project_computer_agent_route_generation'")
      .first<string>("value");
  } catch {
    fail("COMPUTER_AGENT_ROUTE_SCHEMA_NOT_READY", 503,
      "Computer-agent route migration 0088 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_ROUTE_SCHEMA_NOT_READY", 503,
      "Computer-agent route migration 0088 is required", true);
  }
}
async function requireProjectOwner(db: D1Database, projectId: string, principal: string): Promise<void> {
  let row: unknown;
  try {
    row = await db.prepare("SELECT 1 FROM project_owner WHERE project_id=?1 AND principal_ref=?2 LIMIT 1")
      .bind(projectId, principal).first();
  } catch {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE", 503, "Project owner read is unavailable", true);
  }
  if (row === null) fail("COMPUTER_AGENT_ROUTE_OWNER_REQUIRED", 403, "Project owner authority is required");
}

interface RouteRow {
  project_id: string;
  task_kind: string;
  revision: number;
  owner_principal_ref: string;
  state: string;
  strategy: string;
  connection_order_json: string;
  idempotency_key: string;
  request_sha256: string;
  record_json: string;
  record_sha256: string;
  created_at: string;
  updated_at: string;
}
interface EntryRow {
  priority: number;
  connection_id: string;
  connection_revision: number;
}
interface BindingRow {
  operation_id: string;
  project_id: string;
  task_kind: string;
  route_revision: number;
  priority: number;
  connection_id: string;
  connection_revision: number;
  client_grant_id: string;
  client_grant_revision: number;
  actor_issuer: string;
  actor_subject: string;
  binding_json: string;
  binding_sha256: string;
  created_at: string;
}

async function entries(db: D1Database, row: RouteRow): Promise<readonly ComputerAgentRouteEntry[]> {
  let values: EntryRow[];
  try {
    const result = await db.prepare("SELECT priority,connection_id,connection_revision " +
      "FROM project_computer_agent_route_entry WHERE project_id=?1 AND task_kind=?2 AND route_revision=?3 " +
      "ORDER BY priority")
      .bind(row.project_id, row.task_kind, row.revision).all<EntryRow>();
    values = result.results ?? [];
  } catch {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE", 503, "Route entry read is unavailable", true);
  }
  if (values.some((value, index) => value.priority !== index)) {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500, "Route priorities are corrupt");
  }
  return Object.freeze(values.map((value) => Object.freeze({
    connection_id: value.connection_id,
    connection_revision: value.connection_revision,
  })));
}
async function decodeRoute(db: D1Database, row: RouteRow): Promise<ProjectComputerAgentRoute> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500, "Route record is not valid JSON"); }
  const parsed = ProjectComputerAgentRouteSchema.safeParse(raw);
  const recordedEntries = await entries(db, row);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      canonicalJson(parsed.data.connections) !== canonicalJson(recordedEntries) ||
      parsed.data.project_id !== row.project_id || parsed.data.task_kind !== row.task_kind ||
      parsed.data.revision !== row.revision || parsed.data.owner_principal_ref !== row.owner_principal_ref ||
      parsed.data.state !== row.state || parsed.data.strategy !== row.strategy ||
      parsed.data.created_at !== row.created_at || parsed.data.updated_at !== row.updated_at) {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500, "Route record identity is corrupt");
  }
  return parsed.data;
}
async function currentRoute(db: D1Database, projectId: string,
  kind: ComputerAgentTaskKind): Promise<RouteRow | null> {
  try {
    return await db.prepare("SELECT * FROM project_computer_agent_route_current " +
      "WHERE project_id=?1 AND task_kind=?2 LIMIT 1").bind(projectId, kind).first<RouteRow>();
  } catch {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE", 503, "Route read is unavailable", true);
  }
}
async function routeReplay(db: D1Database, principal: string, idempotencyKey: string): Promise<RouteRow | null> {
  try {
    return await db.prepare("SELECT * FROM project_computer_agent_route " +
      "WHERE owner_principal_ref=?1 AND idempotency_key=?2 LIMIT 1")
      .bind(principal, idempotencyKey).first<RouteRow>();
  } catch {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE", 503, "Route replay read is unavailable", true);
  }
}
async function validateConnections(db: D1Database, principal: string,
  kind: ComputerAgentTaskKind, values: readonly ComputerAgentRouteEntry[]): Promise<void> {
  for (const value of values) {
    const [exact, current] = await Promise.all([
      readComputerAgentConnectionRevision(db, value.connection_id, value.connection_revision),
      readCurrentComputerAgentConnection(db, value.connection_id),
    ]);
    if (exact === null || current === null || exact.state !== "ENABLED" || current.state !== "ENABLED" ||
        exact.owner_principal_ref !== principal || current.owner_principal_ref !== principal ||
        current.revision !== value.connection_revision || !exact.task_kinds.includes(kind)) {
      fail("COMPUTER_AGENT_ROUTE_AUTHORITY_STALE", 409,
        "Every route entry must reference the owner's current enabled connection revision");
    }
  }
}

export function createProjectComputerAgentRouteService(options: {
  readonly database: D1Database;
  readonly now?: () => number;
}) {
  const db = options.database;
  const now = options.now ?? Date.now;

  async function get(context: AuthenticatedRequestContext, rawProject: string,
    rawKind: string): Promise<ProjectComputerAgentRoute> {
    await requireSchema(db);
    const principal = owner(context, now);
    const projectId = identifier(rawProject, "project_id");
    const kind = taskKind(rawKind);
    await requireProjectOwner(db, projectId, principal);
    const row = await currentRoute(db, projectId, kind);
    if (row === null) fail("COMPUTER_AGENT_ROUTE_NOT_FOUND", 404, "Project route does not exist");
    const route = await decodeRoute(db, row);
    if (route.owner_principal_ref !== principal) {
      fail("COMPUTER_AGENT_ROUTE_DENIED", 403, "Project route belongs to another owner");
    }
    owner(context, now);
    return route;
  }

  async function mutate(context: AuthenticatedRequestContext, rawProject: string, rawKind: string,
    rawInput: unknown, operation: "PUT" | "DELETE"): Promise<ProjectComputerAgentRoute> {
    await requireSchema(db);
    const principal = owner(context, now);
    const projectId = identifier(rawProject, "project_id");
    const kind = taskKind(rawKind);
    const idempotencyKey = key(context.request.headers.get("Idempotency-Key"));
    await requireProjectOwner(db, projectId, principal);
    const parsed = operation === "PUT"
      ? ProjectComputerAgentRoutePutSchema.safeParse(rawInput)
      : ProjectComputerAgentRouteDisableSchema.safeParse(rawInput);
    if (!parsed.success) {
      fail("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 400, "Route mutation contains unknown or invalid fields");
    }
    const normalized = operation === "PUT" ? ProjectComputerAgentRoutePutSchema.parse(parsed.data) : parsed.data;
    const requestDigest = await sha256Utf8(canonicalJson({
      protocol: "eliotr.project-computer-agent-route-mutation.v1",
      operation,
      project_id: projectId,
      task_kind: kind,
      owner_principal_ref: principal,
      input: normalized,
    }));
    const replay = await routeReplay(db, principal, idempotencyKey);
    if (replay !== null) {
      if (replay.request_sha256 !== requestDigest) {
        fail("COMPUTER_AGENT_ROUTE_REVISION_CONFLICT", 409,
          "Idempotency-Key is already bound to another route mutation");
      }
      owner(context, now);
      return decodeRoute(db, replay);
    }
    const previousRow = await currentRoute(db, projectId, kind);
    const previous = previousRow === null ? null : await decodeRoute(db, previousRow);
    const expected = parsed.data.expected_revision;
    if ((previous?.revision ?? 0) !== expected || (operation === "DELETE" && previous === null)) {
      fail("COMPUTER_AGENT_ROUTE_REVISION_CONFLICT", 409, "Route revision changed");
    }
    const timestamp = new Date(instant(now)).toISOString();
    let result: ProjectComputerAgentRoute;
    if (operation === "PUT") {
      const input = ProjectComputerAgentRoutePutSchema.parse(normalized);
      await validateConnections(db, principal, kind, input.connections);
      result = ProjectComputerAgentRouteSchema.parse({
        protocol: "eliotr.project-computer-agent-route.v1",
        project_id: projectId,
        task_kind: kind,
        revision: expected + 1,
        owner_principal_ref: principal,
        state: "ACTIVE",
        strategy: input.strategy,
        connections: input.connections,
        created_at: previous?.created_at ?? timestamp,
        updated_at: timestamp,
      });
    } else {
      if (previous === null) fail("COMPUTER_AGENT_ROUTE_NOT_FOUND", 404, "Project route does not exist");
      result = ProjectComputerAgentRouteSchema.parse({
        ...previous,
        revision: expected + 1,
        state: "DISABLED",
        updated_at: timestamp,
      });
    }
    const record = canonicalJson(result);
    const digest = await sha256Utf8(record);
    if (new TextEncoder().encode(record).byteLength > MAX_RECORD_BYTES) {
      fail("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 413, "Route exceeds its byte envelope");
    }
    owner(context, now);
    const statements = [
      db.prepare("INSERT INTO project_computer_agent_route(" +
        "project_id,task_kind,revision,owner_principal_ref,state,strategy,connection_order_json," +
        "idempotency_key,request_sha256,record_json,record_sha256,created_at,updated_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)")
        .bind(result.project_id, result.task_kind, result.revision, result.owner_principal_ref,
          result.state, result.strategy, canonicalJson(result.connections), idempotencyKey,
          requestDigest, record, digest, result.created_at, result.updated_at),
      ...result.connections.map((entry, priority) => db.prepare(
        "INSERT INTO project_computer_agent_route_entry(" +
        "project_id,task_kind,route_revision,priority,connection_id,connection_revision) " +
        "VALUES (?1,?2,?3,?4,?5,?6)")
        .bind(result.project_id, result.task_kind, result.revision, priority,
          entry.connection_id, entry.connection_revision)),
    ];
    try { await db.batch(statements); }
    catch { /* Exact immutable receipt readback reconciles lost acknowledgements and CAS conflicts. */ }
    const settled = await routeReplay(db, principal, idempotencyKey);
    if (settled !== null) {
      if (settled.request_sha256 !== requestDigest) {
        fail("COMPUTER_AGENT_ROUTE_REVISION_CONFLICT", 409,
          "Idempotency-Key settled another route mutation");
      }
      const decoded = await decodeRoute(db, settled);
      if (canonicalJson(decoded) !== record) {
        fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500,
          "Route receipt differs from the intended revision");
      }
      owner(context, now);
      return decoded;
    }
    const current = await currentRoute(db, projectId, kind);
    if ((current?.revision ?? 0) !== expected) {
      fail("COMPUTER_AGENT_ROUTE_REVISION_CONFLICT", 409, "Route changed before commit");
    }
    fail("COMPUTER_AGENT_ROUTE_SETTLEMENT_UNCERTAIN", 503,
      "No exact route receipt; retry with the same Idempotency-Key", true);
  }

  return {
    get,
    put: (context: AuthenticatedRequestContext, projectId: string, kind: string, input: unknown) =>
      mutate(context, projectId, kind, input, "PUT"),
    disable: (context: AuthenticatedRequestContext, projectId: string, kind: string, input: unknown) =>
      mutate(context, projectId, kind, input, "DELETE"),
  };
}

export async function readCurrentProjectComputerAgentRoute(
  database: D1Database,
  projectIdValue: string,
  taskKindValue: string,
): Promise<ProjectComputerAgentRoute | null> {
  await requireSchema(database);
  const projectId = identifier(projectIdValue, "project_id");
  const kind = taskKind(taskKindValue);
  const row = await currentRoute(database, projectId, kind);
  return row === null ? null : decodeRoute(database, row);
}

async function readBinding(db: D1Database, operationId: string): Promise<BindingRow | null> {
  try {
    return await db.prepare("SELECT * FROM research_computer_agent_route_binding_valid " +
      "WHERE operation_id=?1 LIMIT 1").bind(operationId).first<BindingRow>();
  } catch {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE", 503, "Run route binding read is unavailable", true);
  }
}
async function decodeBinding(row: BindingRow): Promise<ResearchComputerAgentRouteBinding> {
  let raw: unknown;
  try { raw = JSON.parse(row.binding_json); }
  catch { return fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500, "Run route binding is not valid JSON"); }
  const parsed = ResearchComputerAgentRouteBindingSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.binding_json ||
      await sha256Utf8(row.binding_json) !== row.binding_sha256 ||
      parsed.data.operation_id !== row.operation_id || parsed.data.project_id !== row.project_id ||
      parsed.data.task_kind !== row.task_kind || parsed.data.route_revision !== row.route_revision ||
      parsed.data.priority !== row.priority || parsed.data.connection_id !== row.connection_id ||
      parsed.data.connection_revision !== row.connection_revision ||
      parsed.data.client_grant_id !== row.client_grant_id ||
      parsed.data.client_grant_revision !== row.client_grant_revision ||
      parsed.data.actor.issuer !== row.actor_issuer || parsed.data.actor.subject !== row.actor_subject ||
      parsed.data.created_at !== row.created_at) {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500, "Run route binding identity is corrupt");
  }
  return parsed.data;
}

export async function bindComputerAgentRunRoute(input: {
  readonly database: D1Database;
  readonly context: AuthenticatedRequestContext;
  readonly grant: ProjectClientGrant;
  readonly operation_id: string;
  readonly task_kind: ComputerAgentTaskKind;
  readonly now?: () => number;
}): Promise<ResearchComputerAgentRouteBinding> {
  const now = input.now ?? Date.now;
  await requireSchema(input.database);
  const operationId = identifier(input.operation_id, "operation_id");
  const connection = await requireEnabledComputerAgentConnectionForTask(
    input.database, input.context, input.task_kind, now,
  );
  const grant = input.grant;
  if (grant.state !== "ACTIVE" || grant.grantee.authentication_method !== "service_token" ||
      grant.grantee.issuer !== connection.actor.issuer || grant.grantee.subject !== connection.actor.subject ||
      grant.grantee.subject !== input.context.principal_ref || !grant.allowed_operations.includes("run") ||
      Date.parse(grant.expires_at) <= instant(now)) {
    fail("COMPUTER_AGENT_ROUTE_DENIED", 403,
      "Run grant and computer-agent connection bind different or stale authority");
  }
  const routeRow = await currentRoute(input.database, grant.project_id, input.task_kind);
  if (routeRow === null) fail("COMPUTER_AGENT_ROUTE_NOT_FOUND", 403,
    "The project has no active computer-agent route");
  const route = await decodeRoute(input.database, routeRow);
  if (route.state !== "ACTIVE" || route.owner_principal_ref !== grant.grantor_principal_ref) {
    fail("COMPUTER_AGENT_ROUTE_AUTHORITY_STALE", 403, "Project computer-agent route is not active");
  }
  const priority = route.connections.findIndex((entry) =>
    entry.connection_id === connection.connection_id && entry.connection_revision === connection.revision);
  if (priority < 0) {
    fail("COMPUTER_AGENT_ROUTE_DENIED", 403,
      "The originating computer-agent connection is not present in the active project route");
  }
  const timestamp = new Date(instant(now)).toISOString();
  const binding = ResearchComputerAgentRouteBindingSchema.parse({
    protocol: "eliotr.research-computer-agent-route-binding.v1",
    operation_id: operationId,
    project_id: grant.project_id,
    task_kind: input.task_kind,
    route_revision: route.revision,
    priority,
    connection_id: connection.connection_id,
    connection_revision: connection.revision,
    client_grant_id: grant.grant_id,
    client_grant_revision: grant.revision,
    actor: connection.actor,
    created_at: timestamp,
  });
  const record = canonicalJson(binding);
  const digest = await sha256Utf8(record);
  try {
    await input.database.prepare("INSERT INTO research_computer_agent_route_binding(" +
      "operation_id,project_id,task_kind,route_revision,priority,connection_id,connection_revision," +
      "client_grant_id,client_grant_revision,actor_issuer,actor_subject,binding_json,binding_sha256,created_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) " +
      "ON CONFLICT(operation_id) DO NOTHING")
      .bind(binding.operation_id, binding.project_id, binding.task_kind, binding.route_revision,
        binding.priority, binding.connection_id, binding.connection_revision,
        binding.client_grant_id, binding.client_grant_revision, binding.actor.issuer,
        binding.actor.subject, record, digest, binding.created_at).run();
  } catch { /* Readback below distinguishes a lost acknowledgement from stale authority. */ }
  const row = await readBinding(input.database, operationId);
  if (row === null) {
    fail("COMPUTER_AGENT_ROUTE_AUTHORITY_STALE", 409,
      "Run route binding could not be committed under current authority");
  }
  const settled = await decodeBinding(row);
  if (canonicalJson(settled) !== record) {
    fail("COMPUTER_AGENT_ROUTE_IDENTITY_CONFLICT", 409,
      "Operation is already bound to another computer-agent route");
  }
  return settled;
}

export async function requireComputerAgentRunRouteBinding(
  database: D1Database,
  operationIdValue: string,
  grant: ProjectClientGrant,
): Promise<ResearchComputerAgentRouteBinding> {
  await requireSchema(database);
  const operationId = identifier(operationIdValue, "operation_id");
  const row = await readBinding(database, operationId);
  if (row === null) fail("COMPUTER_AGENT_ROUTE_AUTHORITY_STALE", 403,
    "Research run has no valid computer-agent route binding");
  const binding = await decodeBinding(row);
  if (binding.project_id !== grant.project_id || binding.client_grant_id !== grant.grant_id ||
      binding.client_grant_revision !== grant.revision || binding.actor.issuer !== grant.grantee.issuer ||
      binding.actor.subject !== grant.grantee.subject || grant.grantee.authentication_method !== "service_token") {
    fail("COMPUTER_AGENT_ROUTE_AUTHORITY_STALE", 403,
      "Research run route binding differs from its exact project grant");
  }
  return binding;
}
