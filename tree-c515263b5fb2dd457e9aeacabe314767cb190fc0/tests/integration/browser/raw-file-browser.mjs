import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveLocalBrowserExecutable } from "../../../scripts/lib/local-launch.mjs";
/* global URL:readonly, Buffer:readonly, btoa:readonly, document:readonly, window:readonly, Event:readonly, MutationObserver:readonly,
  Request:readonly, TextDecoder:readonly, location:readonly, process:readonly, console:readonly */

const root = resolve(import.meta.dirname, "../../..");
const dist = resolve(root, "apps/eliotr-pwa/dist");
const generation = "browser-fixture";
const trace = "raw-file-browser";
const envelope = (data, deploymentGeneration = generation) => ({ data, trace_id: trace, deployment_generation: deploymentGeneration });
const SAFE_NETWORK_FAILURES = new Set(["net::ERR_ABORTED", "net::ERR_CONNECTION_CLOSED", "net::ERR_CONNECTION_RESET", "net::ERR_CONTENT_LENGTH_MISMATCH", "net::ERR_FAILED", "net::ERR_INCOMPLETE_CHUNKED_ENCODING", "net::ERR_NETWORK_CHANGED"]);
function rawResponsePhase(method, path) {
  if (path.endsWith("/markdown")) return "conversion";
  if (path.endsWith("/admission")) return "admission";
  if (/\/admission\/[^/]+$/u.test(path)) return "status";
  return "capture";
}
function rawBodyErrorKind(error) {
  const message = String(error?.message ?? "");
  if (/No resource with given identifier/iu.test(message)) return "NoResource";
  if (/Response body is unavailable/iu.test(message)) return "BodyUnavailable";
  if (/ERR_ABORTED|\baborted\b/iu.test(message)) return "RequestAborted";
  if (/Target (?:page|closed)|browser has been closed|context has been closed/iu.test(message)) return "TargetClosed";
  return "Other";
}
function rawBodyDiagnostic(page, response, method, path, status, error) {
  const request = response.request();
  let requestMethod = method;
  try { requestMethod = request.method(); } catch { /* Bounded diagnostic only. */ }
  let networkFailure = "unavailable";
  try { const value = request.failure()?.errorText; if (SAFE_NETWORK_FAILURES.has(value)) networkFailure = value; } catch { /* Bounded diagnostic only. */ }
  let serviceWorker = false;
  try { serviceWorker = typeof response.fromServiceWorker === "function" && response.fromServiceWorker(); } catch { /* Bounded diagnostic only. */ }
  let frameDetached = false;
  try { const frame = request.frame(); frameDetached = typeof frame?.isDetached === "function" && frame.isDetached(); } catch { /* Bounded diagnostic only. */ }
  let pageClosed = false;
  try { pageClosed = typeof page.isClosed === "function" && page.isClosed(); } catch { /* Bounded diagnostic only. */ }
  return `method=${requestMethod} phase=${rawResponsePhase(method, path)} status=${status} service_worker=${serviceWorker} network_failure=${networkFailure} body_error=${rawBodyErrorKind(error)} page_closed=${pageClosed} frame_detached=${frameDetached}`;
}

async function beginRawAdmissionDiagnostic(page, path) {
  if (!path.endsWith("/admission")) return false;
  await page.evaluate(() => {
    const old = window.__eliotrRawAdmissionDiagnostic;
    old?.dispose?.();
    const events = [];
    const allowedCodes = new Set(["API_REQUEST_ABORTED", "API_UNREACHABLE", "API_RESPONSE_SCHEMA_MISMATCH", "API_RESPONSE_TOO_LARGE", "MALFORMED_JSON_RESPONSE", "API_STATUS_INVALID", "API_GENERATION_MISMATCH", "RAW_ADMISSION_RESPONSE_INVALID", "RAW_ADMISSION_OUTCOME_UNKNOWN", "RAW_NORMALIZED_OUTCOME_UNKNOWN"]);
    let lastMilestone = "";
    const milestone = () => {
      const panel = document.querySelector("#raw-upload");
      const status = panel?.querySelector("[data-raw-status]")?.textContent?.trim() ?? "";
      const match = status.match(/\b[A-Z][A-Z0-9_]{2,63}\b/gu)?.find((code) => allowedCodes.has(code));
      const value = match === "API_REQUEST_ABORTED" ? "ui:API_REQUEST_ABORTED"
        : match ? `ui:${match}`
          : /Added to Library/iu.test(status) ? "ui:COMPLETED"
            : /Adding the processed file/iu.test(status) ? "ui:STARTED" : "";
      if (value && value !== lastMilestone && events.length < 24) { events.push(value); lastMilestone = value; }
    };
    const record = (value) => { if (events.length < 24) events.push(value); };
    const targets = [[window, "eliotr:authorization-cleared", "lifecycle:authorization-cleared"],
      [window, "offline", "lifecycle:offline"], [window, "pagehide", "lifecycle:pagehide"],
      [document.querySelector("#app"), "eliotr:health-lost", "lifecycle:health-lost"]];
    const listeners = [];
    for (const [target, type, value] of targets) if (target) {
      const listener = () => record(value);
      target.addEventListener(type, listener); listeners.push([target, type, listener]);
    }
    const panel = document.querySelector("#raw-upload");
    const observer = panel ? new MutationObserver(milestone) : undefined;
    observer?.observe(panel, { subtree: true, childList: true, characterData: true, attributes: true });
    milestone();
    window.__eliotrRawAdmissionDiagnostic = { events, dispose: () => { observer?.disconnect(); for (const [target, type, listener] of listeners) target.removeEventListener(type, listener); } };
  });
  return true;
}

async function finishRawAdmissionDiagnostic(page) {
  try {
    return await page.evaluate(() => {
      const diagnostic = window.__eliotrRawAdmissionDiagnostic;
      const panel = document.querySelector("#raw-upload");
      const status = panel?.querySelector("[data-raw-status]")?.textContent?.trim() ?? "";
      const allowedCodes = new Set(["API_REQUEST_ABORTED", "API_UNREACHABLE", "API_RESPONSE_SCHEMA_MISMATCH", "API_RESPONSE_TOO_LARGE", "MALFORMED_JSON_RESPONSE", "API_STATUS_INVALID", "API_GENERATION_MISMATCH", "RAW_ADMISSION_RESPONSE_INVALID", "RAW_ADMISSION_OUTCOME_UNKNOWN", "RAW_NORMALIZED_OUTCOME_UNKNOWN"]);
      const match = status.match(/\b[A-Z][A-Z0-9_]{2,63}\b/gu)?.find((code) => allowedCodes.has(code));
      const uiCode = match ?? (/Added to Library/iu.test(status) ? "COMPLETED" : "unavailable");
      const events = Array.isArray(diagnostic?.events) ? diagnostic.events.slice(0, 24) : [];
      diagnostic?.dispose?.(); delete window.__eliotrRawAdmissionDiagnostic;
      return { ui_code: uiCode, events };
    });
  } catch { return { ui_code: "unavailable", events: [] }; }
}

function rawResponseTransportDiagnostic(response) {
  const headers = response.headers();
  const timing = response.request().timing();
  const finite = (value) => Number.isFinite(value) ? Math.round(value) : undefined;
  return {
    content_type: headers["content-type"] ?? "unavailable",
    content_length: headers["content-length"] ?? "unavailable",
    request_start_ms: finite(timing.requestStart), response_start_ms: finite(timing.responseStart), response_end_ms: finite(timing.responseEnd),
  };
}

