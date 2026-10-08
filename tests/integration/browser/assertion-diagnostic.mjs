// Test-only diagnostics. Only these literal test assertions may disclose values;
// arbitrary Error.message/actual/expected/cause data is never logged.
const assertions = new WeakMap();
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const statusText = new Set([
  "File saved", "File uploaded. Continue to process it before adding it to Library.",
  "Existing upload found. Continue to process it before adding it to Library.",
  "Processing the captured file…", "Checking processing status…",
  "Processing complete. Ready to add to Library.",
  "Processing started. Continue when processing is ready.",
  "Processing status is unknown. Check processing status again.",
  "Adding the processed file to Library…", "Checking Library status…",
  "Added to Library. Search readiness is reported separately.",
  "This document is already in Library. Search readiness is reported separately.",
  "Library add status is unknown. Check Library status again.",
]);
const rules = Object.freeze({
  "raw-upload.status": { phase: "raw-upload", expected: "File saved" },
  "raw-recovery.status": { phase: "raw-recovery", expected: "Existing upload found" },
});

// Descriptor reads avoid executing getters on foreign error objects. Prototype
// lookup is bounded and needed for native TypeError/AssertionError names.
export function diagnosticProperty(value, key) {
  try {
    for (let depth = 0; value && (typeof value === "object" || typeof value === "function") && depth < 3; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor) {
        if (Object.hasOwn(descriptor, "value")) return descriptor.value;
        // V8 Node 22 uses a shared native accessor even for an assigned stack.
        // Its exact identity is trusted; a user-defined getter is never invoked.
        if (key === "stack" && nativeStackGetter && descriptor.get === nativeStackGetter) {
          return Reflect.apply(nativeStackGetter, value, []);
        }
        return undefined;
      }
      value = Object.getPrototypeOf(value);
    }
  } catch { /* A proxy or a revoked foreign object is not diagnostic authority. */ }
  return undefined;
}

