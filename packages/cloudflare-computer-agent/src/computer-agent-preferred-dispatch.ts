import {
  ComputerAgentPreferredDispatchCreateSchema,
  ComputerAgentPreferredDispatchReceiptSchema,
  ComputerAgentPreferredDispatchSelectionSchema,
  ComputerAgentPreferredDispatchSettlementSchema,
  type ComputerAgentDispatch,
  type ComputerAgentPreferredDispatchReceipt,
  type ComputerAgentPreferredDispatchSelection,
  type ComputerAgentPreferredDispatchSettlement,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { ComputerAgentRouteError } from "./computer-agent-route-store.js";
import { readProjectComputerAgentRouteReadiness } from "./computer-agent-route-readiness.js";
import {
  decodeComputerAgentDispatch,
  readComputerAgentDispatchReplay,
  readComputerAgentDispatchRow,
} from "./computer-agent-dispatch-record.js";
import { failComputerAgentDispatch as fail } from "./computer-agent-dispatch-error.js";
import type { ComputerAgentRuntime } from "./runtime.js";

const SCHEMA_GENERATION = "computer-agent-preferred-dispatch-v1";
const TASK_KIND = "RESEARCH_BRANCH_ANALYSIS" as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const INTERNAL_PREFIX = "preferred-dispatch-";

interface SelectionRow {
  selection_id: string;
  project_id: string;
  task_kind: string;
  selection_strategy: string;
  transport: string;
  route_revision: number;
  priority: number;
  connection_id: string;
  connection_revision: number;
  client_grant_id: string;
  client_grant_revision: number;
  owner_principal_ref: string;
  owner_credential_generation: string;
  qualification_challenge_id: string;
  qualification_observation_ref: string;
  qualification_credential_generation: string;
  qualification_ready_until: string;
  deployment_generation: string;
  run_request_sha256: string;
  idempotency_key: string;
  request_sha256: string;
  record_json: string;
  record_sha256: string;
  selected_at: string;
}
interface SettlementRow {
  selection_id: string;
  dispatch_id: string;
  record_json: string;
  record_sha256: string;
  settled_at: string;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400, `${label} is invalid`);
  }
  return value;
}
function idempotency(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value) || value.startsWith(INTERNAL_PREFIX)) {
    fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
      "Idempotency-Key is required, invalid, or uses a reserved prefix");
  }
  return value;
}
function instant(now: () => number): number {
  let value: number;
  try { value = now(); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
    "Preferred-dispatch clock is unavailable", true); }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Preferred-dispatch clock is invalid", true);
  }
  return value;
}
function owner(context: AuthenticatedRequestContext, now: () => number) {
  const current = instant(now);
  if (context.client_class !== "owner_pwa" || context.request.signal.aborted) {
    fail("COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", 403, "A current owner request is required");
  }
  if (context.access && (context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) ||
      Date.parse(context.access.expires_at) <= current)) {
    fail("COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", 403, "Owner session is no longer current");
  }
  return Object.freeze({
    principal_ref: identifier(context.principal_ref, "owner principal"),
    credential_generation: identifier(context.credential_generation, "owner credential generation"),
  });
}
async function requireSchema(db: D1Database): Promise<void> {
  let value: string | null;
  try {
    value = await db.prepare(
      "SELECT value FROM schema_state WHERE key='computer_agent_preferred_dispatch_generation'",
    ).first<string>("value");
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent preferred dispatch migration 0094 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent preferred dispatch migration 0094 is required", true);
  }
}
function mapReadiness(error: unknown): never {
  if (error instanceof ComputerAgentRouteError) {
    if (error.retryable) fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Preferred route readiness is unavailable", true);
    if (error.status >= 500) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Preferred route readiness is corrupt");
    fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
      "Preferred route readiness is no longer current");
  }
  throw error;
}
async function readSelectionReplay(db: D1Database, principal: string,
  key: string): Promise<SelectionRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_preferred_dispatch_selection " +
      "WHERE owner_principal_ref=?1 AND idempotency_key=?2 LIMIT 1")
      .bind(principal, key).first<SelectionRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Preferred selection replay is unavailable", true);
  }
}
async function readSettlement(db: D1Database, selectionId: string): Promise<SettlementRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_preferred_dispatch_settlement " +
      "WHERE selection_id=?1 LIMIT 1").bind(selectionId).first<SettlementRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Preferred dispatch settlement read is unavailable", true);
  }
}
async function decodeSelection(row: SelectionRow): Promise<ComputerAgentPreferredDispatchSelection> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Preferred selection is not valid JSON"); }
  const parsed = ComputerAgentPreferredDispatchSelectionSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.selection_id !== row.selection_id || parsed.data.project_id !== row.project_id ||
      parsed.data.task_kind !== row.task_kind ||
      parsed.data.selection_strategy !== row.selection_strategy ||
      parsed.data.transport !== row.transport || parsed.data.route_revision !== row.route_revision ||
      parsed.data.priority !== row.priority || parsed.data.connection_id !== row.connection_id ||
      parsed.data.connection_revision !== row.connection_revision ||
      parsed.data.client_grant_id !== row.client_grant_id ||
      parsed.data.client_grant_revision !== row.client_grant_revision ||
      parsed.data.owner_principal_ref !== row.owner_principal_ref ||
      parsed.data.owner_credential_generation !== row.owner_credential_generation ||
      parsed.data.qualification.challenge_id !== row.qualification_challenge_id ||
      parsed.data.qualification.observation_ref !== row.qualification_observation_ref ||
      parsed.data.qualification.verified_credential_generation !==
        row.qualification_credential_generation ||
      parsed.data.qualification.ready_until !== row.qualification_ready_until ||
      parsed.data.qualification.deployment_generation !== row.deployment_generation ||
      parsed.data.run_request_sha256 !== row.run_request_sha256 ||
      parsed.data.idempotency_key !== row.idempotency_key ||
      parsed.data.request_sha256 !== row.request_sha256 ||
      parsed.data.selected_at !== row.selected_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Preferred selection identity is corrupt");
  }
  return parsed.data;
}
async function decodeSettlement(row: SettlementRow): Promise<ComputerAgentPreferredDispatchSettlement> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Preferred dispatch settlement is not valid JSON"); }
  const parsed = ComputerAgentPreferredDispatchSettlementSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.selection_id !== row.selection_id || parsed.data.dispatch_id !== row.dispatch_id ||
      parsed.data.settled_at !== row.settled_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Preferred dispatch settlement identity is corrupt");
  }
  return parsed.data;
}
function requireDispatchMatch(dispatch: ComputerAgentDispatch,
  selection: ComputerAgentPreferredDispatchSelection, runRequest: unknown): void {
  if (dispatch.project_id !== selection.project_id || dispatch.task_kind !== selection.task_kind ||
      dispatch.transport !== selection.transport || dispatch.route_revision !== selection.route_revision ||
      dispatch.priority !== selection.priority || dispatch.connection_id !== selection.connection_id ||
      dispatch.connection_revision !== selection.connection_revision ||
      dispatch.client_grant_id !== selection.client_grant_id ||
      dispatch.client_grant_revision !== selection.client_grant_revision ||
      dispatch.owner_principal_ref !== selection.owner_principal_ref ||
      dispatch.owner_credential_generation !== selection.owner_credential_generation ||
      canonicalJson(dispatch.qualification) !== canonicalJson(selection.qualification) ||
      dispatch.run_request_sha256 !== selection.run_request_sha256 ||
      canonicalJson(dispatch.run_request) !== canonicalJson(runRequest)) {
    fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
      "Preferred selection settled a different exact dispatch");
  }
}
async function receipt(db: D1Database, selection: ComputerAgentPreferredDispatchSelection,
  settlement: ComputerAgentPreferredDispatchSettlement, runRequest: unknown,
): Promise<ComputerAgentPreferredDispatchReceipt> {
  const row = await readComputerAgentDispatchRow(db, settlement.dispatch_id);
  if (row === null) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Preferred settlement references a missing dispatch");
  const dispatch = await decodeComputerAgentDispatch(row);
  requireDispatchMatch(dispatch, selection, runRequest);
  return ComputerAgentPreferredDispatchReceiptSchema.parse({
    protocol: "eliotr.computer-agent-preferred-dispatch-receipt.v1",
    selection,
    settlement,
    dispatch,
  });
}