async function beginRawResponseCapture(page, method, path, expectedStatus) {
  if (typeof page.evaluate !== "function") return false;
  await page.evaluate(({ method: expectedMethod, path: expectedPath, expectedStatus: status }) => {
    if (window.__eliotrRawResponseCapture !== undefined) throw new Error("duplicate raw response capture");
    const originalFetch = window.fetch;
    const state = { phase: "waiting", status: undefined, bodyBase64: undefined, errorCode: undefined };
    let matched = false;
    let disposed = false;
    let activeReader;
    const captureLimit = 512 * 1024;
    const cancelReader = (reader) => {
      if (reader === undefined || typeof reader.cancel !== "function") return;
      try {
        const pending = reader.cancel();
        pending?.catch?.(() => {});
      } catch { /* cancellation cannot delay capture failure or disposal */ }
    };
    const captureBody = async (clone) => {
      let reader;
      try {
        reader = clone?.body?.getReader?.();
        if (reader === undefined || typeof reader.read !== "function") throw new Error("body stream unavailable");
        activeReader = reader;
        const chunks = [];
        let totalBytes = 0;
        for (;;) {
          if (disposed) {
            cancelReader(reader);
            return;
          }
          const part = await reader.read();
          if (disposed) {
            cancelReader(reader);
            return;
          }
          if (part?.done === true) break;
          const value = part?.value;
          if (value === undefined || value === null || typeof value.byteLength !== "number") throw new Error("invalid body chunk");
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (totalBytes + chunk.byteLength > captureLimit) {
            cancelReader(reader);
            throw new Error("overflow");
          }
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
        }
        activeReader = undefined;
        if (disposed) return;
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        if (disposed) return;
        const bodyText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        JSON.parse(bodyText);
        if (disposed) return;
        let binary = "";
        for (let chunkOffset = 0; chunkOffset < bytes.byteLength; chunkOffset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(chunkOffset, Math.min(chunkOffset + 0x8000, bytes.byteLength)));
        }
        if (disposed) return;
        state.bodyBase64 = btoa(binary);
        state.phase = "complete";
      } catch {
        activeReader = undefined;
        if (!disposed) { state.phase = "error"; state.errorCode = "BODY_CAPTURE_FAILED"; }
      }
    };
    const wrappedFetch = function (...args) {
      if (disposed) return Reflect.apply(originalFetch, this, args);
      let requestUrl;
      let requestMethod;
      try {
        const [input, init] = args;
        requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
        requestMethod = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      } catch {
        return Reflect.apply(originalFetch, this, args);
      }
      const matches = requestMethod === expectedMethod && requestUrl.origin === location.origin &&
        requestUrl.pathname === expectedPath && requestUrl.search === "";
      if (!matches) return Reflect.apply(originalFetch, this, args);
      if (matched) {
        if (!disposed) {
          state.phase = "error";
          state.errorCode = "DUPLICATE_RAW_RESPONSE";
        }
        return Reflect.apply(originalFetch, this, args);
      }
      matched = true;
      let responsePromise;
      try { responsePromise = Reflect.apply(originalFetch, this, args); }
      catch (error) {
        if (!disposed) { state.phase = "error"; state.errorCode = "FETCH_FAILED"; }
        throw error;
      }
      return Promise.resolve(responsePromise).then((response) => {
        if (disposed) return response;
        state.status = response.status;
        let responseUrl;
        try { responseUrl = new URL(response.url, location.href); } catch { responseUrl = undefined; }
        if (response.redirected || response.type === "opaqueredirect" || responseUrl === undefined ||
            responseUrl.origin !== location.origin || responseUrl.pathname !== expectedPath || responseUrl.search !== "") {
          if (!disposed) { state.phase = "error"; state.errorCode = "RESPONSE_IDENTITY_MISMATCH"; }
          return response;
        }
        state.phase = "reading";
        let clone;
        try { clone = response.clone(); }
        catch { state.phase = "error"; state.errorCode = "CLONE_FAILED"; return response; }
        void captureBody(clone);
        if (!disposed && response.status !== status) state.errorCode = "STATUS_MISMATCH";
        return response;
      }, (error) => {
        if (!disposed) { state.phase = "error"; state.errorCode = "FETCH_FAILED"; }
        throw error;
      });
    };
    window.fetch = wrappedFetch;
    window.__eliotrRawResponseCapture = {
      state,
      dispose: () => {
        disposed = true;
        const reader = activeReader;
        activeReader = undefined;
        if (window.fetch === wrappedFetch) window.fetch = originalFetch;
        state.bodyBase64 = undefined;
        delete window.__eliotrRawResponseCapture;
        cancelReader(reader);
      },
    };
  }, { method, path, expectedStatus });
  return true;
}

async function readRawResponseCapture(page, method, path, expectedStatus) {
  if (typeof page.waitForFunction !== "function") throw new Error("raw response capture requires a browser page");
  const handle = await page.waitForFunction(({ method: expectedMethod, path: expectedPath, expectedStatus: status }) => {
    const capture = window.__eliotrRawResponseCapture?.state;
    if (!capture || !["complete", "error"].includes(capture.phase)) return false;
    return { method: expectedMethod, path: expectedPath, expectedStatus: status, ...capture };
  }, { method, path, expectedStatus }, { timeout: 30000 });
  const captured = await handle.jsonValue();
  await handle.dispose?.();
  if (captured.errorCode !== undefined) throw new Error(`raw response clone capture rejected (${captured.errorCode})`);
  if (captured.status !== expectedStatus) throw new Error(`raw response clone status mismatch (expected=${expectedStatus} actual=${captured.status})`);
  if (typeof captured.bodyBase64 !== "string") throw new Error("raw response clone body missing");
  return Buffer.from(captured.bodyBase64, "base64");
}

async function finishRawResponseCapture(page) {
  if (typeof page.evaluate !== "function") return;
  try { await page.evaluate(() => window.__eliotrRawResponseCapture?.dispose?.()); }
  catch { /* The page may have closed; the original response failure remains primary. */ }
}

function rawResponseTargetPath(target) {
  if (typeof target.path === "string" && target.path.startsWith("/")) return target.path;
  if (typeof target.pathPattern === "string" && target.pathPattern.length > 0 && target.pathPattern.length <= 160) return target.pathPattern;
  throw new TypeError("raw response target requires a bounded path or path pattern");
}

