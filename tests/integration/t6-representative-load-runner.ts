// T6-representative-load trial runner (tests/integration only).
//
// Implements the scoped representative-load profile: readers at 5/20/50
// concurrency, 5 sessions, 10 ingest jobs, 2 workflows. Measures per-phase and
// overall p50/p95/p99 latencies and error rates, and produces a fail-closed
// SLO pass/fail evaluation as input to release evidence.
//
// Discipline (all branches proven by the companion test file):
// - absent credentials -> NOT_EXECUTED, executor and cleanup never called;
// - failed policy/code prerequisite -> BLOCKED (distinct from FAIL);
// - malformed trial generation or a live trial on a non-live environment ->
//   BLOCKED before any effect;
// - missing or invalid SLO thresholds -> BLOCKED before any effect
//   (SLO_THRESHOLDS_NOT_PROVIDED / SLO_THRESHOLDS_INVALID): a load trial with
//   no owner-approved thresholds can never be reported as pass;
// - a performed trial whose observed p95 or error rate exceeds the injected
//   thresholds -> FAIL with SLO_P95_BREACH / SLO_ERROR_RATE_BREACH;
// - any operation whose settlement is unknown (timeout / lost response) ->
//   RUNNING with SETTLEMENT_UNCERTAIN_OPS; unknown ops are excluded from the
//   latency/error accounting and can never yield a PASS;
// - only `live` trials carrying attested worker/data generations can satisfy
//   `gateMayBeReportedAsPass`; a `local` trial is downgraded to unattested
//   identity even if attestation is supplied, so a local fake is structurally
//   incapable of turning the live gate green;
// - no real Cloudflare credentials, bindings, or model calls: the runner takes
//   an injected load-executor dependency, so unit tests prove the statistics
//   against fakes;
// - raw input values, prompts, source text and secrets never reach output:
//   only digests, counts, and redacted text are recorded;
// - cleanup names exactly the owned op keys derived from the trial
//   generation; never a broad prefix, never account discovery.
//
// Honestly refused in this checkpoint:
// - cost accounting: per-op cost is not measured here; the cost observer
//   (S96 design) owns cost, and any cost check in this runner would be a
//   fabricated always-pass.
// - per-phase SLO thresholds (e.g. hybrid locate 2.5 s vs cached catalog
//   500 ms): the architecture doc gives per-operation targets, but the T6
//   profile evaluates one overall p95/error-rate pair. Mapping each phase to
//   its own doc target is a future owner decision, not invented here.
import {
  redactSecretsText,
  sha256Hex,
} from "./d1-write-readback-runner.js";
import type { LiveGateReceipt } from "./gate-state.js";

export const T6_REPRESENTATIVE_LOAD_GATE_ID = "T6-representative-load" as const;

export type T6TrialMode = "live" | "local";

export type T6LoadPhaseId =
  | "readers-5"
  | "readers-20"
  | "readers-50"
  | "sessions-5"
  | "ingest-10"
  | "workflows-2";

export type T6LoadOpKind = "reader" | "session" | "ingest-job" | "workflow";

// The scoped representative-load profile. Fixed by the T6 checkpoint scope:
// reader concurrency ramps 5 -> 20 -> 50, then 5 sessions, 10 ingest jobs,
// 2 workflows. These are scope constants, not owner knobs.
export interface T6LoadPhaseSpec {
  readonly phase: T6LoadPhaseId;
  readonly kind: T6LoadOpKind;
  readonly op_count: number;
  readonly concurrency: number;
}

export const T6_LOAD_PROFILE: ReadonlyArray<T6LoadPhaseSpec> = [
  { phase: "readers-5", kind: "reader", op_count: 5, concurrency: 5 },
  { phase: "readers-20", kind: "reader", op_count: 20, concurrency: 20 },
  { phase: "readers-50", kind: "reader", op_count: 50, concurrency: 50 },
  { phase: "sessions-5", kind: "session", op_count: 5, concurrency: 5 },
  { phase: "ingest-10", kind: "ingest-job", op_count: 10, concurrency: 10 },
  { phase: "workflows-2", kind: "workflow", op_count: 2, concurrency: 2 },
] as const;

