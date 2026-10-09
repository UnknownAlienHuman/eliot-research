/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type DeliveryMessage } from "@eliotr/platform-cloudflare";
import { externalTaskCanonical, MAX_RESULT_BYTES } from "./external-agent-task-codec.js";
import { EXTERNAL_AGENT_RESULT_WAKE_TOPIC } from "./external-agent-result-outbox.js";
import { createExternalTaskResultDeliveryHandler } from "./external-task-result-delivery.js";
import { parseRequest } from "./types.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const context = { message_id: "delivery", idempotency_key: "key", topic: EXTERNAL_AGENT_RESULT_WAKE_TOPIC, attempt: 1 };

function fixture() {
  const digest = "a".repeat(64);
  const request = parseRequest({ protocol: "eliotr.workflow-stage.v1", operation_id: "run-1",
    investigation_ref: { id: "investigation-1", revision: 9 }, stage: "ANALYZE_BRANCHES", idempotency_key: "stage-1",
    handler_generation: "research-handlers.exploratory.external-wait.v1",
    input_manifest: { object_ref: "manifest-1", sha256: digest, byte_length: 1, residency: {
      scope_domain_id: "scope-1", access_domain_id: "access-1", confidentiality_domain_id: "confidential",
      encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
      content_digest: { algorithm: "sha256", digest },
    } },
  });
  const request_json = JSON.stringify(request);
  const request_sha256 = hash(request_json);
  const task_id = `external-task:${request_sha256}`;
  const submitted_at = new Date(Date.now() - 10_000).toISOString();
  const lease_id = "external-lease:12345678-1234-4123-8123-123456789012";
  const result_json = externalTaskCanonical({ protocol: "eliotr.external-agent-result.v1", task_id,
    operation_id: request.operation_id, stage_index: 8, stage: request.stage, attempt_ref: "attempt-1", request_sha256,
    lease_id, idempotency_key: "result-1", disposition: "SUCCEEDED", output: { private: "never-in-wake" },
    evidence_refs: [], diagnostics: [], usage: { accounting: "UNKNOWN" }, submitted_at }, MAX_RESULT_BYTES, "fixture");
  const result_sha256 = hash(result_json);
  const row = { task_id, operation_id: request.operation_id, stage_index: 8, stage: request.stage, attempt_ref: "attempt-1",
    request_sha256, request_json, grantee_subject: "actor-1", state: "RESULT_RECORDED", lease_id, lease_slot: "slot-1",
    lease_credential_generation: "credential-1", lease_revision: 1, lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    result_idempotency_key: "result-1", result_json, result_sha256,
    client_grant_revision: 1, created_at: new Date(Date.now() - 20_000).toISOString(), updated_at: submitted_at,
    budget_expires_at_ms: Date.now() - 1_000 };
  const intent_id = `external-task-wake:${request_sha256}`;
  const outbox_id = `outbox-${hash(`outbox\u0000${intent_id}\u00001`).slice(0, 48)}`;
  const intent = { intent_id, revision: 1, operation_kind: "RESEARCH", principal_ref: "actor-1", idempotency_key: intent_id,
    payload_ref: task_id, policy_decision_ref: "authorization-1", budget_reservation_ref: null,
    cancellation_ref: "workflow:run-1", created_at: submitted_at, outbox_id,
    topic: EXTERNAL_AGENT_RESULT_WAKE_TOPIC, payload_sha256: result_sha256 };
  const authority = { ...row, ...intent, attempts: 2, workflow_state: "ACTIVE", next_stage_index: 8 };
  const current = { operation_id: request.operation_id, stage_index: 8, principal_ref: "actor-1", intent_id: task_id };
  const state = { current: true, recorded: true };
  const calls: string[] = [];
  const database: D1Database = {
    prepare(query) {
      const statement: D1PreparedStatement = {
        bind() { return statement; },
        async first<T>(column?: string): Promise<T | null> {
          calls.push(query);
          let found: unknown;
          if (query.includes("external_agent_task_generation")) found = column ? "external-agent-task-v1" : { value: "external-agent-task-v1" };
          else if (query.includes("external_agent_result_outbox_generation")) found = column ? "external-agent-result-outbox-v1" : { value: "external-agent-result-outbox-v1" };
          else if (query.includes("FROM outbox o")) found = authority;
          else if (query.includes("FROM operation_intent i JOIN outbox o")) found = intent;
          else if (query.includes("FROM research_external_agent_task_binding WHERE")) found = state.recorded ? row : null;
          else if (query.includes("SELECT principal_ref,authorization_receipt_ref,handler_generation")) found = {
            principal_ref: "actor-1", authorization_receipt_ref: "authorization-1", handler_generation: request.handler_generation };
          else if (query.includes("FROM research_external_agent_result_settlement_authorized")) found = state.current ? current : null;
          else throw new Error("Unexpected fixture query");
          return found as T | null;
        },
        async run() { throw new Error("Wake cannot mutate D1"); },
        async all() { throw new Error("Wake cannot scan"); },
        raw: async () => { throw new Error("Wake cannot raw scan"); },
      };
      return statement;
    },
    async batch() { throw new Error("Wake cannot batch mutate"); },
    async exec() { throw new Error("Wake cannot execute SQL effects"); },
    async dump() { throw new Error("Wake cannot dump"); },
    withSession() { throw new Error("Unexpected fixture session"); },
  };
  const send = vi.fn(async (_event: { type: string; payload: unknown }) => undefined);
  const get = vi.fn(async (id: string) => ({ id, sendEvent: send }));
  const handler = createExternalTaskResultDeliveryHandler({ database, get_instance: get });
  const message: DeliveryMessage = { protocol: "eliotr.delivery.message.v1", message_id: `${outbox_id}:1`,
    topic: EXTERNAL_AGENT_RESULT_WAKE_TOPIC, payload_ref: task_id, payload_sha256: result_sha256,
    idempotency_key: intent_id, outbox_id, outbox_attempt: 1, created_at_ms: Date.parse(submitted_at) };
  return { row, authority, intent, current, state, calls, handler, send, get, message };
}

