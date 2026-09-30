from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).resolve().parents[2]


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(dedent(content).lstrip(), encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


def append_once(path: str, marker: str, content: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    if marker in text:
        return
    target.write_text(text.rstrip() + "\n\n" + dedent(content).strip() + "\n", encoding="utf-8")


write("packages/contracts/src/computer-agent-route.ts", r'''
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import {
  ComputerAgentActorSchema,
  ComputerAgentTaskKindSchema,
} from "./computer-agent-connection.js";

const id = IdentifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);

export const ComputerAgentRouteEntrySchema = z.object({
  connection_id: id,
  connection_revision: revision,
}).strict();
export type ComputerAgentRouteEntry = z.infer<typeof ComputerAgentRouteEntrySchema>;

const orderedConnections = z.array(ComputerAgentRouteEntrySchema).min(1).max(16)
  .superRefine((value, context) => {
    const ids = value.map((entry) => entry.connection_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Route connection IDs must be unique" });
    }
  });

export const ProjectComputerAgentRouteSchema = z.object({
  protocol: z.literal("eliotr.project-computer-agent-route.v1"),
  project_id: id,
  task_kind: ComputerAgentTaskKindSchema,
  revision,
  owner_principal_ref: id,
  state: z.enum(["ACTIVE", "DISABLED"]),
  strategy: z.literal("ORIGINATING_MATCH"),
  connections: orderedConnections,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict();
export type ProjectComputerAgentRoute = z.infer<typeof ProjectComputerAgentRouteSchema>;

export const ProjectComputerAgentRoutePutSchema = z.object({
  strategy: z.literal("ORIGINATING_MATCH"),
  connections: orderedConnections,
  expected_revision: z.number().int().min(0).max(2_147_483_646),
}).strict();
export const ProjectComputerAgentRouteDisableSchema = z.object({
  expected_revision: revision.max(2_147_483_646),
}).strict();

export const ResearchComputerAgentRouteBindingSchema = z.object({
  protocol: z.literal("eliotr.research-computer-agent-route-binding.v1"),
  operation_id: id,
  project_id: id,
  task_kind: ComputerAgentTaskKindSchema,
  route_revision: revision,
  priority: z.number().int().min(0).max(15),
  connection_id: id,
  connection_revision: revision,
  client_grant_id: id,
  client_grant_revision: revision,
  actor: ComputerAgentActorSchema,
  created_at: IsoDateTimeSchema,
}).strict();
export type ResearchComputerAgentRouteBinding = z.infer<typeof ResearchComputerAgentRouteBindingSchema>;
''')

write("infra/d1/core/migrations/0088_project_computer_agent_routes.sql", r'''
-- Owner-selected project routing for computer agents. ORIGINATING_MATCH records priority
-- without reassigning an existing grant, task or lease to another actor.
PRAGMA foreign_keys = ON;

CREATE TABLE project_computer_agent_route (
  project_id TEXT NOT NULL REFERENCES project(project_id),
  task_kind TEXT NOT NULL CHECK(task_kind='RESEARCH_BRANCH_ANALYSIS'),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','DISABLED')),
  strategy TEXT NOT NULL CHECK(strategy='ORIGINATING_MATCH'),
  connection_order_json TEXT NOT NULL CHECK(
    json_valid(connection_order_json) AND json_type(connection_order_json)='array'
    AND json_array_length(connection_order_json) BETWEEN 1 AND 16
  ),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 24576),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
  PRIMARY KEY(project_id,task_kind,revision),
  UNIQUE(owner_principal_ref,idempotency_key),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.project-computer-agent-route.v1'),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.task_kind') IS task_kind),
  CHECK(json_extract(record_json,'$.revision') IS revision),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.state') IS state),
  CHECK(json_extract(record_json,'$.strategy') IS strategy),
  CHECK(json_extract(record_json,'$.connections') IS json(connection_order_json)),
  CHECK(json_extract(record_json,'$.created_at') IS created_at),
  CHECK(json_extract(record_json,'$.updated_at') IS updated_at),
  CHECK(julianday(updated_at)>=julianday(created_at))
) STRICT;

CREATE TABLE project_computer_agent_route_entry (
  project_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  route_revision INTEGER NOT NULL,
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 15),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  PRIMARY KEY(project_id,task_kind,route_revision,priority),
  UNIQUE(project_id,task_kind,route_revision,connection_id),
  UNIQUE(project_id,task_kind,route_revision,priority,connection_id,connection_revision),
  FOREIGN KEY(project_id,task_kind,route_revision)
    REFERENCES project_computer_agent_route(project_id,task_kind,revision),
  FOREIGN KEY(connection_id,connection_revision)
    REFERENCES computer_agent_connection(connection_id,revision)
) STRICT;

CREATE INDEX project_computer_agent_route_owner_idx
  ON project_computer_agent_route(owner_principal_ref,project_id,task_kind,revision DESC);
CREATE INDEX project_computer_agent_route_connection_idx
  ON project_computer_agent_route_entry(connection_id,connection_revision,project_id,task_kind);

CREATE VIEW project_computer_agent_route_current AS
SELECT r.* FROM project_computer_agent_route r
WHERE NOT EXISTS (
  SELECT 1 FROM project_computer_agent_route n
  WHERE n.project_id=r.project_id AND n.task_kind=r.task_kind AND n.revision>r.revision
)
AND (SELECT COUNT(*) FROM project_computer_agent_route_entry e
  WHERE e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision)
  =json_array_length(r.connection_order_json)
AND NOT EXISTS (
  SELECT 1 FROM project_computer_agent_route_entry e
  WHERE e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision
    AND (json_extract(r.connection_order_json,'$['||e.priority||'].connection_id') IS NOT e.connection_id
      OR json_extract(r.connection_order_json,'$['||e.priority||'].connection_revision') IS NOT e.connection_revision)
);

CREATE TRIGGER project_computer_agent_route_insert_guard
BEFORE INSERT ON project_computer_agent_route
BEGIN
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_REVISION_CONFLICT')
  WHERE NEW.revision<>COALESCE((SELECT MAX(revision) FROM project_computer_agent_route
    WHERE project_id=NEW.project_id AND task_kind=NEW.task_kind),0)+1;
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_OWNER_REQUIRED') WHERE NOT EXISTS (
    SELECT 1 FROM project_owner o
    WHERE o.project_id=NEW.project_id AND o.principal_ref=NEW.owner_principal_ref
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM project_computer_agent_route r
    WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind
      AND (r.owner_principal_ref IS NOT NEW.owner_principal_ref OR r.created_at IS NOT NEW.created_at)
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_INITIAL_STATE_INVALID')
  WHERE NEW.revision=1 AND NEW.state<>'ACTIVE';
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_TIME_INVALID') WHERE EXISTS (
    SELECT 1 FROM project_computer_agent_route r
    WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind AND r.revision=NEW.revision-1
      AND julianday(r.updated_at)>julianday(NEW.updated_at)
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_CONNECTION_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.connection_order_json) e
    WHERE json_type(e.value)<>'object'
      OR json_type(e.value,'$.connection_id')<>'text'
      OR json_type(e.value,'$.connection_revision')<>'integer'
      OR length(json_extract(e.value,'$.connection_id')) NOT BETWEEN 1 AND 256
      OR json_extract(e.value,'$.connection_revision') NOT BETWEEN 1 AND 2147483647
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_CONNECTION_INVALID') WHERE
    (SELECT COUNT(DISTINCT json_extract(value,'$.connection_id')) FROM json_each(NEW.connection_order_json))
      <>json_array_length(NEW.connection_order_json);
END;

CREATE TRIGGER project_computer_agent_route_entry_guard
BEFORE INSERT ON project_computer_agent_route_entry
WHEN NOT EXISTS (
  SELECT 1 FROM project_computer_agent_route r
  JOIN computer_agent_connection c
    ON c.connection_id=NEW.connection_id AND c.revision=NEW.connection_revision
  WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind AND r.revision=NEW.route_revision
    AND c.owner_principal_ref=r.owner_principal_ref AND c.state='ENABLED'
    AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value=NEW.task_kind)
    AND json_extract(r.connection_order_json,'$['||NEW.priority||'].connection_id')=NEW.connection_id
    AND json_extract(r.connection_order_json,'$['||NEW.priority||'].connection_revision')=NEW.connection_revision
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_CONNECTION_STALE'); END;

CREATE TRIGGER project_computer_agent_route_no_update
BEFORE UPDATE ON project_computer_agent_route
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER project_computer_agent_route_no_delete
BEFORE DELETE ON project_computer_agent_route
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER project_computer_agent_route_entry_no_update
BEFORE UPDATE ON project_computer_agent_route_entry
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER project_computer_agent_route_entry_no_delete
BEFORE DELETE ON project_computer_agent_route_entry
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IMMUTABLE'); END;

CREATE TABLE research_computer_agent_route_binding (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  route_revision INTEGER NOT NULL,
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 15),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  client_grant_id TEXT NOT NULL,
  client_grant_revision INTEGER NOT NULL,
  actor_issuer TEXT NOT NULL CHECK(length(actor_issuer) BETWEEN 1 AND 256),
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 256),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB)) BETWEEN 1 AND 24576),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  FOREIGN KEY(project_id,task_kind,route_revision,priority,connection_id,connection_revision)
    REFERENCES project_computer_agent_route_entry(project_id,task_kind,route_revision,priority,connection_id,connection_revision),
  FOREIGN KEY(client_grant_id,client_grant_revision)
    REFERENCES project_client_grant(grant_id,revision),
  CHECK(json_extract(binding_json,'$.protocol') IS 'eliotr.research-computer-agent-route-binding.v1'),
  CHECK(json_extract(binding_json,'$.operation_id') IS operation_id),
  CHECK(json_extract(binding_json,'$.project_id') IS project_id),
  CHECK(json_extract(binding_json,'$.task_kind') IS task_kind),
  CHECK(json_extract(binding_json,'$.route_revision') IS route_revision),
  CHECK(json_extract(binding_json,'$.priority') IS priority),
  CHECK(json_extract(binding_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(binding_json,'$.connection_revision') IS connection_revision),
  CHECK(json_extract(binding_json,'$.client_grant_id') IS client_grant_id),
  CHECK(json_extract(binding_json,'$.client_grant_revision') IS client_grant_revision),
  CHECK(json_extract(binding_json,'$.actor.issuer') IS actor_issuer),
  CHECK(json_extract(binding_json,'$.actor.authentication_method') IS 'service_token'),
  CHECK(json_extract(binding_json,'$.actor.subject') IS actor_subject),
  CHECK(json_extract(binding_json,'$.created_at') IS created_at)
) STRICT;

CREATE TRIGGER research_computer_agent_route_binding_guard
BEFORE INSERT ON research_computer_agent_route_binding
WHEN NOT EXISTS (
  SELECT 1 FROM project_computer_agent_route_current r
  JOIN project_computer_agent_route_entry e
    ON e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision
    AND e.priority=NEW.priority AND e.connection_id=NEW.connection_id
    AND e.connection_revision=NEW.connection_revision
  JOIN computer_agent_connection_current c
    ON c.connection_id=e.connection_id AND c.revision=e.connection_revision AND c.state='ENABLED'
  JOIN project_client_grant_current g
    ON g.grant_id=NEW.client_grant_id AND g.revision=NEW.client_grant_revision AND g.state='ACTIVE'
  JOIN project_owner o ON o.project_id=r.project_id AND o.principal_ref=r.owner_principal_ref
  WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind AND r.revision=NEW.route_revision
    AND r.state='ACTIVE' AND r.strategy='ORIGINATING_MATCH'
    AND c.owner_principal_ref=r.owner_principal_ref
    AND g.project_id=r.project_id AND g.grantor_principal_ref=r.owner_principal_ref
    AND g.grantee_issuer=NEW.actor_issuer AND g.grantee_subject=NEW.actor_subject
    AND g.grantee_method='service_token'
    AND c.actor_issuer=NEW.actor_issuer AND c.actor_subject=NEW.actor_subject
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_AUTHORITY_STALE'); END;

CREATE TRIGGER research_computer_agent_route_binding_no_update
BEFORE UPDATE ON research_computer_agent_route_binding
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_BINDING_IMMUTABLE'); END;
CREATE TRIGGER research_computer_agent_route_binding_no_delete
BEFORE DELETE ON research_computer_agent_route_binding
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_BINDING_IMMUTABLE'); END;

CREATE VIEW research_computer_agent_route_binding_valid AS
SELECT b.* FROM research_computer_agent_route_binding b
JOIN project_computer_agent_route r
  ON r.project_id=b.project_id AND r.task_kind=b.task_kind AND r.revision=b.route_revision
JOIN project_computer_agent_route_entry e
  ON e.project_id=b.project_id AND e.task_kind=b.task_kind AND e.route_revision=b.route_revision
  AND e.priority=b.priority AND e.connection_id=b.connection_id AND e.connection_revision=b.connection_revision
JOIN computer_agent_connection c
  ON c.connection_id=b.connection_id AND c.revision=b.connection_revision
JOIN project_client_grant g
  ON g.grant_id=b.client_grant_id AND g.revision=b.client_grant_revision
JOIN project_owner o ON o.project_id=b.project_id AND o.principal_ref=r.owner_principal_ref
WHERE r.state='ACTIVE' AND r.strategy='ORIGINATING_MATCH' AND c.state='ENABLED'
  AND c.owner_principal_ref=r.owner_principal_ref
  AND c.actor_issuer=b.actor_issuer AND c.actor_subject=b.actor_subject
  AND g.state='ACTIVE' AND g.project_id=b.project_id AND g.grantor_principal_ref=r.owner_principal_ref
  AND g.grantee_method='service_token' AND g.grantee_issuer=b.actor_issuer AND g.grantee_subject=b.actor_subject;

INSERT INTO schema_state(key,value,updated_at)
VALUES('project_computer_agent_route_generation','project-computer-agent-route-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
''')

write("apps/eliotr-core/src/computer-agent-route-store.ts", r'''
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
''')

write("apps/eliotr-core/src/computer-agent-route-http.ts", r'''
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentRouteError,
  createProjectComputerAgentRouteService,
} from "./computer-agent-route-store.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";

function requireMutationOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) ||
      (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("COMPUTER_AGENT_ROUTE_CSRF_DENIED", 403,
      "Route mutation requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 415,
      "Route mutations require application/json");
  }
}
function map(error: unknown): never {
  if (error instanceof ComputerAgentRouteError) {
    throw new HttpRequestError(error.code, error.status,
      "Computer-agent project route request could not be completed", error.retryable);
  }
  throw error;
}

export async function handleComputerAgentRouteHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const service = createProjectComputerAgentRouteService({ database: env.CORE_DB });
  const projectId = params.project_id ?? "";
  const taskKind = params.task_kind ?? "";
  const url = new URL(request.url);
  try {
    requireNoQuery(url);
    if (request.method === "GET") {
      return apiResult(request, env, await service.get(context, projectId, taskKind));
    }
    requireMutationOrigin(request, url);
    const input: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
    const result = request.method === "PUT"
      ? await service.put(context, projectId, taskKind, input)
      : await service.disable(context, projectId, taskKind, input);
    return apiResult(request, env, result);
  } catch (error) {
    map(error);
  }
}
''')

replace_once(
    "packages/contracts/src/computer-agent-connection.ts",
    "const actor = z.object({\n",
    "export const ComputerAgentActorSchema = z.object({\n",
)
replace_once(
    "packages/contracts/src/computer-agent-connection.ts",
    "  actor,\n",
    "  actor: ComputerAgentActorSchema,\n",
)
replace_once(
    "packages/contracts/src/index.ts",
    'export * from "./computer-agent-connection.js";\n',
    'export * from "./computer-agent-connection.js";\nexport * from "./computer-agent-route.js";\n',
)

replace_once(
    "apps/eliotr-core/src/computer-agent-connection-store.ts",
    r'''export async function requireComputerAgentConnectionForTask(
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
}''',
    r'''export async function readComputerAgentConnectionRevision(
  database: D1Database,
  connectionIdValue: string,
  revision: number,
): Promise<ComputerAgentConnection | null> {
  await requireSchema(database);
  const connectionId = identifier(connectionIdValue, "connection_id");
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) {
    fail("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 400, "connection_revision is invalid");
  }
  let row: ConnectionRow | null;
  try {
    row = await database.prepare("SELECT * FROM computer_agent_connection " +
      "WHERE connection_id=?1 AND revision=?2 LIMIT 1").bind(connectionId, revision).first<ConnectionRow>();
  } catch {
    fail("COMPUTER_AGENT_CONNECTION_STORAGE_UNAVAILABLE", 503, "Connection revision read is unavailable", true);
  }
  return row === null ? null : decode(row);
}

export async function readCurrentComputerAgentConnection(
  database: D1Database,
  connectionIdValue: string,
): Promise<ComputerAgentConnection | null> {
  await requireSchema(database);
  const connectionId = identifier(connectionIdValue, "connection_id");
  const row = await currentById(database, connectionId);
  return row === null ? null : decode(row);
}

export async function requireEnabledComputerAgentConnectionForTask(
  database: D1Database,
  context: AuthenticatedRequestContext,
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
  if (connection.state !== "ENABLED" || !connection.task_kinds.includes(taskKind)) {
    fail("COMPUTER_AGENT_CONNECTION_DENIED", 403,
      "The computer-agent connection is disabled or lacks the required task capability");
  }
  return connection;
}

export async function requireComputerAgentConnectionForTask(
  database: D1Database,
  context: AuthenticatedRequestContext,
  transport: ComputerAgentTransportCapability,
  taskKind: ComputerAgentTaskKind,
  now: () => number = Date.now,
): Promise<ComputerAgentConnection> {
  const connection = await requireEnabledComputerAgentConnectionForTask(database, context, taskKind, now);
  if (!connection.transport_capabilities.includes(transport)) {
    fail("COMPUTER_AGENT_CONNECTION_DENIED", 403,
      "The computer-agent connection lacks the required transport capability");
  }
  return connection;
}''',
)

replace_once(
    "packages/interfaces/src/routes.ts",
    '  { method: "DELETE", path: "/api/v1/research/projects/:project_id/client-grants/:grant_id", operation: "research.client-grants.revoke", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n',
    '  { method: "DELETE", path: "/api/v1/research/projects/:project_id/client-grants/:grant_id", operation: "research.client-grants.revoke", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n'
    '  { method: "GET", path: "/api/v1/research/projects/:project_id/computer-agent-routes/:task_kind", operation: "research.computer-agent-routes.read", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },\n'
    '  { method: "PUT", path: "/api/v1/research/projects/:project_id/computer-agent-routes/:task_kind", operation: "research.computer-agent-routes.put", auth: "owner", maximum_request_bytes: 24576, response_mode: "json" },\n'
    '  { method: "DELETE", path: "/api/v1/research/projects/:project_id/computer-agent-routes/:task_kind", operation: "research.computer-agent-routes.disable", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n',
)

replace_once(
    "apps/eliotr-core/src/http-special-routes.ts",
    'import { handleComputerAgentConnectionHttp } from "./computer-agent-connection-http.js";\n',
    'import { handleComputerAgentConnectionHttp } from "./computer-agent-connection-http.js";\n'
    'import { handleComputerAgentRouteHttp } from "./computer-agent-route-http.js";\n',
)
replace_once(
    "apps/eliotr-core/src/http-special-routes.ts",
    '    case "research.client-grants.list":\n',
    '    case "research.computer-agent-routes.read":\n'
    '    case "research.computer-agent-routes.put":\n'
    '    case "research.computer-agent-routes.disable":\n'
    '      return handleComputerAgentRouteHttp(input.request, input.env, input.context,\n'
    '        input.match.params, input.match.route.maximum_request_bytes);\n'
    '    case "research.client-grants.list":\n',
)

replace_once(
    "apps/eliotr-core/src/research-session.ts",
    'import { prepareClientResearchAdmission, requireClientResearchExecution } from "./research-client-execution.js";\n',
    'import { prepareClientResearchAdmission, requireClientResearchExecution } from "./research-client-execution.js";\n'
    'import {\n  bindComputerAgentRunRoute,\n  ComputerAgentRouteError,\n} from "./computer-agent-route-store.js";\n',
)
replace_once(
    "apps/eliotr-core/src/research-session.ts",
    'function mapRetrievalError(error: unknown): never {\n',
    'function mapComputerAgentRouteError(error: unknown): never {\n'
    '  if (!(error instanceof ComputerAgentRouteError)) throw error;\n'
    '  if (error.retryable) {\n'
    '    fail("RESEARCH_SETTLEMENT_UNCERTAIN",\n'
    '      "Computer-agent project route is temporarily unavailable", 503, true);\n'
    '  }\n'
    '  if (error.status === 403 || error.status === 404) {\n'
    '    fail("RESEARCH_AUTHORITY_STALE", "Computer-agent project route is not current", 403);\n'
    '  }\n'
    '  fail("RESEARCH_CONFLICT", "Computer-agent project route conflicts with this run", 409);\n'
    '}\n'
    'function mapRetrievalError(error: unknown): never {\n',
)
replace_once(
    "apps/eliotr-core/src/research-session.ts",
    '      const wantHead = { investigation_id, goal: request.query, scope_snapshot_id: scopeRef.id, scope_snapshot_revision: scopeRef.revision, evidence_grade: request.evidence_grade, lane, portfolio_ref: payloadKey, principal_ref: context.principal_ref, input_digest: payloadHash, policy_generation: policyGeneration, policy_authority_ref: snapshotRow.policy_authority_ref, deployment_generation: env.DEPLOYMENT_GENERATION, idempotency_key: key };\n',
    '      if (handlerGeneration === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION && delegated !== undefined) {\n'
    '        await bindComputerAgentRunRoute({\n'
    '          database: db,\n'
    '          context,\n'
    '          grant: delegated.lease.grant,\n'
    '          operation_id,\n'
    '          task_kind: "RESEARCH_BRANCH_ANALYSIS",\n'
    '        }).catch(mapComputerAgentRouteError);\n'
    '      }\n'
    '      const wantHead = { investigation_id, goal: request.query, scope_snapshot_id: scopeRef.id, scope_snapshot_revision: scopeRef.revision, evidence_grade: request.evidence_grade, lane, portfolio_ref: payloadKey, principal_ref: context.principal_ref, input_digest: payloadHash, policy_generation: policyGeneration, policy_authority_ref: snapshotRow.policy_authority_ref, deployment_generation: env.DEPLOYMENT_GENERATION, idempotency_key: key };\n',
)

replace_once(
    "apps/eliotr-core/src/research-external-agent-routing.ts",
    'import type { Env } from "./env.js";\n',
    'import type { Env } from "./env.js";\n'
    'import {\n  ComputerAgentRouteError,\n  requireComputerAgentRunRouteBinding,\n} from "./computer-agent-route-store.js";\n',
)
replace_once(
    "apps/eliotr-core/src/research-external-agent-routing.ts",
    '      resolver,\n      grant,\n',
    '      resolver,\n      grant,\n'
    '      require_route_binding: async (operationId, exactGrant) => {\n'
    '        try {\n'
    '          await requireComputerAgentRunRouteBinding(input.env.CORE_DB, operationId, exactGrant);\n'
    '        } catch (error) {\n'
    '          if (error instanceof ComputerAgentRouteError && error.retryable) {\n'
    '            fail("WORKFLOW_EFFECT_UNCERTAIN");\n'
    '          }\n'
    '          fail("WORKFLOW_AUTHORITY_STALE");\n'
    '        }\n'
    '      },\n',
)

replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    '  readonly grant: ProjectClientGrant;\n  readonly now?: () => number;\n',
    '  readonly grant: ProjectClientGrant;\n'
    '  readonly require_route_binding: (operationId: string, grant: ProjectClientGrant) => Promise<void>;\n'
    '  readonly now?: () => number;\n',
)
replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    '      !grant.allowed_operations.includes("evidence")) stale();\n  const context = await loadContext(dependencies, request, principal);\n',
    '      !grant.allowed_operations.includes("evidence")) stale();\n'
    '  await dependencies.require_route_binding(request.operation_id, grant);\n'
    '  const context = await loadContext(dependencies, request, principal);\n',
)

