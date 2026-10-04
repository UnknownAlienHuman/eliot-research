import {
  ComputerAgentDispatchDeclineReceiptSchema,
  ComputerAgentDispatchDeclineSchema,
  type ComputerAgentDispatchDeclineReceipt,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  decodeComputerAgentDispatch,
  decodeComputerAgentDispatchDecline,
  readComputerAgentDispatchAbandonmentRow,
  readComputerAgentDispatchAcceptanceRow,
  readComputerAgentDispatchDeclineReplay,
  readComputerAgentDispatchDeclineRow,
  readComputerAgentDispatchRow,
} from "./computer-agent-dispatch-record.js";
import { failComputerAgentDispatch as fail } from "./computer-agent-dispatch-error.js";

const SCHEMA_GENERATION = "computer-agent-dispatch-decline-v1";
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
    "Dispatch decline clock is unavailable", true); }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch decline clock is invalid", true);
  }
  return value;
}
function serviceIdentity(context: AuthenticatedRequestContext, now: () => number) {
  const current = instant(now);
  const access = context.access;
  if ((context.client_class !== "trusted_agent" &&
      context.client_class !== "named_api_client") ||
      access === undefined || access.authentication_method !== "service_token" ||
      typeof access.issuer !== "string" ||
      access.principal_ref !== context.principal_ref ||
      access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(access.expires_at)) ||
      Date.parse(access.expires_at) <= current ||
      context.request.signal.aborted) {
    fail("COMPUTER_AGENT_DISPATCH_SERVICE_REQUIRED", 403,
      "A current verified service-token actor is required");
  }
  return Object.freeze({
    issuer: identifier(access.issuer, "actor issuer"),
    subject: identifier(context.principal_ref, "actor subject"),
    credential_generation: identifier(context.credential_generation,
      "actor credential generation"),
  });
}
async function requireSchema(db: D1Database): Promise<void> {
  let value: string | null;
  try {
    value = await db.prepare(
      "SELECT value FROM schema_state WHERE key='computer_agent_dispatch_decline_generation'",
    ).first<string>("value");
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent dispatch decline migration 0092 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent dispatch decline migration 0092 is required", true);
  }
}

export function createComputerAgentDispatchDeclineService(options: {
  readonly database: D1Database;
  readonly now?: () => number;
}) {
  const db = options.database;
  const now = options.now ?? Date.now;

  async function decline(
    context: AuthenticatedRequestContext,
    dispatchIdValue: string,
    rawInput: unknown,
  ): Promise<ComputerAgentDispatchDeclineReceipt> {
    await requireSchema(db);
    const identity = serviceIdentity(context, now);
    const dispatchId = identifier(dispatchIdValue, "dispatch_id");
    const parsed = ComputerAgentDispatchDeclineSchema.safeParse(rawInput);
    if (!parsed.success) {
      fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
        "Dispatch decline contains unknown or invalid fields");
    }
    const key = idempotency(context.request.headers.get("Idempotency-Key"));
    const row = await readComputerAgentDispatchRow(db, dispatchId);
    if (row === null) {
      fail("COMPUTER_AGENT_DISPATCH_NOT_FOUND", 404,
        "Computer-agent dispatch does not exist");
    }
    const dispatch = await decodeComputerAgentDispatch(row);
    if (dispatch.actor.issuer !== identity.issuer ||
        dispatch.actor.subject !== identity.subject ||
        dispatch.qualification.verified_credential_generation !==
          identity.credential_generation) {
      fail("COMPUTER_AGENT_DISPATCH_DENIED", 403,
        "Only the exact selected actor credential generation may decline this dispatch");
    }
    const requestSha = await sha256Utf8(canonicalJson({
      protocol: "eliotr.computer-agent-dispatch-decline-request.v1",
      dispatch_id: dispatch.dispatch_id,
      connection_id: dispatch.connection_id,
      connection_revision: dispatch.connection_revision,
      actor: dispatch.actor,
      credential_generation: identity.credential_generation,
      idempotency_key: key,
      input: parsed.data,
    }));
    const replay = await readComputerAgentDispatchDeclineReplay(
      db, identity.issuer, identity.subject, key,
    );
    if (replay !== null) {
      if (replay.dispatch_id !== dispatch.dispatch_id ||
          replay.request_sha256 !== requestSha) {
        fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
          "Idempotency-Key is already bound to another dispatch decline");
      }
      serviceIdentity(context, now);
      return decodeComputerAgentDispatchDecline(replay);
    }
    const existing = await readComputerAgentDispatchDeclineRow(db, dispatch.dispatch_id);
    if (existing !== null) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Dispatch was already declined by another immutable action");
    }
    const [acceptance, abandonment] = await Promise.all([
      readComputerAgentDispatchAcceptanceRow(db, dispatch.dispatch_id),
      readComputerAgentDispatchAbandonmentRow(db, dispatch.dispatch_id),
    ]);
    if (acceptance !== null || abandonment !== null) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Accepted or abandoned dispatch cannot be declined");
    }
    const declinedAt = new Date(instant(now)).toISOString();
    const receipt = ComputerAgentDispatchDeclineReceiptSchema.parse({
      protocol: "eliotr.computer-agent-dispatch-declined.v1",
      dispatch_id: dispatch.dispatch_id,
      project_id: dispatch.project_id,
      connection_id: dispatch.connection_id,
      connection_revision: dispatch.connection_revision,
      actor: dispatch.actor,
      credential_generation: identity.credential_generation,
      reason: parsed.data.reason,
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
      idempotency_key: key,
      request_sha256: requestSha,
      declined_at: declinedAt,
    });
    const record = canonicalJson(receipt);
    const digest = await sha256Utf8(record);
    serviceIdentity(context, now);
    try {
      await db.prepare("INSERT INTO computer_agent_dispatch_decline(" +
        "dispatch_id,project_id,connection_id,connection_revision,actor_issuer,actor_subject," +
        "credential_generation,reason,note,idempotency_key,request_sha256,record_json," +
        "record_sha256,declined_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)")
        .bind(receipt.dispatch_id, receipt.project_id, receipt.connection_id,
          receipt.connection_revision, receipt.actor.issuer, receipt.actor.subject,
          receipt.credential_generation, receipt.reason, receipt.note ?? null,
          receipt.idempotency_key, receipt.request_sha256, record, digest,
          receipt.declined_at).run();
    } catch { /* Immutable readback below reconciles lost acknowledgements and races. */ }
    const settled = await readComputerAgentDispatchDeclineRow(db, dispatch.dispatch_id);
    if (settled === null) {
      fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
        "Dispatch decline receipt is unavailable; retry with the same Idempotency-Key", true);
    }
    if (settled.request_sha256 !== requestSha || settled.idempotency_key !== key) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Dispatch settled another decline action");
    }
    const decoded = await decodeComputerAgentDispatchDecline(settled);
    if (canonicalJson(decoded) !== record) {
      fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
        "Dispatch decline readback differs from the intended record");
    }
    serviceIdentity(context, now);
    return decoded;
  }

  return { decline };
}
