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


write("packages/contracts/src/computer-agent-qualification.ts", r'''
import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, OpaqueTokenSchema } from "./common.js";

const id = IdentifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);

export const ComputerAgentQualificationTransportSchema = z.enum(["MCP_WRITE", "WEB_INBOX"]);
export type ComputerAgentQualificationTransport = z.infer<typeof ComputerAgentQualificationTransportSchema>;

export const ComputerAgentQualificationBindingSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-qualification-binding.v1"),
  challenge_id: id,
  connection_id: id,
  connection_revision: revision,
  transport: ComputerAgentQualificationTransportSchema,
  owner_principal_ref: id,
  owner_credential_generation: id,
  deployment_generation: id,
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  created_at: IsoDateTimeSchema,
}).strict().refine((value) => Date.parse(value.expires_at) > Date.parse(value.issued_at), {
  path: ["expires_at"], message: "Qualification challenge expiry must follow issuance",
});
export type ComputerAgentQualificationBinding = z.infer<typeof ComputerAgentQualificationBindingSchema>;

export const ComputerAgentQualificationIssueInputSchema = z.object({}).strict();

export const ComputerAgentQualificationChallengeSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-qualification-challenge.v1"),
  status: z.literal("ISSUED"),
  connection_id: id,
  connection_revision: revision,
  transport: ComputerAgentQualificationTransportSchema,
  challenge_id: id,
  challenge_token: OpaqueTokenSchema,
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  deployment_generation: id,
  auth_profile: z.literal("service-token"),
}).strict();
export type ComputerAgentQualificationChallenge = z.infer<typeof ComputerAgentQualificationChallengeSchema>;

export const ComputerAgentQualificationStatusValueSchema = z.enum([
  "ISSUED", "READY", "EXPIRED", "ACTOR_MISMATCH", "STALE",
]);
export type ComputerAgentQualificationStatusValue = z.infer<typeof ComputerAgentQualificationStatusValueSchema>;

export const ComputerAgentQualificationStatusSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-qualification-status.v1"),
  status: ComputerAgentQualificationStatusValueSchema,
  connection_id: id,
  connection_revision: revision,
  transport: ComputerAgentQualificationTransportSchema,
  challenge_id: id,
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  deployment_generation: id,
  observation_ref: id.optional(),
  observed_at: IsoDateTimeSchema.optional(),
  ready_until: IsoDateTimeSchema.optional(),
  verified_credential_generation: id.optional(),
}).strict().superRefine((value, context) => {
  const confirmation = value.observation_ref !== undefined || value.observed_at !== undefined ||
    value.ready_until !== undefined || value.verified_credential_generation !== undefined;
  if (value.status === "READY" && (
    value.observation_ref === undefined || value.observed_at === undefined ||
    value.ready_until === undefined || value.verified_credential_generation === undefined
  )) {
    context.addIssue({ code: "custom", message: "READY qualification requires complete observation fields" });
  }
  if (value.status === "ISSUED" && confirmation) {
    context.addIssue({ code: "custom", message: "ISSUED qualification cannot carry confirmation fields" });
  }
});
export type ComputerAgentQualificationStatus = z.infer<typeof ComputerAgentQualificationStatusSchema>;

export const ComputerAgentQualificationConfirmationSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-qualification-confirmed.v1"),
  status: z.literal("READY"),
  connection_id: id,
  connection_revision: revision,
  transport: ComputerAgentQualificationTransportSchema,
  challenge_id: id,
  observation_ref: id,
  observed_at: IsoDateTimeSchema,
  ready_until: IsoDateTimeSchema,
  deployment_generation: id,
}).strict();
export type ComputerAgentQualificationConfirmation = z.infer<typeof ComputerAgentQualificationConfirmationSchema>;
''')

write("infra/d1/core/migrations/0089_computer_agent_qualification.sql", r'''
-- Exact connection/transport qualification reuses the immutable one-shot MCP diagnostic challenge.
-- The bearer challenge token remains absent from this table and from every status receipt.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_connection_qualification_binding (
  challenge_id TEXT PRIMARY KEY REFERENCES mcp_client_diagnostic_challenge(challenge_id),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL CHECK(connection_revision BETWEEN 1 AND 2147483647),
  transport TEXT NOT NULL CHECK(transport IN ('MCP_WRITE','WEB_INBOX')),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  owner_credential_generation TEXT NOT NULL CHECK(length(owner_credential_generation) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  issued_at TEXT NOT NULL CHECK(julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK(julianday(expires_at) IS NOT NULL),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB)) BETWEEN 1 AND 24576),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  FOREIGN KEY(connection_id,connection_revision)
    REFERENCES computer_agent_connection(connection_id,revision),
  CHECK(json_extract(binding_json,'$.protocol') IS 'eliotr.computer-agent-qualification-binding.v1'),
  CHECK(json_extract(binding_json,'$.challenge_id') IS challenge_id),
  CHECK(json_extract(binding_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(binding_json,'$.connection_revision') IS connection_revision),
  CHECK(json_extract(binding_json,'$.transport') IS transport),
  CHECK(json_extract(binding_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(binding_json,'$.owner_credential_generation') IS owner_credential_generation),
  CHECK(json_extract(binding_json,'$.deployment_generation') IS deployment_generation),
  CHECK(json_extract(binding_json,'$.issued_at') IS issued_at),
  CHECK(json_extract(binding_json,'$.expires_at') IS expires_at),
  CHECK(json_extract(binding_json,'$.created_at') IS created_at),
  CHECK(created_at IS issued_at),
  CHECK(julianday(expires_at)>julianday(issued_at))
) STRICT;

CREATE INDEX computer_agent_connection_qualification_latest_idx
  ON computer_agent_connection_qualification_binding(
    owner_principal_ref,connection_id,connection_revision,transport,issued_at DESC,challenge_id DESC
  );

CREATE VIEW computer_agent_connection_qualification_observation AS
SELECT b.*,
  d.state AS challenge_state,
  d.auth_profile,
  d.observation_ref,
  d.observed_at,
  d.trace_id,
  d.verified_actor_ref,
  d.verified_credential_generation,
  d.verified_authentication_method,
  d.verified_expires_at,
  c.owner_principal_ref AS connection_owner_principal_ref,
  c.state AS connection_state,
  c.actor_issuer,
  c.actor_subject,
  c.transport_capabilities_json,
  c.task_kinds_json,
  cc.revision AS current_connection_revision,
  cc.state AS current_connection_state
FROM computer_agent_connection_qualification_binding b
JOIN mcp_client_diagnostic_challenge d ON d.challenge_id=b.challenge_id
JOIN computer_agent_connection c
  ON c.connection_id=b.connection_id AND c.revision=b.connection_revision
LEFT JOIN computer_agent_connection_current cc ON cc.connection_id=b.connection_id;

CREATE TRIGGER computer_agent_connection_qualification_insert_guard
BEFORE INSERT ON computer_agent_connection_qualification_binding
WHEN NOT EXISTS (
  SELECT 1 FROM mcp_client_diagnostic_challenge d
  JOIN computer_agent_connection_current c
    ON c.connection_id=NEW.connection_id AND c.revision=NEW.connection_revision
  WHERE d.challenge_id=NEW.challenge_id AND d.state='ISSUED'
    AND d.owner_principal_ref=NEW.owner_principal_ref
    AND d.owner_credential_generation=NEW.owner_credential_generation
    AND d.deployment_generation=NEW.deployment_generation
    AND d.auth_profile='service-token'
    AND d.issued_at=NEW.issued_at AND d.expires_at=NEW.expires_at
    AND c.owner_principal_ref=NEW.owner_principal_ref AND c.state='ENABLED'
    AND EXISTS (SELECT 1 FROM json_each(c.transport_capabilities_json) WHERE value=NEW.transport)
    AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value='RESEARCH_BRANCH_ANALYSIS')
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_QUALIFICATION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_connection_qualification_no_update
BEFORE UPDATE ON computer_agent_connection_qualification_binding
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_QUALIFICATION_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_connection_qualification_no_delete
BEFORE DELETE ON computer_agent_connection_qualification_binding
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_QUALIFICATION_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_qualification_generation','computer-agent-qualification-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
''')

