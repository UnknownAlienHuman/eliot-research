// T5-failure-injection probe runner (tests/integration only).
//
// Chosen gate: T5-failure-injection. Rationale: the T5 family proves the system
// degrades safely; this runner is its fault-injection arm. Five fault classes
// are injected through dependency-injected probes — never against canonical
// production state: D1 write error, R2 readback mismatch, queue duplicate
// delivery, model timeout, and ledger conflict. For each class the runner
// asserts the system fails closed: the fault is detected, a well-formed
// digest-pinned negative receipt is produced, nothing is partially committed,
// and nothing silently passes. Exactly one attempt is performed per class
// (failure-model.md: every mutation follows Intent -> Attempt -> Receipt ->
// Readback -> Reconciliation; a timeout is unknown outcome, not proof, so the
// model-timeout class must surface uncertainty, not success).
//
// Staging composition map (the runner stays dependency-injected; the future
// staging wire-up binds each probe against the real subsystem with a fault
// injector in front of it):
// - probeD1WriteError -> D1 write through the fault injector forced to fail
//   (constraint violation / write error); the system must reject the write
//   and emit a negative receipt instead of committing;
// - probeR2ReadbackMismatch -> R2 readback with bytes altered in transit; the
//   digest mismatch must be detected, never silently accepted;
// - probeQueueDuplicateDelivery -> the same queue message delivered twice under
//   one idempotency key; the duplicate must be detected and deduped, never
//   double-applied;
// - probeModelTimeout -> model call forced to time out; settlement is unknown,
//   so the system must report uncertainty with exactly one attempt and no
//   retry under a new intent — claiming success is a silent pass;
// - probeLedgerConflict -> ledger append racing a conflicting CAS/version; the
//   conflicting append must be rejected and the original entry preserved.
//
// Discipline (all branches proven by the companion test file):
// - absent credentials -> NOT_EXECUTED, no probe is called;
// - failed policy/code prerequisite -> BLOCKED (distinct from FAIL);
// - malformed trial generation or a live trial in a non-live environment ->
//   BLOCKED before any effect;
// - any fault class not handled as its expected fail-closed posture -> FAIL
//   (performed assertion: silent pass or partial commit is a real defect);
// - malformed negative receipt (not a pinned digest) -> FAIL: fail-closed
//   requires a well-formed negative receipt;
// - timeout / lost response / unknown outcome at any step -> RUNNING with
//   SETTLEMENT_UNCERTAIN, exactly one attempt for that class, no automatic
//   retry, remaining classes are not probed;
// - only `live` trials carrying attested worker/data generations can satisfy
//   `gateMayBeReportedAsPass`; a `local` trial is downgraded to unattested
//   identity even if attestation is supplied, so a local fake is structurally
//   incapable of turning the live gate green;
// - raw input values, prompts, source text and secrets never reach output:
//   probes receive the owned key and the canonical input digest only, output
//   carries digests plus redacted text;
// - cleanup names exactly the five owned keys derived from the trial
//   generation; never a prefix, never account discovery.
import { createHash } from "node:crypto";
import type { LiveGateReceipt } from "./gate-state.js";
import type { ProbeMode } from "./d1-write-readback-runner.js";

export const T5_FAILURE_INJECTION_GATE_ID = "T5-failure-injection" as const;

export type FaultClass =
  | "d1-write-error"
  | "r2-readback-mismatch"
  | "queue-duplicate-delivery"
  | "model-timeout"
  | "ledger-conflict";

// How the system under test responded to the injected fault.
// "failed-closed": fault detected, negative receipt emitted, no incorrect state.
// "uncertain": settlement unknown; exactly one attempt; no retry (timeout posture).
// "silent-pass": fault not detected; the operation was reported successful (defect).
// "partial-commit": fault mishandled; incorrect or partial state committed (defect).
export type FaultHandling = "failed-closed" | "uncertain" | "silent-pass" | "partial-commit";

export interface FaultHandlingReport {
  readonly handling: FaultHandling;
  // sha256 hex digest of the negative receipt the system produced for this
  // fault. A fail-closed system must produce a well-formed receipt; a
  // malformed digest fails the trial.
  readonly evidence_digest: string;
  // Redacted prose detail. Must not carry raw values or secrets.
  readonly detail: string;
}

