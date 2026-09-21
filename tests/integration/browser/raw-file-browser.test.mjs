import { inspect } from "node:util";
import { annotateBrowserAssertion, browserAssertionDiagnostic, diagnosticErrorChain } from "./assertion-diagnostic.mjs";
import { preserveWorkerFailure } from "./owner-e2e.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rawBrowser from "./raw-file-browser.mjs";
import { createHash } from "node:crypto";
import { waitForRawResponse, waitForRawResponses } from "./raw-file-browser.mjs";
/* global Buffer:readonly, Response:readonly, TextEncoder:readonly, URL:readonly, setTimeout:readonly */

const rawPath = "/api/v1/ingest/raw";
const rawUrl = `http://127.0.0.1:4321${rawPath}`;

function responseFixture() {
  let unavailable = false;
  const response = {
    status: () => 200,
    url: () => "http://127.0.0.1:4321/api/v1/ingest/raw",
    request: () => ({
      method: () => "POST",
      allHeaders: async () => ({ "content-type": "application/json" }),
    }),
    body: async () => {
      if (unavailable) throw new Error("response body unavailable after navigation");
      return Buffer.from(JSON.stringify({ data: { protocol: "eliotr.raw-file-capture.v1" } }), "utf8");
    },
  };
  const page = { waitForResponse: () => Promise.resolve(response) };
  const action = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    unavailable = true;
  };
  return { page, action };
}

test("raw response snapshots body before an action can navigate away", async () => {
  const { page, action } = responseFixture();
  const snapshot = await waitForRawResponse(page, "POST", action);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.requestHeaders["content-type"], "application/json");
  assert.equal(snapshot.payload.data.protocol, "eliotr.raw-file-capture.v1");
});

test("the former action-then-body ordering fails after navigation", async () => {
  const { page, action } = responseFixture();
  const response = await page.waitForResponse(() => true);
  await action();
  await assert.rejects(response.body(), /response body unavailable/u);
});

function cloneCaptureFixture({ responseFactory = () => new Response(JSON.stringify({ data: { protocol: "eliotr.raw-file-capture.v1" } }), {
  status: 200, headers: { "content-type": "application/json; charset=utf-8" },
}), cdpResponse = {} } = {}) {
  const priorWindow = globalThis.window;
  const priorLocation = globalThis.location;
  const priorBtoa = globalThis.btoa;
  const pageWindow = {};
  const originalFetch = async function (...args) {
    pageWindow.seenFetch = { receiver: this, args };
    const response = responseFactory();
    if (!response.url) Object.defineProperty(response, "url", { configurable: true, value: rawUrl });
    return response;
  };
  pageWindow.fetch = originalFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: pageWindow });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: `${rawUrl}/`, origin: "http://127.0.0.1:4321" } });
  Object.defineProperty(globalThis, "btoa", { configurable: true, value: (value) => Buffer.from(value, "binary").toString("base64") });
  let resolveResponse;
  const response = {
    status: () => 200,
    url: () => rawUrl,
    headers: () => ({ "content-type": "application/json" }),
    request: () => ({ method: () => "POST", allHeaders: async () => ({ "content-type": "application/json" }), postData: () => "{}", timing: () => ({}) }),
    body: async () => { throw new Error("Response body is unavailable"); },
    ...cdpResponse,
  };
  const page = {
    url: () => `${rawUrl}/fixture`,
    mainFrame: () => undefined,
    evaluate: async (fn, args) => fn(args),
    waitForResponse: () => new Promise((resolve) => { resolveResponse = resolve; }),
    waitForFunction: async (fn, args) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const value = await fn(args);
        if (value) return { jsonValue: async () => value, dispose: async () => {} };
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("capture did not settle");
    },
    restore: () => {
      if (priorWindow === undefined) delete globalThis.window;
      else Object.defineProperty(globalThis, "window", { configurable: true, value: priorWindow });
      if (priorLocation === undefined) delete globalThis.location;
      else Object.defineProperty(globalThis, "location", { configurable: true, value: priorLocation });
      if (priorBtoa === undefined) delete globalThis.btoa;
      else Object.defineProperty(globalThis, "btoa", { configurable: true, value: priorBtoa });
    },
  };
  const action = async () => {
    await pageWindow.fetch(rawPath, { method: "POST" });
    resolveResponse(response);
  };
  return { page, action, response, rawUrl };
}

