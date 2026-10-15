/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, test } from "vitest";
import {
  createD1ManagedSourceDependencies,
  managedManifestDependencyRoot,
  readManagedRootDependencySet,
  type ManagedDependencySourceFence,
} from "./managed-source-dependencies.js";
import { projectionSha256Utf8 } from "./canonical.js";

interface SqlStatement {
  readonly sql: string;
  readonly bindings: Record<string, SQLInputValue>;
}

function d1(db: DatabaseSync, lostAck: { next: boolean }): D1Database {
  function statement(sql: string, args: readonly SQLInputValue[] = []) {
    const bindings = Object.fromEntries(args.map((value, i) => [String(i + 1), value]));
    return {
      sql, bindings,
      bind(...values: SQLInputValue[]) { return statement(sql, values); },
      async all() { return { success: true, results: db.prepare(sql).all(bindings) }; },
      async run() {
        const result = db.prepare(sql).run(bindings);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare: statement,
    async batch(statements: readonly SqlStatement[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map(({ sql, bindings }) => {
          const result = db.prepare(sql).run(bindings);
          return { success: true, results: [], meta: { changes: Number(result.changes) } };
        });
        db.exec("COMMIT");
        if (lostAck.next) {
          lostAck.next = false;
          throw new Error("lost ACK after durable commit");
        }
        return results;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function world() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE source(source_id TEXT PRIMARY KEY,source_namespace_id TEXT,source_owner_system_id TEXT,
      source_owner_generation TEXT,source_class TEXT,head_rev TEXT,ownership_mode TEXT);
    CREATE TABLE source_revision(source_revision_ref TEXT PRIMARY KEY,source_id TEXT,
      source_owner_generation TEXT,object_residency_key_digest TEXT,content_sha256 TEXT,purge_state TEXT);
    CREATE TABLE source_namespace_ownership(source_namespace_id TEXT,owner_system_id TEXT,
      source_owner_generation TEXT,ownership_record_revision INTEGER,source_admission_policy_revision INTEGER,status TEXT);
    CREATE TABLE source_admission_policy(source_namespace_id TEXT,source_class TEXT,revision INTEGER,
      allowed_use_json TEXT,allowed_ownership_modes_json TEXT);
    CREATE TABLE source_admission_decision(source_revision_ref TEXT,decision_receipt_ref TEXT,decision_sha256 TEXT,
      decision TEXT,source_owner_generation TEXT,owner_system_id TEXT,source_namespace_id TEXT,
      source_class TEXT,expires_at TEXT,created_at TEXT,allowed_use_json TEXT,object_residency_key_digest TEXT);
  `);
  const registry = readFileSync(new URL("../../../infra/d1/core/migrations/0008_erasure_closure.sql", import.meta.url), "utf8");
  db.exec(registry.slice(registry.indexOf("CREATE TABLE erasure_dependency_registry"), registry.indexOf("CREATE TABLE erasure_hold")));
  db.exec(readFileSync(new URL("../../../infra/d1/core/migrations/0148_managed_manifest_dependency_roots.sql", import.meta.url), "utf8"));
  const lostAck = { next: false };
  const binding = d1(db, lostAck);
  const expectedSet = { extra_count: 0, wrong_digest: false };
  const port = createD1ManagedSourceDependencies(binding, {
    async readExpected(root) {
      const actual = await readManagedRootDependencySet(binding, root.root_ref);
      return {
        protocol: "eliotr.managed-root-dependency-set.v1", root_ref: root.root_ref,
        manifest_ref: `${root.build_prefix}root.json`, manifest_sha256: "f".repeat(64),
        dependency_count: actual.count + expectedSet.extra_count,
        dependency_set_sha256: expectedSet.wrong_digest ? "0".repeat(64) : actual.sha256,
      };
    },
  });
  function source(id: string): ManagedDependencySourceFence {
    db.prepare("INSERT INTO source VALUES(?,?,?,?,?,?,?)").run(id, `namespace-${id}`, "system", "owner-1", "PUBLIC", `rev-${id}`, "immutable_import");
    db.prepare("INSERT INTO source_revision VALUES(?,?,?,?,?,?)").run(`rev-${id}`, id, "owner-1", "a".repeat(64), "b".repeat(64), "LIVE");
    db.prepare("INSERT INTO source_namespace_ownership VALUES(?,?,?,?,?,?)").run(`namespace-${id}`, "system", "owner-1", 1, 1, "ACTIVE");
    db.prepare("INSERT INTO source_admission_policy VALUES(?,?,?,?,?)").run(`namespace-${id}`, "PUBLIC", 1, '["research"]', '["immutable_import"]');
    db.prepare("INSERT INTO source_admission_decision VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      `rev-${id}`, `admission-${id}`, "c".repeat(64), "ADMITTED", "owner-1", "system", `namespace-${id}`, "PUBLIC", null, "2026-10-14T00:00:00Z", '["research"]', "a".repeat(64));
    return {
      source_revision_ref: `rev-${id}`, source_id: id, source_namespace_id: `namespace-${id}`,
      source_owner_system_id: "system", source_owner_generation: "owner-1",
      object_residency_key_digest: "a".repeat(64), content_sha256: "b".repeat(64),
      ownership_record_revision: 1, source_admission_policy_revision: 1, source_class: "PUBLIC",
      admission_decision_receipt_ref: `admission-${id}`, admission_decision_sha256: "c".repeat(64),
    };
  }
  return { db, port, source, lostAck, expectedSet, binding };
}

const asOf = "2026-10-14T23:59:00Z";
const prefix = "managed-target-manifests/target/build-1/";

test("exact immutable source registration survives lost ACK and rejects divergent bytes", async () => {
  const w = world();
  try {
    const source = w.source("A");
    const root = await managedManifestDependencyRoot(prefix);
    const object = { key: `${prefix}copies/A.json`, sha256: "d".repeat(64), kind: "COPY_REF" as const };
    const input = { root, source, as_of: asOf, objects: [object] };
    w.lostAck.next = true;
    await expect(w.port.register(input)).rejects.toThrow("lost ACK");
    expect((await w.port.register(input)).registered_count).toBe(1);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM erasure_dependency_registry").get()?.n).toBe(1);
    await expect(w.port.register({ ...input, objects: [{ ...object, sha256: "e".repeat(64) }] })).rejects.toThrow("immutable dependency");
  } finally { w.db.close(); }
});

test("current source, owner, residency, admission and policy fence guard the actual INSERT", async () => {
  const w = world();
  try {
    const source = w.source("A");
    const root = await managedManifestDependencyRoot(prefix);
    for (const changed of [
      { source_owner_generation: "other-owner" }, { object_residency_key_digest: "d".repeat(64) },
      { ownership_record_revision: 2 }, { admission_decision_sha256: "d".repeat(64) },
      { source_admission_policy_revision: 2 }, { source_class: "PRIVATE" },
    ]) {
      await expect(w.port.register({ root, source: { ...source, ...changed }, as_of: asOf,
        objects: [{ key: `${prefix}copies/A.json`, sha256: "d".repeat(64), kind: "COPY_REF" }] })).rejects.toThrow("source authority");
    }
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM erasure_dependency_registry").get()?.n).toBe(0);
  } finally { w.db.close(); }
});

test("a two-source root is blocked atomically by one purge and preserves unrelated dependencies", async () => {
  const w = world();
  try {
    const root = await managedManifestDependencyRoot(prefix);
    for (const id of ["A", "B"]) {
      await w.port.register({ root, source: w.source(id), as_of: asOf, objects: [
        { key: `${prefix}copies/${id}.json`, sha256: "d".repeat(64), kind: "COPY_REF" },
        { key: `${prefix}root.json`, sha256: "e".repeat(64), kind: "SHARED_REF" },
      ] });
    }
    await w.port.activateRoot(root, 2, 2);
    await w.port.assertActiveRoot(root, 2, 2);
    w.db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref=?").run("rev-A");
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM erasure_dependency_registry WHERE managed_root_state='BLOCKED'").get()?.n).toBe(4);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM erasure_dependency_registry WHERE exact_subject_ref='source-revision:rev-B' AND state='ACTIVE'").get()?.n).toBe(2);
    await expect(w.port.assertActiveRoot(root, 2, 2)).rejects.toThrow("no longer current");
    await expect(w.port.activateRoot(root, 2, 2)).rejects.toThrow("no longer current");
    expect(w.db.prepare("SELECT COUNT(DISTINCT shared_reference_key) AS n FROM erasure_dependency_registry WHERE managed_object_kind='SHARED_REF'").get()?.n).toBe(1);
  } finally { w.db.close(); }
});

test("root publication and read fail after owner or admission authority changes", async () => {
  const w = world();
  try {
    const root = await managedManifestDependencyRoot(prefix);
    await w.port.register({ root, source: w.source("A"), as_of: asOf,
      objects: [{ key: `${prefix}copies/A.json`, sha256: "d".repeat(64), kind: "COPY_REF" }] });
    await w.port.activateRoot(root, 1, 1);
    w.db.prepare("UPDATE source_namespace_ownership SET status='FENCED'").run();
    await expect(w.port.assertActiveRoot(root, 1, 1)).rejects.toThrow("no longer current");
    w.db.prepare("UPDATE source_namespace_ownership SET status='ACTIVE'").run();
    w.db.prepare("UPDATE source_admission_decision SET expires_at='2020-01-01T00:00:00Z'").run();
    await expect(w.port.assertActiveRoot(root, 1, 1)).rejects.toThrow("no longer current");
  } finally { w.db.close(); }
});

test("the current policy and admitted decision must still permit research and the current ownership mode", async () => {
  const w = world();
  try {
    const root = await managedManifestDependencyRoot(prefix);
    const input = { root, source: w.source("A"), as_of: asOf,
      objects: [{ key: `${prefix}copies/A.json`, sha256: "d".repeat(64), kind: "COPY_REF" as const }] };
    w.db.exec("UPDATE source_admission_policy SET allowed_ownership_modes_json='[]'");
    await expect(w.port.register(input)).rejects.toThrow("source authority");
    w.db.exec(`UPDATE source_admission_policy SET allowed_ownership_modes_json='["immutable_import"]',allowed_use_json='[]'`);
    await expect(w.port.register(input)).rejects.toThrow("source authority");
    w.db.exec(`UPDATE source_admission_policy SET allowed_use_json='["research"]'`);
    w.db.exec("UPDATE source_admission_decision SET allowed_use_json='[]'");
    await expect(w.port.register(input)).rejects.toThrow("source authority");
    w.db.exec(`UPDATE source_admission_decision SET allowed_use_json='["research"]'`);
    await w.port.register(input);
    await w.port.activateRoot(root, 1, 1);
    w.db.exec("UPDATE source_admission_policy SET allowed_use_json='[]'");
    await expect(w.port.assertActiveRoot(root, 1, 1)).rejects.toThrow("no longer current");
  } finally { w.db.close(); }
});

test("activation and active reads require the complete immutable Work dependency set, not just copy/source counts", async () => {
  const w = world();
  try {
    const root = await managedManifestDependencyRoot(prefix);
    await w.port.register({ root, source: w.source("A"), as_of: asOf,
      objects: [{ key: `${prefix}copies/A.json`, sha256: "d".repeat(64), kind: "COPY_REF" }] });
    // The trusted immutable receipt also includes a shared root ref that was
    // omitted from registration. Source/copy counts alone still equal 1/1.
    w.expectedSet.extra_count = 1;
    await expect(w.port.activateRoot(root, 1, 1)).rejects.toThrow("complete immutable Work receipt");
    w.expectedSet.extra_count = 0;
    w.expectedSet.wrong_digest = true;
    await expect(w.port.activateRoot(root, 1, 1)).rejects.toThrow("complete immutable Work receipt");
    w.expectedSet.wrong_digest = false;
    await w.port.activateRoot(root, 1, 1);
    w.expectedSet.wrong_digest = true;
    await expect(w.port.assertActiveRoot(root, 1, 1)).rejects.toThrow("complete immutable Work receipt");
    await expect(createD1ManagedSourceDependencies(w.binding).activateRoot(root, 1, 1))
      .rejects.toThrow("immutable root dependency authority is unavailable");
  } finally { w.db.close(); }
});

test("root is sealed to new dependencies while exact registration replay remains valid", async () => {
  const w = world();
  try {
    const root = await managedManifestDependencyRoot(prefix);
    const source = w.source("A");
    const object = { key: `${prefix}copies/A.json`, sha256: "d".repeat(64), kind: "COPY_REF" as const };
    const input = { root, source, as_of: asOf, objects: [object] };
    await w.port.register(input);
    await expect(w.port.activateRoot(root, 2, 1)).rejects.toThrow("incomplete");
    await w.port.activateRoot(root, 1, 1);
    await w.port.register(input);
    await expect(w.port.register({ ...input, objects: [{ ...object, key: `${prefix}copies/late.json` }] })).rejects.toThrow("sealed");
  } finally { w.db.close(); }
});

test("canonical source objects remain source scoped and can be reused by multiple build roots", async () => {
  const w = world();
  try {
    const source = w.source("A");
    const sourcePrefix = `projection/${(await projectionSha256Utf8("source\0rev-A")).slice(0, 48)}/`;
    const object = { key: `${sourcePrefix}canonical/item.md`, sha256: "d".repeat(64), kind: "CANONICAL" as const };
    const objects = [object];
    await w.port.register({ root: await managedManifestDependencyRoot(prefix), source, objects, as_of: asOf });
    await w.port.register({ root: await managedManifestDependencyRoot(`${prefix}other/`), source, objects, as_of: asOf });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM erasure_dependency_registry").get()?.n).toBe(1);
    await expect(w.port.register({ root: await managedManifestDependencyRoot(prefix), source, as_of: asOf,
      objects: [{ ...object, key: "projection/foreign/item.md" }] })).rejects.toThrow("escaped");
  } finally { w.db.close(); }
});
