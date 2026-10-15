/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, test } from "vitest";
import { registeredSharedCount } from "./inventory-readers.js";

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
