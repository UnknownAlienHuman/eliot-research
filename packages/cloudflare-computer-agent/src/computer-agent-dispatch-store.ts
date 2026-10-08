import {
  ComputerAgentDispatchAcceptSchema,
  ComputerAgentDispatchAcceptanceSchema,
  ComputerAgentDispatchCreateSchema,
  ComputerAgentDispatchOfferSchema,
  ComputerAgentDispatchPullSchema,
  ComputerAgentDispatchSchema,
  type ComputerAgentConnection,
  type ComputerAgentDispatch,
  type ComputerAgentDispatchAcceptance,
  type ComputerAgentDispatchOffer,
  type ComputerAgentDispatchStatus,
  type ComputerAgentQualificationStatus,
  type ProjectClientGrant,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import {
  authorizeProjectClientGrant,
  ClientGrantError,
  readClientGrant,
} from "@eliotr/cloudflare-navigation";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  ComputerAgentConnectionError,
  readComputerAgentConnectionRevision,
  readCurrentComputerAgentConnection,
  requireComputerAgentConnectionForTask,
} from "./computer-agent-connection-store.js";
import {
  ComputerAgentQualificationError,
  readComputerAgentQualificationStatusForConnection,
  requireCurrentComputerAgentQualification,
} from "./computer-agent-qualification-store.js";
import {
  ComputerAgentRouteError,
  createProjectComputerAgentRouteService,
  readCurrentProjectComputerAgentRoute,
} from "./computer-agent-route-store.js";
import {
  ComputerAgentDispatchError,
  failComputerAgentDispatch as fail,
} from "./computer-agent-dispatch-error.js";
import {
  decodeComputerAgentDispatch,
  decodeComputerAgentDispatchAcceptance,
  readComputerAgentDispatchAcceptanceRow,
  readComputerAgentDispatchReplay,
  readComputerAgentDispatchRow,
  readCurrentComputerAgentDispatchOffer,
  type DispatchRow,
} from "./computer-agent-dispatch-record.js";
import { readComputerAgentDispatchStatus } from "./computer-agent-dispatch-status.js";
import type { ComputerAgentRuntime } from "./runtime.js";

