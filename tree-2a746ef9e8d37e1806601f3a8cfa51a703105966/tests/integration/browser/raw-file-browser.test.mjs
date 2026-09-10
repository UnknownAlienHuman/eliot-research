import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForRawResponse } from "./raw-file-browser.mjs";
/* global Buffer:readonly, setTimeout:readonly */

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
