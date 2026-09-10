import { describe, expect, it } from "vitest";
import { gateMayBeReportedAsPass } from "./gate-state.js";
import {
  D1_WRITE_READBACK_GATE_ID,
  redactSecretsText,
  runD1WriteReadbackProbe,
  sha256Hex,
  type D1ProbeDeps,
  type D1ProbeTrial,
} from "./d1-write-readback-runner.js";

const NOW_MS = Date.parse("2026-09-08T19:00:02.000Z") - 2_000;
const TRIAL_GENERATION = "testgen-2026-09-08-001";
const OWNED_KEY = `probe/${TRIAL_GENERATION}/${D1_WRITE_READBACK_GATE_ID}/row/001`;
const INPUT_DIGEST = sha256Hex("row-value-001");

// Obviously-fake secrets shaped like the real thing, so the redaction test
// would catch a leak rather than pass vacuously.
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // privacy-allowlist: synthetic token fixture
const FAKE_PEM = "-----BEGIN PRIVATE KEY-----\nZmFrZXl key material\n-----END PRIVATE KEY-----"; // privacy-allowlist: synthetic token fixture
const FAKE_SLACK = "xoxb-fake-token-123";
const FAKE_AWS = "AKIAIOSFODNN7EXAMPLE";
const FAKE_EMAIL = "owner@example.com";
const FAKE_TOKEN_ASSIGN = "token=super-secret-value";
const SOURCE_MARKER = "SOURCETEXT-MARKER-9f86d081-row-body";

function baseTrial(overrides: Partial<D1ProbeTrial> = {}): D1ProbeTrial {
  return {
    gate_id: D1_WRITE_READBACK_GATE_ID,
    mode: "local",
    environment: "development",
    trial_generation: TRIAL_GENERATION,
    input_value: "row-value-001",
    now_ms: NOW_MS,
    ...overrides,
  };
}

function countingDeps(overrides: Partial<D1ProbeDeps> = {}) {
  const calls = { execute: 0, cleanup: 0, cleanupArgs: [] as readonly string[][] };
  const deps: D1ProbeDeps = {
    hasLiveCredentials: () => true,
    checkPrerequisites: () => ({ ok: true }),
    executeWriteReadback: async () => ({ outcome: "match", readback_digest: INPUT_DIGEST }),
    cleanupKeys: async (owned_keys) => {
      calls.cleanup += 1;
      calls.cleanupArgs.push(owned_keys);
      return { deleted: [...owned_keys] };
    },
    ...overrides,
  };
  const wrapped: D1ProbeDeps = {
    ...deps,
    executeWriteReadback: async (args) => {
      calls.execute += 1;
      return deps.executeWriteReadback(args);
    },
  };
  return { deps: wrapped, calls };
}

