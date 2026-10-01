import {
  ComputerAgentDispatchAbandonmentSchema,
  ComputerAgentDispatchAcceptanceSchema,
  ComputerAgentDispatchDeclineReceiptSchema,
  ComputerAgentDispatchReassignmentSchema,
  ComputerAgentDispatchSchema,
  type ComputerAgentDispatch,
  type ComputerAgentDispatchAbandonment,
  type ComputerAgentDispatchAcceptance,
  type ComputerAgentDispatchDeclineReceipt,
  type ComputerAgentDispatchReassignment,
} from "@eliotr/contracts";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { failComputerAgentDispatch as fail } from "./computer-agent-dispatch-error.js";

export interface DispatchRow {
  dispatch_id: string;
  project_id: string;
  task_kind: string;
  transport: string;
  route_revision: number;
  priority: number;
  connection_id: string;
  connection_revision: number;
  client_grant_id: string;
  client_grant_revision: number;
  owner_principal_ref: string;
  owner_credential_generation: string;
  actor_issuer: string;
  actor_subject: string;
  qualification_challenge_id: string;
  qualification_observation_ref: string;
  qualification_credential_generation: string;
  deployment_generation: string;
  idempotency_key: string;
  request_sha256: string;
  run_request_sha256: string;
  record_json: string;
  record_sha256: string;
  created_at: string;
  expires_at: string;
}
export interface AcceptanceRow {
  dispatch_id: string;
  workflow_instance_id: string;
  investigation_id: string;
  investigation_revision: number;
  actor_issuer: string;
  actor_subject: string;
  credential_generation: string;
  record_json: string;
  record_sha256: string;
  accepted_at: string;
}
export interface AbandonmentRow {
  dispatch_id: string;
  project_id: string;
  owner_principal_ref: string;
  owner_credential_generation: string;
  reason: string;
  note: string | null;
  idempotency_key: string;
  request_sha256: string;
  record_json: string;
  record_sha256: string;
  abandoned_at: string;
}
export interface DeclineRow {
  dispatch_id: string;
  project_id: string;
  connection_id: string;
  connection_revision: number;
  actor_issuer: string;
  actor_subject: string;
  credential_generation: string;
  reason: string;
  note: string | null;
  idempotency_key: string;
  request_sha256: string;
  record_json: string;
  record_sha256: string;
  declined_at: string;
}
export interface ReassignmentRow {
  predecessor_dispatch_id: string;
  successor_dispatch_id: string;
  project_id: string;
  owner_principal_ref: string;
  owner_credential_generation: string;
  predecessor_state: string;
  run_request_sha256: string;
  successor_transport: string;
  successor_route_revision: number;
  successor_connection_id: string;
  successor_connection_revision: number;
  successor_client_grant_id: string;
  successor_client_grant_revision: number;
  idempotency_key: string;
  request_sha256: string;
  record_json: string;
  record_sha256: string;
  reassigned_at: string;
}

export async function decodeComputerAgentDispatch(row: DispatchRow): Promise<ComputerAgentDispatch> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Dispatch record is not valid JSON"); }
  const parsed = ComputerAgentDispatchSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      await sha256Utf8(canonicalJson(parsed.data.run_request)) !== row.run_request_sha256 ||
      parsed.data.dispatch_id !== row.dispatch_id || parsed.data.project_id !== row.project_id ||
      parsed.data.task_kind !== row.task_kind || parsed.data.transport !== row.transport ||
      parsed.data.route_revision !== row.route_revision || parsed.data.priority !== row.priority ||
      parsed.data.connection_id !== row.connection_id ||
      parsed.data.connection_revision !== row.connection_revision ||
      parsed.data.client_grant_id !== row.client_grant_id ||
      parsed.data.client_grant_revision !== row.client_grant_revision ||
      parsed.data.owner_principal_ref !== row.owner_principal_ref ||
      parsed.data.owner_credential_generation !== row.owner_credential_generation ||
      parsed.data.actor.issuer !== row.actor_issuer || parsed.data.actor.subject !== row.actor_subject ||
      parsed.data.qualification.challenge_id !== row.qualification_challenge_id ||
      parsed.data.qualification.observation_ref !== row.qualification_observation_ref ||
      parsed.data.qualification.verified_credential_generation !==
        row.qualification_credential_generation ||
      parsed.data.qualification.deployment_generation !== row.deployment_generation ||
      parsed.data.run_request_sha256 !== row.run_request_sha256 ||
      parsed.data.created_at !== row.created_at || parsed.data.expires_at !== row.expires_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch record identity is corrupt");
  }
  return parsed.data;
}

