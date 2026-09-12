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

const RUNTIME_DIAGNOSTIC_PROTOCOL = "eliotr.local-worker.runtime-diagnostic.v1";
const RUNTIME_DIAGNOSTIC_TAIL_LIMIT = 8192;
const RUNTIME_DIAGNOSTIC_MAX_LINES = 128;
const RUNTIME_DIAGNOSTIC_SIGNALS = new Set([
  "SIGABRT", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGSEGV", "SIGTERM", "SIGTRAP",
]);
const RUNTIME_DIAGNOSTIC_SOURCES = new Set(["stdout", "stderr", "process", "unknown"]);
const RUNTIME_DIAGNOSTIC_STACK_BASENAMES = new Set([
  "cli.js", "index.js", "worker.js", "worker.mjs", "main.js", "workerd", "workerd.exe",
  "jsg.c++", "kj.c++", "exception.c++", "io.c++", "server.c++", "actor-state.c++", "workerd-api.c++",
]);
const RUNTIME_DIAGNOSTIC_STACK_PATTERN = /^(?:cli\.js|index\.js|worker\.m?js|main\.js|workerd(?:\.exe)?|(?:jsg|kj|exception|io|server|actor-state|workerd-api)\.c\+\+)$/u;
const RUNTIME_DIAGNOSTIC_DESCRIPTORS = [
  { template: "uncaught-workerd-exception", class: "runtime", code: "WORKERD_UNCAUGHT_EXCEPTION", phase: "runtime", priority: 100,
    pattern: /\b(?:uncaught\s+(?:exception|error)|workerd\b[^\r\n]*\b(?:exception|error)|(?:exception|error)\b[^\r\n]*\bworkerd\b|runtimeerror)\b/iu },
  { template: "allocation-failed", class: "runtime", code: "ALLOCATION_FAILED", phase: "runtime", priority: 110,
    pattern: /\b(?:ENOMEM|allocation\s+failed|failed\s+to\s+allocate|out\s+of\s+memory|memory\s+allocation|std::bad_alloc|javascript\s+heap\s+out\s+of\s+memory)\b/iu },
  { template: "address-in-use", class: "network", code: "EADDRINUSE", phase: "startup", priority: 80,
    pattern: /\b(?:EADDRINUSE|address\s+already\s+in\s+use)\b/iu },
  { template: "connection-reset", class: "network", code: "ECONNRESET", phase: "transport", priority: 70,
    pattern: /\b(?:ECONNRESET|connection\s+(?:was\s+)?reset|socket\s+reset|socket\s+hang\s+up)\b/iu },
  { template: "connection-timeout", class: "network", code: "ETIMEDOUT", phase: "transport", priority: 60,
    pattern: /\b(?:ETIMEDOUT|connection\s+timed\s+out|headers\s+timeout)\b/iu },
  { template: "address-unavailable", class: "network", code: "EADDRNOTAVAIL", phase: "startup", priority: 55,
    pattern: /\b(?:EADDRNOTAVAIL|address\s+not\s+available)\b/iu },
  { template: "unsafe-port", class: "network", code: "ERR_UNSAFE_PORT", phase: "startup", priority: 55,
    pattern: /\b(?:ERR_UNSAFE_PORT|unsafe\s+port)\b/iu },
  { template: "failed-runtime-start", class: "runtime", code: "RUNTIME_START_FAILED", phase: "startup", priority: 40,
    pattern: /\b(?:failed|unable)\s+to\s+(?:start|load|initialize)\b|\b(?:start|startup|initialization)\s+(?:failed|error)\b/iu },
];
const RUNTIME_DIAGNOSTIC_DESCRIPTOR_BY_KEY = new Map(
  RUNTIME_DIAGNOSTIC_DESCRIPTORS.map((descriptor) => [`${descriptor.template}/${descriptor.class}/${descriptor.code}/${descriptor.phase}`, descriptor]),
);

function normalizeSignalCode(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return "UNKNOWN";
  const normalized = value.toUpperCase();
  return RUNTIME_DIAGNOSTIC_SIGNALS.has(normalized) ? normalized : "UNKNOWN";
}