test("uses the actual page-side clone when the CDP response body is unavailable", async () => {
  const fixture = cloneCaptureFixture();
  try {
    const snapshot = await waitForRawResponse(fixture.page, "POST", fixture.action, rawPath);
    assert.equal(snapshot.payload.data.protocol, "eliotr.raw-file-capture.v1");
    await assert.rejects(fixture.response.body(), /Response body is unavailable/u);
    assert.equal(globalThis.window.seenFetch.receiver, globalThis.window);
    assert.equal(globalThis.window.seenFetch.args[0], rawPath);
    assert.equal(globalThis.window.__eliotrRawResponseCapture, undefined);
  } finally { fixture.page.restore(); }
});

test("reads clone streams incrementally, preserves split UTF-8, and cancels overflow", async (t) => {
  await t.test("split UTF-8", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ data: { protocol: "eliotr.raw-file-capture.v1", label: "naïve" } }));
    const splitAt = body.findIndex((value, index) => value >= 0x80 && index > 0);
    let offset = 0;
    const fixture = cloneCaptureFixture({ responseFactory: () => ({
      status: 200, url: rawUrl, type: "basic", redirected: false,
      clone: () => ({ body: { getReader: () => ({
        read: async () => {
          if (offset === 0) { const value = body.subarray(0, splitAt + 1); offset = splitAt + 1; return { done: false, value }; }
          if (offset < body.byteLength) { const value = body.subarray(offset); offset = body.byteLength; return { done: false, value }; }
          return { done: true, value: undefined };
        },
        cancel: async () => {},
      }) } }),
    }) });
    try {
      const snapshot = await waitForRawResponse(fixture.page, "POST", fixture.action, rawPath);
      assert.equal(snapshot.payload.data.label, "naïve");
    } finally { fixture.page.restore(); }
  });
  await t.test("overflow cancels the reader", async () => {
    const oversized = new Uint8Array(512 * 1024 + 1);
    let cancelCalls = 0;
    const fixture = cloneCaptureFixture({ responseFactory: () => ({
      status: 200, url: rawUrl, type: "basic", redirected: false,
      clone: () => ({ body: { getReader: () => ({
        read: async () => ({ done: false, value: oversized }),
        cancel: () => { cancelCalls += 1; return new Promise(() => {}); },
      }) } }),
    }) });
    try {
      await Promise.race([
        assert.rejects(waitForRawResponse(fixture.page, "POST", fixture.action, rawPath), /BODY_CAPTURE_FAILED/u),
        new Promise((_, reject) => setTimeout(() => reject(new Error("overflow cleanup stalled")), 250)),
      ]);
      assert.equal(cancelCalls, 1);
      assert.equal(globalThis.window.__eliotrRawResponseCapture, undefined);
    } finally { fixture.page.restore(); }
  });
});

test("rejects a clone status mismatch and failed clone, then restores fetch state", async (t) => {
  await t.test("status mismatch", async () => {
    const fixture = cloneCaptureFixture({ responseFactory: () => {
      const response = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(response, "url", { configurable: true, value: fixture.rawUrl });
      return response;
    }});
    try { await assert.rejects(waitForRawResponse(fixture.page, "POST", fixture.action, rawPath, 503), /STATUS_MISMATCH/u); }
    finally { assert.equal(globalThis.window.__eliotrRawResponseCapture, undefined); fixture.page.restore(); }
  });
  await t.test("failed clone", async () => {
    const fixture = cloneCaptureFixture({ responseFactory: () => ({ status: 200, url: fixture.rawUrl, type: "default", redirected: false,
      clone: () => { throw new Error("clone failed"); } }) });
    try { await assert.rejects(waitForRawResponse(fixture.page, "POST", fixture.action, rawPath), /CLONE_FAILED/u); }
    finally { assert.equal(globalThis.window.__eliotrRawResponseCapture, undefined); fixture.page.restore(); }
  });
});

