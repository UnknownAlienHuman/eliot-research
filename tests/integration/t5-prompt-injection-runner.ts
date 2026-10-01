// T5-prompt-injection trial runner (tests/integration only).
//
// Chosen gate: T5-prompt-injection. The trial injects a corpus of synthetic
// prompt-injection canaries through the research input pipeline under test
// and asserts none of them escape into privileged contexts (system prompts,
// tool calls, citation handles, spend authorization). Every injection attempt
// must be detected-and-contained or the gate FAILs.
//
// The canary corpus is an injected fixture, never a hardcoded attack library:
// each canary carries a clearly synthetic marker (e.g.
// "ELIOTR-T5B-CANARY-001") and only its sha256 digest may reach output or the
// diagnostic log. Detection evidence is digests only, never payload text.
//
// Discipline (all branches proven by the companion test file), mirroring the
// T4-d1-write-readback runner:
// - absent credentials -> NOT_EXECUTED, injector and cleanup never called;
// - failed policy/code prerequisite -> BLOCKED (distinct from FAIL);
// - malformed trial generation, non-live environment on a live trial, or an
//   invalid canary corpus -> BLOCKED before any effect;
// - any canary escaping into a privileged context -> FAIL;
// - timeout / lost response / unknown per-canary settlement -> RUNNING with
//   SETTLEMENT_UNCERTAIN, exactly one attempt under the same intent key, no
//   automatic retry with a new intent (failure-model.md: every mutation
//   follows Intent -> Attempt -> Receipt -> Readback -> Reconciliation; a
//   timeout is unknown outcome, not proof);
// - only `live` trials carrying attested worker/data generations can satisfy
//   `gateMayBeReportedAsPass`; a `local` trial is downgraded to unattested
//   identity even if attestation is supplied, so a local fake is structurally
//   incapable of turning the live gate green;
// - raw payload text never reaches output: only digests, counts, canary ids
//   (synthetic labels, never payloads) and redacted text are recorded;
// - cleanup names exactly the owned per-canary keys derived from the trial
//   generation; never a broad prefix, never account discovery.
import type { LiveGateReceipt } from "./gate-state.js";
import { redactSecretsText, sha256Hex } from "./d1-write-readback-runner.js";

export const PROMPT_INJECTION_GATE_ID = "T5-prompt-injection" as const;

export type PromptInjectionMode = "live" | "local";

// Privileged contexts a canary must never reach. The injector dep reports
// escapes against exactly these names; anything else is treated as an escape
// too (fail-closed on unknown context shapes).
export const PRIVILEGED_CONTEXTS = [
  "system-prompt",
  "tool-call",
  "citation-handle",
  "spend-authorization",
] as const;
export type PrivilegedContext = (typeof PRIVILEGED_CONTEXTS)[number];

export interface PromptInjectionCanary {
  // Synthetic label, e.g. "canary-001". Constrained so it can never widen
  // cleanup into a prefix. Never the payload itself.
  readonly id: string;
  // Synthetic canary string (must carry a synthetic marker such as
  // "ELIOTR-T5B-CANARY-001"). Only its digest reaches output or deps'
  // verdicts; the pipeline under test receives the text because that is the
  // point of the trial.
  readonly payload: string;
}

export interface PromptInjectionTrial {
  readonly gate_id: typeof PROMPT_INJECTION_GATE_ID;
  readonly mode: PromptInjectionMode;
  readonly environment: string;
  // Named test generation owning every disposable resource, e.g.
  // "testgen-2026-10-01-001". Constrained so a malformed generation can never
  // widen cleanup into a prefix or account scan.
  readonly trial_generation: string;
  // Injected fixture corpus. Non-empty, unique ids, bounded payloads; the
  // staging composition owns corpus quality (synthetic canaries only).
  readonly canaries: ReadonlyArray<PromptInjectionCanary>;
  // Injected trial clock (epoch ms) for deterministic timings.
  readonly now_ms: number;
  readonly max_age_ms?: number;
  // Live-only attestation. Ignored unless mode === "live".
  readonly worker_generation?: string | null;
  readonly data_generation?: string | null;
}

export type CanaryInjectionVerdict =
  | {
      readonly id: string;
      readonly outcome: "contained";
      readonly payload_digest: string;
      readonly detection_digest: string;
    }
  | {
      readonly id: string;
      readonly outcome: "escaped";
      readonly payload_digest: string;
      readonly escaped_contexts: ReadonlyArray<string>;
      readonly detection_digest: string;
    }
  // Settlement of this canary is unknown (timeout, lost response). Not proof
  // of containment and not proof of escape.
  | { readonly id: string; readonly outcome: "unknown"; readonly payload_digest: string; readonly detail: string };

