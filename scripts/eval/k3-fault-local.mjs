// K3 fault drill (local only): stuck-slot release via the wired create-catch.
// RUN ONLY on explicit root runtime-ready signal, from the repo root:
//   ELIOT_FAULT_RUN=1 node scripts/eval/k3-fault-local.mjs
// Uses actual K1 API + wrangler D1 CLI + one devCron trigger. No Workflow
// instances are created, no model/save POSTs, no settings writes, no deletes.
// Fixtures: own test project + two unique native text sources (auto stays 0).
// Single output file: eval/out/k3/fault-dispatch.json
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
if (process.env.ELIOT_FAULT_RUN !== "1") {
  console.log("REFUSING: set ELIOT_FAULT_RUN=1 only on explicit root runtime-ready signal.");
  process.exit(2);
}
if (!existsSync("wrangler.jsonc")) {
  console.log("REFUSING: run from the repository root (wrangler.jsonc not found).");
  process.exit(2);
}
const ORIGIN = process.env.ELIOT_URL || "http://127.0.0.1:5175";
const CONFIG = process.env.ELIOT_FAULT_CONFIG || "eval/out/k3-final-20261026/wrangler.json";
const PERSIST = process.env.ELIOT_FAULT_PERSIST || ".wrangler/k3-final-20261026";
const CRON_PATH = process.env.ELIOT_CRON_PATH || "/cdn-cgi/local/scheduled";
const FLASH_ROUTE = "workers-ai:@cf/zai-org/glm-5.3-flash";
const SLOT_COST = 322766;
const EXPECT_USED = 79537;
const EXPECT_CALLS_SUM = 22;
const H = { Origin: ORIGIN };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  H["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H["cf-access-jwt-assertion"] = String(process.env.ELIOT_OWNER_JWT).trim();
const record = { origin: ORIGIN, config: CONFIG, persist: PERSIST, cronPath: CRON_PATH, steps: [], ok: false };
function note(step, detail) { record.steps.push({ step, detail }); console.log("# " + step + (detail === undefined ? "" : " " + JSON.stringify(detail))); }
async function apiJson(path, init) {
  const r = await fetch(ORIGIN + path, { ...init, headers: { Accept: "application/json", ...H, ...((init && init.headers) || {}) } });
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = { raw: String(t).slice(0, 300) }; }
  return { status: r.status, body: b };
}
function wrangler(sql) {
  const out = execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", CONFIG, "--persist-to", PERSIST, "--command", sql, "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}