// Owner-approved SLO thresholds. INJECTED trial input, never defaulted by the
// runner: the runner validates presence and shape and blocks the trial when
// they are absent or malformed. The documented initial values (sourced from
// docs/architecture/ELIOT_RESEARCH.md §15.7–§15.8, not invented) are exported
// separately as T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE for the staging
// composition to inject explicitly.
export interface T6SloThresholds {
  readonly p95_ms: number;
  readonly error_rate: number;
}

// Documented initial SLO inputs, sourced verbatim from
// docs/architecture/ELIOT_RESEARCH.md §15.7 "SLO and alert thresholds"
// (lines 3949–3967) and §15.8 "Performance targets" (lines 3970–3978), which
// state: "Initial thresholds, replaced only by measured profiles".
//
// Mapping rationale (which doc thresholds become the two trial knobs):
// - p95_ms = 800: the T6 profile's representative read path is the "reader"
//   op; the doc's read-path target is "exact handle read p95 < 800 ms"
//   (§15.8), warned at "p95 >800 ms for 30 min" (§15.7).
// - error_rate = 0.01: "Worker error rate >1% for 10 min" alert (§15.7); the
//   "for 10 min" part is an alerting window, not a trial knob, so only the
//   1% rate is carried over.
// Deliberately NOT wired into the trial's two knobs:
// - "hybrid locate p95 < 2.5 s" (§15.8) and "interactive first token < 4 s
//   after retrieval" (§15.8): different operation types with no dedicated
//   phase in the T6 profile; a per-phase threshold table is a future owner
//   decision, not invented here.
// - "catalog/orient cached p95 < 500 ms" (§15.8): the cached fast-path
//   special case, not the representative read path.
// - "citation resolution <100% in accepted output / block publish" (§15.7):
//   a publish correctness gate, not a load-trial latency/error measure.
// - DLQ/outbox/projection-lag/erasure/budget/R2-retention lines: unrelated
//   subsystems.
export interface T6DocumentedSloInput {
  readonly p95_ms: number;
  readonly error_rate: number;
  readonly doc_source: string;
  readonly doc_section: string;
  readonly p95_ms_basis: string;
  readonly error_rate_basis: string;
  readonly status: string;
}

export const T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE: T6DocumentedSloInput = {
  p95_ms: 800,
  error_rate: 0.01,
  doc_source: "docs/architecture/ELIOT_RESEARCH.md",
  doc_section: "§15.7 SLO and alert thresholds (lines 3949–3967); §15.8 Performance targets (lines 3970–3978)",
  p95_ms_basis: "exact handle read p95 < 800 ms (§15.8); warn at p95 >800 ms for 30 min (§15.7)",
  error_rate_basis: "Worker error rate >1% for 10 min alert (§15.7)",
  status: "Initial thresholds, replaced only by measured profiles",
} as const;

// Returns the documented initial thresholds in the injected-trial shape.
// The composition injects this explicitly; the runner still refuses to
// default to it, so missing thresholds keep failing closed.
export function documentedInitialSloThresholds(): T6SloThresholds {
  return {
    p95_ms: T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.p95_ms,
    error_rate: T6_INITIAL_SLO_INPUTS_FROM_ARCHITECTURE.error_rate,
  };
}

export interface T6RepresentativeLoadTrial {
  readonly gate_id: typeof T6_REPRESENTATIVE_LOAD_GATE_ID;
  readonly mode: T6TrialMode;
  readonly environment: string;
  // Named test generation owning every disposable resource, e.g.
  // "testgen-2026-10-01-001". Constrained so a malformed generation can never
  // widen cleanup into a prefix or account scan.
  readonly trial_generation: string;
  // Free-form canonical seed describing the load inputs (seed material,
  // scenario names). Only its sha256 digest may reach output or deps.
  readonly input_value: string;
  // Injected trial clock (epoch ms) for deterministic timings.
  readonly now_ms: number;
  readonly max_age_ms?: number;
  // Owner-decided SLO thresholds. Absent or invalid -> BLOCKED, fail-closed.
  readonly slo: T6SloThresholds | null | undefined;
  // Live-only attestation. Ignored unless mode === "live".
  readonly worker_generation?: string | null;
  readonly data_generation?: string | null;
}