describe("canonical external result Queue wake", () => {
  it("sends only the exact locator after original lease/budget expiry when current settlement authorizes it", async () => {
    const f = fixture();
    expect(f.row.budget_expires_at_ms).toBeLessThan(Date.now());
    const receipt = await f.handler(f.message, context);
    expect(receipt.receipt_ref).toMatch(/:sent$/u);
    expect(f.get).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(f.send).toHaveBeenCalledTimes(1);
    const event = f.send.mock.calls[0]?.[0];
    expect(event?.type).toMatch(/^external-result-[a-f0-9]{64}$/u);
    expect(event?.payload).toEqual({ protocol: "eliotr.external-task-wake.v1", task_id: f.row.task_id,
      operation_id: "run-1", stage_index: 8, attempt_ref: "attempt-1", request_sha256: f.row.request_sha256,
      result_digest: f.row.result_sha256 });
    expect(JSON.stringify(event)).not.toContain("never-in-wake");
    expect(f.calls.some((sql) => sql.includes("research_external_agent_task_current"))).toBe(false);
  });

  it("retries only the identical locator after a lost send acknowledgement", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("Lost send ACK"));
    await expect(f.handler(f.message, context)).rejects.toMatchObject({ code: "DELIVERY_SETTLEMENT_UNCERTAIN", retryable: true });
    await f.handler(f.message, context);
    expect(f.send.mock.calls[1]?.[0]).toEqual(f.send.mock.calls[0]?.[0]);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("rejects foreign message metadata and exact-result tuple/digest conflicts before any wake", async () => {
    for (const patch of [{ topic: "foreign" }, { payload_sha256: "c".repeat(64) }, { payload_ref: "foreign-task" },
      { idempotency_key: "foreign" }, { created_at_ms: 1 }, { outbox_attempt: 3 }]) {
      const f = fixture();
      const message = { ...f.message, ...patch };
      message.message_id = `${message.outbox_id}:${message.outbox_attempt}`;
      await expect(f.handler(message, context)).rejects.toThrow();
      expect(f.send).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.authority.attempt_ref = "foreign-attempt";
    await expect(f.handler(f.message, context)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("refuses absent/noncanonical result and nonstable outbox identity", async () => {
    const absent = fixture();
    absent.state.recorded = false;
    await expect(absent.handler(absent.message, context)).rejects.toMatchObject({ code: "DELIVERY_SETTLEMENT_UNCERTAIN" });
    expect(absent.send).not.toHaveBeenCalled();
    const corrupt = fixture();
    corrupt.row.result_json += " ";
    corrupt.row.result_sha256 = hash(corrupt.row.result_json);
    await expect(corrupt.handler(corrupt.message, context)).rejects.toThrow();
    expect(corrupt.send).not.toHaveBeenCalled();
    const forged = fixture();
    forged.authority.outbox_id = "outbox-foreign";
    const forgedMessage = { ...forged.message, outbox_id: "outbox-foreign", message_id: "outbox-foreign:1" };
    await expect(forged.handler(forgedMessage, context)).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
    expect(forged.send).not.toHaveBeenCalled();
  });

  it("acknowledges obsolete transport for cancellation, advanced stage or revoked current authority without sending", async () => {
    for (const status of ["CANCELLED", "ENGINE_COMPLETED", "ADVANCED", "REVOKED"]) {
      const f = fixture();
      if (status === "ADVANCED") f.authority.next_stage_index = 9;
      else if (status === "REVOKED") f.state.current = false;
      else f.authority.workflow_state = status;
      expect((await f.handler(f.message, context)).receipt_ref).toMatch(/:obsolete$/u);
      expect(f.send).not.toHaveBeenCalled();
    }
  });

  it("rechecks current authority after native get and refuses foreign native identity", async () => {
    const revoked = fixture();
    revoked.get.mockImplementation(async (id) => { revoked.state.current = false; return { id, sendEvent: revoked.send }; });
    expect((await revoked.handler(revoked.message, context)).receipt_ref).toMatch(/:obsolete$/u);
    expect(revoked.send).not.toHaveBeenCalled();
    const foreign = fixture();
    foreign.get.mockImplementation(async () => ({ id: "foreign-run", sendEvent: foreign.send }));
    await expect(foreign.handler(foreign.message, context)).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
    expect(foreign.send).not.toHaveBeenCalled();
  });
});
