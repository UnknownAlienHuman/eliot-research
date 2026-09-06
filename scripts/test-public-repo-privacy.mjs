// Public-repo privacy regression scan (tracked + untracked tree).
// Fails (non-zero exit) on any hit. Prints file:line + redacted label only.
// Never prints matched values.
//
// Forbidden exact values are loaded at runtime from ignored local state
// (.eliotr-state/cloudflare/operator-profile.json) or explicit env vars and
// are never embedded here. When no local binding exists the scan still
// enforces generic patterns (fail-open-safe).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const LOCAL_PROFILE_CANDIDATES = [
  ".eliotr-state/cloudflare/operator-profile.json",
  process.env.ELIOTR_OPERATOR_PROFILE_PATH ?? "",
].filter(Boolean);

const GENERIC_ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_NAME",
  "ELIOTR_OPERATOR_EMAIL",
  "ELIOTR_OWNER_EMAILS",
  "ELIOTR_ACCESS_HOSTNAME",
  "ELIOTR_ACCESS_TEAM_DOMAIN",
  "ELIOTR_WORKERS_DEV_SUBDOMAIN",
  "ELIOTR_WORKER_NAME",
];

// Generic (non-personal) values that must never be treated as forbidden.
const GENERIC_ALLOWLIST = new Set([
  "default",
  "browser-oauth",
  "workers-dev-only",
  "free-tier",
  "eliotr-core",
  "0",
  "operator@example.com",
  "owner@example.com",
]);

// Lines carrying this marker are synthetic token fixtures for negative tests.
// They are skipped for credential-material patterns only (identity patterns
// still apply).
const FIXTURE_MARKER = "privacy-allowlist: synthetic token fixture";

// Placeholders that keep workers.dev / access-origin lines account-neutral.
const NEUTRAL_HOST_MARKERS = ["example", "replace-me", "invalid"];

function isNeutralHostLine(line) {
  const lower = line.toLowerCase();
  return NEUTRAL_HOST_MARKERS.some((m) => lower.includes(m));
}

// 32-hex with every char identical (e.g. all zeros) is a fictional placeholder.
function isFictionalHexId(value) {
  return /^([0-9a-f])\1{31}$/i.test(value);
}

// Patterns built via concatenation so this file holds no scannable literal.
const AT = "@";
const GMAIL_DOMAIN = ["gmail", ".", "com"].join("");
const gmailPattern = () => new RegExp(`[A-Za-z0-9._%+-]+${AT}gmail\\.${"com"}`, "i");
const hexIdPattern = () => /\b[0-9a-f]{32}\b/i;
const workersDevPattern = () => new RegExp(`[A-Za-z0-9-]+\\.[A-Za-z0-9-]+\\.${"workers"}\\.${"dev"}`, "i");
const accessOriginPattern = () =>
  new RegExp(`https:\\/\\/[A-Za-z0-9-]+\\.${"cloudflareaccess"}\\.${"com"}`, "i");
