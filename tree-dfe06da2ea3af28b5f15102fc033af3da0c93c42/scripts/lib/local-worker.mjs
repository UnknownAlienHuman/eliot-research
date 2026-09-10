import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { devArguments, localEnvironment, ROOT, signalLocalProcess } from "./local-launch.mjs";
import { CHROMIUM_SAFE_PORT_RETRIES, assertChromiumSafePort, bindChromiumSafeListener, isPortCollisionMessage } from "./local-owner-bridge.mjs";
import { readDeploymentJson } from "./deployment-verification.mjs";

function listenHolder(candidate) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      server.close(() => reject(error));
    });
    server.listen(candidate, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// Hold-the-listener reservation shared with the bridge/JWKS path (no duplicate
// authority): bind port 0 via bindChromiumSafeListener so a Chromium-blocked
// ephemeral port (observed: 6000) retries with a fresh bind and a rejected
// attempt closes its listener before the next attempt. The winning holder is
// closed after reserving so the port can be handed to `wrangler dev`; the
// residual probe-to-bind race is closed by the bounded reselect/retry in
// startLocalWorker below, never by skipping or by an unbounded sleep-loop.
export async function reserveChromiumSafePort({ port: requestedPort = 0, attempts = CHROMIUM_SAFE_PORT_RETRIES } = {}) {
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("Invalid local worker port");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error("Invalid local worker retry bound");
  }
  if (requestedPort !== 0) {
    assertChromiumSafePort(requestedPort, "requested local worker port");
    // An explicit port is an operator-selected origin. It must fail closed on
    // collision instead of silently selecting another listener.
    attempts = 1;
  }
  const bound = await bindChromiumSafeListener(listenHolder, { port: requestedPort, attempts });
  if (requestedPort !== 0 && bound.port !== requestedPort) {
    await new Promise((resolve, reject) => bound.server.close((error) => error ? reject(error) : resolve()));
    throw new Error(`Requested local worker port ${requestedPort} was not reserved exactly`);
  }
  const port = bound.port;
  const bindAttempts = bound.attempts;
  await new Promise((resolve, reject) => bound.server.close((error) => error ? reject(error) : resolve()));
  assertChromiumSafePort(port, "reserved local worker port");
  return { port, attempts: bindAttempts };
}

function redactSpawnDiagnostic(text) {
  return String(text ?? "")
    .replaceAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[REDACTED_JWT]")
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED_KEY]")
    .replaceAll(/((?:MF-Proxy-Shared-Secret|authorization|cookie|set-cookie|cf-access-jwt-assertion|access[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)/giu, "$1[REDACTED]")
    .replaceAll(/(https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?)\?[^\s#]*/gu, "$1?[REDACTED_QUERY]")
    .slice(0, 2000);
}

function summarizeRuntimeOutput(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const value = line.trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    const kind = /error|exception|fatal|uncaught|crash|reset/u.test(lower) ? "error"
      : /reload|restart|restarting|reloading/u.test(lower) ? "reload"
        : /exit|closed|terminated|shutdown/u.test(lower) ? "exit"
          : /ready|listen(?:ing)?|started/u.test(lower) ? "ready" : null;
    if (kind === null) continue;
    const code = value.match(/\b(?:ECONNRESET|EADDRINUSE|ERR_UNSAFE_PORT|EADDRNOTAVAIL|ETIMEDOUT|SIGTERM|SIGKILL)\b/iu)?.[0]?.toUpperCase();
    const status = value.match(/\bstatus[=: ]+(\d{3})\b/iu)?.[1];
    events.push(`${kind}${code ? `:${code}` : ""}${status ? `:status-${status}` : ""}`);
  }
  return [...new Set(events)].slice(-24).join(",").slice(0, 2000);
}

async function spawnOnce(paths, port, { testScheduled = false } = {}) {
  assertChromiumSafePort(port, "local worker port");
  const child = spawn(process.execPath, devArguments(paths, port, { testScheduled }), {
    cwd: ROOT, env: localEnvironment(), stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  // Drain, but retain only a bounded redacted tail for collision classification.
  // Never retain or reflect possible credentials from Wrangler diagnostics.
  let stdoutTail = "";
  let stderrTail = "";
  child.stdout.on("data", (chunk) => {
    stdoutTail = `${stdoutTail}${chunk.toString("utf8")}`.slice(-8192);
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8192);
  });
  child.stderr.resume();
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
  return { child, closed, stop, spawnError: () => spawnError, stderrTail: () => redactSpawnDiagnostic(stderrTail),
    diagnostics: () => Object.freeze({ pid: child.pid ?? null, port, exitCode: child.exitCode,
      stderrTail: redactSpawnDiagnostic(stderrTail), stdoutEvents: summarizeRuntimeOutput(stdoutTail) }) };
}

export async function startLocalWorker(paths, {
  attempts = CHROMIUM_SAFE_PORT_RETRIES, testScheduled = false, port: requestedPort,
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error("Invalid local worker retry bound");
  }
  if (typeof testScheduled !== "boolean") throw new Error("testScheduled must be a boolean");
  const explicitPort = requestedPort !== undefined;
  if (explicitPort) assertChromiumSafePort(requestedPort, "requested local worker port");
  let lastError;
  let reserveAttempts = 0;
  const maxAttempts = explicitPort ? 1 : attempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reserved = await reserveChromiumSafePort(explicitPort ? { port: requestedPort, attempts: 1 } : {});
    reserveAttempts += reserved.attempts;
    const port = reserved.port;
    const handle = await spawnOnce(paths, port, { testScheduled });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    let earlyExit = false;
    for (let i = 0; i < 120; i += 1) {
      if (handle.spawnError() || handle.child.exitCode !== null) { earlyExit = true; break; }
      try {
        const { data } = await readDeploymentJson(`${origin}/healthz`, {}, { timeoutMs: 500 });
        assert.equal(data.ready, true);
        assert.equal(data.deployment_generation, paths.generation);
        ready = true;
        break;
      } catch { await delay(250); }
    }
    if (ready) {
      // Success: the child stays running under the returned stop() handle.
      // Evidence records which start attempt won and how many port
      // reservations it took; no listener leaks (holder closed per reserve).
      return { origin, port, stop: handle.stop, startAttempts: attempt, reserveAttempts, diagnostics: handle.diagnostics };
    }
    // Classify the failure: a port collision or bad-port refusal stops this
    // child and reselects a fresh Chromium-safe port with a bounded retry. Any
    // other failure (config, migration, schema, authority) fails closed now.
    const diagnostic = `${handle.spawnError()?.message ?? ""}\n${handle.spawnError()?.code ?? ""}\n${handle.stderrTail()}`;
    await handle.stop();
    if ((earlyExit || handle.child.exitCode !== null) && isPortCollisionMessage(diagnostic)) {
      if (explicitPort) {
        throw new Error(`Local Worker requested port ${requestedPort} collided/refused; refusing fallback :: ${handle.stderrTail().slice(0, 300)}`);
      }
      lastError = new Error(`Local Worker port ${port} collided/refused (attempt ${attempt}/${attempts}); reselecting a fresh Chromium-safe port :: ${handle.stderrTail().slice(0, 300)}`);
      continue;
    }
    if (earlyExit || handle.child.exitCode !== null) {
      throw new Error(`Local Worker exited before HTTP readiness on Chromium-safe port ${port} :: ${handle.stderrTail().slice(0, 300)}`);
    }
    throw new Error("Local Worker did not become ready with both migrated databases");
  }
  throw lastError ?? new Error("Local Worker did not become ready with both migrated databases");
}
