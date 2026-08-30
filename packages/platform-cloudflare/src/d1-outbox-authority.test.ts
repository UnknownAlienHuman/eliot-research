import { describe, expect, it } from "vitest";
import type { OperationIntent } from "@eliotr/contracts";
import { appendIntentWithOutbox } from "./d1-outbox-authority.js";

interface Call { readonly sql: string; readonly values: readonly unknown[]; readonly method: string }
interface Step { readonly method: "first" | "batch"; readonly value?: unknown; readonly error?: Error }

function intent(overrides: Partial<OperationIntent> = {}): OperationIntent {
  return {
    intent_ref: { id: "intent-1", revision: 1 },
    operation_kind: "PROJECTION",
    principal_ref: "principal-1",
    idempotency_key: "projection-1",
    payload_ref: "source-revision-1",
    policy_decision_ref: "policy-1",
    created_at: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

function authorityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent_id: "intent-1",
    revision: 1,
    operation_kind: "PROJECTION",
    principal_ref: "principal-1",
    idempotency_key: "projection-1",
    payload_ref: "source-revision-1",
    policy_decision_ref: "policy-1",
    budget_reservation_ref: null,
    cancellation_ref: null,
    created_at: "2026-08-30T00:00:00.000Z",
    outbox_id: "outbox-3f52c36308030f76d789c1fa5968c3fde63f1dfe0700f8c0",
    topic: "source.revision.admitted",
    payload_sha256: "a".repeat(64),
    ...overrides,
  };
}

function fixture(steps: readonly Step[]): { readonly database: D1Database; readonly calls: Call[] } {
  const calls: Call[] = [];
  let cursor = 0;
  const take = (method: Step["method"]): Step => {
    const step = steps[cursor++];
    expect(step?.method).toBe(method);
    if (step?.error !== undefined) throw step.error;
    return step ?? { method };
  };
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              calls.push({ sql, values, method: "first" });
              return take("first").value as T | null;
            },
            async run<T>() {
              calls.push({ sql, values, method: "run" });
              return { success: true, meta: { changes: 1 } } as D1Result<T>;
            },
          };
        },
      };
    },
    async batch<T>(statements: readonly D1PreparedStatement[]) {
      calls.push({ sql: `batch:${statements.length}`, values: [], method: "batch" });
      return take("batch").value as D1Result<T>[];
    },
  } as unknown as D1Database;
  return { database, calls };
}

describe("D1 intent/outbox authority", () => {
  it("commits intent and exact digest-bound outbox in one batch then requires readback", async () => {
    const existingProbe = { method: "first", value: null } as const;
    const { database, calls } = fixture([
      existingProbe,
      { method: "batch", value: [
        { success: true, meta: { changes: 1 } },
        { success: true, meta: { changes: 1 } },
      ] },
      { method: "first", value: authorityRow() },
    ]);
    const result = await appendIntentWithOutbox(database, {
      intent: intent(), topic: "source.revision.admitted", payload_sha256: "a".repeat(64),
    });
    expect(result.disposition).toBe("CREATED");
    expect(calls.some((call) => call.method === "batch")).toBe(true);
    expect(calls.find((call) => call.sql.startsWith("batch:"))?.sql).toBe("batch:2");
  });

  it("returns an exact idempotent replay without another mutation", async () => {
    const { database, calls } = fixture([{ method: "first", value: authorityRow() }]);
    const result = await appendIntentWithOutbox(database, {
      intent: intent(), topic: "source.revision.admitted", payload_sha256: "a".repeat(64),
    });
    expect(result.disposition).toBe("EXISTING");
    expect(calls.some((call) => call.method === "batch")).toBe(false);
  });

  it("rejects payload substitution under the same idempotency identity", async () => {
    const { database } = fixture([{ method: "first", value: authorityRow({ payload_sha256: "b".repeat(64) }) }]);
    await expect(appendIntentWithOutbox(database, {
      intent: intent(), topic: "source.revision.admitted", payload_sha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID", retryable: false });
  });

  it("reconciles an ambiguous batch failure only through exact durable readback", async () => {
    const { database } = fixture([
      { method: "first", value: null },
      { method: "batch", error: new Error("lost acknowledgement") },
      { method: "first", value: authorityRow() },
    ]);
    await expect(appendIntentWithOutbox(database, {
      intent: intent(), topic: "source.revision.admitted", payload_sha256: "a".repeat(64),
    })).resolves.toMatchObject({ disposition: "EXISTING" });
  });
});
