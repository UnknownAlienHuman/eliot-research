/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createD1QueueTerminalStore } from "./d1-queue-terminal-store.js";
import { DELIVERY_MESSAGE_PROTOCOL, type DeliveryMessage } from "./delivery-types.js";
import type { QueueTerminalInput } from "./queue-terminal-types.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  for (const name of ["0001_initial", "0002_execution_coordination", "0003_delivery_inbox_payload_digest",
    "0004_outbox_delivery_fence", "0133_queue_terminal_observation"]) {
    sqlite.exec(readFileSync(new URL(`../../../infra/d1/core/migrations/${name}.sql`, import.meta.url), "utf8"));
  }
  const created = "2026-10-11T00:00:00.000Z";
  sqlite.prepare("INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key," +
    "payload_ref,policy_decision_ref,created_at) VALUES(?,1,?,?,?,?,?,?)")
    .run("intent-1", "projection", "owner-1", "key-1", "r2://payload/1", "policy-1", created);
  sqlite.prepare("INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,state,attempts," +
    "next_attempt_at,created_at,updated_at,payload_sha256) VALUES(?,?,1,?,?,?,2,?,?,?,?)")
    .run("outbox-1", "intent-1", "projection.refresh", "r2://payload/1", "SENT", Date.parse(created), created, created, "a".repeat(64));
  const message: DeliveryMessage = {
    protocol: DELIVERY_MESSAGE_PROTOCOL, message_id: "outbox-1:1", topic: "projection.refresh",
    payload_ref: "r2://payload/1", payload_sha256: "a".repeat(64), idempotency_key: "key-1",
    outbox_id: "outbox-1", outbox_attempt: 1, created_at_ms: Date.parse(created),
  };
  const input: QueueTerminalInput = { queue_name: "eliotr-dlq-test", platform_message_id: "native-1",
    platform_attempt: 1, observed_at_ms: Date.parse(created) + 1000, message };
  let loseInsertAck = false;
  const database = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      return { bind(...values: (string | number | null)[]) {
        return {
          async first() { return statement.get(...values) ?? null; },
          async run() {
            const result = statement.run(...values);
            if (loseInsertAck && sql.startsWith("INSERT INTO queue_terminal_observation")) {
              loseInsertAck = false;
              throw new Error("INSERT committed; acknowledgement lost");
            }
            return result;
          },
        };
      } };
    },
  } as unknown as D1Database;
  const store = createD1QueueTerminalStore(database);
  const state = () => JSON.stringify({ outbox: sqlite.prepare("SELECT * FROM outbox").all(),
    intent: sqlite.prepare("SELECT * FROM operation_intent").all(), inbox: sqlite.prepare("SELECT * FROM delivery_inbox").all() });
  function inbox(receipt: string | null, digest = message.payload_sha256) {
    sqlite.prepare("INSERT INTO delivery_inbox(message_id,idempotency_key,topic,payload_ref,state,attempt," +
      "result_receipt_ref,first_seen_at,updated_at,payload_sha256) VALUES(?,?,?,?,'COMPLETED',1,?,1,1,?)")
      .run(message.message_id, message.idempotency_key, message.topic, message.payload_ref, receipt, digest);
  }
  return { sqlite, input, message, store, state, inbox, loseAck() { loseInsertAck = true; } };
}

describe("D1 terminal transport observation against SQLite", () => {
  it("concurrent duplicates converge on one immutable diagnostic without touching business state", async () => {
    const f = fixture(), before = f.state();
    const [first, second] = await Promise.all([f.store.record(f.input), f.store.record(f.input)]);
    expect(first).toEqual(second);
    expect(first.disposition).toBe("QUARANTINED");
    expect(first.original_message).toEqual(f.message);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM queue_terminal_observation").get()?.n).toBe(1);
    expect(f.state()).toBe(before);
    expect(() => f.sqlite.exec("UPDATE queue_terminal_observation SET platform_attempt=2")).toThrow("immutable");
  });

  it("reconciles a committed INSERT whose acknowledgement was lost", async () => {
    const f = fixture();
    f.loseAck();
    const first = await f.store.record(f.input);
    const retry = await f.store.record({ ...f.input, platform_attempt: 2, observed_at_ms: f.input.observed_at_ms + 1 });
    expect(retry).toEqual(first);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM queue_terminal_observation").get()?.n).toBe(1);
  });

  it("retains only native metadata for malformed and foreign input", async () => {
    const f = fixture(), before = f.state();
    const malformed = await f.store.record({ ...f.input, message: null });
    const foreign = await f.store.record({ ...f.input, platform_message_id: "native-2",
      message: { ...f.message, payload_ref: "r2://private-foreign-secret" } });
    expect(malformed.disposition).toBe("MALFORMED");
    expect(foreign.disposition).toBe("IDENTITY_MISMATCH");
    expect(foreign.original_message).toBeNull();
    const rows = f.sqlite.prepare("SELECT * FROM queue_terminal_observation").all();
    expect(rows.every(row => row.outbox_id === null && row.original_message_json === null && row.completed_receipt_ref === null)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("private-foreign-secret");
    expect(f.state()).toBe(before);
  });

  it.each(["idempotency_key", "payload_sha256", "topic", "created_at_ms", "outbox_attempt"] as const)("quarantines canonical identity substitution: %s", async (field) => {
      const f = fixture();
      const changes = { idempotency_key: "other-key", payload_sha256: "b".repeat(64), topic: "foreign.topic",
        created_at_ms: f.message.created_at_ms + 1, outbox_attempt: 3 };
      const message = { ...f.message, [field]: changes[field] };
      message.message_id = `${message.outbox_id}:${message.outbox_attempt}`;
      expect((await f.store.record({ ...f.input, message })).disposition).toBe("IDENTITY_MISMATCH");
    });

  it("returns the retained completed receipt with no Inbox or outbox mutations", async () => {
    const f = fixture();
    f.inbox("receipt://original-1");
    const before = f.state();
    const result = await f.store.record(f.input);
    expect(result.disposition).toBe("COMPLETED");
    expect(result.completed_receipt_ref).toBe("receipt://original-1");
    expect(f.state()).toBe(before);
  });

  it("refuses missing completion proof and rejects a foreign Inbox digest", async () => {
    const missing = fixture();
    missing.inbox(null);
    await expect(missing.store.record(missing.input)).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
    expect(missing.sqlite.prepare("SELECT count(*) AS n FROM queue_terminal_observation").get()?.n).toBe(0);
    const foreign = fixture();
    foreign.inbox("receipt://foreign", "b".repeat(64));
    expect((await foreign.store.record(foreign.input)).disposition).toBe("IDENTITY_MISMATCH");
  });

  it("rejects conflicting duplicate body and removes known metadata with original outbox cleanup", async () => {
    const f = fixture();
    await f.store.record(f.input);
    await expect(f.store.record({ ...f.input, message: { ...f.message, payload_sha256: "b".repeat(64) } }))
      .rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
    f.sqlite.exec("DELETE FROM outbox WHERE outbox_id='outbox-1'");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM queue_terminal_observation").get()?.n).toBe(0);
  });
});