function stripDiagnosticAnsi(value) {
  return String(value ?? "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function safeSourceStack(value) {
  if (!value || typeof value !== "object") return null;
  const basename = typeof value.basename === "string" ? value.basename : "";
  const line = value.line;
  if (!RUNTIME_DIAGNOSTIC_STACK_BASENAMES.has(basename) || !RUNTIME_DIAGNOSTIC_STACK_PATTERN.test(basename)) return null;
  if (!Number.isSafeInteger(line) || line < 1 || line > 1_000_000_000) return null;
  return Object.freeze({ basename, line });
}

function parseSourceStackLocation(line) {
  const match = stripDiagnosticAnsi(line).match(/^\s*at\b[^\r\n]*?((?:cli\.js|index\.js|worker\.m?js|main\.js|workerd(?:\.exe)?|(?:jsg|kj|exception|io|server|actor-state|workerd-api)\.c\+\+)):(\d{1,10})(?::\d{1,10})?\)?\s*$/iu);
  if (!match) return null;
  const location = { basename: match[1], line: Number(match[2]) };
  return safeSourceStack(location);
}

function safeDiagnosticCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, RUNTIME_DIAGNOSTIC_MAX_LINES);
}

function freezeRuntimeDiagnostic({ descriptor, source = "unknown", signalCode = null, sourceStack = null,
  counts = {}, truncated = {} } = {}) {
  const safeDescriptor = descriptor ?? undefined;
  const safeSource = RUNTIME_DIAGNOSTIC_SOURCES.has(source) ? source : "unknown";
  const safeSignal = normalizeSignalCode(signalCode);
  const safeCounts = Object.freeze({
    observed: safeDiagnosticCount(counts.observed),
    classified: safeDiagnosticCount(counts.classified),
    unknown: safeDiagnosticCount(counts.unknown),
    stdout: safeDiagnosticCount(counts.stdout),
    stderr: safeDiagnosticCount(counts.stderr),
  });
  const safeTruncated = Object.freeze({ stdout: truncated.stdout === true, stderr: truncated.stderr === true });
  return Object.freeze({
    protocol: RUNTIME_DIAGNOSTIC_PROTOCOL,
    template: safeDescriptor?.template ?? "unknown",
    class: safeDescriptor?.class ?? "unknown",
    code: safeDescriptor?.code ?? "UNKNOWN",
    phase: safeDescriptor?.phase ?? "unknown",
    source: safeSource,
    source_stack: safeSourceStack(sourceStack),
    signal_code: safeSignal,
    counts: safeCounts,
    truncated: safeTruncated,
  });
}

/**
 * Keep runtime failure evidence useful without reflecting Worker source,
 * URLs, payloads, or credentials captured in Wrangler output.
 */
export function sanitizeRuntimeDiagnostic(value) {
  if (!value || typeof value !== "object") return freezeRuntimeDiagnostic();
  const key = [value.template, value.class, value.code, value.phase].map((item) => String(item ?? "")).join("/");
  const descriptor = RUNTIME_DIAGNOSTIC_DESCRIPTOR_BY_KEY.get(key) ??
    (value.template === "process-signal" && value.class === "process" && value.phase === "process" &&
      RUNTIME_DIAGNOSTIC_SIGNALS.has(String(value.code ?? "").toUpperCase())
      ? { template: "process-signal", class: "process", code: String(value.code).toUpperCase(), phase: "process" }
      : undefined);
  const counts = value.counts && typeof value.counts === "object" ? value.counts : {};
  const truncated = value.truncated && typeof value.truncated === "object" ? value.truncated : {};
  return freezeRuntimeDiagnostic({ descriptor, source: value.source, signalCode: value.signal_code ?? value.signalCode,
    sourceStack: value.source_stack, counts, truncated });
}

function scanRuntimeDiagnosticChannel(text, source, explicitTruncated) {
  const lines = String(text ?? "").split(/\r?\n/u).filter((line) => line.trim() !== "");
  const selectedLines = lines.slice(-RUNTIME_DIAGNOSTIC_MAX_LINES);
  const matches = [];
  let sourceStack;
  let classified = 0;
  for (const rawLine of selectedLines) {
    const line = stripDiagnosticAnsi(rawLine).trim();
    const location = parseSourceStackLocation(line);
    sourceStack ??= location;
    const descriptor = RUNTIME_DIAGNOSTIC_DESCRIPTORS.filter((candidate) => candidate.pattern.test(line))
      .sort((left, right) => right.priority - left.priority)[0];
    if (!descriptor) continue;
    classified += 1;
    matches.push({ descriptor, source, sourceStack: location });
  }
  return {
    source, matches, sourceStack, observed: selectedLines.length,
    classified, unknown: Math.max(0, selectedLines.length - classified),
    truncated: explicitTruncated === true || lines.length > selectedLines.length,
  };
}

