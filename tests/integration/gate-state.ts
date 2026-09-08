export type LiveGateState = "NOT_EXECUTED" | "RUNNING" | "PASS" | "FAIL" | "BLOCKED";

export interface LiveGateReceipt {
  readonly gate_id: string;
  readonly state: LiveGateState;
  readonly environment: string;
  readonly generation_ref: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly redacted_receipt_ref: string | null;
  readonly reason_codes: readonly string[];
  readonly cleanup_state: "NOT_REQUIRED" | "PENDING" | "COMPLETE" | "FAILED";
  // Identity/freshness bindings. Null until a live trial attests them; every
  // non-null binding below is mandatory before a receipt may be reported PASS.
  // `worker_generation` is the deployed Worker/config generation the observation
  // was read back against; `data_generation` is the data/index generation.
  // `test_id` must equal `gate_id`; `input_digest` pins the canonical probe input.
  // `observed_at` is when the readback observation completed.
  readonly worker_generation: string | null;
  readonly data_generation: string | null;
  readonly test_id: string | null;
  readonly input_digest: string | null;
  readonly observed_at: string | null;
}

export function initialLiveGateReceipt(gateId: string, environment: string): LiveGateReceipt {
  return {
    gate_id: gateId,
    state: "NOT_EXECUTED",
    environment,
    generation_ref: null,
    started_at: null,
    finished_at: null,
    redacted_receipt_ref: null,
    reason_codes: ["LIVE_CREDENTIALS_OR_BINDINGS_NOT_PRESENT"],
    cleanup_state: "NOT_REQUIRED",
    worker_generation: null,
    data_generation: null,
    test_id: null,
    input_digest: null,
    observed_at: null,
  };
}

// Only these environments may ever carry release evidence. In particular a
// `development` (or any local) observation can never satisfy the PASS predicate,
// which is what makes "local fakes cannot turn a live gate green" structural.
const LIVE_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Redacted handles are digest/key references, never raw secrets. Bounded,
// whitespace-free, and explicitly refusing JWT/PEM/token-shaped material.
const RECEIPT_HANDLE = /^[A-Za-z0-9:_\-./]{8,256}$/;
const SECRET_SHAPES: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]*\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[baprs]-/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bbearer\s+\S+/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseInstant(value: string | null | undefined): number | null {
  if (!isNonEmpty(value)) return null;
  const text = value.trim();
  if (!ISO8601_UTC.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

function isRedactedHandle(ref: string | null | undefined): boolean {
  if (!isNonEmpty(ref)) return false;
  const text = ref.trim();
  if (!RECEIPT_HANDLE.test(text)) return false;
  return !SECRET_SHAPES.some((shape) => shape.test(text));
}

export interface GatePassOptions {
  // Trial clock in epoch milliseconds. The structural ordering
  // (started <= finished <= observed) is always enforced; the absolute replay
  // window (observed within maxAgeMs of nowMs, never in the future) is enforced
  // only when nowMs is supplied. Release evidence MUST supply the trial clock:
  // without it a stale receipt cannot be distinguished from a current pass.
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
}

export function gateMayBeReportedAsPass(receipt: LiveGateReceipt, opts: GatePassOptions = {}): boolean {
  if (receipt.state !== "PASS") return false;
  if (!LIVE_ENVIRONMENTS.has(receipt.environment)) return false;
  if (!isNonEmpty(receipt.generation_ref)) return false;
  if (!isNonEmpty(receipt.worker_generation)) return false;
  if (!isNonEmpty(receipt.data_generation)) return false;
  if (!isNonEmpty(receipt.gate_id) || receipt.test_id !== receipt.gate_id) return false;
  if (typeof receipt.input_digest !== "string" || !SHA256_HEX.test(receipt.input_digest)) return false;
  const started = parseInstant(receipt.started_at);
  const finished = parseInstant(receipt.finished_at);
  const observed = parseInstant(receipt.observed_at);
  if (started === null || finished === null || observed === null) return false;
  if (!(started <= finished && finished <= observed)) return false;
  if (opts.nowMs !== undefined) {
    const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (!(observed <= opts.nowMs && opts.nowMs - observed <= maxAge)) return false;
  }
  if (!isRedactedHandle(receipt.redacted_receipt_ref)) return false;
  if (receipt.reason_codes.length !== 0) return false;
  return receipt.cleanup_state === "COMPLETE" || receipt.cleanup_state === "NOT_REQUIRED";
}

// Honestly out of scope for this predicate (no live observation available here,
// and a check that always passes would be worse than none):
// - generation *currency*: that worker_generation/data_generation equal the
//   actually-deployed Worker and live data generations requires the missing
//   binding/version attestation reader (cloudflare-handoff: the current bounded
//   inventory receipt does NOT prove binding/version identity). Presence and
//   shape are enforced above; equality against deployment must be attested by
//   that reader before release evidence is produced.
// - cost/bounds/rollback-target presence: without a live cost observer any such
//   check would always pass; the runner records timings and leaves cost to the
//   staging trial.