export async function decodeComputerAgentDispatchAcceptance(
  row: AcceptanceRow,
): Promise<ComputerAgentDispatchAcceptance> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Dispatch acceptance is not valid JSON"); }
  const parsed = ComputerAgentDispatchAcceptanceSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.dispatch_id !== row.dispatch_id ||
      parsed.data.workflow_instance_id !== row.workflow_instance_id ||
      parsed.data.investigation_ref.id !== row.investigation_id ||
      parsed.data.investigation_ref.revision !== row.investigation_revision ||
      parsed.data.actor.issuer !== row.actor_issuer || parsed.data.actor.subject !== row.actor_subject ||
      parsed.data.credential_generation !== row.credential_generation ||
      parsed.data.accepted_at !== row.accepted_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch acceptance identity is corrupt");
  }
  return parsed.data;
}

export async function decodeComputerAgentDispatchAbandonment(
  row: AbandonmentRow,
): Promise<ComputerAgentDispatchAbandonment> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Dispatch abandonment is not valid JSON"); }
  const parsed = ComputerAgentDispatchAbandonmentSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.dispatch_id !== row.dispatch_id || parsed.data.project_id !== row.project_id ||
      parsed.data.owner_principal_ref !== row.owner_principal_ref ||
      parsed.data.owner_credential_generation !== row.owner_credential_generation ||
      parsed.data.reason !== row.reason || (parsed.data.note ?? null) !== row.note ||
      parsed.data.idempotency_key !== row.idempotency_key ||
      parsed.data.request_sha256 !== row.request_sha256 ||
      parsed.data.abandoned_at !== row.abandoned_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch abandonment identity is corrupt");
  }
  return parsed.data;
}

export async function decodeComputerAgentDispatchDecline(
  row: DeclineRow,
): Promise<ComputerAgentDispatchDeclineReceipt> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Dispatch decline is not valid JSON"); }
  const parsed = ComputerAgentDispatchDeclineReceiptSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.dispatch_id !== row.dispatch_id || parsed.data.project_id !== row.project_id ||
      parsed.data.connection_id !== row.connection_id ||
      parsed.data.connection_revision !== row.connection_revision ||
      parsed.data.actor.issuer !== row.actor_issuer ||
      parsed.data.actor.subject !== row.actor_subject ||
      parsed.data.credential_generation !== row.credential_generation ||
      parsed.data.reason !== row.reason || (parsed.data.note ?? null) !== row.note ||
      parsed.data.idempotency_key !== row.idempotency_key ||
      parsed.data.request_sha256 !== row.request_sha256 ||
      parsed.data.declined_at !== row.declined_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch decline identity is corrupt");
  }
  return parsed.data;
}

export async function decodeComputerAgentDispatchReassignment(
  row: ReassignmentRow,
): Promise<ComputerAgentDispatchReassignment> {
  let raw: unknown;
  try { raw = JSON.parse(row.record_json); }
  catch { return fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
    "Dispatch reassignment is not valid JSON"); }
  const parsed = ComputerAgentDispatchReassignmentSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data) !== row.record_json ||
      await sha256Utf8(row.record_json) !== row.record_sha256 ||
      parsed.data.predecessor_dispatch_id !== row.predecessor_dispatch_id ||
      parsed.data.successor_dispatch_id !== row.successor_dispatch_id ||
      parsed.data.project_id !== row.project_id ||
      parsed.data.owner_principal_ref !== row.owner_principal_ref ||
      parsed.data.owner_credential_generation !== row.owner_credential_generation ||
      parsed.data.predecessor_state !== row.predecessor_state ||
      parsed.data.run_request_sha256 !== row.run_request_sha256 ||
      parsed.data.successor_transport !== row.successor_transport ||
      parsed.data.successor_route_revision !== row.successor_route_revision ||
      parsed.data.successor_connection_id !== row.successor_connection_id ||
      parsed.data.successor_connection_revision !== row.successor_connection_revision ||
      parsed.data.successor_client_grant_id !== row.successor_client_grant_id ||
      parsed.data.successor_client_grant_revision !== row.successor_client_grant_revision ||
      parsed.data.idempotency_key !== row.idempotency_key ||
      parsed.data.request_sha256 !== row.request_sha256 ||
      parsed.data.reassigned_at !== row.reassigned_at) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
      "Dispatch reassignment identity is corrupt");
  }
  return parsed.data;
}

