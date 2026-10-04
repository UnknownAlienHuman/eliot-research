import {
  ComputerAgentDispatchReassignSchema,
  ComputerAgentDispatchReassignmentSchema,
  type ComputerAgentDispatch,
  type ComputerAgentDispatchCreate,
  type ComputerAgentDispatchReassignment,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  decodeComputerAgentDispatch,
  decodeComputerAgentDispatchReassignment,
  readComputerAgentDispatchReassignmentReplay,
  readComputerAgentDispatchReassignmentRow,
  readComputerAgentDispatchRow,
} from "./computer-agent-dispatch-record.js";
import { failComputerAgentDispatch as fail } from "./computer-agent-dispatch-error.js";
import { readComputerAgentDispatchStatus } from "./computer-agent-dispatch-status.js";
import type { ComputerAgentRuntime } from "./runtime.js";

const SCHEMA_GENERATION = "computer-agent-dispatch-reassignment-v1";
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
    "Dispatch reassignment clock is unavailable", true); }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", 503,
      "Dispatch reassignment clock is invalid", true);
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
    credential_generation: identifier(context.credential_generation,
      "owner credential generation"),
  });
}
async function requireSchema(db: D1Database): Promise<void> {
  let value: string | null;
  try {
    value = await db.prepare(
      "SELECT value FROM schema_state " +
      "WHERE key='computer_agent_dispatch_reassignment_generation'",
    ).first<string>("value");
  } catch {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent dispatch reassignment migration 0093 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("COMPUTER_AGENT_DISPATCH_SCHEMA_NOT_READY", 503,
      "Computer-agent dispatch reassignment migration 0093 is required", true);
  }
}
function derivedContext(
  context: AuthenticatedRequestContext,
  successorKey: string,
): AuthenticatedRequestContext {
  const headers = new Headers(context.request.headers);
  headers.set("Idempotency-Key", successorKey);
  return Object.freeze({
    ...context,
    request: new Request(context.request.url, {
      method: "POST",
      headers,
      signal: context.request.signal,
    }),
  });
}

