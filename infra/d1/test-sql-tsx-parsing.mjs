import assert from "node:assert/strict";
import process from "node:process";
import { extractSourceText } from "./extract-application-sql.mjs";

const source = `
const db = { prepare: (sql: string) => sql };
export function view(sql: string) {
  db.prepare("SELECT 1");
  db.prepare("SELECT " + sql);
  return <section title="db.prepare('SELECT fake')">SELECT prose</section>;
}
`;
const result = extractSourceText(source, "registered-source.tsx");
assert.deepEqual(result.queries.map((query) => query.sql), ["SELECT 1"]);
assert.equal(result.queries[0].targetStore, "unknown", "A parsed JSX source confers no database authority");
assert.equal(result.unresolved.length, 1, "Dynamic SQL remains unresolved in JSX source");
assert.throws(() => extractSourceText(source, "registered-source.ts"), /SOURCE_PARSE_FAILED/u);
assert.throws(() => extractSourceText("export const broken = <section>", "registered-source.tsx"), /SOURCE_PARSE_FAILED/u);
const typed = extractSourceText("const cast = <number>1; db.prepare('SELECT 2');", "registered-source.cts");
assert.deepEqual(typed.queries.map((query) => query.sql), ["SELECT 2"], "CTS retains the TypeScript assertion dialect");
process.stdout.write("D1 SQL filename dialect: TSX static/dynamic SQL, JSX nonauthority, malformed source and CTS assertion PASS.\n");
