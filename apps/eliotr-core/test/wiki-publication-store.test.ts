import { beforeAll, describe, expect, it } from "vitest";
import { createWikiPublisher, type DraftRiskClass } from "@eliotr/research";
import type { WikiPageRevision } from "@eliotr/contracts";
import { db, runtime, setupOrientationDatabase } from "./orientation-fixture.js";
import { createD1R2WikiPublicationPort, recordWikiPublicationAuthority } from "../src/wiki-publication-store.js";

beforeAll(async () => { await setupOrientationDatabase(); });

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture(tag: string, riskClass: DraftRiskClass = "D2_ANALYTICAL") {
  const bodyText = `# Wiki ${tag}\n\nExact body.\n`;
  const bodyKey = `wiki-test/body-${tag}`;
  const evidenceKey = `wiki-test/evidence-${tag}`;
  await runtime.WORK_BUCKET.put(bodyKey, bodyText);
  await runtime.WORK_BUCKET.put(evidenceKey, JSON.stringify({ claim: `claim-${tag}`, exact: true }));
  const page: WikiPageRevision = {
    page_ref: { id: `page-${tag}`, revision: 1 },
    page_type: "Source",
    title: `Source ${tag}`,
    scope_snapshot_ref: { id: `scope-${tag}`, revision: 1 },
    body_object_ref: bodyKey,
    body_sha256: await digest(bodyText),
    statement_labels: { [`claim-${tag}`]: "SOURCE_SUPPORTED" },
    evidence_map_ref: evidenceKey,
    counterposition_refs: [],
    coverage_receipt_ref: { id: `coverage-${tag}`, revision: 1 },
    limitations: [],
    dependency_refs: [`source-revision-${tag}`],
    generator_generation: "wiki-generator-v1",
    status: "DRAFT",
    publication_metadata: { source: "local-test" },
    created_at: "2026-09-11T00:00:00.000Z",
  };
  const context = { principal_ref: "owner-1", idempotency_key: `wiki-${tag}`, now: () => "2026-09-11T01:00:00.000Z" };
  const publisher = createWikiPublisher(createD1R2WikiPublicationPort(db, runtime.WORK_BUCKET, context));
  const proposalRef = await publisher.propose(page, riskClass);
  return { page, publisher, proposalRef, context };
}

async function admit(value: Awaited<ReturnType<typeof fixture>>) {
  await recordWikiPublicationAuthority(db, {
    proposal_ref: value.proposalRef,
    principal_ref: value.context.principal_ref,
    evidence_receipt_ref: `evidence-receipt-${value.page.page_ref.id}`,
    dependency_closure_receipt_ref: `dependency-receipt-${value.page.page_ref.id}`,
    verifier_receipt_ref: `verifier-receipt-${value.page.page_ref.id}`,
    coverage_complete: true,
    dependency_closure_complete: true,
    conflict_count: 0,
    changes_current_state: false,
    admitted_at: "2026-09-11T00:30:00.000Z",
  });
}

