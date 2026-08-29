import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type ReadinessChannel =
  | "captured" | "normalized" | "structure_qualified" | "exact_ready" | "lexical_ready"
  | "semantic_ready" | "sourcecard_ready" | "atlas_included" | "distillates_ready" | "wiki_published";
export type ReadinessState = "not_requested" | "queued" | "running" | "ready" | "degraded" | "failed" | "stale" | "redacted";

const TRANSITIONS: Readonly<Record<ReadinessState, readonly ReadinessState[]>> = {
  not_requested: ["queued", "redacted"],
  queued: ["running", "failed", "redacted"],
  running: ["ready", "degraded", "failed", "redacted"],
  ready: ["stale", "degraded", "redacted"],
  degraded: ["queued", "running", "ready", "failed", "stale", "redacted"],
  failed: ["queued", "redacted"],
  stale: ["queued", "running", "redacted"],
  redacted: [],
};

export function validateReadinessTransition(current: ReadinessState, next: ReadinessState): Result<ReadinessState, DomainError> {
  return TRANSITIONS[current].includes(next)
    ? ok(next)
    : err(domainError("INVALID_TRANSITION", `${current} cannot transition to ${next}`));
}
