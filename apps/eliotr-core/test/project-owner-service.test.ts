import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { sha256Utf8 } from "@eliotr/platform-cloudflare";
import { createProjectOwnerService } from "../src/project-owner-service.js";
import { db, insert, observeDatabase, principal, runtime, seedSource, setupOrientationDatabase } from "./orientation-fixture.js";

let clock: number;
beforeEach(async () => { await reset(); await setupOrientationDatabase(); clock = Date.now(); });

function context(key: string, who = principal): AuthenticatedRequestContext {
  return { request: new Request("https://research.example/api/v1/projects", {
    method: "POST", headers: { "idempotency-key": key },
  }), principal_ref: who, client_class: "owner_pwa", credential_generation: "credential-v1", trace_id: `trace-${key}` };
}

function service(database = db) {
  return createProjectOwnerService({ database, deployment_generation: runtime.DEPLOYMENT_GENERATION, now: () => clock });
}

async function source(id: string) {
  await seedSource(id);
  // The shared fixture supplies admitted revisions and explicit read grants;
  // project mutations also require the matching current admission policy.
  await insert("source_admission_policy", { source_namespace_id: `ns-${id}`, revision: 1,
    authorized_principal_refs_json: JSON.stringify([principal]), allowed_ownership_modes_json: '["immutable_import"]',
    source_class: "document", assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY",
    allowed_use_json: '["research"]', disclosure_ceiling: "private", license_policy_ref: "license-1",
    default_storage_policy: "NORMALIZED_CLOUD_ONLY", default_residency_profile_id: "residency-1",
    default_retention_policy_id: "retention-1", minimum_quality_state: "standard", created_at: new Date(clock).toISOString() });
}

async function snapshot() {
  const tables = ["project", "project_owner", "project_source_membership", "project_mutation_receipt",
    "project_mutation_guard", "outbox"] as const;
  return Promise.all(tables.map(async (table) => {
    const rows = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    expect(rows.success).toBe(true);
    return { table, rows: rows.results };
  }));
}

async function memberships(id: string) {
  return (await db.prepare("SELECT source_id,membership_generation,valid_from,valid_to FROM project_source_membership " +
    "WHERE project_id=?1 ORDER BY membership_generation,source_id").bind(id).all<{
      source_id: string; membership_generation: number; valid_from: string; valid_to: string | null;
    }>()).results;
}

async function receipt(key: string) {
  const row = await db.prepare("SELECT response_json,response_sha256,request_sha256,project_revision FROM project_mutation_receipt " +
    "WHERE principal_ref=?1 AND idempotency_key=?2").bind(principal, key).first<{
      response_json: string; response_sha256: string; request_sha256: string; project_revision: number;
    }>();
  if (row === null) throw new Error("missing project mutation receipt");
  expect(row.response_sha256).toBe(await sha256Utf8(row.response_json));
  expect(row.request_sha256).toMatch(/^[a-f0-9]{64}$/u);
  return row;
}

