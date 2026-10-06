import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ModelGatewayExecutionError } from "@eliotr/cloudflare-ai";
import {
  readResearchModelQualificationFailureSummary,
  recordResearchModelQualificationFailureSummary,
} from "./research-model-qualification-failure-summary.js";

const root = new URL("../../../", import.meta.url);
const [probeMigration, dispatchMigration, summaryMigration] = await Promise.all([
  readFile(new URL("infra/d1/core/migrations/0054_model_route_qualification.sql", root), "utf8"),
  readFile(new URL("infra/d1/core/migrations/0055_model_route_qualification_dispatch.sql", root), "utf8"),
  readFile(new URL("infra/d1/core/migrations/0122_model_qualification_failure_summary.sql", root), "utf8"),
]);

function d1(database: DatabaseSync, options: { loseSummaryInsertAck?: boolean } = {}): D1Database {
  let loseSummaryInsertAck = options.loseSummaryInsertAck === true;
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = database.prepare(sql);
          return {
          async first<T>() { return (statement.get(...(values as never[])) ?? null) as T | null; },
            async run() {
              const result = statement.run(...(values as never[]));
              if (loseSummaryInsertAck && sql.includes("model_route_qualification_failure_summary")) {
                loseSummaryInsertAck = false;
                throw new Error("simulated acknowledgement loss after commit");
              }
              return { success: true, meta: { changes: Number(result.changes) } } as D1Result<unknown>;
            },
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function createDatabase(options?: { loseSummaryInsertAck?: boolean }): D1Database {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(probeMigration);
  database.exec(dispatchMigration);
  database.exec(summaryMigration);
  return d1(database, options);
}

async function admit(database: D1Database, key: string, claim: string, input = "a".repeat(64)): Promise<void> {
  const raw = database as unknown as { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };
  await raw.prepare("INSERT INTO model_route_qualification_probe(probe_idempotency_key,probe_input_sha256,claim_ref,started_at) VALUES(?,?,?,?)")
    .bind(key, input, claim, "2026-10-06T00:00:00.000Z").run();
  await raw.prepare("INSERT INTO model_route_qualification_dispatch(probe_idempotency_key,probe_input_sha256,claim_ref,state,observation_sha256,observation_json,started_at,completed_at) VALUES(?,?,?,'STARTED',NULL,NULL,?,NULL)")
    .bind(key, input, claim, "2026-10-06T00:00:01.000Z").run();
}

describe("qualification failure-summary persistence", () => {
  it("persists code-only policy failures and reconciles the same lost acknowledgement", async () => {
    const database = createDatabase({ loseSummaryInsertAck: true });
    const key = "policy-probe";
    await admit(database, key, "policy-claim");
    const error = new ModelGatewayExecutionError("MODEL_GATEWAY_POLICY_REJECTED", "policy rejected");
    const first = await recordResearchModelQualificationFailureSummary(database, {
      probe_idempotency_key: key,
      probe_input_sha256: "a".repeat(64),
      claim_ref: "policy-claim",
      error,
    });
    const second = await recordResearchModelQualificationFailureSummary(database, {
      probe_idempotency_key: key,
      probe_input_sha256: "a".repeat(64),
      claim_ref: "policy-claim",
      error,
    });
    expect(first.summary_sha256).toBe(second.summary_sha256);
    expect(first.safe_response_reason).toBeNull();
    expect(first.transport_failure_reason).toBeNull();
    await expect(database.prepare("SELECT state,observation_sha256,observation_json,completed_at FROM model_route_qualification_dispatch WHERE probe_idempotency_key=?")
      .bind(key).first()).resolves.toEqual({
        state: "STARTED",
        observation_sha256: null,
        observation_json: null,
        completed_at: null,
      });
    await expect(readResearchModelQualificationFailureSummary(database, {
      probe_idempotency_key: key,
      probe_input_sha256: "a".repeat(64),
      claim_ref: "wrong-claim",
    })).rejects.toThrow();
  });

  it("keeps a response reason bound to its exact digest and claim", async () => {
    const database = createDatabase();
    const key = "response-probe";
    await admit(database, key, "response-claim", "b".repeat(64));
    const error = new ModelGatewayExecutionError("MODEL_GATEWAY_RESPONSE_INVALID", "AI Gateway response is not valid UTF-8 JSON");
    const persisted = await recordResearchModelQualificationFailureSummary(database, {
      probe_idempotency_key: key,
      probe_input_sha256: "b".repeat(64),
      claim_ref: "response-claim",
      error,
    });
    expect(persisted.safe_response_reason).toBe("BODY_JSON_INVALID");
    await expect(recordResearchModelQualificationFailureSummary(database, {
      probe_idempotency_key: key,
      probe_input_sha256: "c".repeat(64),
      claim_ref: "response-claim",
      error,
    })).rejects.toThrow();
    assert.equal(persisted.transport_failure_reason, null);
  });
});