write("apps/eliotr-core/src/computer-agent-qualification-store.ts", r'''
import {
  ComputerAgentQualificationBindingSchema,
  ComputerAgentQualificationChallengeSchema,
  ComputerAgentQualificationConfirmationSchema,
  ComputerAgentQualificationStatusSchema,
  ComputerAgentQualificationTransportSchema,
  McpDiagnosticConsumeInputSchema,
  type ComputerAgentConnection,
  type ComputerAgentQualificationBinding,
  type ComputerAgentQualificationChallenge,
  type ComputerAgentQualificationConfirmation,
  type ComputerAgentQualificationStatus,
  type ComputerAgentQualificationTransport,
  type ComputerAgentTaskKind,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  createD1McpClientDiagnosticService,
  McpClientDiagnosticServiceError,
  type McpToolCallContext,
} from "@eliotr/cloudflare-workspace-mcp";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  ComputerAgentConnectionError,
  readCurrentComputerAgentConnection,
} from "./computer-agent-connection-store.js";

const SCHEMA_GENERATION = "computer-agent-qualification-v1";
const FRESHNESS_MS = 24 * 60 * 60 * 1000;

export type ComputerAgentQualificationErrorCode =
  | "COMPUTER_AGENT_QUALIFICATION_SCHEMA_NOT_READY"
  | "COMPUTER_AGENT_QUALIFICATION_OWNER_REQUIRED"
  | "COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID"
  | "COMPUTER_AGENT_QUALIFICATION_NOT_FOUND"
  | "COMPUTER_AGENT_QUALIFICATION_DENIED"
  | "COMPUTER_AGENT_QUALIFICATION_STALE"
  | "COMPUTER_AGENT_QUALIFICATION_EXPIRED"
  | "COMPUTER_AGENT_QUALIFICATION_ACTOR_MISMATCH"
  | "COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT"
  | "COMPUTER_AGENT_QUALIFICATION_STORAGE_UNAVAILABLE"
  | "COMPUTER_AGENT_QUALIFICATION_SETTLEMENT_UNCERTAIN";

export class ComputerAgentQualificationError extends Error {
  readonly code: ComputerAgentQualificationErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: ComputerAgentQualificationErrorCode, status: number, message: string, retryable = false) {
    super(message);
    this.name = "ComputerAgentQualificationError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
function fail(code: ComputerAgentQualificationErrorCode, status: number,
  message: string, retryable = false): never {
  throw new ComputerAgentQualificationError(code, status, message, retryable);
}
function nowValue(now: () => number): number {
  let value: number;
  try { value = now(); }
  catch { return fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_UNAVAILABLE", 503,
    "Qualification clock is unavailable", true); }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_UNAVAILABLE", 503,
      "Qualification clock is invalid", true);
  }
  return value;
}
function owner(context: AuthenticatedRequestContext, now: () => number) {
  const observed = nowValue(now);
  if (context.client_class !== "owner_pwa" || context.request.signal.aborted) {
    fail("COMPUTER_AGENT_QUALIFICATION_OWNER_REQUIRED", 403, "A current owner request is required");
  }
  if (context.access && (context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= observed)) {
    fail("COMPUTER_AGENT_QUALIFICATION_OWNER_REQUIRED", 403, "Owner session is no longer current");
  }
  return Object.freeze({ principal_ref: context.principal_ref,
    credential_generation: context.credential_generation });
}
function serviceIdentity(context: AuthenticatedRequestContext, now: () => number) {
  const observed = nowValue(now);
  const access = context.access;
  if ((context.client_class !== "trusted_agent" && context.client_class !== "named_api_client") ||
      access === undefined || access.authentication_method !== "service_token" ||
      typeof access.issuer !== "string" || access.principal_ref !== context.principal_ref ||
      access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(access.expires_at)) || Date.parse(access.expires_at) <= observed ||
      context.request.signal.aborted) {
    fail("COMPUTER_AGENT_QUALIFICATION_DENIED", 403,
      "A current verified service-token actor is required");
  }
  return Object.freeze({ issuer: access.issuer, subject: context.principal_ref,
    credential_generation: context.credential_generation, expires_at: access.expires_at,
    trace_id: context.trace_id });
}
function transport(value: unknown): ComputerAgentQualificationTransport {
  const parsed = ComputerAgentQualificationTransportSchema.safeParse(value);
  if (!parsed.success) {
    fail("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 400, "Qualification transport is invalid");
  }
  return parsed.data;
}
async function requireSchema(db: D1Database): Promise<void> {
  let value: string | null;
  try {
    value = await db.prepare("SELECT value FROM schema_state WHERE key='computer_agent_qualification_generation'")
      .first<string>("value");
  } catch {
    fail("COMPUTER_AGENT_QUALIFICATION_SCHEMA_NOT_READY", 503,
      "Computer-agent qualification migration 0089 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_QUALIFICATION_SCHEMA_NOT_READY", 503,
      "Computer-agent qualification migration 0089 is required", true);
  }
}
function mapConnection(error: unknown): never {
  if (error instanceof ComputerAgentQualificationError) throw error;
  if (error instanceof ComputerAgentConnectionError) {
    fail(error.retryable ? "COMPUTER_AGENT_QUALIFICATION_STORAGE_UNAVAILABLE" :
      "COMPUTER_AGENT_QUALIFICATION_DENIED", error.retryable ? 503 : 403,
    "Computer-agent connection is unavailable for qualification", error.retryable);
  }
  throw error;
}
function requireConnectionCapability(connection: ComputerAgentConnection,
  ownerPrincipal: string, selectedTransport: ComputerAgentQualificationTransport): void {
  if (connection.owner_principal_ref !== ownerPrincipal || connection.state !== "ENABLED" ||
      !connection.transport_capabilities.includes(selectedTransport) ||
      !connection.task_kinds.includes("RESEARCH_BRANCH_ANALYSIS")) {
    fail("COMPUTER_AGENT_QUALIFICATION_DENIED", 403,
      "Connection is disabled, belongs to another owner, or lacks the selected capability");
  }
}

interface QualificationRow {
  challenge_id: string;
  connection_id: string;
  connection_revision: number;
  transport: string;
  owner_principal_ref: string;
  owner_credential_generation: string;
  deployment_generation: string;
  issued_at: string;
  expires_at: string;
  binding_json: string;
  binding_sha256: string;
  created_at: string;
  challenge_state: string;
  auth_profile: string;
  observation_ref: string | null;
  observed_at: string | null;
  trace_id: string | null;
  verified_actor_ref: string | null;
  verified_credential_generation: string | null;
  verified_authentication_method: string | null;
  verified_expires_at: string | null;
  connection_owner_principal_ref: string;
  connection_state: string;
  actor_issuer: string;
  actor_subject: string;
  transport_capabilities_json: string;
  task_kinds_json: string;
  current_connection_revision: number | null;
  current_connection_state: string | null;
}
const SELECT_OBSERVATION = "SELECT * FROM computer_agent_connection_qualification_observation ";
async function byChallenge(db: D1Database, challengeId: string): Promise<QualificationRow | null> {
  try {
    return await db.prepare(`${SELECT_OBSERVATION}WHERE challenge_id=?1 LIMIT 1`)
      .bind(challengeId).first<QualificationRow>();
  } catch {
    fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_UNAVAILABLE", 503,
      "Qualification observation read is unavailable", true);
  }
}
async function latest(db: D1Database, connectionId: string, revision: number,
  selectedTransport: ComputerAgentQualificationTransport): Promise<QualificationRow | null> {
  try {
    return await db.prepare(`${SELECT_OBSERVATION}WHERE connection_id=?1 AND connection_revision=?2 ` +
      "AND transport=?3 ORDER BY issued_at DESC,challenge_id DESC LIMIT 1")
      .bind(connectionId, revision, selectedTransport).first<QualificationRow>();
  } catch {
    fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_UNAVAILABLE", 503,
      "Qualification status read is unavailable", true);
  }
}
function parseJsonArray(value: string, label: string): readonly string[] {
  let decoded: unknown;
  try { decoded = JSON.parse(value); }
  catch { return fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT", 500, `${label} is corrupt`); }
  if (!Array.isArray(decoded) || decoded.some((item) => typeof item !== "string")) {
    fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT", 500, `${label} is corrupt`);
  }
  return decoded;
}
async function bindingFromRow(row: QualificationRow): Promise<ComputerAgentQualificationBinding> {
  let raw: unknown;
  try { raw = JSON.parse(row.binding_json); }
  catch { return fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT", 500,
    "Qualification binding is not valid JSON"); }
  const parsed = ComputerAgentQualificationBindingSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.binding_json ||
      await sha256Utf8(row.binding_json) !== row.binding_sha256 ||
      parsed.data.challenge_id !== row.challenge_id || parsed.data.connection_id !== row.connection_id ||
      parsed.data.connection_revision !== row.connection_revision || parsed.data.transport !== row.transport ||
      parsed.data.owner_principal_ref !== row.owner_principal_ref ||
      parsed.data.owner_credential_generation !== row.owner_credential_generation ||
      parsed.data.deployment_generation !== row.deployment_generation ||
      parsed.data.issued_at !== row.issued_at || parsed.data.expires_at !== row.expires_at ||
      parsed.data.created_at !== row.created_at) {
    fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT", 500,
      "Qualification binding identity is corrupt");
  }
  return parsed.data;
}
async function statusFromRow(row: QualificationRow, now: number): Promise<ComputerAgentQualificationStatus> {
  const binding = await bindingFromRow(row);
  const transports = parseJsonArray(row.transport_capabilities_json, "Connection transports");
  const taskKinds = parseJsonArray(row.task_kinds_json, "Connection task kinds");
  const stale = row.connection_owner_principal_ref !== binding.owner_principal_ref ||
    row.connection_state !== "ENABLED" || row.current_connection_state !== "ENABLED" ||
    row.current_connection_revision !== binding.connection_revision ||
    !transports.includes(binding.transport) || !taskKinds.includes("RESEARCH_BRANCH_ANALYSIS") ||
    row.auth_profile !== "service-token" || row.deployment_generation !== binding.deployment_generation;
  const base = {
    protocol: "eliotr.computer-agent-qualification-status.v1" as const,
    connection_id: binding.connection_id,
    connection_revision: binding.connection_revision,
    transport: binding.transport,
    challenge_id: binding.challenge_id,
    issued_at: binding.issued_at,
    expires_at: binding.expires_at,
    deployment_generation: binding.deployment_generation,
  };
  if (stale) return ComputerAgentQualificationStatusSchema.parse({ ...base, status: "STALE" });
  if (row.challenge_state === "ISSUED") {
    return ComputerAgentQualificationStatusSchema.parse({ ...base,
      status: now >= Date.parse(binding.expires_at) ? "EXPIRED" : "ISSUED" });
  }
  if (row.challenge_state !== "CONFIRMED" || row.observation_ref === null || row.observed_at === null ||
      row.trace_id === null || row.verified_actor_ref === null ||
      row.verified_credential_generation === null || row.verified_authentication_method === null ||
      row.verified_expires_at === null || !Number.isFinite(Date.parse(row.observed_at)) ||
      !Number.isFinite(Date.parse(row.verified_expires_at))) {
    fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT", 500,
      "Qualification confirmation is corrupt");
  }
  const readyUntilMs = Math.min(Date.parse(row.observed_at) + FRESHNESS_MS,
    Date.parse(row.verified_expires_at));
  const confirmed = {
    observation_ref: row.observation_ref,
    observed_at: row.observed_at,
    ready_until: new Date(readyUntilMs).toISOString(),
    verified_credential_generation: row.verified_credential_generation,
  };
  if (row.verified_authentication_method !== "service_token" ||
      row.verified_actor_ref !== row.actor_subject) {
    return ComputerAgentQualificationStatusSchema.parse({ ...base, ...confirmed,
      status: "ACTOR_MISMATCH" });
  }
  return ComputerAgentQualificationStatusSchema.parse({ ...base, ...confirmed,
    status: now < readyUntilMs ? "READY" : "EXPIRED" });
}

export function createComputerAgentQualificationService(options: {
  readonly database: D1Database;
  readonly deployment_generation: string;
  readonly mcp_auth_profile?: string | undefined;
  readonly now?: () => number;
}) {
  const db = options.database;
  const now = options.now ?? Date.now;

  async function issue(context: AuthenticatedRequestContext, connectionId: string,
    transportValue: unknown): Promise<ComputerAgentQualificationChallenge> {
    await requireSchema(db);
    const ownerIdentity = owner(context, now);
    const selectedTransport = transport(transportValue);
    if (selectedTransport === "MCP_WRITE" && options.mcp_auth_profile !== "service-token") {
      fail("COMPUTER_AGENT_QUALIFICATION_DENIED", 409,
        "MCP_WRITE qualification requires the service-token MCP profile");
    }
    const connection = await readCurrentComputerAgentConnection(db, connectionId).catch(mapConnection);
    if (connection === null) fail("COMPUTER_AGENT_QUALIFICATION_NOT_FOUND", 404,
      "Computer-agent connection does not exist");
    requireConnectionCapability(connection, ownerIdentity.principal_ref, selectedTransport);
    const diagnostic = createD1McpClientDiagnosticService(db, {
      now, auth_profile: "service-token", deployment_generation: options.deployment_generation,
    });
    let challenge;
    try { challenge = await diagnostic.issue(ownerIdentity); }
    catch (error) {
      if (error instanceof McpClientDiagnosticServiceError) {
        fail(error.retryable ? "COMPUTER_AGENT_QUALIFICATION_STORAGE_UNAVAILABLE" :
          "COMPUTER_AGENT_QUALIFICATION_DENIED", error.status,
        "Qualification challenge could not be issued", error.retryable);
      }
      throw error;
    }
    const binding = ComputerAgentQualificationBindingSchema.parse({
      protocol: "eliotr.computer-agent-qualification-binding.v1",
      challenge_id: challenge.challenge_id,
      connection_id: connection.connection_id,
      connection_revision: connection.revision,
      transport: selectedTransport,
      owner_principal_ref: ownerIdentity.principal_ref,
      owner_credential_generation: ownerIdentity.credential_generation,
      deployment_generation: options.deployment_generation,
      issued_at: challenge.issued_at,
      expires_at: challenge.expires_at,
      created_at: challenge.issued_at,
    });
    const bindingJson = canonicalJson(binding);
    const bindingSha = await sha256Utf8(bindingJson);
    let mutationError: unknown;
    try {
      await db.prepare("INSERT INTO computer_agent_connection_qualification_binding(" +
        "challenge_id,connection_id,connection_revision,transport,owner_principal_ref," +
        "owner_credential_generation,deployment_generation,issued_at,expires_at,binding_json," +
        "binding_sha256,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)")
        .bind(binding.challenge_id, binding.connection_id, binding.connection_revision,
          binding.transport, binding.owner_principal_ref, binding.owner_credential_generation,
          binding.deployment_generation, binding.issued_at, binding.expires_at,
          bindingJson, bindingSha, binding.created_at).run();
    } catch (error) { mutationError = error; }
    const row = await byChallenge(db, challenge.challenge_id);
    if (row === null) {
      fail("COMPUTER_AGENT_QUALIFICATION_SETTLEMENT_UNCERTAIN", 503,
        mutationError === undefined ? "Qualification binding was not recorded" :
          "Qualification binding acknowledgement is uncertain", true);
    }
    const recorded = await bindingFromRow(row);
    if (canonicalJson(recorded) !== bindingJson) {
      fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT", 500,
        "Qualification binding readback differs from issuance");
    }
    owner(context, now);
    return ComputerAgentQualificationChallengeSchema.parse({
      protocol: "eliotr.computer-agent-qualification-challenge.v1",
      status: "ISSUED",
      connection_id: binding.connection_id,
      connection_revision: binding.connection_revision,
      transport: binding.transport,
      challenge_id: challenge.challenge_id,
      challenge_token: challenge.challenge_token,
      issued_at: challenge.issued_at,
      expires_at: challenge.expires_at,
      deployment_generation: challenge.deployment_generation,
      auth_profile: "service-token",
    });
  }

  async function latestStatus(context: AuthenticatedRequestContext, connectionId: string,
    transportValue: unknown): Promise<ComputerAgentQualificationStatus> {
    await requireSchema(db);
    const ownerIdentity = owner(context, now);
    const selectedTransport = transport(transportValue);
    const connection = await readCurrentComputerAgentConnection(db, connectionId).catch(mapConnection);
    if (connection === null) fail("COMPUTER_AGENT_QUALIFICATION_NOT_FOUND", 404,
      "Computer-agent connection does not exist");
    requireConnectionCapability(connection, ownerIdentity.principal_ref, selectedTransport);
    const row = await latest(db, connection.connection_id, connection.revision, selectedTransport);
    if (row === null) fail("COMPUTER_AGENT_QUALIFICATION_NOT_FOUND", 404,
      "No qualification challenge exists for this connection revision and transport");
    const result = await statusFromRow(row, nowValue(now));
    owner(context, now);
    return result;
  }

  return { issue, latestStatus };
}

export async function preflightComputerAgentQualificationChallenge(input: {
  readonly database: D1Database;
  readonly challenge_id: string;
  readonly transport: ComputerAgentQualificationTransport;
  readonly issuer: string | undefined;
  readonly subject: string;
  readonly deployment_generation: string;
  readonly now?: () => number;
}): Promise<boolean> {
  const now = input.now ?? Date.now;
  await requireSchema(input.database);
  const row = await byChallenge(input.database, input.challenge_id);
  if (row === null) return false;
  const status = await statusFromRow(row, nowValue(now));
  if (status.transport !== input.transport || status.deployment_generation !== input.deployment_generation ||
      input.issuer === undefined || input.issuer !== row.actor_issuer || input.subject !== row.actor_subject) {
    fail("COMPUTER_AGENT_QUALIFICATION_ACTOR_MISMATCH", 403,
      "Qualification challenge is bound to another actor, transport or deployment");
  }
  if (status.status === "EXPIRED") fail("COMPUTER_AGENT_QUALIFICATION_EXPIRED", 409,
    "Qualification challenge has expired");
  if (status.status !== "ISSUED") fail("COMPUTER_AGENT_QUALIFICATION_STALE", 409,
    "Qualification challenge is no longer issuable");
  return true;
}

export async function requireComputerAgentQualificationChallengeReady(input: {
  readonly database: D1Database;
  readonly challenge_id: string;
  readonly transport: ComputerAgentQualificationTransport;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly now?: () => number;
}): Promise<ComputerAgentQualificationStatus> {
  const now = input.now ?? Date.now;
  await requireSchema(input.database);
  const row = await byChallenge(input.database, input.challenge_id);
  if (row === null) fail("COMPUTER_AGENT_QUALIFICATION_NOT_FOUND", 404,
    "Qualification challenge is not bound to a connection");
  const status = await statusFromRow(row, nowValue(now));
  if (status.status !== "READY" || status.transport !== input.transport ||
      status.deployment_generation !== input.deployment_generation ||
      status.verified_credential_generation !== input.credential_generation) {
    fail(status.status === "EXPIRED" ? "COMPUTER_AGENT_QUALIFICATION_EXPIRED" :
      status.status === "ACTOR_MISMATCH" ? "COMPUTER_AGENT_QUALIFICATION_ACTOR_MISMATCH" :
        "COMPUTER_AGENT_QUALIFICATION_STALE", 409,
    "Computer-agent qualification is not current for this credential generation");
  }
  return status;
}

export async function requireCurrentComputerAgentQualification(input: {
  readonly database: D1Database;
  readonly context: AuthenticatedRequestContext;
  readonly connection: ComputerAgentConnection;
  readonly transport: ComputerAgentQualificationTransport;
  readonly task_kind: ComputerAgentTaskKind;
  readonly deployment_generation: string;
  readonly now?: () => number;
}): Promise<ComputerAgentQualificationStatus> {
  const now = input.now ?? Date.now;
  await requireSchema(input.database);
  const identity = serviceIdentity(input.context, now);
  if (input.task_kind !== "RESEARCH_BRANCH_ANALYSIS" ||
      input.connection.actor.issuer !== identity.issuer || input.connection.actor.subject !== identity.subject ||
      !input.connection.transport_capabilities.includes(input.transport) ||
      !input.connection.task_kinds.includes(input.task_kind)) {
    fail("COMPUTER_AGENT_QUALIFICATION_DENIED", 403,
      "Connection, actor and requested task transport do not match");
  }
  const row = await latest(input.database, input.connection.connection_id,
    input.connection.revision, input.transport);
  if (row === null) fail("COMPUTER_AGENT_QUALIFICATION_NOT_FOUND", 403,
    "Computer-agent connection has not been qualified for this transport");
  const status = await statusFromRow(row, nowValue(now));
  if (status.status !== "READY" || status.deployment_generation !== input.deployment_generation ||
      status.verified_credential_generation !== identity.credential_generation) {
    fail(status.status === "EXPIRED" ? "COMPUTER_AGENT_QUALIFICATION_EXPIRED" :
      status.status === "ACTOR_MISMATCH" ? "COMPUTER_AGENT_QUALIFICATION_ACTOR_MISMATCH" :
        "COMPUTER_AGENT_QUALIFICATION_STALE", 403,
    "Computer-agent connection qualification is not current");
  }
  return status;
}

export async function confirmWebInboxComputerAgentQualification(input: {
  readonly database: D1Database;
  readonly context: AuthenticatedRequestContext;
  readonly body: unknown;
  readonly deployment_generation: string;
  readonly now?: () => number;
}): Promise<ComputerAgentQualificationConfirmation> {
  const now = input.now ?? Date.now;
  const parsed = McpDiagnosticConsumeInputSchema.safeParse(input.body);
  if (!parsed.success) fail("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 400,
    "Qualification confirmation input is invalid");
  const identity = serviceIdentity(input.context, now);
  const bound = await preflightComputerAgentQualificationChallenge({
    database: input.database,
    challenge_id: parsed.data.challenge_id,
    transport: "WEB_INBOX",
    issuer: identity.issuer,
    subject: identity.subject,
    deployment_generation: input.deployment_generation,
    now,
  });
  if (!bound) fail("COMPUTER_AGENT_QUALIFICATION_NOT_FOUND", 404,
    "Qualification challenge is not bound to the web inbox");
  const toolContext: McpToolCallContext = Object.freeze({
    principal_ref: identity.subject,
    trace_id: identity.trace_id,
    deployment_generation: input.deployment_generation,
    verified_actor: Object.freeze({
      actor_ref: identity.subject,
      credential_generation: identity.credential_generation,
      authentication_method: "service_token",
      expires_at: identity.expires_at,
      auth_profile: "service-token",
      deployment_generation: input.deployment_generation,
    }),
    ...(input.context.access === undefined ? {} : { verified_access: input.context.access }),
  });
  const diagnostic = createD1McpClientDiagnosticService(input.database, {
    now, auth_profile: "service-token", deployment_generation: input.deployment_generation,
  });
  try { await diagnostic.consume(parsed.data, toolContext); }
  catch (error) {
    if (error instanceof McpClientDiagnosticServiceError) {
      fail(error.retryable ? "COMPUTER_AGENT_QUALIFICATION_STORAGE_UNAVAILABLE" :
        error.code === "MCP_DIAGNOSTIC_CHALLENGE_EXPIRED" ? "COMPUTER_AGENT_QUALIFICATION_EXPIRED" :
          "COMPUTER_AGENT_QUALIFICATION_DENIED", error.status,
      "Qualification challenge could not be confirmed", error.retryable);
    }
    throw error;
  }
  const status = await requireComputerAgentQualificationChallengeReady({
    database: input.database,
    challenge_id: parsed.data.challenge_id,
    transport: "WEB_INBOX",
    credential_generation: identity.credential_generation,
    deployment_generation: input.deployment_generation,
    now,
  });
  return ComputerAgentQualificationConfirmationSchema.parse({
    protocol: "eliotr.computer-agent-qualification-confirmed.v1",
    status: "READY",
    connection_id: status.connection_id,
    connection_revision: status.connection_revision,
    transport: status.transport,
    challenge_id: status.challenge_id,
    observation_ref: status.observation_ref,
    observed_at: status.observed_at,
    ready_until: status.ready_until,
    deployment_generation: status.deployment_generation,
  });
}
''')