export interface FaultProbeArgs {
  // Exact owned key for this fault class.
  readonly key: string;
  // Canonical probe-input digest. Probes receive digests only, never raw input.
  readonly input_digest: string;
}

export interface T5FailureInjectionDeps {
  // Injected so tests prove the discipline without an account. There is no
  // environment fallback here on purpose: the future staging composition must
  // wire the real binding/credential check explicitly, not inherit one.
  readonly hasLiveCredentials: () => boolean;
  readonly checkPrerequisites: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  // One probe per fault class. Each performs the operation with its fault
  // injected and reports how the system handled it. Called exactly once per
  // trial; never retried.
  readonly probeD1WriteError: (args: FaultProbeArgs) => Promise<FaultHandlingReport>;
  readonly probeR2ReadbackMismatch: (args: FaultProbeArgs) => Promise<FaultHandlingReport>;
  readonly probeQueueDuplicateDelivery: (args: FaultProbeArgs) => Promise<FaultHandlingReport>;
  readonly probeModelTimeout: (args: FaultProbeArgs) => Promise<FaultHandlingReport>;
  readonly probeLedgerConflict: (args: FaultProbeArgs) => Promise<FaultHandlingReport>;
  // Exact-key delete only. Must never be called with prefixes or wildcards.
  readonly cleanupKeys: (owned_keys: readonly string[]) => Promise<{ readonly deleted: readonly string[] }>;
}

export interface T5FailureInjectionTrial {
  readonly gate_id: typeof T5_FAILURE_INJECTION_GATE_ID;
  readonly mode: ProbeMode;
  readonly environment: string;
  // Named test generation owning every disposable resource, e.g.
  // "testgen-2026-10-01-001". Constrained so a malformed generation can never
  // widen cleanup into a prefix or account scan.
  readonly trial_generation: string;
  // Injected trial clock (epoch ms) for deterministic timings.
  readonly now_ms: number;
  // Reserved for the release-evidence predicate window (maxAgeMs). The runner
  // does not evaluate the window itself; the evidence consumer applies it.
  readonly max_age_ms?: number;
  // Live-only attestation. Ignored unless mode === "live".
  readonly worker_generation?: string | null;
  readonly data_generation?: string | null;
}

export interface T5FailureInjectionProbeOutput {
  readonly receipt: LiveGateReceipt;
  readonly owned_keys: readonly string[];
  readonly duration_ms: number;
  readonly diagnostic_log: readonly string[];
}

interface FaultClassSpec {
  readonly fault_class: FaultClass;
  readonly probe: (deps: T5FailureInjectionDeps, args: FaultProbeArgs) => Promise<FaultHandlingReport>;
  // The only acceptable posture for this class. Anything else is a defect.
  readonly expected_handling: FaultHandling;
  readonly unhandled_reason_code: string;
}

const FAULT_CLASSES: ReadonlyArray<FaultClassSpec> = [
  {
    fault_class: "d1-write-error",
    probe: (deps, args) => deps.probeD1WriteError(args),
    expected_handling: "failed-closed",
    unhandled_reason_code: "FAULT_D1_WRITE_ERROR_UNHANDLED",
  },
  {
    fault_class: "r2-readback-mismatch",
    probe: (deps, args) => deps.probeR2ReadbackMismatch(args),
    expected_handling: "failed-closed",
    unhandled_reason_code: "FAULT_R2_READBACK_MISMATCH_UNHANDLED",
  },
  {
    fault_class: "queue-duplicate-delivery",
    probe: (deps, args) => deps.probeQueueDuplicateDelivery(args),
    expected_handling: "failed-closed",
    unhandled_reason_code: "FAULT_QUEUE_DUPLICATE_DELIVERY_UNHANDLED",
  },
  {
    fault_class: "model-timeout",
    probe: (deps, args) => deps.probeModelTimeout(args),
    expected_handling: "uncertain",
    unhandled_reason_code: "FAULT_MODEL_TIMEOUT_UNHANDLED",
  },
  {
    fault_class: "ledger-conflict",
    probe: (deps, args) => deps.probeLedgerConflict(args),
    expected_handling: "failed-closed",
    unhandled_reason_code: "FAULT_LEDGER_CONFLICT_UNHANDLED",
  },
];

