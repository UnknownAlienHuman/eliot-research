// T4-d1-write-readback probe runner (ER-27, tests/integration only).
//
// Chosen gate: T4-d1-write-readback. Rationale: it has the smallest disposable
// surface of the T4 family — a single D1 row under a named test generation —
// so cleanup can name exact keys, there is no provider SDK, no destructive
// scope, and the write -> readback -> reconcile loop exercises the failure
// model (Intent -> Attempt -> Receipt -> Readback -> Reconciliation) without
// any account. One runner done properly beats five sketched.
//
// Discipline (all branches proven by the companion test file):
// - absent credentials -> NOT_EXECUTED, executor and cleanup never called;
// - failed policy/code prerequisite -> BLOCKED (distinct from FAIL);
// - performed failed assertion -> FAIL;
// - timeout / lost response -> RUNNING with SETTLEMENT_UNCERTAIN, exactly one
//   attempt under the same intent key, no automatic retry with a new intent
//   (failure-model.md: every mutation follows Intent -> Attempt -> Receipt ->
//   Readback -> Reconciliation; a timeout is unknown outcome, not proof);
// - only `live` trials carrying attested worker/data generations can satisfy
//   `gateMayBeReportedAsPass`; a `local` trial is downgraded to unattested
//   identity even if attestation is supplied, so a local fake is structurally
//   incapable of turning the live gate green;
// - raw input values, prompts, source text and secrets never reach output:
//   only digests and redacted text are recorded;
// - cleanup names exactly the owned key derived from the trial generation;
//   never a broad prefix, never account discovery.
import { createHash } from "node:crypto";
import type { LiveGateReceipt } from "./gate-state.js";

export const D1_WRITE_READBACK_GATE_ID = "T4-d1-write-readback" as const;

export type ProbeMode = "live" | "local";

export interface D1ProbeTrial {
  readonly gate_id: typeof D1_WRITE_READBACK_GATE_ID;
  readonly mode: ProbeMode;
  readonly environment: string;
  // Named test generation owning every disposable resource, e.g.
  // "testgen-2026-09-08-001". Constrained so a malformed generation can never
  // widen cleanup into a prefix or account scan.
  readonly trial_generation: string;
  // Row value under test. Only its sha256 digest may reach output or deps.
  readonly input_value: string;
  // Injected trial clock (epoch ms) for deterministic timings.
  readonly now_ms: number;
  readonly max_age_ms?: number;
  // Live-only attestation. Ignored unless mode === "live".
  readonly worker_generation?: string | null;
  readonly data_generation?: string | null;
}

export type WriteReadbackResult =
  | { readonly outcome: "match"; readonly readback_digest: string }
  | { readonly outcome: "mismatch"; readonly readback_digest: string; readonly detail: string }
  // Timeout, lost response, or any provider reply whose settlement is unknown.
  | { readonly outcome: "unknown"; readonly detail: string };

export interface D1ProbeDeps {
  // Injected so tests prove the discipline without an account. There is no
  // environment fallback here on purpose: the future staging composition must
  // wire the real binding/credential check explicitly, not inherit one.
  readonly hasLiveCredentials: () => boolean;
  readonly checkPrerequisites: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  // Single attempt. Receives the digest only, never the raw input value.
  readonly executeWriteReadback: (args: {
    readonly key: string;
    readonly value_digest: string;
  }) => Promise<WriteReadbackResult>;
  // Exact-key delete only. Must never be called with prefixes or wildcards.
  readonly cleanupKeys: (owned_keys: readonly string[]) => Promise<{ readonly deleted: readonly string[] }>;
}

export interface D1ProbeOutput {
  readonly receipt: LiveGateReceipt;
  readonly owned_keys: readonly string[];
  readonly duration_ms: number;
  readonly diagnostic_log: readonly string[];
}

const TRIAL_GENERATION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
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

