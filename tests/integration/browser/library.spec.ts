import assert from "node:assert/strict";
import { test } from "node:test";

type E2EReceipt = {
  readonly isolated_setup: string;
  readonly unauth_denied: string;
  readonly authorized_library: string;
  readonly persistence: string;
  readonly logout: string;
  readonly teardown: string;
  readonly console_errors: string;
  readonly failed_startup: string;
  readonly storage: string;
  readonly bounds: string;
  readonly controlled_issuer: string;
  readonly live: string;
  readonly browser: unknown;
};

async function loadHarness(): Promise<{ runOwnerE2E: () => Promise<E2EReceipt> }> {
  const module = (await import("./owner-e2e.mjs")) as unknown as {
    runOwnerE2E: () => Promise<E2EReceipt>;
  };
  return module;
}

test("L1 real-browser owner harness: isolated Worker/PWA, denial, persistence, teardown, errors, storage, bounds", async () => {
  const harness = await loadHarness();
  const receipt = await harness.runOwnerE2E();
  assert.equal(receipt.isolated_setup, "PASS", "fresh isolated setup with all migrations must pass");
  assert.equal(receipt.unauth_denied, "PASS", "unauthenticated catalog must be 401 with no private UI");
  assert.equal(receipt.authorized_library, "NOT_EXECUTED", "authorized Library requires live Access login; fixture must not count");
  assert.equal(receipt.persistence, "PASS", "Worker restart must preserve generation and serve again");
  assert.equal(receipt.logout, "NOT_EXECUTED", "bridge logout requires a live session; must not fake PASS");
  assert.equal(receipt.teardown, "PASS", "teardown must spare unrelated dev DBs");
  assert.equal(receipt.console_errors, "PASS", "explicit console/page errors must be empty");
  assert.equal(receipt.failed_startup, "PASS", "partial/failed startup must clean up with no false-running Worker");
  assert.equal(receipt.storage, "PASS", "browser storage must hold no credentials/source bytes/private responses");
  assert.equal(receipt.bounds, "PASS", "64 files / 16MiB / 32MiB / 256KiB max and max+1 must hold");
  assert.equal(receipt.controlled_issuer, "PASS", "controlled RSA issuer negatives must pass without weakening verification");
  assert.equal(receipt.live, "NOT_EXECUTED", "remote/live remains NOT_EXECUTED");
  assert.ok(typeof receipt.browser === "string" && receipt.browser.length > 0, "real Chromium executable must be recorded");
  console.warn(`owner-e2e: ${receipt.isolated_setup}/${receipt.unauth_denied}/${receipt.authorized_library} live=${receipt.live}`);
});
