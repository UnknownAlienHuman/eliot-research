// T5-disclosure-audit probe runner (Phase 10, tests/integration only).
//
// Chosen gate: T5-disclosure-audit. Rationale: the production-readiness plan
// (Phase 10) requires disclosure, inference, source/task and client policies
// to be verified independently, and no gate covers them yet. A policy probe
// has a tiny disposable surface — three synthetic fixture keys under a named
// test generation — so cleanup names exact keys and every check exercises the
// failure model (Intent -> Attempt -> Receipt -> Readback -> Reconciliation)
// without any account.
//
// The four policy dimensions, each with its own reason code:
//   (a) disclosure policy redacts sensitive fields from receipts/logs;
//   (b) inference boundaries hold: no cross-client leakage in shared fixtures;
//   (c) source-task attribution is preserved through redaction;
//   (d) per-client allow/deny is enforced on evidence reads.
//
// Discipline (all branches proven by the companion test file):
// - absent credentials -> NOT_EXECUTED, no dep has any effect;
// - failed policy/code prerequisite or malformed generation -> BLOCKED
//   (distinct from FAIL);
// - performed policy violation -> FAIL with a dimension-specific reason code;
// - timeout / lost response -> RUNNING with SETTLEMENT_UNCERTAIN, each dep
//   operation attempted exactly once, no retry with a new intent;
// - only `live` trials carrying attested worker/data generations can satisfy
//   `gateMayBeReportedAsPass`; a `local` trial is downgraded to unattested
//   identity even if attestation is supplied;
// - synthetic fixtures only: canaries and sensitive shapes are derived from
//   the trial generation and are obviously fake; raw fixture bytes never reach
//   output — receipts carry digests, logs carry redacted text;
// - cleanup names exactly the planted fixture keys, never a prefix, never
//   account discovery.
import { createHash } from "node:crypto";
import type { LiveGateReceipt } from "./gate-state.js";

export const DISCLOSURE_AUDIT_GATE_ID = "T5-disclosure-audit" as const;

export type ProbeMode = "live" | "local";

export interface DisclosureAuditTrial {
  readonly gate_id: typeof DISCLOSURE_AUDIT_GATE_ID;
  readonly mode: ProbeMode;
  readonly environment: string;
  // Named test generation owning every disposable resource, e.g.
  // "testgen-2026-10-01-001". Constrained so a malformed generation can never
  // widen cleanup into a prefix or account scan.
  readonly trial_generation: string;
  // Injected trial clock (epoch ms) for deterministic timings.
  readonly now_ms: number;
  readonly max_age_ms?: number;
  // Live-only attestation. Ignored unless mode === "live".
  readonly worker_generation?: string | null;
  readonly data_generation?: string | null;
}

export type SharedFixtureRead =
  | {
      readonly outcome: "visible";
      readonly excerpt_digest: string;
      readonly attributed_client_id: string;
    }
  | { readonly outcome: "denied"; readonly reason: string };

export type EvidenceRead =
  | { readonly outcome: "allowed"; readonly excerpt_digest: string }
  | { readonly outcome: "denied"; readonly reason: string };

export interface DisclosureAuditDeps {
  // Injected so tests prove the discipline without an account. There is no
  // environment fallback here on purpose: the future staging composition must
  // wire the real binding/credential check explicitly, not inherit one.
  readonly hasLiveCredentials: () => boolean;
  readonly checkPrerequisites: () => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  // Plants one synthetic fixture under an exact key. Returns only the digest
  // of the planted excerpt, never the stored bytes.
  readonly plantFixture: (input: {
    readonly key: string;
    readonly client_id: string;
    readonly canary: string;
  }) => Promise<{ readonly excerpt_digest: string }>;
  // (a) The product's disclosure-redaction entrypoint. Raw synthetic text in,
  // redacted text out.
  readonly redactForDisclosure: (input: { readonly text: string }) => Promise<{ readonly redacted_text: string }>;
  // (b) Shared-fixture read scoped to one client. Cross-client reads must be
  // denied; a visible cross-client read is an inference-boundary violation.
  readonly readSharedFixture: (input: {
    readonly client_id: string;
    readonly fixture_key: string;
  }) => Promise<SharedFixtureRead>;
  // (c) Redaction that must preserve the source-task reference end to end.
  readonly attributeAfterRedaction: (input: {
    readonly text: string;
    readonly source_task_ref: string;
  }) => Promise<{ readonly redacted_text: string; readonly source_task_ref: string }>;
  // (d) Evidence read with per-client allow/deny policy.
  readonly readEvidence: (input: {
    readonly client_id: string;
    readonly evidence_key: string;
  }) => Promise<EvidenceRead>;
  // Exact-key delete only. Must never be called with prefixes or wildcards.
  readonly cleanupKeys: (owned_keys: readonly string[]) => Promise<{ readonly deleted: readonly string[] }>;
}