export function redactSecretsText(text: string): string {
  let out = text;
  for (const [shape, marker] of REDACTIONS) out = out.replace(shape, marker);
  return out;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function runD1WriteReadbackProbe(trial: D1ProbeTrial, deps: D1ProbeDeps): Promise<D1ProbeOutput> {
  const started_at = iso(trial.now_ms);
  const finished_at = iso(trial.now_ms + FINISH_OFFSET_MS);
  const observed_at = iso(trial.now_ms + OBSERVE_OFFSET_MS);
  const duration_ms = OBSERVE_OFFSET_MS;
  const input_digest = sha256Hex(trial.input_value);
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
    log.push(redactSecretsText(`invalid trial generation: ${trial.trial_generation}`));
    return {
      receipt: baseReceipt("BLOCKED", ["INVALID_TRIAL_GENERATION"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }
  if (trial.mode === "live" && !LIVE_ENVIRONMENTS.has(trial.environment)) {
    log.push(redactSecretsText(`live trial requires a staging/production environment, got: ${trial.environment}`));
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
    log.push(redactSecretsText(`prerequisite not satisfied: ${pre.reason}`));
    return {
      receipt: baseReceipt("BLOCKED", ["PROBE_PREREQUISITE_UNSATISFIED"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }

  // The single owned disposable resource. Cleanup below names exactly this key.
  const owned_keys = [`probe/${trial.trial_generation}/${trial.gate_id}/row/001`] as const;
  const owned = [...owned_keys];

  const settleCleanup = async (): Promise<LiveGateReceipt["cleanup_state"]> => {
    try {
      const result = await deps.cleanupKeys(owned);
      return result.deleted.includes(owned[0]) ? "COMPLETE" : "FAILED";
    } catch (error) {
      log.push(redactSecretsText(`cleanup failed for owned key: ${error instanceof Error ? error.message : String(error)}`));
      return "FAILED";
    }
  };

  // Attestation binds only live trials. Local trials are downgraded even when
  // attestation is supplied: a local fake can never satisfy the PASS predicate.
  const worker_generation = trial.mode === "live" ? (trial.worker_generation ?? null) : null;
  const data_generation = trial.mode === "live" ? (trial.data_generation ?? null) : null;

  let result: WriteReadbackResult;
  try {
    // Exactly one attempt under one intent key. No retry: an uncertain outcome
    // stays unresolved until provider evidence resolves it.
    result = await deps.executeWriteReadback({ key: owned[0], value_digest: input_digest });
  } catch (error) {
    if (isUncertainError(error)) {
      log.push(redactSecretsText(`settlement unknown, no retry: ${messageOf(error)}`));
      const cleanup_state = await settleCleanup();
      const receipt = baseReceipt("RUNNING", ["SETTLEMENT_UNCERTAIN"], cleanup_state, {
        generation_ref: worker_generation,
        worker_generation,
        data_generation,
      });
      return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
    }
    log.push(redactSecretsText(`transport error: ${messageOf(error)}`));
    const cleanup_state = await settleCleanup();
    const receipt = baseReceipt("FAIL", ["PROBE_TRANSPORT_ERROR"], cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
    });
    return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
  }

  if (result.outcome === "unknown") {
    log.push(redactSecretsText(`settlement unknown, no retry: ${result.detail}`));
    const cleanup_state = await settleCleanup();
    const receipt = baseReceipt("RUNNING", ["SETTLEMENT_UNCERTAIN"], cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
    });
    return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
  }

  if (result.outcome === "mismatch") {
    log.push(redactSecretsText(`readback mismatch: ${result.detail}`));
    const cleanup_state = await settleCleanup();
    const receipt = baseReceipt("FAIL", ["PROBE_ASSERTION_MISMATCH"], cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
      redacted_receipt_ref: `sha256:${result.readback_digest}`,
    });
    return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
  }

  const cleanup_state = await settleCleanup();
  const receipt = baseReceipt("PASS", [], cleanup_state, {
    generation_ref: worker_generation,
    worker_generation,
    data_generation,
    redacted_receipt_ref: `sha256:${result.readback_digest}`,
  });
  return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
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
