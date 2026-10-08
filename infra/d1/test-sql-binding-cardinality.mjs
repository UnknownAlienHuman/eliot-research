import assert from "node:assert/strict";
import process from "node:process";
import { extractSourceText } from "./extract-application-sql.mjs";

const paired = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function read(sql: string, ...values: unknown[]): void { db.prepare(sql).bind(...values).first(); }
read("SELECT 1 FROM first_row WHERE a=?", runtimeValue);
read("SELECT 1 FROM second_row WHERE a=? AND b=?", runtimeValue, { value: runtimeValue });
function readAfterSpread(head: unknown, sql: string): void { db.prepare(sql).bind(1).first(); }
readAfterSpread(...["head", "SELECT 1 FROM spread_formal"], "SELECT 1 FROM extra_argument");
readAfterSpread(...[runtimeValue, "SELECT 1 FROM untrusted_spread_formal"], "SELECT 1 FROM extra_argument");
`);
assert.deepEqual(paired.queries.map(({ sql, bindingArity }) => [sql, bindingArity]), [
  ["SELECT 1 FROM first_row WHERE a=?", 1],
  ["SELECT 1 FROM second_row WHERE a=? AND b=?", 2],
  ["SELECT 1 FROM spread_formal", 1],
]);
assert.equal(paired.unresolved.some(({ bindingArity }) => bindingArity === 1), true,
  "unknown spread values cannot be used to bind later formal SQL parameters");

const exportedOwner = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function read(sql: string, ...values: unknown[]): void { db.prepare(sql).bind(...values).first(); }
read("SELECT 1 FROM exported_local_call WHERE a=?", runtimeValue);
export { read as publicRead };
`);
assert.deepEqual(exportedOwner.queries.map(({ sql, bindingArity }) => [sql, bindingArity]), [
  ["SELECT 1 FROM exported_local_call WHERE a=?", 1],
]);
assert.equal(exportedOwner.unresolved.length, 1, "the external exported caller remains represented as an unknown context");
assert.equal(exportedOwner.unresolved[0].bindingArity, null);

const escapedOwner = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function read(sql: string, ...values: unknown[]): void { db.prepare(sql).bind(...values).first(); }
read("SELECT 1 FROM escaped_local_call WHERE a=?", runtimeValue);
const callback = read;
`);
assert.deepEqual(escapedOwner.queries.map(({ sql, bindingArity }) => [sql, bindingArity]), [
  ["SELECT 1 FROM escaped_local_call WHERE a=?", 1],
]);
assert.equal(escapedOwner.unresolved.length, 1, "a non-call function reference keeps open-world uncertainty");

const nestedOpenOwner = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
export function outer(sql: string): void {
  function inner(...values: unknown[]): void { db.prepare(sql).bind(...values).first(); }
  inner(1);
}
outer("SELECT 1 FROM nested_open_owner WHERE value=?");
`);
assert.deepEqual(nestedOpenOwner.queries.map(({ sql, bindingArity }) => [sql, bindingArity]), [
  ["SELECT 1 FROM nested_open_owner WHERE value=?", 1],
]);
assert.equal(nestedOpenOwner.unresolved.length, 1,
  "the incomplete exported outer path stays unknown while inner local call arity remains exact");
assert.equal(nestedOpenOwner.unresolved[0].bindingArity, 1,
  "a private inner helper stays closed-world under an exported outer caller");

const unknownSpreadDefault = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function read(sql = "SELECT 1 FROM must_not_default", ...values: unknown[]): void { db.prepare(sql).bind(...values).first(); }
read(...runtimeIterable);
`);
assert.equal(unknownSpreadDefault.queries.length, 0, "an unknown spread cannot be mistaken for an omitted defaulted argument");
assert.equal(unknownSpreadDefault.unresolved.length, 1);

const fixedShapes = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
export async function tuple(): Promise<readonly unknown[]> { return [runtimeValue, { nested: runtimeValue }, runtimeValue]; }
async function read(): Promise<void> {
  const values = [runtimeValue, { nested: runtimeValue }, runtimeValue, runtimeValue];
  db.prepare("SELECT 1 FROM literal_values").bind(...values.slice(0, 3)).first();
  db.prepare("SELECT 1 FROM helper_values").bind(...await tuple()).first();
  (db.prepare("SELECT 1 FROM parenthesized_values")).bind(...[runtimeValue, runtimeValue]).first();
}
read();
`);
assert.deepEqual(fixedShapes.queries.map(({ sql, bindingArity }) => [sql, bindingArity]), [
  ["SELECT 1 FROM literal_values", 3],
  ["SELECT 1 FROM helper_values", 3],
  ["SELECT 1 FROM parenthesized_values", 2],
]);

const unsupportedHelperFlow = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function tuple(which: boolean): readonly unknown[] {
  switch (which) { case true: return [1, 2]; default: return [1]; }
  return [1];
}
function withTuple(): readonly unknown[] {
  with (runtimeObject) { return [1, 2]; }
  return [1];
}
async function asyncTuple(): Promise<readonly unknown[]> { return [1, 2]; }
function* generatorTuple(): Generator<unknown, readonly unknown[], unknown> { return [1, 2]; }
function read(): void {
  db.prepare("SELECT 1 FROM unsupported_helper_flow").bind(...tuple(runtimeFlag)).first();
  db.prepare("SELECT 1 FROM unsupported_with_flow").bind(...withTuple()).first();
  db.prepare("SELECT 1 FROM unawaited_async_result").bind(...asyncTuple()).first();
  db.prepare("SELECT 1 FROM generator_result").bind(...generatorTuple()).first();
}
read();
`);
assert.deepEqual(unsupportedHelperFlow.queries.map(({ bindingArity, bindingProvenance }) => [bindingArity, bindingProvenance]), [
  [null, "dynamic-bind-arguments"],
  [null, "dynamic-bind-arguments"],
  [null, "dynamic-bind-arguments"],
  [null, "dynamic-bind-arguments"],
]);

const mutableHelper = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
let tuple = () => [1];
tuple = () => [1, 2];
db.prepare("SELECT 1 FROM reassigned_helper").bind(...tuple()).first();
function reassignedDeclaration(): number[] { return [1]; }
reassignedDeclaration = () => [1, 2];
db.prepare("SELECT 1 FROM reassigned_function_declaration").bind(...reassignedDeclaration()).first();
`);
assert.deepEqual(mutableHelper.queries.map(({ bindingArity }) => bindingArity), [null, null],
  "a reassigned variable or function-declaration binding cannot provide a return-shape proof");