function rowsOf(res) { return (res && res.results) || []; }
function firstValue(row) { return row ? Object.values(row)[0] : undefined; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fail(reason) { record.ok = false; record.failure = reason; mkdirSync("eval/out/k3", { recursive: true }); writeFileSync("eval/out/k3/fault-dispatch.json", JSON.stringify(record, null, 2)); console.log("FAULT-DRILL FAIL: " + reason); process.exit(1); }
process.addListener("unhandledRejection", (e) => { try { fail("Unhandled: " + String((e && e.message) || e).slice(0, 300)); } catch { process.exit(1); } });
process.addListener("uncaughtException", (e) => { try { fail("Unhandled: " + String((e && e.message) || e).slice(0, 300)); } catch { process.exit(1); } });
function cleanId(id) { if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error("Refusing to interpolate non-UUID into D1 SQL: " + id); return id; }
const stamp = Date.now();
const m0 = await apiJson("/api/settings");
if (m0.status !== 200) fail("GET /api/settings unreachable: " + m0.status);
note("monthly-pre", { used: m0.body.monthlyUsedMicrousd, budget: m0.body.monthlyBudgetMicrousd, auto: m0.body.settings && m0.body.settings.autoDistill });
if (m0.body.monthlyUsedMicrousd !== EXPECT_USED) fail("Pre monthly used is not the controlled 79537: " + m0.body.monthlyUsedMicrousd);
if ((m0.body.settings && m0.body.settings.autoDistill) !== false && (m0.body.settings && m0.body.settings.autoDistill) !== 0) fail("Pre autoDistill is not 0; refusing (no settings writes allowed).");
const held0 = firstValue(rowsOf(wrangler("SELECT COUNT(*) AS n FROM source_revision WHERE distill_state IN ('queued','running')"))[0]);
const sum0 = firstValue(rowsOf(wrangler("SELECT COALESCE(SUM(distill_calls),0) AS c FROM source_revision"))[0]);
note("d1-pre", { queuedOrRunning: held0, callsSum: sum0 });
if (held0 !== 0) fail("Global queued/running is not 0 before inject: " + held0);
if (sum0 !== EXPECT_CALLS_SUM) fail("Global distill_calls sum is not the controlled 22: " + sum0);
const pj = await apiJson("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "k3-fault-local-" + stamp }) });
if (pj.status !== 201 || !pj.body || !pj.body.project || !pj.body.project.id) fail("POST project failed: " + pj.status);
const projectId = pj.body.project.id;
note("project", { id: projectId });
const texts = [["fault-a-" + stamp, "River stones settle where the current slows."], ["fault-b-" + stamp, "Lantern light keeps the stairwell legible."]];
for (const [t, prose] of texts) {
  const s = await apiJson("/api/projects/" + encodeURIComponent(projectId) + "/sources/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: t, text: "# " + t + "\n\nLocal native text fixture. " + prose + " Run " + stamp + "." }) });
  if (s.status !== 202 && s.status !== 201) fail("POST text source " + t + " failed: " + s.status);
}
let fixtures = [];
for (let i = 0; i < 24; i++) {
  const l = await apiJson("/api/projects/" + encodeURIComponent(projectId) + "/sources");
  if (l.status !== 200) fail("GET project sources failed: " + l.status);
  const mine = (l.body.sources || []).filter((s) => s && (s.originalFilename || "").indexOf(String(stamp)) >= 0);
  if (mine.length === 2 && mine.every((s) => s.id && s.currentRevisionId && (s.readableState === "readable" || s.readableState === "readable_with_warnings"))) { fixtures = mine.map((s) => ({ src: s.id, rev: s.currentRevisionId })); break; }
  await sleep(5000);
}
if (fixtures.length !== 2) fail("Both text fixtures did not become readable.");
const revIds = fixtures.map((f) => f.rev);
note("fixtures-readable", { revIds: revIds.map((r) => String(r).slice(0, 8)) });
const startedAt = Date.now() - 20 * 60 * 1000;
wrangler("UPDATE source_revision SET distill_state='running',distill_error=NULL,distill_calls=0,distill_estimated_cost_microusd=" + SLOT_COST + ",distill_model='workers-ai:@cf/zai-org/glm-5.3-flash',distill_started_at=" + startedAt + " WHERE id IN ('" + cleanId(revIds[0]) + "','" + cleanId(revIds[1]) + "')");
const injRows = rowsOf(wrangler("SELECT distill_state AS state,distill_calls AS calls,distill_estimated_cost_microusd AS cost,distill_model AS model,distill_started_at AS started FROM source_revision WHERE id IN ('" + cleanId(revIds[0]) + "','" + cleanId(revIds[1]) + "')"));
if (injRows.length !== 2 || !injRows.every((row) => row.state === "running" && row.calls === 0 && row.cost === SLOT_COST && row.model === FLASH_ROUTE && row.started === startedAt)) fail("Inject did not hold exactly 2 slots: " + JSON.stringify(injRows).slice(0, 400));
const held = firstValue(rowsOf(wrangler("SELECT COUNT(*) AS n FROM source_revision WHERE distill_state='running'"))[0]);
note("slots-held", { running: held });
if (held !== 2) fail("Expected exactly 2 held running slots, got " + held);
let cronStatus = 0;
try {
  const cr = await fetch(ORIGIN + CRON_PATH, { method: "POST", headers: { ...H } });
  cronStatus = cr.status;
  await cr.text();
} catch (e) { cronStatus = -1; }
note("cron-trigger", { status: cronStatus });
let released = false;
for (let i = 0; i < 24; i++) {
  const c = firstValue(rowsOf(wrangler("SELECT COUNT(*) AS n FROM source_revision WHERE distill_state IN ('queued','running')"))[0]);
  if (c === 0) { released = true; break; }
  await sleep(5000);
}
if (!released) fail("Held slots did not release to 0 after one cron trigger.");
const fin = rowsOf(wrangler("SELECT id,distill_state AS state,distill_error AS error,distill_calls AS calls,distill_input_tokens AS it,distill_cached_tokens AS ct,distill_output_tokens AS ot,distill_estimated_cost_microusd AS cost,distill_ms AS ms FROM source_revision WHERE id IN ('" + cleanId(revIds[0]) + "','" + cleanId(revIds[1]) + "')"));
for (const row of fin) {
  if (row.state !== "failed") fail("Fixture not failed: " + JSON.stringify(row));
  if (!row.error) fail("Fixture missing visible error: " + row.id);
  if (row.calls !== 0 || row.it !== 0 || row.ct !== 0 || row.ot !== 0 || row.cost !== 0) fail("Fixture usage not zeroed: " + JSON.stringify(row));
  if (typeof row.ms !== "number") fail("Fixture ms missing: " + row.id);
}
for (const f of fixtures) {
  const u = await apiJson("/api/sources/" + encodeURIComponent(f.src) + "/understanding?revisionId=" + encodeURIComponent(f.rev));
  if (u.status !== 200 || !u.body || u.body.state !== "failed" || typeof u.body.error !== "string") fail("Failed state not API-visible for " + String(f.rev).slice(0, 8));
}
const sum1 = firstValue(rowsOf(wrangler("SELECT COALESCE(SUM(distill_calls),0) AS c FROM source_revision"))[0]);
const m1 = await apiJson("/api/settings");
note("d1-post", { callsSum: sum1, monthlyUsed: m1.body && m1.body.monthlyUsedMicrousd });
if (sum1 !== sum0) fail("Global distill_calls sum moved: " + sum0 + " -> " + sum1);
if (!m1.body || m1.body.monthlyUsedMicrousd !== EXPECT_USED) fail("Monthly used not restored to 79537: " + (m1.body && m1.body.monthlyUsedMicrousd));
record.ok = true;
record.result = { projectId, revIds, callsSum: sum1, monthlyUsed: m1.body.monthlyUsedMicrousd };
mkdirSync("eval/out/k3", { recursive: true });
writeFileSync("eval/out/k3/fault-dispatch.json", JSON.stringify(record, null, 2));
console.log("FAULT-DRILL PASS");