export async function readComputerAgentDispatchRow(
  db: D1Database,
  dispatchId: string,
): Promise<DispatchRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_dispatch WHERE dispatch_id=?1 LIMIT 1")
      .bind(dispatchId).first<DispatchRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch read is unavailable", true);
  }
}

export async function readComputerAgentDispatchReplay(
  db: D1Database,
  principal: string,
  key: string,
): Promise<DispatchRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_dispatch " +
      "WHERE owner_principal_ref=?1 AND idempotency_key=?2 LIMIT 1")
      .bind(principal, key).first<DispatchRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch replay read is unavailable", true);
  }
}

export async function readComputerAgentDispatchAcceptanceRow(
  db: D1Database,
  dispatchId: string,
): Promise<AcceptanceRow | null> {
  try {
    return await db.prepare(
      "SELECT * FROM computer_agent_dispatch_acceptance WHERE dispatch_id=?1 LIMIT 1",
    ).bind(dispatchId).first<AcceptanceRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch acceptance read is unavailable", true);
  }
}

export async function readComputerAgentDispatchAbandonmentRow(
  db: D1Database,
  dispatchId: string,
): Promise<AbandonmentRow | null> {
  try {
    return await db.prepare(
      "SELECT * FROM computer_agent_dispatch_abandonment WHERE dispatch_id=?1 LIMIT 1",
    ).bind(dispatchId).first<AbandonmentRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch abandonment read is unavailable", true);
  }
}

export async function readComputerAgentDispatchAbandonmentReplay(
  db: D1Database,
  principal: string,
  key: string,
): Promise<AbandonmentRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_dispatch_abandonment " +
      "WHERE owner_principal_ref=?1 AND idempotency_key=?2 LIMIT 1")
      .bind(principal, key).first<AbandonmentRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch abandonment replay read is unavailable", true);
  }
}

export async function readComputerAgentDispatchDeclineRow(
  db: D1Database,
  dispatchId: string,
): Promise<DeclineRow | null> {
  try {
    return await db.prepare(
      "SELECT * FROM computer_agent_dispatch_decline WHERE dispatch_id=?1 LIMIT 1",
    ).bind(dispatchId).first<DeclineRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch decline read is unavailable", true);
  }
}

export async function readComputerAgentDispatchDeclineReplay(
  db: D1Database,
  issuer: string,
  subject: string,
  key: string,
): Promise<DeclineRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_dispatch_decline " +
      "WHERE actor_issuer=?1 AND actor_subject=?2 AND idempotency_key=?3 LIMIT 1")
      .bind(issuer, subject, key).first<DeclineRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch decline replay read is unavailable", true);
  }
}

export async function readComputerAgentDispatchReassignmentRow(
  db: D1Database,
  predecessorDispatchId: string,
): Promise<ReassignmentRow | null> {
  try {
    return await db.prepare(
      "SELECT * FROM computer_agent_dispatch_reassignment " +
      "WHERE predecessor_dispatch_id=?1 LIMIT 1",
    ).bind(predecessorDispatchId).first<ReassignmentRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch reassignment read is unavailable", true);
  }
}

export async function readComputerAgentDispatchReassignmentReplay(
  db: D1Database,
  principal: string,
  key: string,
): Promise<ReassignmentRow | null> {
  try {
    return await db.prepare("SELECT * FROM computer_agent_dispatch_reassignment " +
      "WHERE owner_principal_ref=?1 AND idempotency_key=?2 LIMIT 1")
      .bind(principal, key).first<ReassignmentRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch reassignment replay read is unavailable", true);
  }
}

export async function readCurrentComputerAgentDispatchOffer(
  db: D1Database,
  dispatchId: string,
): Promise<DispatchRow | null> {
  try {
    return await db.prepare(
      "SELECT * FROM computer_agent_dispatch_offer_claimable WHERE dispatch_id=?1 LIMIT 1",
    ).bind(dispatchId).first<DispatchRow>();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Current dispatch authority is unavailable", true);
  }
}
