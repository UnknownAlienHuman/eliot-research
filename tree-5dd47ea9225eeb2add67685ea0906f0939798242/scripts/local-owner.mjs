import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadOwnerConfig } from "./lib/local-owner-config.mjs";
import { loginOwner, readOwnerIdentity } from "./lib/local-owner-login.mjs";
import { startOwnerBridge } from "./lib/local-owner-bridge.mjs";
import { prepareLocal } from "./lib/local-launch.mjs";
import { startLocalWorker } from "./lib/local-worker.mjs";
import { applyLocalReadPolicy, localPolicyQuery, validatePolicyCommand } from "./lib/local-read-policy.mjs";

export async function runLocalOwner({ policyFile, stopSignal, log = console.log } = {}) {
  // Policy is an explicit local operator command, never a browser-supplied grant.
  let command;
  if (policyFile) {
    if ((await stat(resolve(policyFile))).size > 8192) throw new Error("Policy command exceeds 8192 bytes");
    const text = await readFile(resolve(policyFile), "utf8");
    if (Buffer.byteLength(text) > 8192) throw new Error("Policy command exceeds 8192 bytes");
    let decoded;
    try { decoded = JSON.parse(text); } catch { throw new Error("Policy command is not valid JSON"); }
    command = validatePolicyCommand(decoded);
  }
  const config = await loadOwnerConfig();
  const paths = await prepareLocal();
  let worker; let bridge;
  try {
    log("Opening the official Cloudflare Access login. No Worker or tunnel is deployed.");
    let token = await loginOwner(config, { signal: stopSignal });
    if (stopSignal?.aborted) return;
    worker = await startLocalWorker(paths);
    const identity = await readOwnerIdentity(worker.origin, token, paths.generation);
    if (stopSignal?.aborted) return;
    if (command) {
      const receipt = await applyLocalReadPolicy({ command, identity, query: localPolicyQuery(paths) });
      log(JSON.stringify(receipt, null, 2));
    }
    if (stopSignal?.aborted) return;
    bridge = await startOwnerBridge({ workerOrigin: worker.origin, token, generation: paths.generation });
    token = null;
    log(`Owner: ${identity.principal_ref}\nOpen this one-time local link within 60 seconds:\n${bridge.pairingUrl}`);
    log("The local session lasts at most 15 minutes. Sign out at /__local/ or press Ctrl+C. Source access is not granted by login.");
    if (stopSignal && !stopSignal.aborted) await new Promise((resolve) => stopSignal.addEventListener("abort", resolve, { once: true }));
  } finally { try { await bridge?.close(); } finally { await worker?.stop(); } }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--policy")) {
    console.error("Usage: pnpm local:owner [--policy path/to/local-policy.json]"); process.exitCode = 2;
  } else {
    const controller = new globalThis.AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await runLocalOwner({ policyFile: args[1], stopSignal: controller.signal }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
}
