import { beforeEach, describe, expect, it } from "vitest";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import {
  MANAGED_RANKING_OUTCOME_PROTOCOL,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  ManagedRankingOutcomeSchema,
  ManagedRetrievalTraceSchema,
  RetrievalLaneSchema,
  ScopeSnapshotSchema,
  type RetrievalLane,
  type RetrievalTrace,
} from "@eliotr/contracts";
import { readFreezeProtocolAndScopeCheckpoint } from "../../../packages/cloudflare-research/src/research-protocol-freeze.js";
import { digest, readWorkflowObject, INSTALLED_INQUIRY_PROTOCOL_REFS } from "@eliotr/cloudflare-research";
import { readRetrieveBranchesCheckpoint, serializeRetrieveBranchesCheckpoint } from "@eliotr/cloudflare-research-runtime/research-retrieve-branches.js";
import { AI_SEARCH_PRIMARY_NAMESPACE, AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  createAiSearchGenerationRegistryService, createD1AiSearchGenerationRegistryStore } from "@eliotr/cloudflare-ai";
import { createD1ScopeProfilePort, decodeRetrieveBranchesCheckpoint, managedRetrievalInvocationIdsV1,
  managedRetrievalRefIdV1, type RetrievalQueryAdmissionReceiptV1, type RetrievalTerminalSettlementIdentityV1 } from "@eliotr/retrieval";
import { textDigest } from "@eliotr/cloudflare-workflows";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { createResearchStageHandlerFactory, SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
  SERVER_OWNED_FREEZE_HANDLER_GENERATION, SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION, SERVER_OWNED_PROTOCOL_HANDLER_GENERATION } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import { runtime, access, principal, profile, fixture, prepareRetrieveStage, rowCounts } from "./research-retrieve-fixture.js";
import { createD1RetrievalSettlementOwnerPort } from "../../../packages/cloudflare-research-runtime/src/research-retrieval-settlement-owner.js";
import {
  explainManagedRetrievalBatches,
  observeManagedRetrievalD1,
  readManagedRetrievalSettlementSnapshot,
} from "./research-managed-retrieval-fixture.js";

