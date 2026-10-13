/**
 * ER-335 mutation-outcome classifier, revision 3 focused regressions.
 *
  * Executed in the intake branch. Revision 3 repaired four review defects and revision 4 repaired
  * two further map defects found by the causal audit. These cases pin the repaired behaviour so
  * the same mistakes cannot return:
 *
 *  - RAW_CAPTURE_RESPONSE_INVALID must not clear a capture intent, because the same code is
 *    thrown from a locally built receipt at raw.ts:133 and 141, from the local digest port at
 *    raw.ts:148, and from the awaited capture response at raw.ts:246, 259, 284 and 289.
 *  - API_VALIDATOR_MISMATCH must not clear anything, because body.ts:138 raises it after the
 *    response arrived when the representation validator did not match.
 *  - Authorization loss must be reported even for an unregistered operation, because the privacy
 *    controller owns session state for every operation.
 *
 * Revision 4 repairs two more defects found by the causal source audit, each anchored to a throw
 * site that disproves the previous claim:
 *
 *  - WIKI_HEAD_CONFLICT must not clear a publish intent, because the publish path raises the same
 *    code before its durable effect at wiki.ts:360 and wiki-publication-store.ts:217 and after it
 *    at wiki.ts:398, 402 and 409, all following the immutable write at wiki.ts:367.
 *  - RESEARCH_RUN_CONFIGURATION_REQUIRED must not clear a run intent, because it is thrown only
 *    from artifact-report-admission.ts and never on the research.run.admit path.
 *
 * Each case names the exact code and throw site it relies on, so a future contract change fails
 * here instead of silently clearing an intent on unverified evidence.
 */

import { describe, expect, it } from "vitest";
import {
  classifyMutationOutcome,
  classifyMutationSuccess,
  type MutationOutcomeInput,
} from "./mutation-outcome";

/** Dispatched is true throughout, because that is the state revision 1 mishandled. */
const dispatched: MutationOutcomeInput["dispatched"] = true;

interface Case {
  readonly name: string;
  readonly input: MutationOutcomeInput;
  readonly outcome: string;
  readonly action?: string;
  readonly clearsIntent?: boolean;
  readonly preservesIdentity?: boolean;
}

const definitiveCases: readonly Case[] = [
  {
    name: "RESEARCH_CONFLICT after dispatch is still definitive",
    input: { operation: "research.run.admit", dispatched, status: 409, code: "RESEARCH_CONFLICT" },
    outcome: "REJECTED_BEFORE_EFFECT",
    action: "REVIEW_CONFLICT",
  },
  {
    name: "RESEARCH_INPUT_SCHEMA_MISMATCH is a definitive 503, not an unknown",
    input: { operation: "research.run.admit", dispatched, status: 503, code: "RESEARCH_INPUT_SCHEMA_MISMATCH" },
    outcome: "REJECTED_BEFORE_EFFECT",
    action: "REVIEW_CONFLICT",
  },
  {
    name: "WIKI_PUBLICATION_INCOMPLETE after dispatch is still definitive",
    input: { operation: "wiki.publish", dispatched, status: 422, code: "WIKI_PUBLICATION_INCOMPLETE" },
    outcome: "REJECTED_BEFORE_EFFECT",
    action: "REVIEW_EVIDENCE_INCOMPLETE",
  },
  {
    name: "WIKI_PROPOSAL_READBACK_MISMATCH after dispatch is still definitive",
    input: { operation: "wiki.publish", dispatched, status: 409, code: "WIKI_PROPOSAL_READBACK_MISMATCH" },
    outcome: "REJECTED_BEFORE_EFFECT",
    action: "REVIEW_CONFLICT",
  },
  {
    name: "WIKI_POLICY_DENIED after dispatch is still definitive",
    input: { operation: "wiki.publish", dispatched, status: 403, code: "WIKI_POLICY_DENIED" },
    outcome: "REJECTED_BEFORE_EFFECT",
    action: "REVIEW_CURRENT_AUTHORITY",
  },
  {
    name: "erasure permission denial after dispatch is still definitive",
    input: { operation: "erasure.execute", dispatched, status: 403, code: "ERASURE_PERMISSION_DENIED" },
    outcome: "REJECTED_BEFORE_EFFECT",
    action: "REVIEW_CURRENT_AUTHORITY",
  },
];