describe("D1/R2 Wiki publication storage", () => {
  it("captures exact body/evidence bytes, requires authority, then commits immutable revision, head and outbox", async () => {
    const value = await fixture("publish");
    await expect(value.publisher.publish(value.proposalRef, 0, "reviewer-1"))
      .rejects.toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
    await admit(value);
    const published = await value.publisher.publish(value.proposalRef, 0, "reviewer-1");
    expect(published).toMatchObject({ status: "PUBLISHED", reviewer_ref: "reviewer-1" });
    const head = await db.prepare("SELECT revision, manifest_ref, outbox_ref FROM wiki_publication_head WHERE page_id = ?1")
      .bind(value.page.page_ref.id).first<{ revision: number; manifest_ref: string; outbox_ref: string }>();
    expect(head?.revision).toBe(1);
    expect(head?.manifest_ref).toContain("wiki/revisions/");
    expect(head?.outbox_ref).toContain("wiki-outbox-");
    expect(await runtime.WORK_BUCKET.get(head?.manifest_ref ?? "missing")).not.toBeNull();
    const outbox = await db.prepare("SELECT state FROM wiki_publication_outbox WHERE outbox_ref = ?1")
      .bind(head?.outbox_ref).first<{ state: string }>();
    expect(outbox?.state).toBe("PENDING");
  });

  it("replays proposal and publication without duplicate durable effects", async () => {
    const value = await fixture("replay", "D1_LOW_RISK_ADDITIVE");
    const replayRef = await value.publisher.propose(value.page, "D1_LOW_RISK_ADDITIVE");
    expect(replayRef).toEqual(value.proposalRef);
    await admit(value);
    const first = await value.publisher.publish(value.proposalRef, 0, "reviewer-1");
    const second = await value.publisher.publish(value.proposalRef, 0, "reviewer-1");
    expect(second).toEqual(first);
    const revisions = await db.prepare("SELECT COUNT(*) AS n FROM wiki_publication_revision WHERE page_id = ?1")
      .bind(value.page.page_ref.id).first<number>("n");
    const outbox = await db.prepare("SELECT COUNT(*) AS n FROM wiki_publication_outbox WHERE page_id = ?1")
      .bind(value.page.page_ref.id).first<number>("n");
    expect(revisions).toBe(1);
    expect(outbox).toBe(1);
  });

  it("elects one expected-head CAS winner for two different immutable revisions", async () => {
    const first = await fixture("race-a");
    const secondBody = `# Wiki race-b\n\nDifferent body.\n`;
    const secondBodyKey = "wiki-test/body-race-b";
    const secondEvidenceKey = "wiki-test/evidence-race-b";
    await runtime.WORK_BUCKET.put(secondBodyKey, secondBody);
    await runtime.WORK_BUCKET.put(secondEvidenceKey, "{\"different\":true}");
    const secondPage: WikiPageRevision = {
      ...first.page,
      title: "Different candidate",
      body_object_ref: secondBodyKey,
      body_sha256: await digest(secondBody),
      evidence_map_ref: secondEvidenceKey,
      publication_metadata: { source: "race-b" },
    };
    const secondContext = { principal_ref: "owner-1", idempotency_key: "wiki-race-b", now: () => "2026-09-11T01:00:00.000Z" };
    const secondPublisher = createWikiPublisher(createD1R2WikiPublicationPort(db, runtime.WORK_BUCKET, secondContext));
    const secondRef = await secondPublisher.propose(secondPage, "D2_ANALYTICAL");
    await admit(first);
    await recordWikiPublicationAuthority(db, {
      proposal_ref: secondRef, principal_ref: secondContext.principal_ref,
      evidence_receipt_ref: "evidence-receipt-race-b", dependency_closure_receipt_ref: "dependency-receipt-race-b",
      verifier_receipt_ref: "verifier-receipt-race-b", coverage_complete: true,
      dependency_closure_complete: true, conflict_count: 0, changes_current_state: false,
    });
    const results = await Promise.allSettled([
      first.publisher.publish(first.proposalRef, 0, "reviewer-a"),
      secondPublisher.publish(secondRef, 0, "reviewer-b"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ code: "WIKI_HEAD_CONFLICT" });
      const pageId = first.page.page_ref.id;
      const revisionCount = await db.prepare(
        "SELECT COUNT(*) AS n FROM wiki_publication_revision WHERE page_id = ?1",
      ).bind(pageId).first<number>("n");
      const outboxCount = await db.prepare(
        "SELECT COUNT(*) AS n FROM wiki_publication_outbox WHERE page_id = ?1",
      ).bind(pageId).first<number>("n");
      const publishedCount = await db.prepare(
        "SELECT COUNT(*) AS n FROM wiki_publication_proposal WHERE page_id = ?1 AND state = 'PUBLISHED'",
      ).bind(pageId).first<number>("n");
      const proposedCount = await db.prepare(
        "SELECT COUNT(*) AS n FROM wiki_publication_proposal WHERE page_id = ?1 AND state = 'PROPOSED'",
      ).bind(pageId).first<number>("n");
      expect({ revisionCount, outboxCount, publishedCount, proposedCount }).toEqual({
        revisionCount: 1, outboxCount: 1, publishedCount: 1, proposedCount: 1,
      });
  });

  it("rejects a body digest mismatch before reserving D1 authority", async () => {
    const bodyKey = "wiki-test/body-bad-digest";
    const evidenceKey = "wiki-test/evidence-bad-digest";
    await runtime.WORK_BUCKET.put(bodyKey, "actual");
    await runtime.WORK_BUCKET.put(evidenceKey, "{}");
    const candidate: WikiPageRevision = {
      page_ref: { id: "page-bad-digest", revision: 1 }, page_type: "Source", title: "Bad digest",
      scope_snapshot_ref: { id: "scope-bad-digest", revision: 1 }, body_object_ref: bodyKey,
      body_sha256: "a".repeat(64), statement_labels: { claim: "SOURCE_SUPPORTED" },
      evidence_map_ref: evidenceKey, counterposition_refs: [], coverage_receipt_ref: { id: "coverage-bad", revision: 1 },
      limitations: [], dependency_refs: ["source-bad"], generator_generation: "wiki-generator-v1",
      status: "DRAFT", publication_metadata: {}, created_at: "2026-09-11T00:00:00.000Z",
    };
    const publisher = createWikiPublisher(createD1R2WikiPublicationPort(db, runtime.WORK_BUCKET, {
      principal_ref: "owner-1", idempotency_key: "wiki-bad-digest",
    }));
    await expect(publisher.propose(candidate, "D2_ANALYTICAL"))
      .rejects.toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM wiki_publication_proposal WHERE idempotency_key = ?1")
      .bind("wiki-bad-digest").first<number>("n");
    expect(count).toBe(0);
  });
});