export type T6LoadOpResult =
  | { readonly outcome: "ok"; readonly latency_ms: number }
  | { readonly outcome: "error"; readonly latency_ms: number; readonly detail: string }
  // Timeout, lost response, or any executor reply whose settlement is unknown.
  // An unknown op is excluded from percentile/error-rate accounting and
  // prevents any PASS verdict: unknown outcome is not proof of failure and
  // not proof of success either.
  | { readonly outcome: "unknown"; readonly detail: string };

export interface T6ProbeDeps {
  // Injected so tests prove the discipline without an account. There is no
  // environment fallback here on purpose: the future staging composition must
  // wire the real binding/credential check explicitly, not inherit one.
  readonly hasLiveCredentials: () => boolean;
  readonly checkPrerequisites: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  // One injected load executor. Receives the owned op key, the op kind, the
  // phase, and the op index only: never the raw input value, never secrets,
  // never cost material. No real Cloudflare or model calls happen here; the
  // staging composition supplies the real executor.
  readonly executeLoadOperation: (args: {
    readonly key: string;
    readonly kind: T6LoadOpKind;
    readonly phase: T6LoadPhaseId;
    readonly op_index: number;
  }) => Promise<T6LoadOpResult>;
  // Exact-key delete only. Must never be called with prefixes or wildcards.
  readonly cleanupKeys: (owned_keys: readonly string[]) => Promise<{ readonly deleted: readonly string[] }>;
}

export interface T6PhaseSummary {
  readonly phase: T6LoadPhaseId;
  readonly kind: T6LoadOpKind;
  readonly op_count: number;
  readonly ok_count: number;
  readonly error_count: number;
  readonly unknown_count: number;
  // Null when no settled (ok/error) observations exist in this phase.
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly p99_ms: number | null;
  // errors / (ok + error); null when nothing settled.
  readonly error_rate: number | null;
}

export interface T6SloEvaluation {
  readonly thresholds_present: boolean;
  readonly p95_ms_threshold: number | null;
  readonly error_rate_threshold: number | null;
  readonly observed_p95_ms: number | null;
  readonly observed_error_rate: number | null;
  readonly unknown_op_count: number;
  readonly verdict: "PASS" | "FAIL" | "NOT_EVALUATED";
  readonly reason_codes: readonly string[];
}

export interface T6ProbeOutput {
  readonly receipt: LiveGateReceipt;
  readonly owned_keys: readonly string[];
  readonly duration_ms: number;
  readonly phases: readonly T6PhaseSummary[];
  readonly slo_evaluation: T6SloEvaluation;
  readonly diagnostic_log: readonly string[];
}

const TRIAL_GENERATION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LIVE_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);
const FINISH_OFFSET_MS = 1_000;
const OBSERVE_OFFSET_MS = 2_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isUncertainError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && (code === "TIMEOUT" || code === "ETIMEDOUT" || code === "ECONNRESET")) {
      return true;
    }
    return /timed out|timeout|lost response|no response/i.test(error.message);
  }
  return false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Percentiles via linear interpolation on the sorted observations, the same
// convention as numpy's default. Deterministic and exactly testable; exported
// so the companion test pins the arithmetic.
export function percentileOfSorted(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = quantile * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

export function summarizeLatencies(latencies_ms: readonly number[]): {
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly p99_ms: number | null;
} {
  const sorted = [...latencies_ms].sort((a, b) => a - b);
  return {
    p50_ms: percentileOfSorted(sorted, 0.5),
    p95_ms: percentileOfSorted(sorted, 0.95),
    p99_ms: percentileOfSorted(sorted, 0.99),
  };
}

function validateSlo(slo: T6SloThresholds | null | undefined): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly detail: string } {
  if (slo === null || slo === undefined) {
    return { ok: false, code: "SLO_THRESHOLDS_NOT_PROVIDED", detail: "SLO thresholds are an injected owner decision; absent thresholds fail closed" };
  }
  if (!Number.isFinite(slo.p95_ms) || slo.p95_ms < 0) {
    return { ok: false, code: "SLO_THRESHOLDS_INVALID", detail: `p95_ms must be a finite non-negative number, got: ${String(slo.p95_ms)}` };
  }
  if (!Number.isFinite(slo.error_rate) || slo.error_rate < 0 || slo.error_rate > 1) {
    return { ok: false, code: "SLO_THRESHOLDS_INVALID", detail: `error_rate must be a finite number in [0, 1], got: ${String(slo.error_rate)}` };
  }
  return { ok: true };
}