export function createComputerAgentPreferredDispatchService(runtime: ComputerAgentRuntime, options: {
  readonly now?: () => number;
  readonly create_dispatch_service: (options: {
    now: () => number;
    allow_preferred_internal_key: true;
  }) => {
    create(context: AuthenticatedRequestContext, projectId: string, input: unknown): Promise<ComputerAgentDispatch>;
  };
}) {
  const db = runtime.database;
  const now = options?.now ?? Date.now;

  async function create(context: AuthenticatedRequestContext,
    projectIdValue: string, rawInput: unknown): Promise<ComputerAgentPreferredDispatchReceipt> {
    await requireSchema(db);
    const identity = owner(context, now);
    const projectId = identifier(projectIdValue, "project_id");
    const parsed = ComputerAgentPreferredDispatchCreateSchema.safeParse(rawInput);
    if (!parsed.success || parsed.data.run_request.scope_expression.project_id !== projectId) {
      fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
        "Preferred dispatch input contains unknown, invalid or cross-project fields");
    }
    const key = idempotency(context.request.headers.get("Idempotency-Key"));
    const requestSha = await sha256Utf8(canonicalJson({
      protocol: "eliotr.computer-agent-preferred-dispatch-create.v1",
      project_id: projectId,
      owner_principal_ref: identity.principal_ref,
      input: parsed.data,
    }));
    let row = await readSelectionReplay(db, identity.principal_ref, key);
    if (row !== null && (row.project_id !== projectId || row.request_sha256 !== requestSha)) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Idempotency-Key is already bound to another preferred selection");
    }
    if (row === null) {
      const readiness = await readProjectComputerAgentRouteReadiness({
        database: db,
        context,
        project_id: projectId,
        task_kind: TASK_KIND,
        transport: parsed.data.transport,
        deployment_generation: runtime.deployment_generation,
        now,
      }).catch(mapReadiness);
      if (readiness.route_state !== "ACTIVE" ||
          readiness.route_revision !== parsed.data.expected_route_revision ||
          readiness.preferred_ready_connection === null) {
        fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
          "The expected route has no READY preferred connection for this transport");
      }
      const preferred = readiness.preferred_ready_connection;
      const entry = readiness.entries[preferred.priority];
      const qualification = entry?.qualification;
      if (entry === undefined || !entry.eligible ||
          entry.connection_id !== preferred.connection_id ||
          entry.connection_revision !== preferred.connection_revision ||
          qualification?.status !== "READY" || qualification.observation_ref === undefined ||
          qualification.verified_credential_generation === undefined ||
          qualification.ready_until === undefined ||
          qualification.deployment_generation !== runtime.deployment_generation) {
        fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
          "Preferred readiness report is internally inconsistent");
      }
      const runRequestSha = await sha256Utf8(canonicalJson(parsed.data.run_request));
      const selection = ComputerAgentPreferredDispatchSelectionSchema.parse({
        protocol: "eliotr.computer-agent-preferred-selection.v1",
        selection_id: `preferred-selection-${requestSha.slice(0, 48)}`,
        project_id: projectId,
        task_kind: TASK_KIND,
        selection_strategy: "FIRST_READY",
        transport: parsed.data.transport,
        route_revision: readiness.route_revision,
        priority: entry.priority,
        connection_id: entry.connection_id,
        connection_revision: entry.connection_revision,
        client_grant_id: parsed.data.client_grant_id,
        client_grant_revision: parsed.data.client_grant_revision,
        owner_principal_ref: identity.principal_ref,
        owner_credential_generation: identity.credential_generation,
        qualification: {
          challenge_id: qualification.challenge_id,
          observation_ref: qualification.observation_ref,
          verified_credential_generation: qualification.verified_credential_generation,
          ready_until: qualification.ready_until,
          deployment_generation: qualification.deployment_generation,
        },
        run_request_sha256: runRequestSha,
        idempotency_key: key,
        request_sha256: requestSha,
        selected_at: readiness.observed_at,
      });
      const record = canonicalJson(selection);
      const digest = await sha256Utf8(record);
      owner(context, now);
      try {
        await db.prepare("INSERT INTO computer_agent_preferred_dispatch_selection(" +
          "selection_id,project_id,task_kind,selection_strategy,transport,route_revision,priority," +
          "connection_id,connection_revision,client_grant_id,client_grant_revision," +
          "owner_principal_ref,owner_credential_generation,qualification_challenge_id," +
          "qualification_observation_ref,qualification_credential_generation," +
          "qualification_ready_until,deployment_generation,run_request_sha256,idempotency_key," +
          "request_sha256,record_json,record_sha256,selected_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16," +
          "?17,?18,?19,?20,?21,?22,?23,?24)")
          .bind(selection.selection_id, selection.project_id, selection.task_kind,
            selection.selection_strategy, selection.transport, selection.route_revision,
            selection.priority, selection.connection_id, selection.connection_revision,
            selection.client_grant_id, selection.client_grant_revision,
            selection.owner_principal_ref, selection.owner_credential_generation,
            selection.qualification.challenge_id, selection.qualification.observation_ref,
            selection.qualification.verified_credential_generation,
            selection.qualification.ready_until,
            selection.qualification.deployment_generation, selection.run_request_sha256,
            selection.idempotency_key, selection.request_sha256, record, digest,
            selection.selected_at).run();
      } catch { /* Immutable owner/key readback below reconciles the selection intent. */ }
      row = await readSelectionReplay(db, identity.principal_ref, key);
      if (row === null) fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
        "Preferred selection acknowledgement is uncertain; retry the same request", true);
      const recorded = await decodeSelection(row);
      if (canonicalJson(recorded) !== record) fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
        "Preferred selection readback differs from the intended record");
    }
    const selection = await decodeSelection(row);
    if (selection.request_sha256 !== requestSha ||
        selection.run_request_sha256 !== await sha256Utf8(canonicalJson(parsed.data.run_request))) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Preferred selection is bound to another request");
    }
    let settlementRow = await readSettlement(db, selection.selection_id);
    if (settlementRow !== null) {
      owner(context, now);
      return receipt(db, selection, await decodeSettlement(settlementRow), parsed.data.run_request);
    }
    if (selection.owner_credential_generation !== identity.credential_generation) {
      fail("COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
        "Unsettled preferred selection belongs to another owner credential generation");
    }
    const internalKey = `${INTERNAL_PREFIX}${selection.request_sha256.slice(0, 48)}`;
    const existing = await readComputerAgentDispatchReplay(db, identity.principal_ref, internalKey);
    let dispatch: ComputerAgentDispatch;
    if (existing !== null) {
      dispatch = await decodeComputerAgentDispatch(existing);
      requireDispatchMatch(dispatch, selection, parsed.data.run_request);
    } else {
      const headers = new Headers(context.request.headers);
      headers.set("Idempotency-Key", internalKey);
      headers.set("Content-Type", "application/json");
      const internalContext: AuthenticatedRequestContext = {
        ...context,
        request: new Request(context.request.url, {
          method: "POST",
          headers,
          signal: context.request.signal,
        }),
      };
      dispatch = await options.create_dispatch_service({
        now,
        allow_preferred_internal_key: true,
      }).create(internalContext, projectId, {
        transport: selection.transport,
        expected_route_revision: selection.route_revision,
        connection_id: selection.connection_id,
        connection_revision: selection.connection_revision,
        client_grant_id: selection.client_grant_id,
        client_grant_revision: selection.client_grant_revision,
        expires_in_seconds: parsed.data.expires_in_seconds,
        run_request: parsed.data.run_request,
      });
      requireDispatchMatch(dispatch, selection, parsed.data.run_request);
    }
    const settlement = ComputerAgentPreferredDispatchSettlementSchema.parse({
      protocol: "eliotr.computer-agent-preferred-dispatch-settlement.v1",
      selection_id: selection.selection_id,
      dispatch_id: dispatch.dispatch_id,
      settled_at: dispatch.created_at,
    });
    const settlementJson = canonicalJson(settlement);
    const settlementSha = await sha256Utf8(settlementJson);
    owner(context, now);
    try {
      await db.prepare("INSERT INTO computer_agent_preferred_dispatch_settlement(" +
        "selection_id,dispatch_id,record_json,record_sha256,settled_at) VALUES (?1,?2,?3,?4,?5)")
        .bind(settlement.selection_id, settlement.dispatch_id, settlementJson,
          settlementSha, settlement.settled_at).run();
    } catch { /* Exact immutable selection settlement readback below reconciles lost ACK. */ }
    settlementRow = await readSettlement(db, selection.selection_id);
    if (settlementRow === null) fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
      "Preferred dispatch settlement is uncertain; retry the same request", true);
    const recordedSettlement = await decodeSettlement(settlementRow);
    if (canonicalJson(recordedSettlement) !== settlementJson) {
      fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
        "Preferred dispatch settlement readback differs from the intended record");
    }
    owner(context, now);
    return ComputerAgentPreferredDispatchReceiptSchema.parse({
      protocol: "eliotr.computer-agent-preferred-dispatch-receipt.v1",
      selection,
      settlement: recordedSettlement,
      dispatch,
    });
  }
  return Object.freeze({ create });
}
