// T5-erasure-restore probe runner (tests/integration only).
//
// Chosen gate: T5-erasure-restore. Rationale: it is the erasure side of the
// T5 live-gate family — a disposable source is ingested under a named test
// generation, erased through the erasure-request flow, read back (must fail
// closed with an exact absence proof), then the purge-ledger replay must show
// the content still absent after rebuild. Cleanup names one exact key, never a
// prefix or account discovery.
//
// Staging composition map (the runner stays dependency-injected; the future
// staging wire-up binds each dep against the real erasure package):
// - ingestDisposableSource -> disposable ingest through the owner HTTP surface
//   (apps/eliotr-core/src/erasure-owner-http.ts request shapes);
// - eraseSource -> erasure request admission + execution per
//   erc.privacy.erasure.v1 (packages/cloudflare-erasure: admission-policy,
//   authority, erasure-targets, closure-completeness);
// - readbackErased -> absence readback for every requested PurgeLocation
//   (packages/cloudflare-erasure: every location must verify absence or the
//   erasure is BLOCKED, never complete);
// - verifyPurgeReplay -> purge-ledger replay via appendPurgeLedger durable
//   readback (packages/cloudflare-erasure/ledger.ts): exact erasure closure
//   read back after rebuild, content must still be absent.
//
// Discipline (all branches proven by the companion test file):
// - absent credentials -> NOT_EXECUTED, no dep is called;
// - failed policy/code prerequisite -> BLOCKED (distinct from FAIL);
// - malformed trial generation, non-digest source label, or a live trial in a
//   non-live environment -> BLOCKED before any effect;
// - ingest/erase not confirmed -> FAIL (performed assertion);
// - readback after erasure returns "present" -> FAIL: the core T5-A assertion
//   is that an erased source fails closed with an exact absence proof;
// - purge-ledger replay returns "present" -> FAIL: content survived rebuild;
// - timeout / lost response / unknown outcome at any step -> RUNNING with
//   SETTLEMENT_UNCERTAIN, exactly one attempt per step, no automatic retry
//   (failure-model.md: a timeout is unknown outcome, not proof);
// - only `live` trials carrying attested worker/data generations can satisfy
//   `gateMayBeReportedAsPass`; a `local` trial is downgraded to unattested
//   identity even if attestation is supplied, so a local fake is structurally
//   incapable of turning the live gate green;
// - raw labels, prompts, source text and secrets never reach output: the trial
//   carries only the source-label digest, and output carries digests plus
//   redacted text;
// - cleanup names exactly the owned key derived from the trial generation.
import { redactSecretsText } from "./redact.js";
import type { ProbeMode } from "./d1-write-readback-runner.js";
import type { LiveGateReceipt } from "./gate-state.js";

export const T5_ERASURE_RESTORE_GATE_ID = "T5-erasure-restore" as const;

export interface T5ErasureTrial {
  readonly gate_id: typeof T5_ERASURE_RESTORE_GATE_ID;
  readonly mode: ProbeMode;
  readonly environment: string;
  // Named test generation owning every disposable resource, e.g.
  // "testgen-2026-10-01-001". Constrained so a malformed generation can never
  // widen cleanup into a prefix or account scan.
  readonly trial_generation: string;
  // Digest (64 hex) of the disposable source label. The raw label never
  // reaches the runner: only this digest is pinned in the receipt.
  readonly source_label_digest: string;
  // Injected trial clock (epoch ms) for deterministic timings.
  readonly now_ms: number;
  // Reserved for the release-evidence predicate window (maxAgeMs). The runner
  // does not evaluate the window itself; the evidence consumer applies it.
  readonly max_age_ms?: number;
  // Live-only attestation. Ignored unless mode === "live".
  readonly worker_generation?: string | null;
  readonly data_generation?: string | null;
}

export type ErasureRestoreResult =
  // The location failed closed: the content is absent and the proof is an
  // exact, digest-pinned absence proof (never raw bytes).
  | { readonly outcome: "absent"; readonly absence_proof_digest: string }
  // The content is still readable after erasure: the core negative case.
  | { readonly outcome: "present"; readonly detail: string }
  // Timeout, lost response, or any reply whose settlement is unknown.
  | { readonly outcome: "unknown"; readonly detail: string };