write("apps/eliotr-core/src/computer-agent-qualification-http.ts", r'''
import { ComputerAgentQualificationIssueInputSchema } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentQualificationError,
  confirmWebInboxComputerAgentQualification,
  createComputerAgentQualificationService,
} from "./computer-agent-qualification-store.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";

const INBOX_PROTOCOL = "eliotr.agent-inbox.v1";

function map(error: unknown): never {
  if (error instanceof ComputerAgentQualificationError) {
    throw new HttpRequestError(error.code, error.status,
      "Computer-agent qualification request could not be completed", error.retryable);
  }
  throw error;
}
function requireOwnerMutation(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin !== url.origin || request.headers.get("X-Eliotr-Csrf") !== "1" ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_CSRF_DENIED", 403,
      "Qualification issuance requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 415,
      "Qualification issuance requires application/json");
  }
}
function requireInboxOrigin(request: Request, url: URL): void {
  if (request.headers.get("X-Eliotr-Agent-Inbox") !== INBOX_PROTOCOL ||
      request.headers.get("Origin") !== url.origin || request.headers.has("Cookie")) {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification requires the dedicated same-origin cookie-free shell");
  }
  const referer = request.headers.get("Referer");
  if (referer !== null) {
    let parsed: URL;
    try { parsed = new URL(referer); }
    catch { throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification referrer is invalid"); }
    if (parsed.origin !== url.origin || !parsed.pathname.startsWith("/agent-inbox/") ||
        parsed.username !== "" || parsed.password !== "") {
      throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
        "Web-inbox qualification referrer is outside the dedicated shell");
    }
  }
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  const destination = request.headers.get("Sec-Fetch-Dest");
  if ((site !== null && site !== "same-origin" && site !== "none") ||
      (mode !== null && mode !== "same-origin" && mode !== "cors") ||
      (destination !== null && destination !== "empty")) {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification fetch metadata is invalid");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 415,
      "Qualification confirmation requires application/json");
  }
}

export async function handleComputerAgentQualificationOwnerHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const url = new URL(request.url);
  requireNoQuery(url);
  const service = createComputerAgentQualificationService({
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    mcp_auth_profile: env.MCP_ACCESS_AUTH_PROFILE,
  });
  try {
    if (request.method === "GET") {
      return apiResult(request, env, await service.latestStatus(context,
        params.connection_id ?? "", params.transport ?? ""));
    }
    requireOwnerMutation(request, url);
    const body: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
    if (!ComputerAgentQualificationIssueInputSchema.safeParse(body).success) {
      throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 400,
        "Qualification issue accepts only an empty JSON object");
    }
    return apiResult(request, env, await service.issue(context,
      params.connection_id ?? "", params.transport ?? ""), 201);
  } catch (error) { map(error); }
}

export async function handleComputerAgentQualificationConfirmHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  maximumBytes: number,
): Promise<Response> {
  const url = new URL(request.url);
  requireNoQuery(url);
  requireInboxOrigin(request, url);
  try {
    const result = await confirmWebInboxComputerAgentQualification({
      database: env.CORE_DB,
      context,
      body: await readJsonBodyWithinBytes(request, maximumBytes),
      deployment_generation: env.DEPLOYMENT_GENERATION,
    });
    return apiResult(request, env, result);
  } catch (error) { map(error); }
}
''')