function batchCaptureFixture({ orientationBrowserStatus = 200, orientationPageResponse, rejectAction = false } = {}) {
  const priorWindow = globalThis.window;
  const priorLocation = globalThis.location;
  const priorBtoa = globalThis.btoa;
  const pageWindow = {};
  const waiters = [];
  const responseFor = (path, method, body, browserStatus = 200, pageResponse = undefined) => {
    const response = pageResponse ?? new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const responseUrl = `http://127.0.0.1:4321${path}`;
    Object.defineProperty(response, "url", { configurable: true, value: responseUrl });
    const requestBody = method === "POST" ? JSON.stringify({ product: "FAST_SEARCH", query: "fixture" }) : undefined;
    const request = { method: () => method, allHeaders: async () => ({ accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }), postData: () => requestBody };
    return { pageResponse: response, browserResponse: { status: () => browserStatus, url: () => responseUrl, request: () => request } };
  };
  const responses = new Map([
    ["POST /orient", responseFor("/orient", "POST", { data: { protocol: "orient.fixture" } }, orientationBrowserStatus, orientationPageResponse)],
    ["GET /ready?source_id=source-1", responseFor("/ready?source_id=source-1", "GET", { data: { source_id: "source-1" } })],
    ["GET /trace/query-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", responseFor("/trace/query-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "GET", { data: { query_product: "FAST_SEARCH" } })],
  ]);
  const originalFetch = async (input, init = {}) => {
    const url = new URL(String(input), pageWindow.location.href);
    const entry = responses.get(`${String(init.method ?? "GET").toUpperCase()} ${url.pathname}${url.search}`);
    if (!entry) throw new Error("unexpected fixture request");
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(entry.browserResponse)) {
        const waiter = waiters.splice(index, 1)[0];
        waiter.resolve(entry.browserResponse);
      }
    }
    return entry.pageResponse;
  };
  pageWindow.fetch = originalFetch;
  pageWindow.location = { href: "http://127.0.0.1:4321/fixture", origin: "http://127.0.0.1:4321" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: pageWindow });
  Object.defineProperty(globalThis, "location", { configurable: true, value: pageWindow.location });
  Object.defineProperty(globalThis, "btoa", { configurable: true, value: (value) => Buffer.from(value, "binary").toString("base64") });
  const page = {
    url: () => pageWindow.location.href,
    mainFrame: () => undefined,
    evaluate: async (fn, args) => fn(args),
    waitForResponse: (predicate) => new Promise((resolve) => { waiters.push({ predicate, resolve }); }),
    waitForFunction: async (fn, args) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const value = await fn(args);
        if (value) return { jsonValue: async () => value, dispose: async () => {} };
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("batch capture did not settle");
    },
  };
  return {
    page,
    action: async () => {
      if (rejectAction) throw new Error("fixture action failed");
      await pageWindow.fetch("/orient", { method: "POST" });
      await pageWindow.fetch("/ready?source_id=source-1", { method: "GET" });
      await pageWindow.fetch("/trace/query-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { method: "GET" });
    },
    restore: () => {
      if (priorWindow === undefined) delete globalThis.window;
      else Object.defineProperty(globalThis, "window", { configurable: true, value: priorWindow });
      if (priorLocation === undefined) delete globalThis.location;
      else Object.defineProperty(globalThis, "location", { configurable: true, value: priorLocation });
      if (priorBtoa === undefined) delete globalThis.btoa;
      else Object.defineProperty(globalThis, "btoa", { configurable: true, value: priorBtoa });
    },
  };
}

function overflowPageResponse(path, onCancel) {
  const responseUrl = `http://127.0.0.1:4321${path}`;
  return {
    status: 200, url: responseUrl, type: "basic", redirected: false,
    clone: () => ({ body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(512 * 1024 + 1) }),
      cancel: () => { onCancel(); return new Promise(() => {}); },
    }) } }),
  };
}