const SCHEMA_GENERATION = "computer-agent-dispatch-v1";
const ABANDONMENT_SCHEMA_GENERATION = "computer-agent-dispatch-abandonment-v1";
const DECLINE_SCHEMA_GENERATION = "computer-agent-dispatch-decline-v1";
const REASSIGNMENT_SCHEMA_GENERATION = "computer-agent-dispatch-reassignment-v1";
const TASK_KIND = "RESEARCH_BRANCH_ANALYSIS" as const;
const MAX_RECORD_BYTES = 294_912;
const MIN_REMAINING_MS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}
function idempotency(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value)) {
    fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Idempotency-Key is required and invalid");
  }
  return value;
}
function instant(now: () => number): number {
  let value: number;
  try { value = now(); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
    "Dispatch clock is unavailable", true); }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch clock is invalid", true);
  }
  return value;
}
function owner(context: AuthenticatedRequestContext, now: () => number) {
  const current = instant(now);
  if (context.client_class !== "owner_pwa" || context.request.signal.aborted) {
    fail("COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", 403,
      "A current owner request is required");
  }
  if (context.access && (context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) ||
      Date.parse(context.access.expires_at) <= current)) {
    fail("COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", 403,
      "Owner session is no longer current");
  }
  return Object.freeze({
    principal_ref: identifier(context.principal_ref, "owner principal"),
    credential_generation: identifier(context.credential_generation, "owner credential generation"),
  });
}
async function requireSchema(db: D1Database): Promise<void> {
  let values: Map<string, string>;
  try {
    const result = await db.prepare(
      "SELECT key,value FROM schema_state WHERE key IN (" +
      "'computer_agent_dispatch_generation','computer_agent_dispatch_abandonment_generation'," +
      "'computer_agent_dispatch_decline_generation'," +
      "'computer_agent_dispatch_reassignment_generation')",
    ).all<{ key: string; value: string }>();
    values = new Map((result.results ?? []).map((entry) => [entry.key, entry.value]));
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent dispatch migrations 0090 through 0093 are required", true);
  }
  if (values.get("computer_agent_dispatch_generation") !== SCHEMA_GENERATION ||
      values.get("computer_agent_dispatch_abandonment_generation") !==
        ABANDONMENT_SCHEMA_GENERATION ||
      values.get("computer_agent_dispatch_decline_generation") !==
        DECLINE_SCHEMA_GENERATION ||
      values.get("computer_agent_dispatch_reassignment_generation") !==
        REASSIGNMENT_SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent dispatch migrations 0090 through 0093 are required", true);
  }
}
function mapDependency(error: unknown): never {
  if (error instanceof ComputerAgentDispatchError) throw error;
  if (error instanceof ClientGrantError || error instanceof ComputerAgentConnectionError ||
      error instanceof ComputerAgentQualificationError || error instanceof ComputerAgentRouteError) {
    if (error.retryable) fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch authority could not be read", true);
    if (error.status >= 500) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch authority record is corrupt");
    fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
      "Dispatch authority is no longer current");
  }
  throw error;
}
function requireGrant(grant: ProjectClientGrant | null, input: {
  project_id: string;
  owner_principal_ref: string;
  actor: ComputerAgentConnection["actor"];
  revision: number;
  now: number;
}): ProjectClientGrant {
  if (grant === null || grant.state !== "ACTIVE" || grant.revision !== input.revision ||
      grant.project_id !== input.project_id ||
      grant.grantor_principal_ref !== input.owner_principal_ref ||
      grant.grantee.authentication_method !== "service_token" ||
      canonicalJson(grant.grantee) !== canonicalJson(input.actor) ||
      !grant.allowed_operations.includes("run") ||
      !grant.allowed_operations.includes("recover") ||
      !grant.allowed_operations.includes("evidence") ||
      grant.spend_policy_ref === undefined || Date.parse(grant.expires_at) <= input.now) {
    fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
      "Exact current run, recovery, evidence and sponsorship delegation is required");
  }
  return grant;
}
function requireReadyQualification(status: ComputerAgentQualificationStatus | null, input: {
  connection: ComputerAgentConnection;
  transport: ComputerAgentDispatch["transport"];
  deployment_generation: string;
  now: number;
}) {
  if (status === null || status.status !== "READY" ||
      status.connection_id !== input.connection.connection_id ||
      status.connection_revision !== input.connection.revision ||
      status.transport !== input.transport ||
      status.deployment_generation !== input.deployment_generation ||
      status.observation_ref === undefined || status.ready_until === undefined ||
      status.verified_credential_generation === undefined ||
      Date.parse(status.ready_until) <= input.now) {
    fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
      "The selected connection is not currently qualified for this transport");
  }
  return Object.freeze({
    challenge_id: status.challenge_id,
    observation_ref: status.observation_ref,
    verified_credential_generation: status.verified_credential_generation,
    ready_until: status.ready_until,
    deployment_generation: status.deployment_generation,
  });
}
function requireRunRequest(raw: unknown, projectId: string, parseRequest: (raw: unknown) => QueryRequest,
  isInputError: (error: unknown) => boolean): QueryRequest {
  let parsed: QueryRequest;
  try { parsed = parseRequest(raw); }
  catch (error) {
    if (isInputError(error)) fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Dispatch contains an invalid explicit Research request");
    throw error;
  }
  if (parsed.request_version === undefined || parsed.inquiry_protocol_ref === undefined ||
      parsed.scope_expression.kind !== "PROJECT" ||
      parsed.scope_expression.project_id !== projectId) {
    fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Dispatch requires one explicit-protocol PROJECT Research request");
  }
  return parsed;
}

