import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { extractApplicationSql } from "../../infra/d1/extract-application-sql.mjs";

// Compile the real prepared Workflow failure UPDATE against the installed migration
// chains. Positive target evidence is bounded; the query's global target stays unknown.
const root = fileURLToPath(new URL("../..", import.meta.url));
const failureSource = fileURLToPath(new URL("../../packages/cloudflare-workflows/src/failures.ts", import.meta.url));
const workflowApplication = fileURLToPath(new URL(
  "../../packages/cloudflare-research-runtime/src/research-workflow-application.ts", import.meta.url));
const workflowEntry = fileURLToPath(new URL("../../apps/eliotr-core/src/research-workflow.ts", import.meta.url));
const inventory = extractApplicationSql({
  sourceFiles: [failureSource, workflowApplication, workflowEntry],
  includeBoundedTargetEvidence: true,
});
const query = inventory.queries.find((item) =>
  item.location.startsWith("packages/cloudflare-workflows/src/failures.ts:")
    && item.sql.startsWith("UPDATE research_workflow_run SET first_failure_json="));

assert.ok(query, "production run-row UPDATE source must be recovered");
assert.equal(query.receiver, "database");
assert.equal(query.targetStore, "unknown", "a positive caller path is not exhaustive target proof");
assert.equal(query.targetStatus, "unresolved-receiver");
assert.equal(query.bindingArity, 11, "use current production .bind() arity");
assert.equal(query.targetBindingEvidence?.coverage, "positive-paths-only");
assert.equal(query.targetBindingEvidence?.exhaustive, false);
assert.ok(query.targetBindingEvidence?.paths.some((path) =>
  path.targetStore === "core"
    && path.callsites.some((location) => location.startsWith(
      "packages/cloudflare-research-runtime/src/research-workflow-application.ts:"))),
"the positive target path must be derived through Workflow's typed CORE_DB caller");
assert.match(readFileSync(workflowEntry, "utf8"),
  /executeResearchWorkflowApplication\(\{\s*environment:\s*\{\s*CORE_DB:\s*this\.env\.CORE_DB/s,
  "the production Workflow entry must source CORE_DB from its Worker environment");

const compiler = fileURLToPath(new URL("./test-update-of-source-coverage.py", import.meta.url));
const result = spawnSync(process.platform === "win32" ? "python" : "python3", [compiler], {
  cwd: root,
  input: JSON.stringify(query),
  encoding: "utf8",
  shell: false,
  timeout: 30_000,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr);
process.stdout.write(result.stdout);
