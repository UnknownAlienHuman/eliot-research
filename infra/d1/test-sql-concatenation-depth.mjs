import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { extractSourceText } from "./extract-application-sql.mjs";

const source = fileURLToPath(new URL("../../packages/cloudflare-artifacts/src/artifact-draft-read-authority.ts", import.meta.url));
const production = extractSourceText(readFileSync(source, "utf8"), source);
const delegated = production.queries.find((query) => query.sql.includes("project_client_artifact_read_origin"));
assert.ok(delegated, "recover the real delegated-artifact authority query from its source");
assert.equal(delegated.bindingArity, 14);
assert.equal(delegated.targetStore, "unknown", "SQL recovery does not establish a runtime database binding");
assert.equal(delegated.targetStatus, "unresolved-receiver");
assert.equal(production.unresolved.length, 0);

const db = "const db = { prepare: (sql: string) => sql };\n";
const pieces = ["SELECT '", ...Array.from({ length: 64 }, () => "x"), "'"];
const expression = pieces.map((piece) => JSON.stringify(piece)).join(" + ");
const long = extractSourceText(`${db}db.prepare(${expression});`);
assert.deepEqual(long.queries.map((query) => query.sql), [pieces.join("")]);
assert.equal(long.unresolved.length, 0);

const grouping = extractSourceText(`${db}
db.prepare("SELECT " + (1 + 2));
db.prepare("SELECT " + 1 + 2);
db.prepare("SELECT " + (1 + (2 + 3)));
`);
assert.deepEqual(grouping.queries.map((query) => query.sql), ["SELECT 3", "SELECT 12", "SELECT 6"],
  "retain actual JavaScript addition semantics and parenthesis grouping");

const dynamic = extractSourceText(`${db}db.prepare(${expression} + runtimeValue);`);
assert.equal(dynamic.queries.length, 0);
assert.equal(dynamic.unresolved.length, 1, "a long known prefix cannot authorize an unknown suffix");

const shadowed = extractSourceText(`${db}
const suffix = " FROM must_not_leak";
export function read(suffix: string) { db.prepare(${expression} + suffix); }
`);
assert.equal(shadowed.queries.length, 0);
assert.equal(shadowed.unresolved.length, 1, "a shadowed unknown parameter cannot use the global constant");

const nested = extractSourceText(`${db}db.prepare(${"(".repeat(30)}"SELECT 1"${")".repeat(30)});`);
assert.equal(nested.queries.length, 0);
assert.equal(nested.unresolved.length, 1, "the unrelated evaluator nesting guard remains in force");

process.stdout.write("D1 SQL concatenation: 6 source/grouping/negative groups PASS; database target remains unknown.\n");
