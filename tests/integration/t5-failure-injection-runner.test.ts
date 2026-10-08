import { describe, expect, it } from "vitest";
import { gateMayBeReportedAsPass } from "./gate-state.js";
import {
  T5_FAILURE_INJECTION_GATE_ID,
  redactFaultText,
  runT5FailureInjectionProbe,
  sha256HexFault,
  type FaultClass,
  type FaultHandling,
  type FaultHandlingReport,
  type T5FailureInjectionDeps,
  type T5FailureInjectionTrial,
} from "./t5-failure-injection-runner.js";

const NOW_MS = Date.parse("2026-10-01T11:00:02.000Z") - 2_000;
const TRIAL_GENERATION = "testgen-2026-10-01-001";
const FAULT_CLASSES: readonly FaultClass[] = [
  "d1-write-error",
  "r2-readback-mismatch",
  "queue-duplicate-delivery",
  "model-timeout",
  "ledger-conflict",
];
const OWNED_KEYS = FAULT_CLASSES.map(
  (fault_class) => `probe/${TRIAL_GENERATION}/${T5_FAILURE_INJECTION_GATE_ID}/${fault_class}/001`,
);
const INPUT_DIGEST = sha256HexFault(FAULT_CLASSES.join(","));
const EVIDENCE = sha256HexFault("negative-receipt-evidence-001");

// Obviously-fake secrets shaped like the real thing, so the redaction test
// would catch a leak rather than pass vacuously.
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // privacy-allowlist: synthetic token fixture
const FAKE_EMAIL = "owner@example.com";
const FAKE_TOKEN_ASSIGN = "token=super-secret-value";

function baseTrial(overrides: Partial<T5FailureInjectionTrial> = {}): T5FailureInjectionTrial {
  return {
    gate_id: T5_FAILURE_INJECTION_GATE_ID,
    mode: "local",
    environment: "development",
    trial_generation: TRIAL_GENERATION,
    now_ms: NOW_MS,
    ...overrides,
  };
}

function goodReport(handling: FaultHandling, detail = "fault handled"): FaultHandlingReport {
  return { handling, evidence_digest: EVIDENCE, detail };
}

type ProbeFn = (args: { key: string; input_digest: string }) => Promise<FaultHandlingReport>;

function countingDeps(overrides: Partial<T5FailureInjectionDeps> = {}) {
  const calls: Record<FaultClass, number> & {
    cleanup: number;
    cleanupArgs: string[][];
    probeArgs: { fault_class: FaultClass; key: string; input_digest: string }[];
  } = {
    "d1-write-error": 0,
    "r2-readback-mismatch": 0,
    "queue-duplicate-delivery": 0,
    "model-timeout": 0,
    "ledger-conflict": 0,
    cleanup: 0,
    cleanupArgs: [],
    probeArgs: [],
  };
  // Overrides are applied to the inner probe first, then wrapped: every
  // invocation is counted exactly once, including overridden probes.
  const defaults: Record<FaultClass, ProbeFn> = {
    "d1-write-error": async () => goodReport("failed-closed", "write rejected, nothing committed"),
    "r2-readback-mismatch": async () => goodReport("failed-closed", "digest mismatch detected"),
    "queue-duplicate-delivery": async () => goodReport("failed-closed", "duplicate deduped by idempotency key"),
    "model-timeout": async () => goodReport("uncertain", "settlement unknown, single attempt, no retry"),
    "ledger-conflict": async () => goodReport("failed-closed", "conflicting append rejected"),
  };
  const methodFor: Record<FaultClass, keyof T5FailureInjectionDeps> = {
    "d1-write-error": "probeD1WriteError",
    "r2-readback-mismatch": "probeR2ReadbackMismatch",
    "queue-duplicate-delivery": "probeQueueDuplicateDelivery",
    "model-timeout": "probeModelTimeout",
    "ledger-conflict": "probeLedgerConflict",
  };
  const wrap = (fault_class: FaultClass): ProbeFn => {
    const inner = (overrides[methodFor[fault_class]] as ProbeFn | undefined) ?? defaults[fault_class];
    return async (args) => {
      calls[fault_class] += 1;
      calls.probeArgs.push({ fault_class, key: args.key, input_digest: args.input_digest });
      return inner(args);
    };
  };
  const deps: T5FailureInjectionDeps = {
    hasLiveCredentials: overrides.hasLiveCredentials ?? (() => true),
    checkPrerequisites: overrides.checkPrerequisites ?? (() => ({ ok: true })),
    probeD1WriteError: wrap("d1-write-error"),
    probeR2ReadbackMismatch: wrap("r2-readback-mismatch"),
    probeQueueDuplicateDelivery: wrap("queue-duplicate-delivery"),
    probeModelTimeout: wrap("model-timeout"),
    probeLedgerConflict: wrap("ledger-conflict"),
    cleanupKeys:
      overrides.cleanupKeys ??
      (async (owned_keys) => {
        calls.cleanup += 1;
        calls.cleanupArgs.push([...owned_keys]);
        return { deleted: [...owned_keys] };
      }),
  };
  return { deps, calls };
}

