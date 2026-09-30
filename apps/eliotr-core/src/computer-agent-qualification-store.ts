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

export async function readComputerAgentQualificationStatusForConnection(input: {
  readonly database: D1Database;
  readonly connection_id: string;
  readonly connection_revision: number;
  readonly transport: ComputerAgentQualificationTransport;
  readonly now?: () => number;
}): Promise<ComputerAgentQualificationStatus | null> {
  const now = input.now ?? Date.now;
  await requireSchema(input.database);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(input.connection_id) ||
      !Number.isSafeInteger(input.connection_revision) || input.connection_revision < 1 ||
      input.connection_revision > 2_147_483_647) {
    fail("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 400,
      "Connection qualification identity is invalid");
  }
  const selectedTransport = transport(input.transport);
  const row = await latest(input.database, input.connection_id,
    input.connection_revision, selectedTransport);
  if (row === null) return null;
  const status = await statusFromRow(row, nowValue(now));
  if (status.connection_id !== input.connection_id ||
      status.connection_revision !== input.connection_revision ||
      status.transport !== selectedTransport) {
    fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT", 500,
      "Connection qualification readback identity is corrupt");
  }
  return status;
}
