/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, test } from "vitest";
import { createD1ManagedTargetWriterDrain } from "./managed-target-writer-drain.js";
import { createD1AiSearchGenerationRegistryStore } from "./ai-search-generation-registry-d1.js";
import { createAiSearchGenerationRegistryService } from "./ai-search-generation-registry.js";
import { desiredManifest, profileFor, promotionAuthority, targetForProfile } from "./managed-generation-promotion-evidence.test-support.js";
import type { ManagedGenerationPromotionHoldV1 } from "./managed-generation-promotion-evidence-contract.js";

function binding(db: DatabaseSync): D1Database {
  function prepare(sql: string, values: readonly SQLInputValue[] = []) {
    const args = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
    return {
      sql, args,
      bind(...next: SQLInputValue[]) { return prepare(sql, next); },
      async first() { return db.prepare(sql).get(args) ?? null; },
      async all() { return { success: true, results: db.prepare(sql).all(args) }; },
      async run() {
        const result = db.prepare(sql).run(args);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare,
    async batch(statements: readonly ReturnType<typeof prepare>[]) {
      db.exec("BEGIN");
      try {
        const result = statements.map(({ sql, args }) => {
          const rows = db.prepare(sql).all(args);
          const changes = db.prepare("SELECT changes() AS n").get()?.n;
          return { success: true, results: rows, meta: { changes: Number(changes) } };
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

async function world() {
  const core = new DatabaseSync(":memory:"), search = new DatabaseSync(":memory:");
  const clock = { now: Date.parse("2026-10-14T18:03:00.000Z") };
  core.function("unixepoch", () => clock.now / 1000);
  core.exec(readFileSync(new URL("../../../infra/d1/core/migrations/0002_execution_coordination.sql", import.meta.url), "utf8"));
  // The effect table's pre-existing identity guards are outside this hold fixture.
  // The new migration's actual prepare/dispatch/acquisition triggers run here.
  core.exec("CREATE TABLE projection_managed_item_effect(item_key TEXT PRIMARY KEY,managed_instance_id TEXT,managed_generation TEXT,state TEXT)");
  core.exec(readFileSync(new URL("../../../infra/d1/core/migrations/0150_managed_target_writer_holds.sql", import.meta.url), "utf8"));
  search.exec("CREATE TABLE schema_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)");
  for (const file of ["0004_ai_search_generation_registry.sql", "0005_ai_search_generation_registry_v2.sql"]) {
    search.exec(readFileSync(new URL(`../../../infra/d1/search/migrations/${file}`, import.meta.url), "utf8"));
  }
  const profile = profileFor("generation-b", "search-instance-b");
  const target = await targetForProfile("search-main", profile);
  const fence = { sha: desiredManifest({}, target).target_fence.digest };
  const state = { reconciliations: 0, failReconcile: false, expired: false, root: "BUILDING", currentRevision: 0, appliedRevision: 0 };
  const drain = createD1ManagedTargetWriterDrain({
    core_database: binding(core), search_database: binding(search),
    async read_target_fence() { return fence.sha; },
    async reconcile_core({ hold, registry_readback, applied_registry_readback }) {
      state.reconciliations += 1;
      expect(core.prepare("SELECT state FROM operation_execution_lease WHERE operation_id=?").get(hold.operation_id)?.state).toBe("LEASED");
      if (state.failReconcile) throw new Error("Core root activation ACK unavailable");
      state.root = state.expired ? "BLOCKED" : "ACTIVE";
      state.currentRevision = registry_readback.revision;
      state.appliedRevision = applied_registry_readback.revision;
    },
  });
  const request = { operation_id: "hold-test", operation: "QUALIFY" as const, targets: [{ target, target_fence_sha256: fence.sha }] };
  function effect(id: string, effectState = "INTENT", generation = target.managed_generation) {
    core.prepare("INSERT INTO projection_managed_item_effect VALUES(?,?,?,?)")
      .run(id, target.managed_instance_id, generation, effectState);
  }
  const store = createD1AiSearchGenerationRegistryStore(binding(search));
  const { authority } = promotionAuthority();
  const service = createAiSearchGenerationRegistryService(store, { promotion_evidence: { ...authority, ...drain,
    async readCurrentEvidence(target) {
      if (state.expired) throw new Error("source admission expired");
      return authority.readCurrentEvidence(target);
    },
  } });
  return { core, search, clock, profile, target, fence, state, drain, request, effect, store, service };
}

test("durable target hold blocks prepare after worker expiry, overlapping holds, mutation and deletion", async () => {
  const w = await world();
  w.effect("settled", "READBACK_VERIFIED");
  let captured: ManagedGenerationPromotionHoldV1 | undefined;
  await expect(w.drain.runWithTargetWriterDrain(w.request, async (hold) => {
    captured = hold;
    expect(() => w.effect("late")).toThrow("MANAGED_TARGET_WRITERS_HELD");
    expect(() => w.core.prepare("UPDATE projection_managed_item_effect SET state='DISPATCHED' WHERE item_key='settled'").run())
      .toThrow("MANAGED_TARGET_WRITERS_HELD");
    w.effect("other", "INTENT", "other-generation");
    throw new Error("lost callback ACK");
  })).rejects.toThrow("lost callback ACK");
  w.clock.now += 120_000;
  expect(() => w.effect("after-expiry")).toThrow("MANAGED_TARGET_WRITERS_HELD");
  await expect(w.drain.runWithTargetWriterDrain({ ...w.request, operation_id: "competing" }, async () => undefined))
    .rejects.toThrow("atomically exclude");
  expect(() => w.core.prepare("UPDATE operation_execution_lease SET state='FAILED' WHERE operation_id=?").run(w.request.operation_id))
    .toThrow("MANAGED_TARGET_HOLD_IMMUTABLE");
  expect(() => w.core.prepare("DELETE FROM operation_execution_lease WHERE operation_id=?").run(w.request.operation_id))
    .toThrow("MANAGED_TARGET_HOLD_IMMUTABLE");
  if (captured === undefined) throw new Error("hold was not acquired");
  await w.drain.assertTargetWriterDrainHold(captured);
  w.fence.sha = "f".repeat(64);
  await expect(w.drain.assertTargetWriterDrainHold(captured)).rejects.toThrow("current target authority changed");
  w.core.close(); w.search.close();
});

test.each(["INTENT", "DISPATCHED", "UNKNOWN"])("%s effect blocks hold acquisition before the commit callback", async (state) => {
  const w = await world();
  w.effect("pending", state);
  let called = false;
  await expect(w.drain.runWithTargetWriterDrain(w.request, async () => { called = true; }))
    .rejects.toThrow("atomically exclude");
  expect(called).toBe(false);
  expect(w.core.prepare("SELECT COUNT(*) AS n FROM operation_execution_lease").get()?.n).toBe(0);
  w.core.close(); w.search.close();
});

test("callback success without a committed transition cannot release a hold; forged readback also fails", async () => {
  const w = await world();
  await expect(w.drain.runWithTargetWriterDrain(w.request, async () => "success"))
    .rejects.toThrow("unique committed Search transition");
  await expect(w.drain.reconcileTargetWriterDrain({ operation_id: w.request.operation_id,
    registry_readback: { namespace: "search-main", revision: 1, artifact_sha256: "a".repeat(64), active_head_generation: null } }))
    .rejects.toThrow("unique committed Search transition");
  expect(w.core.prepare("SELECT state FROM operation_execution_lease").get()?.state).toBe("LEASED");
  expect(w.state.reconciliations).toBe(0);
  w.core.close(); w.search.close();
});

test("real Search qualification CAS releases only after exact transition readback and Core reconciliation", async () => {
  const w = await world();
  await w.service.declare({ namespace: "search-main", profile: w.profile, declared_at: "2026-10-14T18:00:00.000Z" });
  const result = await w.service.qualify("search-main", { generation: w.target.managed_generation });
  expect(result.operation).toBe("QUALIFY");
  expect(w.state.reconciliations).toBe(1);
  expect(w.core.prepare("SELECT state FROM operation_execution_lease").get()?.state).toBe("COMPLETED");
  w.effect("after-release");
  w.core.close(); w.search.close();
});

test("committed Search CAS plus lost Core ACK retains the hold and exact replay reconciles without another CAS", async () => {
  const w = await world();
  await w.service.declare({ namespace: "search-main", profile: w.profile, declared_at: "2026-10-14T18:00:00.000Z" });
  w.state.failReconcile = true;
  await expect(w.service.qualify("search-main", { generation: w.target.managed_generation })).rejects.toThrow("Core root activation ACK unavailable");
  expect(w.core.prepare("SELECT state FROM operation_execution_lease").get()?.state).toBe("LEASED");
  expect(() => w.effect("uncertain")).toThrow("MANAGED_TARGET_WRITERS_HELD");
  const before = await w.service.read("search-main");
  w.state.failReconcile = false;
  await w.service.qualify("search-main", { generation: w.target.managed_generation });
  const after = await w.service.read("search-main");
  expect(after?.artifact.revision).toBe(before?.artifact.revision);
  expect(w.core.prepare("SELECT state FROM operation_execution_lease").get()?.state).toBe("COMPLETED");
  w.core.close(); w.search.close();
});

test("qualification recovery tolerates a later DECLARE and expired source by blocking the old Core root", async () => {
  const w = await world();
  await w.service.declare({ namespace: "search-main", profile: w.profile, declared_at: "2026-10-14T18:00:00.000Z" });
  w.state.failReconcile = true;
  await expect(w.service.qualify("search-main", { generation: w.target.managed_generation })).rejects.toThrow("Core root activation ACK unavailable");
  const applied = await w.service.read("search-main");
  await w.service.declare({ namespace: "search-main", profile: { ...w.profile, generation: "generation-c" },
    declared_at: "2026-10-14T18:04:00.000Z" });
  const advanced = await w.service.read("search-main");
  expect(advanced?.artifact.revision).toBe((applied?.artifact.revision ?? 0) + 1);
  w.state.failReconcile = false;
  w.state.expired = true;
  w.fence.sha = "f".repeat(64);
  await w.service.qualify("search-main", { generation: w.target.managed_generation });
  expect(w.state.root).toBe("BLOCKED");
  expect(w.state.appliedRevision).toBe(applied?.artifact.revision);
  expect(w.state.currentRevision).toBe(advanced?.artifact.revision);
  expect((await w.service.read("search-main"))?.artifact.revision).toBe(advanced?.artifact.revision);
  expect(w.core.prepare("SELECT state FROM operation_execution_lease").get()?.state).toBe("COMPLETED");
  // A fresh qualification still checks current source authority after recovery.
  await expect(w.service.qualify("search-main", { generation: w.target.managed_generation })).rejects.toThrow("authoritative promotion evidence read failed");
  w.core.close(); w.search.close();
});
