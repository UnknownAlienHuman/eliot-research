import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import type { WikiPageRevision } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalEvidenceJson, loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { db, principal, runtime, seedSource, setupOrientationDatabase, successful, request } from "./orientation-fixture.js";
import { createWikiProposalService, createWikiProposalReaderService, publishWikiProposal } from "../src/wiki-service.js";
import { recordWikiPublicationAuthority } from "../src/wiki-publication-store.js";
import { textDigest, validRef, pageJson, loadProposalRow } from "../src/wiki-publication-store-support.js";
import { parseInput, parseMetadata, proposeWikiFromOwnerEdit } from "../src/wiki-owner-edit-proposal.js";
import { readOwnerEditReviewProof } from "../src/wiki-owner-edit-review-proof.js";

beforeEach(async () => { await reset(); await setupOrientationDatabase(); });

function context(key: string): AuthenticatedRequestContext {
  return { request: new Request("https://research.example/api/v1/research/wiki/propose", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
  }), principal_ref: principal, client_class: "owner_pwa", credential_generation: "credential-v1", trace_id: `trace-${key}` };
}

async function base(tag: string, evidenceRef = `wiki-parity/${tag}/evidence.json`) {
  const id = `wiki-parity-${tag}`;
  await seedSource(id);
  const orientation = await successful(request(id));
  const scopeRef = orientation.evidence_pack.scope_snapshot_ref;
  const authority = await loadScopeAuthority(db, scopeRef);
  if (authority === null) throw new Error("missing admitted owner scope");
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO investigation_current_policy VALUES ('wiki-parity-policy',?1,'ACTIVE',?2)")
      .bind(authority.snapshot.policy_authority_ref, now),
    db.prepare("INSERT INTO investigation_current_deployment(deployment_generation,state,created_at) VALUES (?1,'ACTIVE',?2)")
      .bind(runtime.DEPLOYMENT_GENERATION, now),
  ]);
  const bodyText = "# Published base\n\nSource text.\n";
  const bodyRef = `wiki-parity/${tag}/base.md`;
  await runtime.WORK_BUCKET.put(bodyRef, bodyText);
  await runtime.WORK_BUCKET.put(evidenceRef, canonicalEvidenceJson({ claims: ["base-claim"] }));
  const page: WikiPageRevision = {
    page_ref: { id, revision: 1 }, page_type: "Source", title: `Base ${tag}`,
    scope_snapshot_ref: scopeRef,
    body_object_ref: bodyRef, body_sha256: await textDigest(bodyText), statement_labels: { "base-claim": "SOURCE_SUPPORTED" },
    evidence_map_ref: evidenceRef, counterposition_refs: [], coverage_receipt_ref: { id: `coverage-${tag}`, revision: 1 },
    limitations: [], dependency_refs: [`rev-${id}`], generator_generation: "wiki-test-v1", status: "DRAFT",
    publication_metadata: { generated_by: "test" }, created_at: "2026-09-11T00:00:00.000Z",
  };
  const ctx = context(`base-${tag}`);
  const proposal = await createWikiProposalService(runtime)(ctx, { page, risk_class: "D2_ANALYTICAL" });
  // Local base fixture only, not a live qualification receipt.
  await recordWikiPublicationAuthority(db, {
    proposal_ref: proposal.proposal_ref, principal_ref: principal, evidence_receipt_ref: `evidence-${tag}`,
    dependency_closure_receipt_ref: `dependency-${tag}`, verifier_receipt_ref: `verifier-${tag}`,
    coverage_complete: true, dependency_closure_complete: true, conflict_count: 0, changes_current_state: false,
  });
  await publishWikiProposal(runtime, ctx, { proposal_ref: proposal.proposal_ref, expected_head_revision: 0 });
  return { page, proposal };
}

function edit(value: Awaited<ReturnType<typeof base>>, editNote = "", title = "Edited Wiki 😀") {
  return { base_proposal_ref: value.proposal.proposal_ref, expected_head_revision: 1, title,
    body_text: "# Edited Wiki 😀\r\n\tПроверка e\u0301 and é; no normalization.\n", edit_note: editNote };
}

