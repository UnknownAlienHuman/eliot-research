import { describe, expect, it } from "vitest";
import type { VersionedRef, WikiPageRevision } from "@eliotr/contracts";
import {
  createWikiPublisher,
  WikiPublicationError,
  type DraftRiskClass,
  type WikiAutoPromotionReceipt,
  type WikiHeadCommit,
  type WikiHeadCommitDisposition,
  type WikiHeadReadback,
  type WikiImmutableRevisionReceipt,
  type WikiProposalRecord,
  type WikiPublicationPort,
} from "./wiki.js";

function page(tag: "a" | "b" = "a", fields: Partial<WikiPageRevision> = {}): WikiPageRevision {
  return {
    page_ref: { id: "page-1", revision: 1 },
    page_type: "Source",
    title: `Source ${tag}`,
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    body_object_ref: `wiki-body-${tag}`,
    body_sha256: tag.repeat(64),
    statement_labels: { "claim-1": "SOURCE_SUPPORTED" },
    evidence_map_ref: `evidence-map-${tag}`,
    counterposition_refs: [],
    coverage_receipt_ref: { id: `coverage-${tag}`, revision: 1 },
    limitations: [],
    dependency_refs: [`source-revision-${tag}`],
    generator_generation: "wiki-generator-1",
    status: "DRAFT",
    publication_metadata: { origin: "test" },
    created_at: "2026-09-11T00:00:00.000Z",
    ...fields,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryWikiPort implements WikiPublicationPort {
  public readonly events: string[] = [];
  public readonly commits: WikiHeadCommit[] = [];
  public corruptImmutableReadback = false;
  public loseCommitAcknowledgement = false;
  public evidenceValid = true;
  public coverageValid = true;
  public dependenciesValid = true;
  private proposalSequence = 0;
  private readonly proposals = new Map<string, WikiProposalRecord>();
  private readonly revisions = new Map<string, WikiPageRevision>();
  private readonly heads = new Map<string, WikiHeadReadback>();

  public async saveProposal(candidate: WikiPageRevision, riskClass: DraftRiskClass): Promise<VersionedRef> {
    const proposalRef = { id: `wiki-proposal-${this.proposalSequence += 1}`, revision: 1 };
    this.events.push(`proposal:${proposalRef.id}`);
    this.proposals.set(proposalRef.id, {
      proposal_ref: proposalRef,
      page: clone(candidate),
      risk_class: riskClass,
    });
    return proposalRef;
  }

  public async readProposal(proposalRef: VersionedRef): Promise<WikiProposalRecord | null> {
    const value = this.proposals.get(proposalRef.id);
    return value === undefined ? null : clone(value);
  }

  public async validateEvidenceMap(_candidate: WikiPageRevision): Promise<boolean> {
    this.events.push("validate:evidence");
    return this.evidenceValid;
  }

  public async validateCoverage(_candidate: WikiPageRevision): Promise<boolean> {
    this.events.push("validate:coverage");
    return this.coverageValid;
  }

  public async validateDependencyClosure(_candidate: WikiPageRevision): Promise<boolean> {
    this.events.push("validate:dependencies");
    return this.dependenciesValid;
  }

  public async writeImmutableRevision(candidate: WikiPageRevision): Promise<WikiImmutableRevisionReceipt> {
    const manifestRef = `wiki-manifest-${candidate.page_ref.id}-${candidate.page_ref.revision}-${candidate.body_sha256.slice(0, 8)}`;
    this.events.push(`r2:write:${manifestRef}`);
    this.revisions.set(manifestRef, clone(candidate));
    return {
      page_ref: clone(candidate.page_ref),
      manifest_ref: manifestRef,
      body_object_ref: candidate.body_object_ref,
      body_sha256: candidate.body_sha256,
    };
  }

  public async readImmutableRevision(_pageRef: VersionedRef, manifestRef: string): Promise<WikiPageRevision | null> {
    this.events.push(`r2:read:${manifestRef}`);
    const value = this.revisions.get(manifestRef);
    if (value === undefined) return null;
    return this.corruptImmutableReadback ? { ...clone(value), title: `${value.title} changed` } : clone(value);
  }

  public async commitHeadAndOutbox(input: WikiHeadCommit): Promise<WikiHeadCommitDisposition> {
    this.events.push(`d1:commit:${input.manifest_ref}`);
    const current = this.heads.get(input.page.page_ref.id);
    const currentRevision = current?.page_ref.revision ?? null;
    if (currentRevision !== input.expected_head_revision) return "CONFLICT";
    const outboxRef = `outbox-${input.manifest_ref}`;
    this.commits.push(clone(input));
    this.heads.set(input.page.page_ref.id, {
      page_ref: clone(input.page.page_ref),
      manifest_ref: input.manifest_ref,
      outbox_ref: outboxRef,
    });
    if (this.loseCommitAcknowledgement) throw new Error("lost commit acknowledgement");
    return "COMMITTED";
  }

  public async readHead(pageId: string): Promise<WikiHeadReadback | null> {
    const value = this.heads.get(pageId);
    return value === undefined ? null : clone(value);
  }
}

const autoAuthority: WikiAutoPromotionReceipt = {
  publisher_ref: "wiki-auto-publisher-1",
  explicit_project_policy: true,
  policy_receipt_ref: "policy-receipt-1",
  exact_evidence_complete: true,
  evidence_receipt_ref: "evidence-receipt-1",
  dependency_closure_complete: true,
  coverage_complete: true,
  independent_verifier_receipt_ref: "verifier-receipt-1",
  conflict_count: 0,
  changes_current_state: false,
};

describe("Wiki publisher", () => {
  it("publishes only after exact immutable readback and atomically records the head plus outbox", async () => {
    const port = new MemoryWikiPort();
    const publisher = createWikiPublisher(port);
    const proposalRef = await publisher.propose(page(), "D1_LOW_RISK_ADDITIVE");
    const published = await publisher.publish(proposalRef, 0, "reviewer-1");
    expect(published).toMatchObject({ status: "PUBLISHED", reviewer_ref: "reviewer-1" });
    expect(port.commits).toHaveLength(1);
    const readIndex = port.events.findIndex((event) => event.startsWith("r2:read:"));
    const commitIndex = port.events.findIndex((event) => event.startsWith("d1:commit:"));
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(readIndex);
    expect(port.commits[0]?.expected_head_revision).toBeNull();
  });

  it("races two different publishers against one expected head; exactly one wins", async () => {
    const port = new MemoryWikiPort();
    const publisher = createWikiPublisher(port);
    const firstRef = await publisher.propose(page("a"), "D1_LOW_RISK_ADDITIVE");
    const secondRef = await publisher.propose(page("b"), "D1_LOW_RISK_ADDITIVE");
    const results = await Promise.allSettled([
      publisher.publish(firstRef, 0, "reviewer-a"),
      publisher.publish(secondRef, 0, "reviewer-b"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(WikiPublicationError);
    expect(rejected?.reason).toMatchObject({ code: "WIKI_HEAD_CONFLICT", retryable: false });
    expect(port.commits).toHaveLength(1);
  });

  it("never auto-promotes D2/D3 and performs no immutable write when policy denies", async () => {
    const port = new MemoryWikiPort();
    const publisher = createWikiPublisher(port);
    for (const risk of ["D2_ANALYTICAL", "D3_AUTHORITY_SENSITIVE"] as const) {
      const proposalRef = await publisher.propose(page(risk === "D2_ANALYTICAL" ? "a" : "b"), risk);
      await expect(publisher.autoPromote(proposalRef, 0, autoAuthority))
        .rejects.toMatchObject({ code: "WIKI_POLICY_DENIED" });
    }
    expect(port.events.some((event) => event.startsWith("r2:write:"))).toBe(false);
    expect(port.commits).toHaveLength(0);
  });

  it("auto-promotes an exact D1 draft only with its policy receipt bound into the commit", async () => {
    const port = new MemoryWikiPort();
    const publisher = createWikiPublisher(port);
    const proposalRef = await publisher.propose(page(), "D1_LOW_RISK_ADDITIVE");
    await expect(publisher.autoPromote(proposalRef, 0, autoAuthority)).resolves.toMatchObject({
      status: "PUBLISHED",
      reviewer_ref: autoAuthority.publisher_ref,
    });
    expect(port.commits[0]?.auto_promotion_policy_receipt_ref).toBe(autoAuthority.policy_receipt_ref);
  });

  it("blocks D1 head mutation when immutable R2 readback differs", async () => {
    const port = new MemoryWikiPort();
    port.corruptImmutableReadback = true;
    const publisher = createWikiPublisher(port);
    const proposalRef = await publisher.propose(page(), "D1_LOW_RISK_ADDITIVE");
    await expect(publisher.publish(proposalRef, 0, "reviewer-1"))
      .rejects.toMatchObject({ code: "WIKI_IMMUTABLE_READBACK_MISMATCH" });
    expect(port.commits).toHaveLength(0);
  });

  it("reconciles a lost D1 acknowledgement through exact head, outbox and immutable readback", async () => {
    const port = new MemoryWikiPort();
    port.loseCommitAcknowledgement = true;
    const publisher = createWikiPublisher(port);
    const proposalRef = await publisher.propose(page(), "D1_LOW_RISK_ADDITIVE");
    await expect(publisher.publish(proposalRef, 0, "reviewer-1"))
      .resolves.toMatchObject({ status: "PUBLISHED" });
    expect(port.commits).toHaveLength(1);
  });

  it("rejects incomplete evidence authority before any immutable revision write", async () => {
    const port = new MemoryWikiPort();
    port.coverageValid = false;
    const publisher = createWikiPublisher(port);
    const proposalRef = await publisher.propose(page(), "D1_LOW_RISK_ADDITIVE");
    await expect(publisher.publish(proposalRef, 0, "reviewer-1"))
      .rejects.toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
    expect(port.events.some((event) => event.startsWith("r2:write:"))).toBe(false);
    expect(port.commits).toHaveLength(0);
  });
});
