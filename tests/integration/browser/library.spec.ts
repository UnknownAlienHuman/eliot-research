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
  readonly authed_epoch_regression: string;
  readonly controlled_issuer: string;
  readonly seam_rejection: string;
  readonly browser_pairing: string;
  readonly browser_logout: string;
  readonly evidence_readback: string;
  readonly chromium_safe_ports: string;
  readonly worker_ports: string;
  readonly network_ledger: string;
  readonly ledger_negative: string;
  readonly jwt_negatives: string;
  readonly jwks_rotation: string;
  readonly browser_jwt_matrix: string;
  readonly artifact_ledger: string;
  readonly cross_client_ledger: string;
  readonly exhaustive_workflow: string;
  readonly exhaustive_workflow_d1: string;
  readonly raw_file_capture: string;
  readonly raw_projection_fast_search: string;
  readonly early_cleanup: string;
  readonly teardown_inventory: unknown;
  readonly live: string;
  readonly browser: unknown;
};

type E2EHarness = {
  runOwnerE2E: () => Promise<E2EReceipt>;
  verifyPhaseLedgerIdentityRegression: () => { state: string };
  verifyServiceWorkerFinishedTerminalRegression: () => { state: string };
  verifyLedgerResetBoundaryRegression: () => { state: string };
  verifyServiceWorkerSettlementRegression: () => Promise<{ state: string }>;
  verifyReadbackRetryClassification: () => Promise<{ state: string }>;
  verifyEarlyFailureCleanup: () => Promise<{ state: string }>;
  verifyWorkerFetchDiagnosticRegression: () => Promise<{ state: string }>;
  assertWorkflowJobReadback: (bindings: readonly unknown[], jobs: readonly unknown[]) => { bindingCount: number; jobRowCount: number };
};

async function loadHarness(): Promise<E2EHarness> {
  return (await import("./owner-e2e.mjs")) as unknown as E2EHarness;
}

test("L6 phase ledger: exact request identity across service worker phases", async () => {
  const harness = await loadHarness();
  assert.equal(harness.verifyPhaseLedgerIdentityRegression().state, "PASS");
});

test("L6 phase settlement: wait for late service-worker update before freezing the ledger", async () => {
  const harness = await loadHarness();
  assert.equal((await harness.verifyServiceWorkerSettlementRegression()).state, "PASS");
});

test("L6 phase settlement: preserve exact metadata-null service-worker terminal", async () => {
  const harness = await loadHarness();
  assert.equal(harness.verifyServiceWorkerFinishedTerminalRegression().state, "PASS");
});

test("L6 phase reset: retain request identity until late response settles", async () => {
  const harness = await loadHarness();
  assert.equal(harness.verifyLedgerResetBoundaryRegression().state, "PASS");
});

test("L6 workflow D1 readback: allow early missing job but reject foreign owner rows", async () => {
  const harness = await loadHarness();
  const binding = {
    workflow_id: `exhaustive-workflow-${"a".repeat(64)}`,
    job_id: `exhaustive-job-${"b".repeat(48)}`,
    principal_ref: "e2e-owner",
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    deployment_generation: "deployment-1",
    request_identity_digest: "c".repeat(64),
    state: "CANCEL_REQUESTED",
  };
  const job = { job_id: binding.job_id, principal_ref: binding.principal_ref, client_class: binding.client_class,
    credential_generation: binding.credential_generation, state: "PENDING" };
  assert.deepEqual(harness.assertWorkflowJobReadback([binding], []), { bindingCount: 1, jobRowCount: 0 });
  assert.deepEqual(harness.assertWorkflowJobReadback([binding], [job]), { bindingCount: 1, jobRowCount: 1 });
  assert.throws(() => harness.assertWorkflowJobReadback([binding], [{ ...job, principal_ref: "foreign-owner" }]), /bound owner principal/u);
});

test("L6 readback retry: deterministic authority failures stop before any retry", async () => {
  const harness = await loadHarness();
  assert.equal((await harness.verifyReadbackRetryClassification()).state, "PASS");
});

test("L6 cleanup: marker creation failure removes its known-created directory", async () => {
  const harness = await loadHarness();
  assert.equal((await harness.verifyEarlyFailureCleanup()).state, "PASS");
});

test("L6 diagnostics: bounded Worker fetch errors preserve phase and redacted route context", async () => {
  const harness = await loadHarness();
  assert.equal((await harness.verifyWorkerFetchDiagnosticRegression()).state, "PASS");
});

