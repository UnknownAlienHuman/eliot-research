/**
 * ER-335 mutation-outcome classifier, revision 4.
 *
 * Revision 4 is a bounded repair over revision 3, which was rejected on causal source review for
 * two further defects found in its rejection maps. Like revision 3 it removes every claim that
 * could not be anchored to a throw site proving the mutation was refused before its durable
 * effect, and it fixes one control-flow defect.
 *
 * Defects repaired, each confirmed at the exact line before removal:
 *
 *  1. RAW_CAPTURE_RESPONSE_INVALID was listed as a definitive capture rejection. It is thrown at
 *     seven sites in sources/import/raw.ts, and only some of them are pre-effect. Line 133 and 141
 *     reject a malformed captured_at inside a locally built receipt, line 148 rejects a local digest
 *     port result, and 246, 259, 284 and 289 reject the awaited server capture response. The same
 *     code therefore cannot clear a capture intent by code alone. It is now classified as an
 *     unconfirmed outcome, which preserves the capture identity for readback.
 *
 *  2. API_VALIDATOR_MISMATCH was listed as a pre-effect transport code. It is thrown at
 *     transport/body.ts:138, after the response arrived, when the representation validator did not
 *     match the expected strong validator. It moved to the unconfirmed list.
 *
 *  3. ARTIFACT_SECTION_REVISE_PROTOCOL was listed as a rejection code. It is a string literal
 *     constant declared in cloudflare-workflows/src/artifact-cow-workflow.ts:4 and never thrown as
 *     a typed error, so no throw evidence exists. It is removed, with no replacement.
 *
 *  4. BUNDLE_FILE_SET_INVALID and BUNDLE_HASH_MANIFEST_INVALID were listed as bundle rejections.
 *     Neither has any occurrence in the owner-api-client or the core source, so no causal throw
 *     path exists. Both are removed, with no replacement. BUNDLE_INPUT_INVALID remains because it
 *     is a real client input guard.
 *
 *  5. WIKI_HEAD_CONFLICT was listed as a definitive wiki.publish rejection. The code is thrown
 *     from both pre-effect and post-effect sites on the same publish path, so it cannot clear a
 *     publish intent. It is removed; see the map for the exact anchors on each side.
 *
 *  6. RESEARCH_RUN_CONFIGURATION_REQUIRED was listed as a research.run.admit rejection. It is
 *     thrown only from apps/eliotr-core/src/artifact-report-admission.ts, which resolves the
 *     original run of an artifact REPORT product, so it never reaches the run admission path. It is
 *     removed with no replacement.
 *
 * Control-flow defect repaired:
 * The unregistered-operation early return ran before the authorization-loss check, so an
 * authorization loss observed on an unregistered operation was silently reported as an unknown
 * outcome. Authorization and session loss are owned by the privacy controller and apply to every
 * operation, so the loss check now precedes the operation-map lookup.
 *
 * Properties carried forward unchanged from revision 2. An awaited server-typed rejection is
 * definitive whether or not the request had been dispatched, because dispatch only means a request
 * was written. Definitive status comes from the operation-and-code pair alone. There is no
 * status-range fallback and no prefix inference. Success stays a separate path that an observed
 * authorization loss overrides.
 */

/** Whether a refused mutation produced its server effect. */
export type MutationOutcomeClass =
  | "REJECTED_BEFORE_EFFECT"
  | "OUTCOME_UNKNOWN"
  | "COMMITTED"
  | "AUTHORIZATION_LOSS";

/** The exact bounded action presentation must offer. Never an automatic repeat. */
export type MutationOutcomeAction =
  | "REVIEW_CONFLICT"
  | "REVIEW_CURRENT_AUTHORITY"
  | "REVIEW_EVIDENCE_INCOMPLETE"
  | "READBACK_STATUS"
  | "RESOLVE_AUTHORIZATION";

