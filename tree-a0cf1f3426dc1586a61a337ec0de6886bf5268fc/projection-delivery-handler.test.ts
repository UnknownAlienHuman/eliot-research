import type { DeliveryMessage } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import { createProjectionDeliveryHandler } from "./projection-delivery-handler.js";

const DIGEST = "a".repeat(64);

type FixtureMode = "FAILED_ONLY" | "ACCEPTED" | "CORRUPT_ACCEPTED";

function message(): DeliveryMessage {
  return {
    protocol: "eliotr.delivery.message.v1",
    message_id: "outbox-1:1",
    topic: "source.revision.admitted",
    payload_ref: "source-revision-1",
    payload_sha256: DIGEST,
    idempotency_key: "projection-1",
    outbox_id: "outbox-1",
    outbox_attempt: 1,
    created_at_ms: 1_000,
  };
}

function authorityRow(): Record<string, unknown> {
  return {
    outbox_id: "outbox-1",
    topic: "source.revision.admitted",
    payload_ref: "source-revision-1",
    payload_sha256: DIGEST,
    attempts: 1,
    intent_id: "intent-1",
    revision: 1,
    operation_kind: "PROJECTION",
    principal_ref: "principal-1",
    idempotency_key: "projection-1",
    policy_decision_ref: "policy-1",
    budget_reservation_ref: null,
    cancellation_ref: null,
    created_at: "2026-08-30T00:00:00.000Z",
  };
}

function fixture(mode: FixtureMode) {
  const statements: string[] = [];
  const database = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM outbox o JOIN operation_intent")) {
                return authorityRow() as T;
              }
              if (sql.includes("FROM source_revision sr")) {
                return {
                  source_revision_ref: "source-revision-1",
                  content_sha256: DIGEST,
                } as T;
              }
              if (sql.includes("FROM operation_receipt r")) {
                if (mode === "FAILED_ONLY") return null;
                const jobId = values[2];
                return {
                  receipt_id: "receipt-accepted",
                  revision: 1,
                  outcome: "ACCEPTED",
                  attempt_id: "attempt-accepted",
                  output_refs_json: mode === "CORRUPT_ACCEPTED"
                    ? "[]"
                    : JSON.stringify([jobId]),
                  job_id: jobId,
                  job_state: "ACCEPTED",
                  attempt_state: "CHECKPOINTED",
                } as T;
              }
              if (sql.includes("INSERT INTO operation_execution_lease")) return null;
              if (sql.includes("SELECT operation_kind, state FROM operation_execution_lease")) {
                return null;
              }
              if (sql.includes("SELECT * FROM operation_execution_lease")) return null;
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, statements };
}

const context = {
  message_id: "outbox-1:1",
  idempotency_key: "projection-1",
  topic: "source.revision.admitted",
  attempt: 1,
} as const;

describe("projection Queue acceptance", () => {
  it("never treats FAILED/BLOCKED/CANCELLED receipts as successful delivery deduplication", async () => {
    const test = fixture("FAILED_ONLY");
    const handler = createProjectionDeliveryHandler(test.database, () => 10_000);
    await expect(handler(message(), context)).rejects.toMatchObject({
      code: "DELIVERY_LEASE_LOST",
      retryable: true,
    });
    const receiptSql = test.statements.find((sql) => sql.includes("FROM operation_receipt r"));
    expect(receiptSql).toContain(
      "outcome IN ('ACCEPTED','DUPLICATE','SUCCEEDED','PARTIAL')",
    );
  });

  it("reuses only a receipt joined to the deterministic job and attempt authority", async () => {
    const test = fixture("ACCEPTED");
    const handler = createProjectionDeliveryHandler(test.database, () => 10_000);
    await expect(handler(message(), context)).resolves.toEqual({
      receipt_ref: "receipt:receipt-accepted:1",
    });
    const receiptSql = test.statements.find((sql) => sql.includes("FROM operation_receipt r"));
    expect(receiptSql).toContain("JOIN job j");
    expect(receiptSql).toContain("JOIN operation_attempt a");
    expect(receiptSql).toContain("json_each(r.output_refs_json)");
    expect(test.statements.some((sql) =>
      sql.includes("INSERT INTO operation_execution_lease"))).toBe(false);
  });

  it("rejects an acknowledging receipt that does not bind the deterministic job", async () => {
    const test = fixture("CORRUPT_ACCEPTED");
    const handler = createProjectionDeliveryHandler(test.database, () => 10_000);
    await expect(handler(message(), context)).rejects.toMatchObject({
      code: "DELIVERY_INPUT_INVALID",
      retryable: false,
    });
  });
});