async function beginRawResponseBatchCapture(page, targets) {
  if (typeof page.evaluate !== "function") return false;
  await page.evaluate((expectedTargets) => {
    if (window.__eliotrRawResponseBatchCapture !== undefined) throw new Error("duplicate raw response batch capture");
    const originalFetch = window.fetch;
    const states = Object.fromEntries(expectedTargets.map((target) => [target.key, {
      phase: "waiting", status: undefined, responsePath: undefined, bodyBase64: undefined, errorCode: undefined,
    }]));
    const specs = expectedTargets.map((target) => {
      const expected = target.path === undefined ? undefined : new URL(target.path, location.href);
      return { ...target, origin: location.origin, pathname: expected?.pathname, search: expected?.search ?? "" };
    });
    const matched = new Set();
    const activeReaders = new Set();
    const captureLimit = 512 * 1024;
    const cancelReader = (reader) => {
      if (reader === undefined || typeof reader.cancel !== "function") return;
      try { reader.cancel()?.catch?.(() => {}); } catch { /* bounded cleanup */ }
    };
    let disposed = false;
    const captureBody = async (key, clone) => {
      let reader;
      try {
        reader = clone?.body?.getReader?.();
        if (reader === undefined || typeof reader.read !== "function") throw new Error("body stream unavailable");
        activeReaders.add(reader);
        const chunks = [];
        let totalBytes = 0;
        for (;;) {
          if (disposed) { cancelReader(reader); return; }
          const part = await reader.read();
          if (disposed) { cancelReader(reader); return; }
          if (part?.done === true) break;
          const value = part?.value;
          if (value === undefined || value === null || typeof value.byteLength !== "number") throw new Error("invalid body chunk");
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (totalBytes + chunk.byteLength > captureLimit) throw new Error("overflow");
          chunks.push(chunk); totalBytes += chunk.byteLength;
        }
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        JSON.parse(text);
        let binary = "";
        for (let chunkOffset = 0; chunkOffset < bytes.byteLength; chunkOffset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(chunkOffset, Math.min(chunkOffset + 0x8000, bytes.byteLength)));
        }
        if (!disposed && states[key].phase !== "error") { states[key].bodyBase64 = btoa(binary); states[key].phase = "complete"; }
      } catch {
        cancelReader(reader);
        if (!disposed) { states[key].phase = "error"; states[key].errorCode = "BODY_CAPTURE_FAILED"; }
      } finally { if (reader !== undefined) activeReaders.delete(reader); }
    };
    const wrappedFetch = function (...args) {
      if (disposed) return Reflect.apply(originalFetch, this, args);
      let requestUrl;
      let requestMethod;
      try {
        const [input, init] = args;
        requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
        requestMethod = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      } catch { return Reflect.apply(originalFetch, this, args); }
      const spec = specs.find((candidate) => {
        if (candidate.method !== requestMethod || candidate.origin !== requestUrl.origin) return false;
        if (candidate.pathPattern !== undefined) return requestUrl.search === "" && new RegExp(candidate.pathPattern, "u").test(requestUrl.pathname);
        return candidate.pathname === requestUrl.pathname && candidate.search === requestUrl.search;
      });
      if (spec === undefined) return Reflect.apply(originalFetch, this, args);
      if (matched.has(spec.key)) {
        states[spec.key].phase = "error"; states[spec.key].errorCode = "DUPLICATE_REQUEST";
        return Reflect.apply(originalFetch, this, args);
      }
      matched.add(spec.key);
      const responsePromise = Reflect.apply(originalFetch, this, args);
      return Promise.resolve(responsePromise).then((response) => {
        if (disposed) return response;
        states[spec.key].status = response.status;
        let responseUrl;
        try { responseUrl = new URL(response.url, location.href); } catch { responseUrl = undefined; }
        const identityMatches = responseUrl !== undefined && responseUrl.origin === spec.origin &&
          (spec.pathPattern === undefined ? responseUrl.pathname === spec.pathname && responseUrl.search === spec.search
            : responseUrl.search === "" && new RegExp(spec.pathPattern, "u").test(responseUrl.pathname));
        if (response.redirected || response.type === "opaqueredirect" || !identityMatches) {
          states[spec.key].phase = "error"; states[spec.key].errorCode = "RESPONSE_IDENTITY_MISMATCH"; return response;
        }
        states[spec.key].responsePath = `${responseUrl.pathname}${responseUrl.search}`;
        let clone;
        try { clone = response.clone(); } catch { states[spec.key].phase = "error"; states[spec.key].errorCode = "CLONE_FAILED"; return response; }
        states[spec.key].phase = "reading";
        void captureBody(spec.key, clone);
        return response;
      }, () => { states[spec.key].phase = "error"; states[spec.key].errorCode = "FETCH_FAILED"; throw new Error("raw response fetch failed"); });
    };
    window.fetch = wrappedFetch;
    window.__eliotrRawResponseBatchCapture = {
      states,
      dispose: () => {
        disposed = true;
        for (const reader of activeReaders) cancelReader(reader);
        if (window.fetch === wrappedFetch) window.fetch = originalFetch;
        delete window.__eliotrRawResponseBatchCapture;
      },
    };
  }, targets);
  return true;
}

async function readRawResponseBatchCapture(page, targets) {
  if (typeof page.waitForFunction !== "function") throw new Error("raw response batch capture requires a browser page");
  const keys = targets.map((target) => target.key);
  const handle = await page.waitForFunction((expectedKeys) => {
    const states = window.__eliotrRawResponseBatchCapture?.states;
    if (!states || expectedKeys.some((key) => !states[key] || !["complete", "error"].includes(states[key].phase))) return false;
    return expectedKeys.map((key) => ({ key, ...states[key] }));
  }, keys, { timeout: 30000 });
  const captured = await handle.jsonValue();
  await handle.dispose?.();
  const result = {};
  for (const state of captured) {
    if (state.errorCode !== undefined) throw new Error(`raw response clone capture rejected (${state.key}:${state.errorCode})`);
    if (typeof state.bodyBase64 !== "string") throw new Error(`raw response clone body missing (${state.key})`);
    result[state.key] = state;
  }
  return result;
}

async function finishRawResponseBatchCapture(page) {
  if (typeof page.evaluate !== "function") return;
  try { await page.evaluate(() => window.__eliotrRawResponseBatchCapture?.dispose?.()); }
  catch { /* Preserve the original response failure. */ }
}

/** Capture several same-page JSON responses from one UI action before navigation can discard them. */
export async function waitForRawResponses(page, targets, action) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 4) throw new TypeError("raw response batch must contain 1 to 4 targets");
  const keys = new Set();
  for (const target of targets) {
    const hasPath = typeof target?.path === "string";
    const hasPathPattern = typeof target?.pathPattern === "string";
    if (!target || typeof target.key !== "string" || keys.has(target.key) || !/^[A-Za-z0-9_.:-]{1,64}$/u.test(target.key) ||
        hasPath === hasPathPattern ||
        !["GET", "POST", "PUT", "DELETE", "HEAD"].includes(target.method) || !Number.isSafeInteger(target.expectedStatus)) {
      throw new TypeError("raw response batch target is invalid");
    }
    if (hasPathPattern) {
      try { new RegExp(target.pathPattern, "u"); } catch (error) { throw new TypeError("raw response batch target pattern is invalid", { cause: error }); }
    }
    keys.add(target.key);
    rawResponseTargetPath(target);
  }
  const browserCapture = await beginRawResponseBatchCapture(page, targets);
  try {
    const expectedOrigin = (() => { try { return new URL(page.url()).origin; } catch { return undefined; } })();
    const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : undefined;
    const responsePromises = targets.map((target) => page.waitForResponse((response) => {
      try {
        const request = response.request();
        const responseUrl = new URL(response.url());
        if (expectedOrigin !== undefined && responseUrl.origin !== expectedOrigin) return false;
        if (mainFrame !== undefined && typeof request.frame === "function" && request.frame() !== mainFrame) return false;
        if (request.method() !== target.method) return false;
        if (target.pathPattern !== undefined) return responseUrl.search === "" && new RegExp(target.pathPattern, "u").test(responseUrl.pathname);
        const expected = new URL(target.path, responseUrl.origin);
        return responseUrl.pathname === expected.pathname && responseUrl.search === expected.search;
      } catch { return false; }
    }, { timeout: 30000 }));
    const actionPromise = Promise.resolve().then(action);
    const responsesPromise = Promise.all(responsePromises);
    const [responses] = await Promise.all([responsesPromise, actionPromise]);
    const captures = browserCapture ? await readRawResponseBatchCapture(page, targets) : {};
    await actionPromise;
    const result = {};
    for (const [index, target] of targets.entries()) {
      const response = responses[index];
      const capture = captures[target.key];
      if (capture !== undefined) {
        const responseUrl = new URL(response.url());
        const responsePath = `${responseUrl.pathname}${responseUrl.search}`;
        if (capture.status !== response.status() || capture.responsePath !== responsePath) {
          throw new Error(`raw response clone/CDP identity mismatch (${target.key})`);
        }
      }
      let body = capture === undefined ? await response.body() : Buffer.from(capture.bodyBase64, "base64");
      let payload;
      try { payload = JSON.parse(body.toString("utf8")); } catch (error) {
        if (response.status() === 200) throw new Error(`raw ${target.method} ${rawResponseTargetPath(target)} response must be JSON`, { cause: error });
      }
      const request = response.request();
      const requestHeaders = await request.allHeaders();
      result[target.key] = {
        status: response.status(), requestHeaders,
        requestBody: typeof request.postData === "function" ? request.postData() ?? undefined : undefined,
        payload, responsePath: capture?.responsePath ?? (() => { const responseUrl = new URL(response.url()); return `${responseUrl.pathname}${responseUrl.search}`; })(),
      };
      if (result[target.key].status !== target.expectedStatus) {
        const code = String(payload?.code ?? payload?.data?.code ?? payload?.title ?? "unavailable").slice(0, 128);
        throw new Error(`raw ${target.method} ${rawResponseTargetPath(target)} must answer with ${target.expectedStatus}: status=${result[target.key].status} code=${code}`);
      }
    }
    return result;
  } finally { if (browserCapture) await finishRawResponseBatchCapture(page); }
}

