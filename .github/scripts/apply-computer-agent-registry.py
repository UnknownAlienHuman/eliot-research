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


write("packages/contracts/src/computer-agent-connection.ts", r'''
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";

const id = IdentifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);
const actor = z.object({
  issuer: z.string().max(256).regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u),
  authentication_method: z.literal("service_token"),
  subject: z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u),
}).strict();

export const ComputerAgentContourSchema = z.enum([
  "GEMINI_SPARK", "META_MUSE", "OPENAI_DOT", "OTHER",
]);
export const ComputerAgentTransportCapabilitySchema = z.enum([
  "MCP_READ", "MCP_WRITE", "WEB_INBOX",
]);
export const ComputerAgentComputerCapabilitySchema = z.enum([
  "CLOUD_BROWSER", "CLOUD_DESKTOP", "CLOUD_NETWORK", "LOCAL_COMPUTER",
  "LOCAL_FILES", "LOCAL_SHELL", "PYTHON_VM", "CONNECTED_APPS",
  "SCHEDULED_WORK", "PROACTIVE_WORK", "MESSAGING", "SCREENSHOTS",
]);
export const ComputerAgentTaskKindSchema = z.enum(["RESEARCH_BRANCH_ANALYSIS"]);

const transports = z.array(ComputerAgentTransportCapabilitySchema).min(1).max(8)
  .refine((value) => new Set(value).size === value.length, "Transport capabilities must be unique");
const computers = z.array(ComputerAgentComputerCapabilitySchema).max(16)
  .refine((value) => new Set(value).size === value.length, "Computer capabilities must be unique");
const taskKinds = z.array(ComputerAgentTaskKindSchema).min(1).max(8)
  .refine((value) => new Set(value).size === value.length, "Task kinds must be unique");

const mutable = {
  display_name: z.string().min(1).max(128),
  contour: ComputerAgentContourSchema,
  actor,
  transport_capabilities: transports,
  computer_capabilities: computers,
  task_kinds: taskKinds,
};

export const ComputerAgentConnectionSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-connection.v1"),
  connection_id: id,
  revision,
  owner_principal_ref: id,
  state: z.enum(["ENABLED", "DISABLED"]),
  ...mutable,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict();
export type ComputerAgentConnection = z.infer<typeof ComputerAgentConnectionSchema>;
export type ComputerAgentTransportCapability = z.infer<typeof ComputerAgentTransportCapabilitySchema>;
export type ComputerAgentTaskKind = z.infer<typeof ComputerAgentTaskKindSchema>;

export const ComputerAgentConnectionPutSchema = z.object({
  ...mutable,
  expected_revision: z.number().int().min(0).max(2_147_483_646),
}).strict().refine(
  (value) => value.transport_capabilities.includes("MCP_WRITE") ||
    value.transport_capabilities.includes("WEB_INBOX"),
  { path: ["transport_capabilities"], message: "A task connection requires MCP_WRITE or WEB_INBOX" },
);
export type ComputerAgentConnectionPut = z.infer<typeof ComputerAgentConnectionPutSchema>;

export const ComputerAgentConnectionDisableSchema = z.object({
  expected_revision: revision.max(2_147_483_646),
}).strict();

export const ComputerAgentConnectionListSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-connections.v1"),
  connections: z.array(ComputerAgentConnectionSchema).max(20),
  next_connection_id: id.optional(),
}).strict();
export type ComputerAgentConnectionList = z.infer<typeof ComputerAgentConnectionListSchema>;
''')