export function createComputerAgentDispatchReassignmentService(
  runtime: ComputerAgentRuntime,
  options: {
    readonly now?: () => number;
    readonly create_dispatch_service: (options: { now: () => number }) => {
      create(context: AuthenticatedRequestContext, projectId: string, input: unknown): Promise<ComputerAgentDispatch>;
    };
  },
) {
  const db = runtime.database;
  const now = options?.now ?? Date.now;

  async function reassign(
    context: AuthenticatedRequestContext,
    projectIdValue: string,
    predecessorIdValue: string,
    rawInput: unknown,
  ): Promise<ComputerAgentDispatchReassignment> {
    await requireSchema(db);
    const identity = owner(context, now);
    const projectId = identifier(projectIdValue, "project_id");
    const predecessorId = identifier(predecessorIdValue, "predecessor dispatch_id");
    const parsed = ComputerAgentDispatchReassignSchema.safeParse(rawInput);
    if (!parsed.success) {
      fail("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 400,
        "Dispatch reassignment contains unknown or invalid fields");
    }
    const key = idempotency(context.request.headers.get("Idempotency-Key"));
    const predecessorRow = await readComputerAgentDispatchRow(db, predecessorId);
    if (predecessorRow === null) {
      fail("COMPUTER_AGENT_DISPATCH_NOT_FOUND", 404,
        "Predecessor dispatch does not exist");
    }
    const predecessor = await decodeComputerAgentDispatch(predecessorRow);
    if (predecessor.project_id !== projectId ||
        predecessor.owner_principal_ref !== identity.principal_ref) {
      fail("COMPUTER_AGENT_DISPATCH_NOT_FOUND", 404,
        "Predecessor dispatch does not exist in this owner project");
    }
    const current = instant(now);
    const status = await readComputerAgentDispatchStatus({
      database: db,
      dispatch: predecessor,
      now: current,
    });
    if (status.state !== "ABANDONED" && status.state !== "DECLINED") {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Only an abandoned or declined predecessor may be reassigned");
    }
    if (status.state !== parsed.data.expected_predecessor_state) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Predecessor terminal state changed before reassignment");
    }
    if (parsed.data.expected_run_request_sha256 !== predecessor.run_request_sha256) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Frozen Research request changed before reassignment");
    }
    const requestSha = await sha256Utf8(canonicalJson({
      protocol: "eliotr.computer-agent-dispatch-reassignment-request.v1",
      predecessor_dispatch_id: predecessor.dispatch_id,
      project_id: projectId,
      owner_principal_ref: identity.principal_ref,
      idempotency_key: key,
      input: parsed.data,
    }));
    const [byPredecessor, replay] = await Promise.all([
      readComputerAgentDispatchReassignmentRow(db, predecessor.dispatch_id),
      readComputerAgentDispatchReassignmentReplay(db, identity.principal_ref, key),
    ]);
    const existing = byPredecessor ?? replay;
    if (existing !== null) {
      if (existing.predecessor_dispatch_id !== predecessor.dispatch_id ||
          existing.request_sha256 !== requestSha ||
          existing.idempotency_key !== key) {
        fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
          "Dispatch or Idempotency-Key is already bound to another reassignment");
      }
      owner(context, now);
      return decodeComputerAgentDispatchReassignment(existing);
    }

    const successorKeyDigest = await sha256Utf8(canonicalJson({
      protocol: "eliotr.computer-agent-dispatch-reassignment-successor-key.v1",
      predecessor_dispatch_id: predecessor.dispatch_id,
      owner_principal_ref: identity.principal_ref,
      reassignment_idempotency_key: key,
      reassignment_request_sha256: requestSha,
    }));
    const successorInput: ComputerAgentDispatchCreate = {
      transport: parsed.data.transport,
      expected_route_revision: parsed.data.expected_route_revision,
      connection_id: parsed.data.connection_id,
      connection_revision: parsed.data.connection_revision,
      client_grant_id: parsed.data.client_grant_id,
      client_grant_revision: parsed.data.client_grant_revision,
      expires_in_seconds: parsed.data.expires_in_seconds,
      run_request: predecessor.run_request,
    };
    const successor = await options.create_dispatch_service({ now }).create(
      derivedContext(context, `computer-agent-reassign:${successorKeyDigest}`),
      projectId,
      successorInput,
    );
    if (successor.dispatch_id === predecessor.dispatch_id ||
        successor.project_id !== predecessor.project_id ||
        successor.owner_principal_ref !== identity.principal_ref ||
        successor.run_request_sha256 !== predecessor.run_request_sha256 ||
        successor.transport !== parsed.data.transport ||
        successor.route_revision !== parsed.data.expected_route_revision ||
        successor.connection_id !== parsed.data.connection_id ||
        successor.connection_revision !== parsed.data.connection_revision ||
        successor.client_grant_id !== parsed.data.client_grant_id ||
        successor.client_grant_revision !== parsed.data.client_grant_revision) {
      fail("COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT", 500,
        "Successor dispatch readback differs from the reassignment request");
    }
    const reassignedAt = new Date(instant(now)).toISOString();
    const receipt = ComputerAgentDispatchReassignmentSchema.parse({
      protocol: "eliotr.computer-agent-dispatch-reassigned.v1",
      predecessor_dispatch_id: predecessor.dispatch_id,
      successor_dispatch_id: successor.dispatch_id,
      project_id: projectId,
      owner_principal_ref: identity.principal_ref,
      owner_credential_generation: identity.credential_generation,
      predecessor_state: status.state,
      run_request_sha256: predecessor.run_request_sha256,
      successor_transport: successor.transport,
      successor_route_revision: successor.route_revision,
      successor_connection_id: successor.connection_id,
      successor_connection_revision: successor.connection_revision,
      successor_client_grant_id: successor.client_grant_id,
      successor_client_grant_revision: successor.client_grant_revision,
      idempotency_key: key,
      request_sha256: requestSha,
      reassigned_at: reassignedAt,
    });
    const record = canonicalJson(receipt);
    const recordSha = await sha256Utf8(record);
    owner(context, now);
    let mutationError: unknown;
    try {
      await db.prepare("INSERT INTO computer_agent_dispatch_reassignment(" +
        "predecessor_dispatch_id,successor_dispatch_id,project_id,owner_principal_ref," +
        "owner_credential_generation,predecessor_state,run_request_sha256," +
        "successor_transport,successor_route_revision,successor_connection_id," +
        "successor_connection_revision,successor_client_grant_id," +
        "successor_client_grant_revision,idempotency_key,request_sha256,record_json," +
        "record_sha256,reassigned_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9," +
        "?10,?11,?12,?13,?14,?15,?16,?17,?18)")
        .bind(receipt.predecessor_dispatch_id, receipt.successor_dispatch_id,
          receipt.project_id, receipt.owner_principal_ref,
          receipt.owner_credential_generation, receipt.predecessor_state,
          receipt.run_request_sha256, receipt.successor_transport,
          receipt.successor_route_revision, receipt.successor_connection_id,
          receipt.successor_connection_revision, receipt.successor_client_grant_id,
          receipt.successor_client_grant_revision, receipt.idempotency_key,
          receipt.request_sha256, record, recordSha, receipt.reassigned_at).run();
    } catch (error) { mutationError = error; }
    const settled = await readComputerAgentDispatchReassignmentRow(
      db, predecessor.dispatch_id,
    );
    if (settled === null) {
      fail("COMPUTER_AGENT_DISPATCH_SETTLEMENT_UNCERTAIN", 503,
        mutationError === undefined ? "Dispatch reassignment was not recorded" :
          "Dispatch reassignment acknowledgement is uncertain", true);
    }
    const decoded = await decodeComputerAgentDispatchReassignment(settled);
    if (canonicalJson(decoded) !== record) {
      fail("COMPUTER_AGENT_DISPATCH_IDENTITY_CONFLICT", 409,
        "Recorded reassignment differs from the requested successor");
    }
    owner(context, now);
    return decoded;
  }

  return { reassign };
}