test("L6 real-browser owner harness: isolated Worker/PWA, denial, authorized Library, persistence, logout, teardown, errors, storage, bounds", async () => {
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
  assert.equal(receipt.authed_epoch_regression, "PASS", "superseded-epoch abort exemptions with sole-abort/duplicate-bound negatives must pass");
  assert.equal(receipt.controlled_issuer, "PASS", "in-memory RSA negatives + real-Worker verification must pass without weakening verification");
  assert.equal(receipt.seam_rejection, "PASS", "staging/production with identical test vars must fail config, never seam");
  assert.equal(receipt.evidence_readback, "PASS", "exact EVIDENCE_BUCKET canonical key must read back with digest/metadata");
  assert.ok(typeof receipt.browser_pairing === "string" && receipt.browser_pairing.startsWith("PASS"),
    "Chromium itself must pair via the one-time bridge flow with HttpOnly/SameSite cookie");
  assert.ok(typeof receipt.browser_logout === "string" && receipt.browser_logout.startsWith("PASS"),
    "Chromium itself must log out via browser-originated request with Set-Cookie clearing and exact 401");
  assert.equal(receipt.chromium_safe_ports, "PASS", "deterministic Chromium-safe port protocol (unsafe+collision retry, no leak) must pass");
  assert.ok(typeof receipt.network_ledger === "string" && receipt.network_ledger.startsWith("PASS"),
    "phase-aware full request/response ledger over all browser traffic must pass");
  assert.ok(typeof receipt.ledger_negative === "string" && receipt.ledger_negative.startsWith("PASS"),
    "injected unexpected browser response must trip the ledger closure");
  assert.ok(typeof receipt.jwt_negatives === "string" && receipt.jwt_negatives.startsWith("PASS"),
    "real-browser JWT/JWKS negatives with zero D1 mutation must pass");
  assert.ok(typeof receipt.worker_ports === "string" && receipt.worker_ports.startsWith("PASS"),
    "every real Worker start must bind an explicit Chromium-safe port with bounded reselect evidence");
  assert.ok(typeof receipt.jwks_rotation === "string" && receipt.jwks_rotation.startsWith("PASS"),
    "real JWKS key rollover (old denied, new allowed, Chromium re-pairing) must pass");
  assert.ok(typeof receipt.browser_jwt_matrix === "string" && receipt.browser_jwt_matrix.startsWith("PASS"),
    "Chromium page.evaluate JWT matrix with zero D1/R2 mutation must pass");
  assert.ok(typeof receipt.artifact_ledger === "string" && receipt.artifact_ledger.startsWith("PASS"),
    "browser-originated artifact lifecycle with replay must be fully asserted");
  assert.ok(typeof receipt.cross_client_ledger === "string" && receipt.cross_client_ledger.startsWith("PASS"),
    "cross-client ledger must be gapless, ordered and free of JWT material");
  assert.ok(typeof receipt.exhaustive_workflow === "string" && receipt.exhaustive_workflow.startsWith("PASS"),
    "real PWA exhaustive launch/status/cancel/reload/discovery/recovery must pass");
  assert.ok(typeof receipt.exhaustive_workflow_d1 === "string" && receipt.exhaustive_workflow_d1.startsWith("PASS"),
    "stopped Worker D1 readback must retain workflow/job binding and cancellation intent");
  assert.ok(typeof receipt.raw_file_capture === "string" && receipt.raw_file_capture.startsWith("PASS"),
    "real browser raw upload must settle one capture, recover by idempotency and read back original R2 bytes");
  assert.ok(typeof receipt.raw_projection_fast_search === "string" && receipt.raw_projection_fast_search.startsWith("PASS"),
    "real scheduled Queue projection and Chromium FAST_SEARCH readback must pass");
  assert.equal(receipt.early_cleanup, "PASS", "forced early-migration failure must leave zero run-owned residue");
  assert.ok(receipt.teardown_inventory !== null && typeof receipt.teardown_inventory === "object",
    "immutable before/after teardown inventories must be recorded");
  assert.equal(receipt.live, "NOT_EXECUTED", "remote/live remains NOT_EXECUTED");
  assert.ok(typeof receipt.browser === "string" && receipt.browser.length > 0, "real Chromium executable must be recorded");
  console.warn(`owner-e2e: ${receipt.isolated_setup}/${receipt.unauth_denied}/${receipt.authorized_library}/${receipt.logout} live=${receipt.live}`);
});
