import assert from "node:assert/strict";
import { extractSourceText } from "./extract-application-sql.mjs";

const fixture = extractSourceText(`
const shared = "SELECT * FROM source";
function registered(kind: string): string {
  if (kind === "source") return shared + " WHERE state='READY'";
  return "SELECT * FROM project";
}
const byState = (state: string) => \`SELECT * FROM source WHERE state='\u0024{state}'\`;
const db = { prepare: (sql: string) => sql };
db.prepare(registered("source"));
db.prepare(registered("project"));
db.prepare(byState("READY"));
db.prepare(
  \`SELECT * FROM source WHERE source_id=\u0024{sourceId}\`,
);
`);

assert.deepEqual(fixture.queries.map((query) => query.sql), [
  "SELECT * FROM source WHERE state='READY'",
  "SELECT * FROM project",
  "SELECT * FROM source WHERE state='READY'",
]);
assert.equal(fixture.unresolved.length, 1);
assert.equal(fixture.unresolved[0].reason, "dynamic-or-unresolved");

const changed = extractSourceText(`
const db = { prepare: (sql: string) => sql };
db.prepare(\`SELECT * FROM \u0024{runtimeTable}\`);
`);
assert.equal(changed.queries.length, 0);
assert.equal(changed.unresolved.length, 1);

process.stdout.write("D1_APP_SQL extractor fixtures PASS\n");
