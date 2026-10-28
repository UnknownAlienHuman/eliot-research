// K6 replacement acceptance: source replacement stales only dependent pages; old revisions stay readable.
// Run only on explicit root ready signal against a disposable copied local origin:
//   ELIOT_K6_REPLACEMENT=1 ELIOT_K6_REPLACEMENT_URL=http://127.0.0.1:PORT
//   ELIOT_K6_REPLACEMENT_PROJECT=<projectId> ELIOT_K6_REPLACEMENT_SOURCE=<sourceId>
//   ELIOT_K6_REPLACEMENT_FILE=<absolute path to canonical Markdown>
//   ELIOT_K6_REPLACEMENT_D1=<absolute path to copied SQLite store>
//   ELIOT_K6_EXPECTED_AFFECTED='["<pageId>",...]' ELIOT_K6_EXPECTED_UNAFFECTED='["<pageId>",...]'
//   node scripts/eval/k6-replacement.mjs
// No setup/cloning in script: manager creates the separate copied D1/R2 namespace
// (remote AI/crons off, autoDistill 0) and wires run.ts --replacement. No model calls,
// no distill POSTs, no credentials changes, no synthetic science/corpus writes.
// Each attempt is retained at eval/out/k6/replacement-<timestamp>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eval", "out", "k6");
const OUT_FILE = join(OUT_DIR, "replacement-" + Date.now() + ".json");
const record = { ok: false, origin: null, projectId: null, phase: "init", checks: [], warnings: [] };
function note(check, detail) { record.checks.push(detail === undefined ? { check } : { check, detail }); console.log("# " + check + (detail === undefined ? "" : " " + JSON.stringify(detail))); }
function warn(message) { record.warnings.push(message); console.log("# warn: " + message); }
function fail(reason) {
  record.ok = false;
  record.failure = reason;
  try { mkdirSync(OUT_DIR, { recursive: true }); } catch { /* best effort */ }
  try { writeFileSync(OUT_FILE, JSON.stringify(record, null, 2) + "\n"); } catch { /* best effort */ }
  console.log("K6-REPLACEMENT FAIL: " + reason);
  process.exit(1);
}
process.addListener("unhandledRejection", (e) => { try { fail("Unhandled: " + String((e && e.message) || e).slice(0, 300)); } catch { process.exit(1); } });
process.addListener("uncaughtException", (e) => { try { fail("Unhandled: " + String((e && e.message) || e).slice(0, 300)); } catch { process.exit(1); } });
if (process.env.ELIOT_K6_REPLACEMENT !== "1") {
  console.log("REFUSING: set ELIOT_K6_REPLACEMENT=1 only on explicit root ready signal against the copied disposable origin.");
  process.exit(2);
}
const ORIGIN = process.env.ELIOT_K6_REPLACEMENT_URL || "";
let originUrl;
try { originUrl = new URL(ORIGIN); } catch { fail("ELIOT_K6_REPLACEMENT_URL must be a valid URL."); }
if (!["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname)) fail("ELIOT_K6_REPLACEMENT_URL must be a loopback-only origin; got " + originUrl.hostname + ".");
record.origin = originUrl.origin;
const PROJECT_ID = process.env.ELIOT_K6_REPLACEMENT_PROJECT || "";
const SOURCE_ID = process.env.ELIOT_K6_REPLACEMENT_SOURCE || "";
const FILE_PATH = process.env.ELIOT_K6_REPLACEMENT_FILE || "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(PROJECT_ID)) fail("ELIOT_K6_REPLACEMENT_PROJECT must be a UUID.");
if (!UUID_RE.test(SOURCE_ID)) fail("ELIOT_K6_REPLACEMENT_SOURCE must be a UUID.");
if (!FILE_PATH) fail("ELIOT_K6_REPLACEMENT_FILE must be an absolute path to a real canonical Markdown file.");
if (!isAbsolute(FILE_PATH)) fail("ELIOT_K6_REPLACEMENT_FILE must be absolute.");
const d1Path = process.env.ELIOT_K6_REPLACEMENT_D1;
if (!d1Path || !isAbsolute(d1Path)) fail("ELIOT_K6_REPLACEMENT_D1 must name the copied local SQLite store.");
function modelCounters() {
  const db = new DatabaseSync(d1Path, { readOnly: true });
  try {
    return {
      sources: db.prepare("SELECT id,distill_calls AS calls FROM source_revision ORDER BY id").all(),
      pages: db.prepare("SELECT id,model_calls AS calls FROM page_revision ORDER BY id").all(),
    };
  } finally { db.close(); }
}
let replacementBytes;
try { replacementBytes = readFileSync(FILE_PATH); } catch (e) { fail("Cannot read ELIOT_K6_REPLACEMENT_FILE: " + String((e && e.message) || e).slice(0, 200)); }
if (replacementBytes.length === 0) fail("Replacement file is empty.");
if (replacementBytes.length > 25 * 1024 * 1024) fail("Replacement file exceeds the 25 MiB API cap.");
const H = { Origin: originUrl.origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  H["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H["cf-access-jwt-assertion"] = String(process.env.ELIOT_OWNER_JWT).trim();
async function apiJson(path, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const r = await fetch(originUrl.origin + path, { ...init, signal: controller.signal, headers: { Accept: "application/json", ...H, ...((init && init.headers) || {}) } });
    const t = await r.text();
    let b = null;
    try { b = t ? JSON.parse(t) : null; } catch { b = { raw: String(t).slice(0, 300) }; }
    return { status: r.status, body: b };
  } finally { clearTimeout(timer); }
}
async function apiBytes(path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  try {
    const r = await fetch(originUrl.origin + path, { signal: controller.signal, headers: { ...H } });
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
  } finally { clearTimeout(timer); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);
function parseIdList(raw, name) {
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail(name + " is not valid JSON."); }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) fail(name + " must be a JSON array of strings.");
  return parsed;
}
const EXPECTED_AFFECTED = parseIdList(process.env.ELIOT_K6_EXPECTED_AFFECTED, "ELIOT_K6_EXPECTED_AFFECTED");
const EXPECTED_UNAFFECTED = parseIdList(process.env.ELIOT_K6_EXPECTED_UNAFFECTED, "ELIOT_K6_EXPECTED_UNAFFECTED");
const startedAt = Date.now();
async function getJson(path, what, allow404) {
  const r = await apiJson(path);
  if (r.status === 404 && allow404) return null;
  if (r.status !== 200) fail("GET " + path + " returned " + r.status + " (" + what + ").");
  return r.body;
}
async function snapshotState(tag) {
  const settings = await getJson("/api/settings", "settings");
  const proj = await getJson("/api/projects/" + encodeURIComponent(PROJECT_ID), "project");
  const sources = await getJson("/api/projects/" + encodeURIComponent(PROJECT_ID) + "/sources", "project sources");
  const knowledge = await getJson("/api/projects/" + encodeURIComponent(PROJECT_ID) + "/knowledge", "project knowledge");
  const pages = await getJson("/api/projects/" + encodeURIComponent(PROJECT_ID) + "/pages", "project pages");
  return { tag, settings, project: (proj && proj.project !== undefined) ? proj.project : proj, sources: (sources && sources.sources !== undefined) ? sources.sources : sources, knowledge, pages: (pages && pages.pages !== undefined) ? pages.pages : pages };
}
function sourceById(sources, id) {
  return (Array.isArray(sources) ? sources : []).find((s) => s && s.id === id) || null;
}
const pre = await snapshotState("before");
if (pre.settings.settings?.autoDistill !== 0) fail("Use a copied namespace with autoDistill disabled.");
record.before = pre;
const countersBefore = modelCounters();
record.projectId = PROJECT_ID;
if (pre.project === null || pre.project === undefined || (pre.project.id !== undefined && pre.project.id !== PROJECT_ID)) fail("Project lookup did not return the requested project.");
note("monthly-pre", { used: pre.settings.monthlyUsedMicrousd, budget: pre.settings.monthlyBudgetMicrousd, autoDistill: pre.settings.settings && pre.settings.settings.autoDistill });
const preSettingsJson = JSON.stringify({ a: pre.settings.settings && pre.settings.settings.answerModel, d: pre.settings.settings && pre.settings.settings.distillModel, b: pre.settings.monthlyBudgetMicrousd });
const preKnowledgeJson = JSON.stringify(pre.knowledge);
const preSource = sourceById(pre.sources, SOURCE_ID);
if (!preSource) fail("ELIOT_K6_REPLACEMENT_SOURCE not found in project sources.");
const preRev = preSource.currentRevisionId;
if (!isUuid(preRev)) fail("Source has no current readable revision id to replace.");
note("source-before", { sourceId: SOURCE_ID.slice(0, 8), currentRevisionId: String(preRev).slice(0, 8), readableState: preSource.currentReadableState || preSource.readableState || null, converter: preSource.converter || null, conversionCalls: preSource.conversionCalls !== undefined ? preSource.conversionCalls : preSource.conversion_calls });
const prePageViews = new Map();
for (const p of pre.pages) {
  if (p && typeof p.id === "string") {
    const d = await apiJson("/api/projects/" + encodeURIComponent(PROJECT_ID) + "/pages/" + encodeURIComponent(p.id));
    if (d.status !== 200) fail("GET page " + p.id.slice(0, 8) + " returned " + d.status + " before replacement.");
    prePageViews.set(p.id, d.body.page || d.body);
  }
}
note("pages-before", (Array.isArray(pre.pages) ? pre.pages : []).map((p) => ({ id: p && p.id && String(p.id).slice(0, 8), freshness: p && p.freshness })));
if (!pre.knowledge.page || pre.knowledge.page.freshness !== "current") fail("The copied map must be current before this one replacement.");
const baselineText = await apiBytes("/api/revisions/" + encodeURIComponent(preRev) + "/text");
if (baselineText.status !== 200) fail("Baseline revision text not readable before replacement.");
const preWhole = baselineText.bytes;
record.originalText = { revisionId: preRev, bytes: preWhole.length };
if (!EXPECTED_AFFECTED?.length || !EXPECTED_UNAFFECTED?.length) fail("Supply both affected and unaffected page expectations before uploading.");
if (EXPECTED_AFFECTED.some((id) => !isUuid(id)) || EXPECTED_UNAFFECTED.some((id) => !isUuid(id))
  || JSON.stringify([...EXPECTED_AFFECTED, ...EXPECTED_UNAFFECTED].sort()) !== JSON.stringify([...prePageViews.keys()].sort()))
  fail("Expected page sets must cover the full accepted inventory exactly once.");
record.beforePages = Object.fromEntries(prePageViews);
record.beforeCounters = countersBefore;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(record, null, 2) + "\n");
note("baseline-readable", { bytes: preWhole.length });
const form = new FormData();
form.append("file", new Blob([replacementBytes], { type: "text/markdown" }), "replacement.md");
form.append("sourceId", SOURCE_ID);
const postedAt = Date.now();
const up = await apiJson("/api/projects/" + encodeURIComponent(PROJECT_ID) + "/sources/file", { method: "POST", body: form }, 120000);
if (up.status !== 202 && up.status !== 200) fail("File replacement POST returned " + up.status + ": " + JSON.stringify(up.body).slice(0, 300));
note("replacement-post", { status: up.status, ms: Date.now() - postedAt });
if (up.body && Array.isArray(up.body.warnings) && up.body.warnings.length > 0) note("api-warnings", up.body.warnings.slice(0, 5));
let readableRev = null;
let lastState = "?";
for (let waited = 0; waited < 300000; waited += 5000) {
  const probe = await apiJson("/api/sources/" + encodeURIComponent(SOURCE_ID));
  if (probe.status !== 200) fail("GET source returned " + probe.status + " while polling readable state.");
  const s = probe.body && (probe.body.source || probe.body);
  lastState = (s && (s.currentReadableState || s.readableState)) || "?";
  const rev = s && (s.currentRevisionId || s.revisionId);
  if ((lastState === "readable" || lastState === "readable_with_warnings") && typeof rev === "string" && rev !== preRev) { readableRev = rev; break; }
  if (lastState === "failed") fail("Replacement revision entered failed state; no model inference or retry attempted by this script.");
  await sleep(5000);
}
if (!readableRev) fail("Replacement revision did not become readable within 300s (last state: " + lastState + "). No POST retried.");
note("replacement-readable", { revisionId: String(readableRev).slice(0, 8), waitedMs: Date.now() - postedAt });
const post = await snapshotState("after");
note("monthly-after", { used: post.settings.monthlyUsedMicrousd, budget: post.settings.monthlyBudgetMicrousd });
if (post.settings.monthlyUsedMicrousd !== pre.settings.monthlyUsedMicrousd) fail("Monthly usage moved during a zero-model replacement run: before " + pre.settings.monthlyUsedMicrousd + " after " + post.settings.monthlyUsedMicrousd + ".");
if (post.settings.monthlyBudgetMicrousd !== pre.settings.monthlyBudgetMicrousd) fail("Monthly budget moved during the run.");
const postSettingsJson = JSON.stringify({ a: post.settings.settings && post.settings.settings.answerModel, d: post.settings.settings && post.settings.settings.distillModel, b: post.settings.monthlyBudgetMicrousd });
if (postSettingsJson !== JSON.stringify({ a: pre.settings.settings && pre.settings.settings.answerModel, d: pre.settings.settings && pre.settings.settings.distillModel, b: pre.settings.monthlyBudgetMicrousd })) fail("Default settings changed during the run; refusing to attribute deltas.");
const postSource = sourceById(post.sources, SOURCE_ID);
if (!postSource || postSource.currentRevisionId !== readableRev) fail("Replaced source does not point at the new readable revision.");
const ccRaw = postSource.conversionCalls !== undefined ? postSource.conversionCalls : postSource.conversion_calls;
note("conversion-calls", { value: ccRaw === undefined ? "unknown" : ccRaw });
if (ccRaw !== 0) fail("conversionCalls must be known zero on a native Markdown upload.");
const { page: beforeMap, ...beforeView } = pre.knowledge;
const { page: afterMap, ...afterView } = post.knowledge;
const { freshness: beforeFreshness, ...beforeMapBytes } = beforeMap;
const { freshness: afterFreshness, ...afterMapBytes } = afterMap;
if (beforeFreshness !== "current" || afterFreshness !== "stale" || JSON.stringify(beforeView) !== JSON.stringify(afterView)
  || JSON.stringify(beforeMapBytes) !== JSON.stringify(afterMapBytes)) fail("Replacement must stale the frozen map without regenerating or changing its content.");
note("knowledge-still-frozen", true);
const stalePages = [];
const currentPages = [];
for (const p of (Array.isArray(post.pages) ? post.pages : [])) {
  if (!p || typeof p.id !== "string") continue;
  const d = await apiJson("/api/projects/" + encodeURIComponent(PROJECT_ID) + "/pages/" + encodeURIComponent(p.id));
  if (d.status !== 200) fail("GET page " + p.id.slice(0, 8) + " returned " + d.status + " after replacement.");
  const page = d.body && (d.body.page || d.body);
  const previous = prePageViews.get(p.id);
  if (EXPECTED_UNAFFECTED.includes(p.id) && JSON.stringify(page) !== JSON.stringify(previous)) fail("An unrelated page changed: " + p.id);
  if (page && page.freshness === "stale") stalePages.push(page.id || p.id);
  else currentPages.push(page && page.id ? page.id : p.id);
}
note("stale-pages", stalePages.map((id) => String(id).slice(0, 8)));
note("current-pages", currentPages.map((id) => String(id).slice(0, 8)));
if (EXPECTED_AFFECTED) {
  if (JSON.stringify([...stalePages].sort()) !== JSON.stringify([...EXPECTED_AFFECTED].sort())) fail("Additional or missing stale pages.");
  for (const id of EXPECTED_AFFECTED) if (!stalePages.includes(id)) fail("Expected affected page is not stale: " + String(id).slice(0, 8));
  note("expected-affected-ok", EXPECTED_AFFECTED.length);
}
if (EXPECTED_UNAFFECTED) {
  for (const id of EXPECTED_UNAFFECTED) if (!currentPages.includes(id)) fail("Expected unaffected page is not current: " + String(id).slice(0, 8));
  note("expected-unaffected-ok", EXPECTED_UNAFFECTED.length);
}
async function checkRange(rev, start, end, tag) {
  const r = await apiBytes("/api/revisions/" + encodeURIComponent(rev) + "/range?start=" + start + "&end=" + end);
  if (r.status !== 200) fail(tag + " range did not open: " + r.status + " [" + start + "," + end + ")");
  if (r.bytes.length !== end - start) fail(tag + " range returned wrong byte length");
  return r.bytes;
}
const oldRange = await checkRange(preRev, 0, Math.min(preWhole.length, 64), "old-head-bytes");
if (!oldRange.equals(preWhole.subarray(0, oldRange.length))) fail("Old revision range bytes changed.");
const oldWhole = await apiBytes("/api/revisions/" + encodeURIComponent(preRev) + "/text");
if (oldWhole.status !== 200 || !oldWhole.bytes.equals(preWhole)) fail("Old revision text changed.");
note("old-revision-readable", { bytes: preWhole.length });
const newText = await apiBytes("/api/revisions/" + encodeURIComponent(readableRev) + "/text");
if (newText.status !== 200) fail("New revision text not readable: " + newText.status);
if (!newText.bytes.equals(replacementBytes) || newText.bytes.equals(preWhole)) fail("Replacement canonical bytes differ from the supplied different paper.");
const countersAfter = modelCounters();
if (JSON.stringify(countersAfter.pages) !== JSON.stringify(countersBefore.pages)
  || JSON.stringify(countersAfter.sources.filter((row) => row.id !== readableRev)) !== JSON.stringify(countersBefore.sources)
  || countersAfter.sources.find((row) => row.id === readableRev)?.calls !== 0) fail("A model counter changed during replacement.");
record.counterCheck = { unchangedOriginalRows: true, newRevisionCalls: 0 };
note("new-revision-readable", { bytes: newText.bytes.length, changed: !newText.bytes.equals(preWhole) });
record.ok = true;
record.modelCalls = 0;
record.usageDelta = 0;
try { mkdirSync(OUT_DIR, { recursive: true }); } catch { /* best effort */ }
try { writeFileSync(OUT_FILE, JSON.stringify(record, null, 2) + "\n"); } catch (e) { console.log("K6-REPLACEMENT PASS but could not write artifact: " + String((e && e.message) || e).slice(0, 200)); }
console.log("K6-REPLACEMENT PASS: replacement accepted, staleness scoped, old revision readable, zero model calls.");
process.exit(0);
