import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_INSTRUCTION, loadWranglerOAuthCredential, resolveAuthMode,
  scrubTokenEnv, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE } from "./lib/cloudflare-wrangler-oauth.mjs";
import { runUsagePreflight } from "./lib/cloudflare-usage-collection.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
let token = process.env.CLOUDFLARE_API_TOKEN;
const apiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
const checkOnly = process.argv.includes("--check-only");
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
    // Test-only seam ELIOTR_TEST_WRANGLER_WHOAMI_OUTPUT bypasses the wrangler
    // binary in mocked tests; production always spawns wrangler whoami.
    const mockedWhoami = process.env.ELIOTR_TEST_WRANGLER_WHOAMI_OUTPUT;
    let whoamiOutput;
    if (mockedWhoami !== undefined && mockedWhoami !== "") {
      whoamiOutput = mockedWhoami;
    } else {
      const scrubbed = scrubTokenEnv(process.env);
      const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"],
        { cwd: repositoryRoot, env: scrubbed, encoding: "utf8", shell: process.platform === "win32" });
      if (result.error || result.status !== 0) {
        console.error(`Wrangler verification (wrangler whoami exit ${result.status ?? "unknown"}) failed. ${LOGIN_INSTRUCTION}`);
        process.exit(2);
      }
      whoamiOutput = result.stdout ?? "";
    }
    await verifyWranglerOAuthAccount({ expectedAccountId: accountId, getWhoamiOutput: async () => whoamiOutput });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
} else if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(2);
}

// FIX1-B usage-envelope gate (narrow): usage preflight before the first
// remote mutation. In-process shared runner writes the redacted admission
// receipt. BLOCKED exits in every mode; any other non-ADMITTED decision
// (SEALED) exits in apply mode — SEALED never POSTs gateway creates.
// Check-only inspection stays read-only metadata.
{
  let usageGate;
  try {
    usageGate = await runUsagePreflight({ env: process.env, nowMs: Date.now(), writeReceipt: true,
      receiptPath: resolve(repositoryRoot, ".eliotr-state/cloudflare-usage-admission-receipt.json"), cwd: repositoryRoot });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
  if (usageGate.decision === "BLOCKED" || (!checkOnly && usageGate.decision !== "ADMITTED")) {
    console.error(`Cloudflare usage preflight ${usageGate.decision} denies AI Gateway provisioning before any mutation. ${usageGate.evaluation.reasons.join("; ")}`);
    process.exit(2);
  }
}
const desired = JSON.parse(await readFile(new URL("../infra/cloudflare/ai-gateways.json", import.meta.url), "utf8"));
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

async function request(method, path, body, allow404 = false) {
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