write("infra/d1/core/migrations/0087_computer_agent_connections.sql", r'''
-- Owner-controlled, append-only computer-agent connection registry.
-- Vendor contour is metadata. Exact Access issuer/subject is the stable actor identity.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_connection (
  connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  actor_issuer TEXT NOT NULL CHECK(length(actor_issuer) BETWEEN 1 AND 256),
  actor_method TEXT NOT NULL CHECK(actor_method='service_token'),
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('ENABLED','DISABLED')),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 128),
  contour TEXT NOT NULL CHECK(contour IN ('GEMINI_SPARK','META_MUSE','OPENAI_DOT','OTHER')),
  transport_capabilities_json TEXT NOT NULL CHECK(
    json_valid(transport_capabilities_json) AND json_type(transport_capabilities_json)='array'
    AND json_array_length(transport_capabilities_json) BETWEEN 1 AND 8
  ),
  computer_capabilities_json TEXT NOT NULL CHECK(
    json_valid(computer_capabilities_json) AND json_type(computer_capabilities_json)='array'
    AND json_array_length(computer_capabilities_json) BETWEEN 0 AND 16
  ),
  task_kinds_json TEXT NOT NULL CHECK(
    json_valid(task_kinds_json) AND json_type(task_kinds_json)='array'
    AND json_array_length(task_kinds_json) BETWEEN 1 AND 8
  ),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 24576),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
  PRIMARY KEY(connection_id,revision),
  UNIQUE(owner_principal_ref,idempotency_key),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-connection.v1'),
  CHECK(json_extract(record_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(record_json,'$.revision') IS revision),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.actor.issuer') IS actor_issuer),
  CHECK(json_extract(record_json,'$.actor.authentication_method') IS actor_method),
  CHECK(json_extract(record_json,'$.actor.subject') IS actor_subject),
  CHECK(json_extract(record_json,'$.state') IS state),
  CHECK(json_extract(record_json,'$.display_name') IS display_name),
  CHECK(json_extract(record_json,'$.contour') IS contour),
  CHECK(json_extract(record_json,'$.transport_capabilities') IS json(transport_capabilities_json)),
  CHECK(json_extract(record_json,'$.computer_capabilities') IS json(computer_capabilities_json)),
  CHECK(json_extract(record_json,'$.task_kinds') IS json(task_kinds_json)),
  CHECK(json_extract(record_json,'$.created_at') IS created_at),
  CHECK(json_extract(record_json,'$.updated_at') IS updated_at),
  CHECK(julianday(updated_at)>=julianday(created_at))
) STRICT;

CREATE INDEX computer_agent_connection_owner_idx
  ON computer_agent_connection(owner_principal_ref,connection_id,revision DESC);
CREATE INDEX computer_agent_connection_actor_idx
  ON computer_agent_connection(actor_issuer,actor_subject,revision DESC);
CREATE VIEW computer_agent_connection_current AS
SELECT c.* FROM computer_agent_connection c
WHERE NOT EXISTS (
  SELECT 1 FROM computer_agent_connection n
  WHERE n.connection_id=c.connection_id AND n.revision>c.revision
);

CREATE TRIGGER computer_agent_connection_insert_guard
BEFORE INSERT ON computer_agent_connection
BEGIN
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_REVISION_CONFLICT')
  WHERE NEW.revision<>COALESCE((SELECT MAX(revision) FROM computer_agent_connection
    WHERE connection_id=NEW.connection_id),0)+1;
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM computer_agent_connection c WHERE c.connection_id=NEW.connection_id AND (
      c.owner_principal_ref IS NOT NEW.owner_principal_ref OR c.actor_issuer IS NOT NEW.actor_issuer
      OR c.actor_method IS NOT NEW.actor_method OR c.actor_subject IS NOT NEW.actor_subject
      OR c.created_at IS NOT NEW.created_at
    )
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM computer_agent_connection c
    WHERE c.actor_issuer=NEW.actor_issuer AND c.actor_subject=NEW.actor_subject
      AND c.connection_id<>NEW.connection_id
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_INITIAL_STATE_INVALID')
  WHERE NEW.revision=1 AND NEW.state<>'ENABLED';
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TIME_INVALID') WHERE EXISTS (
    SELECT 1 FROM computer_agent_connection c
    WHERE c.connection_id=NEW.connection_id AND c.revision=NEW.revision-1
      AND julianday(c.updated_at)>julianday(NEW.updated_at)
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TRANSPORT_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.transport_capabilities_json)
    WHERE type<>'text' OR value NOT IN ('MCP_READ','MCP_WRITE','WEB_INBOX')
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TRANSPORT_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.transport_capabilities_json))
      <>json_array_length(NEW.transport_capabilities_json);
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_CAPABILITY_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.computer_capabilities_json)
    WHERE type<>'text' OR value NOT IN (
      'CLOUD_BROWSER','CLOUD_DESKTOP','CLOUD_NETWORK','LOCAL_COMPUTER','LOCAL_FILES','LOCAL_SHELL',
      'PYTHON_VM','CONNECTED_APPS','SCHEDULED_WORK','PROACTIVE_WORK','MESSAGING','SCREENSHOTS'
    )
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_CAPABILITY_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.computer_capabilities_json))
      <>json_array_length(NEW.computer_capabilities_json);
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TASK_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.task_kinds_json)
    WHERE type<>'text' OR value<>'RESEARCH_BRANCH_ANALYSIS'
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TASK_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.task_kinds_json))
      <>json_array_length(NEW.task_kinds_json);
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_WRITE_TRANSPORT_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1 FROM json_each(NEW.transport_capabilities_json)
    WHERE value IN ('MCP_WRITE','WEB_INBOX')
  );
END;

CREATE TRIGGER computer_agent_connection_no_update
BEFORE UPDATE ON computer_agent_connection
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_connection_no_delete
BEFORE DELETE ON computer_agent_connection
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_connection_generation','computer-agent-connection-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
''')

