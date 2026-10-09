import { describe, expect, it } from "vitest";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import {
  ResolvedEvidenceSchema,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import { INSTALLED_INQUIRY_PROTOCOL_REFS, installedInquiryProtocolDefinition } from "./research-inquiry-protocol.js";
import { createResearchPlanningManifest } from "./research-planning-manifest.js";
import { branchEvidenceFromResolved, type BranchExecutionContext } from "./research-branch-execution-context.js";

/**
 * Focused unit for sibling deduplication only. branchEvidenceFromResolved reads
 * exactly context.protocol.scope_snapshot_ref and context.planning.source_portfolio.members.
 * The planning manifest is the real product of createResearchPlanningManifest; the ledger
 * head, stage-five lineage and protocol profile are deliberately absent, so this test is not
 * a context-authority or native-authority proof.
 */
const EXCERPT = "hello";
// SHA-256 of the UTF-8 bytes of EXCERPT.
const SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const OTHER_SHA = "b".repeat(64);
const SCOPE: VersionedRef = { id: "scope-1", revision: 1 };
const SOURCE_REVISION_REF = "revision-1";

function resolvedEvidence(overrides: Partial<ResolvedEvidence> = {}): ResolvedEvidence {
  return ResolvedEvidenceSchema.parse({
    handle: {
      handle_ref: { id: "evidence-handle-1", revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-generation-1",
      source_revision_ref: SOURCE_REVISION_REF,
      scope_snapshot_ref: SCOPE,
      anchor: { kind: "normalized_byte_range", start: 0, end: EXCERPT.length },
      excerpt_sha256: SHA,
      excerpt_byte_length: EXCERPT.length,
      object_residency_key_digest: SHA,
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    exact_excerpt: EXCERPT,
    verification_receipt_ref: "verification-1",
    authorization_receipt_ref: "authorization-1",
    credential_generation: "cred-1",
    source_revision_content_sha256: SHA,
    scope_snapshot_digest: SHA,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

/** A fresh exact re-resolution: new verification and authorization receipts, time, title. */
function reResolvedEvidence(): ResolvedEvidence {
  return resolvedEvidence({
    verification_receipt_ref: "verification-2",
    authorization_receipt_ref: "authorization-2",
    resolved_at: "2026-01-02T00:00:00.000Z",
    source_title: "Source title refreshed",
  });
}

async function unitContext(): Promise<BranchExecutionContext> {
  const protocolRef = INSTALLED_INQUIRY_PROTOCOL_REFS.lookup;
  const planning = await createResearchPlanningManifest({
    investigation_id: "investigation-1",
    operation_id: "run-1",
    question: "Which architecture should be selected?",
    scope_snapshot_ref: SCOPE,
    scope_created_at: "2026-09-18T00:00:00.000Z",
    inquiry_protocol_ref: protocolRef,
    definition: installedInquiryProtocolDefinition(protocolRef),
    sources: [{
      source_revision_ref: SOURCE_REVISION_REF,
      source_id: "source-1",
      source_class: "document",
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-generation-1",
      origin_uri: "https://example.com/a",
    }],
  });
  // Only the two fields this function reads are supplied; no ledger, stage five or profile.
  return {
    protocol: { scope_snapshot_ref: SCOPE },
    planning,
  } as unknown as BranchExecutionContext;
}

describe("branchEvidenceFromResolved", () => {
  it("deduplicates a re-resolved sibling handle carrying fresh receipts and resolution time", async () => {
    const context = await unitContext();

    const evidence = branchEvidenceFromResolved(context, [resolvedEvidence(), reResolvedEvidence()]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.handle_ref).toEqual({ id: "evidence-handle-1", revision: 1 });
    expect(evidence[0]?.verification_receipt_ref).toBe("verification-1");
    expect(evidence[0]?.authorization_receipt_ref).toBe("authorization-1");
    expect(evidence[0]?.excerpt_sha256).toBe(SHA);
    expect(evidence[0]?.excerpt_byte_length).toBe(EXCERPT.length);
  });

  it("rejects a conflicting source-bound identity for one unchanged handle", async () => {
    const context = await unitContext();
    const conflicting = resolvedEvidence({
      source_revision_content_sha256: OTHER_SHA,
      verification_receipt_ref: "verification-3",
      authorization_receipt_ref: "authorization-3",
    });

    expect(() => branchEvidenceFromResolved(context, [resolvedEvidence(), conflicting]))
      .toThrow(WorkflowCheckpointError);
    expect(() => branchEvidenceFromResolved(context, [resolvedEvidence(), conflicting]))
      .toThrow("WORKFLOW_OUTPUT_CORRUPT");
  });

  it("rejects a substituted excerpt for the same handle", async () => {
    const context = await unitContext();
    const substituted = resolvedEvidence({
      exact_excerpt: "substituted",
      verification_receipt_ref: "verification-4",
    });

    expect(() => branchEvidenceFromResolved(context, [resolvedEvidence(), substituted]))
      .toThrow("WORKFLOW_OUTPUT_CORRUPT");
  });
});