export interface MutationOutcomeClassification {
  readonly outcome: MutationOutcomeClass;
  readonly action: MutationOutcomeAction;
  readonly reason: string;
  /** True only when the caller may clear its blocking intent and keep the editable owner input. */
  readonly clearsIntent: boolean;
  /** True only when the exact body, idempotency and CAS identity must be retained for readback. */
  readonly preservesIdentity: boolean;
}

export interface MutationOutcomeInput {
  /** The registered operation identity. An unregistered operation can never be definitive. */
  readonly operation: string;
  /** The exact code from the raised typed error, bounded by problem.ts:78. */
  readonly code?: string;
  readonly status?: number;
  /**
   * Retained for diagnostics only. It never widens or narrows a class, because a definitive
   * awaited rejection is definitive whether or not the request had been dispatched.
   */
  readonly dispatched?: boolean;
}

export interface MutationOutcomeSuccessInput {
  readonly operation: string;
  /**
   * The exact authorization-loss code observed for this response, when the privacy controller
   * already reported one. A claimed success can never override it.
   */
  readonly authorizationLossCode?: string;
}

/**
 * Closed per-operation rejection maps. Every surviving key was confirmed at a real throw site.
 *
 * The raw capture map is empty rather than permissive. RAW_CAPTURE_RESPONSE_INVALID is emitted
 * from both local and post-response paths, so no code can be definitive for that operation by
 * code alone, and an empty map is the honest answer. The bundle map keeps only
 * BUNDLE_INPUT_INVALID, which is a real client input guard. The artifact revise map keeps only
 * codes that are actually thrown; the protocol literal constant is not one of them.
 */
const OPERATION_REJECTIONS: Readonly<
  Record<string, Readonly<Record<string, MutationOutcomeAction>>>
