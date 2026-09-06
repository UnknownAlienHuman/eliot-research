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
  assert.equal(receipt.authorized_library, "NOT_EXECUTED", "positive owner Library needs the ER-44->ER-24->ER-00 JWKS seam + ER-17 review; L1 must not fake PASS");
  assert.equal(receipt.persistence, "PASS", "Worker restart must preserve ledgers/namespace/generation and serve again with no private residue");
  assert.equal(receipt.logout, "NOT_EXECUTED", "authed bridge logout needs the same JWKS seam; unauth logout guard is proven, authed flow must not fake PASS");
  assert.equal(receipt.teardown, "PASS", "teardown must spare unrelated dev DBs");
  assert.equal(receipt.console_errors, "PASS", "Playwright console (beyond expected 401 denial noise)/pageerror/failed-request must be empty");
  assert.equal(receipt.failed_startup, "PASS", "real failed start must leave no owned Worker/port/profile behind");
  assert.equal(receipt.storage, "PASS", "pinned Playwright browser storage must hold no JWT/source bytes/private responses");
  assert.equal(receipt.bounds, "PASS", "64 files / 16MiB / 32MiB / 256KiB max and max+1 must hold");
  assert.equal(receipt.controlled_issuer, "PASS", "in-memory RSA negatives + real-Worker denial must pass without weakening verification");
  assert.equal(receipt.live, "NOT_EXECUTED", "remote/live remains NOT_EXECUTED");
  assert.ok(typeof receipt.browser === "string" && receipt.browser.length > 0, "real Chromium executable must be recorded");
  console.warn(`owner-e2e: ${receipt.isolated_setup}/${receipt.unauth_denied}/${receipt.authorized_library} live=${receipt.live}`);
});