describe("S25 actual owner-edit writer/commit/reader parity", () => {
  it.each([
    { name: "empty note", note: "", title: "Edited title" },
    { name: "BMP maximum", note: "я".repeat(4096), title: "Б".repeat(512) },
    { name: "non-BMP maximum", note: "😀".repeat(2048), title: "😀".repeat(256) },
    { name: "mixed below maximum", note: "😀".repeat(2047) + "a", title: "Mixed 😀" },
    { name: "combining without normalization", note: "e\u0301".repeat(2048), title: "e\u0301 / é" },
    { name: "escaped multiline", note: "note 😀\r\n\tПримечание \" \\", title: "Multiline note" },
  ])("round-trips $name through D1, R2, review and publication", async ({ note, title }) => {
    const value = await base("first");
    const input = edit(value, note, title);
    const ctx = context("edit-first");
    const proposed = await proposeWikiFromOwnerEdit(runtime, ctx, input, "edit-first");
    const reader = createWikiProposalReaderService(runtime);
    const read = await reader.readWikiProposal(ctx, proposed.proposal_ref);
    expect(read.page.publication_metadata.edit_note).toBe(input.edit_note);
    expect(parseMetadata(read.page.publication_metadata).edit_note).toBe(input.edit_note);
    const row = await loadProposalRow(db, proposed.proposal_ref, principal);
    if (row === null) throw new Error("missing committed owner edit");
    expect(row.page_json).toBe(pageJson(read.page));
    expect(row.page_sha256).toBe(await textDigest(row.page_json));
    const noteLength = await db.prepare("SELECT length(json_extract(page_json,'$.publication_metadata.edit_note')) AS n " +
      "FROM wiki_publication_proposal WHERE proposal_id=?1").bind(proposed.proposal_ref.id).first<number>("n");
    expect(noteLength).toBe([...input.edit_note].length);
    const binding = await db.prepare("SELECT request_sha256 FROM wiki_owner_edit_binding WHERE proposal_id=?1")
      .bind(proposed.proposal_ref.id).first<{ request_sha256: string }>();
    expect(binding?.request_sha256).toBe(await textDigest(canonicalEvidenceJson(input)));
    const effectsBeforeReplay = await effects();
    await expect(proposeWikiFromOwnerEdit(runtime, ctx, input, "edit-first")).resolves.toEqual(proposed);
    expect(await effects()).toEqual(effectsBeforeReplay);
    await expect(proposeWikiFromOwnerEdit(runtime, ctx, { ...input, edit_note: input.edit_note + "x" }, "edit-first"))
      .rejects.toMatchObject({ code: input.edit_note.length === 4096 ? "WIKI_INPUT_INVALID" : "WIKI_PROPOSAL_READBACK_MISMATCH" });
    expect(await effects()).toEqual(effectsBeforeReplay);
    expect(await (await reader.readWikiProposalBody(ctx, proposed.proposal_ref)).text()).toBe(input.body_text);
    await expect(readOwnerEditReviewProof(runtime, ctx, proposed.proposal_ref)).resolves.toMatchObject({
      body_sha256: await textDigest(input.body_text), page_ref: { id: value.page.page_ref.id, revision: 2 },
    });
    await expect(publishWikiProposal(runtime, ctx, { proposal_ref: proposed.proposal_ref, expected_head_revision: 1 }))
      .resolves.toMatchObject({ status: "PUBLISHED", page_ref: { id: value.page.page_ref.id, revision: 2 } });
    expect((await reader.readWikiProposal(ctx, proposed.proposal_ref)).state).toBe("PUBLISHED");
    expect(Object.values(read.page.statement_labels)).toEqual(["UNRESOLVED"]);
    const head = await db.prepare("SELECT revision FROM wiki_publication_head WHERE page_id=?1")
      .bind(value.page.page_ref.id).first<number>("revision");
    const outbox = await db.prepare("SELECT count(*) AS n FROM wiki_publication_outbox WHERE page_id=?1")
      .bind(value.page.page_ref.id).first<number>("n");
    expect(head).toBe(2);
    expect(outbox).toBe(2);
  });
});