describe("T5-failure-injection probe", () => {
  it("PASS when every fault class fails closed (timeout surfaces uncertainty)", async () => {
    const { deps, calls } = countingDeps();
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("PASS");
    expect(out.receipt.reason_codes).toEqual([]);
    expect(out.receipt.gate_id).toBe(T5_FAILURE_INJECTION_GATE_ID);
    expect(out.receipt.test_id).toBe(T5_FAILURE_INJECTION_GATE_ID);
    expect(out.receipt.input_digest).toBe(INPUT_DIGEST);
    expect(out.receipt.redacted_receipt_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.receipt.cleanup_state).toBe("COMPLETE");
    expect(out.owned_keys).toEqual(OWNED_KEYS);
    expect(out.duration_ms).toBe(2_000);
    // Exactly one attempt per fault class: no retries.
    for (const fault_class of FAULT_CLASSES) expect(calls[fault_class]).toBe(1);
    expect(calls.cleanup).toBe(1);
    expect(calls.cleanupArgs[0]).toEqual(OWNED_KEYS);
    // Probes receive the exact owned key and the digest only — never raw input.
    expect(calls.probeArgs).toHaveLength(5);
    for (const probeArg of calls.probeArgs) {
      expect(OWNED_KEYS).toContain(probeArg.key);
      expect(probeArg.input_digest).toBe(INPUT_DIGEST);
      expect(Object.keys(probeArg).sort()).toEqual(["fault_class", "input_digest", "key"]);
    }
    // A local trial is structurally incapable of greening the live gate.
    expect(gateMayBeReportedAsPass(out.receipt)).toBe(false);
  });

  it("live trial with attestation can satisfy the pass predicate structurally", async () => {
    const { deps } = countingDeps();
    const out = await runT5FailureInjectionProbe(
      baseTrial({
        mode: "live",
        environment: "staging",
        worker_generation: "worker-gen-001",
        data_generation: "data-gen-001",
      }),
      deps,
    );

    expect(out.receipt.state).toBe("PASS");
    expect(out.receipt.worker_generation).toBe("worker-gen-001");
    expect(out.receipt.data_generation).toBe("data-gen-001");
    expect(out.receipt.generation_ref).toBe("worker-gen-001");
    expect(
      gateMayBeReportedAsPass(out.receipt, { nowMs: NOW_MS + 2_000 + 1_000, maxAgeMs: 60_000 }),
    ).toBe(true);
  });

  it("FAIL when the D1 write error silently passes", async () => {
    const { deps, calls } = countingDeps({
      probeD1WriteError: async () => goodReport("silent-pass", "write reported success"),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    expect(out.receipt.reason_codes).toEqual(["FAULT_D1_WRITE_ERROR_UNHANDLED"]);
    expect(out.receipt.cleanup_state).toBe("COMPLETE");
    expect(out.receipt.redacted_receipt_ref).toBeNull();
    expect(calls["d1-write-error"]).toBe(1);
  });

  it("FAIL when the R2 readback mismatch partially commits", async () => {
    const { deps } = countingDeps({
      probeR2ReadbackMismatch: async () => goodReport("partial-commit", "altered bytes accepted into cache"),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    expect(out.receipt.reason_codes).toEqual(["FAULT_R2_READBACK_MISMATCH_UNHANDLED"]);
  });

  it("FAIL when the queue duplicate is double-applied", async () => {
    const { deps } = countingDeps({
      probeQueueDuplicateDelivery: async () => goodReport("partial-commit", "message applied twice"),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    expect(out.receipt.reason_codes).toEqual(["FAULT_QUEUE_DUPLICATE_DELIVERY_UNHANDLED"]);
  });

  it("FAIL when the model timeout is reported as success (uncertainty is required)", async () => {
    const { deps } = countingDeps({
      probeModelTimeout: async () => goodReport("silent-pass", "timed-out call reported successful"),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    expect(out.receipt.reason_codes).toEqual(["FAULT_MODEL_TIMEOUT_UNHANDLED"]);
  });

  it("FAIL when the ledger conflict commits the conflicting append", async () => {
    const { deps } = countingDeps({
      probeLedgerConflict: async () => goodReport("partial-commit", "conflicting entry overwrote the original"),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    expect(out.receipt.reason_codes).toEqual(["FAULT_LEDGER_CONFLICT_UNHANDLED"]);
  });

  it("FAIL when a negative receipt is not a well-formed pinned digest", async () => {
    const { deps } = countingDeps({
      probeLedgerConflict: async () => ({ handling: "failed-closed", evidence_digest: "not-a-digest", detail: "ok" }),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    expect(out.receipt.reason_codes).toEqual(["FAULT_NEGATIVE_RECEIPT_MALFORMED"]);
  });

  it("FAIL when a handling value is outside the known union", async () => {
    const { deps } = countingDeps({
      probeD1WriteError: async () =>
        ({ handling: "recovered", evidence_digest: EVIDENCE, detail: "ok" }) as unknown as FaultHandlingReport,
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    expect(out.receipt.reason_codes).toEqual(["FAULT_NEGATIVE_RECEIPT_MALFORMED"]);
  });

  it("RUNNING with SETTLEMENT_UNCERTAIN when a probe throws a timeout, exactly one attempt, no retry", async () => {
    const { deps, calls } = countingDeps({
      probeModelTimeout: async () => {
        const error = new Error("model call timed out");
        error.name = "TimeoutError";
        throw error;
      },
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("RUNNING");
    expect(out.receipt.reason_codes).toEqual(["SETTLEMENT_UNCERTAIN"]);
    expect(calls["model-timeout"]).toBe(1);
    // Remaining classes are not probed after uncertainty; cleanup still runs.
    expect(calls["ledger-conflict"]).toBe(0);
    expect(calls.cleanup).toBe(1);
    expect(out.receipt.cleanup_state).toBe("COMPLETE");
  });

  it("FAIL with PROBE_TRANSPORT_ERROR when a probe throws a non-timeout error", async () => {
    const { deps } = countingDeps({
      probeD1WriteError: async () => {
        throw new Error("connection refused");
      },
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    expect(out.receipt.reason_codes).toEqual(["PROBE_TRANSPORT_ERROR"]);
  });

  it("NOT_EXECUTED when credentials are absent and no probe runs", async () => {
    const { deps, calls } = countingDeps({ hasLiveCredentials: () => false });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("NOT_EXECUTED");
    expect(out.receipt.reason_codes).toEqual(["LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT"]);
    expect(out.receipt.cleanup_state).toBe("NOT_REQUIRED");
    expect(out.owned_keys).toEqual([]);
    for (const fault_class of FAULT_CLASSES) expect(calls[fault_class]).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  it("BLOCKED when a prerequisite is unsatisfied", async () => {
    const { deps, calls } = countingDeps({
      checkPrerequisites: () => ({ ok: false, reason: "fault injector not armed" }),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("BLOCKED");
    expect(out.receipt.reason_codes).toEqual(["PROBE_PREREQUISITE_UNSATISFIED"]);
    for (const fault_class of FAULT_CLASSES) expect(calls[fault_class]).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  it("BLOCKED before any effect when the trial generation is malformed", async () => {
    const { deps, calls } = countingDeps();
    const out = await runT5FailureInjectionProbe(baseTrial({ trial_generation: "BAD GENERATION!!" }), deps);

    expect(out.receipt.state).toBe("BLOCKED");
    expect(out.receipt.reason_codes).toEqual(["INVALID_TRIAL_GENERATION"]);
    for (const fault_class of FAULT_CLASSES) expect(calls[fault_class]).toBe(0);
    expect(calls.cleanup).toBe(0);
  });

  it("BLOCKED when a live trial declares a non-live environment", async () => {
    const { deps, calls } = countingDeps();
    const out = await runT5FailureInjectionProbe(baseTrial({ mode: "live", environment: "development" }), deps);

    expect(out.receipt.state).toBe("BLOCKED");
    expect(out.receipt.reason_codes).toEqual(["LIVE_ENVIRONMENT_MISMATCH"]);
    for (const fault_class of FAULT_CLASSES) expect(calls[fault_class]).toBe(0);
  });

  it("downgrades attestation on local trials even when supplied", async () => {
    const { deps } = countingDeps();
    const out = await runT5FailureInjectionProbe(
      baseTrial({ worker_generation: "worker-gen-001", data_generation: "data-gen-001" }),
      deps,
    );

    expect(out.receipt.state).toBe("PASS");
    expect(out.receipt.worker_generation).toBeNull();
    expect(out.receipt.data_generation).toBeNull();
    expect(out.receipt.generation_ref).toBeNull();
    expect(gateMayBeReportedAsPass(out.receipt)).toBe(false);
  });

  it("records FAILED cleanup when cleanup does not delete every owned key", async () => {
    const { deps } = countingDeps({
      cleanupKeys: async (owned_keys) => ({ deleted: owned_keys.slice(0, 4) }),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("PASS");
    expect(out.receipt.cleanup_state).toBe("FAILED");
    expect(gateMayBeReportedAsPass(out.receipt)).toBe(false);
  });

  it("records FAILED cleanup when cleanup throws", async () => {
    const { deps } = countingDeps({
      cleanupKeys: async () => {
        throw new Error("cleanup transport blew up");
      },
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("PASS");
    expect(out.receipt.cleanup_state).toBe("FAILED");
  });

  it("redacts secret-shaped text in the diagnostic log", async () => {
    const { deps } = countingDeps({
      probeR2ReadbackMismatch: async () => goodReport("partial-commit", `mismatch with ${FAKE_JWT} and ${FAKE_EMAIL} (${FAKE_TOKEN_ASSIGN})`),
    });
    const out = await runT5FailureInjectionProbe(baseTrial(), deps);

    expect(out.receipt.state).toBe("FAIL");
    const log = out.diagnostic_log.join("\n");
    expect(log).toContain("[REDACTED_JWT]");
    expect(log).toContain("[REDACTED_EMAIL]");
    expect(log).toContain("[REDACTED_CREDENTIAL]");
    expect(log).not.toContain(FAKE_JWT);
    expect(log).not.toContain(FAKE_EMAIL);
    expect(log).not.toContain("super-secret-value");
  });

  it("redactFaultText covers the standard secret shapes", () => {
    expect(redactFaultText(`bearer abcdef ${FAKE_EMAIL}`)).toBe("[REDACTED_BEARER] [REDACTED_EMAIL]");
    expect(redactFaultText("plain diagnostic detail")).toBe("plain diagnostic detail");
  });

  it("sha256HexFault pins digests deterministically", () => {
    expect(sha256HexFault("probe-input")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256HexFault("probe-input")).toBe(sha256HexFault("probe-input"));
  });
});