test("captures multiple same-page JSON responses with exact path and query binding", async () => {
  const fixture = batchCaptureFixture();
  try {
    const snapshots = await waitForRawResponses(fixture.page, [
      { key: "orientation", method: "POST", path: "/orient", expectedStatus: 200 },
      { key: "readiness", method: "GET", path: "/ready?source_id=source-1", expectedStatus: 200 },
      { key: "trace", method: "GET", pathPattern: "^/trace/query-[0-9a-f]{48}$", expectedStatus: 200 },
    ], fixture.action);
    assert.equal(snapshots.orientation.requestHeaders.accept, "application/json");
    assert.equal(snapshots.orientation.requestHeaders["content-type"], "application/json");
    assert.equal(snapshots.orientation.payload.data.protocol, "orient.fixture");
    assert.equal(snapshots.readiness.responsePath, "/ready?source_id=source-1");
    assert.equal(snapshots.readiness.payload.data.source_id, "source-1");
    assert.equal(snapshots.trace.responsePath, "/trace/query-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(snapshots.trace.payload.data.query_product, "FAST_SEARCH");
  } finally { fixture.restore(); }
});

test("rejects a batch when the CDP status disagrees with the captured response", async () => {
  const fixture = batchCaptureFixture({ orientationBrowserStatus: 503 });
  try {
    await assert.rejects(waitForRawResponses(fixture.page, [
      { key: "orientation", method: "POST", path: "/orient", expectedStatus: 200 },
    ], fixture.action), /clone\/CDP identity mismatch/u);
  } finally { fixture.restore(); }
});

test("cancels an overflowing batch reader and observes action rejection immediately", async () => {
  let cancelCalls = 0;
  const overflow = overflowPageResponse("/orient", () => { cancelCalls += 1; });
  const overflowFixture = batchCaptureFixture({ orientationPageResponse: overflow });
  try {
    await assert.rejects(waitForRawResponses(overflowFixture.page, [
      { key: "orientation", method: "POST", path: "/orient", expectedStatus: 200 },
    ], overflowFixture.action), /BODY_CAPTURE_FAILED/u);
    assert.equal(cancelCalls, 1);
  } finally { overflowFixture.restore(); }

  const rejectedFixture = batchCaptureFixture({ rejectAction: true });
  try {
    await assert.rejects(waitForRawResponses(rejectedFixture.page, [
      { key: "orientation", method: "POST", path: "/orient", expectedStatus: 200 },
    ], rejectedFixture.action), /fixture action failed/u);
  } finally { rejectedFixture.restore(); }
});


const worker = { diagnostics: () => ({ pid: 42, port: 43123, exitCode: 1 }) };
const actual = "Processing the captured file…";
function statusFailure(value = actual) {
  try { assert.match(value, /File saved/u); }
  catch (error) {
    error.stack = "AssertionError: PRIVATE\n    at fixture (C:\\private\\raw-file-browser.mjs:597:10)";
    return annotateBrowserAssertion(error, "raw-upload.status", value, "File saved");
  }
  throw new Error("fixture must fail");
}
function exposed(error) { return JSON.stringify(error) + inspect(error, { depth: 10 }) + error.stack; }

test("S02: nested original assertion retains its registered values, phase and source", () => {
  const original = statusFailure();
  const nested = new Error("Authorization: Bearer SECRET", { cause: new Error("PRIVATE", { cause: original }) });
  const result = preserveWorkerFailure(nested, worker);
  assert.match(result.message, /raw-upload\.status/u);
  assert.match(result.message, /"phase":"raw-upload"/u);
  assert.match(result.message, /"expected":"File saved"/u);
  assert.match(result.message, /"actual":"Processing the captured file…"/u);
  assert.match(result.message, /"basename":"raw-file-browser\.mjs","line":597/u);
  assert.ok(result.cause && !(result.cause instanceof Error));
  assert.equal(result.cause.chain.at(-1).name, "AssertionError");
  assert.doesNotMatch(exposed(result), /SECRET|PRIVATE|C:\\private/u);
});

test("S02: no Worker at early failure still returns only redacted diagnostics", () => {
  const result = preserveWorkerFailure(new Error("Cookie: SECRET; private document"));
  assert.notEqual(result.message, "Cookie: SECRET; private document");
  assert.doesNotMatch(exposed(result), /SECRET|private document/u);
  assert.match(result.message, /owner-e2e failed/u);
});

test("S02: opaque, oversized, token-bearing and partial-match values are redacted", () => {
  for (const value of ["Authorization: Bearer SECRET", "Cookie: SECRET", "https://private.invalid?token=SECRET",
    "File uploaded. SECRET", "x".repeat(100_000)]) {
    const original = new assert.AssertionError({ actual: value, expected: "SECRET", operator: "strictEqual", message: "SECRET" });
    annotateBrowserAssertion(original, "raw-upload.status", value, "SECRET");
    const result = preserveWorkerFailure(original, worker);
    assert.match(result.message, /REDACTED_UNREGISTERED_VALUE/u);
    assert.doesNotMatch(exposed(result), /SECRET|private\.invalid|xxxxxxxxxx/u);
    assert.ok(exposed(result).length < 12000);
  }
});

test("S02: unregistered assertions explain redaction without inventing identity", () => {
  const original = new assert.AssertionError({ actual: "SECRET", expected: "SECRET2", operator: "strictEqual" });
  annotateBrowserAssertion(original, "unknown.assertion", "SECRET", "SECRET2");
  assert.equal(browserAssertionDiagnostic(original), undefined);
  const result = preserveWorkerFailure(original, worker);
  assert.match(result.message, /REDACTED_UNREGISTERED_ASSERTION/u);
  assert.doesNotMatch(exposed(result), /SECRET|unknown\.assertion/u);
});

test("S02: cyclic/aggregate/deep causes are bounded and metadata cannot be forged", () => {
  const original = statusFailure();
  const cyclic = new AggregateError([original, original], "SECRET");
  cyclic.cause = cyclic;
  assert.equal(diagnosticErrorChain(cyclic).length, 2);
  assert.equal(browserAssertionDiagnostic(cyclic).id, "raw-upload.status");
  const result = preserveWorkerFailure(cyclic, worker);
  assert.ok(result.cause.chain.length <= 8);
  assert.doesNotMatch(exposed(result), /SECRET/u);
  const forged = new Error("SECRET");
  forged.assertion_diagnostic = { id: "raw-upload.status", actual: "SECRET" };
  assert.equal(browserAssertionDiagnostic(forged), undefined);
  let deep = original;
  for (let index = 0; index < 20; index += 1) deep = new Error("SECRET", { cause: deep });
  assert.equal(diagnosticErrorChain(deep).length, 6);
  assert.equal(browserAssertionDiagnostic(deep), undefined);
});

test("S02: throwing getters/proxies cannot leak or replace the original failure", () => {
  let getterCalls = 0;
  const foreign = {};
  for (const key of ["cause", "name", "code", "stack", "errors", "original_error", "ownerD1Provenance"]) {
    Object.defineProperty(foreign, key, { get() { getterCalls += 1; throw new Error("SECRET"); } });
  }
  const result = preserveWorkerFailure(foreign, worker);
  assert.equal(getterCalls, 0);
  assert.doesNotMatch(exposed(result), /SECRET/u);
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("SECRET"); } });
  assert.doesNotThrow(() => preserveWorkerFailure(proxy, worker));
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.doesNotThrow(() => preserveWorkerFailure({ errors: revoked.proxy }, worker));
});

