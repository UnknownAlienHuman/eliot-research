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
  readonly seam_rejection: string;
  readonly browser_pairing: string;
  readonly browser_logout: string;
  readonly evidence_readback: string;
  readonly live: string;
  readonly browser: unknown;
};

async function loadHarness(): Promise<{ runOwnerE2E: () => Promise<E2EReceipt> }> {
  const module = (await import("./owner-e2e.mjs")) as unknown as {
    runOwnerE2E: () => Promise<E2EReceipt>;
  };
  return module;
}

test("L1 real-browser owner harness: isolated Worker/PWA, denial, authorized Library, persistence, logout, teardown, errors, storage, bounds", async () => {
  const harness = await loadHarness();
  const receipt = await harness.runOwnerE2E();
  assert.equal(receipt.isolated_setup, "PASS", "fresh isolated setup with all migrations must pass");
  assert.equal(receipt.unauth_denied, "PASS", "unauthenticated catalog must be 401 with no private UI");
  assert.equal(receipt.authorized_library, "PASS", "signed owner Library through the real Worker/JWKS/bridge must pass");
  assert.equal(receipt.persistence, "PASS", "Worker restart must preserve ledgers/namespace/policy/source/revision/R2 and serve again");
  assert.equal(receipt.logout, "PASS", "bridge logout must clear cookie/state, deny private API and hide the Library source");
  assert.equal(receipt.teardown, "PASS", "teardown must spare unrelated dev DBs");
  assert.equal(receipt.console_errors, "PASS", "Playwright console/pageerror/failed-request must be empty beyond expected denial noise");
  assert.equal(receipt.failed_startup, "PASS", "real failed start must leave no owned Worker/port/profile behind");
  assert.equal(receipt.storage, "PASS", "pinned Playwright browser storage must hold no JWT/source bytes/private responses");
  assert.equal(receipt.bounds, "PASS", "64 files / 16MiB / 32MiB / 256KiB max and max+1 must hold");
  assert.equal(receipt.controlled_issuer, "PASS", "in-memory RSA negatives + real-Worker verification must pass without weakening verification");
  assert.equal(receipt.seam_rejection, "PASS", "staging/production with identical test vars must fail config, never seam");
  assert.equal(receipt.evidence_readback, "PASS", "exact EVIDENCE_BUCKET canonical key must read back with digest/metadata");
  assert.ok(typeof receipt.browser_pairing === "string" && receipt.browser_pairing.startsWith("PASS"),
    "Chromium itself must pair via the one-time bridge flow with HttpOnly/SameSite cookie");
  assert.ok(typeof receipt.browser_logout === "string" && receipt.browser_logout.startsWith("PASS"),
    "Chromium itself must log out via browser-originated request with Set-Cookie clearing and exact 401");
  assert.equal(receipt.live, "NOT_EXECUTED", "remote/live remains NOT_EXECUTED");
  assert.ok(typeof receipt.browser === "string" && receipt.browser.length > 0, "real Chromium executable must be recorded");
  console.warn(`owner-e2e: ${receipt.isolated_setup}/${receipt.unauth_denied}/${receipt.authorized_library}/${receipt.logout} live=${receipt.live}`);
});