> = Object.freeze({
  // apps/eliotr-core/src/research-run-service.ts. Each conflict throws while resolving the
  // idempotency identity or lane, before the ledger create and the Workflow dispatch.
  "research.run.admit": Object.freeze({
    RESEARCH_CONFLICT: "REVIEW_CONFLICT",
    RESEARCH_AUTHORITY_STALE: "REVIEW_CURRENT_AUTHORITY",
    RESEARCH_INPUT_INVALID: "REVIEW_CONFLICT",
    // 503 before any effect: the stored question schema generation predates this request, so the run
    // is refused before the ledger application and before any Workflow dispatch.
    RESEARCH_INPUT_SCHEMA_MISMATCH: "REVIEW_CONFLICT",
    RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE: "REVIEW_CURRENT_AUTHORITY",
  }),

  // packages/cloudflare-wiki/src/wiki-publication-store.ts. WIKI_POLICY_DENIED and
  // WIKI_SETTLEMENT_UNCERTAIN both throw before database.batch(statements), so the
  // publication write never happened. The two WIKI_PROPOSAL_* refusals throw while the proposal is
  // loaded back and digests are checked, which is before any R2 put. WIKI_INPUT_INVALID and
  // WIKI_OWNER_REQUIRED are entry guards on the request itself. The two codes that can be raised
  // both before and after the durable write are absent; see the map below.
  "wiki.publish": Object.freeze({
    WIKI_POLICY_DENIED: "REVIEW_CURRENT_AUTHORITY",
    WIKI_PUBLICATION_INCOMPLETE: "REVIEW_EVIDENCE_INCOMPLETE",
    WIKI_PROPOSAL_NOT_FOUND: "REVIEW_CURRENT_AUTHORITY",
    WIKI_PROPOSAL_READBACK_MISMATCH: "REVIEW_CONFLICT",
    // WIKI_HEAD_CONFLICT is deliberately absent. The same code can be raised before the
    // immutable R2 write (stale expected head or a proposal/commit mismatch) and after that write
    // while the direct revision/head/proposal/change transaction is reconciled. The code alone
    // therefore cannot prove that no durable effect occurred; preserve the frozen identity and
    // recover by exact readback. See the HANDOFF audit and the
    // mutation-outcome-source-peer-luna-20261013 MO-001 finding.
    //
    // WIKI_IMMUTABLE_READBACK_MISMATCH is absent for the same reason. Both the immutable R2 write
    // and the post-transaction head/closure readback can fail after bytes or D1 state changed.
    WIKI_INPUT_INVALID: "REVIEW_CONFLICT",
    WIKI_OWNER_REQUIRED: "REVIEW_CURRENT_AUTHORITY",
  }),
  // wiki-create.ts validates input before POST. Server owner-edit input guards (including
  // revision overflow at wiki-owner-edit-proposal.ts:482) precede immutable puts at 551/552.
  // WIKI_HEAD_CONFLICT is excluded: the server also emits it after those puts at 557.
  "wiki.propose": Object.freeze({
    WIKI_INPUT_INVALID: "REVIEW_CONFLICT",
  }),

  // apps/eliotr-core/src/artifact-product-composition.ts.
  "artifact.accept": Object.freeze({
    ARTIFACT_PRODUCT_INPUT_INVALID: "REVIEW_CONFLICT",
    ARTIFACT_PUBLICATION_DENIED: "REVIEW_CURRENT_AUTHORITY",
    ARTIFACT_PUBLICATION_STALE: "REVIEW_CONFLICT",
  }),
  // artifact.revise is registered with an empty map on purpose. No demonstrated pre-effect refusal
  // was found for the revise path, so an empty map is the conservative answer rather than a guess.
  "artifact.revise": Object.freeze({} as Readonly<Record<string, MutationOutcomeAction>>),

  // packages/cloudflare-erasure/src/admission-policy.ts. These are the only two members of
  // ErasureAdmissionErrorCode, and both are thrown before any erasure effect runs.
  "erasure.execute": Object.freeze({
    ERASURE_PERMISSION_DENIED: "REVIEW_CURRENT_AUTHORITY",
    ERASURE_PERMISSION_CONFLICT: "REVIEW_CONFLICT",
  }),

  // packages/owner-api-client/src/sources/import/bundle.ts. Only the input guard is proven.
  "import.bundle.import": Object.freeze({
    BUNDLE_INPUT_INVALID: "REVIEW_CONFLICT",
  }),

  // sources/import/raw.ts and ingest-http.ts. The capture response code is deliberately absent
  // because the same code is emitted from local and post-response paths. The raw admission
  // rejections below are typed input or state refusals before the durable operation.
  "import.raw.capture": Object.freeze({} as Readonly<Record<string, MutationOutcomeAction>>),
  "import.raw.admit": Object.freeze({
    RAW_ADMISSION_INPUT_INVALID: "REVIEW_CONFLICT",
    INGEST_STATE_CONFLICT: "REVIEW_CONFLICT",
    INGEST_POLICY_DENIED: "REVIEW_CURRENT_AUTHORITY",
  }),
});

/**
 * Explicit settlement uncertainty. Each means an operation identity was emitted and its
 * acknowledgement was not, so the effect cannot be excluded. Checked before any rejection map,
 * which is what keeps RESEARCH_SETTLEMENT_UNCERTAIN out of REJECTED_BEFORE_EFFECT even though
 * it shares the 503 status with RESEARCH_INPUT_SCHEMA_MISMATCH.
 */
const SETTLEMENT_UNCERTAIN_CODES: readonly string[] = [
  "RESEARCH_SETTLEMENT_UNCERTAIN",
  "INGEST_SETTLEMENT_UNCERTAIN",
  "EVIDENCE_SETTLEMENT_UNCERTAIN",
  "EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN",
  "MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN",
  "WIKI_SETTLEMENT_UNCERTAIN",
  "WORKFLOW_EFFECT_UNCERTAIN",
  "WORKFLOW_OUTPUT_UNAVAILABLE",
  "WORKFLOW_STORAGE_UNAVAILABLE",
  "WORKFLOW_PREPARATION_FAILED",
  "REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN",
  // Emitted from both local and post-response paths in sources/import/raw.ts, so the capture
  // effect can never be excluded by code alone.
  "RAW_CAPTURE_RESPONSE_INVALID",
];