write("apps/eliotr-core/src/computer-agent-connection-store.ts", r'''
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
''')

write("apps/eliotr-core/src/computer-agent-connection-http.ts", r'''
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentConnectionError,
  createComputerAgentConnectionService,
} from "./computer-agent-connection-store.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";

function trustedIssuers(env: Env): readonly string[] {
  return [env.ACCESS_TEAM_DOMAIN, env.MCP_ACCESS_TEAM_DOMAIN]
    .filter((value): value is string => value !== undefined)
    .map((value) => {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port ||
            url.pathname !== "/" || url.search || url.hash ||
            !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u.test(url.hostname)) {
          throw new Error();
        }
        return url.origin;
      } catch {
        throw new HttpRequestError("COMPUTER_AGENT_CONNECTION_CONFIG_INVALID", 503,
          "Configured Access issuer is invalid", true);
      }
    });
}
function map(error: unknown): never {
  if (error instanceof ComputerAgentConnectionError) {
    throw new HttpRequestError(error.code, error.status,
      "Computer-agent connection request could not be completed", error.retryable);
  }
  throw error;
}
function requireMutationOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) ||
      (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("COMPUTER_AGENT_CONNECTION_CSRF_DENIED", 403,
      "Connection mutation requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 415,
      "Connection mutations require application/json");
  }
}

export async function handleComputerAgentConnectionHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const service = createComputerAgentConnectionService({
    database: env.CORE_DB,
    trusted_issuers: trustedIssuers(env),
  });
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      if ([...url.searchParams.keys()].some((key) => key !== "after_connection_id") ||
          url.searchParams.getAll("after_connection_id").length > 1) {
        throw new HttpRequestError("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 400,
          "Unsupported or duplicate connection-list query parameter");
      }
      return apiResult(request, env,
        await service.list(context, url.searchParams.get("after_connection_id") ?? ""));
    }
    requireNoQuery(url);
    requireMutationOrigin(request, url);
    const input: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
    const id = params.connection_id ?? "";
    const result = request.method === "PUT"
      ? await service.put(context, id, input)
      : await service.disable(context, id, input);
    return apiResult(request, env, result);
  } catch (error) {
    map(error);
  }
}
''')