function assertRawEnvelope(value, expectedGeneration, expected) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "raw capture response must be an object");
  assert.equal(value.trace_id !== undefined, true, "raw capture response must carry a trace id");
  assert.equal(value.deployment_generation, expectedGeneration, "raw capture response must bind the current deployment");
  const receipt = value.data;
  assert.ok(receipt && typeof receipt === "object" && !Array.isArray(receipt), "raw capture response must carry a receipt");
  assert.equal(receipt.protocol, "eliotr.raw-file-capture.v1");
  assert.equal(receipt.disposition, "CAPTURED");
  assert.match(receipt.capture_id, /^raw-capture-[a-f0-9]{48}$/u);
  assert.match(receipt.idempotency_key, /^raw-upload-[a-f0-9]{64}$/u);
  assert.equal(receipt.original_file_name, expected.name);
  assert.equal(receipt.content_sha256, expected.digest);
  assert.equal(receipt.size_bytes, expected.bytes.length);
  assert.equal(receipt.content_type, expected.type);
  assert.match(receipt.captured_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  return receipt;
}

export async function waitForRawResponse(page, method, action, path = "/api/v1/ingest/raw", expectedStatus = 200) {
  const admissionDiagnostic = await beginRawAdmissionDiagnostic(page, path);
  let browserCapture = false;
  try {
    browserCapture = await beginRawResponseCapture(page, method, path, expectedStatus);
    const expectedOrigin = (() => {
      try { return new URL(page.url()).origin; } catch { return undefined; }
    })();
    const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : undefined;
    const responsePromise = page.waitForResponse((response) => {
      try {
        const request = response.request();
        const responseUrl = new URL(response.url());
        if (expectedOrigin !== undefined && responseUrl.origin !== expectedOrigin) return false;
        if (mainFrame !== undefined && typeof request.frame === "function" && request.frame() !== mainFrame) return false;
        return request.method() === method && responseUrl.pathname === path && responseUrl.search === "";
      } catch { return false; }
    }, { timeout: 30000 });
    const snapshotPromise = responsePromise.then(async (response) => {
      const status = response.status();
      let body;
      if (browserCapture) {
        try {
          body = await readRawResponseCapture(page, method, path, expectedStatus);
        } catch (error) {
          const ui = admissionDiagnostic ? await finishRawAdmissionDiagnostic(page) : undefined;
          const transport = rawResponseTransportDiagnostic(response);
          const detail = `${rawBodyDiagnostic(page, response, method, path, status, error)} capture_error=${String(error?.message ?? "unknown").slice(0, 128)} content_type=${transport.content_type} content_length=${transport.content_length} request_start_ms=${transport.request_start_ms ?? "unavailable"} response_start_ms=${transport.response_start_ms ?? "unavailable"} response_end_ms=${transport.response_end_ms ?? "unavailable"}${ui ? ` ui_code=${ui.ui_code} ui_events=${ui.events.join(",") || "none"}` : ""}`;
          throw new Error(`raw response clone unavailable at settlement (${detail})`, { cause: error });
        }
      } else {
        try {
          // Test-only page doubles do not expose browser fetch; retain the old
          // ordering regression there. Real pages use the clone above.
          body = await response.body();
        } catch (error) {
          const ui = admissionDiagnostic ? await finishRawAdmissionDiagnostic(page) : undefined;
          const transport = rawResponseTransportDiagnostic(response);
          const detail = `${rawBodyDiagnostic(page, response, method, path, status, error)} content_type=${transport.content_type} content_length=${transport.content_length} request_start_ms=${transport.request_start_ms ?? "unavailable"} response_start_ms=${transport.response_start_ms ?? "unavailable"} response_end_ms=${transport.response_end_ms ?? "unavailable"}${ui ? ` ui_code=${ui.ui_code} ui_events=${ui.events.join(",") || "none"}` : ""}`;
          throw new Error(`raw response body unavailable at settlement (${detail})`, { cause: error });
        }
      }
      const requestHeaders = await response.request().allHeaders();
      const requestBody = typeof response.request().postData === "function"
        ? response.request().postData() ?? undefined : undefined;
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch (error) {
        if (status === 200) {
          throw new Error(`raw ${method} response must be JSON`, { cause: error });
        }
      }
      return { status, requestHeaders, requestBody, payload };
    });
    const [, snapshot] = await Promise.all([Promise.resolve().then(action), snapshotPromise]);
    if (snapshot.status !== expectedStatus) {
      const code = String(snapshot.payload?.code ?? snapshot.payload?.data?.code ?? snapshot.payload?.title ?? "unavailable").slice(0, 128);
      throw new Error(`raw ${method} ${path} must answer with ${expectedStatus} through the real Worker: status=${snapshot.status} code=${code}`);
    }
    return snapshot;
  } finally {
    if (admissionDiagnostic) await finishRawAdmissionDiagnostic(page);
    if (browserCapture) await finishRawResponseCapture(page);
  }
}

/**
 * Real Worker owner scenario. The browser drives the actual PWA panel and
 * same-origin owner session; this helper never intercepts or fabricates API
 * responses. The caller supplies the current generation and later performs
 * stopped-Worker D1/R2 readback.
 */
export async function runRawFileUploadOwnerScenario({ page, expectedGeneration, ledger }) {
  assert.ok(page && typeof page.waitForSelector === "function", "raw owner scenario requires a Playwright page");
  assert.ok(typeof expectedGeneration === "string" && expectedGeneration.length > 0, "raw owner scenario requires a deployment generation");
  const bytes = Buffer.from("raw upload owner fixture\n", "utf8");
  const expected = {
    name: "исследование.txt",
    type: "text/plain",
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  const panel = page.locator("#raw-upload");
  await page.waitForSelector("#raw-upload [data-raw-file]", { timeout: 15000 });
  const input = panel.locator("input[data-raw-file]");
  const setFile = async () => input.setInputFiles({ name: expected.name, mimeType: expected.type, buffer: expected.bytes });
  await setFile();
  await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
  const postSnapshot = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-submit]").click());
  const postHeaders = postSnapshot.requestHeaders;
  assert.equal(decodeURIComponent(postHeaders["x-eliotr-original-file-name"] ?? ""), expected.name,
    "browser upload must preserve the UTF-8 original filename header");
  assert.equal(postHeaders["x-eliotr-content-sha256"], expected.digest, "browser upload must bind the selected bytes");
  assert.equal(postHeaders["content-type"], expected.type, "browser upload must bind the selected MIME type");
  assert.ok(Number.parseInt(postHeaders["content-length"] ?? "", 10) === expected.bytes.length,
    "Chromium must supply Content-Length for the File body");
  const postEnvelope = postSnapshot.payload;
  const receipt = assertRawEnvelope(postEnvelope, expectedGeneration, expected);
  ledger?.record({ client: "browser", method: "POST", path: "/api/v1/ingest/raw", status: postSnapshot.status,
    correlation: "e2e-raw-upload/post", token_present: false });
  await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-receipt]")?.hidden === false, null, { timeout: 15000 });
  assert.match(await panel.locator("[data-raw-status]").textContent(), /File saved/u);
  return { expected, receipt, idempotencyKey: receipt.idempotency_key, captureId: receipt.capture_id };
}