replace_once(
    "packages/contracts/src/index.ts",
    'export * from "./computer-agent-route.js";\n',
    'export * from "./computer-agent-route.js";\nexport * from "./computer-agent-qualification.js";\n',
)

replace_once(
    "packages/interfaces/src/routes.ts",
    '  { method: "DELETE", path: "/api/v1/system/computer-agents/:connection_id", operation: "system.computer-agents.disable", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n',
    '  { method: "DELETE", path: "/api/v1/system/computer-agents/:connection_id", operation: "system.computer-agents.disable", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n'
    '  { method: "GET", path: "/api/v1/system/computer-agents/:connection_id/qualifications/:transport", operation: "system.computer-agent-qualifications.status", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },\n'
    '  { method: "POST", path: "/api/v1/system/computer-agents/:connection_id/qualifications/:transport", operation: "system.computer-agent-qualifications.issue", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n'
    '  { method: "POST", path: "/api/v1/computer-agents/qualifications/confirm", operation: "computer-agent-qualifications.confirm", auth: "service", maximum_request_bytes: 2048, response_mode: "json" },\n',
)

replace_once(
    "apps/eliotr-core/src/http-special-routes.ts",
    'import { handleComputerAgentRouteHttp } from "./computer-agent-route-http.js";\n',
    'import { handleComputerAgentRouteHttp } from "./computer-agent-route-http.js";\n'
    'import {\n  handleComputerAgentQualificationConfirmHttp,\n  handleComputerAgentQualificationOwnerHttp,\n} from "./computer-agent-qualification-http.js";\n',
)
replace_once(
    "apps/eliotr-core/src/http-special-routes.ts",
    '    case "system.computer-agents.list":\n',
    '    case "system.computer-agent-qualifications.status":\n'
    '    case "system.computer-agent-qualifications.issue":\n'
    '      return handleComputerAgentQualificationOwnerHttp(input.request, input.env, input.context,\n'
    '        input.match.params, input.match.route.maximum_request_bytes);\n'
    '    case "computer-agent-qualifications.confirm":\n'
    '      return handleComputerAgentQualificationConfirmHttp(input.request, input.env, input.context,\n'
    '        input.match.route.maximum_request_bytes);\n'
    '    case "system.computer-agents.list":\n',
)