interface SettledOp {
  readonly key: string;
  readonly latency_ms: number;
  readonly ok: boolean;
  readonly detail: string | null;
}

export async function runT6RepresentativeLoadTrial(trial: T6RepresentativeLoadTrial, deps: T6ProbeDeps): Promise<T6ProbeOutput> {
  const started_at = iso(trial.now_ms);
  const finished_at = iso(trial.now_ms + FINISH_OFFSET_MS);
  const observed_at = iso(trial.now_ms + OBSERVE_OFFSET_MS);
  const duration_ms = OBSERVE_OFFSET_MS;
  const log: string[] = [];

  // The input digest binds the canonical trial descriptor: gate, generation,
  // mode, environment, the fixed load profile, the raw seed digest, and the
  // injected SLO thresholds. No raw values, no secrets.
  const profile_digest = sha256Hex(JSON.stringify(T6_LOAD_PROFILE));
  const input_digest = sha256Hex(
    JSON.stringify({
      gate_id: trial.gate_id,
      trial_generation: trial.trial_generation,
      mode: trial.mode,
      environment: trial.environment,
      profile_digest,
      input_value_digest: sha256Hex(trial.input_value),
      slo: trial.slo ?? null,
    }),
  );

  const baseReceipt = (
    state: LiveGateReceipt["state"],
    reason_codes: readonly string[],
    cleanup_state: LiveGateReceipt["cleanup_state"],
    extra: Partial<LiveGateReceipt> = {},
  ): LiveGateReceipt => ({
    gate_id: trial.gate_id,
    state,
    environment: trial.environment,
    generation_ref: null,
    started_at,
    finished_at,
    redacted_receipt_ref: null,
    reason_codes,
    cleanup_state,
    worker_generation: null,
    data_generation: null,
    test_id: trial.gate_id,
    input_digest,
    observed_at,
    ...extra,
  });

  const notEvaluated = (reason_codes: readonly string[]): T6SloEvaluation => ({
    thresholds_present: trial.slo !== null && trial.slo !== undefined,
    p95_ms_threshold: typeof trial.slo?.p95_ms === "number" ? trial.slo.p95_ms : null,
    error_rate_threshold: typeof trial.slo?.error_rate === "number" ? trial.slo.error_rate : null,
    observed_p95_ms: null,
    observed_error_rate: null,
    unknown_op_count: 0,
    verdict: "NOT_EVALUATED",
    reason_codes,
  });

  // Fail closed before any effect: a malformed generation must never widen
  // cleanup into a prefix, a live trial must declare a live environment, and
  // a trial with no owner-approved SLO thresholds cannot be reported as pass.
  if (!TRIAL_GENERATION.test(trial.trial_generation)) {
    log.push(redactSecretsText(`invalid trial generation: ${trial.trial_generation}`));
    return {
      receipt: baseReceipt("BLOCKED", ["INVALID_TRIAL_GENERATION"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      phases: [],
      slo_evaluation: notEvaluated(["INVALID_TRIAL_GENERATION"]),
      diagnostic_log: log,
    };
  }
  if (trial.mode === "live" && !LIVE_ENVIRONMENTS.has(trial.environment)) {
    log.push(redactSecretsText(`live trial requires a staging/production environment, got: ${trial.environment}`));
    return {
      receipt: baseReceipt("BLOCKED", ["LIVE_ENVIRONMENT_MISMATCH"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      phases: [],
      slo_evaluation: notEvaluated(["LIVE_ENVIRONMENT_MISMATCH"]),
      diagnostic_log: log,
    };
  }
  const sloCheck = validateSlo(trial.slo);
  if (!sloCheck.ok) {
    log.push(redactSecretsText(`SLO thresholds rejected: ${sloCheck.detail}`));
    return {
      receipt: baseReceipt("BLOCKED", [sloCheck.code], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      phases: [],
      slo_evaluation: notEvaluated([sloCheck.code]),
      diagnostic_log: log,
    };
  }

  if (!deps.hasLiveCredentials()) {
    return {
      receipt: baseReceipt("NOT_EXECUTED", ["LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      phases: [],
      slo_evaluation: notEvaluated(["LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT"]),
      diagnostic_log: log,
    };
  }

  const pre = deps.checkPrerequisites();
  if (!pre.ok) {
    log.push(redactSecretsText(`prerequisite not satisfied: ${pre.reason}`));
    return {
      receipt: baseReceipt("BLOCKED", ["PROBE_PREREQUISITE_UNSATISFIED"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      phases: [],
      slo_evaluation: notEvaluated(["PROBE_PREREQUISITE_UNSATISFIED"]),
      diagnostic_log: log,
    };
  }

  // Every disposable op key is derived from the trial generation. Cleanup
  // below names exactly these keys: no prefixes, no wildcards, no discovery.
  const opKeys = new Map<string, { readonly kind: T6LoadOpKind; readonly phase: T6LoadPhaseId; readonly op_index: number }>();
  for (const spec of T6_LOAD_PROFILE) {
    for (let i = 0; i < spec.op_count; i += 1) {
      const key = `load/${trial.trial_generation}/${trial.gate_id}/${spec.phase}/${spec.kind}/${String(i).padStart(3, "0")}`;
      opKeys.set(key, { kind: spec.kind, phase: spec.phase, op_index: i });
    }
  }
  const owned_keys = [...opKeys.keys()];

  const settleCleanup = async (): Promise<LiveGateReceipt["cleanup_state"]> => {
    try {
      const result = await deps.cleanupKeys(owned_keys);
      const deleted = new Set(result.deleted);
      return owned_keys.every((key) => deleted.has(key)) ? "COMPLETE" : "FAILED";
    } catch (error) {
      log.push(redactSecretsText(`cleanup failed for owned keys: ${messageOf(error)}`));
      return "FAILED";
    }
  };

  // Attestation binds only live trials. Local trials are downgraded even when
  // attestation is supplied: a local fake can never satisfy the PASS predicate.
  const worker_generation = trial.mode === "live" ? (trial.worker_generation ?? null) : null;
  const data_generation = trial.mode === "live" ? (trial.data_generation ?? null) : null;

  const settled: SettledOp[] = [];
  const unknownDetails: string[] = [];

  // Phases run sequentially; within a phase, ops run in concurrency-sized
  // batches. Latencies are measured by the injected executor and reported in
  // its results; the runner never invents timings.
  for (const spec of T6_LOAD_PROFILE) {
    const batches: Array<Array<{ key: string; op_index: number }>> = [];
    for (let i = 0; i < spec.op_count; i += spec.concurrency) {
      const batch: Array<{ key: string; op_index: number }> = [];
      for (let j = i; j < Math.min(i + spec.concurrency, spec.op_count); j += 1) {
        batch.push({ key: `load/${trial.trial_generation}/${trial.gate_id}/${spec.phase}/${spec.kind}/${String(j).padStart(3, "0")}`, op_index: j });
      }
      batches.push(batch);
    }
    for (const batch of batches) {
      const outcomes = await Promise.all(
        batch.map(async ({ key, op_index }) => {
          try {
            const result = await deps.executeLoadOperation({ key, kind: spec.kind, phase: spec.phase, op_index });
            return { key, result } as const;
          } catch (error) {
            if (isUncertainError(error)) {
              return { key, result: { outcome: "unknown", detail: `timeout/lost response: ${messageOf(error)}` } as const } as const;
            }
            return { key, result: { outcome: "error", latency_ms: 0, detail: `transport error: ${messageOf(error)}` } as const } as const;
          }
        }),
      );
      for (const { key, result } of outcomes) {
        if (result.outcome === "unknown") {
          unknownDetails.push(redactSecretsText(`op ${key}: settlement unknown: ${result.detail}`));
          continue;
        }
        settled.push({
          key,
          latency_ms: result.latency_ms,
          ok: result.outcome === "ok",
          detail: result.outcome === "error" ? redactSecretsText(result.detail) : null,
        });
        // Record the redacted failure detail: the raw text never reaches
        // output, only the redacted form, mirroring the T4 runner discipline.
        if (result.outcome === "error") {
          log.push(redactSecretsText(`op ${key}: error: ${result.detail}`));
        }
      }
    }
  }

  for (const detail of unknownDetails) log.push(detail);

  const phaseSummaries: T6PhaseSummary[] = T6_LOAD_PROFILE.map((spec) => {
    const inPhase = settled.filter((op) => opKeys.get(op.key)?.phase === spec.phase);
    const latencies = inPhase.map((op) => op.latency_ms);
    const { p50_ms, p95_ms, p99_ms } = summarizeLatencies(latencies);
    const ok_count = inPhase.filter((op) => op.ok).length;
    const error_count = inPhase.length - ok_count;
    const settledKeys = new Set(settled.map((op) => op.key));
    const unknown_count = owned_keys.filter(
      (key) => opKeys.get(key)?.phase === spec.phase && !settledKeys.has(key),
    ).length;
    return {
      phase: spec.phase,
      kind: spec.kind,
      op_count: spec.op_count,
      ok_count,
      error_count,
      unknown_count,
      p50_ms,
      p95_ms,
      p99_ms,
      error_rate: inPhase.length === 0 ? null : error_count / inPhase.length,
    };
  });

  const cleanup_state = await settleCleanup();

  const settledLatencies = settled.map((op) => op.latency_ms);
  const overall = summarizeLatencies(settledLatencies);
  const errorCount = settled.filter((op) => !op.ok).length;
  const observed_error_rate = settled.length === 0 ? null : errorCount / settled.length;
  const thresholds = trial.slo as T6SloThresholds;

  const sloReasons: string[] = [];
  let verdict: T6SloEvaluation["verdict"];
  if (unknownDetails.length > 0) {
    sloReasons.push("SETTLEMENT_UNCERTAIN_OPS");
    verdict = "NOT_EVALUATED";
  } else if (overall.p95_ms === null || observed_error_rate === null) {
    sloReasons.push("NO_SETTLED_OBSERVATIONS");
    verdict = "NOT_EVALUATED";
  } else {
    if (overall.p95_ms > thresholds.p95_ms) sloReasons.push("SLO_P95_BREACH");
    if (observed_error_rate > thresholds.error_rate) sloReasons.push("SLO_ERROR_RATE_BREACH");
    verdict = sloReasons.length === 0 ? "PASS" : "FAIL";
  }

  const slo_evaluation: T6SloEvaluation = {
    thresholds_present: true,
    p95_ms_threshold: thresholds.p95_ms,
    error_rate_threshold: thresholds.error_rate,
    observed_p95_ms: overall.p95_ms,
    observed_error_rate,
    unknown_op_count: unknownDetails.length,
    verdict,
    reason_codes: sloReasons,
  };

  const summaryDigest = sha256Hex(JSON.stringify({ phases: phaseSummaries, slo_evaluation }));

  if (verdict !== "PASS") {
    const state = unknownDetails.length > 0 ? "RUNNING" : "FAIL";
    const receipt = baseReceipt(state, sloReasons, cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
      redacted_receipt_ref: `sha256:${summaryDigest}`,
    });
    return { receipt, owned_keys, duration_ms, phases: phaseSummaries, slo_evaluation, diagnostic_log: log };
  }

  const receipt = baseReceipt("PASS", [], cleanup_state, {
    generation_ref: worker_generation,
    worker_generation,
    data_generation,
    redacted_receipt_ref: `sha256:${summaryDigest}`,
  });
  return { receipt, owned_keys, duration_ms, phases: phaseSummaries, slo_evaluation, diagnostic_log: log };
}