test("S02: a failing registered assertion remains a rejection and executes cleanup", async () => {
  let cleaned = false;
  await assert.rejects(async () => {
    try { throw preserveWorkerFailure(statusFailure(), worker); }
    finally { cleaned = true; }
  }, /raw-upload\.status/u);
  assert.equal(cleaned, true);
});


function rawProcessingFixture(state = "COMMITTED") {
  const expected = { bytes: Buffer.from("# Recorded raw owner fixture\n"), type: "text/plain" };
  expected.digest = createHash("sha256").update(expected.bytes).digest("hex");
  const captureId = `raw-capture-${"a".repeat(48)}`;
  const conversionKey = `raw-markdown-${createHash("sha256").update(`raw-markdown-ui-v1\0${captureId}\0${expected.digest}\0text/plain`).digest("hex")}`;
  const operationId = createHash("sha256").update(JSON.stringify(["eliotr.raw-markdown-conversion.v1", "e2e-owner", captureId, conversionKey])).digest("hex");
  const admissionKey = `raw-admission-${createHash("sha256").update(`raw-normalized-admission-ui-v1\0${captureId}\0${operationId}`).digest("hex")}`;
  const conversion = { protocol: "eliotr.raw-markdown-conversion.v1", state: "COMPLETE", operation_id: operationId,
    capture_id: captureId, content_sha256: expected.digest, output_sha256: expected.digest,
    output_bytes: expected.bytes.length, detected_mime: "text/plain", format: "markdown", tokens: Math.ceil(expected.bytes.length / 4) };
  const admission = { protocol: "eliotr.raw-normalized-admission.v1", state, capture_id: captureId,
    conversion_operation_id: operationId, admission_operation_id: "b".repeat(64),
    candidate_ref: `raw-normalized-candidate:${"c".repeat(64)}`, source_view_ref: `snapshot-view:v1:${"d".repeat(64)}`,
    source_revision_ref: "raw-revision-fixture", conversion_state: "COMPLETE",
    reason_codes: state === "QUARANTINED" ? ["QUALITY_BELOW_POLICY_MINIMUM"] : [],
    admission_receipt: { decision: state === "COMMITTED" ? "ADMITTED" : state, source_revision_ref: "raw-revision-fixture" } };
  const snapshot = (path, data, body) => ({ status: 200, responsePath: path, payload: { trace_id: "trace-fixture",
    deployment_generation: "generation-fixture", data }, requestBody: JSON.stringify(body) });
  return { expected, captureId, expectedGeneration: "generation-fixture", expectedAdmissionState: state,
    snapshots: {
      conversion: snapshot(`/api/v1/ingest/raw/${captureId}/markdown`, conversion,
        { idempotency_key: conversionKey, max_output_bytes: 8 * 1024 * 1024, max_tokens: 1_000_000,
          timeout_ms: 300_000, conversion_options: { output: { format: "markdown" } } }),
      admission: snapshot(`/api/v1/ingest/raw/${captureId}/admission`, admission,
        { conversion_operation_id: operationId, idempotency_key: admissionKey }),
    } };
}

