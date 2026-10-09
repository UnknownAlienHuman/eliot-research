/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { externalTaskWakeEventType, parseExternalTaskWakeEvent } from "./external-task-wake-event.js";

const bound = { operation_id: "wake-run:1", stage_index: 8, attempt_ref: "attempt-1",
  request_sha256: "a".repeat(64) };
const event = () => ({ protocol: "eliotr.external-task-wake.v1", task_id: `external-task:${bound.request_sha256}`,
  ...bound, result_digest: "b".repeat(64) });
const invalid = { code: "EXTERNAL_AGENT_TASK_INPUT_INVALID", status: 400 };

describe("bounded native external-task wake locator", () => {
  it("accepts exactly seven locator fields, snapshots them and grants no result body", () => {
    const raw = event();
    const parsed = parseExternalTaskWakeEvent(raw);
    expect(parsed).toEqual(raw);
    expect(Object.keys(parsed)).toHaveLength(7);
    expect(Object.isFrozen(parsed)).toBe(true);
    raw.operation_id = "rebound-run";
    raw.result_digest = "c".repeat(64);
    expect(parsed.operation_id).toBe(bound.operation_id);
    expect(parsed.result_digest).toBe("b".repeat(64));
    expect(parseExternalTaskWakeEvent(Object.assign(Object.create(null), event()))).toEqual(event());
  });

  it("rejects unknown or missing fields, wrong versions and non-object envelopes", () => {
    for (const raw of [null, [], "{}", 0, new Date(), { ...event(), protocol: "eliotr.external-task-wake.v2" },
      { ...event(), output: {} }, { ...event(), evidence_refs: [] }, { ...event(), [Symbol("hidden")]: true }]) {
      expect(() => parseExternalTaskWakeEvent(raw)).toThrow(expect.objectContaining(invalid));
    }
    for (const key of Object.keys(event())) {
      const raw: Record<string, unknown> = event();
      delete raw[key];
      expect(() => parseExternalTaskWakeEvent(raw)).toThrow(expect.objectContaining(invalid));
    }
  });

  it("rejects mismatched task digests and every invalid identity component", () => {
    const patches = [
      { task_id: `external-task:${"c".repeat(64)}` }, { task_id: "external-task:short" },
      { operation_id: "" }, { operation_id: "bad/run" }, { operation_id: "x".repeat(129) },
      { stage_index: -1 }, { stage_index: 18 }, { stage_index: 1.5 }, { stage_index: "8" }, { stage_index: NaN },
      { attempt_ref: "" }, { attempt_ref: "bad\u0000attempt" }, { attempt_ref: "x".repeat(129) },
      { request_sha256: "A".repeat(64) }, { request_sha256: 1 }, { result_digest: "B".repeat(64) },
      { result_digest: "b".repeat(63) }, { result_digest: null },
    ];
    for (const patch of patches) {
      expect(() => parseExternalTaskWakeEvent({ ...event(), ...patch })).toThrow(expect.objectContaining(invalid));
    }
  });

  it("hashes a fixed domain-separated full identity independently of property order or result", async () => {
    const expected = createHash("sha256").update(JSON.stringify({ protocol: "eliotr.external-task-wake.v1", ...bound })).digest("hex");
    const type = await externalTaskWakeEventType(bound);
    expect(type).toBe(`external-result-${expected}`);
    expect(type).toMatch(/^external-result-[a-f0-9]{64}$/u);
    expect(type.length).toBeLessThanOrEqual(100);
    expect(await externalTaskWakeEventType({ request_sha256: bound.request_sha256, attempt_ref: bound.attempt_ref,
      stage_index: bound.stage_index, operation_id: bound.operation_id })).toBe(type);
    // Passing a parsed locator cannot make the type depend on result availability.
    expect(await externalTaskWakeEventType(parseExternalTaskWakeEvent(event()))).toBe(type);
    expect(await externalTaskWakeEventType(parseExternalTaskWakeEvent({ ...event(), result_digest: "c".repeat(64) }))).toBe(type);
  });

  it("changes the event type for each attempt component and rejects delimiter ambiguity", async () => {
    const original = await externalTaskWakeEventType(bound);
    for (const patch of [{ operation_id: "wake-run:2" }, { stage_index: 9 }, { attempt_ref: "attempt-2" },
      { request_sha256: "c".repeat(64) }]) {
      expect(await externalTaskWakeEventType({ ...bound, ...patch })).not.toBe(original);
    }
    const first = { ...bound, operation_id: "op:1", stage_index: 2, attempt_ref: "3" };
    const second = { ...bound, operation_id: "op", stage_index: 1, attempt_ref: "2:3" };
    expect([first.operation_id, first.stage_index, first.attempt_ref].join(":"))
      .toBe([second.operation_id, second.stage_index, second.attempt_ref].join(":"));
    expect(await externalTaskWakeEventType(first)).not.toBe(await externalTaskWakeEventType(second));
  });

  it("snapshots identity before digest and validates the pre-result type builder", async () => {
    const mutable = { ...bound };
    const pending = externalTaskWakeEventType(mutable);
    mutable.operation_id = "rebound-run";
    mutable.stage_index = 9;
    expect(await pending).toBe(await externalTaskWakeEventType(bound));
    for (const patch of [{ stage_index: 18 }, { operation_id: "bad/run" }, { attempt_ref: "bad\u007f" },
      { request_sha256: "short" }]) {
      await expect(externalTaskWakeEventType({ ...bound, ...patch })).rejects.toMatchObject(invalid);
    }
  });
});