async function effects() {
  const tables = ["wiki_publication_proposal", "wiki_owner_edit_binding", "wiki_publication_revision",
    "wiki_publication_head", "wiki_publication_outbox", "wiki_publication_authority", "wiki_owner_publication_guard"];
  const counts = await Promise.all(tables.map((table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n")));
  const objects = await runtime.WORK_BUCKET.list({ limit: 1000 });
  expect(objects.truncated).toBe(false);
  return { counts, objects: objects.objects.map(({ key, etag }) => ({ key, etag })) };
}

function rawEdit(fields: Record<string, unknown> = {}) {
  return { base_proposal_ref: { id: "base-proposal", revision: 1 }, expected_head_revision: 1,
    title: "Title", body_text: "Body", edit_note: "", ...fields };
}

describe("S25 invalid inputs and safe readback", () => {
  it("rejects malformed or oversized text at the actual writer before durable effects", async () => {
    const before = await effects();
    const invalid = [
      { edit_note: "x".repeat(4097) }, { edit_note: "😀".repeat(2048) + "x" },
      { edit_note: "😀".repeat(2049) }, { title: "x".repeat(513) }, { title: "😀".repeat(257) },
      ...["\u0000", "\ud800", "\udc00", "x\ud800y", "\ud800\ud800"].flatMap((value) =>
        ["edit_note", "title", "body_text"].map((field) => ({ [field]: value }))),
    ];
    for (const [index, fields] of invalid.entries()) {
      const key = `invalid-${index}`;
      const input = rawEdit(fields);
      expect(() => parseInput(input)).toThrow();
      await expect(proposeWikiFromOwnerEdit(runtime, context(key), input, key)).rejects.toMatchObject({ code: "WIKI_INPUT_INVALID" });
      expect(await effects()).toEqual(before);
    }
  });

  it("keeps the existing UTF-16 note/title and UTF-8 body boundaries explicit", () => {
    const bodyLimit = 8 * 1024 * 1024;
    const maximumBody = "😀".repeat(bodyLimit / 4);
    expect(parseInput(rawEdit({ body_text: maximumBody })).body_bytes.byteLength).toBe(bodyLimit);
    expect(() => parseInput(rawEdit({ body_text: maximumBody + "a" }))).toThrow();
    expect(parseInput(rawEdit({ edit_note: "😀".repeat(2048) })).edit_note.length).toBe(4096);
    expect(() => parseInput(rawEdit({ edit_note: "😀".repeat(2048) + "a" }))).toThrow();
  });

  it.each([
    "wiki/ref:._/@%+-", "a".repeat(256),
  ])("round-trips an accepted reference through the supported writer: %s", async (reference) => {
    const value = await base("ref", reference);
    const input = edit(value, "reference parity");
    const proposed = await proposeWikiFromOwnerEdit(runtime, context("edit-ref"), input, "edit-ref");
    const read = await createWikiProposalReaderService(runtime).readWikiProposal(context("read-ref"), proposed.proposal_ref);
    expect(parseMetadata(read.page.publication_metadata).base_evidence_map_ref).toBe(reference);
    await expect(readOwnerEditReviewProof(runtime, context("proof-ref"), proposed.proposal_ref)).resolves.toBeDefined();
  });

  it("rejects invalid references before committing a proposal or binding", async () => {
    const value = await base("bad-ref");
    const before = await effects();
    const invalid = ["", "a".repeat(513), "/absolute", "a/../b", "a..b", "a\\b", "a b", "a\n", "a\u0000b", "я", "😀", "a\ud800"];
    for (const [index, reference] of invalid.entries()) {
      expect(() => validRef(reference, "evidence reference")).toThrow();
      await expect(createWikiProposalService(runtime)(context(`bad-ref-${index}`), {
        page: { ...value.page, evidence_map_ref: reference }, risk_class: "D2_ANALYTICAL",
      })).rejects.toMatchObject({ code: reference === "a\n" ? "WIKI_PUBLICATION_INCOMPLETE" : "WIKI_INPUT_INVALID" });
      expect(await effects()).toEqual(before);
    }
    // The public page DTO is tighter than the private 512-character object-key helper.
    expect(validRef("a".repeat(512), "private key")).toHaveLength(512);
    await expect(createWikiProposalService(runtime)(context("wire-maximum-plus-one"), {
      page: { ...value.page, evidence_map_ref: "a".repeat(257) }, risk_class: "D2_ANALYTICAL",
    })).rejects.toMatchObject({ code: "WIKI_INPUT_INVALID" });
    expect(await effects()).toEqual(before);
  });

  it("does not treat the SQL width predicate as a complete metadata validator", async () => {
    const value = await base("sql-width");
    const proposed = await proposeWikiFromOwnerEdit(runtime, context("edit-width"), edit(value), "edit-width");
    const read = await createWikiProposalReaderService(runtime).readWikiProposal(context("read-width"), proposed.proposal_ref);
    const before = await effects();
    for (const [field, invalid] of [
      ["edit_note", "😀".repeat(2048) + "x"], ["edit_note", "a\u0000b"], ["edit_note", "\ud800"],
      ["base_evidence_map_ref", "a/../b"], ["base_evidence_map_ref", "a b"], ["base_evidence_map_ref", "😀"],
    ] as const) {
      // Read-only simulation of legacy/corrupt JSON through real D1, never disabling a trigger or mutating an immutable row.
      const encoded = JSON.stringify({ ...read.page.publication_metadata, [field]: invalid });
      const sql = await db.prepare("SELECT json_valid(?1) AS valid, length(json_extract(?1,?2)) AS width")
        .bind(encoded, `$.${field}`).first<{ valid: number; width: number }>();
      expect(sql?.valid).toBe(1);
      expect(sql?.width).toBeLessThanOrEqual(field === "edit_note" ? 4096 : 512);
      expect(() => parseMetadata(JSON.parse(encoded))).toThrow();
      expect(await effects()).toEqual(before);
    }
  });

  it("rejects corrupted stored evidence without creating a review, head or outbox", async () => {
    const value = await base("corrupt");
    const input = edit(value, "original note");
    const ctx = context("edit-corrupt");
    const proposed = await proposeWikiFromOwnerEdit(runtime, ctx, input, "edit-corrupt");
    const reader = createWikiProposalReaderService(runtime);
    const read = await reader.readWikiProposal(ctx, proposed.proposal_ref);
    // Out-of-band corruption, not a supported writer: preserve the canonical D1 digest and change the object.
    await runtime.WORK_BUCKET.put(read.page.evidence_map_ref, canonicalEvidenceJson({ edit_note: "\ud800" }));
    const before = await effects();
    await expect(proposeWikiFromOwnerEdit(runtime, ctx, input, "edit-corrupt"))
      .rejects.toMatchObject({ code: "WIKI_PROPOSAL_READBACK_MISMATCH" });
    await expect(readOwnerEditReviewProof(runtime, ctx, proposed.proposal_ref))
      .rejects.toMatchObject({ code: "WIKI_PROPOSAL_READBACK_MISMATCH" });
    await expect(publishWikiProposal(runtime, ctx, { proposal_ref: proposed.proposal_ref, expected_head_revision: 1 }))
      .rejects.toMatchObject({ code: "WIKI_PROPOSAL_READBACK_MISMATCH" });
    expect(await effects()).toEqual(before);
    expect(await db.prepare("SELECT revision FROM wiki_publication_head WHERE page_id=?1")
      .bind(value.page.page_ref.id).first<number>("revision")).toBe(1);
  });
});