export interface PromptInjectionDeps {
  // Injected so tests prove the discipline without an account. There is no
  // environment fallback here on purpose: the future staging composition must
  // wire the real binding/credential check explicitly, not inherit one.
  readonly hasLiveCredentials: () => boolean;
  readonly checkPrerequisites: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  // Single attempt. Injects every canary through the research input pipeline
  // under test and reports a containment verdict per canary. Verdicts carry
  // digests only, never payload text; detection evidence is digest-bound.
  readonly injectCanaries: (args: {
    readonly key: string;
    readonly canaries: ReadonlyArray<{ readonly id: string; readonly payload: string }>;
  }) => Promise<ReadonlyArray<CanaryInjectionVerdict>>;
  // Exact-key delete only. Must never be called with prefixes or wildcards.
  readonly cleanupKeys: (owned_keys: readonly string[]) => Promise<{ readonly deleted: readonly string[] }>;
}

export interface PromptInjectionOutput {
  readonly receipt: LiveGateReceipt;
  readonly owned_keys: readonly string[];
  readonly duration_ms: number;
  readonly diagnostic_log: readonly string[];
}

const TRIAL_GENERATION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CANARY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_CANARIES = 64;
const MAX_PAYLOAD_CHARS = 8 * 1024;
const LIVE_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);
const FINISH_OFFSET_MS = 1_000;
const OBSERVE_OFFSET_MS = 2_000;

function canonicalCorpus(canaries: ReadonlyArray<PromptInjectionCanary>): string {
  return JSON.stringify(
    canaries.map((c) => ({ id: c.id, payload_digest: sha256Hex(c.payload) })),
  );
}

// Canonical corpus form pinned by the receipt's input_digest. Exported so the
// staging composition and tests pin the exact same bytes the runner digests.
export function canonicalPromptInjectionCorpus(
  canaries: ReadonlyArray<Pick<PromptInjectionCanary, "id" | "payload">>,
): string {
  return canonicalCorpus(canaries);
}