const spreadValueMutation = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function readAfterSpread(head: unknown, sql: string): void { db.prepare(sql).bind(1).first(); }
function invoke(): void {
  const actuals = ["head"];
  actuals.push("SELECT 1 FROM mutated_spread");
  readAfterSpread(...actuals, "SELECT 1 FROM extra_argument");
}
invoke();
`);
assert.equal(spreadValueMutation.queries.length, 0, "a mutated array cannot supply a later formal SQL value");
assert.equal(spreadValueMutation.unresolved.length, 1);

const shadowedCallValue = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function query(): string { return "SELECT 1 FROM global_query"; }
function read(sql: string, ...values: unknown[]): void { db.prepare(sql).bind(...values).first(); }
function caller(): void {
  function query(): string { return "SELECT 1 FROM local_query"; }
  read(...[query(), 1]);
}
caller();
`);
assert.equal(shadowedCallValue.queries.length, 0,
  "a local function with a global same-name peer cannot contribute the global SQL value");
assert.equal(shadowedCallValue.unresolved.length, 1);

const shadowedCallInitializer = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function query(): string { return "SELECT 1 FROM global_initializer_query"; }
function read(sql: string, ...values: unknown[]): void { db.prepare(sql).bind(...values).first(); }
function caller(): void {
  function query(): string { return "SELECT 1 FROM local_initializer_query"; }
  const sql = query();
  read(sql);
}
caller();
`);
assert.equal(shadowedCallInitializer.queries.length, 0,
  "a call-containing const initializer cannot supply a shadowed SQL parameter");
assert.equal(shadowedCallInitializer.unresolved.length, 1);

const shadowedSliceBound = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function limit(): number { return 1; }
function read(): void {
  function limit(): number { return 2; }
  const values = [1, 2, 3];
  db.prepare("SELECT 1 FROM shadowed_slice_bound").bind(...values.slice(0, limit())).first();
}
read();
`);
assert.equal(shadowedSliceBound.queries[0].bindingArity, null,
  "slice bounds must be literal integers rather than name-resolved helper calls");

const restShape = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
async function read(...values: unknown[]): Promise<void> {
  db.prepare("SELECT 1 FROM rest_values").bind(...values).first();
}
read(runtimeValue, { nested: runtimeValue });
`);
assert.equal(restShape.queries[0].bindingArity, 2);

const mutationAndEscape = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function mutated(): void {
  const values = [1, 2];
  values.push(3);
  db.prepare("SELECT 1 FROM mutated_values").bind(...values).first();
}
function captured(...values: unknown[]): void {
  const later = () => values;
  db.prepare("SELECT 1 FROM captured_values").bind(...values).first();
}
function escaped(): void {
  const values = [1, 2];
  retain(values);
  db.prepare("SELECT 1 FROM escaped_values").bind(...values).first();
}
mutated();
captured(1, 2);
escaped();
`);
assert.deepEqual(mutationAndEscape.queries.map(({ bindingArity }) => bindingArity), [null, null, null]);
assert.ok(mutationAndEscape.queries.every(({ bindingProvenance }) => bindingProvenance === "dynamic-bind-arguments"));

const shadowedCaller = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function read(...values: unknown[]): void { db.prepare("SELECT 1 FROM shadowed_values").bind(...values).first(); }
function caller(): void { const read = (value: unknown) => value; read(runtimeValue); }
caller();
`);
assert.equal(shadowedCaller.queries[0].bindingArity, null);
assert.equal(shadowedCaller.queries[0].bindingProvenance, "dynamic-bind-arguments");

const valueReference = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function read(...values: unknown[]): void { db.prepare("SELECT 1 FROM escaped_function").bind(...values).first(); }
const callback = read;
callback(1, 2);
`);
assert.equal(valueReference.queries[0].bindingArity, null);
assert.equal(valueReference.queries[0].bindingProvenance, "dynamic-bind-arguments");

const unknownSpread = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function read(...values: unknown[]): void { db.prepare("SELECT 1 FROM unknown_spread").bind(...values).first(); }
read(...runtimeIterable);
`);
assert.equal(unknownSpread.queries[0].bindingArity, null);
assert.equal(unknownSpread.queries[0].bindingProvenance, "dynamic-bind-arguments");

const spreadBeforeRest = extractSourceText(`
const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: () => values }) }) };
function read(head: unknown, ...values: unknown[]): void {
  db.prepare("SELECT 1 FROM spread_before_rest").bind(...values).first();
}
read(...[1, 2]);
`);
assert.equal(spreadBeforeRest.queries[0].bindingArity, null);
assert.equal(spreadBeforeRest.queries[0].bindingProvenance, "dynamic-bind-arguments");

process.stdout.write("D1 binding cardinality fixtures passed\n");