/**
 * Local refusals that prove no server effect, because the transport itself rejected the
 * request before writing it. Each is thrown inside transport/client.ts, so no server ever saw
 * the mutation. A caller clears an intent on one of these only by positively asserting
 * dispatched === false, because a composite operation such as raw import or bundle import performs
 * several awaited calls and an absent provenance cannot exclude an earlier effect.
 * MALFORMED_JSON_RESPONSE is deliberately absent: it is raised after a server
 * response exists and says nothing about whether the effect was written.
 */
const PRE_EFFECT_TRANSPORT_CODES: readonly string[] = [
  "API_REQUEST_INVALID",
  "API_HEADER_CONFLICT",
  "API_UPLOAD_INVALID",
  "API_RANGE_INVALID",
  "API_TIMEOUT_INVALID",
  "API_PATH_INVALID",
  "API_BODY_BUDGET_INVALID",
  "API_VALIDATOR_INVALID",
  "API_STATUS_POLICY_INVALID",
];

/**
 * Transport and body identities whose effect is unconfirmed, because they are raised after
 * dispatch when an acknowledgement could not be obtained: abort, deadline, lost body, lost
 * connection, a body that failed to decode, or a validator that changed. API_VALIDATOR_MISMATCH
 * lives here because transport/body.ts:138 raises it after the response arrived.
 */
const UNCONFIRMED_TRANSPORT_CODES: readonly string[] = [
  "API_REQUEST_ABORTED",
  "API_REQUEST_DEADLINE",
  "API_BODY_INTERRUPTED",
  "API_UNREACHABLE",
  "API_SESSION_CLOSED",
  "API_RESPONSE_TOO_LARGE",
  "API_RESPONSE_TRANSFORMED",
  "API_RESPONSE_SCHEMA_MISMATCH",
  "API_VALIDATOR_MISMATCH",
  "API_RANGE_MISMATCH",
  "API_STATUS_INVALID",
  "MALFORMED_API_PROBLEM",
  "MALFORMED_JSON_RESPONSE",
];

/** Authorization and session loss. Owned by the privacy controller and applied to every operation. */
const AUTHORIZATION_LOSS_CODES: readonly string[] = [
  "ACCESS_SESSION_REQUIRED",
  "ACCESS_SCOPE_DENIED",
];

const SETTLEMENT_UNCERTAIN = new Set(SETTLEMENT_UNCERTAIN_CODES);
const PRE_EFFECT_TRANSPORT = new Set(PRE_EFFECT_TRANSPORT_CODES);
const UNCONFIRMED_TRANSPORT = new Set(UNCONFIRMED_TRANSPORT_CODES);
const AUTHORIZATION_LOSS = new Set(AUTHORIZATION_LOSS_CODES);

function classified(
  outcome: MutationOutcomeClass,
  action: MutationOutcomeAction,
  reason: string,
): MutationOutcomeClassification {
  return Object.freeze({
    outcome,
    action,
    reason,
    clearsIntent: outcome === "REJECTED_BEFORE_EFFECT",
    preservesIdentity: outcome === "OUTCOME_UNKNOWN",
  });
}

/**
 * Classify one mutation failure.
 *
 * The order is causal and the first step is deliberate. Authorization loss is checked before the
 * operation-map lookup, because session loss is owned by the privacy controller and applies to
 * every operation, including one this classifier has not registered. Revision 2 returned early on
 * an unregistered operation, which silently turned such a loss into an unknown outcome.
 *
 * An explicitly unconfirmed outcome is checked next, before any rejection map, so an
 * unconfirmed acknowledgement can never be presented as a rejection. A local transport refusal
 * follows, since it proves no server ever saw the request. Only then is a code trusted as a
 * definitive rejection, and that trust comes from the operation-and-code pair alone.
 *
 * There is no status-range fallback. A status without a recognized code is contract drift, and
 * treating it as a rejection would clear an intent on evidence nobody verified.
 */