replace_once(
    "apps/eliotr-core/src/mcp-external-agent-task.ts",
    'import type { ComputerAgentTransportCapability } from "@eliotr/contracts";\n',
    'import type { ComputerAgentTransportCapability } from "@eliotr/contracts";\n'
    'import {\n  ComputerAgentQualificationError,\n  requireCurrentComputerAgentQualification,\n} from "./computer-agent-qualification-store.js";\n',
)
replace_once(
    "apps/eliotr-core/src/mcp-external-agent-task.ts",
    '    if (connection.actor.issuer !== grant.grantee.issuer ||\n        connection.actor.subject !== grant.grantee.subject) {\n',
    '    await requireCurrentComputerAgentQualification({\n'
    '      database: env.CORE_DB,\n'
    '      context,\n'
    '      connection,\n'
    '      transport,\n'
    '      task_kind: "RESEARCH_BRANCH_ANALYSIS",\n'
    '      deployment_generation: env.DEPLOYMENT_GENERATION,\n'
    '    });\n'
    '    if (connection.actor.issuer !== grant.grantee.issuer ||\n'
    '        connection.actor.subject !== grant.grantee.subject) {\n',
)
replace_once(
    "apps/eliotr-core/src/mcp-external-agent-task.ts",
    '    if (error instanceof ComputerAgentConnectionError) {\n',
    '    if (error instanceof ComputerAgentQualificationError) {\n'
    '      const code = error.code === "COMPUTER_AGENT_QUALIFICATION_SCHEMA_NOT_READY"\n'
    '        ? "EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY"\n'
    '        : error.code === "COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT"\n'
    '          ? "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT"\n'
    '          : error.retryable\n'
    '            ? "EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN"\n'
    '            : "EXTERNAL_AGENT_TASK_DENIED";\n'
    '      throw new ExternalAgentTaskError(code, error.status,\n'
    '        "Computer-agent qualification is not current for this task transport", error.retryable);\n'
    '    }\n'
    '    if (error instanceof ComputerAgentConnectionError) {\n',
)

