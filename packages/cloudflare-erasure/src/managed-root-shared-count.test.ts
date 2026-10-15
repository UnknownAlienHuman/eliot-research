/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { registeredSharedCount } from "./inventory-readers.js";
import { createD1ErasureInventory } from "./inventory.js";
import { erasureDigest } from "./canonical.js";
import { projectionWorkPrefix } from "./empty-location-proof-r2.js";
import type { ErasureRequest } from "@eliotr/contracts";

function sqliteBinding(db: DatabaseSync): D1Database {
  function prepare(sql: string, values: readonly SQLInputValue[] = []) {
    const args = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
    return {
      bind(...next: SQLInputValue[]) { return prepare(sql, next); },
      async first() { return db.prepare(sql).get(args) ?? null; },
      async all() { return { success: true, results: db.prepare(sql).all(args) }; },
    };
  }
  return { prepare } as unknown as D1Database;
}

function world() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE erasure_dependency_registry(exact_subject_ref TEXT,shared_reference_key TEXT,state TEXT," +
    "managed_root_ref TEXT,managed_root_state TEXT,managed_object_kind TEXT)");
  const binding = {
    prepare(sql: string) {
      return { bind(...values: SQLInputValue[]) {
        const args = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
        return { async all() { return { success: true, results: db.prepare(sql).all(args) }; } };
      } };
    },
  } as unknown as D1Database;
  function row(subject: string, root: string | null = "managed-root:one", state: string | null = "BLOCKED",
    kind: string | null = "SHARED_REF", shared = "shared-tree") {
    db.prepare("INSERT INTO erasure_dependency_registry VALUES(?,?,'ACTIVE',?,?,?)").run(subject, shared, root, state, kind);
  }
  return { db, binding, row, selected: new Set(["source-revision:A"]) };
}

test("a fully blocked shared metadata root retires only with a complete immutable verifier", async () => {
  const w = world();
  w.row("source-revision:A"); w.row("source-revision:B"); w.row("source-revision:C");
  expect(await registeredSharedCount(w.binding, "shared-tree", w.selected)).toBe(2);
  const verified: string[] = [];
  expect(await registeredSharedCount(w.binding, "shared-tree", w.selected, async root => { verified.push(root); })).toBe(0);
  expect(verified).toEqual(["managed-root:one"]);
  await expect(registeredSharedCount(w.binding, "shared-tree", w.selected, async () => { throw new Error("omitted shared ref"); }))
    .rejects.toThrow("complete immutable dependency proof");
  w.db.close();
});

test.each(["BUILDING", "ACTIVE"])("a %s root retains its unrelated source references", async state => {
  const w = world();
  w.row("source-revision:B", "managed-root:one", state);
  let verified = false;
  expect(await registeredSharedCount(w.binding, "shared-tree", w.selected, async () => { verified = true; })).toBe(1);
  expect(verified).toBe(false);
  w.db.close();
});

test("a partial root, legacy shared ref, and unrelated copy object all retain live references", async () => {
  const w = world();
  w.row("source-revision:B");
  w.row("source-revision:C", "managed-root:one", "ACTIVE", "COPY_REF", "other-key");
  w.row("source-revision:D", null, null, null);
  w.row("source-revision:E", "managed-root:two", "BLOCKED", "COPY_REF");
  let verified = false;
  expect(await registeredSharedCount(w.binding, "shared-tree", w.selected, async () => { verified = true; })).toBe(3);
  expect(verified).toBe(false);
  w.db.close();
});

test("a verified blocked root does not discount a separate live root sharing the same exact object", async () => {
  const w = world();
  w.row("source-revision:B");
  w.row("source-revision:C", "managed-root:two", "ACTIVE");
  const verified: string[] = [];
  expect(await registeredSharedCount(w.binding, "shared-tree", w.selected, async root => { verified.push(root); })).toBe(1);
  expect(verified).toEqual(["managed-root:one"]);
  w.db.close();
});