const TRIAL_GENERATION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LIVE_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);
const FINISH_OFFSET_MS = 1_000;
const OBSERVE_OFFSET_MS = 2_000;

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PEM]"],
  [/\bxox[baprs]-[A-Za-z0-9-]+/g, "[REDACTED_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]"],
  [/\bbearer\s+\S+/gi, "[REDACTED_BEARER]"],
  [/(?:token|cookie|session)\s*[:=]\s*\S+/gi, "[REDACTED_CREDENTIAL]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
];

export function redactFaultText(text: string): string {
  let out = text;
  for (const [shape, marker] of REDACTIONS) out = out.replace(shape, marker);
  return out;
}

export function sha256HexFault(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Timeout / lost-response shapes stay unresolved. Everything else is a
// performed failure, never uncertainty.
function isUncertainError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return true;
    if (typeof (error as NodeJS.ErrnoException).code === "string") {
      const code = (error as NodeJS.ErrnoException).code as string;
      if (code === "TIMEOUT" || code === "ETIMEDOUT" || code === "ECONNRESET") return true;
    }
    return /timed out|timeout|lost response|no response/i.test(error.message);
  }
  return false;
}

function isWellFormedReport(report: unknown): report is FaultHandlingReport {
  if (typeof report !== "object" || report === null) return false;
  const candidate = report as Partial<FaultHandlingReport>;
  if (
    candidate.handling !== "failed-closed" &&
    candidate.handling !== "uncertain" &&
    candidate.handling !== "silent-pass" &&
    candidate.handling !== "partial-commit"
  ) {
    return false;
  }
  return typeof candidate.evidence_digest === "string" && SHA256_HEX.test(candidate.evidence_digest);
}