export function createComputerAgentDispatchService(runtime: ComputerAgentRuntime, options: {
  readonly now?: () => number;
  readonly start_run: (context: AuthenticatedRequestContext, request: QueryRequest) =>
    Promise<{ investigation_ref: { readonly id: string; readonly revision: number };
      workflow_instance_id: string }>;
  readonly parse_run_request: (raw: unknown) => QueryRequest;
  readonly is_run_request_input_error: (error: unknown) => boolean;
  readonly is_research_run_service_error: (error: unknown) => error is {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
  };
  readonly allow_preferred_internal_key?: boolean | undefined;
}) {
  const db = runtime.database;
  const now = options?.now ?? Date.now;
  const startRun = options.start_run;

  async function create(context: AuthenticatedRequestContext,
    projectIdValue: string, rawInput: unknown): Promise<ComputerAgentDispatch> {
    await requireSchema(db);
    const identity = owner(context, now);
    const projectId = identifier(projectIdValue, "project_id");
    const parsed = ComputerAgentDispatchCreateSchema.safeParse(rawInput);
    if (!parsed.success) fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Dispatch input contains unknown or invalid fields");
    requireRunRequest(parsed.data.run_request, projectId, options.parse_run_request,
      options.is_run_request_input_error);
    const key = idempotency(context.request.headers.get("Idempotency-Key"));
    if (key.startsWith("preferred-dispatch-") &&
        options?.allow_preferred_internal_key !== true) {
      fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
        "Idempotency-Key uses the reserved preferred-dispatch namespace");
    }
    const requestSha = await sha256Utf8(canonicalJson({
      protocol: "eliotr.computer-agent-dispatch-create.v1",
      project_id: projectId,
      owner_principal_ref: identity.principal_ref,
      input: parsed.data,
    }));
    const replay = await readComputerAgentDispatchReplay(db, identity.principal_ref, key);
    if (replay !== null) {
      if (replay.project_id !== projectId || replay.request_sha256 !== requestSha) fail(
        "COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Idempotency-Key is already bound to another dispatch");
      owner(context, now);
      return decodeComputerAgentDispatch(replay);
    }
    const current = instant(now);
    const route = await createProjectComputerAgentRouteService({ database: db, now })
      .get(context, projectId, TASK_KIND).catch(mapDependency);
    if (route.state !== "ACTIVE" || route.revision !== parsed.data.expected_route_revision) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "The selected project route revision is not current and active");
    }
    const priority = route.connections.findIndex((entry) =>
      entry.connection_id === parsed.data.connection_id &&
      entry.connection_revision === parsed.data.connection_revision);
    if (priority < 0) fail("COMPUTER_AGENT_DISPATCH_DENIED", 403,
      "The selected connection revision is not in the active project route");
    const [exact, currentConnection] = await Promise.all([
      readComputerAgentConnectionRevision(db, parsed.data.connection_id,
        parsed.data.connection_revision).catch(mapDependency),
      readCurrentComputerAgentConnection(db, parsed.data.connection_id).catch(mapDependency),
    ]);
    if (exact === null || currentConnection === null || exact.state !== "ENABLED" ||
        currentConnection.state !== "ENABLED" || currentConnection.revision !== exact.revision ||
        exact.owner_principal_ref !== identity.principal_ref ||
        !exact.task_kinds.includes(TASK_KIND) ||
        !exact.transport_capabilities.includes(parsed.data.transport)) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "The selected connection revision is not current, enabled and capable");
    }
    const grant = requireGrant(
      await readClientGrant(db, parsed.data.client_grant_id).catch(mapDependency),
      { project_id: projectId, owner_principal_ref: identity.principal_ref,
        actor: exact.actor, revision: parsed.data.client_grant_revision, now: current },
    );
    const qualification = requireReadyQualification(
      await readComputerAgentQualificationStatusForConnection({
        database: db, connection_id: exact.connection_id, connection_revision: exact.revision,
        transport: parsed.data.transport, now,
      }).catch(mapDependency),
      { connection: exact, transport: parsed.data.transport,
        deployment_generation: runtime.deployment_generation, now: current },
    );
    const expiresMs = Math.min(current + parsed.data.expires_in_seconds * 1000,
      Date.parse(grant.expires_at), Date.parse(qualification.ready_until));
    if (!Number.isFinite(expiresMs) || expiresMs <= current + MIN_REMAINING_MS) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "Dispatch authority expires too soon; renew grant or qualification first");
    }
    const runRequestSha = await sha256Utf8(canonicalJson(parsed.data.run_request));
    const dispatchHash = await sha256Utf8(`${identity.principal_ref}|${key}|${requestSha}`);
    const dispatch = ComputerAgentDispatchSchema.parse({
      protocol: "eliotr.computer-agent-dispatch.v1",
      dispatch_id: `dispatch-${dispatchHash.slice(0, 48)}`,
      project_id: projectId,
      task_kind: TASK_KIND,
      transport: parsed.data.transport,
      route_revision: route.revision,
      priority,
      connection_id: exact.connection_id,
      connection_revision: exact.revision,
      client_grant_id: grant.grant_id,
      client_grant_revision: grant.revision,
      owner_principal_ref: identity.principal_ref,
      owner_credential_generation: identity.credential_generation,
      actor: exact.actor,
      qualification,
      run_request: parsed.data.run_request,
      run_request_sha256: runRequestSha,
      created_at: new Date(current).toISOString(),
      expires_at: new Date(expiresMs).toISOString(),
    });
    const record = canonicalJson(dispatch);
    if (new TextEncoder().encode(record).byteLength > MAX_RECORD_BYTES) fail(
      "COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 413, "Dispatch exceeds its byte envelope");
    const recordSha = await sha256Utf8(record);
    owner(context, now);
    try {
      await db.prepare("INSERT INTO computer_agent_dispatch(" +
        "dispatch_id,project_id,task_kind,transport,route_revision,priority," +
        "connection_id,connection_revision,client_grant_id,client_grant_revision," +
        "owner_principal_ref,owner_credential_generation,actor_issuer,actor_subject," +
        "qualification_challenge_id,qualification_observation_ref," +
        "qualification_credential_generation,deployment_generation,idempotency_key," +
        "request_sha256,run_request_sha256,record_json,record_sha256,created_at,expires_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17," +
        "?18,?19,?20,?21,?22,?23,?24,?25)")
        .bind(dispatch.dispatch_id, dispatch.project_id, dispatch.task_kind, dispatch.transport,
          dispatch.route_revision, dispatch.priority, dispatch.connection_id,
          dispatch.connection_revision, dispatch.client_grant_id, dispatch.client_grant_revision,
          dispatch.owner_principal_ref, dispatch.owner_credential_generation,
          dispatch.actor.issuer, dispatch.actor.subject, dispatch.qualification.challenge_id,
          dispatch.qualification.observation_ref,
          dispatch.qualification.verified_credential_generation,
          dispatch.qualification.deployment_generation, key, requestSha, runRequestSha,
          record, recordSha, dispatch.created_at, dispatch.expires_at).run();
    } catch { /* Exact replay/readback below reconciles lost acknowledgements and stale authority. */ }
    const settled = await readComputerAgentDispatchReplay(db, identity.principal_ref, key);
    if (settled === null) fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
      "Dispatch receipt is unavailable; retry with the same Idempotency-Key", true);
    if (settled.request_sha256 !== requestSha) fail(
      "COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
      "Idempotency-Key settled another dispatch");
    const decoded = await decodeComputerAgentDispatch(settled);
    if (canonicalJson(decoded) !== record) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch receipt differs from the intended record");
    owner(context, now);
    return decoded;
  }

  async function status(context: AuthenticatedRequestContext,
    projectIdValue: string, dispatchIdValue: string): Promise<ComputerAgentDispatchStatus> {
    await requireSchema(db);
    const projectId = identifier(projectIdValue, "project_id");
    const dispatchId = identifier(dispatchIdValue, "dispatch_id");
    await createProjectComputerAgentRouteService({ database: db, now })
      .get(context, projectId, TASK_KIND).catch(mapDependency);
    const row = await readComputerAgentDispatchRow(db, dispatchId);
    if (row === null || row.project_id !== projectId) fail("COMPUTER_AGENT_DISPATCH_NOT_FOUND", 404,
      "Computer-agent dispatch does not exist in this project");
    const dispatch = await decodeComputerAgentDispatch(row);
    const result = await readComputerAgentDispatchStatus({
      database: db,
      dispatch,
      now: instant(now),
    });
    owner(context, now);
    return result;
  }

  async function serviceGrant(context: AuthenticatedRequestContext, dispatch: ComputerAgentDispatch) {
    if (context.request.headers.get("X-Eliotr-Client-Grant") !== dispatch.client_grant_id) {
      fail("COMPUTER_AGENT_DISPATCH_DENIED", 403,
        "Dispatch acceptance requires the exact grant locator selected by the owner");
    }
    const lease = await authorizeProjectClientGrant(db, context, {
      operation: "run", project_id: dispatch.project_id,
      required_revision: dispatch.client_grant_revision,
    }, now).catch(mapDependency);
    requireGrant(lease.grant, {
      project_id: dispatch.project_id,
      owner_principal_ref: dispatch.owner_principal_ref,
      actor: dispatch.actor,
      revision: dispatch.client_grant_revision,
      now: instant(now),
    });
    return lease;
  }

  async function requireTarget(context: AuthenticatedRequestContext,
    dispatch: ComputerAgentDispatch): Promise<void> {
    const current = instant(now);
    if (dispatch.qualification.deployment_generation !== runtime.deployment_generation ||
        Date.parse(dispatch.expires_at) <= current ||
        dispatch.qualification.verified_credential_generation !== context.credential_generation) {
      fail(Date.parse(dispatch.expires_at) <= current
        ? "COMPUTER_AGENT_DISPATCH_EXPIRED" : "COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
      "Dispatch is expired or bound to another credential/deployment generation");
    }
    const connection = await requireComputerAgentConnectionForTask(
      db, context, dispatch.transport, TASK_KIND, now,
    ).catch(mapDependency);
    if (connection.connection_id !== dispatch.connection_id ||
        connection.revision !== dispatch.connection_revision ||
        canonicalJson(connection.actor) !== canonicalJson(dispatch.actor)) {
      fail("COMPUTER_AGENT_DISPATCH_DENIED", 403,
        "Verified service actor is not the owner-selected dispatch target");
    }
    const lease = await serviceGrant(context, dispatch);
    const route = await readCurrentProjectComputerAgentRoute(
      db, dispatch.project_id, TASK_KIND,
    ).catch(mapDependency);
    const entry = route?.connections[dispatch.priority];
    if (route === null || route.state !== "ACTIVE" || route.revision !== dispatch.route_revision ||
        entry?.connection_id !== dispatch.connection_id ||
        entry.connection_revision !== dispatch.connection_revision) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "Owner route changed before dispatch acceptance");
    }
    const qualification = await requireCurrentComputerAgentQualification({
      database: db, context, connection, transport: dispatch.transport,
      task_kind: TASK_KIND, deployment_generation: runtime.deployment_generation, now,
    }).catch(mapDependency);
    if (qualification.challenge_id !== dispatch.qualification.challenge_id ||
        qualification.observation_ref !== dispatch.qualification.observation_ref ||
        qualification.verified_credential_generation !==
          dispatch.qualification.verified_credential_generation ||
        qualification.ready_until !== dispatch.qualification.ready_until) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "Connection qualification changed before dispatch acceptance");
    }
    if (await readCurrentComputerAgentDispatchOffer(db, dispatch.dispatch_id) === null) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "Dispatch is no longer a current pending offer");
    }
    await lease.requireCurrent().catch(mapDependency);
  }

  async function pull(context: AuthenticatedRequestContext,
    rawInput: unknown): Promise<ComputerAgentDispatchOffer> {
    await requireSchema(db);
    const parsed = ComputerAgentDispatchPullSchema.safeParse(rawInput);
    if (!parsed.success) fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Dispatch pull input contains unknown or invalid fields");
    const connection = await requireComputerAgentConnectionForTask(
      db, context, parsed.data.transport, TASK_KIND, now,
    ).catch(mapDependency);
    if (context.request.headers.get("X-Eliotr-Client-Grant") === null) fail(
      "COMPUTER_AGENT_DISPATCH_DENIED", 403,
      "Dispatch pull requires one explicit project grant locator");
    const lease = await authorizeProjectClientGrant(db, context, { operation: "run" }, now)
      .catch(mapDependency);
    requireGrant(lease.grant, {
      project_id: lease.grant.project_id,
      owner_principal_ref: lease.grant.grantor_principal_ref,
      actor: connection.actor,
      revision: lease.grant.revision,
      now: instant(now),
    });
    const qualification = await requireCurrentComputerAgentQualification({
      database: db, context, connection, transport: parsed.data.transport,
      task_kind: TASK_KIND, deployment_generation: runtime.deployment_generation, now,
    }).catch(mapDependency);
    const route = await readCurrentProjectComputerAgentRoute(
      db, lease.grant.project_id, TASK_KIND,
    ).catch(mapDependency);
    const priority = route?.connections.findIndex((entry) =>
      entry.connection_id === connection.connection_id &&
      entry.connection_revision === connection.revision) ?? -1;
    if (route === null || route.state !== "ACTIVE" || priority < 0) fail(
      "COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
      "Verified actor is not present in the current project route");
    let row: DispatchRow | null;
    try {
      row = await db.prepare("SELECT * FROM computer_agent_dispatch_offer_claimable " +
        "WHERE project_id=?1 AND route_revision=?2 AND priority=?3 " +
        "AND connection_id=?4 AND connection_revision=?5 AND client_grant_id=?6 " +
        "AND client_grant_revision=?7 AND transport=?8 AND actor_issuer=?9 AND actor_subject=?10 " +
        "AND qualification_challenge_id=?11 AND qualification_credential_generation=?12 " +
        "AND deployment_generation=?13 ORDER BY created_at,dispatch_id LIMIT 1")
        .bind(lease.grant.project_id, route.revision, priority, connection.connection_id,
          connection.revision, lease.grant.grant_id, lease.grant.revision, parsed.data.transport,
          connection.actor.issuer, connection.actor.subject, qualification.challenge_id,
          context.credential_generation, runtime.deployment_generation).first<DispatchRow>();
    } catch {
      fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
        "Dispatch offer read is unavailable", true);
    }
    await lease.requireCurrent().catch(mapDependency);
    return ComputerAgentDispatchOfferSchema.parse({
      protocol: "eliotr.computer-agent-dispatch-offer.v1",
      dispatch: row === null ? null : await decodeComputerAgentDispatch(row),
    });
  }

  async function accept(context: AuthenticatedRequestContext,
    dispatchIdValue: string, rawInput: unknown): Promise<ComputerAgentDispatchAcceptance> {
    await requireSchema(db);
    if (!ComputerAgentDispatchAcceptSchema.safeParse(rawInput).success) fail(
      "COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Dispatch acceptance input must be an empty object");
    const dispatchId = identifier(dispatchIdValue, "dispatch_id");
    const row = await readComputerAgentDispatchRow(db, dispatchId);
    if (row === null) fail("COMPUTER_AGENT_DISPATCH_NOT_FOUND", 404,
      "Computer-agent dispatch does not exist");
    const dispatch = await decodeComputerAgentDispatch(row);
    const existingRow = await readComputerAgentDispatchAcceptanceRow(db, dispatchId);
    if (existingRow !== null) {
      if (context.credential_generation !== dispatch.qualification.verified_credential_generation) {
        fail("COMPUTER_AGENT_DISPATCH_DENIED", 403,
          "Accepted dispatch belongs to another credential generation");
      }
      const lease = await serviceGrant(context, dispatch);
      await lease.requireCurrent().catch(mapDependency);
      return decodeComputerAgentDispatchAcceptance(existingRow);
    }
    await requireTarget(context, dispatch);
    const headers = new Headers(context.request.headers);
    headers.set("X-Eliotr-Client-Grant", dispatch.client_grant_id);
    headers.set("Idempotency-Key", `computer-agent-dispatch:${dispatch.dispatch_id}`);
    headers.set("Content-Type", "application/json");
    const runContext: AuthenticatedRequestContext = {
      ...context,
      request: new Request(context.request.url, {
        method: "POST", headers, signal: context.request.signal,
      }),
    };
    let started;
    try { started = await startRun(runContext, dispatch.run_request); }
    catch (error) {
      if (options.is_research_run_service_error(error)) {
        if (error.retryable || error.status >= 500) fail(
          "COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
          "Research run admission is temporarily unavailable", true);
        if (error.code.includes("CONFLICT")) fail(
          "COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
          "Dispatch run identity conflicts with another operation");
        fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
          "Research run authority changed before acceptance");
      }
      throw error;
    }
    const acceptance = ComputerAgentDispatchAcceptanceSchema.parse({
      protocol: "eliotr.computer-agent-dispatch-accepted.v1",
      dispatch_id: dispatch.dispatch_id,
      workflow_instance_id: started.workflow_instance_id,
      investigation_ref: started.investigation_ref,
      connection_id: dispatch.connection_id,
      connection_revision: dispatch.connection_revision,
      client_grant_id: dispatch.client_grant_id,
      client_grant_revision: dispatch.client_grant_revision,
      actor: dispatch.actor,
      credential_generation: context.credential_generation,
      accepted_at: new Date(instant(now)).toISOString(),
    });
    const record = canonicalJson(acceptance);
    const digest = await sha256Utf8(record);
    try {
      await db.prepare("INSERT INTO computer_agent_dispatch_acceptance(" +
        "dispatch_id,workflow_instance_id,investigation_id,investigation_revision," +
        "actor_issuer,actor_subject,credential_generation,record_json,record_sha256,accepted_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(dispatch_id) DO NOTHING")
        .bind(acceptance.dispatch_id, acceptance.workflow_instance_id,
          acceptance.investigation_ref.id, acceptance.investigation_ref.revision,
          acceptance.actor.issuer, acceptance.actor.subject, acceptance.credential_generation,
          record, digest, acceptance.accepted_at).run();
    } catch { /* Replay/readback below reconciles a lost acceptance acknowledgement. */ }
    const settledRow = await readComputerAgentDispatchAcceptanceRow(db, dispatch.dispatch_id);
    if (settledRow === null) fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
      "Run exists but dispatch acceptance receipt is unavailable; retry this acceptance", true);
    const settled = await decodeComputerAgentDispatchAcceptance(settledRow);
    if (canonicalJson(settled) !== record) fail(
      "COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
      "Dispatch was accepted as another Research run");
    return settled;
  }

  return { create, status, pull, accept };
}
