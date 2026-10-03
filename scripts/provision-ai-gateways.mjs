import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_INSTRUCTION, loadWranglerOAuthCredential, resolveAuthMode,
  scrubTokenEnv, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE } from "./lib/cloudflare-wrangler-oauth.mjs";
import { isUsageAdmissionCapability, runUsagePreflight } from "./lib/cloudflare-usage-admission.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Isolated state root for tests: ELIOTR_STATE_DIRECTORY overrides the shared
// gitignored .eliotr-state so parallel/serial runs never communicate through
// leftover receipts. Production default is unchanged.
const stateDirectory = process.env.ELIOTR_STATE_DIRECTORY ? resolve(process.env.ELIOTR_STATE_DIRECTORY) : resolve(repositoryRoot, ".eliotr-state");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
let token = process.env.CLOUDFLARE_API_TOKEN;
const apiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
const checkOnly = process.argv.includes("--check-only");
const verifyExisting = process.argv.includes("--verify-existing");
const showHelp = process.argv.includes("--help") || process.argv.includes("-h");
if (checkOnly && verifyExisting) {
  console.error("--check-only and --verify-existing cannot be used together");
  process.exit(2);
}
if (showHelp) {
  console.log("Usage: scripts/provision-ai-gateways.mjs [--check-only | --verify-existing] [--help]\nProvisions AI Gateway configuration from infra/cloudflare/ai-gateways.json. --check-only prints the plan with zero mutations. --verify-existing performs GET-only exact readback and fails if any gateway is missing.");
  process.exitCode = 0;
}
if (!showHelp) {
let authMode = "api-token";
try {
  authMode = resolveAuthMode(process.env);
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(2);
}
if (authMode === WRANGLER_OAUTH_MODE) {
  // Direct-invocation OAuth path: bearer stays in process memory only.
  if (!accountId) {
    console.error(`CLOUDFLARE_ACCOUNT_ID is required. ${LOGIN_INSTRUCTION}`);
    process.exit(2);
  }
  try {
    const credential = await loadWranglerOAuthCredential({ env: process.env, now: Date.now() });
    token = credential.bearer;
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
  try {
    // Official-profile account pin before the first Cloudflare GET. Always
    // spawns the official `wrangler whoami` with a token-scrubbed env. No
    // ambient test seam is honored here.
    const scrubbed = scrubTokenEnv(process.env);
    const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"],
      { cwd: repositoryRoot, env: scrubbed, encoding: "utf8", shell: process.platform === "win32" });
    if (result.error || result.status !== 0) {
      console.error(`Wrangler verification (wrangler whoami exit ${result.status ?? "unknown"}) failed. ${LOGIN_INSTRUCTION}`);
      process.exit(2);
    }
    await verifyWranglerOAuthAccount({ expectedAccountId: accountId, getWhoamiOutput: async () => result.stdout ?? "" });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
} else if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(2);
}

// Default apply retains the fresh live-usage admission fence. Check-only and
// verify-existing are read-only inspection paths and skip usage collection;
// verify-existing guards every Cloudflare request as GET-only.
if (!checkOnly && !verifyExisting) {
  let usageGate;
  try {
    usageGate = await runUsagePreflight({ env: process.env, nowMs: Date.now(), writeReceipt: true,
      receiptPath: resolve(stateDirectory, "cloudflare-usage-admission-receipt.json"), cwd: repositoryRoot });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
  const admittedWithCapability = usageGate.decision === "ADMITTED" && isUsageAdmissionCapability(usageGate.capability);
  if (usageGate.decision === "BLOCKED" || (!checkOnly && !admittedWithCapability)) {
    console.error(`Cloudflare usage preflight ${usageGate.decision} denies AI Gateway provisioning before any mutation. ${usageGate.evaluation.reasons.join("; ")}${usageGate.decision === "ADMITTED" ? " Missing same-process admission capability: ADMITTED alone never authorizes mutations." : ""}`);
    process.exit(2);
  }
}
const desired = JSON.parse(await readFile(new URL("../infra/cloudflare/ai-gateways.json", import.meta.url), "utf8"));
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

async function request(method, path, body, allow404 = false) {
  if (verifyExisting && method !== "GET") {
    throw new Error(`--verify-existing permits GET requests only; refused ${method} ${path}`);
  }
  const response = await fetch(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (allow404 && response.status === 404) return null;
  if (!response.ok || payload.success === false) throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
  return payload.result ?? payload;
}

const keys = ["id", "cache_invalidate_on_update", "cache_ttl", "collect_logs", "rate_limiting_interval", "rate_limiting_limit", "authentication"];
const receipts = [];
for (const spec of desired.gateways) {
  const path = `/accounts/${enc(accountId)}/ai-gateway/gateways/${enc(spec.id)}`;
  let existing = await request("GET", path, undefined, true);
  if (existing === null) {
    if (verifyExisting) {
      throw new Error(`--verify-existing found missing resource: AI Gateway ${spec.id}`);
    }
    if (checkOnly) {
      receipts.push({ id: spec.id, disposition: "CREATE" });
      continue;
    }
    existing = await request("POST", `/accounts/${enc(accountId)}/ai-gateway/gateways`, spec);
    console.log(`created AI Gateway ${spec.id}`);
    receipts.push({ id: spec.id, disposition: "CREATED" });
    continue;
  }
  const drift = keys.flatMap((key) => Object.is(existing[key], spec[key]) ? [] : [{ field: key, expected: spec[key], actual: existing[key] }]);
  if (drift.length > 0) {
    throw new Error(`AI Gateway ${spec.id} configuration drift. Review before an explicit update: ${JSON.stringify(drift, null, 2)}`);
  }
  console.log(`verified AI Gateway ${spec.id}`);
  receipts.push({ id: spec.id, disposition: "VERIFIED" });
}
console.log(JSON.stringify({
  protocol: checkOnly ? "eliotr.ai-gateways-plan.v1" : desired.protocol,
  mode: checkOnly ? "CHECK_ONLY_NO_MUTATION" : "APPLIED",
  gateways: receipts,
}, null, 2));
}