test("S03 actual automatic snapshots retain exact text, identities and terminal admission", () => {
  const input = rawProcessingFixture();
  const result = rawBrowser.assertRawProcessingSnapshots(input);
  assert.equal(result.conversionOperationId, input.snapshots.conversion.payload.data.operation_id);
  assert.equal(result.admissionOperationId, input.snapshots.admission.payload.data.admission_operation_id);
  assert.deepEqual(result.conversion, input.snapshots.conversion.payload.data);
  const replay = rawProcessingFixture();
  replay.snapshots.admission.payload.data.admission_receipt.decision = "DUPLICATE";
  assert.equal(rawBrowser.assertRawProcessingSnapshots(replay).admissionOperationId, result.admissionOperationId);
});

test("S03 never accepts only capture/conversion or an uncommitted admission as import success", () => {
  for (const state of ["UNKNOWN", "PREPARING", "REJECTED", "QUARANTINED"]) {
    const input = rawProcessingFixture(state); input.expectedAdmissionState = "COMMITTED";
    assert.throws(() => rawBrowser.assertRawProcessingSnapshots(input), { code: "ERR_ASSERTION" });
  }
  const input = rawProcessingFixture(); delete input.snapshots.admission;
  assert.throws(() => rawBrowser.assertRawProcessingSnapshots(input), { code: "ERR_ASSERTION" });
});

test("S03 rejects substituted capture, conversion, request and deployment identities", () => {
  const mutations = [
    (x) => { x.snapshots.conversion.responsePath = `/api/v1/ingest/raw/foreign/markdown`; },
    (x) => { x.snapshots.conversion.payload.data.capture_id = "foreign"; },
    (x) => { x.snapshots.conversion.payload.data.operation_id = "e".repeat(64); },
    (x) => { x.snapshots.admission.payload.deployment_generation = "foreign"; },
    (x) => { x.snapshots.admission.payload.data.conversion_operation_id = "e".repeat(64); },
    (x) => { x.snapshots.admission.requestBody = JSON.stringify({ conversion_operation_id: "e".repeat(64), idempotency_key: "other" }); },
    (x) => { x.snapshots.admission.payload.data.admission_receipt.source_revision_ref = "foreign"; },
  ];
  for (const mutate of mutations) { const input = rawProcessingFixture(); mutate(input);
    assert.throws(() => rawBrowser.assertRawProcessingSnapshots(input), { code: "ERR_ASSERTION" }); }
});

