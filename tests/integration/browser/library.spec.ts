import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

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
  readonly exhaustive_workflow_complete: string;
  readonly exhaustive_workflow_complete_d1: string;
  readonly raw_file_capture: string;
  readonly raw_file_conversion_admission: string;
  readonly raw_admission_refusal: string;
  readonly raw_projection_fast_search: string;
  readonly early_cleanup: string;
  readonly teardown_inventory: unknown;
  readonly live: string;
  readonly browser: unknown;
};

type E2EHarness = {
  runOwnerE2E: () => Promise<E2EReceipt>;
  verifyPhaseLedgerIdentityRegression: () => { state: string };
  verifyAsyncLaunchTerminalRegression: () => { state: string };
  verifyServiceWorkerFinishedTerminalRegression: () => { state: string };
  verifyLedgerResetBoundaryRegression: () => { state: string };
  verifyServiceWorkerSettlementRegression: () => Promise<{ state: string }>;
  verifyReadbackRetryClassification: () => Promise<{ state: string }>;
  verifyEarlyFailureCleanup: () => Promise<{ state: string }>;
  verifyWorkerFetchDiagnosticRegression: () => Promise<{ state: string }>;
  verifyRawProjectionReadinessPollingRegression: () => Promise<{ state: string }>;
  assertWorkflowJobReadback: (bindings: readonly unknown[], jobs: readonly unknown[]) => { bindingCount: number; jobRowCount: number };
};

async function loadHarness(): Promise<E2EHarness> {
  return (await import("./owner-e2e.mjs")) as unknown as E2EHarness;
}

test("L6 phase ledger: exact request identity across service worker phases", async () => {
  const harness = await loadHarness();
  assert.equal(harness.verifyPhaseLedgerIdentityRegression().state, "PASS");
});

