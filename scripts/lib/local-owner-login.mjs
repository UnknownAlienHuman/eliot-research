import { spawn } from "node:child_process";
import { localEnvironment, signalLocalProcess } from "./local-launch.mjs";
import { validateOwnerConfig } from "./local-owner-config.mjs";
import { readDeploymentJson } from "./deployment-verification.mjs";

function cli(args, { capture = false, spawnProcess = spawn, timeoutMs = 120000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new Error("Cloudflare Access login cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawnProcess("cloudflared", args, { env: localEnvironment(), shell: false,
      windowsHide: true, stdio: ["ignore", capture ? "pipe" : "ignore", capture ? "ignore" : "inherit"] });
    const chunks = []; let size = 0; let failure;
    const stop = () => { try { signalLocalProcess(child, "SIGKILL"); } catch { failure = "shutdown"; } };
    const cancelled = () => { failure = "cancelled"; stop(); reject(new Error("Cloudflare Access login cancelled")); };
    signal?.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => { failure = "deadline"; stop(); reject(new Error("Cloudflare Access login timed out")); }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16384) { failure = "oversized output"; stop(); }
      else chunks.push(chunk);
    });
    child.once("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); reject(new Error("Cannot start cloudflared; install the official CLI and put it on PATH")); });
    child.once("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancelled);
      if (code !== 0 || failure) reject(new Error("Cloudflare Access login failed; token output was not logged"));
      else resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

export async function loginOwner(config, { run = cli, signal } = {}) {
  const settings = validateOwnerConfig(config);
  // --quiet prevents login from printing the bearer JWT. The official CLI owns the browser flow/cache.
  await run(["access", "login", "--quiet", settings.app], { signal });
  const token = await run(["access", "token", `--app=${settings.app}`], { capture: true, signal });
  if (typeof token !== "string" || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error("Cloudflare CLI returned an invalid token; output was not logged");
  }
  return token;
}

export function validateWorkerOrigin(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      !url.port || url.username || url.password) throw new Error("Owner bridge requires a fixed IPv4 loopback Worker origin");
  return origin;
}

export async function readOwnerIdentity(origin, token, generation, { fetchImpl = fetch, now = Date.now } = {}) {
  validateWorkerOrigin(origin);
  const { data: envelope } = await readDeploymentJson(`${origin}/api/v1/system/session`, {
    "Cf-Access-Jwt-Assertion": token, Accept: "application/json",
  }, { fetchImpl, maxBytes: 4096, timeoutMs: 15000 });
  const identity = envelope?.data;
  const id = (value) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!envelope || Object.keys(envelope).sort().join(",") !== "data,deployment_generation,trace_id" ||
      envelope.deployment_generation !== generation || !id(envelope.trace_id) || !identity ||
      Object.keys(identity).sort().join(",") !== "client_class,credential_generation,expires_at,principal_ref,protocol" ||
      identity.protocol !== "eliotr.owner-session.v1" || identity.client_class !== "owner_pwa" ||
      !id(identity.principal_ref) || !id(identity.credential_generation) || typeof identity.expires_at !== "string" ||
      !Number.isFinite(Date.parse(identity.expires_at)) || Date.parse(identity.expires_at) <= now()) {
    throw new Error("Worker rejected the exact owner identity, generation or token lifetime");
  }
  return identity;
}