export interface DisclosureAuditOutput {
  readonly receipt: LiveGateReceipt;
  readonly owned_keys: readonly string[];
  readonly duration_ms: number;
  readonly diagnostic_log: readonly string[];
}

const TRIAL_GENERATION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LIVE_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);
const FINISH_OFFSET_MS = 1_000;
const OBSERVE_OFFSET_MS = 2_000;

// Synthetic client identities for the trial. Obviously fake; the staging
// composition maps these to real policy principals.
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

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

export async function runDisclosureAuditProbe(
  trial: DisclosureAuditTrial,
  deps: DisclosureAuditDeps,
): Promise<DisclosureAuditOutput> {
  const started_at = iso(trial.now_ms);
  const finished_at = iso(trial.now_ms + FINISH_OFFSET_MS);
  const observed_at = iso(trial.now_ms + OBSERVE_OFFSET_MS);
  const duration_ms = OBSERVE_OFFSET_MS;
  const log: string[] = [];
  // Raw synthetic canaries the runner generated. A misbehaving dep may echo
  // them back inside an error or denial reason; the log scrubber below is the
  // backstop so raw fixture bytes never reach output.
  const canaries: string[] = [];

  const scrub = (text: string): string => {
    let out = redactSecretsText(text);
    for (const canary of canaries) out = out.split(canary).join("[REDACTED_CANARY]");
    return out;
  };

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

  // Synthetic canary per client, derived from the trial generation. The digest
  // pins the probe input; the raw canary never leaves dep calls and logs.
  const canaryFor = (clientId: string): string =>
    `SYNTH-CANARY-${sha256Hex(`${trial.trial_generation}:${clientId}`).slice(0, 16)}`;
  const canaryA = canaryFor(CLIENT_A);
  const canaryB = canaryFor(CLIENT_B);
  canaries.push(canaryA, canaryB);

  // Synthetic sensitive shapes for the disclosure check. Obviously fake:
  // derived from the trial generation, example.com domain, never real.
  const synth = (label: string): string => sha256Hex(`${trial.trial_generation}:${label}`).slice(0, 24);
  const syntheticEmail = `synth-probe-${synth("email").slice(0, 12)}@example.com`;
  const syntheticJwt = `eyJhbGciOiJIUzI1NiJ9.${synth("jwt-payload")}.${synth("jwt-sig")}`;
  const syntheticToken = `xoxb-synth-${synth("token").slice(0, 12)}`;
  const sensitiveValues: readonly string[] = [syntheticEmail, syntheticJwt, syntheticToken];
  const sensitiveText = [
    `excerpt marker ${canaryA}`,
    `notify ${syntheticEmail}`,
    `session ${syntheticJwt}`,
    `api ${syntheticToken}`,
  ].join("\n");

  const keyFixtureA = `probe/${trial.trial_generation}/${DISCLOSURE_AUDIT_GATE_ID}/fixture/${CLIENT_A}/001`;
  const keyFixtureB = `probe/${trial.trial_generation}/${DISCLOSURE_AUDIT_GATE_ID}/fixture/${CLIENT_B}/001`;
  const keyEvidenceA = `probe/${trial.trial_generation}/${DISCLOSURE_AUDIT_GATE_ID}/evidence/${CLIENT_A}/001`;
  // The three owned disposable resources. Cleanup below names exactly these.
  const owned = [keyFixtureA, keyFixtureB, keyEvidenceA] as const;
  const ownedKeys: readonly string[] = [...owned];

  // Canonical probe input pinned by digest: fixture descriptors with canary
  // digests only, never raw canary bytes.
  const input_digest = sha256Hex(
    JSON.stringify([
      { key: keyFixtureA, client_id: CLIENT_A, canary_digest: sha256Hex(canaryA) },
      { key: keyFixtureB, client_id: CLIENT_B, canary_digest: sha256Hex(canaryB) },
      { key: keyEvidenceA, client_id: CLIENT_A, canary_digest: sha256Hex(canaryA) },
    ]),
  );

  // Digest-bound source-task reference: attribution must survive redaction.
  const source_task_ref = `task:${sha256Hex(`${trial.trial_generation}:source-task-001`).slice(0, 32)}`;

  // Fail closed before any effect: a malformed generation must never widen
  // cleanup into a prefix, and a live trial must declare a live environment.
  if (!TRIAL_GENERATION.test(trial.trial_generation)) {
    log.push(scrub(`invalid trial generation: ${trial.trial_generation}`));
    return {
      receipt: baseReceipt("BLOCKED", ["INVALID_TRIAL_GENERATION"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }
  if (trial.mode === "live" && !LIVE_ENVIRONMENTS.has(trial.environment)) {
    log.push(scrub(`live trial requires a staging/production environment, got: ${trial.environment}`));
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
    log.push(scrub(`prerequisite not satisfied: ${pre.reason}`));
    return {
      receipt: baseReceipt("BLOCKED", ["PROBE_PREREQUISITE_UNSATISFIED"], "NOT_REQUIRED"),
      owned_keys: [],
      duration_ms,
      diagnostic_log: log,
    };
  }

  const settleCleanup = async (): Promise<LiveGateReceipt["cleanup_state"]> => {
    try {
      const result = await deps.cleanupKeys(ownedKeys);
      return ownedKeys.every((key) => result.deleted.includes(key)) ? "COMPLETE" : "FAILED";
    } catch (error) {
      log.push(scrub(`cleanup failed for owned keys: ${messageOf(error)}`));
      return "FAILED";
    }
  };

  // Attestation binds only live trials. Local trials are downgraded even when
  // attestation is supplied: a local fake can never satisfy the PASS predicate.
  const worker_generation = trial.mode === "live" ? (trial.worker_generation ?? null) : null;
  const data_generation = trial.mode === "live" ? (trial.data_generation ?? null) : null;

  const failWith = async (
    reason_codes: readonly string[],
    redacted_receipt_ref: string | null,
  ): Promise<DisclosureAuditOutput> => {
    const cleanup_state = await settleCleanup();
    const receipt = baseReceipt("FAIL", reason_codes, cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
      redacted_receipt_ref,
    });
    return { receipt, owned_keys: ownedKeys, duration_ms, diagnostic_log: log };
  };

  const leaksSensitive = (text: string): boolean => sensitiveValues.some((value) => text.includes(value));
  const leaksCanary = (text: string): boolean => canaries.some((canary) => text.includes(canary));

  try {
    const plantedA = await deps.plantFixture({ key: keyFixtureA, client_id: CLIENT_A, canary: canaryA });
    const plantedB = await deps.plantFixture({ key: keyFixtureB, client_id: CLIENT_B, canary: canaryB });
    const plantedE = await deps.plantFixture({ key: keyEvidenceA, client_id: CLIENT_A, canary: canaryA });

    // Digests observed per dimension; the receipt carries their digest only.
    const dimensionDigests: string[] = [
      sha256Hex(plantedA.excerpt_digest),
      sha256Hex(plantedB.excerpt_digest),
      sha256Hex(plantedE.excerpt_digest),
    ];
    const policyRef = (): string => `sha256:${sha256Hex(JSON.stringify(dimensionDigests))}`;

    const violations: string[] = [];

    // (a) Disclosure policy: sensitive fields must be redacted, with markers.
    const redactedA = await deps.redactForDisclosure({ text: sensitiveText });
    dimensionDigests.push(sha256Hex(redactedA.redacted_text));
    if (leaksSensitive(redactedA.redacted_text) || !redactedA.redacted_text.includes("[REDACTED_")) {
      log.push(scrub("disclosure redaction leaked a sensitive value or produced no marker"));
      violations.push("DISCLOSURE_REDACTION_LEAK");
    }

    // (b) Inference boundary: own reads stay visible and correctly attributed.
    const readAA = await deps.readSharedFixture({ client_id: CLIENT_A, fixture_key: keyFixtureA });
    if (
      readAA.outcome !== "visible" ||
      readAA.excerpt_digest !== plantedA.excerpt_digest ||
      readAA.attributed_client_id !== CLIENT_A
    ) {
      log.push(scrub("inference boundary: own fixture read failed or was misattributed"));
      violations.push("INFERENCE_BOUNDARY_LEAK");
    }
    const readBB = await deps.readSharedFixture({ client_id: CLIENT_B, fixture_key: keyFixtureB });
    if (
      readBB.outcome !== "visible" ||
      readBB.excerpt_digest !== plantedB.excerpt_digest ||
      readBB.attributed_client_id !== CLIENT_B
    ) {
      log.push(scrub("inference boundary: own fixture read failed or was misattributed"));
      violations.push("INFERENCE_BOUNDARY_LEAK");
    }

    // (b) Inference boundary: cross-client reads must be denied, and even the
    // denial must not leak fixture bytes.
    const crossAB = await deps.readSharedFixture({ client_id: CLIENT_A, fixture_key: keyFixtureB });
    if (crossAB.outcome === "visible") {
      log.push(scrub("inference boundary: cross-client fixture was visible"));
      violations.push("INFERENCE_BOUNDARY_LEAK");
    } else if (leaksCanary(crossAB.reason)) {
      log.push(scrub(`inference boundary: denial leaked fixture bytes: ${crossAB.reason}`));
      violations.push("INFERENCE_BOUNDARY_LEAK");
    }
    const crossBA = await deps.readSharedFixture({ client_id: CLIENT_B, fixture_key: keyFixtureA });
    if (crossBA.outcome === "visible") {
      log.push(scrub("inference boundary: cross-client fixture was visible"));
      violations.push("INFERENCE_BOUNDARY_LEAK");
    } else if (leaksCanary(crossBA.reason)) {
      log.push(scrub(`inference boundary: denial leaked fixture bytes: ${crossBA.reason}`));
      violations.push("INFERENCE_BOUNDARY_LEAK");
    }

    // (c) Source-task attribution must survive redaction unchanged, and the
    // attribution path must not leak sensitive values either.
    const attributed = await deps.attributeAfterRedaction({ text: sensitiveText, source_task_ref });
    dimensionDigests.push(sha256Hex(attributed.redacted_text), sha256Hex(attributed.source_task_ref));
    if (attributed.source_task_ref !== source_task_ref) {
      log.push(scrub("source-task attribution lost through redaction"));
      violations.push("ATTRIBUTION_LOST");
    }
    if (leaksSensitive(attributed.redacted_text)) {
      log.push(scrub("attribution path leaked a sensitive value"));
      violations.push("DISCLOSURE_REDACTION_LEAK");
    }

    // (d) Client policy: the owning client reads, a stranger is denied, and
    // the denial leaks nothing.
    const ownEvidence = await deps.readEvidence({ client_id: CLIENT_A, evidence_key: keyEvidenceA });
    if (ownEvidence.outcome !== "allowed" || ownEvidence.excerpt_digest !== plantedE.excerpt_digest) {
      log.push(scrub("client policy denied the owning client"));
      violations.push("CLIENT_POLICY_OWNER_DENIED");
    }
    const strangerEvidence = await deps.readEvidence({ client_id: CLIENT_B, evidence_key: keyEvidenceA });
    if (strangerEvidence.outcome !== "denied") {
      log.push(scrub("client policy granted a non-owning client"));
      violations.push("CLIENT_POLICY_GRANT_VIOLATION");
    } else if (leaksCanary(strangerEvidence.reason)) {
      log.push(scrub(`client policy denial leaked fixture bytes: ${strangerEvidence.reason}`));
      violations.push("CLIENT_POLICY_GRANT_VIOLATION");
    }

    if (violations.length > 0) {
      return failWith(violations, policyRef());
    }

    const cleanup_state = await settleCleanup();
    const receipt = baseReceipt("PASS", [], cleanup_state, {
      generation_ref: worker_generation,
      worker_generation,
      data_generation,
      redacted_receipt_ref: policyRef(),
    });
    return { receipt, owned_keys: ownedKeys, duration_ms, diagnostic_log: log };
  } catch (error) {
    if (isUncertainError(error)) {
      log.push(scrub(`settlement unknown, no retry: ${messageOf(error)}`));
      const cleanup_state = await settleCleanup();
      const receipt = baseReceipt("RUNNING", ["SETTLEMENT_UNCERTAIN"], cleanup_state, {
        generation_ref: worker_generation,
        worker_generation,
        data_generation,
      });
      return { receipt, owned_keys: ownedKeys, duration_ms, diagnostic_log: log };
    }
    log.push(scrub(`transport error: ${messageOf(error)}`));
    return failWith(["PROBE_TRANSPORT_ERROR"], null);
  }
}