test("actual inventory forwards full-root verification without selecting the unrelated source", async () => {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../../../infra/d1/core/migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(file => /^\d{4}_.*\.sql$/u.test(file)).sort()) {
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const at = "2026-10-14T18:00:00.000Z";
  db.prepare("INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision,owner_system_id," +
    "owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,created_at) " +
    "VALUES('namespace',1,'system','incarnation','owner-generation',1,'ACTIVE',?)").run(at);
  for (const id of ["A", "B"]) {
    db.prepare("INSERT INTO source(source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode," +
      "kind,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,created_at) " +
      "VALUES(?,'namespace','system','owner-generation','immutable_import','document',?,'retain','private','PUBLIC','license','retention',?)")
      .run(`source-${id}`, id, at);
    db.prepare("INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation,content_sha256," +
      "object_residency_key_digest,captured_at,quality_state,purge_state,source_view_ref,admitted_at) " +
      "VALUES(?,?,'owner-generation',?,?,?,'standard','LIVE',?,?)")
      .run(id, `source-${id}`, "a".repeat(64), "b".repeat(64), at, `view-${id}`, at);
  }
  const key = "managed-target-manifests/target/builds/build/tree.json";
  const expected: Record<string, SQLInputValue>[] = [];
  for (const id of ["A", "B"]) {
    const subject = `source-revision:${id}`, ref = `r2-work:${key}`;
    const digest = await erasureDigest({ exact_subject_ref: subject, location: "Projection", canonical_ref: ref, provider_ref: null });
    const entry = { dependency_id: `dependency-${id}`, exact_subject_ref: subject, canonical_ref: ref,
      object_identity_digest: digest, shared_reference_key: "shared-tree", managed_object_kind: "SHARED_REF", managed_source_fence_json: "{}" };
    expected.push(entry);
    db.prepare("INSERT INTO erasure_dependency_registry(dependency_id,exact_subject_ref,location,canonical_ref,object_identity_digest," +
      "shared_reference_key,state,created_at,updated_at,managed_root_ref,managed_root_state,managed_object_kind,managed_source_fence_json) " +
      "VALUES(?,?,'Projection',?,?,'shared-tree','ACTIVE',?,?,'managed-root:one','BUILDING','SHARED_REF','{}')")
      .run(entry.dependency_id, subject, ref, digest, at, at);
  }
  // This is the actual 0148 atomic retirement trigger, not an operator flag.
  db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref='A'").run();
  const prefix = await projectionWorkPrefix("A");
  const bucket = { async list() { return { objects: [{ key: `${prefix}body.md` }], truncated: false }; } } as unknown as R2Bucket;
  const request: ErasureRequest = { protocol: "erc.privacy.erasure.v1", erasure_ref: { id: "erase-A", revision: 1 },
    requested_by_principal_ref: "owner", exact_subject_refs: ["source-revision:A"], required_locations: ["Projection"],
    legal_basis_ref: "owner-request", admitted_at: at, deadline: "2026-10-15T18:00:00.000Z" };
  const make = (verify?: (ref: string) => Promise<void>) => createD1ErasureInventory({ core_database: sqliteBinding(db),
    search_database: {} as D1Database, work_bucket: bucket,
    ...(verify === undefined ? {} : { verify_managed_root_dependency_set: verify }) });
  const before = await make().enumerate(request);
  expect(before.targets.find(target => target.canonical_ref === `r2-work:${key}`)?.shared_live_reference_count).toBe(1);
  let verified = 0;
  const after = await make(async root => {
    expect(root).toBe("managed-root:one");
    // Fixture expected set originates independently of the D1 readback.
    expect(db.prepare("SELECT dependency_id,exact_subject_ref,canonical_ref,object_identity_digest,shared_reference_key," +
      "managed_object_kind,managed_source_fence_json FROM erasure_dependency_registry WHERE managed_root_ref=? ORDER BY dependency_id")
      .all(root).map(row => ({ ...row }))).toEqual(expected);
    verified += 1;
  }).enumerate(request);
  expect(verified).toBe(1);
  expect(after.targets.find(target => target.canonical_ref === `r2-work:${key}`)?.shared_live_reference_count).toBe(0);
  expect(after.targets.some(target => target.exact_subject_ref === "source-revision:B")).toBe(false);
  expect(db.prepare("SELECT purge_state FROM source_revision WHERE source_revision_ref='B'").get()?.purge_state).toBe("LIVE");
  db.close();
});
