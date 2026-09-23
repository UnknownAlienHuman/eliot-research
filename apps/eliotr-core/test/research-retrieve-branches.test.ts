import { describe, expect, it } from "vitest";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { readFreezeProtocolAndScopeCheckpoint } from "../../../packages/cloudflare-research/src/research-protocol-freeze.js";
import { digest, readWorkflowObject } from "@eliotr/cloudflare-research";
import { readRetrieveBranchesCheckpoint } from "../src/research-retrieve-branches.js";
import { AI_SEARCH_PRIMARY_NAMESPACE, AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  createAiSearchGenerationRegistryService, createD1AiSearchGenerationRegistryStore } from "@eliotr/cloudflare-ai";
import { createD1ScopeProfilePort } from "@eliotr/retrieval";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { createResearchStageHandlerFactory, SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
  SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import { runtime, access, principal, profile, fixture, prepareRetrieveStage, rowCounts } from "./research-retrieve-fixture.js";

describe("RETRIEVE_BRANCHES over the persisted protocol scope", () => {

  it.each([
    { path: "environment", generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, sem: true },
    { path: "explicit", generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, sem: true },
    { path: "legacy", generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION, sem: false },
    { path: "missing-binding", generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, sem: false },
  ] as const)("pins SEM behavior to $generation through the $path factory path", async ({ path, generation, sem }) => {
    const f = await fixture(generation);
    const { request, dependencies } = await prepareRetrieveStage(f);
    await createD1ScopeProfilePort(f.db).recordBinding(f.scope, profile);
    const item = await runtime.SEARCH_DB.prepare(
      "SELECT item_key, canonical_section_id, content_sha256, instruction_taint, projection_generation, source_revision_ref FROM projection_item WHERE active=1 LIMIT 1",
    ).first<{ item_key: string; canonical_section_id: string; content_sha256: string;
      instruction_taint: string; projection_generation: string; source_revision_ref: string }>();
    if (item === null) throw new Error("missing projected fixture");
    const registry = createAiSearchGenerationRegistryService(createD1AiSearchGenerationRegistryStore(runtime.SEARCH_DB));
    const now = new Date().toISOString();
    const prior = await registry.read(AI_SEARCH_PRIMARY_NAMESPACE);
    await registry.declare({ namespace: AI_SEARCH_PRIMARY_NAMESPACE, profile: {
      ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE, id: "stage-sem", generation: item.projection_generation,
    }, expected_item_count: 1, declared_at: now });
    await registry.observe(AI_SEARCH_PRIMARY_NAMESPACE, { generation: item.projection_generation,
      indexed_item_count: 1, readback_item_count: 1, failed_item_count: 0, mismatch_count: 0,
      golden_set_result_ref: "stage-sem-controlled-provider", observed_at: now });
    await registry.promote(AI_SEARCH_PRIMARY_NAMESPACE, { expected_active_head_generation: prior?.artifact.registry.active_head_generation ?? null,
      target_generation: item.projection_generation, promoted_at: now });
    let calls = 0;
    const ai = { get(id: string) {
      expect(id).toBe("stage-sem");
      return { search: async () => {
        calls++;
        return { search_query: "Pinned", chunks: [{ id: "sem-chunk", type: "text", score: 0.9,
          text: "Provider preview is not evidence", item: { key: `${item.item_key}.md`, metadata: {
            canonical_section_id: item.canonical_section_id, content_sha256: item.content_sha256,
            instruction_taint: item.instruction_taint, projection_generation: item.projection_generation,
            source_revision_ref: item.source_revision_ref,
          } }, scoring_details: { vector_score: 0.9, vector_rank: 1 } }] };
      } };
    } } as unknown as AiSearchNamespaceLike;
    const base = { kind: "server-owned-exploratory" as const, generation,
      navigation: f.navigation, ledger: f.ledger } as const;
    const factory = createResearchStageHandlerFactory(path === "explicit"
      ? { ...base, retrieval: { ...dependencies, ai_search: ai } }
      : { ...base, environment: { CORE_DB: f.db, SEARCH_DB: runtime.SEARCH_DB,
        WORK_BUCKET: f.bucket, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET,
        ...(path === "missing-binding" ? {} : { AI_SEARCH: ai }) } });
    const receipt = await f.executor.execute(request, principal, factory("RETRIEVE_BRANCHES"));
    const result = await readRetrieveBranchesCheckpoint(dependencies, request, principal);
    expect(calls, JSON.stringify(result.checkpoint.trace)).toBe(sem ? 1 : 0);
    expect(result.checkpoint.trace.lanes_used.includes("SEM")).toBe(sem);
    expect(result.checkpoint.trace.query_product).toBe(path === "legacy" ? "FAST_SEARCH" : "RESEARCH");
    expect(result.checkpoint.trace.candidates_by_lane["SEM"]).toBe(sem ? 1 : 0);
    if (path === "missing-binding") expect(result.checkpoint.trace.lanes_skipped).toContainEqual({ lane: "SEM", reason: "LANE_UNAVAILABLE" });
    expect(result.checkpoint.evidence_pack.resolved_evidence[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(await f.executor.execute(request, principal, factory("RETRIEVE_BRANCHES"))).toEqual(receipt);
    expect(calls).toBe(sem ? 1 : 0);
  });

  it("reads stage-0 authority, searches the same scope, and replays exact evidence refs", async () => {
    const f = await fixture();
    const { request: retrieveRequest, handler, dependencies } = await prepareRetrieveStage(f);
    const beforeRetrieve = await rowCounts(f.db);
    const firstReceipt = await f.executor.execute(retrieveRequest, principal, handler);
    const authoritative = await readRetrieveBranchesCheckpoint(dependencies, retrieveRequest, principal);
    expect(authoritative.receipt.request_sha256).toBe(firstReceipt.request_sha256);
    expect(authoritative.checkpoint.operation_id).toBe(retrieveRequest.operation_id);
    const firstBytes = await readWorkflowObject(runtime.WORK_BUCKET, firstReceipt.output_manifest, true);
    const first = JSON.parse(new TextDecoder().decode(firstBytes)) as { evidence_pack: { resolved_evidence: readonly { exact_excerpt: string; handle: { source_revision_ref: string; scope_snapshot_ref: { id: string; revision: number } } }[]; pack_ref: { id: string; revision: number } }; trace: { evidence_pack_ref: string }; coverage_claim: string };
    expect(first.coverage_claim, JSON.stringify(first)).toBe("SAMPLED");
    expect(first.evidence_pack.resolved_evidence).toHaveLength(1);
    expect(first.evidence_pack.resolved_evidence[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(first.evidence_pack.resolved_evidence[0]?.handle.scope_snapshot_ref).toEqual({ id: f.scope.snapshot_id, revision: f.scope.revision });
    expect(first.evidence_pack.pack_ref.id).toBe(first.trace.evidence_pack_ref);
    const counts = await rowCounts(f.db);
    expect(counts.snapshots).toBe(beforeRetrieve.snapshots);
    expect(counts.grants).toBe(beforeRetrieve.grants);
    expect(counts.profiles).toBe(beforeRetrieve.profiles + 1);
    expect(counts.results).toBe(beforeRetrieve.results + 1);
    expect(counts.traces).toBe(beforeRetrieve.traces + 1);
    const replayReceipt = await f.executor.execute(retrieveRequest, principal, handler);
    const replayBytes = await readWorkflowObject(runtime.WORK_BUCKET, replayReceipt.output_manifest, true);
    expect(new TextDecoder().decode(replayBytes)).toBe(new TextDecoder().decode(firstBytes));
    expect(await rowCounts(f.db)).toEqual(counts);
    const replayReadback = await readRetrieveBranchesCheckpoint(dependencies, retrieveRequest, principal);
    expect(canonicalEvidenceJson(replayReadback.checkpoint)).toBe(canonicalEvidenceJson(authoritative.checkpoint));
  }, 30_000);

  it("rejects a mismatched operation reference and tampered persisted output", async () => {
    const f = await fixture();
    const { request, handler, dependencies } = await prepareRetrieveStage(f);
    const receipt = await f.executor.execute(request, principal, handler);
    await expect(readRetrieveBranchesCheckpoint(dependencies, { ...request, operation_id: "other-operation" }, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    const original = await f.bucket.head(receipt.output_manifest.object_ref);
    expect(original).not.toBeNull();
    const corrupted = new Uint8Array(await readWorkflowObject(f.bucket, receipt.output_manifest, true));
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    await f.bucket.put(receipt.output_manifest.object_ref, corrupted, {
      sha256: await digest(corrupted),
      customMetadata: original?.customMetadata ?? {},
    });
    await expect(readRetrieveBranchesCheckpoint(dependencies, request, principal))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  }, 30_000);

  it("binds stage-0 readback to the committed attempt reference", async () => {
    const f = await fixture();
    await expect(readFreezeProtocolAndScopeCheckpoint({
      request: f.stage0,
      principal,
      database: f.db,
      bucket: f.bucket,
      navigation: f.navigation,
      ledger: f.ledger,
      expected_attempt_ref: "tampered-stage-zero-attempt",
    }))
      .rejects.toMatchObject({ code: "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE" });
  });

  it("refuses a revoked held grant before retrieval rows or evidence reads", async () => {
    const f = await fixture();
    const { request, handler } = await prepareRetrieveStage(f);
    const before = await rowCounts(f.db);
    await f.db.prepare("UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3")
      .bind(f.scope.snapshot_id, f.scope.revision, access.principal_ref).run();
    const inputBytes = await readWorkflowObject(runtime.WORK_BUCKET, request.input_manifest, true);
    await expect(handler({ request, principal, input_bytes: inputBytes, attempt_ref: "retrieve-revoked-attempt", budget_receipt_ref: "retrieve-budget" }))
      .rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
    expect(await rowCounts(f.db)).toEqual(before);
  });
});
