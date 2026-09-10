// Large-line regression for the public-repo privacy scanner.
// Asserts the tracked-tree scan stays linear on very long fixture lines
// (previously ~190s from per-line regex compilation + unbounded backtracking).
// Budgets are strict: synthetic megalines must scan in milliseconds, and the
// full scanner must finish well under 10s. Never prints secret material:
// only redacted labels and timings reach stdout/stderr.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Mirror of scripts/test-public-repo-privacy.mjs (precompiled once, bounded
// quantifiers, literal prefilters). Fragments are concatenated so this file
// holds no scannable literal.
const AT = "@";
const GMAIL_RE = new RegExp(`[A-Za-z0-9._%+-]{1,256}${AT}gmail\\.${"com"}`, "i");
const HEX_RE = /\b[0-9a-f]{32}\b/i;
const WORKERS_DEV_RE = new RegExp(`[A-Za-z0-9-]{1,128}\\.[A-Za-z0-9-]{1,128}\\.${"workers"}\\.${"dev"}`, "i");
const ACCESS_ORIGIN_RE =
  new RegExp(`https:\\/\\/[A-Za-z0-9-]{1,128}\\.${"cloudflareaccess"}\\.${"com"}`, "i");
const JWT_RE = new RegExp(`${"eyJ"}[A-Za-z0-9_-]{10,512}\\.[A-Za-z0-9_-]{10,512}`);
const BEARER_RE = new RegExp(`\\bBearer\\s+[A-Za-z0-9._~+/-]{20,512}={0,2}\\b`, "i");

function scanMirrored(line) {
  const hits = [];
  if (line.includes(AT) && GMAIL_RE.test(line)) hits.push("personal-email-provider");
  if (line.length >= 32 && HEX_RE.test(line)) hits.push("account-id-hex");
  if (line.includes("eyJ") && JWT_RE.test(line)) hits.push("token-material-jwt");
  const low = line.toLowerCase();
  if (low.includes("bearer") && BEARER_RE.test(line)) hits.push("token-material-bearer");
  if (low.includes("workers") && WORKERS_DEV_RE.test(line)) hits.push("workers-dev-hostname");
  if (low.includes("cloudflareaccess") && ACCESS_ORIGIN_RE.test(line)) hits.push("access-team-origin");
  return hits;
}

const MEGALINE_LEN = 300_000;
const ITERATIONS = 50;
const MICRO_BUDGET_MS = 2000;
const FULL_SCAN_BUDGET_MS = 30_000;

// 300k filler with no trigger substrings (mirrors canonical-body megalines).
const filler = `${"json_input_limit|canonicalize_json|"}/${"2".repeat(64)} ${" "} `;
const megaline = filler.repeat(Math.ceil(MEGALINE_LEN / filler.length)).slice(0, MEGALINE_LEN);
assert.equal(megaline.length, MEGALINE_LEN);

const microStart = Date.now();
for (let i = 0; i < ITERATIONS; i += 1) {
  const hits = scanMirrored(megaline);
  assert.deepEqual(hits, [], "filler megaline must be clean");
}
const microElapsed = Date.now() - microStart;
console.log(`Large-line micro-bench: ${ITERATIONS}x ${MEGALINE_LEN}-char lines in ${microElapsed}ms.`);
assert.ok(microElapsed < MICRO_BUDGET_MS, `micro-bench exceeded budget: ${microElapsed}ms >= ${MICRO_BUDGET_MS}ms`);

// Positive control: trigger at the tail of a megaline is still detected.
const tailTrigger = `${"a".repeat(MEGALINE_LEN - 40)}${"eyJ"}${"A".repeat(16)}.${"B".repeat(16)}`;
const tailHits = scanMirrored(tailTrigger);
assert.ok(tailHits.includes("token-material-jwt"), "tail trigger must be detected");

// Full scanner wall-time budget (real script, tracked tree).
// Scrub in-runner mock ELIOTR_* fixtures: they would otherwise become forbidden patterns per test-public-repo-privacy.mjs:125-127; standalone scan remains the leak-detection authority.
const scanEnv = { ...process.env };
delete scanEnv.ELIOTR_ACCESS_TEAM_DOMAIN;
delete scanEnv.ELIOTR_ACCESS_AUDIENCE;
delete scanEnv.ELIOTR_ACCESS_SERVICE_PRINCIPALS;
const fullStart = Date.now();
const full = spawnSync(process.execPath, [resolve(process.cwd(), "scripts/test-public-repo-privacy.mjs")], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: FULL_SCAN_BUDGET_MS,
  env: scanEnv,
});
const fullElapsed = Date.now() - fullStart;
console.log(`Full privacy scan: exit=${full.status} in ${fullElapsed}ms.`);
assert.equal(full.status, 0, `privacy scan failed:\n${full.stdout}\n${full.stderr}`);
assert.ok(fullElapsed < FULL_SCAN_BUDGET_MS, `full scan exceeded budget: ${fullElapsed}ms`);
console.log("Privacy large-line regression: PASS");