describe("RETRIEVE_BRANCHES over the persisted protocol scope", () => {

  it("round-trips managed and historical traces through the Stage-5 producer codec", async () => {
    const scopeSnapshot = ScopeSnapshotSchema.parse({
      snapshot_id: "managed-checkpoint-scope",
      revision: 1,
      resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
      participant_generations: {},
      member_source_revision_refs: ["source-revision-1"],
      source_owner_generations: { "source-revision-1": "owner-generation-1" },
      policy_authority_ref: "policy-authority-1",
      disclosure_closure_digest: "a".repeat(64),
      purge_ledger_revision: 0,
      digest: "b".repeat(64),
      created_at: "2026-10-14T00:00:00.000Z",
      expires_at: "2026-10-15T00:00:00.000Z",
    });
    const candidatesByLane = Object.fromEntries(
      RetrievalLaneSchema.options.map((lane) => [lane, 0]),
    ) as Record<RetrievalLane, number>;
    const traceFields = (traceId: string, packId: string): RetrievalTrace => ({
      trace_ref: { id: traceId, revision: 1 },
      raw_query: "managed checkpoint query",
      scope_snapshot: scopeSnapshot,
      query_product: "RESEARCH",
      lanes_used: ["SEM"],
      lanes_skipped: [],
      exact_probes: [],
      index_generations: ["managed-index-generation-1"],
      context_expansion: 0,
      candidates_by_lane: candidatesByLane,
      expansion_refs: [],
      represented_source_refs: [],
      omitted_sources: [],
      stale_or_degraded_channels: [],
      budget_receipt_ref: "budget-checkpoint-1",
      evidence_pack_ref: packId,
    });
    const invocationId = "managed-checkpoint-invocation-1";
    const managedTraceId = await managedRetrievalRefIdV1(invocationId, "trace");
    const managedPackId = await managedRetrievalRefIdV1(invocationId, "pack");
    const managedOutcome = ManagedRankingOutcomeSchema.parse({
      protocol: MANAGED_RANKING_OUTCOME_PROTOCOL,
      provider: "cloudflare_ai_search",
      request_digest: "c".repeat(64),
      scoped_invocation_id: invocationId,
      provider_execution_identity: {
        available: false,
        provider_execution_id: null,
        reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
      },
      output_digest: "d".repeat(64),
      provider_authority: {
        namespace: "research",
        instance_id: "managed-search-1",
        registry_revision: 1,
        registry_artifact_sha256: "e".repeat(64),
      },
      authority_generations: {
        policy_generation: null,
        execution_generation: null,
        index_generation: "managed-index-generation-1",
        query_compiler_generation: null,
      },
      executed_query: "managed checkpoint query",
      contributing_signals: [{ signal: "VECTOR", basis: "EXECUTED_QUERY" }],
      list_semantics: "ONE_PHYSICAL_MANAGED_LIST",
      scope_absence_proven: false,
      rerank_requested: false,
      rerank_attempted: false,
      rerank_succeeded: false,
      rerank_provider: null,
      rerank_model: null,
      fallback_used: false,
      failure_class: null,
      processing_state: "NO_HIT",
      ordered_candidates: [],
    });
    const managedTrace = ManagedRetrievalTraceSchema.parse({
      ...traceFields(managedTraceId, managedPackId),
      protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
      managed_ranking_outcomes: [managedOutcome],
    });
    const checkpoint = (trace: RetrievalTrace | typeof managedTrace, packId: string) => ({
      protocol: "eliotr.research.retrieve-branches.v1" as const,
      workflow_stage: "RETRIEVE_BRANCHES" as const,
      operation_id: "managed-checkpoint-operation",
      investigation_ref: { id: "managed-checkpoint-investigation", revision: 1 },
      principal_ref: "managed-checkpoint-owner",
      scope_snapshot_ref: { id: scopeSnapshot.snapshot_id, revision: scopeSnapshot.revision },
      protocol_digest: "f".repeat(64),
      denominator_digest: "1".repeat(64),
      retrieval_request_digest: "2".repeat(64),
      evidence_pack: {
        pack_ref: { id: packId, revision: 1 },
        scope_snapshot_ref: { id: scopeSnapshot.snapshot_id, revision: scopeSnapshot.revision },
        resolved_evidence: [],
        omitted_candidates: [],
        trace_ref: trace.trace_ref,
        total_utf8_bytes: 0,
      },
      trace,
      coverage_claim: "SAMPLED" as const,
    });

    const managedCheckpoint = checkpoint(managedTrace, managedPackId);
    const managedBytes = serializeRetrieveBranchesCheckpoint(managedCheckpoint);
    expect(decodeRetrieveBranchesCheckpoint(managedBytes)).toEqual(managedCheckpoint);
    expect(JSON.parse(new TextDecoder().decode(managedBytes)).trace.managed_ranking_outcomes)
      .toEqual([managedOutcome]);

    const legacyTraceId = `query-${"8".repeat(48)}`;
    const legacyPackId = `pack-${"9".repeat(48)}`;
    const legacyCheckpoint = checkpoint(traceFields(legacyTraceId, legacyPackId), legacyPackId);
    const legacyBytes = serializeRetrieveBranchesCheckpoint(legacyCheckpoint);
    expect(decodeRetrieveBranchesCheckpoint(legacyBytes)).toEqual(legacyCheckpoint);
  });

  describe.each([
    { path: "environment", generation: SERVER_OWNED_PROTOCOL_HANDLER_GENERATION, sem: true },
    { path: "explicit", generation: SERVER_OWNED_PROTOCOL_HANDLER_GENERATION, sem: true },
    { path: "missing-binding", generation: SERVER_OWNED_PROTOCOL_HANDLER_GENERATION, sem: false },
    { path: "legacy", generation: SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION, sem: false },
    { path: "environment", generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, sem: true },
    { path: "explicit", generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, sem: true },
    { path: "legacy", generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION, sem: false },
    { path: "missing-binding", generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION, sem: false },
  ] as const)("SEM generation $generation through the $path factory path", ({ path, generation, sem }) => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture(generation, generation === SERVER_OWNED_PROTOCOL_HANDLER_GENERATION ||
        generation === SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION
        ? { inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup } : {});
    });
    it("pins the plan and exact replay to the stored generation", async () => {
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
      const observedDatabase = path === "environment" && generation === SERVER_OWNED_PROTOCOL_HANDLER_GENERATION
        ? observeManagedRetrievalD1(f.db) : undefined;
      const factory = createResearchStageHandlerFactory(path === "explicit"
        ? { ...base, retrieval: { ...dependencies, ai_search: ai } }
        : { ...base, environment: { CORE_DB: observedDatabase?.database ?? f.db, SEARCH_DB: runtime.SEARCH_DB,
          WORK_BUCKET: f.bucket, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET,
          ...(path === "missing-binding" ? {} : { AI_SEARCH: ai }) } });
      const receipt = await f.executor.execute(request, principal, factory("RETRIEVE_BRANCHES")).catch(async (error: unknown) => {
        if (observedDatabase === undefined) throw error;
        const idempotency_key = `retrieve-branches:${await textDigest(JSON.stringify(request))}`;
        const settlement = await readManagedRetrievalSettlementSnapshot(f.db, { ...access, idempotency_key });
        const terminalBatches = observedDatabase.batches.filter((batch) =>
          batch.statements.some((statement) => statement.sql.includes("operation_receipt")));
        const explain = await explainManagedRetrievalBatches(f.db, terminalBatches);
        const batches = observedDatabase.batches.map((batch) => ({
          statements: batch.statements.map((statement) => statement.sql),
          ...(batch.changes === undefined ? {} : { changes: batch.changes }),
          ...(batch.error === undefined ? {} : { error: batch.error }),
        }));
        throw new Error(`managed retrieval settlement fixture failed: ${JSON.stringify({ settlement, batches, explain, cause: String(error) })}`);
      });
      const readDependencies = observedDatabase === undefined ? dependencies : { ...dependencies, database: observedDatabase.database };
      const result = await readRetrieveBranchesCheckpoint(readDependencies, request, principal);
      if (observedDatabase !== undefined) {
        const idempotency_key = `retrieve-branches:${await textDigest(JSON.stringify(request))}`;
        const settlement = await readManagedRetrievalSettlementSnapshot(f.db, { ...access, idempotency_key });
        expect(settlement.result?.state).toBe("COMPLETE");
        expect(settlement.attempt?.state).toBe("SUCCEEDED");
        expect(settlement.lease?.state).toBe("COMPLETED");
        expect(settlement.receipt?.outcome).toBe("SUCCEEDED");
        const terminalBatch = observedDatabase.batches.find((batch) =>
          batch.statements.some((statement) => statement.sql.includes("INSERT INTO operation_receipt")));
        expect(terminalBatch?.error).toBeUndefined();
        expect(terminalBatch?.changes?.[2]).toBe(1);
        expect(terminalBatch?.changes?.[3]).toBe(1);
        expect(terminalBatch?.changes?.[4]).toBe(1);
        expect(terminalBatch?.changes?.[5]).toBe(0);

        const persisted = await f.db.prepare(
          "SELECT operation_id,request_digest,result_json,trace_id,trace_revision FROM retrieval_query_result " +
            "WHERE principal_ref=?1 AND client_class=?2 AND credential_generation=?3 AND idempotency_key=?4 LIMIT 1",
        ).bind(access.principal_ref, access.client_class, access.credential_generation, idempotency_key)
          .first<{ operation_id: string; request_digest: string; result_json: string; trace_id: string; trace_revision: number }>();
        const traceRow = await f.db.prepare(
          "SELECT trace_digest FROM retrieval_query_trace WHERE trace_id=?1 AND revision=?2 LIMIT 1",
        ).bind(result.checkpoint.trace.trace_ref.id, result.checkpoint.trace.trace_ref.revision)
          .first<{ trace_digest: string }>();
        if (persisted === null || traceRow === null || !("managed_ranking_outcomes" in result.checkpoint.trace)) {
          throw new Error("managed retrieval settlement identity was not persisted");
        }
        const managedOutcome = result.checkpoint.trace.managed_ranking_outcomes[0];
        if (managedOutcome === undefined) throw new Error("managed retrieval outcome is missing");
        const ids = await managedRetrievalInvocationIdsV1(access.principal_ref, access.client_class, idempotency_key);
        const leaseOwner = settlement.lease?.lease_owner;
        if (persisted.operation_id !== ids.retrieval_operation_id || typeof leaseOwner !== "string") {
          throw new Error("managed retrieval settlement owner identity is inconsistent");
        }
        const identity: RetrievalTerminalSettlementIdentityV1 = {
          access,
          retrieval_operation_id: ids.retrieval_operation_id,
          scoped_invocation_id: ids.scoped_invocation_id,
          execution_id: ids.execution_id,
          idempotency_key,
          scope_snapshot_ref: result.checkpoint.scope_snapshot_ref,
          scope_digest: result.checkpoint.trace.scope_snapshot.digest,
          intent_ref: { id: ids.retrieval_operation_id, revision: 1 },
          attempt_ref: `${ids.retrieval_operation_id}-a1`,
          request_digest: persisted.request_digest,
          output_digest: managedOutcome.output_digest,
          result_json_sha256: await digest(new TextEncoder().encode(persisted.result_json)),
          trace_ref: result.checkpoint.trace.trace_ref,
          trace_json_sha256: traceRow.trace_digest,
        };
        const admission: RetrievalQueryAdmissionReceiptV1 = {
          protocol: "eliotr.retrieval-query-admission.v1",
          retrieval_operation_id: ids.retrieval_operation_id,
          scoped_invocation_id: ids.scoped_invocation_id,
          execution_id: ids.execution_id,
          request_digest: identity.request_digest,
          scope_snapshot_ref: identity.scope_snapshot_ref,
          scope_digest: identity.scope_digest,
          intent_ref: identity.intent_ref,
          attempt_ref: identity.attempt_ref,
          fence: { operation_id: ids.execution_id, lease_owner: leaseOwner, lease_generation: 1 },
        };
        const settlementOwner = createD1RetrievalSettlementOwnerPort();
        expect(await settlementOwner.readCompletedSettlement(f.db, identity)).toBe("COMMITTED");
        const expectRejectedSettlementMutation = async (
          mutate: () => Promise<unknown>, restore: () => Promise<unknown>,
        ): Promise<void> => {
          try {
            await mutate();
            expect(await settlementOwner.readCompletedSettlement(f.db, identity)).toBe("NOT_COMMITTED");
          } finally {
            await restore();
          }
          expect(await settlementOwner.readCompletedSettlement(f.db, identity)).toBe("COMMITTED");
        };

        await expectRejectedSettlementMutation(
          () => f.db.prepare("UPDATE scope_snapshot SET policy_authority_ref=?1 WHERE snapshot_id=?2 AND revision=?3")
            .bind("foreign-policy-authority", identity.scope_snapshot_ref.id, identity.scope_snapshot_ref.revision).run(),
          () => f.db.prepare("UPDATE scope_snapshot SET policy_authority_ref=?1 WHERE snapshot_id=?2 AND revision=?3")
            .bind(result.checkpoint.trace.scope_snapshot.policy_authority_ref,
              identity.scope_snapshot_ref.id, identity.scope_snapshot_ref.revision).run(),
        );

        const ownerMap = await f.db.prepare(
          "SELECT source_owner_generations_json FROM scope_snapshot WHERE snapshot_id=?1 AND revision=?2 LIMIT 1",
        ).bind(identity.scope_snapshot_ref.id, identity.scope_snapshot_ref.revision)
          .first<{ source_owner_generations_json: string }>();
        if (ownerMap === null) throw new Error("managed retrieval scope owner map is missing");
        const owners = JSON.parse(ownerMap.source_owner_generations_json) as Record<string, string>;
        const memberRef = Object.keys(owners)[0];
        if (memberRef === undefined) throw new Error("managed retrieval scope has no owner member");
        owners[memberRef] = "foreign-owner-generation";
        await expectRejectedSettlementMutation(
          () => f.db.prepare("UPDATE scope_snapshot SET source_owner_generations_json=?1 WHERE snapshot_id=?2 AND revision=?3")
            .bind(JSON.stringify(owners), identity.scope_snapshot_ref.id, identity.scope_snapshot_ref.revision).run(),
          () => f.db.prepare("UPDATE scope_snapshot SET source_owner_generations_json=?1 WHERE snapshot_id=?2 AND revision=?3")
            .bind(ownerMap.source_owner_generations_json, identity.scope_snapshot_ref.id, identity.scope_snapshot_ref.revision).run(),
        );

        await expectRejectedSettlementMutation(
          () => f.db.prepare("UPDATE scope_snapshot SET purge_ledger_revision=purge_ledger_revision+1 WHERE snapshot_id=?1 AND revision=?2")
            .bind(identity.scope_snapshot_ref.id, identity.scope_snapshot_ref.revision).run(),
          () => f.db.prepare("UPDATE scope_snapshot SET purge_ledger_revision=?1 WHERE snapshot_id=?2 AND revision=?3")
            .bind(result.checkpoint.trace.scope_snapshot.purge_ledger_revision, identity.scope_snapshot_ref.id, identity.scope_snapshot_ref.revision).run(),
        );

        await expectRejectedSettlementMutation(
          () => f.db.prepare("UPDATE operation_receipt SET reason_codes_json='[\"FOREIGN\"]' WHERE intent_id=?1 AND attempt_id=?2")
            .bind(identity.intent_ref.id, identity.attempt_ref).run(),
          () => f.db.prepare("UPDATE operation_receipt SET reason_codes_json='[]' WHERE intent_id=?1 AND attempt_id=?2")
            .bind(identity.intent_ref.id, identity.attempt_ref).run(),
        );

        await expectRejectedSettlementMutation(
          () => f.db.prepare("UPDATE operation_execution_lease SET state='FAILED' WHERE operation_id=?1")
            .bind(identity.execution_id).run(),
          () => f.db.prepare("UPDATE operation_execution_lease SET state='COMPLETED' WHERE operation_id=?1")
            .bind(identity.execution_id).run(),
        );
        expect(await settlementOwner.reconcileLostAck(f.db, {
          ...admission,
          fence: { ...admission.fence, lease_owner: "foreign-lease-owner" },
        }, identity)).toBe("NOT_COMMITTED");
        expect(await settlementOwner.reconcileLostAck(f.db, admission, identity)).toBe("COMMITTED");
      }
      expect(calls, JSON.stringify(result.checkpoint.trace)).toBe(sem ? 1 : 0);
      expect(result.checkpoint.trace.lanes_used.includes("SEM")).toBe(sem);
      expect(result.checkpoint.trace.query_product).toBe(path === "legacy" ? "FAST_SEARCH" : "RESEARCH");
      expect(result.checkpoint.trace.candidates_by_lane["SEM"]).toBe(sem ? 1 : 0);
      if (observedDatabase !== undefined) {
        if (!("managed_ranking_outcomes" in result.checkpoint.trace)) throw new Error("managed result was not retained in Stage-5 readback");
        const outcome = result.checkpoint.trace.managed_ranking_outcomes[0];
        if (outcome === undefined) throw new Error("managed outcome was not retained in Stage-5 readback");
        expect(result.checkpoint.trace.trace_ref.id).toBe(await managedRetrievalRefIdV1(outcome.scoped_invocation_id, "trace"));
        expect(result.checkpoint.evidence_pack.pack_ref.id).toBe(await managedRetrievalRefIdV1(outcome.scoped_invocation_id, "pack"));
        expect(result.checkpoint.trace.managed_ranking_outcomes).toHaveLength(1);
      }
      if (path === "missing-binding") expect(result.checkpoint.trace.lanes_skipped).toContainEqual({ lane: "SEM", reason: "LANE_UNAVAILABLE" });
      expect(result.checkpoint.evidence_pack.resolved_evidence[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
      expect(await f.executor.execute(request, principal, factory("RETRIEVE_BRANCHES"))).toEqual(receipt);
      expect(calls).toBe(sem ? 1 : 0);
    });
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

  describe("revoked held grant", () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let prepared: Awaited<ReturnType<typeof prepareRetrieveStage>>;
    beforeEach(async () => { f = await fixture(); prepared = await prepareRetrieveStage(f); });
    it("refuses a revoked held grant before retrieval rows or evidence reads", async () => {
      const { request, handler } = prepared;
      const before = await rowCounts(f.db);
      await f.db.prepare("UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3")
        .bind(f.scope.snapshot_id, f.scope.revision, access.principal_ref).run();
      const inputBytes = await readWorkflowObject(runtime.WORK_BUCKET, request.input_manifest, true);
      await expect(handler({ request, principal, input_bytes: inputBytes, attempt_ref: "retrieve-revoked-attempt", budget_receipt_ref: "retrieve-budget" }))
        .rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
      expect(await rowCounts(f.db)).toEqual(before);
    });
  });
});