describe("S04 project mutations on actual Workers D1", () => {
  it("applies the current migrations and enforces D1's depth-100 expression boundary", async () => {
    const applied = (await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results;
    expect(applied.map(({ name }) => name)).toEqual(runtime.CORE_MIGRATIONS.map(({ name }) => name));
    const expression = (terms: number) => `SELECT ${Array.from({ length: terms }, () => "1").join(" + ")} AS n`;
    expect(await db.prepare(expression(100)).first<number>("n")).toBe(100);
    await expect(db.prepare(expression(101)).first()).rejects.toThrow(/Expression tree is too large|Expression tree too large/iu);
    expect(await db.prepare("SELECT 1 AS n").first<number>("n")).toBe(1);
  });

  it("creates, replaces and removes memberships with immutable exact receipts and replay", async () => {
    for (const id of ["s04-a", "s04-b", "s04-c"]) await source(id);
    const owner = service();
    const initial = await owner.create(context("create"), { idempotency_key: "create", title: "Project", source_ids: ["s04-b", "s04-a"] });
    const id = initial.project_ref.id;
    expect(initial).toMatchObject({ revision: 1, source_ids: ["s04-a", "s04-b"], owner_principal_ref: principal });
    expect(JSON.parse((await receipt("create")).response_json)).toEqual(initial);
    const created = await snapshot();
    await expect(service().create(context("create"), { idempotency_key: "create", title: "Project", source_ids: ["s04-a", "s04-b"] })).resolves.toEqual(initial);
    expect(await snapshot()).toEqual(created);

    clock += 1000;
    const input = { idempotency_key: "update", expected_revision: 1, title: "Project updated", source_ids: ["s04-c", "s04-a"] };
    const updated = await owner.update(context("update"), id, input);
    expect(updated).toMatchObject({ project_ref: { id, revision: 2 }, title: input.title, source_ids: ["s04-a", "s04-c"] });
    await expect(owner.read(context("read"), id)).resolves.toEqual(updated);
    expect(JSON.parse((await receipt("update")).response_json)).toEqual(updated);
    const rows = await memberships(id);
    expect(rows.map(({ source_id, membership_generation, valid_to }) => [source_id, membership_generation, valid_to])).toEqual([
      ["s04-a", 1, new Date(clock).toISOString()], ["s04-b", 1, new Date(clock).toISOString()],
      ["s04-a", 2, null], ["s04-c", 2, null],
    ]);
    const committed = await snapshot();
    await expect(service().update(context("update"), id, input)).resolves.toEqual(updated);
    await expect(owner.update(context("update"), id, { ...input, title: "Changed replay" }))
      .rejects.toMatchObject({ code: "PROJECT_IDEMPOTENCY_CONFLICT", status: 409 });
    expect(await snapshot()).toEqual(committed);

    clock += 1000;
    await expect(owner.update(context("remove"), id, { idempotency_key: "remove", expected_revision: 2, title: "Empty project", source_ids: [] }))
      .resolves.toMatchObject({ revision: 3, source_ids: [] });
    expect((await memberships(id)).every(({ valid_to }) => valid_to !== null)).toBe(true);
    expect(await db.prepare("SELECT count(*) AS n FROM project_mutation_guard").first<number>("n")).toBe(0);
    // Projects do not currently emit an outbox event; do not invent one in a test.
    expect(await db.prepare("SELECT count(*) AS n FROM outbox").first<number>("n")).toBe(0);
  });

  it("rejects a stale preflight and a foreign owner without changing durable state", async () => {
    await source("s04-a");
    const owner = service();
    const created = await owner.create(context("create"), { idempotency_key: "create", title: "Original", source_ids: ["s04-a"] });
    const id = created.project_ref.id;
    const before = await snapshot();
    await expect(owner.update(context("stale"), id, { idempotency_key: "stale", expected_revision: 2, title: "Stale", source_ids: [] }))
      .rejects.toMatchObject({ code: "PROJECT_REVISION_CONFLICT", status: 409 });
    await expect(owner.update(context("foreign", "other-owner"), id, { idempotency_key: "foreign", expected_revision: 1, title: "Foreign", source_ids: [] }))
      .rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back the losing native batch when another service commits after preflight", async () => {
    for (const id of ["s04-a", "s04-b"]) await source(id);
    const owner = service();
    const created = await owner.create(context("create"), { idempotency_key: "create", title: "Original", source_ids: ["s04-a"] });
    const id = created.project_ref.id;
    clock += 1000;
    let batches = 0;
    let winnerSnapshot: Awaited<ReturnType<typeof snapshot>> | undefined;
    const racing = observeDatabase(async (sql, phase) => {
      if (sql !== "BATCH" || phase !== "before") return;
      batches += 1;
      expect(batches).toBe(1);
      await owner.update(context("winner"), id, { idempotency_key: "winner", expected_revision: 1, title: "Winner", source_ids: ["s04-b"] });
      winnerSnapshot = await snapshot();
    });
    await expect(service(racing).update(context("loser"), id, { idempotency_key: "loser", expected_revision: 1, title: "Loser", source_ids: [] }))
      .rejects.toMatchObject({ code: "PROJECT_REVISION_CONFLICT", status: 409 });
    expect(batches).toBe(1);
    expect(await snapshot()).toEqual(winnerSnapshot);
    expect(await owner.read(context("read"), id)).toMatchObject({ title: "Winner", revision: 2, source_ids: ["s04-b"] });
    expect(await db.prepare("SELECT count(*) AS n FROM project_mutation_receipt WHERE idempotency_key='loser'").first<number>("n")).toBe(0);
  });

  it("rechecks read-policy revocation in the native transaction after preflight", async () => {
    await source("s04-a");
    const created = await service().create(context("create"), { idempotency_key: "create", title: "Original", source_ids: ["s04-a"] });
    const before = await snapshot();
    clock += 1000;
    let batches = 0;
    const revoked = observeDatabase(async (sql, phase) => {
      if (sql !== "BATCH" || phase !== "before") return;
      batches += 1;
      await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id='ns-s04-a'").run();
    });
    await expect(service(revoked).update(context("revoked"), created.project_ref.id,
      { idempotency_key: "revoked", expected_revision: 1, title: "Denied", source_ids: ["s04-a"] }))
      .rejects.toMatchObject({ code: "PROJECT_SOURCE_DENIED", status: 403 });
    expect(batches).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back earlier writes when a later statement fails inside the native batch", async () => {
    await source("s04-a");
    const created = await service().create(context("create"), { idempotency_key: "create", title: "Original", source_ids: [] });
    const before = await snapshot();
    clock += 1000;
    let batches = 0;
    const failing = new Proxy(db, { get(target, key) {
      if (key === "batch") return (statements: D1PreparedStatement[]) => {
        batches += 1;
        // A real NOT NULL/owner constraint failure after the unchanged emitted
        // mutation SQL. No statement, transaction or SQL result is mocked.
        return target.batch([...statements, target.prepare("INSERT INTO project_owner(project_id) VALUES ('s04-fault')")]);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(service(failing).update(context("late-failure"), created.project_ref.id,
      { idempotency_key: "late-failure", expected_revision: 1, title: "Must roll back", source_ids: ["s04-a"] }))
      .rejects.toMatchObject({ code: "PROJECT_SETTLEMENT_UNCERTAIN", status: 503 });
    expect(batches).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it("reconciles a lost native batch acknowledgement by the same durable receipt", async () => {
    await source("s04-a");
    const created = await service().create(context("create"), { idempotency_key: "create", title: "Original", source_ids: [] });
    clock += 1000;
    let committedBatches = 0;
    const lostAck = observeDatabase(async (sql, phase) => {
      if (sql !== "BATCH" || phase !== "after") return;
      committedBatches += 1;
      throw new Error("simulated lost response after actual D1 commit");
    });
    const input = { idempotency_key: "lost-ack", expected_revision: 1, title: "Committed", source_ids: ["s04-a"] };
    const result = await service(lostAck).update(context("lost-ack"), created.project_ref.id, input);
    expect(result).toMatchObject({ revision: 2, source_ids: ["s04-a"] });
    expect(committedBatches).toBe(1);
    const committed = await snapshot();
    const savedReceipt = await receipt("lost-ack");
    await expect(service().update(context("lost-ack"), created.project_ref.id, input)).resolves.toEqual(result);
    expect(await receipt("lost-ack")).toEqual(savedReceipt);
    expect(await snapshot()).toEqual(committed);
  });
});
