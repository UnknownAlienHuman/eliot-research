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
