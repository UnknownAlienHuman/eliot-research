import { describe, expect, it } from "vitest";
import { gateMayBeReportedAsPass } from "./gate-state.js";
import {
  documentedInitialSloThresholds,
  runT6RepresentativeLoadTrial,
  summarizeLatencies,
  T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE,
  T6_LOAD_PROFILE,
  T6_REPRESENTATIVE_LOAD_GATE_ID,
  type T6LoadOpResult,
  type T6ProbeDeps,
  type T6RepresentativeLoadTrial,
} from "./t6-representative-load-runner.js";

const NOW_MS = Date.parse("2026-10-01T10:00:02.000Z") - 2_000;
const TRIAL_GENERATION = "testgen-2026-10-01-001";
const TOTAL_OPS = T6_LOAD_PROFILE.reduce((sum, spec) => sum + spec.op_count, 0);
const OWNED_KEY_PREFIX = `load/${TRIAL_GENERATION}/${T6_REPRESENTATIVE_LOAD_GATE_ID}/`;

// Obviously-fake secrets shaped like the real thing, so the redaction test
// would catch a leak rather than pass vacuously.
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // privacy-allowlist: synthetic token fixture
const FAKE_EMAIL = "owner@example.com";
const INPUT_VALUE = "canonical-load-seed-v1; FAKE-SECRET never emitted";

function baseTrial(overrides: Partial<T6RepresentativeLoadTrial> = {}): T6RepresentativeLoadTrial {
  return {
    gate_id: T6_REPRESENTATIVE_LOAD_GATE_ID,
    mode: "local",
    environment: "development",
    trial_generation: TRIAL_GENERATION,
    input_value: INPUT_VALUE,
    now_ms: NOW_MS,
    slo: { p95_ms: 500, error_rate: 0.05 },
    ...overrides,
  };
}

interface CallStats {
  execute: number;
  cleanup: number;
  cleanupArgs: Array<readonly string[]>;
  executorArgs: Array<{ key: string; kind: string; phase: string; op_index: number }>;
  maxInFlightByPhase: Map<string, number>;
}