export interface T5ErasureDeps {
  // Injected so tests prove the discipline without an account. There is no
  // environment fallback here on purpose: the future staging composition must
  // wire the real binding/credential check explicitly, not inherit one.
  readonly hasLiveCredentials: () => boolean;
  readonly checkPrerequisites: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  // Ingest the disposable source addressed by the owned key. Receives digests
  // only, never the raw label or source bytes.
  readonly ingestDisposableSource: (args: {
    readonly key: string;
    readonly source_label_digest: string;
  }) => Promise<{ readonly ingested: boolean }>;
  // Perform the erasure-request flow (erc.privacy.erasure.v1). Returns the
  // erasure ref so the ledger replay can re-read the exact closure.
  readonly eraseSource: (args: {
    readonly key: string;
  }) => Promise<{ readonly erased: boolean; readonly erasure_ref: string }>;
  // Readback after erasure: must fail closed with an exact absence proof.
  readonly readbackErased: (args: {
    readonly key: string;
  }) => Promise<ErasureRestoreResult>;
  // Purge-ledger replay after rebuild: the content must still be absent.
  readonly verifyPurgeReplay: (args: {
    readonly key: string;
    readonly erasure_ref: string;
  }) => Promise<ErasureRestoreResult>;
  // Exact-key delete only. Must never be called with prefixes or wildcards.
  readonly cleanupKeys: (owned_keys: readonly string[]) => Promise<{ readonly deleted: readonly string[] }>;
}

export interface T5ErasureProbeOutput {
  readonly receipt: LiveGateReceipt;
  readonly owned_keys: readonly string[];
  readonly duration_ms: number;
  readonly diagnostic_log: readonly string[];
}

const TRIAL_GENERATION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LIVE_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);
const FINISH_OFFSET_MS = 1_000;
const OBSERVE_OFFSET_MS = 2_000;

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

