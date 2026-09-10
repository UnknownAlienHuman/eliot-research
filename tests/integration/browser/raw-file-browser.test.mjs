import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForRawResponse } from "./raw-file-browser.mjs";
/* global Buffer:readonly, Response:readonly, setTimeout:readonly */

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