function makeDeps(overrides: Partial<T6ProbeDeps> = {}): { deps: T6ProbeDeps; calls: CallStats } {
  const calls: CallStats = {
    execute: 0,
    cleanup: 0,
    cleanupArgs: [],
    executorArgs: [],
    maxInFlightByPhase: new Map(),
  };
  const inFlightByPhase = new Map<string, number>();
  const baseExecute: T6ProbeDeps["executeLoadOperation"] = async (args) => {
    calls.execute += 1;
    calls.executorArgs.push({ key: args.key, kind: args.kind, phase: args.phase, op_index: args.op_index });
    const current = (inFlightByPhase.get(args.phase) ?? 0) + 1;
    inFlightByPhase.set(args.phase, current);
    calls.maxInFlightByPhase.set(args.phase, Math.max(calls.maxInFlightByPhase.get(args.phase) ?? 0, current));
    // Yield so concurrent batch members genuinely overlap.
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlightByPhase.set(args.phase, current - 1);
    // Deterministic latency: op_index ms, so the percentile math is pinnable.
    return { outcome: "ok", latency_ms: args.op_index } satisfies T6LoadOpResult;
  };
  const deps: T6ProbeDeps = {
    hasLiveCredentials: () => true,
    checkPrerequisites: () => ({ ok: true }),
    executeLoadOperation: baseExecute,
    cleanupKeys: async (owned_keys) => {
      calls.cleanup += 1;
      calls.cleanupArgs.push(owned_keys);
      return { deleted: [...owned_keys] };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("T6-representative-load trial runner", () => {
  it("reports NOT_EXECUTED without credentials and calls neither executor nor cleanup", async () => {
    const { deps, calls } = makeDeps({ hasLiveCredentials: () => false });
    const output = await runT6RepresentativeLoadTrial(baseTrial(), deps);
    expect(output.receipt.state).toBe("NOT_EXECUTED");
    expect(output.receipt.reason_codes).toContain("LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT");
    expect(output.receipt.cleanup_state).toBe("NOT_REQUIRED");
    expect(output.slo_evaluation.verdict).toBe("NOT_EVALUATED");
    expect(calls.execute).toBe(0);
    expect(calls.cleanup).toBe(0);
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("fails closed without SLO thresholds: BLOCKED before any load is executed", async () => {
    for (const slo of [null, undefined]) {
      const { deps, calls } = makeDeps();
      const output = await runT6RepresentativeLoadTrial(baseTrial({ slo }), deps);
      expect(output.receipt.state).toBe("BLOCKED");
      expect(output.receipt.state).not.toBe("PASS");
      expect(output.receipt.reason_codes).toContain("SLO_THRESHOLDS_NOT_PROVIDED");
      expect(output.receipt.cleanup_state).toBe("NOT_REQUIRED");
      expect(output.slo_evaluation.verdict).toBe("NOT_EVALUATED");
      expect(calls.execute).toBe(0);
      expect(calls.cleanup).toBe(0);
      expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
    }
  });

  it("fails closed on invalid SLO thresholds (negative p95, out-of-range error_rate)", async () => {
    const bad: Array<T6RepresentativeLoadTrial["slo"]> = [
      { p95_ms: -1, error_rate: 0.05 },
      { p95_ms: Number.NaN, error_rate: 0.05 },
      { p95_ms: 500, error_rate: 1.5 },
      { p95_ms: 500, error_rate: -0.1 },
    ];
    for (const slo of bad) {
      const { deps, calls } = makeDeps();
      const output = await runT6RepresentativeLoadTrial(baseTrial({ slo }), deps);
      expect(output.receipt.state).toBe("BLOCKED");
      expect(output.receipt.reason_codes).toContain("SLO_THRESHOLDS_INVALID");
      expect(calls.execute).toBe(0);
      expect(calls.cleanup).toBe(0);
    }
  });

  it("reports BLOCKED for a malformed trial generation and a live/non-live environment mismatch", async () => {
    const { deps, calls } = makeDeps();
    const badGen = await runT6RepresentativeLoadTrial(baseTrial({ trial_generation: "../*broad*" }), deps);
    expect(badGen.receipt.state).toBe("BLOCKED");
    expect(badGen.receipt.reason_codes).toContain("INVALID_TRIAL_GENERATION");
    expect(calls.execute).toBe(0);

    const envMismatch = await runT6RepresentativeLoadTrial(
      baseTrial({ mode: "live", environment: "development" }),
      deps,
    );
    expect(envMismatch.receipt.state).toBe("BLOCKED");
    expect(envMismatch.receipt.reason_codes).toContain("LIVE_ENVIRONMENT_MISMATCH");
    expect(calls.execute).toBe(0);
  });

  it("computes p50/p95/p99 exactly via linear interpolation", () => {
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
    const { p50_ms, p95_ms, p99_ms } = summarizeLatencies(latencies);
    expect(p50_ms).toBeCloseTo(50.5, 10);
    expect(p95_ms).toBeCloseTo(95.05, 10);
    expect(p99_ms).toBeCloseTo(99.01, 10);
    expect(summarizeLatencies([])).toEqual({ p50_ms: null, p95_ms: null, p99_ms: null });
    expect(summarizeLatencies([7])).toEqual({ p50_ms: 7, p95_ms: 7, p99_ms: 7 });
  });

  it("runs the full scoped profile with the specified phase concurrency", async () => {
    const { deps, calls } = makeDeps();
    const output = await runT6RepresentativeLoadTrial(baseTrial(), deps);
    expect(output.receipt.state).toBe("PASS");
    expect(calls.execute).toBe(TOTAL_OPS);
    expect(TOTAL_OPS).toBe(92);
    expect(output.phases).toHaveLength(T6_LOAD_PROFILE.length);
    for (const spec of T6_LOAD_PROFILE) {
      expect(calls.maxInFlightByPhase.get(spec.phase)).toBe(spec.concurrency);
      const summary = output.phases.find((p) => p.phase === spec.phase);
      expect(summary?.op_count).toBe(spec.op_count);
      expect(summary?.ok_count).toBe(spec.op_count);
      expect(summary?.error_count).toBe(0);
      expect(summary?.unknown_count).toBe(0);
      expect(summary?.error_rate).toBe(0);
    }
    expect(output.slo_evaluation.verdict).toBe("PASS");
    // Local trials are downgraded: a fake can never green the live gate.
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("accounts error rate over settled ops and fails the SLO on a breach", async () => {
    const { deps, calls } = makeDeps({
      executeLoadOperation: async (args) => {
        calls.execute += 1;
        if (args.op_index % 10 === 0) {
          return { outcome: "error", latency_ms: 1_000, detail: `seeded error ${args.op_index}` } satisfies T6LoadOpResult;
        }
        return { outcome: "ok", latency_ms: 5 } satisfies T6LoadOpResult;
      },
    });
    const output = await runT6RepresentativeLoadTrial(baseTrial({ slo: { p95_ms: 100, error_rate: 0.05 } }), deps);
    expect(output.receipt.state).toBe("FAIL");
    expect(output.slo_evaluation.verdict).toBe("FAIL");
    expect(output.slo_evaluation.reason_codes).toContain("SLO_P95_BREACH");
    expect(output.slo_evaluation.reason_codes).toContain("SLO_ERROR_RATE_BREACH");
    // Errors counted against settled ops only: op_index restarts per phase,
    // so op_index % 10 === 0 errors 1+2+5+1+1+1 = 11 ops across the 92 total
    // => 11 errors / 92 settled = 0.1196.
    expect(output.slo_evaluation.observed_error_rate).toBeCloseTo(11 / 92, 10);
    expect(output.slo_evaluation.unknown_op_count).toBe(0);
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("passes the SLO when observed p95 and error rate are within injected thresholds", async () => {
    const { deps } = makeDeps({
      executeLoadOperation: async (args) => ({ outcome: "ok", latency_ms: 10 + args.op_index } satisfies T6LoadOpResult),
    });
    // Largest latency: readers-50 op 49 -> 59 ms.
    const output = await runT6RepresentativeLoadTrial(baseTrial({ slo: { p95_ms: 60, error_rate: 0.01 } }), deps);
    expect(output.slo_evaluation.verdict).toBe("PASS");
    expect(output.slo_evaluation.observed_p95_ms).not.toBeNull();
    expect(output.slo_evaluation.observed_p95_ms as number).toBeLessThanOrEqual(60);
    expect(output.slo_evaluation.observed_error_rate).toBe(0);
    expect(output.receipt.state).toBe("PASS");
    expect(output.receipt.reason_codes).toHaveLength(0);
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    // Still a local trial: structural downgrade keeps the live gate red.
    expect(output.receipt.worker_generation).toBeNull();
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("reports RUNNING with SETTLEMENT_UNCERTAIN_OPS when any op settlement is unknown, never PASS", async () => {
    const { deps } = makeDeps({
      executeLoadOperation: async (args) => {
        if (args.phase === "workflows-2" && args.op_index === 0) {
          return { outcome: "unknown", detail: "provider reply lost" } satisfies T6LoadOpResult;
        }
        return { outcome: "ok", latency_ms: 3 } satisfies T6LoadOpResult;
      },
    });
    const output = await runT6RepresentativeLoadTrial(baseTrial(), deps);
    expect(output.receipt.state).toBe("RUNNING");
    expect(output.receipt.reason_codes).toContain("SETTLEMENT_UNCERTAIN_OPS");
    expect(output.slo_evaluation.verdict).toBe("NOT_EVALUATED");
    expect(output.slo_evaluation.unknown_op_count).toBe(1);
    const workflowPhase = output.phases.find((p) => p.phase === "workflows-2");
    expect(workflowPhase?.unknown_count).toBe(1);
    expect(workflowPhase?.ok_count).toBe(1);
    // Unknown op excluded from percentile accounting.
    expect(workflowPhase?.p95_ms).toBe(3);
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("treats a timeout throw as unknown settlement and a transport throw as a performed error", async () => {
    const { deps } = makeDeps({
      executeLoadOperation: async (args) => {
        if (args.phase === "sessions-5" && args.op_index === 0) {
          const timeout = new Error("request timed out");
          timeout.name = "TimeoutError";
          throw timeout;
        }
        if (args.phase === "sessions-5" && args.op_index === 1) {
          throw new Error("connection refused");
        }
        return { outcome: "ok", latency_ms: 2 } satisfies T6LoadOpResult;
      },
    });
    const output = await runT6RepresentativeLoadTrial(baseTrial(), deps);
    expect(output.receipt.state).toBe("RUNNING");
    expect(output.receipt.reason_codes).toContain("SETTLEMENT_UNCERTAIN_OPS");
    const sessionPhase = output.phases.find((p) => p.phase === "sessions-5");
    expect(sessionPhase?.unknown_count).toBe(1);
    expect(sessionPhase?.error_count).toBe(1);
    expect(sessionPhase?.ok_count).toBe(3);
  });

  it("cleans up with exact owned keys: no prefixes, no wildcards, one call", async () => {
    const { deps, calls } = makeDeps();
    const output = await runT6RepresentativeLoadTrial(baseTrial(), deps);
    expect(calls.cleanup).toBe(1);
    const cleaned = calls.cleanupArgs[0];
    expect(cleaned).toHaveLength(TOTAL_OPS);
    expect(new Set(cleaned).size).toBe(TOTAL_OPS);
    for (const key of cleaned) {
      expect(key.startsWith(OWNED_KEY_PREFIX)).toBe(true);
      expect(key).not.toContain("*");
    }
    expect([...cleaned].sort()).toEqual([...output.owned_keys].sort());
    expect(output.receipt.cleanup_state).toBe("COMPLETE");
  });

  it("reports cleanup FAILED when the exact-key delete does not remove everything", async () => {
    const { deps, calls } = makeDeps({
      cleanupKeys: async (owned_keys) => {
        calls.cleanup += 1;
        return { deleted: owned_keys.slice(0, owned_keys.length - 1) };
      },
    });
    const output = await runT6RepresentativeLoadTrial(baseTrial(), deps);
    expect(output.receipt.state).toBe("PASS");
    expect(output.receipt.cleanup_state).toBe("FAILED");
    expect(gateMayBeReportedAsPass(output.receipt)).toBe(false);
  });

  it("never emits raw input, source text, or secret-shaped material in output", async () => {
    const { deps } = makeDeps({
      executeLoadOperation: async () => ({
        outcome: "error",
        latency_ms: 1,
        detail: `provider said: ${FAKE_JWT} contact ${FAKE_EMAIL}`,
      } satisfies T6LoadOpResult),
    });
    const output = await runT6RepresentativeLoadTrial(baseTrial(), deps);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(INPUT_VALUE);
    expect(serialized).not.toContain(FAKE_JWT);
    expect(serialized).not.toContain(FAKE_EMAIL);
    expect(serialized).toContain("[REDACTED_JWT]");
    expect(serialized).toContain("[REDACTED_EMAIL]");
    // No cost material anywhere in the output contract.
    expect(serialized).not.toMatch(/"cost/i);
    // Executor receives digests only: never the raw input value.
    expect(output.receipt.input_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(output.receipt.redacted_receipt_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("never passes the raw input value to the injected executor", async () => {
    const { deps, calls } = makeDeps();
    await runT6RepresentativeLoadTrial(baseTrial(), deps);
    expect(calls.executorArgs.length).toBe(TOTAL_OPS);
    for (const arg of calls.executorArgs) {
      expect(arg.key.startsWith(OWNED_KEY_PREFIX)).toBe(true);
      expect(Object.keys(arg).sort()).toEqual(["key", "kind", "op_index", "phase"]);
      expect(JSON.stringify(arg)).not.toContain(INPUT_VALUE);
    }
  });
});

describe("T6 documented initial SLO inputs (ELIOT_RESEARCH.md §15.7–§15.8)", () => {
  it("exposes the doc-sourced initial thresholds with their provenance, inventing nothing", () => {
    expect(T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.p95_ms).toBe(800);
    expect(T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.error_rate).toBe(0.01);
    expect(T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.doc_source).toBe("docs/architecture/ELIOT_RESEARCH.md");
    expect(T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.doc_section).toContain("3949–3967");
    expect(T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.doc_section).toContain("3970–3978");
    expect(T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.p95_ms_basis).toContain("exact handle read p95 < 800 ms");
    expect(T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.error_rate_basis).toContain(">1%");
    expect(T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.status).toContain("replaced only by measured profiles");
    expect(documentedInitialSloThresholds()).toEqual({ p95_ms: 800, error_rate: 0.01 });
  });

  it("evaluates a trial against the documented initial thresholds when they are injected", async () => {
    const { deps } = makeDeps({
      executeLoadOperation: async (args) =>
        ({ outcome: "ok", latency_ms: 100 + args.op_index }) satisfies T6LoadOpResult,
    });
    const pass = await runT6RepresentativeLoadTrial(baseTrial({ slo: documentedInitialSloThresholds() }), deps);
    expect(pass.slo_evaluation.verdict).toBe("PASS");
    expect(pass.slo_evaluation.p95_ms_threshold).toBe(800);
    expect(pass.slo_evaluation.error_rate_threshold).toBe(0.01);
    expect(pass.receipt.state).toBe("PASS");

    const { deps: slowDeps } = makeDeps({
      executeLoadOperation: async () => ({ outcome: "ok", latency_ms: 900 }) satisfies T6LoadOpResult,
    });
    const fail = await runT6RepresentativeLoadTrial(baseTrial({ slo: documentedInitialSloThresholds() }), slowDeps);
    expect(fail.slo_evaluation.verdict).toBe("FAIL");
    expect(fail.slo_evaluation.reason_codes).toContain("SLO_P95_BREACH");
    expect(fail.receipt.state).toBe("FAIL");
    expect(gateMayBeReportedAsPass(fail.receipt)).toBe(false);
  });
});
