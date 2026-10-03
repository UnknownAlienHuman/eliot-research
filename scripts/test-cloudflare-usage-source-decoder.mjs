// Safe status classification fixtures; no live Cloudflare calls or credentials.
// Run with: node scripts/test-cloudflare-usage-source-decoder.mjs

import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import {
  classifyCloudflareUsageHttpStatus,
  decodeCloudflareUsageJson,
  decodeCloudflareUsageResult,
  UsageSourceDecodeError,
} from "./lib/cloudflare-usage-source-decoder.mjs";

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Usage source decoder: ${name}: PASS`);
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function expectDecodeFailure(promise, code, textNotAllowed = []) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof UsageSourceDecodeError);
    assert.equal(error.code, code);
    assert.equal(typeof error.classification, "string");
    for (let i = 0; i < textNotAllowed.length; i += 1) {
      assert.doesNotMatch(`${error.name} ${error.message}`, new RegExp(textNotAllowed[i], "i"));
    }
    return true;
  });
}

await check("2xx is not a failure", async () => {
  assert.equal(classifyCloudflareUsageHttpStatus(200), null);
  assert.equal(classifyCloudflareUsageHttpStatus(299), null);
});

await check("401 records authentication failure without provider details", async () => {
  assert.deepEqual(classifyCloudflareUsageHttpStatus(401), {
    code: "HTTP_UNAUTHENTICATED",
    classification: "authentication-failure",
    httpStatus: 401,
    message: "Cloudflare usage source authentication failed (HTTP 401)",
  });
});

await check("403 remains a generic authorization denial", async () => {
  const result = classifyCloudflareUsageHttpStatus(403);
  assert.equal(result.code, "HTTP_FORBIDDEN");
  assert.equal(result.classification, "authorization-denial");
  assert.equal(result.httpStatus, 403);
  assert.match(result.message, /authorization was denied/);
  assert.doesNotMatch(result.message, /scope|entitlement|owner|approval|token/i);
});

await check("404 does not imply an unsupported or restricted endpoint", async () => {
  const result = classifyCloudflareUsageHttpStatus(404);
  assert.equal(result.code, "HTTP_NOT_FOUND");
  assert.equal(result.classification, "not-found");
  assert.match(result.message, /resource was not found/);
  assert.doesNotMatch(result.message, /unsupported|restricted|entitlement/i);
});

await check("other HTTP failures retain numeric status only", async () => {
  for (const status of [301, 400, 429, 500, 503]) {
    const result = classifyCloudflareUsageHttpStatus(status);
    assert.equal(result.code, "HTTP_STATUS_ERROR");
    assert.equal(result.classification, "http-error");
    assert.equal(result.httpStatus, status);
    assert.ok(result.message.includes(`HTTP ${status}`));
  }
});

await check("invalid or absent statuses become unknown gaps", async () => {
  for (const status of [null, undefined, "403", 0, 99, 600, NaN]) {
    const result = classifyCloudflareUsageHttpStatus(status);
    assert.equal(result.code, "HTTP_STATUS_UNKNOWN");
    assert.equal(result.classification, "unknown-transport-or-response-gap");
    assert.equal(result.httpStatus, null);
  }
});

await check("returned descriptors are immutable and contain no supplied secrets", async () => {
  const result = classifyCloudflareUsageHttpStatus(403);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result).sort(), ["classification", "code", "httpStatus", "message"]);
});

await check("strict D1 list envelope keeps documented pagination fields", async () => {
  const decoded = await decodeCloudflareUsageResult(response({
    success: true,
    errors: [],
    messages: [],
    result: [{ uuid: "d1-example", name: "fictional" }],
    result_info: { count: 1, page: 1, per_page: 10000, total_count: 1 },
  }), { expectedResultKind: "array" });
  assert.equal(decoded.httpStatus, 200);
  assert.deepEqual(decoded.result, [{ uuid: "d1-example", name: "fictional" }]);
  assert.deepEqual(decoded.resultInfo, { count: 1, page: 1, per_page: 10000, total_count: 1 });
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.resultInfo), true);
});

await check("strict D1 detail envelope accepts documented object results", async () => {
  const decoded = await decodeCloudflareUsageResult(response({
    success: true,
    errors: [],
    messages: [],
    result: { uuid: "d1-example", file_size: 0, read_replication: { mode: "auto" } },
  }), { expectedResultKind: "object" });
  assert.equal(decoded.result.uuid, "d1-example");
  assert.equal(decoded.result.file_size, 0);
  assert.equal(decoded.resultInfo, null);
});

await check("shared bounded JSON reader exposes parsed GraphQL bodies to strict callers", async () => {
  const graphqlBody = { data: { viewer: { accounts: [] } }, errors: null };
  const decoded = await decodeCloudflareUsageJson(response(graphqlBody));
  assert.equal(decoded.httpStatus, 200);
  assert.deepEqual(decoded.body, graphqlBody);
  assert.equal(Object.isFrozen(decoded), true);
});

await check("unknown response envelope fields fail closed without echo", async () => {
  await expectDecodeFailure(
    decodeCloudflareUsageResult(response({ success: true, errors: [], messages: [], result: [], raw_secret: "bearer-should-not-leak" }), { expectedResultKind: "array" }),
    "MALFORMED",
    ["raw_secret", "bearer-should-not-leak"],
  );
});

await check("unknown result_info fields fail closed", async () => {
  await expectDecodeFailure(
    decodeCloudflareUsageResult(response({
      success: true,
      errors: [],
      messages: [],
      result: [],
      result_info: { count: 0, next_cursor: "unrecognized" },
    }), { expectedResultKind: "array" }),
    "MALFORMED",
    ["unrecognized"],
  );
});

await check("documented Cloudflare error fields are validated and never echoed", async () => {
  await expectDecodeFailure(
    decodeCloudflareUsageResult(response({
      success: false,
      errors: [{ code: 10000, message: "token-secret and private provider detail", documentation_url: "https://example.invalid/docs" }],
      messages: [],
    }), { expectedResultKind: "object" }),
    "HTTP_RESPONSE_ERROR",
    ["token-secret", "private provider detail", "example.invalid"],
  );
  await expectDecodeFailure(
    decodeCloudflareUsageResult(response({ success: true, errors: [{ code: "bad", message: "secret" }], result: {} }), { expectedResultKind: "object" }),
    "MALFORMED",
    ["secret"],
  );
});

await check("D1 REST response requires its documented errors and messages arrays", async () => {
  await expectDecodeFailure(
    decodeCloudflareUsageResult(response({ success: true, result: [] }), { expectedResultKind: "array" }),
    "MALFORMED",
  );
});

await check("HTTP failures use status-only classification and do not read bodies", async () => {
  const denied = new Response("bearer-secret raw body", { status: 403 });
  await expectDecodeFailure(decodeCloudflareUsageResult(denied, { expectedResultKind: "object" }), "HTTP_FORBIDDEN", ["bearer-secret", "raw body"]);
});

await check("oversized UTF-8 body is rejected before JSON decoding", async () => {
  const body = { success: true, result: { text: "éééé" } };
  await expectDecodeFailure(
    decodeCloudflareUsageResult(response(body), { expectedResultKind: "object", maxBytes: 16 }),
    "MALFORMED",
    ["é"],
  );
});

await check("malformed JSON and wrong result type fail closed", async () => {
  await expectDecodeFailure(decodeCloudflareUsageResult(new Response("not-json", { status: 200 }), { expectedResultKind: "object" }), "MALFORMED", ["not-json"]);
  await expectDecodeFailure(decodeCloudflareUsageResult(response({ success: true, errors: [], messages: [], result: {} }), { expectedResultKind: "array" }), "MALFORMED");
});

await check("response stream faults become unknown gaps without error text", async () => {
  const body = new ReadableStream({ pull() { throw new Error("private stream failure"); } });
  await expectDecodeFailure(
    decodeCloudflareUsageResult({ status: 200, body }, { expectedResultKind: "object" }),
    "HTTP_BODY_READ_UNKNOWN",
    ["private stream failure"],
  );
});

await check("throwing platform accessors and detached stream chunks stay redacted", async () => {
  const secret = "bearer-private-platform-fault";
  const badStatus = {};
  Object.defineProperty(badStatus, "status", { get() { throw new Error(secret); } });
  await expectDecodeFailure(decodeCloudflareUsageJson(badStatus), "HTTP_STATUS_UNKNOWN", [secret]);

  const badBody = { status: 200 };
  Object.defineProperty(badBody, "body", { get() { throw new Error(secret); } });
  await expectDecodeFailure(decodeCloudflareUsageJson(badBody), "HTTP_BODY_READ_UNKNOWN", [secret]);

  const chunk = new Uint8Array([1, 2, 3, 4]);
  const originalLength = chunk.byteLength;
  Object.defineProperty(chunk, "byteLength", {
    get() {
      globalThis.structuredClone(chunk.buffer, { transfer: [chunk.buffer] });
      return originalLength;
    },
  });
  const changingBody = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  await expectDecodeFailure(
    decodeCloudflareUsageJson({ status: 200, body: changingBody }),
    "HTTP_BODY_READ_UNKNOWN",
    [secret],
  );
});

console.log(`Usage source decoder: ${cases} cases PASS`);