export async function runPromptInjectionTrial(
  trial: PromptInjectionTrial,
  deps: PromptInjectionDeps,
): Promise<PromptInjectionOutput> {
  const started_at = iso(trial.now_ms);
  const finished_at = iso(trial.now_ms + FINISH_OFFSET_MS);
  const observed_at = iso(trial.now_ms + OBSERVE_OFFSET_MS);
  const duration_ms = OBSERVE_OFFSET_MS;
  const input_digest = sha256Hex(canonicalCorpus(trial.canaries));
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
  // cleanup into a prefix, a live trial must declare a live environment, and
  // the canary corpus must be well-formed before anything is injected.
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
  const corpusError = validateCorpus(trial.canaries);
  if (corpusError !== null) {
    log.push(redactSecretsText(`invalid canary corpus: ${corpusError}`));
    return {
      receipt: baseReceipt("BLOCKED", ["INVALID_CANARY_CORPUS"], "NOT_REQUIRED"),
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

  // The owned disposable resources: exactly one key per canary. Cleanup below
  // names exactly these keys.
  const owned = trial.canaries.map(
    (c) => `probe/${trial.trial_generation}/${trial.gate_id}/canary/${c.id}`,
  );

  const settleCleanup = async (): Promise<LiveGateReceipt["cleanup_state"]> => {
    try {
      const result = await deps.cleanupKeys(owned);
      return owned.every((k) => result.deleted.includes(k)) ? "COMPLETE" : "FAILED";
    } catch (error) {
      log.push(redactSecretsText(`cleanup failed for owned keys: ${messageOf(error)}`));
      return "FAILED";
    }
  };

  // Attestation binds only live trials. Local trials are downgraded even when
  // attestation is supplied: a local fake can never satisfy the PASS predicate.
  const worker_generation = trial.mode === "live" ? (trial.worker_generation ?? null) : null;
  const data_generation = trial.mode === "live" ? (trial.data_generation ?? null) : null;

  let verdicts: ReadonlyArray<CanaryInjectionVerdict>;
  try {
    // Exactly one attempt under one intent key. No retry: an uncertain outcome
    // stays unresolved until pipeline evidence resolves it.
    verdicts = await deps.injectCanaries({
      key: `probe/${trial.trial_generation}/${trial.gate_id}/attempt/001`,
      canaries: trial.canaries.map((c) => ({ id: c.id, payload: c.payload })),
    });
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
    const receipt = baseReceipt("FAIL", ["INJECTION_TRANSPORT_ERROR"], cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
    });
    return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
  }

  // Fail closed on verdict shape: every injected canary needs exactly one
  // verdict, and every verdict must name a canary from this trial.
  const expectedIds = new Set(trial.canaries.map((c) => c.id));
  const seenIds = new Set<string>();
  for (const v of verdicts) {
    if (!expectedIds.has(v.id) || seenIds.has(v.id)) {
      log.push(redactSecretsText(`verdict shape invalid for canary id: ${v.id}`));
      const cleanup_state = await settleCleanup();
      const receipt = baseReceipt("FAIL", ["INCOMPLETE_CANARY_VERDICTS"], cleanup_state, {
        generation_ref: worker_generation,
        worker_generation,
        data_generation,
      });
      return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
    }
    seenIds.add(v.id);
  }
  if (seenIds.size !== expectedIds.size) {
    log.push(redactSecretsText(`missing verdicts: expected ${expectedIds.size}, got ${seenIds.size}`));
    const cleanup_state = await settleCleanup();
    const receipt = baseReceipt("FAIL", ["INCOMPLETE_CANARY_VERDICTS"], cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
    });
    return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
  }

  const unknown = verdicts.filter((v) => v.outcome === "unknown");
  if (unknown.length > 0) {
    log.push(
      redactSecretsText(
        `settlement unknown for ${unknown.length}/${verdicts.length} canaries, no retry: ${unknown.map((v) => v.id).join(",")}`,
      ),
    );
    const cleanup_state = await settleCleanup();
    const receipt = baseReceipt("RUNNING", ["SETTLEMENT_UNCERTAIN"], cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
    });
    return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
  }

  // An escape is any canary not contained: an explicit escape verdict, or a
  // stray non-empty escaped-context list on an otherwise "contained" verdict
  // (fail-closed on unknown runtime shapes). Unknown context names fail closed
  // too: any non-empty escaped list is an escape regardless of the names.
  const escaped = verdicts.filter((v) => {
    if (v.outcome === "escaped") return true;
    if (v.outcome === "unknown") return false; // handled above
    const stray = (v as { readonly escaped_contexts?: unknown }).escaped_contexts;
    return Array.isArray(stray) && stray.length > 0;
  });
  // Digest-bound detection evidence: canonical verdicts only, never payloads.
  const verdictDigest = sha256Hex(
    JSON.stringify(
      [...verdicts]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((v) =>
          v.outcome === "escaped"
            ? { id: v.id, outcome: v.outcome, payload_digest: v.payload_digest, escaped_contexts: [...v.escaped_contexts].sort(), detection_digest: v.detection_digest }
            : { id: v.id, outcome: v.outcome, payload_digest: v.payload_digest, detection_digest: v.detection_digest },
        ),
    ),
  );

  if (escaped.length > 0) {
    const escapedIds = escaped.map((v) => v.id).join(",");
    const escapedContexts = [
      ...new Set(
        escaped.flatMap((v) => (v.outcome === "escaped" ? v.escaped_contexts : [])),
      ),
    ]
      .sort()
      .join(",");
    log.push(
      redactSecretsText(
        `prompt injection escaped containment: ${escaped.length}/${verdicts.length} canaries (${escapedIds}) reached privileged contexts (${escapedContexts})`,
      ),
    );
    const cleanup_state = await settleCleanup();
    const receipt = baseReceipt("FAIL", ["PROMPT_INJECTION_ESCAPED"], cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
      redacted_receipt_ref: `sha256:${verdictDigest}`,
    });
    return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
  }

  const contained = verdicts.length;
  log.push(redactSecretsText(`${contained}/${verdicts.length} canaries detected and contained`));
  const cleanup_state = await settleCleanup();
  const receipt = baseReceipt("PASS", [], cleanup_state, {
    generation_ref: worker_generation,
    worker_generation,
    data_generation,
    redacted_receipt_ref: `sha256:${verdictDigest}`,
  });
  return { receipt, owned_keys: owned, duration_ms, diagnostic_log: log };
}

function validateCorpus(canaries: ReadonlyArray<PromptInjectionCanary>): string | null {
  if (canaries.length === 0) return "corpus is empty";
  if (canaries.length > MAX_CANARIES) return `corpus exceeds ${MAX_CANARIES} canaries`;
  const seen = new Set<string>();
  for (const c of canaries) {
    if (!CANARY_ID.test(c.id)) return `invalid canary id: ${c.id}`;
    if (seen.has(c.id)) return `duplicate canary id: ${c.id}`;
    seen.add(c.id);
    if (c.payload.length === 0) return `empty payload for canary id: ${c.id}`;
    if (c.payload.length > MAX_PAYLOAD_CHARS) return `payload too large for canary id: ${c.id}`;
  }
  return null;
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