test("S03 pass-through conversion checks bytes, profile and observed token estimate", () => {
  for (const [key, value] of [["output_sha256", "f".repeat(64)], ["output_bytes", 1], ["tokens", 100], ["format", "text"]]) {
    const input = rawProcessingFixture(); input.snapshots.conversion.payload.data[key] = value;
    assert.throws(() => rawBrowser.assertRawProcessingSnapshots(input), { code: "ERR_ASSERTION" });
  }
  const input = rawProcessingFixture();
  const body = JSON.parse(input.snapshots.conversion.requestBody); body.max_tokens = 0;
  input.snapshots.conversion.requestBody = JSON.stringify(body);
  assert.throws(() => rawBrowser.assertRawProcessingSnapshots(input), { code: "ERR_ASSERTION" });
});

test("S03 a quality-policy refusal is explicit and cannot share success acceptance", () => {
  const input = rawProcessingFixture("QUARANTINED");
  const result = rawBrowser.assertRawProcessingSnapshots(input);
  assert.equal(result.admission.state, "QUARANTINED");
  input.snapshots.admission.payload.data.reason_codes = [];
  assert.throws(() => rawBrowser.assertRawProcessingSnapshots(input), { code: "ERR_ASSERTION" });
});


test("S03 pipeline diagnostics retain only closed stages/statuses and reject arbitrary payloads", async () => {
  const { annotateRawPipelineFailure, browserAssertionDiagnostic } = await import("./assertion-diagnostic.mjs");
  const error = new Error("SECRET");
  annotateRawPipelineFailure(error, { capture: { phase: "complete", status: 200, outcome: "CAPTURED" },
    conversion: { phase: "complete", status: 409, outcome: "FAILED", code: "IDEMPOTENCY_CONFLICT" },
    admission: { phase: "SECRET", status: "SECRET", outcome: "SECRET", code: "SECRET", body: "SECRET" } });
  const value = browserAssertionDiagnostic(error);
  assert.equal(value.id, "raw-pipeline.responses");
  assert.deepEqual(value.responses[1], { operation: "conversion", phase: "complete", status: 409,
    outcome: "FAILED", code: "IDEMPOTENCY_CONFLICT" });
  assert.doesNotMatch(JSON.stringify(value), /SECRET/u);
  let calls = 0;
  const foreign = Object.defineProperty({}, "capture", { get() { calls++; throw new Error("SECRET"); } });
  annotateRawPipelineFailure(error, foreign); assert.equal(calls, 0);
  assert.equal(browserAssertionDiagnostic(error).responses.every((row) => row.status === null), true);
});

test("S03 console diagnosis does not weaken the authenticated rejection", async () => {
  const { assertAuthedLedger } = await import("./owner-e2e.mjs");
  const origin = "http://127.0.0.1:4321";
  const consoleErrors = [
    `Failed to load resource: the server responded with a status of 403 (Forbidden) @${origin}/__local/pair`,
    `Failed to load resource: net::ERR_CONNECTION_REFUSED @${origin}/api/v1/research/catalog?limit=20`,
  ];
  let failure;
  try { assertAuthedLedger({ consoleErrors, pageErrors: [], failedRequests: [] }, "authed", origin); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof assert.AssertionError);
  const diagnostic = browserAssertionDiagnostic(failure);
  assert.equal(diagnostic?.id, "authed.console");
  assert.equal(diagnostic?.count, 2);
  assert.deepEqual(diagnostic.entries, [
    { route: "pair", status: 403, transport: null, template: "http-status" },
    { route: "catalog", status: null, transport: "ERR_CONNECTION_REFUSED", template: "network-error" },
  ]);
});