/** Complete the real browser reload/reselect leg with the same selection. */
export async function recoverRawFileUploadOwnerScenario({ page, expectedGeneration, expected, idempotencyKey, captureId, ledger }) {
  assert.ok(expected && Buffer.isBuffer(expected.bytes), "raw recovery requires the original selected bytes");
  assert.equal(typeof idempotencyKey, "string");
  assert.equal(typeof captureId, "string");
  const panel = page.locator("#raw-upload");
  const input = panel.locator("input[data-raw-file]");
  await page.waitForSelector("#raw-upload [data-raw-file]", { timeout: 15000 });
  await input.setInputFiles({ name: expected.name, mimeType: expected.type, buffer: expected.bytes });
  await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-recover]")?.disabled === false, null, { timeout: 15000 });
  const responseSnapshot = await waitForRawResponse(page, "GET", () => panel.locator("[data-raw-recover]").click());
  const requestHeaders = responseSnapshot.requestHeaders;
  assert.equal(requestHeaders["idempotency-key"], idempotencyKey, "recovery GET must use the original idempotency key");
  const receipt = assertRawEnvelope(responseSnapshot.payload, expectedGeneration, expected);
  assert.equal(receipt.capture_id, captureId, "recovery GET must return the original durable capture");
  ledger?.record({ client: "browser", method: "GET", path: "/api/v1/ingest/raw", status: responseSnapshot.status,
    correlation: "e2e-raw-upload/recovery", token_present: false });
  await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-receipt]")?.hidden === false, null, { timeout: 15000 });
  assert.match(await panel.locator("[data-raw-status]").textContent(), /Existing upload found/u);
  return receipt;
}

/**
 * Real Worker processing/admission leg. The caller may seed one recorded,
 * complete conversion candidate into the authoritative local stores before
 * this function runs; the browser still exercises the production conversion
 * replay and raw admission routes, including the server-composed witness.
 */
export async function processRawFileOwnerScenario({ page, expectedGeneration, expected, captureId, conversionOperationId, ledger }) {
  assert.ok(expected && Buffer.isBuffer(expected.bytes), "raw processing requires the original selected bytes");
  assert.ok(typeof expectedGeneration === "string" && expectedGeneration.length > 0, "raw processing requires a deployment generation");
  assert.equal(typeof captureId, "string");
  assert.match(conversionOperationId, /^[a-f0-9]{64}$/u);
  const panel = page.locator("#raw-upload");
  const conversionPath = `/api/v1/ingest/raw/${encodeURIComponent(captureId)}/markdown`;
  await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-process]")?.hidden === false &&
    document.querySelector("#raw-upload [data-raw-process]")?.disabled === false, null, { timeout: 15000 });
  const conversionSnapshot = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-process]").click(), conversionPath);
  assert.equal(JSON.parse(conversionSnapshot.requestBody ?? "{}").conversion_options?.output?.format, "markdown");
  const conversion = conversionSnapshot.payload?.data;
  assert.equal(conversion?.protocol, "eliotr.raw-markdown-conversion.v1");
  assert.equal(conversion?.state, "COMPLETE", "recorded conversion fixture must replay as COMPLETE");
  assert.equal(conversion?.operation_id, conversionOperationId);
  assert.equal(conversion?.capture_id, captureId);
  assert.equal(conversion?.content_sha256, expected.digest);
  assert.match(conversion?.output_sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(conversion?.format, "markdown");
  ledger?.record({ client: "browser", method: "POST", path: conversionPath, status: conversionSnapshot.status,
    correlation: "e2e-raw-upload/markdown", token_present: false });
  await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-processing]")?.hidden === false, null, { timeout: 15000 });
  assert.match(await panel.locator("[data-raw-status]").textContent(), /Processed/u);
  assert.match(await panel.locator("[data-raw-processing]").textContent(), /Not admitted or indexed/u);

  const admissionPath = `/api/v1/ingest/raw/${encodeURIComponent(captureId)}/admission`;
  const admissionSnapshot = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-admit]").click(), admissionPath);
  const admissionBody = JSON.parse(admissionSnapshot.requestBody ?? "{}");
  assert.deepEqual(Object.keys(admissionBody).sort(), ["conversion_operation_id", "idempotency_key"]);
  assert.equal(admissionBody.conversion_operation_id, conversionOperationId);
  const admission = admissionSnapshot.payload?.data;
  assert.equal(admission?.protocol, "eliotr.raw-normalized-admission.v1");
  assert.equal(admission?.state, "COMMITTED");
  assert.equal(admission?.capture_id, captureId);
  assert.equal(admission?.conversion_operation_id, conversionOperationId);
  assert.match(admission?.admission_operation_id ?? "", /^[a-f0-9]{64}$/u);
  assert.match(admission?.candidate_ref ?? "", /^raw-normalized-candidate:[a-f0-9]{64}$/u);
  assert.match(admission?.source_view_ref ?? "", /^snapshot-view:v1:[a-f0-9]{64}$/u);
  assert.equal(admission?.conversion_state, "COMPLETE");
  assert.ok(admission?.admission_receipt && ["ADMITTED", "DUPLICATE"].includes(admission.admission_receipt.decision));
  ledger?.record({ client: "browser", method: "POST", path: admissionPath, status: admissionSnapshot.status,
    correlation: "e2e-raw-upload/admission", token_present: false });
  await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-admission]")?.hidden === false, null, { timeout: 15000 });
  assert.match(await panel.locator("[data-raw-status]").textContent(), /Added to Library/u);
  assert.match(await panel.locator("[data-raw-admission]").textContent(), /COMMITTED/u);
  return { conversion, admission, conversionOperationId, admissionOperationId: admission.admission_operation_id };
}

function contentType(path) {
  return ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json" })[extname(path)] ?? "application/octet-stream";
}