replace_once(
    "packages/contracts/src/index.ts",
    'export * from "./project-client-grant.js";\n',
    'export * from "./project-client-grant.js";\nexport * from "./computer-agent-connection.js";\n',
)

replace_once(
    "packages/interfaces/src/routes.ts",
    '  { method: "GET", path: "/api/v1/system/research-configuration", operation: "system.research.configuration", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },\n',
    '  { method: "GET", path: "/api/v1/system/research-configuration", operation: "system.research.configuration", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },\n'
    '  { method: "GET", path: "/api/v1/system/computer-agents", operation: "system.computer-agents.list", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },\n'
    '  { method: "PUT", path: "/api/v1/system/computer-agents/:connection_id", operation: "system.computer-agents.put", auth: "owner", maximum_request_bytes: 24576, response_mode: "json" },\n'
    '  { method: "DELETE", path: "/api/v1/system/computer-agents/:connection_id", operation: "system.computer-agents.disable", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n',
)
for operation in ("pull", "progress", "result", "status"):
    replace_once(
        "packages/interfaces/src/routes.ts",
        f'operation: "research.agent-task.{operation}", auth: "owner_or_service"',
        f'operation: "research.agent-task.{operation}", auth: "service"',
    )

replace_once(
    "apps/eliotr-core/src/http-special-routes.ts",
    'import {\n  handleAgentTaskHttp,\n  isAgentTaskHttpOperation,\n} from "./agent-task-http.js";\n',
    'import {\n  handleAgentTaskHttp,\n  isAgentTaskHttpOperation,\n} from "./agent-task-http.js";\n'
    'import { handleComputerAgentConnectionHttp } from "./computer-agent-connection-http.js";\n',
)
replace_once(
    "apps/eliotr-core/src/http-special-routes.ts",
    '  switch (input.match.route.operation) {\n    case "research.client-grants.list":\n',
    '  switch (input.match.route.operation) {\n'
    '    case "system.computer-agents.list":\n'
    '    case "system.computer-agents.put":\n'
    '    case "system.computer-agents.disable":\n'
    '      return handleComputerAgentConnectionHttp(input.request, input.env, input.context,\n'
    '        input.match.params, input.match.route.maximum_request_bytes);\n'
    '    case "research.client-grants.list":\n',
)

replace_once(
    "apps/eliotr-core/src/mcp-external-agent-task.ts",
    'import type { Env } from "./env.js";\n',
    'import type { Env } from "./env.js";\n'
    'import {\n  ComputerAgentConnectionError,\n  requireComputerAgentConnectionForTask,\n} from "./computer-agent-connection-store.js";\n'
    'import type { ComputerAgentTransportCapability } from "@eliotr/contracts";\n',
)
replace_once(
    "apps/eliotr-core/src/mcp-external-agent-task.ts",
    '  input: Record<string, unknown>,\n): Promise<unknown> {\n  const store = new ExternalAgentTaskStore(env.CORE_DB);\n',
    '  input: Record<string, unknown>,\n'
    '  transport: ComputerAgentTransportCapability,\n'
    '): Promise<unknown> {\n'
    '  try {\n'
    '    const connection = await requireComputerAgentConnectionForTask(\n'
    '      env.CORE_DB, context, transport, "RESEARCH_BRANCH_ANALYSIS",\n'
    '    );\n'
    '    if (connection.actor.issuer !== grant.grantee.issuer ||\n'
    '        connection.actor.subject !== grant.grantee.subject) {\n'
    '      throw new ExternalAgentTaskError("EXTERNAL_AGENT_TASK_DENIED", 403,\n'
    '        "Computer-agent connection and project grant bind different actors");\n'
    '    }\n'
    '  } catch (error) {\n'
    '    if (error instanceof ExternalAgentTaskError) throw error;\n'
    '    if (error instanceof ComputerAgentConnectionError) {\n'
    '      const code = error.code === "COMPUTER_AGENT_CONNECTION_SCHEMA_NOT_READY"\n'
    '        ? "EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY"\n'
    '        : error.code === "COMPUTER_AGENT_CONNECTION_STORAGE_CORRUPT"\n'
    '          ? "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT"\n'
    '          : error.retryable\n'
    '            ? "EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN"\n'
    '            : "EXTERNAL_AGENT_TASK_DENIED";\n'
    '      throw new ExternalAgentTaskError(code, error.status,\n'
    '        "Computer-agent connection is not authorized for this task transport", error.retryable);\n'
    '    }\n'
    '    throw error;\n'
    '  }\n'
    '  const store = new ExternalAgentTaskStore(env.CORE_DB);\n',
)

