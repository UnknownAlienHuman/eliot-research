import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { devArguments, localEnvironment, ROOT, signalLocalProcess } from "./local-launch.mjs";
import { readDeploymentJson } from "./deployment-verification.mjs";

async function vacantPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function startLocalWorker(paths) {
  const port = await vacantPort();
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