const jwtPattern = () => new RegExp(`${"eyJ"}[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`);
const privateKeyPattern = () => new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`);
const bearerPattern = () => new RegExp(`\\bBearer\\s+[A-Za-z0-9._~+/-]{20,}={0,2}\\b`, "i");

async function listTrackedFiles() {
  try {
    const out = execSync("git ls-files --cached --others --exclude-standard", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return await walkFallback(ROOT);
  }
}

async function walkFallback(dir, base = "") {
  const entries = await readdir(join(dir, base));
  const files = [];
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules" || entry === ".wrangler" || entry === ".eliotr-state") continue;
    const rel = base ? `${base}/${entry}` : entry;
    const st = await stat(join(dir, rel));
    if (st.isDirectory()) files.push(...(await walkFallback(dir, rel)));
    else files.push(rel);
  }
  return files;
}

async function loadForbiddenExact() {
  const forbidden = new Map(); // value -> redacted label
  const addValue = (value, label) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length < 4 || GENERIC_ALLOWLIST.has(trimmed)) return;
    if (!forbidden.has(trimmed)) forbidden.set(trimmed, label);
  };
  for (const candidate of LOCAL_PROFILE_CANDIDATES) {
    try {
      const raw = await readFile(resolve(ROOT, candidate), "utf8");
      const parsed = JSON.parse(raw);
      addValue(parsed?.account?.id, "forbidden-local-binding:accountId");
      addValue(parsed?.account?.name, "forbidden-local-binding:accountName");
      addValue(parsed?.operator?.email, "forbidden-local-binding:operatorEmail");
      addValue(parsed?.workers_dev?.subdomain, "forbidden-local-binding:subdomain");
      addValue(parsed?.workers_dev?.hostname, "forbidden-local-binding:hostname");
      addValue(parsed?.zero_trust?.team_origin, "forbidden-local-binding:teamOrigin");
      if (Array.isArray(parsed?.zero_trust?.owner_emails)) {
        parsed.zero_trust.owner_emails.forEach((email, i) => addValue(email, `forbidden-local-binding:ownerEmail[${i}]`));
      }
    } catch {
      // Missing/unreadable local state: generic patterns still apply.
    }
  }
  for (const key of GENERIC_ENV_KEYS) {
    const value = process.env[key];
    if (!value) continue;
    for (const part of String(value).split(",")) addValue(part, `forbidden-env:${key}`);
  }
  void GMAIL_DOMAIN;
  return forbidden;
}

// Canonical JSON test vectors that happen to contain 32-hex substrings.
// These are hex encodings of JSON numbers (safe-integer boundaries), not
// account bindings. Narrow: exact tracked file + SHA256(full line) + reason.
// Only suppresses generic-pattern:account-id-hex on those exact lines; all
// other patterns still apply.
const HEX_VECTOR_ALLOWLIST = new Set([
  // json_max_safe_integer vector in canonical-body fixture (not a binding).
  "crates/eliotr-test-vectors/fixtures/canonical-body.v1.txt:dc4b0022dd8c7e29cfb78066bcab3036a2bb1419b76c7db8f4b2482bbba4a1a8",
  // json_integer_overflow vector in canonical-body fixture (not a binding).
  "crates/eliotr-test-vectors/fixtures/canonical-body.v1.txt:3196500e78fbe6d53e7c34e02f76fc2e7c378d0deaee9c6dcefa9ed46572be00",
  // Same max-safe-integer vector in the fuzz seed corpus (not a binding).
  "fuzz/corpus/m1_kernel/canonical-body-frame.txt:dc4b0022dd8c7e29cfb78066bcab3036a2bb1419b76c7db8f4b2482bbba4a1a8",
]);

function isAllowlistedHexVector(rel, line) {
  const key = `${rel}:${createHash("sha256").update(line).digest("hex")}`;
  return HEX_VECTOR_ALLOWLIST.has(key);
}

function scanLine(line, forbidden, rel = "") {
  const hits = [];
  for (const [value, label] of forbidden) {
    if (value && line.includes(value)) hits.push(label);
  }
  if (gmailPattern().test(line)) hits.push("generic-pattern:personal-email-provider");
  const hexMatch = line.match(new RegExp(`\\b[0-9a-f]{32}\\b`, "i"));
  void hexIdPattern;
  if (hexMatch && !isFictionalHexId(hexMatch[0]) && !isAllowlistedHexVector(rel, line)) hits.push("generic-pattern:account-id-hex");
  if (workersDevPattern().test(line) && !isNeutralHostLine(line)) {
    hits.push("generic-pattern:workers-dev-hostname");
  }
  if (accessOriginPattern().test(line) && !isNeutralHostLine(line)) {
    hits.push("generic-pattern:access-team-origin");
  }
  if (!line.includes(FIXTURE_MARKER)) {
    if (jwtPattern().test(line)) hits.push("generic-pattern:token-material-jwt");
    if (privateKeyPattern().test(line)) hits.push("generic-pattern:token-material-private-key");
    if (bearerPattern().test(line)) hits.push("generic-pattern:token-material-bearer");
  }
  return hits;
}

const files = await listTrackedFiles();
const forbidden = await loadForbiddenExact();
let hitCount = 0;
let filesWithHits = 0;

for (const rel of files) {
  let content;
  try {
    content = await readFile(resolve(ROOT, rel), "utf8");
  } catch {
    continue; // binary/unreadable: skip
  }
  const lines = content.split("\n");
  let fileHit = false;
  lines.forEach((line, index) => {
    const hits = scanLine(line, forbidden, rel);
    for (const label of hits) {
      // Redacted: file:line + label only, never the value.
      console.error(`${rel}:${index + 1}: ${label}`);
      hitCount += 1;
      fileHit = true;
    }
  });
  if (fileHit) filesWithHits += 1;
}

console.log(`Privacy scan: ${hitCount} hit(s) in ${filesWithHits} file(s) across ${files.length} file(s).`);
if (hitCount > 0) {
  console.error("Public-repo privacy scan: FAIL");
  process.exit(1);
}
console.log("Public-repo privacy scan: PASS");
