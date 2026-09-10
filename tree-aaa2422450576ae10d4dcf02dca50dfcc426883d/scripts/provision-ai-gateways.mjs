import { readFile } from "node:fs/promises";

async function flushStandardStreams() {
  // Console writes to a piped parent complete asynchronously. Awaiting an
  // empty write on each standard stream guarantees every preceding payload is
  // flushed before the event loop drains. Calling process.exit() here instead
  // would truncate pending writes and tear down pooled fetch sockets mid-close
  // (Windows libuv UV_HANDLE_CLOSING assertion, exit 3221226505).
  for (const stream of [process.stdout, process.stderr]) {
    await new Promise((resolve) => stream.write("", resolve));
  }
}

async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const apiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
  const checkOnly = process.argv.includes("--check-only");
  if (!accountId || !token) {
    console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
    return 2;
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
  return 0;
}

process.exitCode = await main();
await flushStandardStreams();