export async function runT5FailureInjectionProbe(
  trial: T5FailureInjectionTrial,
  deps: T5FailureInjectionDeps,
): Promise<T5FailureInjectionProbeOutput> {
  const started_at = iso(trial.now_ms);
  const finished_at = iso(trial.now_ms + FINISH_OFFSET_MS);
  const observed_at = iso(trial.now_ms + OBSERVE_OFFSET_MS);
  const duration_ms = OBSERVE_OFFSET_MS;
  // Canonical probe input: the fixed fault-class list. Only its digest is pinned.
  const input_digest = sha256HexFault(FAULT_CLASSES.map((spec) => spec.fault_class).join(","));
  const log: string[] = [];

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

  // Fail closed before any effect: a malformed generation must never widen
  // cleanup into a prefix, and a live trial must declare a live environment.
  if (!TRIAL_GENERATION.test(trial.trial_generation)) {
    log.push(redactFaultText(`invalid trial generation: ${trial.trial_generation}`));
    return {
      receipt: baseReceipt("BLOCKED", ["INVALID_TRIAL_GENERATION"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }
  if (trial.mode === "live" && !LIVE_ENVIRONMENTS.has(trial.environment)) {
    log.push(redactFaultText(`live trial requires a staging/production environment, got: ${trial.environment}`));
    return {
      receipt: baseReceipt("BLOCKED", ["LIVE_ENVIRONMENT_MISMATCH"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }

  if (!deps.hasLiveCredentials()) {
    return {
      receipt: baseReceipt("NOT_EXECUTED", ["LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }

  const pre = deps.checkPrerequisites();
  if (!pre.ok) {
    log.push(redactFaultText(`prerequisite not satisfied: ${pre.reason}`));
    return {
      receipt: baseReceipt("BLOCKED", ["PROBE_PREREQUISITE_UNSATISFIED"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }

  // One owned disposable resource per fault class. Cleanup below names exactly
  // these keys — never a prefix, never account discovery.
  const owned_keys = FAULT_CLASSES.map(
    (spec) => `probe/${trial.trial_generation}/${trial.gate_id}/${spec.fault_class}/001`,
  );
  const owned = [...owned_keys];

  const settleCleanup = async (): Promise<LiveGateReceipt["cleanup_state"]> => {
    try {
      const result = await deps.cleanupKeys(owned);
      return owned.every((key) => result.deleted.includes(key)) ? "COMPLETE" : "FAILED";
    } catch (error) {
      log.push(redactFaultText(`cleanup failed for owned keys: ${messageOf(error)}`));
      return "FAILED";
    }
  };

  // Attestation binds only live trials. Local trials are downgraded even when
  // attestation is supplied: a local fake can never satisfy the PASS predicate.
  const worker_generation = trial.mode === "live" ? (trial.worker_generation ?? null) : null;
  const data_generation = trial.mode === "live" ? (trial.data_generation ?? null) : null;
  const attested: Partial<LiveGateReceipt> = {
    generation_ref: worker_generation,
    worker_generation,
    data_generation,
  };

  const finishUncertain = async (detail: string): Promise<T5FailureInjectionProbeOutput> => {
    log.push(redactFaultText(`settlement unknown, no retry: ${detail}`));
    const cleanup_state = await settleCleanup();
    return {
      receipt: baseReceipt("RUNNING", ["SETTLEMENT_UNCERTAIN"], cleanup_state, attested),
      owned_keys: owned,
      duration_ms,
      diagnostic_log: log,
    };
  };

  const finishTransportError = async (error: unknown): Promise<T5FailureInjectionProbeOutput> => {
    log.push(redactFaultText(`transport error: ${messageOf(error)}`));
    const cleanup_state = await settleCleanup();
    return {
      receipt: baseReceipt("FAIL", ["PROBE_TRANSPORT_ERROR"], cleanup_state, attested),
      owned_keys: owned,
      duration_ms,
      diagnostic_log: log,
    };
  };

  const finishFaultFail = async (
    reason_code: string,
    fault_class: FaultClass,
    detail: string,
  ): Promise<T5FailureInjectionProbeOutput> => {
    log.push(redactFaultText(`fault ${fault_class}: ${detail}`));
    const cleanup_state = await settleCleanup();
    return {
      receipt: baseReceipt("FAIL", [reason_code], cleanup_state, attested),
      owned_keys: owned,
      duration_ms,
      diagnostic_log: log,
    };
  };

  type StepResult =
    | { readonly kind: "ok"; readonly report: FaultHandlingReport }
    | { readonly kind: "output"; readonly output: T5FailureInjectionProbeOutput };

  // Exactly one attempt per fault class. No retry: an uncertain outcome stays
  // unresolved until provider evidence resolves it.
  const perform = async (work: () => Promise<FaultHandlingReport>): Promise<StepResult> => {
    try {
      const report = await work();
      return { kind: "ok", report };
    } catch (error) {
      if (isUncertainError(error)) return { kind: "output", output: await finishUncertain(messageOf(error)) };
      return { kind: "output", output: await finishTransportError(error) };
    }
  };

  const evidence: string[] = [];
  for (let index = 0; index < FAULT_CLASSES.length; index += 1) {
    const spec = FAULT_CLASSES[index];
    const step = await perform(() => spec.probe(deps, { key: owned[index], input_digest }));
    if (step.kind === "output") return step.output;
    if (!isWellFormedReport(step.report)) {
      return finishFaultFail(
        "FAULT_NEGATIVE_RECEIPT_MALFORMED",
        spec.fault_class,
        "handling report is not a well-formed negative receipt (handling/evidence_digest)",
      );
    }
    if (step.report.handling !== spec.expected_handling) {
      return finishFaultFail(
        spec.unhandled_reason_code,
        spec.fault_class,
        `expected ${spec.expected_handling}, observed ${step.report.handling}: ${step.report.detail}`,
      );
    }
    evidence.push(step.report.evidence_digest);
  }

  log.push(`negative receipts pinned for ${evidence.length} fault classes`);

  const cleanup_state = await settleCleanup();
  const receipt = baseReceipt("PASS", [], cleanup_state, {
    ...attested,
    redacted_receipt_ref: `sha256:${sha256HexFault(evidence.join("|"))}`,
  });
  return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
}