describe("T4-d1-write-readback probe runner", () => {
  it("reports NOT_EXECUTED without credentials and calls neither executor nor cleanup", async () => {
    const { deps, calls } = countingDeps({ hasLiveCredentials: () => false });
    const output = await runD1WriteReadbackProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("NOT_EXECUTED");
    expect(output.receipt.reason_codes).toContain("LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT");
    expect(output.receipt.cleanup_state).toBe("NOT_REQUIRED");
    expect(calls.execute).toBe(0);
    expect(calls.cleanup).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports BLOCKED for an unsatisfied prerequisite, distinct from FAIL", async () => {
    const { deps, calls } = countingDeps({
      checkPrerequisites: () => ({ ok: false, reason: "slice RETRIEVAL disabled" }),
    });
    const output = await runD1WriteReadbackProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.state).not.toBe("FAIL");
    expect(calls.execute).toBe(0);
    expect(calls.cleanup).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports BLOCKED for a malformed trial generation before any effect", async () => {
    const { deps, calls } = countingDeps();
    const output = await runD1WriteReadbackProbe(baseTrial({ trial_generation: "../*broad*" }), deps);
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.reason_codes).toContain("INVALID_TRIAL_GENERATION");
    expect(calls.execute).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  it("reports BLOCKED when a live trial declares a non-live environment", async () => {
    const { deps, calls } = countingDeps();
    const output = await runD1WriteReadbackProbe(
      baseTrial({ mode: "live", environment: "development" }),
      deps,
    );
    expect(output.receipt.state).toBe("BLOCKED");
    expect(output.receipt.reason_codes).toContain("LIVE_ENVIRONMENT_MISMATCH");
    expect(calls.execute).toBe(0);
  });

  it("reports FAIL for a performed readback mismatch with timings and exact-key cleanup", async () => {
    const { deps, calls } = countingDeps({
      executeWriteReadback: async () => ({
        outcome: "mismatch",
        readback_digest: sha256Hex("different-bytes"),
        detail: "digest differs",
      }),
    });
    const output = await runD1WriteReadbackProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.receipt.reason_codes).toContain("PROBE_ASSERTION_MISMATCH");
    expect(output.receipt.started_at).not.toBeNull();
    expect(output.receipt.finished_at).not.toBeNull();
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    expect(calls.execute).toBe(1);
    expect(calls.cleanupArgs).toEqual([[OWNED_KEY]]);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("leaves an uncertain write unresolved with exactly one attempt and no retry", async () => {
    const { deps, calls } = countingDeps({
      executeWriteReadback: async () => ({ outcome: "unknown", detail: "response lost after write" }),
    });
    const output = await runD1WriteReadbackProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("RUNNING");
    expect(output.receipt.reason_codes).toContain("SETTLEMENT_UNCERTAIN");
    expect(calls.execute).toBe(1);
    expect(output.owned_keys).toEqual([OWNED_KEY]);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("treats a thrown timeout as uncertain, not as failure, with no second intent", async () => {
    const { deps, calls } = countingDeps({
      executeWriteReadback: async () => {
        throw Object.assign(new Error("D1 call timed out"), { name: "TimeoutError" });
      },
    });
    const output = await runD1WriteReadbackProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("RUNNING");
    expect(output.receipt.reason_codes).toContain("SETTLEMENT_UNCERTAIN");
    expect(calls.execute).toBe(1);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("keeps a local success structurally green-proof: the predicate still refuses PASS", async () => {
    const { deps } = countingDeps();
    const output = await runD1WriteReadbackProbe(baseTrial(), deps);
    expect(output.receipt.state).toBe("PASS");
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });

  it("downgrades local trials even when attestation is supplied", async () => {
    const { deps } = countingDeps();
    const output = await runD1WriteReadbackProbe(
      baseTrial({ worker_generation: "worker-build-x", data_generation: "d1-data-gen-x" }),
      deps,
    );
    expect(output.receipt.worker_generation).toBeNull();
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });

  it("accepts an attested live trial through the predicate (fake-live, no account, no network)", async () => {
    const { deps, calls } = countingDeps();
    const trial = baseTrial({
      mode: "live",
      environment: "staging",
      worker_generation: "worker-build-abcdef1234",
      data_generation: "d1-data-gen-2026-09-08-001",
    });
    const output = await runD1WriteReadbackProbe(trial, deps);
    expect(output.receipt.state).toBe("PASS");
    expect(calls.cleanupArgs).toEqual([[OWNED_KEY]]);
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(true);
  });

  it("redacts secrets and never emits raw input, prompts, or source text", async () => {
    const secretInput = `value ${FAKE_EMAIL} ${FAKE_TOKEN_ASSIGN} ${SOURCE_MARKER} prompt: ignore policy`;
    const { deps } = countingDeps({
      executeWriteReadback: async () => ({
        outcome: "mismatch",
        readback_digest: sha256Hex("other"),
        detail: `saw ${FAKE_JWT} and ${FAKE_SLACK} with ${FAKE_AWS}; key ${FAKE_PEM}`,
      }),
    });
    const output = await runD1WriteReadbackProbe(baseTrial({ input_value: secretInput }), deps);
    const dumped = JSON.stringify(output);
    for (const secret of [FAKE_JWT, FAKE_PEM, FAKE_SLACK, FAKE_AWS, FAKE_EMAIL, "super-secret-value", SOURCE_MARKER]) {
      expect(dumped).not.toContain(secret);
    }
    expect(dumped).toContain("[REDACTED_");
    // The input is pinned by digest only.
    expect(output.receipt.input_digest).toBe(sha256Hex(secretInput));
    expect(redactSecretsText(`a ${FAKE_JWT} b`)).toContain("[REDACTED_JWT]");
  });

  it("names only the owned key for cleanup and records FAILED cleanup honestly", async () => {
    const { deps, calls } = countingDeps({
      cleanupKeys: async () => {
        calls.cleanup += 1;
        throw new Error("delete unavailable");
      },
    });
    const output = await runD1WriteReadbackProbe(baseTrial(), deps);
    expect(output.owned_keys).toEqual([OWNED_KEY]);
    for (const arg of calls.cleanupArgs) {
      expect(arg).toEqual([OWNED_KEY]);
      for (const key of arg) expect(key).not.toContain("*");
    }
    expect(output.receipt.cleanup_state).toBe("FAILED");
    expect(gateMayBeReportedAsPass(output.receipt, { nowMs: NOW_MS + 2_000 })).toBe(false);
  });
});