export function classifyRuntimeDiagnostic({ stdout = "", stderr = "", stdoutTruncated = false,
  stderrTruncated = false, signalCode = null } = {}) {
  const channels = [
    scanRuntimeDiagnosticChannel(stdout, "stdout", stdoutTruncated),
    scanRuntimeDiagnosticChannel(stderr, "stderr", stderrTruncated),
  ];
  const matches = channels.flatMap((channel) => channel.matches)
    .sort((left, right) => right.descriptor.priority - left.descriptor.priority);
  const safeSignal = normalizeSignalCode(signalCode);
  let selected = matches[0];
  if (!selected && safeSignal && safeSignal !== "UNKNOWN") {
    selected = { descriptor: { template: "process-signal", class: "process", code: safeSignal, phase: "process" }, source: "process" };
  }
  const selectedChannel = selected?.source === "stdout" || selected?.source === "stderr"
    ? channels.find((channel) => channel.source === selected.source) : undefined;
  return freezeRuntimeDiagnostic({
    descriptor: selected?.descriptor,
    source: selected?.source,
    signalCode: safeSignal,
    sourceStack: selected?.sourceStack ?? selectedChannel?.sourceStack,
    counts: {
      observed: channels.reduce((sum, channel) => sum + channel.observed, 0),
      classified: channels.reduce((sum, channel) => sum + channel.classified, 0),
      unknown: channels.reduce((sum, channel) => sum + channel.unknown, 0),
      stdout: channels[0].observed,
      stderr: channels[1].observed,
    },
    truncated: { stdout: channels[0].truncated, stderr: channels[1].truncated },
  });
}

async function spawnOnce(paths, port, { testScheduled = false } = {}) {
  assertChromiumSafePort(port, "local worker port");
  const child = spawn(process.execPath, devArguments(paths, port, { testScheduled }), {
    cwd: ROOT, env: localEnvironment(), stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  // Drain, but retain only bounded tails for collision classification and the
  // fixed-field runtime diagnostic. Never reflect possible credentials from
  // Wrangler diagnostics.
  let stdoutTail = "";
  let stderrTail = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutTruncated ||= stdoutTail.length + text.length > RUNTIME_DIAGNOSTIC_TAIL_LIMIT;
    stdoutTail = `${stdoutTail}${text}`.slice(-RUNTIME_DIAGNOSTIC_TAIL_LIMIT);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrTruncated ||= stderrTail.length + text.length > RUNTIME_DIAGNOSTIC_TAIL_LIMIT;
    stderrTail = `${stderrTail}${text}`.slice(-RUNTIME_DIAGNOSTIC_TAIL_LIMIT);
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
      signalCode: normalizeSignalCode(child.signalCode), runtimeDiagnostic: classifyRuntimeDiagnostic({
        stdout: stdoutTail, stderr: stderrTail, stdoutTruncated, stderrTruncated, signalCode: child.signalCode,
      }) }) };
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
    // Keep the raw child text private for collision classification. The
    // externally thrown error carries only the fixed runtime classification.
    const diagnostic = `${handle.spawnError()?.message ?? ""}\n${handle.spawnError()?.code ?? ""}\n${handle.stderrTail()}`;
    const runtimeCode = handle.diagnostics().runtimeDiagnostic?.code ?? "UNKNOWN";
    await handle.stop();
    if ((earlyExit || handle.child.exitCode !== null) && isPortCollisionMessage(diagnostic)) {
      if (explicitPort) {
        throw new Error(`Local Worker requested port ${requestedPort} collided/refused; refusing fallback :: runtime=${runtimeCode}`);
      }
      lastError = new Error(`Local Worker port ${port} collided/refused (attempt ${attempt}/${attempts}); reselecting a fresh Chromium-safe port :: runtime=${runtimeCode}`);
      continue;
    }
    if (earlyExit || handle.child.exitCode !== null) {
      throw new Error(`Local Worker exited before HTTP readiness on Chromium-safe port ${port} :: runtime=${runtimeCode}`);
    }
    throw new Error("Local Worker did not become ready with both migrated databases");
  }
  throw lastError ?? new Error("Local Worker did not become ready with both migrated databases");
}