append_once("docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    "## 5. Project route policy and immutable run binding",
    r'''
## 5. Project route policy and immutable run binding

Migration 0088 adds one owner-controlled append-only route per project/task kind. The current strategy,
`ORIGINATING_MATCH`, stores an ordered list of exact enabled connection revisions. A delegated explicit-
protocol run is admitted only when the verified initiating actor's current connection appears in that
route. Admission records the exact route revision, priority, connection revision and project-grant revision
under the run operation ID. Stage 8 must read the immutable binding before task publication or callback
consumption.

Ordering is now authoritative owner state but does not yet authorize silent delegation. The system does
not start another actor, race two agents for one task, or transfer a lease. Updating or disabling a route
affects new runs; an existing run keeps its recorded route identity, while current connection and project-
grant checks can still block new task access. Automatic preferred-agent dispatch and failover require a
separate owner-delegation protocol.
''')
append_once("docs/adr/0008-computer-agent-web-inbox.md",
    "## Project route binding",
    r'''
## Project route binding

An enabled `WEB_INBOX` connection is necessary but not sufficient for a delegated v8 run. The project
owner must also publish an active `RESEARCH_BRANCH_ANALYSIS` route containing that exact current
connection revision. The run records the chosen route/connection/grant revisions before Workflow start,
and Stage 8 verifies that immutable origin before exposing a task. Priority order is not browser-supplied
and does not permit the inbox to claim another connection's run.
''')
append_once("docs/implementation/computer-agent-web-inbox.md",
    "## Configure the project route",
    r'''
## Configure the project route

For each project, PUT the owner-only route at
`/api/v1/research/projects/<project_id>/computer-agent-routes/RESEARCH_BRANCH_ANALYSIS`. Use strategy
`ORIGINATING_MATCH` and order exact current `{connection_id, connection_revision}` records by preference.
A service actor may start a delegated explicit-protocol run only when its own current connection appears
in the active route; its priority and exact revisions are frozen into the run. Updating the list does not
move existing tasks or leases. DELETE appends a disabled revision and blocks new delegated runs.
''')
append_once("docs/implementation/muse-operator-runbook.md",
    "## Bind connections to a project route",
    r'''
## Bind connections to a project route

After registering Spark, Muse or Dot, the project owner publishes an ordered
`RESEARCH_BRANCH_ANALYSIS` route containing the exact current connection revisions. The initial strategy
is `ORIGINATING_MATCH`: the agent that starts the delegated run must itself appear in the route. The
recorded priority is preparation for later owner-directed routing; it does not let a lower- or higher-
priority agent inherit another actor's grant, task or lease. Update the route after changing a connection
revision, and use a new Idempotency-Key for each distinct route revision.
''')