export async function runT5ErasureRestoreProbe(
  trial: T5ErasureTrial,
  deps: T5ErasureDeps,
): Promise<T5ErasureProbeOutput> {
  const started_at = iso(trial.now_ms);
  const finished_at = iso(trial.now_ms + FINISH_OFFSET_MS);
  const observed_at = iso(trial.now_ms + OBSERVE_OFFSET_MS);
  const duration_ms = OBSERVE_OFFSET_MS;
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
    input_digest: trial.source_label_digest,
    observed_at,
    ...extra,
  });

  // Fail closed before any effect: a malformed generation must never widen
  // cleanup into a prefix, the source label must be digest-pinned, and a live
  // trial must declare a live environment.
  if (!TRIAL_GENERATION.test(trial.trial_generation)) {
    log.push(redactSecretsText(`invalid trial generation: ${trial.trial_generation}`));
    return {
      receipt: baseReceipt("BLOCKED", ["INVALID_TRIAL_GENERATION"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }
  if (!SHA256_HEX.test(trial.source_label_digest)) {
    log.push(redactSecretsText(`invalid source label digest: ${trial.source_label_digest}`));
    return {
      receipt: baseReceipt("BLOCKED", ["INVALID_SOURCE_LABEL_DIGEST"], "NOT_REQUIRED"),
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
  const owned_keys = [`probe/${trial.trial_generation}/${trial.gate_id}/source/001`] as const;
  const owned = [...owned_keys];

  const settleCleanup = async (): Promise<LiveGateReceipt["cleanup_state"]> => {
    try {
      const result = await deps.cleanupKeys(owned);
      return result.deleted.includes(owned[0]) ? "COMPLETE" : "FAILED";
    } catch (error) {
      log.push(redactSecretsText(`cleanup failed for owned key: ${messageOf(error)}`));
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

  const finishUncertain = async (detail: string): Promise<T5ErasureProbeOutput> => {
    log.push(redactSecretsText(`settlement unknown, no retry: ${detail}`));
    const cleanup_state = await settleCleanup();
    return {
      receipt: baseReceipt("RUNNING", ["SETTLEMENT_UNCERTAIN"], cleanup_state, attested),
      owned_keys: owned,
      duration_ms,
      diagnostic_log: log,
    };
  };

  const finishTransportError = async (error: unknown): Promise<T5ErasureProbeOutput> => {
    log.push(redactSecretsText(`transport error: ${messageOf(error)}`));
    const cleanup_state = await settleCleanup();
    return {
      receipt: baseReceipt("FAIL", ["PROBE_TRANSPORT_ERROR"], cleanup_state, attested),
      owned_keys: owned,
      duration_ms,
      diagnostic_log: log,
    };
  };

  type StepResult<T> =
    | { readonly kind: "ok"; readonly value: T }
    | { readonly kind: "output"; readonly output: T5ErasureProbeOutput };

  // Exactly one attempt per step. No retry: an uncertain outcome stays
  // unresolved until provider evidence resolves it.
  const perform = async <T>(work: () => Promise<T>): Promise<StepResult<T>> => {
    try {
      return { kind: "ok", value: await work() };
    } catch (error) {
      if (isUncertainError(error)) return { kind: "output", output: await finishUncertain(messageOf(error)) };
      return { kind: "output", output: await finishTransportError(error) };
    }
  };

  const finishAssertionFail = async (
    reason_code: string,
    detail: string,
  ): Promise<T5ErasureProbeOutput> => {
    log.push(redactSecretsText(detail));
    const cleanup_state = await settleCleanup();
    return {
      receipt: baseReceipt("FAIL", [reason_code], cleanup_state, attested),
      owned_keys: owned,
      duration_ms,
      diagnostic_log: log,
    };
  };

  const checkAbsence = async (
    result: ErasureRestoreResult,
    present_reason: string,
    present_detail: string,
  ): Promise<StepResult<string>> => {
    if (result.outcome === "unknown") {
      return { kind: "output", output: await finishUncertain(result.detail) };
    }
    if (result.outcome === "present") {
      return { kind: "output", output: await finishAssertionFail(present_reason, present_detail) };
    }
    if (!SHA256_HEX.test(result.absence_proof_digest)) {
      return {
        kind: "output",
        output: await finishAssertionFail("PROBE_ASSERTION_MISMATCH", "absence proof is not a pinned digest"),
      };
    }
    return { kind: "ok", value: result.absence_proof_digest };
  };

  // Step 1: ingest the disposable source (digests only).
  const ingest = await perform(() =>
    deps.ingestDisposableSource({ key: owned[0], source_label_digest: trial.source_label_digest }),
  );
  if (ingest.kind === "output") return ingest.output;
  if (!ingest.value.ingested) {
    return finishAssertionFail("PROBE_ASSERTION_MISMATCH", "ingest did not confirm the disposable source");
  }

  // Step 2: erase it through the erasure-request flow.
  const erase = await perform(() => deps.eraseSource({ key: owned[0] }));
  if (erase.kind === "output") return erase.output;
  if (!erase.value.erased) {
    return finishAssertionFail("PROBE_ASSERTION_MISMATCH", "erase did not confirm erasure of the disposable source");
  }

  // Step 3: readback after erasure must fail closed with an exact absence proof.
  const readback = await perform(() => deps.readbackErased({ key: owned[0] }));
  if (readback.kind === "output") return readback.output;
  const readbackProof = await checkAbsence(
    readback.value,
    "ERASURE_READBACK_NOT_ABSENT",
    `erased source read back present: ${readback.value.outcome === "present" ? readback.value.detail : ""}`,
  );
  if (readbackProof.kind === "output") return readbackProof.output;

  // Step 4: purge-ledger replay after rebuild must still show the content absent.
  const replay = await perform(() =>
    deps.verifyPurgeReplay({ key: owned[0], erasure_ref: erase.value.erasure_ref }),
  );
  if (replay.kind === "output") return replay.output;
  const replayProof = await checkAbsence(
    replay.value,
    "PURGE_REPLAY_CONTENT_PRESENT",
    `purge-ledger replay found content present after rebuild: ${replay.value.outcome === "present" ? replay.value.detail : ""}`,
  );
  if (replayProof.kind === "output") return replayProof.output;

  log.push(`absence proofs pinned: readback sha256:${readbackProof.value}, ledger replay sha256:${replayProof.value}`);

  const cleanup_state = await settleCleanup();
  const receipt = baseReceipt("PASS", [], cleanup_state, {
    ...attested,
    redacted_receipt_ref: `sha256:${readbackProof.value}`,
  });
  return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
}