export function classifyMutationOutcome(input: MutationOutcomeInput): MutationOutcomeClassification {
  const code = input.code ?? "";
  // Authorization loss precedes every operation check, so it applies to all operations.
  if (code.length > 0 && AUTHORIZATION_LOSS.has(code)) {
    return classified("AUTHORIZATION_LOSS", "RESOLVE_AUTHORIZATION",
      "authorization or session loss is owned by the privacy controller");
  }
  if (typeof input.operation !== "string" || input.operation.length === 0) {
    return classified("OUTCOME_UNKNOWN", "READBACK_STATUS",
      "mutation outcome has no operation identity");
  }
  if (!Object.hasOwn(OPERATION_REJECTIONS, input.operation)) {
    // Object.hasOwn, not an undefined check. OPERATION_REJECTIONS inherits Object.prototype, so a
    // key such as "toString" would otherwise resolve to the inherited function and look registered.
    return classified("OUTCOME_UNKNOWN", "READBACK_STATUS",
      "mutation operation is not registered, so its codes cannot be bounded");
  }
  const rejections = OPERATION_REJECTIONS[input.operation] as
    Readonly<Record<string, MutationOutcomeAction>>;
  if (code.length > 0) {
    if (SETTLEMENT_UNCERTAIN.has(code)) {
      return classified("OUTCOME_UNKNOWN", "READBACK_STATUS",
        "server reported settlement uncertainty for an emitted operation identity");
    }
    if (UNCONFIRMED_TRANSPORT.has(code)) {
      return classified("OUTCOME_UNKNOWN", "READBACK_STATUS",
        "the outcome could not be confirmed after dispatch");
    }
    if (PRE_EFFECT_TRANSPORT.has(code) && input.dispatched === false) {
      // A local refusal clears an intent only when the caller positively asserts the request was
      // not dispatched. A composite operation such as raw import or bundle import performs several
      // awaited calls, so an absent or true provenance means some step may already have taken effect.
      return classified("REJECTED_BEFORE_EFFECT", "REVIEW_CONFLICT",
        "the transport refused the request before any server effect");
    }
    if (!Object.hasOwn(rejections, code)) {
      // Object.hasOwn here too. Each per-operation map inherits Object.prototype, so a code such
      // as "toString" would otherwise resolve to an inherited function and be treated as a
      // trusted action, clearing an intent on evidence that was never a server code.
      return classified("OUTCOME_UNKNOWN", "READBACK_STATUS",
        "no definitive rejection exists for this operation and code");
    }
    const action = rejections[code] as MutationOutcomeAction;
    return classified("REJECTED_BEFORE_EFFECT", action,
      "the server definitively rejected the mutation before its durable effect");
  }
  return classified("OUTCOME_UNKNOWN", "READBACK_STATUS",
    "no definitive rejection exists for this operation and code");
}

/**
 * Classify a successful mutation.
 *
 * Success is a separate path from failure, so no input boolean can turn a failure into one. The
 * one thing that overrides a claimed success is an authorization loss already observed for the
 * same response, because session loss belongs to the privacy controller and a successful body
 * does not prove the owner session is still current.
 */
export function classifyMutationSuccess(
  input: MutationOutcomeSuccessInput,
): MutationOutcomeClassification {
  if (input.authorizationLossCode !== undefined &&
      AUTHORIZATION_LOSS.has(input.authorizationLossCode)) {
    return classified("AUTHORIZATION_LOSS", "RESOLVE_AUTHORIZATION",
      "authorization or session loss was observed for the same response");
  }
  return classified("COMMITTED", "READBACK_STATUS",
    "the mutation completed and its effect is durable");
}

export {
  OPERATION_REJECTIONS,
  SETTLEMENT_UNCERTAIN_CODES,
  PRE_EFFECT_TRANSPORT_CODES,
  UNCONFIRMED_TRANSPORT_CODES,
  AUTHORIZATION_LOSS_CODES,
};