const unknownCases: readonly Case[] = [
  {
    name: "RESEARCH_SETTLEMENT_UNCERTAIN after dispatch preserves identity",
    input: { operation: "research.run.admit", dispatched, status: 503, code: "RESEARCH_SETTLEMENT_UNCERTAIN" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "WIKI_SETTLEMENT_UNCERTAIN after dispatch preserves identity",
    input: { operation: "wiki.publish", dispatched, status: 503, code: "WIKI_SETTLEMENT_UNCERTAIN" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    // Pre-effect at packages/research/src/wiki.ts:360 and wiki-publication-store.ts:217, but
    // post-effect at wiki.ts:398, 402 and 409, all of which run after writeImmutableRevision at
    // wiki.ts:367 has already put the revision bytes in R2 at wiki-publication-store.ts:186.
    name: "WIKI_HEAD_CONFLICT on publish preserves identity because the durable write can precede it",
    input: { operation: "wiki.publish", dispatched, status: 409, code: "WIKI_HEAD_CONFLICT" },
    outcome: "OUTCOME_UNKNOWN",
    action: "READBACK_STATUS",
  },
  {
    // Never thrown on the research.run.admit path. It is thrown only from
    // apps/eliotr-core/src/artifact-report-admission.ts inside originalRunConfiguration, which
    // resolves the original run of an artifact REPORT product.
    name: "RESEARCH_RUN_CONFIGURATION_REQUIRED never clears a research-run intent",
    input: { operation: "research.run.admit", dispatched, status: 409, code: "RESEARCH_RUN_CONFIGURATION_REQUIRED" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "RAW_CAPTURE_RESPONSE_INVALID never clears the capture intent",
    input: { operation: "import.raw.capture", dispatched, status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID" },
    outcome: "OUTCOME_UNKNOWN",
    action: "READBACK_STATUS",
  },
  {
    name: "API_VALIDATOR_MISMATCH never clears anything after dispatch",
    input: { operation: "artifact.accept", dispatched, status: 412, code: "API_VALIDATOR_MISMATCH" },
    outcome: "OUTCOME_UNKNOWN",
    action: "READBACK_STATUS",
  },
  {
    name: "MALFORMED_JSON_RESPONSE never proves a pre-effect rejection",
    input: { operation: "research.run.admit", dispatched, status: 502, code: "MALFORMED_JSON_RESPONSE" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "an abort after dispatch preserves identity",
    input: { operation: "research.run.admit", dispatched, code: "API_REQUEST_ABORTED" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "the removed artifact protocol constant is not a rejection code",
    input: { operation: "artifact.accept", dispatched, code: "ARTIFACT_SECTION_REVISE_PROTOCOL" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "the removed bundle file-set code is not a rejection code",
    input: { operation: "import.bundle.import", dispatched, code: "BUNDLE_FILE_SET_INVALID" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "the removed bundle hash-manifest code is not a rejection code",
    input: { operation: "import.bundle.import", dispatched, code: "BUNDLE_HASH_MANIFEST_INVALID" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "an unrecognized code stays unknown rather than clearing an intent",
    input: { operation: "research.run.admit", dispatched, status: 409, code: "BRAND_NEW_CONTRACT_CODE" },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "a status-only rejection without a recognized code stays unknown",
    input: { operation: "research.run.admit", dispatched, status: 409 },
    outcome: "OUTCOME_UNKNOWN",
  },
  {
    name: "an unregistered operation stays unknown even with a known code",
    input: { operation: "unregistered.endpoint", dispatched, status: 409, code: "RESEARCH_CONFLICT" },
    outcome: "OUTCOME_UNKNOWN",
  },
];

 describe("ER-335 mutation outcome classifier, revision 4", () => {
  describe("an awaited definitive rejection stays definitive after dispatch", () => {
    it.each(definitiveCases)("$name", ({ input, outcome, action }) => {
      const classified = classifyMutationOutcome(input);
      expect(classified.outcome).toBe(outcome);
      expect(classified.clearsIntent).toBe(true);
      expect(classified.preservesIdentity).toBe(false);
      if (action !== undefined) expect(classified.action).toBe(action);
    });
  });

  describe("an unconfirmed outcome preserves identity and never clears the intent", () => {
    it.each(unknownCases)("$name", ({ input, outcome, action }) => {
      const classified = classifyMutationOutcome(input);
      expect(classified.outcome).toBe(outcome);
      expect(classified.clearsIntent).toBe(false);
      expect(classified.preservesIdentity).toBe(true);
      if (action !== undefined) expect(classified.action).toBe(action);
    });
  });

  it("keeps RAW_CAPTURE_RESPONSE_INVALID unconfirmed for every operation that lists it", () => {
    // The same code is emitted from the local receipt builders at raw.ts:133 and 141, from the
    // local digest port at raw.ts:148, and from the awaited response decoders at raw.ts:246,
    // 259, 284 and 289, so no caller may treat it as proof the capture never happened.
    const classified = classifyMutationOutcome({
      operation: "import.raw.capture",
      dispatched,
      code: "RAW_CAPTURE_RESPONSE_INVALID",
    });
    expect(classified.outcome).toBe("OUTCOME_UNKNOWN");
    expect(classified.clearsIntent).toBe(false);
    expect(classified.preservesIdentity).toBe(true);
    expect(classified.action).toBe("READBACK_STATUS");
  });

  it("treats a local refusal as definitive only before the transport writes a request", () => {
    const before = classifyMutationOutcome({
      operation: "research.run.admit",
      code: "API_REQUEST_INVALID",
      dispatched: false,
    });
    expect(before.outcome).toBe("REJECTED_BEFORE_EFFECT");
    expect(before.clearsIntent).toBe(true);
  });

  it("reports authorization loss for an unregistered operation too", () => {
    // Privacy applies to every operation, so the loss check must precede the operation map.
    const loss = classifyMutationOutcome({
      operation: "unregistered.endpoint",
      dispatched,
      status: 401,
      code: "ACCESS_SESSION_REQUIRED",
    });
    expect(loss.outcome).toBe("AUTHORIZATION_LOSS");
    expect(loss.action).toBe("RESOLVE_AUTHORIZATION");
    expect(loss.clearsIntent).toBe(false);
    expect(loss.preservesIdentity).toBe(false);
  });

  it("reports authorization loss when no operation identity is present at all", () => {
    const loss = classifyMutationOutcome({
      operation: "",
      dispatched,
      code: "ACCESS_SCOPE_DENIED",
    });
    expect(loss.outcome).toBe("AUTHORIZATION_LOSS");
    expect(loss.action).toBe("RESOLVE_AUTHORIZATION");
  });

  it("never lets a claimed success override an observed authorization loss", () => {
    const success = classifyMutationSuccess({
      operation: "import.raw.capture",
      authorizationLossCode: "ACCESS_SESSION_REQUIRED",
    });
    expect(success.outcome).toBe("AUTHORIZATION_LOSS");
    expect(success.action).toBe("RESOLVE_AUTHORIZATION");
    expect(success.clearsIntent).toBe(false);
  });

  it("reports a plain canonical confirmation as COMMITTED", () => {
    const success = classifyMutationSuccess({ operation: "research.run.admit" });
    expect(success.outcome).toBe("COMMITTED");
    expect(success.clearsIntent).toBe(false);
    expect(success.preservesIdentity).toBe(false);
  });

  it("does not trust inherited operation or error keys", () => {
    for (const input of [
      { operation: 'toString', code: 'RESEARCH_CONFLICT' },
      { operation: '__proto__', code: 'RESEARCH_CONFLICT' },
      { operation: 'research.run.admit', code: 'toString' },
    ]) {
      const outcome = classifyMutationOutcome(input);
      expect(outcome.outcome).toBe('OUTCOME_UNKNOWN');
      expect(outcome.clearsIntent).toBe(false);
      expect(outcome.preservesIdentity).toBe(true);
    }
  });

  it("retains a composite action after a local error without proven undispatched provenance", () => {
    for (const provenance of [{ dispatched: true }, {}]) {
      expect(classifyMutationOutcome({ operation: 'import.bundle.import', code: 'API_REQUEST_INVALID', ...provenance })
        .outcome).toBe('OUTCOME_UNKNOWN');
    }
  });

  it("retains publication identity when immutable readback can fail after the write", () => {
    const outcome = classifyMutationOutcome({ operation: 'wiki.publish', code: 'WIKI_IMMUTABLE_READBACK_MISMATCH', dispatched: true });
    expect(outcome.outcome).toBe('OUTCOME_UNKNOWN');
    expect(outcome.preservesIdentity).toBe(true);
  });

  it("refuses a Wiki edit only for its proven pre-effect input failure", () => {
    const result = classifyMutationOutcome({ operation: 'wiki.propose', code: 'WIKI_INPUT_INVALID', status: 413, dispatched: true });
    expect(result.outcome).toBe('REJECTED_BEFORE_EFFECT');
    expect(result.clearsIntent).toBe(true);
  });

  it("retains Wiki edit identity when a head conflict can follow immutable writes", () => {
    const result = classifyMutationOutcome({ operation: 'wiki.propose', code: 'WIKI_HEAD_CONFLICT', status: 409, dispatched: true });
    expect(result.outcome).toBe('OUTCOME_UNKNOWN');
    expect(result.preservesIdentity).toBe(true);
  });

  it("retains publication identity when WIKI_HEAD_CONFLICT follows the durable immutable write", () => {
    // The publish path raises the same code before and after its durable effect, so the operation
    // and code pair cannot prove the publication never happened. wiki.ts:360 refuses when the
    // expected head no longer matches and wiki-publication-store.ts:217 refuses when the commit is
    // not bound to the active proposal; both are pre-effect. wiki.ts:398, 402 and 409 raise the
    // same code after commitHeadAndOutbox at 394 has already returned, which is after
    // writeImmutableRevision at wiki.ts:367 wrote the revision bytes into R2 at
    // wiki-publication-store.ts:186. The intent stays unknown so readback can reuse the exact
    // identity instead of a reviewer being told the mutation never took effect.
    const outcome = classifyMutationOutcome({
      operation: 'wiki.publish',
      code: 'WIKI_HEAD_CONFLICT',
      status: 409,
      dispatched: true,
    });
    expect(outcome.outcome).toBe('OUTCOME_UNKNOWN');
    expect(outcome.clearsIntent).toBe(false);
    expect(outcome.preservesIdentity).toBe(true);
  });

  it("still clears a publication intent for the proven pre-effect proposal failures", () => {
    // readProposal runs before publishStored, so a foreign-identity readback at wiki.ts:260 and an
    // absent proposal at wiki.ts:255 are both raised before any write of this request.
    for (const code of ['WIKI_PROPOSAL_READBACK_MISMATCH', 'WIKI_PROPOSAL_NOT_FOUND'] as const) {
      const outcome = classifyMutationOutcome({
        operation: 'wiki.publish',
        code,
        status: code === 'WIKI_PROPOSAL_NOT_FOUND' ? 404 : 409,
        dispatched: true,
      });
      expect(outcome.outcome).toBe('REJECTED_BEFORE_EFFECT');
      expect(outcome.clearsIntent).toBe(true);
      expect(outcome.preservesIdentity).toBe(false);
    }
  });

  it("refuses a research-run intent for a code that belongs to the artifact report path", () => {
    // RESEARCH_RUN_CONFIGURATION_REQUIRED is thrown only from
    // apps/eliotr-core/src/artifact-report-admission.ts inside originalRunConfiguration, which
    // resolves the original run of a completed REPORT artifact product. It never reaches the run
    // admission path, so mapping it there cleared an intent on a code the run never raised.
    const outcome = classifyMutationOutcome({
      operation: 'research.run.admit',
      code: 'RESEARCH_RUN_CONFIGURATION_REQUIRED',
      status: 409,
      dispatched: true,
    });
    expect(outcome.outcome).toBe('OUTCOME_UNKNOWN');
    expect(outcome.clearsIntent).toBe(false);
    expect(outcome.preservesIdentity).toBe(true);
  });

  it("still clears a research-run intent for the chain refusals that precede the ledger", () => {
    for (const code of ['RESEARCH_CONFLICT', 'RESEARCH_INPUT_SCHEMA_MISMATCH'] as const) {
      const outcome = classifyMutationOutcome({
        operation: 'research.run.admit',
        code,
        status: code === 'RESEARCH_CONFLICT' ? 409 : 503,
        dispatched: true,
      });
      expect(outcome.outcome).toBe('REJECTED_BEFORE_EFFECT');
      expect(outcome.clearsIntent).toBe(true);
    }
  });
});
