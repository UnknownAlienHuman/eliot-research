/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  externalTaskCanonical,
  ExternalAgentTaskError,
  MAX_RESULT_BYTES,
  type ExternalAgentRecordedResultRow,
} from "./external-agent-task-codec.js";
import { readExternalAgentRecordedResult } from "./external-agent-recorded-result-reader.js";

const identity = { operation_id: "wake-reader-1", stage_index: 8,
  attempt_ref: "attempt-1", request_sha256: "a".repeat(64) };
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
type Row = ExternalAgentRecordedResultRow & { state: string };

function recordedRow(): Row {
  const envelope = { protocol: "eliotr.external-agent-result.v1", task_id: `external-task:${identity.request_sha256}`,
    ...identity, stage: "ANALYZE_BRANCHES", lease_id: "external-lease:12345678-1234-4123-8123-123456789012",
    idempotency_key: "result-1", disposition: "SUCCEEDED", output: { z: 1, a: 2 }, evidence_refs: [],
    diagnostics: [], usage: { accounting: "UNKNOWN" }, submitted_at: "2026-10-09T14:00:00.000Z" };
  const result_json = externalTaskCanonical(envelope, MAX_RESULT_BYTES, "fixture");
  return { ...identity, task_id: envelope.task_id, stage: envelope.stage, lease_id: envelope.lease_id,
    result_idempotency_key: envelope.idempotency_key, result_json, result_sha256: sha(result_json),
    state: "RESULT_RECORDED" };
}

function fixture(row: Row | null) {
  const bind = vi.fn();
  const statement: D1PreparedStatement = {
    bind(...values: unknown[]) { bind(...values); return statement; },
    async first<T>() { return row as T | null; },
    async run() { throw new Error("unexpected write"); },
    async all() { throw new Error("unexpected scan"); },
    async raw() { throw new Error("unexpected raw read"); },
  };
  const database = { prepare: vi.fn(() => statement) } satisfies Pick<D1Database, "prepare">;
  const validate = vi.fn(async (_row: Row) => undefined);
  return { database, validate, bind };
}

describe("exact external result readback for native wake", () => {
  it("returns the original canonical digest with the existing strict result decoder", async () => {
    const row = recordedRow();
    const f = fixture(row);
    const readback = await readExternalAgentRecordedResult(f.database, identity, f.validate);
    expect(readback?.result_sha256).toBe(row.result_sha256);
    expect(sha(JSON.stringify(readback?.result))).not.toBe(row.result_sha256);
    expect(readback?.result.output).toEqual({ a: 2, z: 1 });
    expect(Object.isFrozen(readback)).toBe(true);
    expect(Object.isFrozen(readback?.result)).toBe(true);
    expect(f.validate).toHaveBeenCalledExactlyOnceWith(row);
    expect(f.bind).toHaveBeenCalledExactlyOnceWith(identity.operation_id, 8, identity.attempt_ref, identity.request_sha256);
  });

  it("keeps missing or unsettled results absent without invoking the binding validator", async () => {
    for (const row of [null, { ...recordedRow(), state: "LEASED" }]) {
      const f = fixture(row);
      expect(await readExternalAgentRecordedResult(f.database, identity, f.validate)).toBeNull();
      expect(f.validate).not.toHaveBeenCalled();
    }
  });

  it("rejects each foreign tuple component and corrupt stored digest", async () => {
    for (const patch of [{ operation_id: "other-run" }, { stage_index: 9 }, { attempt_ref: "other-attempt" },
      { request_sha256: "b".repeat(64) }, { result_sha256: "b".repeat(64) }]) {
      const f = fixture({ ...recordedRow(), ...patch });
      await expect(readExternalAgentRecordedResult(f.database, identity, f.validate))
        .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT" });
    }
  });

  it("rejects noncanonical and malformed result bytes even with matching byte digests", async () => {
    const row = recordedRow();
    const alternate = JSON.stringify(JSON.parse(row.result_json ?? "null"), null, 2);
    for (const result_json of [alternate, "{"]) {
      const f = fixture({ ...row, result_json, result_sha256: sha(result_json) });
      await expect(readExternalAgentRecordedResult(f.database, identity, f.validate))
        .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT" });
    }
  });

  it("preserves storage uncertainty and binding-authority rejection", async () => {
    const f = fixture(recordedRow());
    f.database.prepare.mockImplementation(() => { throw new Error("storage unavailable"); });
    await expect(readExternalAgentRecordedResult(f.database, identity, f.validate))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", retryable: true });
    expect(f.validate).not.toHaveBeenCalled();
    const denied = fixture(recordedRow());
    denied.validate.mockRejectedValue(new ExternalAgentTaskError("EXTERNAL_AGENT_TASK_DENIED", 403, "denied"));
    await expect(readExternalAgentRecordedResult(denied.database, identity, denied.validate))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_DENIED" });
  });

  it("snapshots the request before the asynchronous row read", async () => {
    const f = fixture(recordedRow());
    const mutable = { ...identity };
    const pending = readExternalAgentRecordedResult(f.database, mutable, f.validate);
    mutable.operation_id = "rebound-run";
    mutable.request_sha256 = "b".repeat(64);
    expect((await pending)?.result.operation_id).toBe(identity.operation_id);
  });
});