replace_once(
    "apps/eliotr-core/src/index.ts",
    'import { handleScheduled } from "./scheduled.js";\n',
    'import { handleScheduled } from "./scheduled.js";\n'
    'import {\n  ComputerAgentQualificationError,\n  preflightComputerAgentQualificationChallenge,\n  requireComputerAgentQualificationChallengeReady,\n} from "./computer-agent-qualification-store.js";\n',
)
replace_once(
    "apps/eliotr-core/src/index.ts",
    'function unavailableMcpDiagnosticError(): GeminiMcpToolError {\n',
    'function computerAgentQualificationError(error: ComputerAgentQualificationError): GeminiMcpToolError {\n'
    '  return new GeminiMcpToolError(error.code,\n'
    '    "Computer-agent qualification is not current for this Access actor", error.retryable);\n'
    '}\n\n'
    'function unavailableMcpDiagnosticError(): GeminiMcpToolError {\n',
)
replace_once(
    "apps/eliotr-core/src/index.ts",
    '    try {\n      const service = createD1McpClientDiagnosticService(database, {\n',
    '    try {\n'
    '      const actor = context.verified_actor;\n'
    '      const access = context.verified_access;\n'
    '      const bound = actor === undefined ? false : await preflightComputerAgentQualificationChallenge({\n'
    '        database,\n'
    '        challenge_id: consumeInput.challenge_id,\n'
    '        transport: "MCP_WRITE",\n'
    '        issuer: access?.issuer,\n'
    '        subject: context.principal_ref,\n'
    '        deployment_generation: deploymentGeneration,\n'
    '      });\n'
    '      const service = createD1McpClientDiagnosticService(database, {\n',
)
replace_once(
    "apps/eliotr-core/src/index.ts",
    '      return await service.consume(consumeInput, consumeContext);\n    } catch (error) {\n      if (error instanceof McpClientDiagnosticServiceError) throw mcpDiagnosticError(error);\n',
    '      const result = await service.consume(consumeInput, consumeContext);\n'
    '      if (bound && context.verified_actor !== undefined) {\n'
    '        await requireComputerAgentQualificationChallengeReady({\n'
    '          database,\n'
    '          challenge_id: consumeInput.challenge_id,\n'
    '          transport: "MCP_WRITE",\n'
    '          credential_generation: context.verified_actor.credential_generation,\n'
    '          deployment_generation: deploymentGeneration,\n'
    '        });\n'
    '      }\n'
    '      return result;\n'
    '    } catch (error) {\n'
    '      if (error instanceof ComputerAgentQualificationError) throw computerAgentQualificationError(error);\n'
    '      if (error instanceof McpClientDiagnosticServiceError) throw mcpDiagnosticError(error);\n',
)

replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    'interface AccessFields {\n  readonly clientId: string;\n  readonly clientSecret: string;\n  readonly grantId: string;\n}\n',
    'interface AccessIdentityFields {\n'
    '  readonly clientId: string;\n'
    '  readonly clientSecret: string;\n'
    '  readonly grantId?: string;\n'
    '}\n'
    'interface AccessFields extends AccessIdentityFields {\n'
    '  readonly grantId: string;\n'
    '}\n',
)
replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    'const clientGrantId = element("client-grant-id", HTMLInputElement);\n',
    'const clientGrantId = element("client-grant-id", HTMLInputElement);\n'
    'const qualificationChallengeId = element("qualification-challenge-id", HTMLInputElement);\n'
    'const qualificationChallengeToken = element("qualification-challenge-token", HTMLInputElement);\n',
)
replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    'function credentials(): AccessFields {\n  const clientId = accessClientId.value.trim();\n  const clientSecret = accessClientSecret.value;\n  const grantId = clientGrantId.value.trim();\n  if (\n    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\\.access$/u.test(clientId) ||\n    clientSecret.length < 1 ||\n    clientSecret.length > 4096 ||\n    /\\s/u.test(clientSecret) ||\n    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(grantId)\n  ) {\n    throw new Error("Enter a valid Access Client ID, Client Secret, and project grant locator");\n  }\n  return { clientId, clientSecret, grantId };\n}\n',
    'function accessIdentity(): AccessIdentityFields {\n'
    '  const clientId = accessClientId.value.trim();\n'
    '  const clientSecret = accessClientSecret.value;\n'
    '  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\\.access$/u.test(clientId) ||\n'
    '      clientSecret.length < 1 || clientSecret.length > 4096 || /\\s/u.test(clientSecret)) {\n'
    '    throw new Error("Enter a valid Access Client ID and Client Secret");\n'
    '  }\n'
    '  return { clientId, clientSecret };\n'
    '}\n\n'
    'function credentials(): AccessFields {\n'
    '  const access = accessIdentity();\n'
    '  const grantId = clientGrantId.value.trim();\n'
    '  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(grantId)) {\n'
    '    throw new Error("Enter a valid project grant locator");\n'
    '  }\n'
    '  return { ...access, grantId };\n'
    '}\n',
)
replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    '  access: AccessFields,\n',
    '  access: AccessIdentityFields,\n',
)
replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    '    "X-Eliotr-Agent-Inbox": AGENT_INBOX_PROTOCOL,\n    "X-Eliotr-Client-Grant": access.grantId,\n  });\n',
    '    "X-Eliotr-Agent-Inbox": AGENT_INBOX_PROTOCOL,\n'
    '  });\n'
    '  if (access.grantId !== undefined) headers.set("X-Eliotr-Client-Grant", access.grantId);\n',
)
replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    '  access: AccessFields,\n  init: {\n',
    '  access: AccessIdentityFields,\n  init: {\n',
)
replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    'element("pull-task", HTMLButtonElement).addEventListener("click", () => {\n',
    'element("confirm-qualification", HTMLButtonElement).addEventListener("click", () => {\n'
    '  void busy("Confirming web-inbox qualification…", async () => {\n'
    '    const response = await sameOriginFetch(\n'
    '      "/api/v1/computer-agents/qualifications/confirm",\n'
    '      accessIdentity(),\n'
    '      { method: "POST", body: JSON.stringify({\n'
    '        challenge_id: qualificationChallengeId.value.trim(),\n'
    '        challenge_token: qualificationChallengeToken.value,\n'
    '      }) },\n'
    '    );\n'
    '    const result = await decodedResponse(response);\n'
    '    qualificationChallengeToken.value = "";\n'
    '    render(eventOutput, result);\n'
    '  });\n'
    '});\n\n'
    'element("pull-task", HTMLButtonElement).addEventListener("click", () => {\n',
)
replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    '  clientGrantId.value = "";\n  setStatus("Credential fields cleared.");\n',
    '  clientGrantId.value = "";\n'
    '  qualificationChallengeId.value = "";\n'
    '  qualificationChallengeToken.value = "";\n'
    '  setStatus("Credential and qualification fields cleared.");\n',
)
replace_once(
    "apps/eliotr-pwa/src/agent-inbox.ts",
    '  clientGrantId.value = "";\n  currentTask = null;\n',
    '  clientGrantId.value = "";\n'
    '  qualificationChallengeId.value = "";\n'
    '  qualificationChallengeToken.value = "";\n'
    '  currentTask = null;\n',
)