replace_once(
    "apps/eliotr-core/src/agent-task-http.ts",
    '    TOOL_BY_OPERATION[operation],\n    body,\n  );\n',
    '    TOOL_BY_OPERATION[operation],\n    body,\n    "WEB_INBOX",\n  );\n',
)
replace_once(
    "apps/eliotr-core/src/mcp-research-service.ts",
    '            const result = await callExternalAgentTaskTool(env, context, grant.grant, name, args);\n',
    '            const result = await callExternalAgentTaskTool(\n'
    '              env, context, grant.grant, name, args, "MCP_WRITE",\n'
    '            );\n',
)

append_once("docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    "## 4. Computer-agent connection registry",
    r'''
## 4. Computer-agent connection registry

Migration 0087 and the owner-only `/api/v1/system/computer-agents` contour now register each logical
computer agent as append-only revisions bound to one exact Cloudflare Access service-token issuer and
subject. `GEMINI_SPARK`, `META_MUSE`, `OPENAI_DOT` and `OTHER` remain owner-maintained metadata;
a caller is authorized by its verified Access actor, current project grant and declared transport/task
capabilities. Task MCP requires `MCP_WRITE`; the browser inbox requires `WEB_INBOX`. Disabled or missing
connections fail before task lease authority is reached.

This registry is the substrate for routing, not routing itself. V8 tasks still target the originating
exact grant/actor. Project-level preferred-agent policy, cross-agent assignment, capability-based failover
and parallel independent task publication remain pending and must not reuse or transfer an existing lease.
''')
append_once("docs/adr/0008-computer-agent-web-inbox.md",
    "## Connection registry requirement",
    r'''
## Connection registry requirement

The service-token actor must also have an owner-enabled current computer-agent connection revision with
`WEB_INBOX` and `RESEARCH_BRANCH_ANALYSIS`. The registry stores no Client Secret. It binds transport and
computer capabilities to the exact Access issuer/subject and prevents a self-reported contour selector
from becoming authority. Disabling the connection blocks new inbox task operations without deleting task,
lease, callback or project-grant history.
''')
append_once("docs/implementation/computer-agent-web-inbox.md",
    "## Register the browser contour",
    r'''
## Register the browser contour

Before using the inbox, the owner creates `/api/v1/system/computer-agents/<connection_id>` with a stable
Idempotency-Key and an exact service-token actor. Include `WEB_INBOX` and task kind
`RESEARCH_BRANCH_ANALYSIS`; list cloud/local/browser capabilities honestly. Updating capabilities appends
a revision. DELETE appends `DISABLED` and does not revoke the Cloudflare token or project grant by itself.
Those remain separate reconciled authorities.
''')
append_once("docs/implementation/muse-operator-runbook.md",
    "## Register each computer-agent connection",
    r'''
## Register each computer-agent connection

Register Spark, Muse and Dot separately through the owner-only computer-agent connection API. Bind each
logical connection to its exact Access issuer and Client ID, then declare only observed transport and
computer capabilities. MCP task callbacks require `MCP_WRITE`; the browser inbox requires `WEB_INBOX`.
The contour label is descriptive only. The same actor still needs an exact current project grant with
`run`, `recover` and `evidence`. Disabling a registry entry blocks task access but does not silently revoke
Access credentials or rewrite historical grants and leases.
''')
