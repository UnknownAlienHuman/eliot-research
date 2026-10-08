import {
  ComputerAgentDispatchAbandonSchema,
  ComputerAgentDispatchAbandonmentSchema,
  type ComputerAgentDispatchAbandonment,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  decodeComputerAgentDispatch,
  decodeComputerAgentDispatchAbandonment,
  readComputerAgentDispatchAbandonmentReplay,
  readComputerAgentDispatchAbandonmentRow,
  readComputerAgentDispatchAcceptanceRow,
  readComputerAgentDispatchRow,
} from "./computer-agent-dispatch-record.js";
import {
  failComputerAgentDispatch as fail,
} from "./computer-agent-dispatch-error.js";

const SCHEMA_GENERATION = "computer-agent-dispatch-abandonment-v1";
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
    "Dispatch abandonment clock is unavailable", true); }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch abandonment clock is invalid", true);
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
  let value: string | null;
  try {
    value = await db.prepare(
      "SELECT value FROM schema_state WHERE key='computer_agent_dispatch_abandonment_generation'",
    ).first<string>("value");
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent dispatch abandonment migration 0091 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent dispatch abandonment migration 0091 is required", true);
  }
}
async function requireProjectOwner(
  db: D1Database,
  projectId: string,
  principal: string,
): Promise<void> {
  let row: unknown;
  try {
    row = await db.prepare(
      "SELECT 1 FROM project_owner WHERE project_id=?1 AND principal_ref=?2 LIMIT 1",
    ).bind(projectId, principal).first();
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Project owner authority read is unavailable", true);
  }
  if (row === null) {
    fail("COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", 403,
      "Current project owner authority is required");
  }
}

export function createComputerAgentDispatchAbandonmentService(options: {
  readonly database: D1Database;
  readonly now?: () => number;
}) {
  const db = options.database;
  const now = options.now ?? Date.now;

  async function abandon(
    context: AuthenticatedRequestContext,
    projectIdValue: string,
    dispatchIdValue: string,
    rawInput: unknown,
  ): Promise<ComputerAgentDispatchAbandonment> {
    await requireSchema(db);
    const identity = owner(context, now);
    const projectId = identifier(projectIdValue, "project_id");
    const dispatchId = identifier(dispatchIdValue, "dispatch_id");
    const parsed = ComputerAgentDispatchAbandonSchema.safeParse(rawInput);
    if (!parsed.success) {
      fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
        "Dispatch abandonment contains unknown or invalid fields");
    }
    const key = idempotency(context.request.headers.get("Idempotency-Key"));
    await requireProjectOwner(db, projectId, identity.principal_ref);
    const row = await readComputerAgentDispatchRow(db, dispatchId);
    if (row === null || row.project_id !== projectId) {
      fail("COMPUTER_AGENT_DISPATCH_NOT_FOUND", 404,
        "Computer-agent dispatch does not exist in this project");
    }
    const dispatch = await decodeComputerAgentDispatch(row);
    if (dispatch.owner_principal_ref !== identity.principal_ref) {
      fail("COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", 403,
        "Dispatch belongs to another project owner");
    }
    const requestSha = await sha256Utf8(canonicalJson({
      protocol: "eliotr.computer-agent-dispatch-abandon-request.v1",
      dispatch_id: dispatch.dispatch_id,
      project_id: projectId,
      owner_principal_ref: identity.principal_ref,
      idempotency_key: key,
      input: parsed.data,
    }));
    const replay = await readComputerAgentDispatchAbandonmentReplay(
      db, identity.principal_ref, key,
    );
    if (replay !== null) {
      if (replay.dispatch_id !== dispatch.dispatch_id || replay.project_id !== projectId ||
          replay.request_sha256 !== requestSha) {
        fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
          "Idempotency-Key is already bound to another dispatch abandonment");
      }
      owner(context, now);
      return decodeComputerAgentDispatchAbandonment(replay);
    }
    const existing = await readComputerAgentDispatchAbandonmentRow(db, dispatch.dispatch_id);
    if (existing !== null) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Dispatch was already abandoned by another immutable action");
    }
    if (await readComputerAgentDispatchAcceptanceRow(db, dispatch.dispatch_id) !== null) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Accepted dispatch cannot be abandoned; cancel the existing Research run instead");
    }
    const abandonedAt = new Date(instant(now)).toISOString();
    const abandonment = ComputerAgentDispatchAbandonmentSchema.parse({
      protocol: "eliotr.computer-agent-dispatch-abandoned.v1",
      dispatch_id: dispatch.dispatch_id,
      project_id: projectId,
      owner_principal_ref: identity.principal_ref,
      owner_credential_generation: identity.credential_generation,
      reason: parsed.data.reason,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
      idempotency_key: key,
      request_sha256: requestSha,
      abandoned_at: abandonedAt,
    });
    const record = canonicalJson(abandonment);
    const digest = await sha256Utf8(record);
    owner(context, now);
    try {
      await db.prepare("INSERT INTO computer_agent_dispatch_abandonment(" +
        "dispatch_id,project_id,owner_principal_ref,owner_credential_generation,reason,note," +
        "idempotency_key,request_sha256,record_json,record_sha256,abandoned_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)")
        .bind(abandonment.dispatch_id, abandonment.project_id,
          abandonment.owner_principal_ref, abandonment.owner_credential_generation,
          abandonment.reason, abandonment.note ?? null, abandonment.idempotency_key,
          abandonment.request_sha256, record, digest, abandonment.abandoned_at).run();
    } catch { /* Immutable readback below reconciles lost acknowledgements and races. */ }
    const settled = await readComputerAgentDispatchAbandonmentRow(db, dispatch.dispatch_id);
    if (settled === null) {
      fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
        "Dispatch abandonment receipt is unavailable; retry with the same Idempotency-Key", true);
    }
    if (settled.request_sha256 !== requestSha ||
        settled.idempotency_key !== key) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Dispatch settled another abandonment action");
    }
    const decoded = await decodeComputerAgentDispatchAbandonment(settled);
    if (canonicalJson(decoded) !== record) {
      fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
        "Dispatch abandonment readback differs from the intended record");
    }
    owner(context, now);
    return decoded;
  }

  return { abandon };
}
