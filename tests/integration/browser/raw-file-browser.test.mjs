import assert from "node:assert/strict";
import { test } from "node:test";
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

function batchCaptureFixture() {
  const priorWindow = globalThis.window;
  const priorLocation = globalThis.location;
  const priorBtoa = globalThis.btoa;
  const pageWindow = {};
  const waiters = [];
  const responseFor = (path, method, body) => {
    const response = new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const responseUrl = `http://127.0.0.1:4321${path}`;
    Object.defineProperty(response, "url", { configurable: true, value: responseUrl });
    const requestBody = method === "POST" ? JSON.stringify({ product: "FAST_SEARCH", query: "fixture" }) : undefined;
    const request = { method: () => method, allHeaders: async () => ({ accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }), postData: () => requestBody };
    return { pageResponse: response, browserResponse: { status: () => response.status, url: () => responseUrl, request: () => request } };
  };
  const responses = new Map([
    ["POST /orient", responseFor("/orient", "POST", { data: { protocol: "orient.fixture" } })],
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
