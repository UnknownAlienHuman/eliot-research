import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.js";
import { ScriptedFailureInjector } from "./failure-injection.js";
import {
  FakeAiSearchIndex,
  FakeD1Store,
  FakeDriveExchange,
  FakeModelGateway,
  FakeQueue,
  FakeR2Store,
  LostAckError,
  PurgeBlockedError,
  PartialWriteError,
  StaleGenerationError,
  TamperDetectedError,
} from "./fakes.js";

function harness() {
  const clock = new FakeClock(new Date("2026-09-08T00:00:00.000Z"));
  return { clock };
}

describe("testkit failure fakes", () => {
  it("reconciles a lost ACK via readback without a replacement identity", async () => {
    const { clock } = harness();
    const d1 = new FakeD1Store({ clock });
    await d1.insert("row-1", "v1", "gen-1");
    await expect(d1.commitWithLostAck("row-2", "v2", "gen-1")).rejects.toBeInstanceOf(LostAckError);
    expect(await d1.read("row-2")).toMatchObject({ value: "v2", generation: "gen-1" });
    expect(d1.committedIds()).toEqual(["row-1", "row-2"]);

    const queue = new FakeQueue({ clock });
    const first = await queue.send("payload-1", "idem-1");
    const duplicate = await queue.send("payload-1", "idem-1");
    expect(duplicate.idempotencyKey).toBe(first.idempotencyKey);
    expect(queue.pendingKeys()).toEqual(["idem-1"]);
    await expect(queue.ackWithLoss("idem-1")).rejects.toBeInstanceOf(LostAckError);
    expect(await queue.readback("idem-1")).toMatchObject({ idempotencyKey: "idem-1", acked: true });
  });

  it("rejects stale generations without mutating canonical rows", async () => {
    const { clock } = harness();
    const d1 = new FakeD1Store({ clock });
    await d1.insert("row-1", "v1", "gen-1");
    await expect(d1.compareAndSwap("row-1", "gen-0", "v2", "gen-2")).rejects.toBeInstanceOf(StaleGenerationError);
    expect(await d1.read("row-1")).toMatchObject({ value: "v1", generation: "gen-1" });

    const drive = new FakeDriveExchange({ clock });
    await drive.append("req-1", "{\"op\":1}", "gen-1", "gen-1");
    await expect(drive.append("req-2", "{\"op\":2}", "gen-2", "gen-1")).rejects.toBeInstanceOf(StaleGenerationError);
    expect(drive.storedRowIds()).toEqual(["req-1"]);
  });

  it("detects tampering via digest mismatch", async () => {
    const { clock } = harness();
    const r2 = new FakeR2Store({ clock });
    await r2.put("obj-1", "exact bytes", "gen-1");
    r2.tamper("obj-1", "corrupted bytes");
    await expect(r2.get("obj-1")).rejects.toBeInstanceOf(TamperDetectedError);
    expect(r2.storedKeys()).toEqual(["obj-1"]);

    const drive = new FakeDriveExchange({ clock });
    await drive.append("row-1", "pinned content", "gen-1", "gen-1");
    drive.tamper("row-1", "mutated content");
    await expect(drive.read("row-1")).rejects.toBeInstanceOf(TamperDetectedError);
  });

  it("exposes partial writes for inspection without a success receipt", async () => {
    const { clock } = harness();
    const r2 = new FakeR2Store({ clock });
    await expect(r2.putPartial("obj-partial", "first-half", "second-half", "gen-1")).rejects.toBeInstanceOf(PartialWriteError);
    expect(r2.storedKeys()).toEqual(["obj-partial"]);
    await expect(r2.get("obj-partial")).rejects.toBeInstanceOf(PartialWriteError);
  });

  it("blocks purge under legal hold instead of reporting subset completion", async () => {
    const { clock } = harness();
    const r2 = new FakeR2Store({ clock });
    await r2.put("obj-locked", "sealed", "gen-1");
    r2.hold("obj-locked");
    await expect(r2.delete("obj-locked")).rejects.toBeInstanceOf(PurgeBlockedError);
    expect(r2.storedKeys()).toEqual(["obj-locked"]);
  });

  it("rejects malformed, empty, and oversized transport input early", async () => {
    const { clock } = harness();
    const search = new FakeAiSearchIndex({ clock });
    await search.index("src-1:sec-1", "exact phrase target", "gen-1");
    await expect(search.search("   ", "gen-1")).rejects.toThrow("EMPTY_QUERY");
    await expect(search.search("x".repeat(9 * 1024), "gen-1")).rejects.toThrow("OVERSIZED_QUERY");
    expect(await search.search("exact phrase", "gen-1")).toHaveLength(1);
    expect(await search.search("exact phrase", "gen-stale")).toHaveLength(0);

    const model = new FakeModelGateway({ clock });
    await expect(model.execute({ routeRef: "", promptGeneration: "p1", evidenceDigest: "0".repeat(64), maxOutputBytes: 1024 })).rejects.toThrow("EMPTY_ROUTE_REF");
    await expect(model.execute({ routeRef: "r1", promptGeneration: "p1", evidenceDigest: "0".repeat(64), maxOutputBytes: 0 })).rejects.toThrow("INVALID_MAX_OUTPUT_BYTES");
    await expect(model.execute({ routeRef: "r1", promptGeneration: "p1", evidenceDigest: "0".repeat(64), maxOutputBytes: 65 * 1024 })).rejects.toThrow("OVERSIZED_MODEL_OUTPUT");
    const receipt = await model.execute({ routeRef: "r1", promptGeneration: "p1", evidenceDigest: "0".repeat(64), maxOutputBytes: 1024 });
    expect(receipt.outputSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports scripted injection at the expensive boundary", async () => {
    const { clock } = harness();
    const injector = new ScriptedFailureInjector(new Map([["DURING_READBACK", new Error("injected read fault")]]));
    const d1 = new FakeD1Store({ clock, injector });
    await d1.insert("row-1", "v1", "gen-1");
    await expect(d1.read("row-1")).rejects.toThrow("injected read fault");
    expect(d1.committedIds()).toEqual(["row-1"]);
  });
});