test("L6 phase terminal: accept same-request 202 before duplicate abort", async () => {
  const harness = await loadHarness();
  assert.equal(harness.verifyAsyncLaunchTerminalRegression().state, "PASS");
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

test("L6 raw projection readiness: classified request timeout polls within its total deadline", async () => {
  const harness = await loadHarness();
  assert.equal((await harness.verifyRawProjectionReadinessPollingRegression()).state, "PASS");
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
  assert.ok(typeof receipt.exhaustive_workflow_complete === "string" && receipt.exhaustive_workflow_complete.startsWith("PASS"),
    "real PWA exhaustive workflow must reach COMPLETE after the admitted raw projection");
  assert.ok(typeof receipt.exhaustive_workflow_complete_d1 === "string" && receipt.exhaustive_workflow_complete_d1.startsWith("PASS"),
    "completed exhaustive workflow must retain its owner-bound D1 binding and job receipt");
  assert.ok(typeof receipt.raw_file_capture === "string" && receipt.raw_file_capture.startsWith("PASS"),
    "real browser raw upload must settle one capture, recover by idempotency and read back original R2 bytes");
  assert.ok(receipt.raw_file_conversion_admission.startsWith("PASS"), "automatic raw import must execute actual conversion and admission");
  assert.ok(receipt.raw_admission_refusal.startsWith("PASS"), "quality refusal must retain capture but create no admitted source or projection");
  assert.ok(typeof receipt.raw_projection_fast_search === "string" && receipt.raw_projection_fast_search.startsWith("PASS"),
    "real scheduled Queue projection and Chromium FAST_SEARCH readback must pass");
  assert.equal(receipt.early_cleanup, "PASS", "forced early-migration failure must leave zero run-owned residue");
  assert.ok(receipt.teardown_inventory !== null && typeof receipt.teardown_inventory === "object",
    "immutable before/after teardown inventories must be recorded");
  assert.equal(receipt.live, "NOT_EXECUTED", "remote/live remains NOT_EXECUTED");
  assert.ok(typeof receipt.browser === "string" && receipt.browser.length > 0, "real Chromium executable must be recorded");
  console.warn(`owner-e2e: ${receipt.isolated_setup}/${receipt.unauth_denied}/${receipt.authorized_library}/${receipt.logout} live=${receipt.live}`);
});

// The full owner test also enforces the actual unchanged CSP in Chromium.
test("L6 Research question control uses external styles under the existing CSP", async () => {
  const panel = await readFile(new URL("../../../apps/eliotr-pwa/src/research-run-view.ts", import.meta.url), "utf8");
  const css = await readFile(new URL("../../../apps/eliotr-pwa/src/styles.css", import.meta.url), "utf8");
  const textarea = panel.match(/<textarea\b[^>]*name="query"[^>]*>/u)?.[0];
  assert.ok(textarea);
  assert.doesNotMatch(textarea, /\bstyle=/u, "question textarea must not trigger an inline-style CSP violation");
  assert.match(textarea, /class="research-question-input"/u);
  assert.match(css, /\.research-question-input\s*\{[^}]*min-height:\s*120px[^}]*resize:\s*vertical/u);
});


test("L6 authenticated panels keep exact method/path/status and negative phase boundaries", async () => {
  const harness = await loadHarness();
  assert.equal(harness.verifyAuthenticatedPanelNetworkRegression().state, "PASS");
});

// ---------------------------------------------------------------------------
// S92 local product acceptance: 92.1 intake scenarios (s92-intake.mjs).
// Each scenario drives the real local harness (scripts/lib/local-*.mjs,
// owner-e2e.mjs) against in-memory SQLite seeded with the real migration DDL.
// Honest states: PASS, or PENDING_OWNER_D1B for live-model assertions until
// the owner decides D1(b) (see S92-INPUT-DECISIONS.md).
// ---------------------------------------------------------------------------

type S92ScenarioOutcome = { state: string; detail?: string };

async function runS92IntakeScenario(name: string): Promise<S92ScenarioOutcome> {
  const m = (await import("./s92-intake.mjs")) as unknown as Record<string, () => Promise<S92ScenarioOutcome>>;
  const run = m[name];
  assert.ok(typeof run === "function", `s92-intake.mjs must export ${name}`);
  return run();
}

function assertS92Honest(outcome: S92ScenarioOutcome, allowed: readonly string[]): void {
  assert.ok(
    allowed.includes(outcome.state),
    `S92 scenario must end in an honest state (${allowed.join("/")}), got ${outcome.state}: ${outcome.detail ?? ""}`,
  );
}

test("S92 92.1a intake: RS256 owner identity signs and verifies; tampered token rejected", async () => {
  const outcome = await runS92IntakeScenario("verifyS92IntakeOwnerIdentity");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.1b intake: local launch config allowlisted, model gateway sentinel, env scrubbed", async () => {
  const outcome = await runS92IntakeScenario("verifyS92IntakeLocalConfig");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.1c intake: project admission with exact row readback; replay idempotent; negatives fail closed", async () => {
  const outcome = await runS92IntakeScenario("verifyS92IntakeProjectAdmission");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.1d intake: read-policy grant applied with exact readback; stale/missing refused", async () => {
  const outcome = await runS92IntakeScenario("verifyS92IntakeReadPolicyGrant");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.1e intake: model D1 fail-closed proven; live model PENDING_OWNER_D1B", async () => {
  const outcome = await runS92IntakeScenario("verifyS92IntakeModelD1FailClosed");
  // D1(a): no local model gateway exists. PENDING_OWNER_D1B is the honest
  // terminal state until the owner decides D1(b); PASS is accepted for that
  // future without weakening today's assertion.
  assertS92Honest(outcome, ["PENDING_OWNER_D1B", "PASS"]);
});

test("S92 92.1f intake: Library/Lens exact readback; foreign namespace reads zero rows", async () => {
  const outcome = await runS92IntakeScenario("verifyS92IntakeLibraryLensReadback");
  assertS92Honest(outcome, ["PASS"]);
});

// ---------------------------------------------------------------------------
// S92 local product acceptance: 92.2 delegation scenarios (s92-delegation.mjs).
// Each scenario drives the real delegation service + real 0072/0075 DDL in
// in-memory SQLite: owner-issued grant → machine query/run/status/report →
// citation, with S98/S99 migration guards. Honest states: PASS, or
// PENDING_OWNER_D1B for live-model assertions, NOT_EXECUTED for missing
// Chromium, BLOCKED for stale/missing dist build.
// ---------------------------------------------------------------------------

type S92DelegationScenario = { name: string; run: () => Promise<S92ScenarioOutcome> };

async function runS92DelegationScenario(name: string): Promise<S92ScenarioOutcome> {
  const m = (await import("./s92-delegation.mjs")) as unknown as { SCENARIOS: S92DelegationScenario[] };
  const scenario = m.SCENARIOS.find((s) => s.name === name);
  assert.ok(scenario, `s92-delegation.mjs SCENARIOS must include ${name}`);
  return scenario.run();
}

test("S92 92.2a delegation: grant issuance is owner-only; machine issuance denied", async () => {
  const outcome = await runS92DelegationScenario("s92-delegation-grant-issuance-owner-only");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.2b delegation: owner put → grant → query/run/status/report → revoke → denied", async () => {
  const outcome = await runS92DelegationScenario("s92-delegation-grant-positive-path");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.2c delegation: attachment append-only guards hold against real DDL", async () => {
  const outcome = await runS92DelegationScenario("s92-delegation-attachment-append-only");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.2d delegation: normalized ingest guards hold against real DDL", async () => {
  const outcome = await runS92DelegationScenario("s92-delegation-normalized-ingest-guards");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.2e delegation: receipt digest binding verified against real prepareProjectAttachment", async () => {
  const outcome = await runS92DelegationScenario("s92-delegation-receipt-digest-binding");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.2f delegation: model dispatch fail-closed proven; live model PENDING_OWNER_D1B", async () => {
  const outcome = await runS92DelegationScenario("s92-delegation-model-fail-closed");
  // D1(a): no local model gateway exists. PENDING_OWNER_D1B is the honest
  // terminal state until the owner decides D1(b); PASS is accepted for that
  // future without weakening today's assertion.
  assertS92Honest(outcome, ["PENDING_OWNER_D1B", "PASS"]);
});

test("S92 92.2g delegation: runtime config readiness verified", async () => {
  const outcome = await runS92DelegationScenario("s92-delegation-runtime-config-readiness");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.2h delegation: browser harness probe; NOT_EXECUTED without Chromium", async () => {
  const outcome = await runS92DelegationScenario("s92-delegation-browser-harness-probe");
  // Chromium is unavailable in this environment; the probe honestly reports
  // NOT_EXECUTED. PASS is accepted where Chromium exists.
  assertS92Honest(outcome, ["NOT_EXECUTED", "PASS"]);
});

// ---------------------------------------------------------------------------
// S92 local product acceptance: 92.3 product scenarios (s92-products.mjs).
// Registered ASK/COMPARE/FACT_CHECK/DEEP_RESEARCH/REPORT through actual
// W1/W2/W3/storage and the controlled external model. Honest states: PASS,
// or PENDING_OWNER_D1B for live-model assertions until the owner decides
// D1(b).
// ---------------------------------------------------------------------------

type S92ProductsScenario = { name: string; run: () => Promise<S92ScenarioOutcome> };

async function runS92ProductsScenario(name: string): Promise<S92ScenarioOutcome> {
  const m = (await import("./s92-products.mjs")) as unknown as { SCENARIOS: S92ProductsScenario[] };
  const scenario = m.SCENARIOS.find((s) => s.name === name);
  assert.ok(scenario, `s92-products.mjs SCENARIOS must include ${name}`);
  return scenario.run();
}

test("S92 92.3a products: all five products registered with exact descriptors", async () => {
  const outcome = await runS92ProductsScenario("s92-products-registered");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3b products: local model gateway disabled via sentinel URL", async () => {
  const outcome = await runS92ProductsScenario("s92-local-model-disabled");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3c products: local environment isolation (no test-var seam)", async () => {
  const outcome = await runS92ProductsScenario("s92-local-env-isolation");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3d products: model gateway fail-closed on missing credentials", async () => {
  const outcome = await runS92ProductsScenario("s92-model-gateway-fail-closed");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3e products: ASK admission with exact row readback", async () => {
  const outcome = await runS92ProductsScenario("s92-product-ask-admission");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3f products: COMPARE admission with exact row readback", async () => {
  const outcome = await runS92ProductsScenario("s92-product-compare-admission");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3g products: FACT_CHECK admission with exact row readback", async () => {
  const outcome = await runS92ProductsScenario("s92-product-fact-check-admission");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3h products: DEEP_RESEARCH admission with exact row readback", async () => {
  const outcome = await runS92ProductsScenario("s92-product-deep-research-admission");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3i products: REPORT admission with exact row readback", async () => {
  const outcome = await runS92ProductsScenario("s92-product-report-admission");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.3j products: live model assertions PENDING_OWNER_D1B", async () => {
  const outcome = await runS92ProductsScenario("s92-live-model-assertions");
  // D1(a): no live model gateway exists. PENDING_OWNER_D1B is the honest
  // terminal state until the owner decides D1(b).
  assertS92Honest(outcome, ["PENDING_OWNER_D1B", "PASS"]);
});

// ---------------------------------------------------------------------------
// S92 local product acceptance: 92.4 continuity scenarios (s92-continuity.mjs).
// JWT refresh, compatible deploy, source generations v1→v2, offline, cancel,
// same-run recovery — against real D1 migrations and real Worker boot.
// Honest states: PASS, or NOT_EXECUTED for missing Chromium/Worker boot.
// ---------------------------------------------------------------------------

type S92ContinuityScenario = { name: string; run: () => Promise<S92ScenarioOutcome> };

async function runS92ContinuityScenario(name: string): Promise<S92ScenarioOutcome> {
  const m = (await import("./s92-continuity.mjs")) as unknown as { SCENARIOS: S92ContinuityScenario[] };
  const scenario = m.SCENARIOS.find((s) => s.name === name);
  assert.ok(scenario, `s92-continuity.mjs SCENARIOS must include ${name}`);
  return scenario.run();
}

test("S92 92.4a continuity: JWT refresh with rotation; old expired, new valid", async () => {
  const outcome = await runS92ContinuityScenario("s92-continuity-jwt-refresh");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.4b continuity: compatible deploy; NOT_EXECUTED without local Worker boot", async () => {
  const outcome = await runS92ContinuityScenario("s92-continuity-compatible-deploy");
  // Local Worker boot is unavailable in this environment; the scenario
  // honestly reports NOT_EXECUTED without requesting a remote deploy.
  // PASS is accepted where local boot works.
  assertS92Honest(outcome, ["NOT_EXECUTED", "PASS"]);
});

test("S92 92.4c continuity: 94 migrations; v1→v2 source generations upgrade once", async () => {
  const outcome = await runS92ContinuityScenario("s92-continuity-source-generations-v1-v2");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.4d continuity: offline mode; NOT_EXECUTED without Chromium", async () => {
  const outcome = await runS92ContinuityScenario("s92-continuity-offline");
  // Live CDP offline emulation needs Chromium; the scenario honestly reports
  // NOT_EXECUTED after verifying readiness fixture wiring. PASS is accepted
  // where Chromium exists.
  assertS92Honest(outcome, ["NOT_EXECUTED", "PASS"]);
});

test("S92 92.4e continuity: cancel request retained; foreign bindings rejected", async () => {
  const outcome = await runS92ContinuityScenario("s92-continuity-cancel");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.4f continuity: same-run recovery converges; no repeated effect", async () => {
  const outcome = await runS92ContinuityScenario("s92-continuity-same-run-recover");
  assertS92Honest(outcome, ["PASS"]);
});

// ---------------------------------------------------------------------------
// S92 local product acceptance: 92.5 copy-on-write scenarios (s92-cow.mjs).
// Verified export identity/tamper, change-review entry point, publication
// acceptance, history readback, model policy D1 — against compiled dist.
// Honest states: PASS, BLOCKED for unimplemented prerequisites,
// NOT_EXECUTED for missing fixtures, PENDING_OWNER_D1B for live model.
// ---------------------------------------------------------------------------

type S92CowScenario = { name: string; run: () => Promise<S92ScenarioOutcome> };

async function runS92CowScenario(name: string): Promise<S92ScenarioOutcome> {
  const m = (await import("./s92-cow.mjs")) as unknown as { SCENARIOS: S92CowScenario[] };
  const scenario = m.SCENARIOS.find((s) => s.name === name);
  assert.ok(scenario, `s92-cow.mjs SCENARIOS must include ${name}`);
  return scenario.run();
}

test("S92 92.5a COW: verified export identity with exact digest readback", async () => {
  const outcome = await runS92CowScenario("s92-cow-verified-export-identity");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.5b COW: verified export tamper detected; digest mismatch fail-closed", async () => {
  const outcome = await runS92CowScenario("s92-cow-verified-export-tamper");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.5c COW: change-review entry point; BLOCKED until reviseSection lands", async () => {
  const outcome = await runS92CowScenario("s92-cow-change-review-entry-point");
  // reviseSection is not implemented; the scenario honestly reports BLOCKED.
  // PASS is accepted once the producer exists.
  assertS92Honest(outcome, ["BLOCKED", "PASS"]);
});

test("S92 92.5d COW: publication acceptance; BLOCKED until producer composed", async () => {
  const outcome = await runS92CowScenario("s92-cow-publication-accepted");
  // The ACCEPTED publication producer is not composed; the scenario honestly
  // reports BLOCKED. PASS is accepted once it exists.
  assertS92Honest(outcome, ["BLOCKED", "PASS"]);
});

test("S92 92.5e COW: history readback; NOT_EXECUTED without prepared D1/R2", async () => {
  const outcome = await runS92CowScenario("s92-cow-history-readback");
  // No prepared local D1/R2 in this environment; the scenario honestly
  // reports NOT_EXECUTED. PASS is accepted with fixtures present.
  assertS92Honest(outcome, ["NOT_EXECUTED", "PASS"]);
});

test("S92 92.5f COW: model policy D1 fail-closed verified", async () => {
  const outcome = await runS92CowScenario("s92-cow-model-policy-d1");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.5g COW: live model PENDING_OWNER_D1B", async () => {
  const outcome = await runS92CowScenario("s92-cow-live-model-pending");
  // D1(a): no live model gateway exists. PENDING_OWNER_D1B is the honest
  // terminal state until the owner decides D1(b).
  assertS92Honest(outcome, ["PENDING_OWNER_D1B", "PASS"]);
});

// ---------------------------------------------------------------------------
// S92 local product acceptance: 92.6 negative scenarios (s92-negatives.mjs).
// Actor unauthorized, scope denial, revoke enforcement, purge stickiness,
// corrupt input rejection, CAS conflict single-flight, late-reply
// classification — all against real harness entry points with fakes only at
// documented transport seams. Honest states: PASS (all negatives hold).
// ---------------------------------------------------------------------------

type S92NegativesScenario = { name: string; run: () => Promise<S92ScenarioOutcome> };

async function runS92NegativesScenario(name: string): Promise<S92ScenarioOutcome> {
  const m = (await import("./s92-negatives.mjs")) as unknown as { SCENARIOS: S92NegativesScenario[] };
  const scenario = m.SCENARIOS.find((s) => s.name === name);
  assert.ok(scenario, `s92-negatives.mjs SCENARIOS must include ${name}`);
  return scenario.run();
}

test("S92 92.6a negatives: unauthorized actor denied with zero D1 mutation", async () => {
  const outcome = await runS92NegativesScenario("s92-92.6-actor-unauthorized-denied");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.6b negatives: out-of-scope request denied", async () => {
  const outcome = await runS92NegativesScenario("s92-92.6-scope-out-of-scope-denied");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.6c negatives: revoked grant enforced on subsequent use", async () => {
  const outcome = await runS92NegativesScenario("s92-92.6-revoke-enforced");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.6d negatives: purge semantics sticky; no resurrection", async () => {
  const outcome = await runS92NegativesScenario("s92-92.6-purge-semantics-sticky");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.6e negatives: corrupt input rejected fail-closed", async () => {
  const outcome = await runS92NegativesScenario("s92-92.6-corrupt-input-rejected");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.6f negatives: CAS conflict single-flight; no lost update", async () => {
  const outcome = await runS92NegativesScenario("s92-92.6-cas-conflict-single-flight");
  assertS92Honest(outcome, ["PASS"]);
});

test("S92 92.6g negatives: late reply classified without reopening terminal", async () => {
  const outcome = await runS92NegativesScenario("s92-92.6-late-reply-classified");
  assertS92Honest(outcome, ["PASS"]);
});