replace_once(
    "apps/eliotr-pwa/src/pages/agent-inbox.astro",
    '      <section class="panel" aria-labelledby="task-heading">\n',
    '      <section class="panel" aria-labelledby="qualification-heading">\n'
    '        <div class="panel-heading">\n'
    '          <div>\n'
    '            <p class="step">01b</p>\n'
    '            <h2 id="qualification-heading">Qualify this web-inbox credential</h2>\n'
    '          </div>\n'
    '          <button id="confirm-qualification" class="button" type="button" data-request>Confirm qualification</button>\n'
    '        </div>\n'
    '        <p class="help">\n'
    '          Paste the one-shot owner-issued WEB_INBOX challenge. The token is sent once, never stored,\n'
    '          and cleared after a successful confirmation. Qualification is bound to this exact Access actor,\n'
    '          connection revision, credential generation, deployment, and freshness window.\n'
    '        </p>\n'
    '        <div class="form-grid">\n'
    '          <label>\n'
    '            <span>Qualification challenge ID</span>\n'
    '            <input id="qualification-challenge-id" type="text" autocomplete="off" spellcheck="false" />\n'
    '          </label>\n'
    '          <label>\n'
    '            <span>Qualification challenge token</span>\n'
    '            <input id="qualification-challenge-token" type="password" autocomplete="off"\n'
    '              data-1p-ignore data-lpignore="true" spellcheck="false" />\n'
    '          </label>\n'
    '        </div>\n'
    '      </section>\n\n'
    '      <section class="panel" aria-labelledby="task-heading">\n',
)

append_once("docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    "## 6. Connection qualification and readiness",
    r'''
## 6. Connection qualification and readiness

Migration 0089 binds the existing one-shot MCP diagnostic challenge to one exact connection revision and
`MCP_WRITE` or `WEB_INBOX`. Challenge token generation, SHA-256-only persistence, five-minute issuance,
verified actor/deployment readback and immutable confirmation continue to use the existing diagnostic
protocol. A bound challenge is rejected before consume when the verified Access actor, selected transport,
connection revision or deployment differs.

A confirmed qualification is READY only for the exact credential generation that performed it, while the
connection remains current and enabled, and until the earlier of verified credential expiry or the bounded
freshness window. Task pull/progress/result/status now require READY qualification for the transport actually
used. Qualification does not grant a project, select a route, create a run or transfer a lease. Route priority
can therefore become readiness-aware later without treating configured capability as observed availability.
''')
append_once("docs/adr/0008-computer-agent-web-inbox.md",
    "## Web-inbox qualification",
    r'''
## Web-inbox qualification

Before task access, the owner issues a `WEB_INBOX` challenge for the exact current connection revision.
The agent enters the one-shot challenge ID/token in the no-persistence inbox. Confirmation uses the same
service-token Access actor as later task calls, omits cookies, clears the token after success, and writes only
the existing diagnostic observation plus immutable connection binding. A changed credential generation,
connection revision, deployment, expiry or disabled connection requires a new qualification.
''')
append_once("docs/implementation/computer-agent-web-inbox.md",
    "## Qualify the exact web-inbox credential",
    r'''
## Qualify the exact web-inbox credential

The owner POSTs `{}` with `X-Eliotr-Csrf: 1` to
`/api/v1/system/computer-agents/<connection_id>/qualifications/WEB_INBOX`, then passes the returned one-shot
challenge ID/token to the intended agent. The agent opens `/agent-inbox/`, enters its Access Client ID/Secret
and the challenge, and confirms once. Owner GET on the same qualification URL reports `ISSUED`, `READY`,
`EXPIRED`, `ACTOR_MISMATCH` or `STALE` without returning the token. Task calls fail until the exact current
credential generation is READY.
''')
append_once("docs/implementation/muse-operator-runbook.md",
    "## Qualify each transport",
    r'''
## Qualify each transport

Capability declarations are not readiness. The owner issues a qualification challenge for the exact current
connection revision and transport. An MCP client confirms the challenge with the existing
`eliotr_confirm_client_diagnostic` tool; a UI-only Dot/Muse/Spark contour confirms `WEB_INBOX` in the
no-persistence page. Requalify after credential rotation, connection revision changes, deployment changes,
expiry or freshness timeout. Never copy one contour's challenge token to another actor.
''')