export function diagnosticErrorChain(error) {
  const queue = [{ value: error, depth: 0 }];
  const seen = new Set();
  const values = [];
  while (queue.length > 0 && values.length < 8) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (depth >= 5) continue;
    for (const key of ["cause", "original_error"]) {
      const child = diagnosticProperty(value, key);
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
    const errors = diagnosticProperty(value, "errors");
    let isArray = false;
    try { isArray = Array.isArray(errors); } catch { /* A revoked proxy is opaque. */ }
    if (isArray) {
      for (let index = 0; index < 4; index += 1) {
        const child = diagnosticProperty(errors, String(index));
        if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return values;
}

export function annotateBrowserAssertion(error, id, actual, expected) {
  if (!error || typeof error !== "object" || typeof id !== "string" || !Object.hasOwn(rules, id)) return error;
  const rule = rules[id];
  // Exact equality, never substrings: a private value containing "File saved"
  // remains private. No stringification, JSON serialization, or source hashing.
  const safeActual = typeof actual === "string" && actual.length <= 256 && statusText.has(actual)
    ? actual : "REDACTED_UNREGISTERED_VALUE";
  assertions.set(error, Object.freeze({ id, phase: rule.phase,
    expected: expected === rule.expected ? expected : "REDACTED_UNREGISTERED_VALUE",
    actual: safeActual,
  }));
  return error;
}

export function browserAssertionDiagnostic(error) {
  for (const candidate of diagnosticErrorChain(error)) {
    const diagnostic = assertions.get(candidate);
    if (diagnostic) return diagnostic;
  }
  return undefined;
}


/** Only closed protocol states and numeric HTTP statuses may leave the browser. */
export function annotateRawPipelineFailure(error, observations) {
  if (!error || typeof error !== "object") return error;
  const outcomes = new Set(["CAPTURED", "STARTED", "COMPLETE", "FAILED", "UNKNOWN", "COMMITTED", "QUARANTINED", "REJECTED"]);
  const codes = new Set(["INVALID_REQUEST", "IDEMPOTENCY_CONFLICT", "SOURCE_UNAVAILABLE", "SOURCE_INTEGRITY_MISMATCH",
    "CANCELED", "PROVIDER_FAILED", "PROVIDER_UNCERTAIN", "OUTPUT_UNAVAILABLE", "API_REQUEST_ABORTED",
    "API_UNREACHABLE", "API_RESPONSE_SCHEMA_MISMATCH", "API_GENERATION_MISMATCH", "RAW_NORMALIZED_OUTCOME_UNKNOWN",
    "LOCAL_REQUEST_FAILED", "RAW_ADMISSION_RESPONSE_INVALID", "BODY_CAPTURE_FAILED", "FETCH_FAILED",
    "DUPLICATE_REQUEST", "RESPONSE_IDENTITY_MISMATCH", "CLONE_FAILED"]);
  const responses = ["capture", "conversion", "admission"].map((operation) => {
    const value = diagnosticProperty(observations, operation);
    const phase = diagnosticProperty(value, "phase");
    const status = diagnosticProperty(value, "status");
    const outcome = diagnosticProperty(value, "outcome");
    const code = diagnosticProperty(value, "code");
    return Object.freeze({ operation,
      phase: ["waiting", "reading", "complete", "error"].includes(phase) ? phase : "unobserved",
      status: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null,
      outcome: outcomes.has(outcome) ? outcome : "unobserved",
      code: codes.has(code) ? code : "unobserved",
    });
  });
  assertions.set(error, Object.freeze({ id: "raw-pipeline.responses", phase: "raw-import", responses: Object.freeze(responses) }));
  return error;
}

function consoleRoute(raw, origin) {
  try {
    const url = new globalThis.URL(raw);
    if (url.origin !== origin || url.username || url.password) return "unregistered";
    const paths = {
      "/": "shell-document", "/__local/": "pairing",
      "/__local/pair": "pair", "/api/v1/system/health": "health",
      "/api/v1/system/session": "session", "/api/v1/research/catalog": "catalog",
      "/api/v1/research/runs": "run-history", "/api/v1/research/query": "query", "/api/v1/research/query/jobs": "jobs",
      "/api/v1/library/content": "admitted-content", "/api/v1/library/revisions": "revisions", "/api/v1/ingest/raw": "raw-capture",
      "/api/v1/system/research-configuration": "configuration", "/api/v1/research/changes": "changes",
      "/api/v1/research/wiki/proposals": "wiki-proposals", "/api/v1/research/projects": "projects",
      "/api/v1/library/namespaces": "namespaces", "/api/v1/library/readiness": "readiness",
      "/api/v1/research/orient": "orientation",
      "/manifest.webmanifest": "manifest", "/sw.js": "shell-worker", "/favicon.ico": "favicon",
    };
    if (Object.hasOwn(paths, url.pathname)) return paths[url.pathname];
    const rawStage = /^\/api\/v1\/ingest\/raw\/raw-capture-[a-f0-9]{48}\/(markdown|admission)$/u.exec(url.pathname);
    if (rawStage) return rawStage[1] === "markdown" ? "raw-conversion" : "raw-admission";
    if (/^\/api\/v1\/research\/query\/jobs\/[A-Za-z0-9:_-]+$/u.test(url.pathname)) return "job-status";
    if (/^\/_astro\/[A-Za-z0-9_.-]+\.js$/u.test(url.pathname)) return "shell-script";
  } catch { /* Never disclose an unknown URL or a private identifier. */ }
  return "unregistered";
}

function consoleTemplate(text, match) {
  if (match?.[1]) return "http-status";
  if (match?.[2]) return "network-error";
  if (typeof text !== "string" || text.length > 2048) return "unregistered";
  const templates = [
    ["csp-inline-script", /^(?:Executing inline script violates|Refused to execute inline script)/u],
    ["csp-inline-style", /^(?:Applying inline style violates|Refused to apply inline style)/u],
    ["csp-eval", /^(?:Evaluating a string as JavaScript violates|Refused to evaluate a string as JavaScript)/u],
    ["csp-worker", /^(?:Creating a worker from|Refused to create a worker)/u],
    ["csp-connect", /^(?:Connecting to|Refused to connect to)/u],
    ["csp-meta-frame-ancestors", /^The Content Security Policy directive 'frame-ancestors' is ignored/u],
    ["manifest-icon", /^Error while trying to use the following icon from the Manifest:/u],
    ["service-worker-fetch", /^The FetchEvent for/u],
  ];
  return templates.find(([, pattern]) => pattern.test(text))?.[0] ?? "unregistered";
}

/** Diagnostic only: it cannot authorize console noise or change test outcome. */
export function annotateAuthedConsoleFailure(error, values, origin) {
  if (!error || typeof error !== "object") return error;
  const length = diagnosticProperty(values, "length");
  const count = Number.isSafeInteger(length) && length >= 0 ? length : null;
  const entries = [];
  for (let index = 0; index < Math.min(count ?? 0, 8); index += 1) {
    const text = diagnosticProperty(values, String(index));
    const match = typeof text === "string" && text.length <= 2048
      ? /^Failed to load resource: (?:the server responded with a status of ([45][0-9]{2})(?: \([A-Za-z ]+\))?|net::(ERR_ABORTED|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_FAILED|ERR_CONNECTION_RESET|ERR_TIMED_OUT)) @(.+)$/u.exec(text) : null;
    const location = typeof text === "string" && text.length <= 2048 ? text.lastIndexOf(" @") : -1;
    entries.push(Object.freeze({ route: location >= 0 ? consoleRoute(text.slice(location + 2), origin) : "unregistered",
      status: match?.[1] ? Number(match[1]) : null, transport: match?.[2] ?? null,
      template: consoleTemplate(text, match) }));
  }
  assertions.set(error, Object.freeze({ id: "authed.console", phase: "authed", count, entries: Object.freeze(entries) }));
  return error;
}


/** Retain route category/status only; no URLs, bodies, query strings or IDs. */
export function annotatePhaseNetworkFailure(error, response, expected, origin) {
  if (!error || typeof error !== "object") return error;
  const path = diagnosticProperty(response, "path");
  const responseOrigin = diagnosticProperty(response, "origin");
  const method = diagnosticProperty(response, "method");
  const status = diagnosticProperty(response, "status");
  const safeStatus = (value) => Number.isSafeInteger(value) && value >= 100 && value <= 599;
  const route = typeof path === "string" && path.length <= 2048 && responseOrigin === origin
    ? consoleRoute(`${origin}${path}`, origin) : "unregistered";
  // Only the internal exact-route Set is used; never traverse provider objects.
  const statuses = expected instanceof Set ? [...expected].filter(safeStatus).slice(0, 8) : [];
  assertions.set(error, Object.freeze({ id: "phase.application-response", phase: "network-closure",
    route, method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "unregistered",
    status: safeStatus(status) ? status : null,
    expected_statuses: Object.freeze(statuses),
    reason: statuses.length ? "STATUS_DRIFT" : "UNREGISTERED_ROUTE",
  }));
  return error;
}
