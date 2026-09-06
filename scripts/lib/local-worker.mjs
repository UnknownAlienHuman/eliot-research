import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { devArguments, localEnvironment, ROOT, signalLocalProcess } from "./local-launch.mjs";
import { CHROMIUM_SAFE_PORT_RETRIES, isChromiumSafePort } from "./local-owner-bridge.mjs";
import { readDeploymentJson } from "./deployment-verification.mjs";

async function probeEphemeralPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

// A port-0 probe may return a Chromium-blocked ephemeral port (observed: 6000 on
// Windows) or race a concurrent bind. Retry with a fresh probe; every probe is
// closed before return, so no listener leaks. Bounded: fail-closed, never sleep-loop.
async function vacantChromiumSafePort({ attempts = CHROMIUM_SAFE_PORT_RETRIES } = {}) {
  let lastError = new Error("No Chromium-safe port probe attempted");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await probeEphemeralPort();
    if (isChromiumSafePort(port)) return { port, attempts: attempt };
    lastError = new Error(`OS assigned Chromium-unsafe ephemeral port ${port}; retrying with a fresh probe`);
  }
  throw lastError;
}

export async function startLocalWorker(paths) {
  const probed = await vacantChromiumSafePort();
  const port = probed.port;
  const child = spawn(process.execPath, devArguments(paths, port), {
    cwd: ROOT, env: localEnvironment(), stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  // Drain, but never retain or reflect possible credentials from Wrangler diagnostics.
  child.stdout.resume(); child.stderr.resume();
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    signalLocalProcess(child);
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { signalLocalProcess(child, "SIGKILL"); } catch { /* Report the bounded shutdown failure below. */ }
          reject(new Error("Local Worker did not close within the shutdown deadline"));
        }, 8000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i += 1) {
      if (spawnError || child.exitCode !== null) throw new Error("Local Worker exited before HTTP readiness");
      try {
        const { data } = await readDeploymentJson(`${origin}/healthz`, {}, { timeoutMs: 500 });
        assert.equal(data.ready, true);
        assert.equal(data.deployment_generation, paths.generation);
        return { origin, stop };
      } catch { await delay(250); }
    }
    throw new Error("Local Worker did not become ready with both migrated databases");
  } catch (error) { await stop(); throw error; }
}