test("S03 console diagnosis redacts private values and bounds hostile input", async () => {
  const { annotateAuthedConsoleFailure } = await import("./assertion-diagnostic.mjs");
  const error = new Error("SECRET");
  const origin = "http://127.0.0.1:4321";
  const values = [
    `Failed to load resource: the server responded with a status of 409 (Conflict) @${origin}/api/v1/ingest/raw/raw-capture-${"a".repeat(48)}/admission?token=SECRET`,
    "Authorization: Bearer SECRET",
    "Failed to load resource: net::ERR_ABORTED @https://private.invalid/SECRET",
    "x".repeat(10000),
    ...Array.from({ length: 20 }, () => "Cookie: SECRET"),
  ];
  annotateAuthedConsoleFailure(error, values, origin);
  const diagnostic = browserAssertionDiagnostic(error);
  assert.equal(diagnostic.count, 24);
  assert.equal(diagnostic.entries.length, 8);
  assert.deepEqual(diagnostic.entries[0], { route: "raw-admission", status: 409, transport: null, template: "http-status" });
  assert.doesNotMatch(exposed(preserveWorkerFailure(error, worker)), /SECRET|private\.invalid|xxxxxxx/u);
  let getters = 0;
  const foreign = { get length() { getters += 1; throw new Error("SECRET"); } };
  annotateAuthedConsoleFailure(error, foreign, origin);
  assert.equal(getters, 0);
  assert.equal(browserAssertionDiagnostic(error).count, null);
});


test("S03 console diagnosis identifies closed UI routes and browser policy templates", async () => {
  const { annotateAuthedConsoleFailure } = await import("./assertion-diagnostic.mjs");
  const origin = "http://127.0.0.1:4321";
  const error = new Error("SECRET");
  const paths = [
    ["/api/v1/system/research-configuration", "configuration"],
    ["/api/v1/research/changes", "changes"],
    ["/api/v1/research/wiki/proposals", "wiki-proposals"],
    ["/api/v1/research/projects", "projects"],
    ["/api/v1/library/readiness", "readiness"],
    ["/api/v1/library/namespaces", "namespaces"],
  ];
  for (const [path, route] of paths) {
    annotateAuthedConsoleFailure(error, [
      `Failed to load resource: the server responded with a status of 503 (Service Unavailable) @${origin}${path}?private=SECRET`,
    ], origin);
    const entry = browserAssertionDiagnostic(error).entries[0];
    assert.equal(entry.route, route);
    assert.equal(entry.status, 503);
    assert.equal(entry.template, "http-status");
  }
  annotateAuthedConsoleFailure(error, [
    `Executing inline script violates the following Content Security Policy directive: SECRET @${origin}/`,
    `The Content Security Policy directive 'frame-ancestors' is ignored SECRET @${origin}/__local/`,
    `Error while trying to use the following icon from the Manifest: SECRET @${origin}/`,
    `Arbitrary SECRET @${origin}/private/SECRET`,
  ], origin);
  assert.deepEqual(browserAssertionDiagnostic(error).entries.map(({ route, template }) => ({ route, template })), [
    { route: "shell-document", template: "csp-inline-script" },
    { route: "pairing", template: "csp-meta-frame-ancestors" },
    { route: "shell-document", template: "manifest-icon" },
    { route: "unregistered", template: "unregistered" },
  ]);
  assert.doesNotMatch(exposed(preserveWorkerFailure(error, worker)), /SECRET|private=/u);
});


test("S03 network diagnostics preserve closed categories without private response data", async () => {
  const { annotatePhaseNetworkFailure } = await import("./assertion-diagnostic.mjs");
  const origin = "http://127.0.0.1:4321";
  const error = new Error("Authorization: Bearer SECRET");
  annotatePhaseNetworkFailure(error, { origin, path: "/api/v1/research/changes?token=SECRET",
    method: "POST", status: 503, body: "SECRET" }, new Set([200]), origin);
  assert.deepEqual(browserAssertionDiagnostic(error), { id: "phase.application-response", phase: "network-closure",
    route: "changes", method: "POST", status: 503, expected_statuses: [200], reason: "STATUS_DRIFT" });
  assert.doesNotMatch(exposed(preserveWorkerFailure(error, worker)), /SECRET|token=|127\.0\.0\.1/u);
  let getters = 0;
  annotatePhaseNetworkFailure(error, { get path() { getters++; throw new Error("SECRET"); } }, null, origin);
  assert.equal(getters, 0);
  assert.equal(browserAssertionDiagnostic(error).route, "unregistered");
});
