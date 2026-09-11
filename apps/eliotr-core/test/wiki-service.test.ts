import { beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { WikiPageRevision } from "@eliotr/contracts";
import { count, db, principal, runtime, setupOrientationDatabase } from "./orientation-fixture.js";
import { createWikiProposalService, publishWikiProposal } from "../src/wiki-service.js";
import { recordWikiPublicationAuthority } from "../src/wiki-publication-store.js";

beforeAll(async () => { await setupOrientationDatabase(); });

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function context(key: string, who = principal): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.example/api/v1/research/wiki/propose", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
    }),
    principal_ref: who,
    client_class: "owner_pwa",
    credential_generation: "credential-v1",
    trace_id: `trace-${key}`,
  };
}

async function candidate(tag: string): Promise<WikiPageRevision> {
  const source = `# ${tag}\n\nVerified source body.\n`;
  const bodyKey = `wiki-service/body-${tag}`;
  const evidenceKey = `wiki-service/evidence-${tag}`;
  await runtime.WORK_BUCKET.put(bodyKey, source);
  await runtime.WORK_BUCKET.put(evidenceKey, JSON.stringify({ exact_claims: [`claim-${tag}`] }));
  return {
    page_ref: { id: `service-page-${tag}`, revision: 1 }, page_type: "Source", title: `Source ${tag}`,
    scope_snapshot_ref: { id: `scope-${tag}`, revision: 1 }, body_object_ref: bodyKey,
    body_sha256: await digest(source), statement_labels: { [`claim-${tag}`]: "SOURCE_SUPPORTED" },
    evidence_map_ref: evidenceKey, counterposition_refs: [], coverage_receipt_ref: { id: `coverage-${tag}`, revision: 1 },
    limitations: [], dependency_refs: [`source-revision-${tag}`], generator_generation: "wiki-generator-v1",
    status: "DRAFT", publication_metadata: { generated_by: "test" }, created_at: "2026-09-11T00:00:00.000Z",
  };
}

describe("Wiki semantic service", () => {
  it("persists an owner proposal, returns a stable protocol result and replays the same key", async () => {
    const page = await candidate("proposal");
    const service = createWikiProposalService(runtime);
    const first = await service(context("wiki-service-proposal"), { page, risk_class: "D2_ANALYTICAL" }) as unknown as {
      protocol: string; proposal_ref: { id: string; revision: number }; state: string;
    };
    const second = await service(context("wiki-service-proposal"), { page, risk_class: "D2_ANALYTICAL" });
    expect(first).toMatchObject({ protocol: "eliotr.wiki-proposal.v1", state: "PROPOSED" });
    expect(second).toEqual(first);
    expect(await count("wiki_publication_proposal")).toBeGreaterThanOrEqual(1);
  });

  it("rejects caller authority, unknown fields and divergent same-key bytes", async () => {
    const page = await candidate("negative");
    const service = createWikiProposalService(runtime);
    const foreign = context("wiki-service-foreign", "service-1");
    (foreign as { client_class: string }).client_class = "service";
    await expect(service(foreign, { page, risk_class: "D2_ANALYTICAL" })).rejects.toMatchObject({ code: "WIKI_OWNER_REQUIRED" });
    await expect(service(context("wiki-service-extra"), { page, risk_class: "D2_ANALYTICAL", extra: true }))
      .rejects.toMatchObject({ code: "WIKI_INPUT_INVALID" });
    await service(context("wiki-service-conflict"), { page, risk_class: "D2_ANALYTICAL" });
    await expect(service(context("wiki-service-conflict"), { page: { ...page, title: "changed" }, risk_class: "D2_ANALYTICAL" }))
      .rejects.toMatchObject({ code: "WIKI_PROPOSAL_READBACK_MISMATCH" });
  });

  it("keeps publication server-side, requires admitted authority, and derives reviewer from owner context", async () => {
    const page = await candidate("publish");
    const ctx = context("wiki-service-publish");
    const proposal = await createWikiProposalService(runtime)(ctx, { page, risk_class: "D3_AUTHORITY_SENSITIVE" }) as unknown as {
      proposal_ref: { id: string; revision: number };
    };
    await expect(publishWikiProposal(runtime, ctx, { proposal_ref: proposal.proposal_ref, expected_head_revision: 0 }))
      .rejects.toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
    await recordWikiPublicationAuthority(db, {
      proposal_ref: proposal.proposal_ref, principal_ref: principal,
      evidence_receipt_ref: "service-evidence-receipt", dependency_closure_receipt_ref: "service-dependency-receipt",
      verifier_receipt_ref: "service-verifier-receipt", coverage_complete: true,
      dependency_closure_complete: true, conflict_count: 0, changes_current_state: false,
    });
    await expect(publishWikiProposal(runtime, ctx, { proposal_ref: proposal.proposal_ref, expected_head_revision: 0 }))
      .resolves.toMatchObject({ protocol: "eliotr.wiki-publication.v1", status: "PUBLISHED", reviewer_ref: principal });
  });
});