async function startFixture() {
  const raw = { mode: "lost", postCount: 0, getCount: 0, conversionCount: 0, conversionMode: "unknown", conversionLossPending: false,
    admissionMode: "lost", admissionLossPending: false, admissionStatusNonterminalPending: false, admissionCount: 0, admissionStatusCount: 0, capture: undefined, headers: undefined,
    release: undefined, onPost: undefined, requests: [], conversionRequests: [], admissionRequests: [], admissionStatusRequests: [], healthResponses: [] };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("cache-control", "no-store");
      const json = (value, status = 200) => {
        response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/v1/system/health") {
        const health = raw.healthResponses.shift() ?? { ready: true, deployment_generation: generation,
          core_schema_generation: "fixture", search_schema_generation: "fixture", blocking_reason_codes: [],
          checked_at: new Date().toISOString() };
        return json(envelope(health, health.deployment_generation));
      }
      if (url.pathname === "/api/v1/research/catalog") return json(envelope({
        projects: [{ id: "project-1", title: "Workspace", generation: "1" }],
        sources: [{ id: "source-1", title: "Fixture source", readiness_ref: "readiness:source-1:revision-1" }],
      }));
      const conversionMatch = url.pathname.match(/^\/api\/v1\/ingest\/raw\/([^/]+)\/markdown$/u);
      if (conversionMatch !== null) {
        assert.equal(request.method, "POST");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(typeof body.idempotency_key, "string");
        raw.conversionCount += 1;
        raw.conversionRequests.push({ captureId: decodeURIComponent(conversionMatch[1]), body });
        if (raw.conversionMode === "lost" && raw.conversionLossPending) {
          raw.conversionLossPending = false;
          response.statusCode = 503; response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ type: "urn:eliotr:problem:raw_markdown_settlement_uncertain", title: "Processing settlement is uncertain",
            status: 503, code: "PROVIDER_UNCERTAIN", trace_id: trace, retryable: true }));
          return;
        }
        const state = raw.conversionMode === "unknown" && raw.conversionCount === 1 ? "UNKNOWN" : "COMPLETE";
        const data = state === "UNKNOWN"
          ? { protocol: "eliotr.raw-markdown-conversion.v1", state, operation_id: "b".repeat(64), capture_id: `raw-capture-${"a".repeat(48)}`,
            content_sha256: raw.capture?.digest, failure_code: "PROVIDER_UNCERTAIN" }
          : { protocol: "eliotr.raw-markdown-conversion.v1", state, operation_id: "b".repeat(64), capture_id: `raw-capture-${"a".repeat(48)}`,
            content_sha256: raw.capture?.digest, output_sha256: "c".repeat(64), output_bytes: 12, detected_mime: "text/plain", format: "markdown", tokens: 3 };
        return json(envelope(data));
      }
      const admissionMatch = url.pathname.match(/^\/api\/v1\/ingest\/raw\/([^/]+)\/admission$/u);
      if (admissionMatch !== null) {
        assert.equal(request.method, "POST");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.deepEqual(Object.keys(body).sort(), ["conversion_operation_id", "idempotency_key"]);
        raw.admissionCount += 1;
        raw.admissionRequests.push({ captureId: decodeURIComponent(admissionMatch[1]), body });
        if ((raw.admissionMode === "lost" && raw.admissionCount === 1) || (raw.admissionMode === "lost-next" && raw.admissionLossPending)) {
          raw.admissionLossPending = false;
          response.statusCode = 503; response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ type: "urn:eliotr:problem:raw_normalized_outcome_unknown", title: "Library admission outcome is uncertain",
            status: 503, code: "RAW_NORMALIZED_OUTCOME_UNKNOWN", trace_id: trace, retryable: true }));
          return;
        }
        const state = raw.admissionCount === 1 ? "UNKNOWN" : "COMMITTED";
        const data = state === "UNKNOWN"
          ? { protocol: "eliotr.raw-normalized-admission.v1", admission_operation_id: "a".repeat(64), capture_id: decodeURIComponent(admissionMatch[1]),
            conversion_operation_id: body.conversion_operation_id, candidate_ref: `raw-normalized-candidate:${"b".repeat(64)}`, state,
            source_revision_ref: "revision-raw-1", source_view_ref: `snapshot-view:v1:${"c".repeat(64)}`, conversion_state: "COMPLETE", reason_codes: ["PROVIDER_UNCERTAIN"],
            expires_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z" }
          : { protocol: "eliotr.raw-normalized-admission.v1", admission_operation_id: "a".repeat(64), capture_id: decodeURIComponent(admissionMatch[1]),
            conversion_operation_id: body.conversion_operation_id, candidate_ref: `raw-normalized-candidate:${"b".repeat(64)}`, state,
            source_revision_ref: "revision-raw-1", source_view_ref: `snapshot-view:v1:${"c".repeat(64)}`, conversion_state: "COMPLETE",
            admission_receipt: { operation_id: "bundle-op-raw-1", manifest_sha256: "d".repeat(64), source_revision_ref: "revision-raw-1",
              normalized_artifact_ref: "normalized/raw-1", object_residency_key_digest: "e".repeat(64), decision: "ADMITTED", reason_codes: [],
              readback_sha256: "f".repeat(64), committed_at: "2026-09-09T00:00:00.000Z" }, reason_codes: [],
            expires_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z" };
        return json(envelope(data));
      }
      const admissionStatusMatch = url.pathname.match(/^\/api\/v1\/ingest\/raw\/([^/]+)\/admission\/([a-f0-9]{64})$/u);
      if (admissionStatusMatch !== null) {
        assert.equal(request.method, "GET");
        assert.equal(admissionStatusMatch[2], "a".repeat(64));
        raw.admissionStatusCount += 1;
        raw.admissionStatusRequests.push({ captureId: decodeURIComponent(admissionStatusMatch[1]), admissionOperationId: admissionStatusMatch[2] });
        if (raw.admissionStatusNonterminalPending) {
          raw.admissionStatusNonterminalPending = false;
          return json(envelope({ protocol: "eliotr.raw-normalized-admission.v1", admission_operation_id: "a".repeat(64),
            capture_id: decodeURIComponent(admissionStatusMatch[1]), conversion_operation_id: "b".repeat(64), candidate_ref: `raw-normalized-candidate:${"b".repeat(64)}`, state: "PREPARING",
            source_revision_ref: "revision-raw-1", source_view_ref: `snapshot-view:v1:${"c".repeat(64)}`, conversion_state: "COMPLETE", reason_codes: ["IN_PROGRESS"],
            expires_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z" }));
        }
        return json(envelope({ protocol: "eliotr.raw-normalized-admission.v1", admission_operation_id: "a".repeat(64),
          capture_id: decodeURIComponent(admissionStatusMatch[1]), conversion_operation_id: "b".repeat(64), candidate_ref: `raw-normalized-candidate:${"b".repeat(64)}`, state: "COMMITTED",
          source_revision_ref: "revision-raw-1", source_view_ref: `snapshot-view:v1:${"c".repeat(64)}`, conversion_state: "COMPLETE",
          admission_receipt: { operation_id: "bundle-op-raw-1", manifest_sha256: "d".repeat(64), source_revision_ref: "revision-raw-1",
            normalized_artifact_ref: "normalized/raw-1", object_residency_key_digest: "e".repeat(64), decision: "ADMITTED", reason_codes: [],
            readback_sha256: "f".repeat(64), committed_at: "2026-09-09T00:00:00.000Z" }, reason_codes: [],
          expires_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z" }));
      }
      if (url.pathname === "/api/v1/ingest/raw") {
        if (request.method === "POST") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          const headers = request.headers;
          const key = headers["idempotency-key"];
          const encodedName = headers["x-eliotr-original-file-name"];
          const digest = headers["x-eliotr-content-sha256"];
          assert.equal(typeof key, "string"); assert.equal(typeof encodedName, "string"); assert.equal(typeof digest, "string");
          raw.postCount += 1; raw.headers = headers;
          raw.requests.push({ method: request.method, mode: raw.mode, key });
          raw.capture = { key, name: decodeURIComponent(encodedName), digest, size: bytes.byteLength,
            type: headers["content-type"] ?? "application/octet-stream" };
          raw.onPost?.();
          if (raw.mode === "delayed") await new Promise((resolvePromise) => { raw.release = resolvePromise; });
          if (raw.mode === "lost") {
            response.statusCode = 503; response.setHeader("content-type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ type: "urn:eliotr:problem:raw_capture_settlement_uncertain", title: "Raw capture settlement is uncertain",
              status: 503, code: "RAW_CAPTURE_SETTLEMENT_UNCERTAIN", trace_id: trace, retryable: true }));
            return;
          }
          if (raw.mode === "denied") { response.statusCode = 401; response.setHeader("content-type", "text/html"); response.end("Access denied"); return; }
          return json(envelope(receiptFor(key, raw.capture)));
        }
        assert.equal(request.method, "GET");
        raw.getCount += 1;
        raw.requests.push({ method: request.method, mode: raw.mode, key: request.headers["idempotency-key"] });
        if (raw.capture === undefined || request.headers["idempotency-key"] !== raw.capture.key) { response.statusCode = 404; return json(envelope({ code: "RAW_CAPTURE_NOT_FOUND" }), 404); }
        return json(envelope(receiptFor(raw.capture.key, raw.capture)));
      }
      const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
      if (!file.startsWith(`${dist}${sep}`)) { response.statusCode = 404; response.end(); return; }
      try { response.setHeader("content-type", contentType(file)); response.end(await readFile(file)); }
      catch { response.statusCode = 404; response.end(); }
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, raw };
}

function receiptFor(key, file) {
  return { protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"a".repeat(48)}`,
    idempotency_key: key, original_file_name: file.name, content_sha256: file.digest, size_bytes: file.size,
    content_type: file.type, captured_at: "2026-09-09T00:00:00.000Z" };
}

/**
 * Controlled Chromium lifecycle regression. The page and DOM are real, while
 * only raw capture responses are controlled; this proves UI identity, abort,
 * stale-state and lost-ACK behavior without claiming D1/R2 persistence.
 */
export async function runRawFileUploadBrowser() {
  await access(resolve(dist, "index.html"));
  const fixture = await startFixture();
  const profile = await mkdtemp(resolve(tmpdir(), "eliotr-raw-file-browser-"));
  let browser;
  let context;
  let firstKey;
  const file = { name: "заметка.txt", type: "text/plain", size: 18, digest: "" };
  try {
    const bytes = Buffer.from("Русский source\n", "utf8");
    file.size = bytes.byteLength;
    const { createHash } = await import("node:crypto");
    file.digest = createHash("sha256").update(bytes).digest("hex");
    const executable = await resolveLocalBrowserExecutable();
    browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    context = await browser.newContext();
    const page = await context.newPage();
    fixture.raw.mode = "delayed";
    const unavailableHealth = {
      ready: false, deployment_generation: "unreachable", core_schema_generation: null, search_schema_generation: null,
      blocking_reason_codes: ["HEALTH_ENDPOINT_UNREACHABLE"], checked_at: new Date().toISOString(),
    };
    const readyHealth = {
      ready: true, deployment_generation: generation, core_schema_generation: "fixture", search_schema_generation: "fixture",
      blocking_reason_codes: [], checked_at: new Date().toISOString(),
    };
    fixture.raw.healthResponses.push(unavailableHealth, readyHealth);
    // The server signals after it has consumed the real browser request body.
    const waitForPost = new Promise((resolvePromise) => { fixture.raw.onPost = resolvePromise; });
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    const panel = page.locator("#raw-upload");
    const refresh = page.locator(".content-actions [data-refresh]");
    await page.waitForFunction(() => document.querySelector("#health-summary")?.textContent?.includes("Workspace connection unavailable") === true &&
      document.querySelector("[data-refresh]")?.textContent?.trim() === "Retry connection", null, { timeout: 15000 });
    assert.match(await panel.locator("[data-raw-status]").textContent(), /Workspace connection unavailable/u);
    await refresh.click();
    await page.waitForFunction(() => document.querySelector("#health-badge")?.textContent?.trim() === "ready" &&
      document.querySelector("#raw-upload [data-raw-submit]") !== null, null, { timeout: 15000 });
    assert.match(await page.locator("#health-summary").textContent(), /Workspace connected/u);
    assert.doesNotMatch(await panel.locator("[data-raw-status]").textContent(), /Workspace connection unavailable|connection lost|Application changed/u);
    await page.evaluate(() => {
      const app = document.querySelector("#app");
      const events = [];
      app?.addEventListener("eliotr:health-lost", (event) => events.push(`lost:${event.detail?.reason ?? "missing"}`));
      app?.addEventListener("eliotr:health-updated", () => events.push("updated"));
      window.__rawHealthEvents = events;
    });
    fixture.raw.healthResponses.push(unavailableHealth, readyHealth);
    await refresh.click();
    await page.waitForFunction(() => document.querySelector("#health-summary")?.textContent?.includes("Workspace connection unavailable") === true, null, { timeout: 15000 });
    assert.match(await panel.locator("[data-raw-status]").textContent(), /Workspace connection lost/u);
    await refresh.click();
    await page.waitForFunction(() => document.querySelector("#health-summary")?.textContent?.includes("Workspace connected") === true &&
      document.querySelector("#health-badge")?.textContent?.trim() === "ready", null, { timeout: 15000 });
    assert.doesNotMatch(await panel.locator("[data-raw-status]").textContent(), /Workspace connection unavailable|connection lost|Application changed/u);
    assert.deepEqual(await page.evaluate(() => window.__rawHealthEvents), ["lost:connection-lost", "updated", "updated"]);
    const input = panel.locator("input[data-raw-file]");
    const setFile = async () => input.setInputFiles({ name: file.name, mimeType: file.type, buffer: bytes });

    // Abort must prevent a late fulfilled response from rendering a receipt.
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    await panel.locator("[data-raw-submit]").click();
    await waitForPost;
    await panel.locator("[data-raw-stop]").click();
    fixture.raw.release?.();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-status]")?.textContent?.includes("Capture stopped") === true, null, { timeout: 5000 });
    assert.equal(await panel.locator("[data-raw-receipt]").getAttribute("hidden"), "",
      `cancel must not render a late receipt: ${await panel.locator("[data-raw-receipt]").evaluate((node) => node.outerHTML)}`);

    // A lost POST acknowledgement must use the same key for one GET readback.
    fixture.raw.mode = "lost";
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    await panel.locator("[data-raw-submit]").click();
    try {
      await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-receipt]")?.hidden === false, null, { timeout: 15000 });
    } catch (error) {
      throw new Error(`lost-ACK readback did not render: status=${await panel.locator("[data-raw-status]").textContent()} posts=${fixture.raw.postCount} gets=${fixture.raw.getCount}`, { cause: error });
    }
    firstKey = fixture.raw.capture?.key;
    assert.match(firstKey, /^raw-upload-[a-f0-9]{64}$/u);
    assert.equal(fixture.raw.postCount, 2, `unexpected raw POST count ${fixture.raw.postCount}: ${JSON.stringify(fixture.raw.requests)}`); assert.equal(fixture.raw.getCount, 1);
    assert.match(await panel.locator("[data-raw-status]").textContent(), /Existing upload found/u);

    // Processing has its own durable identity. An UNKNOWN result can be
    // checked again with the same request key, and COMPLETE remains a
    // conversion candidate rather than an admission or index claim.
    const conversionPath = `/api/v1/ingest/raw/${"raw-capture-" + "a".repeat(48)}/markdown`;
    const unknownSnapshot = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-process]").click(), conversionPath);
    assert.equal(unknownSnapshot.payload.data.state, "UNKNOWN");
    assert.equal(fixture.raw.conversionCount, 1);
    const conversionKey = fixture.raw.conversionRequests[0]?.body?.idempotency_key;
    assert.match(conversionKey, /^raw-markdown-[a-f0-9]{64}$/u);
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-process]")?.textContent?.includes("Check processing status") === true, null, { timeout: 5000 });
    assert.match(await panel.locator("[data-raw-status]").textContent(), /status is unknown/u);
    const completeSnapshot = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-process]").click(), conversionPath);
    assert.equal(completeSnapshot.payload.data.state, "COMPLETE");
    assert.equal(fixture.raw.conversionCount, 2);
    assert.equal(fixture.raw.conversionRequests[1]?.body?.idempotency_key, conversionKey, "processing check must reuse the same idempotency key");
    assert.match(await panel.locator("[data-raw-status]").textContent(), /Processed/u);
    const processingText = await panel.locator("[data-raw-processing]").textContent();
    assert.match(processingText, /Not admitted or indexed/u);
    assert.doesNotMatch(processingText, /admitted\s+and\s+indexed/u);

    const admissionPath = `/api/v1/ingest/raw/${"raw-capture-" + "a".repeat(48)}/admission`;
    const admissionUnknown = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-admit]").click(), admissionPath, 503);
    assert.equal(admissionUnknown.payload.code, "RAW_NORMALIZED_OUTCOME_UNKNOWN");
    assert.equal(fixture.raw.admissionCount, 1);
    const admissionKey = fixture.raw.admissionRequests[0]?.body?.idempotency_key;
    assert.match(admissionKey, /^raw-admission-[a-f0-9]{64}$/u);
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-admit]")?.textContent?.includes("Reconcile Library add") === true, null, { timeout: 5000 });
    const admissionCommitted = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-admit]").click(), admissionPath);
    assert.equal(admissionCommitted.payload.data.state, "COMMITTED");
    assert.equal(fixture.raw.admissionCount, 2);
    assert.equal(fixture.raw.admissionRequests[1]?.body?.idempotency_key, admissionKey, "Library reconcile must reuse the same admission idempotency key");
    assert.match(await panel.locator("[data-raw-status]").textContent(), /Added to Library/u);
    assert.match(await panel.locator("[data-raw-admission]").textContent(), /COMMITTED/u);
    const admissionReadbackPath = `${admissionPath}/${"a".repeat(64)}`;
    fixture.raw.admissionStatusNonterminalPending = true;
    const admissionPreparing = await waitForRawResponse(page, "GET", () => panel.locator("[data-raw-admit]").click(), admissionReadbackPath);
    assert.equal(admissionPreparing.payload.data.state, "PREPARING");
    assert.equal(fixture.raw.admissionStatusCount, 1);
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-admit]")?.textContent?.includes("Resume Library add") === true, null, { timeout: 5000 });
    const admissionResumed = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-admit]").click(), admissionPath);
    assert.equal(admissionResumed.payload.data.state, "COMMITTED");
    assert.equal(fixture.raw.admissionCount, 3);
    assert.equal(fixture.raw.admissionRequests[2]?.body?.idempotency_key, admissionKey, "resuming the existing Library add must reuse its idempotency key");
    const admissionReadback = await waitForRawResponse(page, "GET", () => panel.locator("[data-raw-admit]").click(), admissionReadbackPath);
    assert.equal(admissionReadback.payload.data.state, "COMMITTED");
    assert.equal(admissionReadback.payload.data.admission_operation_id, "a".repeat(64));
    assert.equal(admissionReadback.payload.data.admission_receipt.decision, "ADMITTED");
    assert.equal(fixture.raw.admissionStatusCount, 2);

    // The next reload deliberately loses both settlement acknowledgements.
    // Recovery must use the durable capture/conversion identities, then the
    // same admission key, while a known operation remains GET-only in the UI.
    fixture.raw.conversionMode = "lost";
    fixture.raw.conversionLossPending = true;
    fixture.raw.admissionMode = "lost-next";
    fixture.raw.admissionLossPending = true;

    // pagehide clears private state; reselecting the same file starts from the
    // same deterministic identity after the page is loaded again.
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    assert.equal(await panel.locator("[data-raw-receipt]").getAttribute("hidden"), "");
    assert.equal(await input.inputValue(), "");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#health-badge")?.textContent?.trim() === "ready" &&
      document.querySelector("#raw-upload [data-raw-submit]") !== null, null, { timeout: 15000 });
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    const reloadCaptureResponses = await waitForRawResponses(page, [
      { key: "reload-capture", method: "POST", path: "/api/v1/ingest/raw", expectedStatus: 503 },
      { key: "reload-capture-readback", method: "GET", path: "/api/v1/ingest/raw", expectedStatus: 200 },
    ], () => panel.locator("[data-raw-submit]").click());
    assert.equal(reloadCaptureResponses["reload-capture"].status, 503);
    assert.equal(reloadCaptureResponses["reload-capture-readback"].status, 200);
    assert.equal(reloadCaptureResponses["reload-capture-readback"].payload.data.idempotency_key, firstKey);
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-receipt]")?.hidden === false, null, { timeout: 15000 });
    assert.equal(fixture.raw.postCount, 3); assert.equal(fixture.raw.getCount, 2);
    assert.equal(fixture.raw.capture?.key, firstKey, "same file after reload must reuse its deterministic identity");

    const reloadConversionLoss = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-process]").click(), conversionPath, 503);
    assert.equal(reloadConversionLoss.payload.code, "PROVIDER_UNCERTAIN");
    assert.equal(fixture.raw.conversionRequests[2]?.body?.idempotency_key, conversionKey);
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-process]")?.textContent?.includes("Check processing status") === true, null, { timeout: 5000 });
    const reloadConversion = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-process]").click(), conversionPath);
    assert.equal(reloadConversion.payload.data.state, "COMPLETE");
    assert.equal(reloadConversion.payload.data.operation_id, completeSnapshot.payload.data.operation_id, "replayed processing must retain its operation identity");
    assert.equal(fixture.raw.conversionRequests[3]?.body?.idempotency_key, conversionKey);

    const admissionPathAfterReload = admissionPath;
    const reloadAdmissionLoss = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-admit]").click(), admissionPathAfterReload, 503);
    assert.equal(reloadAdmissionLoss.payload.code, "RAW_NORMALIZED_OUTCOME_UNKNOWN");
    assert.equal(fixture.raw.admissionCount, 4);
    assert.equal(fixture.raw.admissionRequests[3]?.body?.idempotency_key, admissionKey);
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-admit]")?.textContent?.includes("Reconcile Library add") === true, null, { timeout: 5000 });
    const reloadAdmission = await waitForRawResponse(page, "POST", () => panel.locator("[data-raw-admit]").click(), admissionPathAfterReload);
    assert.equal(reloadAdmission.payload.data.state, "COMMITTED");
    assert.equal(reloadAdmission.payload.data.admission_operation_id, admissionCommitted.payload.data.admission_operation_id, "replayed admission must retain its operation identity");
    assert.equal(fixture.raw.admissionRequests[4]?.body?.idempotency_key, admissionKey);
    const reloadAdmissionReadback = await waitForRawResponse(page, "GET", () => panel.locator("[data-raw-admit]").click(), admissionReadbackPath);
    assert.equal(reloadAdmissionReadback.payload.data.admission_operation_id, admissionCommitted.payload.data.admission_operation_id);
    assert.equal(fixture.raw.admissionStatusCount, 3);

    // A generation change rejects readback rather than promoting a receipt
    // from the old deployment.
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#health-badge")?.textContent?.trim() === "ready" &&
      document.querySelector("#raw-upload [data-raw-submit]") !== null, null, { timeout: 15000 });
    await page.evaluate(() => {
      const app = document.querySelector("#app");
      const events = [];
      app?.addEventListener("eliotr:health-lost", (event) => events.push(`lost:${event.detail?.reason ?? "missing"}`));
      app?.addEventListener("eliotr:health-updated", () => events.push("updated"));
      window.__rawHealthEvents = events;
    });
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    fixture.raw.healthResponses.push({ ...readyHealth, deployment_generation: "changed-generation" });
    await refresh.click();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-status]")?.textContent?.includes("Application changed") === true, null, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => window.__rawHealthEvents), ["lost:generation-changed", "updated"]);
    assert.equal(await input.inputValue(), "");
    assert.equal(await panel.locator("[data-raw-receipt]").getAttribute("hidden"), "");

    // A 401 clears the selected file through the shared authorization event.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#health-badge")?.textContent?.trim() === "ready" &&
      document.querySelector("#raw-upload [data-raw-submit]") !== null, null, { timeout: 15000 });
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    fixture.raw.mode = "denied";
    await panel.locator("[data-raw-submit]").click();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-status]")?.textContent?.includes("Private upload state cleared") === true, null, { timeout: 15000 });
    assert.equal(await input.inputValue(), "");

    // Offline clears a newly selected file before any request is dispatched.
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    assert.equal(await input.inputValue(), "");
    assert.equal(fixture.raw.headers?.["content-length"], String(file.size), "Chromium must supply Content-Length for the File body");
    return { state: "PASS", postCount: fixture.raw.postCount, getCount: fixture.raw.getCount, conversionCount: fixture.raw.conversionCount, admissionCount: fixture.raw.admissionCount, identity: firstKey, live: "NOT_EXECUTED" };
  } finally {
    fixture.raw.release?.();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRawFileUploadBrowser();
  console.log(`Raw file browser: ${result.state} (controlled Chromium; lost-ACK/readback, cancel, pagehide, deterministic reselection; D1/R2 ${result.live})`);
}
