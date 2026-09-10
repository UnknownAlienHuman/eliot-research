import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  canonicalModelGatewayJson,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
} from "@eliotr/cloudflare-ai";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import { createResearchQueryService } from "../src/research-session.js";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";

/**
 * SEM lane over the managed-search surface against real local D1 Core/Search
 * and R2 through the production Q1 pipeline.
 *
 * Local AI Search qualification boundary (disclosed): the workerd test env
 * carries no live AI Search binding (`wrangler.jsonc` test
 * `ai_search_namespaces` is empty, so `env.AI_SEARCH` is undefined) and the
 * Q1 projector stub reports the managed index DEGRADED, so no managed
 * generation is ever promoted locally. The tests below therefore drive the
 * production registry-backed managed port
 * (`createD1BackedAiSearchManagedSearchPort` over the real SEARCH_DB
 * `ai_search_generation_registry`) with a controlled in-memory AI Search
 * namespace that returns fixed provider chunks. Scope freeze, registry
 * pinning (before/after reads), strict locator decoding, RRF fusion, exact
 * D1+R2 evidence resolution, and trace/result persistence are production
 * code over real D1/R2; only the provider transport bytes are controlled.
 * Live Cloudflare AI Search readback/promotion receipts remain open and the
 * RETRIEVAL slice stays disabled.
 */

const runtime = env as unknown as Q1Runtime;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;

const CREDENTIAL = "credential-1";
const SEM_QUERY = "xenolinguistic drift cartography";

interface Q1Item {
  readonly item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly projection_generation: string;
  readonly instruction_taint: string;
}

async function worldWithPolicy(owner: string): Promise<Q1Namespace> {
  const world: Q1Namespace = {
    db,
    searchDb,
    runtime,
    owner,
    ...(await prepareQ1Namespace(runtime, db, searchDb, owner)),
  };
  await importAndProject(world);
  const decision = await db
    .prepare(
      "SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref = ?1 LIMIT 1",
    )
    .bind(world.revision)
    .first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("Missing admission decision for projected revision");
  const expiry = new Date(Date.now() + 86_400_000).toISOString();
  await db
    .prepare(
      "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
    )
    .bind(world.namespace, owner, `read-${world.namespace}`, decision.allowed_use_json, decision.disclosure_ceiling, expiry, new Date().toISOString())
    .run();
  return world;
}

async function projectedItem(world: Q1Namespace): Promise<Q1Item> {
  const row = await searchDb
    .prepare(
      "SELECT item_key, canonical_section_id, content_sha256, projection_generation, instruction_taint " +
        "FROM projection_item WHERE source_revision_ref = ?1 AND active = 1 LIMIT 1",
    )
    .bind(world.revision)
    .first<Q1Item>();
  if (row === null) throw new Error("Missing projected item");
  return row;
}

function contextFor(owner: string, key: string): AuthenticatedRequestContext {
  const request = new Request("https://research.example/api/v1/research/query", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
  });
  return { request, principal_ref: owner, client_class: "owner_pwa", credential_generation: CREDENTIAL, trace_id: `trace-${key}` };
}

function queryFor(world: Q1Namespace, query: string): QueryRequest {
  return {
    query,
    product: "ORIENT",
    scope_expression: { kind: "SELECTED_SOURCES", source_ids: [`source-${world.namespace}`] },
    literals: [],
    evidence_grade: "E0",
    budget_ref: ORIENTATION_PROFILE,
    max_results: 8,
  };
}

function semProfile(structuralGeneration: string, instanceId: string) {
  return {
    ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    id: instanceId,
    generation: structuralGeneration,
  };
}

/** Promote a registry whose ACTIVE generation is the real structural generation. */
async function promoteStructuralRegistry(structuralGeneration: string, instanceId: string): Promise<void> {
  const service = createAiSearchGenerationRegistryService(
    createD1AiSearchGenerationRegistryStore(searchDb),
  );
  const now = new Date().toISOString();
  const current = await service.read(AI_SEARCH_PRIMARY_NAMESPACE);
  await service.declare({
    namespace: AI_SEARCH_PRIMARY_NAMESPACE,
    profile: semProfile(structuralGeneration, instanceId),
    expected_item_count: 1,
    declared_at: now,
  });
  await service.observe(AI_SEARCH_PRIMARY_NAMESPACE, {
    generation: structuralGeneration,
    indexed_item_count: 1,
    readback_item_count: 1,
    failed_item_count: 0,
    mismatch_count: 0,
    golden_set_result_ref: "golden-sem-test",
    observed_at: now,
  });
  await service.promote(AI_SEARCH_PRIMARY_NAMESPACE, {
    expected_active_head_generation: current?.artifact.registry.active_head_generation ?? null,
    target_generation: structuralGeneration,
    promoted_at: now,
  });
}

function providerChunk(item: Q1Item, revision: string, generation: string) {
  return {
    id: "chunk-sem-1",
    type: "text",
    score: 0.83,
    text: "Controlled provider preview; never citation evidence.",
    item: {
      key: `${item.item_key}.md`,
      metadata: {
        canonical_section_id: item.canonical_section_id,
        content_sha256: item.content_sha256,
        instruction_taint: item.instruction_taint,
        projection_generation: generation,
        source_revision_ref: revision,
      },
    },
    scoring_details: { vector_score: 0.83, vector_rank: 1 },
  };
}

function fakeNamespace(
  instanceId: string,
  onSearch: () => Promise<unknown> | unknown,
): AiSearchNamespaceLike {
  return {
    get(id: string) {
      if (id !== instanceId) throw new Error(`unexpected AI Search instance ${id}`);
      return { search: async () => onSearch() };
    },
  } as unknown as AiSearchNamespaceLike;
}

async function traceOf(traceRef: { readonly id: string; readonly revision: number }) {
  const row = await db
    .prepare("SELECT trace_json FROM retrieval_query_trace WHERE trace_id = ?1 AND revision = ?2")
    .bind(traceRef.id, traceRef.revision)
    .first<{ readonly trace_json: string }>();
  if (row === null) throw new Error("Missing persisted retrieval trace");
  return JSON.parse(row.trace_json) as {
    readonly lanes_used: readonly string[];
    readonly lanes_skipped: readonly { readonly lane: string; readonly reason: string }[];
    readonly index_generations: readonly string[];
    readonly candidates_by_lane: Record<string, number>;
  };
}

describe("research.query SEM lane over the managed-search surface", () => {
  it("executes SEM and resolves a semantically-found candidate to real R2 bytes", async () => {
    const owner = "rq-sem-owner";
    const world = await worldWithPolicy(owner);
    const item = await projectedItem(world);
    const instanceId = "test-sem-instance";
    await promoteStructuralRegistry(item.projection_generation, instanceId);
    const namespace = fakeNamespace(instanceId, () => ({
      search_query: SEM_QUERY,
      chunks: [providerChunk(item, world.revision, item.projection_generation)],
    }));
    const service = createResearchQueryService(
      { CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET, AI_SEARCH: namespace },
    );
    // SEM_QUERY matches no FTS section, so the fused hit can only come from SEM.
    const first = await service.query(contextFor(owner, "rq-sem-first"), queryFor(world, SEM_QUERY));
    expect(first.evidence_pack.resolved_evidence).toHaveLength(1);
    const resolved = first.evidence_pack.resolved_evidence[0];
    if (resolved === undefined) throw new Error("Missing resolved evidence for the SEM hit");
    expect(resolved.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(resolved.handle.source_revision_ref).toBe(world.revision);
    const trace = await traceOf(first.trace_ref);
    expect(trace.lanes_used).toContain("SEM");
    expect(trace.lanes_skipped.map((entry) => entry.lane)).not.toContain("SEM");
    expect(trace.candidates_by_lane["SEM"]).toBe(1);
    expect(trace.index_generations).toContain(item.projection_generation);
    const resultRow = await db
      .prepare("SELECT state, coverage_claim FROM retrieval_query_result WHERE principal_ref = ?1 AND idempotency_key = ?2")
      .bind(owner, "rq-sem-first")
      .first<{ readonly state: string; readonly coverage_claim: string }>();
    // No exhaustive denominator exists, so genuine SEM execution still caps at SAMPLED.
    expect(resultRow).toMatchObject({ state: "COMPLETE", coverage_claim: "SAMPLED" });
  });

  it("catches a mid-read generation rotation instead of serving the stale chunk", async () => {
    const owner = "rq-sem-drift-owner";
    const world = await worldWithPolicy(owner);
    const item = await projectedItem(world);
    const instanceId = "test-sem-drift-instance";
    await promoteStructuralRegistry(item.projection_generation, instanceId);
    const driftGeneration = `drifted-${item.projection_generation}`;
    const driftArtifact = buildAiSearchGenerationRegistryArtifact(AI_SEARCH_PRIMARY_NAMESPACE, 2, {
      active_head_generation: driftGeneration,
      generations: [
        {
          namespace: AI_SEARCH_PRIMARY_NAMESPACE,
          generation: item.projection_generation,
          profile: semProfile(item.projection_generation, instanceId),
          state: "RETIRED",
          expected_item_count: 1,
          indexed_item_count: 1,
          readback_item_count: 1,
          failed_item_count: 0,
          mismatch_count: 0,
          golden_set_result_ref: "golden-sem-test",
          declared_at: new Date(Date.now() - 60_000).toISOString(),
          observed_at: new Date(Date.now() - 30_000).toISOString(),
          retired_at: new Date().toISOString(),
        },
        {
          namespace: AI_SEARCH_PRIMARY_NAMESPACE,
          generation: driftGeneration,
          profile: semProfile(driftGeneration, "test-sem-drift-next"),
          state: "ACTIVE",
          expected_item_count: 1,
          indexed_item_count: 1,
          readback_item_count: 1,
          failed_item_count: 0,
          mismatch_count: 0,
          golden_set_result_ref: "golden-sem-drift",
          declared_at: new Date(Date.now() - 60_000).toISOString(),
          observed_at: new Date(Date.now() - 30_000).toISOString(),
          activated_at: new Date().toISOString(),
        },
      ],
    });
    const driftDigest = await aiSearchGenerationRegistryArtifactDigest(driftArtifact);
    const driftJson = canonicalModelGatewayJson(driftArtifact);
    const namespace = fakeNamespace(instanceId, async () => {
      // Rotate the live registry between the port's before/after reads.
      await searchDb
        .prepare(
          "UPDATE ai_search_generation_registry SET revision = ?2, artifact_sha256 = ?3, artifact_json = ?4 WHERE namespace = ?1",
        )
        .bind(AI_SEARCH_PRIMARY_NAMESPACE, 2, driftDigest, driftJson)
        .run();
      return {
        search_query: SEM_QUERY,
        chunks: [providerChunk(item, world.revision, item.projection_generation)],
      };
    });
    const service = createResearchQueryService(
      { CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET, AI_SEARCH: namespace },
    );
    const result = await service.query(contextFor(owner, "rq-sem-drift"), queryFor(world, SEM_QUERY));
    expect(result.evidence_pack.resolved_evidence).toEqual([]);
    const driftRow = await db
      .prepare("SELECT coverage_claim FROM retrieval_query_result WHERE principal_ref = ?1 AND idempotency_key = ?2")
      .bind(owner, "rq-sem-drift")
      .first<{ readonly coverage_claim: string }>();
    expect(driftRow?.coverage_claim).toBe("NONE");
    const trace = await traceOf(result.trace_ref);
    expect(trace.lanes_used).not.toContain("SEM");
    expect(trace.lanes_skipped).toContainEqual({ lane: "SEM", reason: "SEARCH_INCOMPLETE" });
  });

  it("degrades honestly to SKIPPED_UNAVAILABLE when no managed generation is promoted", async () => {
    const owner = "rq-sem-unpromoted-owner";
    const world = await worldWithPolicy(owner);
    // Restore genuine absence: earlier tests in this file promote the shared
    // "eliotr" registry, and the Q1 fixture itself never promotes one.
    await searchDb
      .prepare("DELETE FROM ai_search_generation_registry WHERE namespace = ?1")
      .bind(AI_SEARCH_PRIMARY_NAMESPACE)
      .run();
    const namespace = fakeNamespace("test-sem-absent-instance", () => {
      throw new Error("provider must not be contacted without a promoted generation");
    });
    const service = createResearchQueryService(
      { CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET, AI_SEARCH: namespace },
    );
    const result = await service.query(contextFor(owner, "rq-sem-unpromoted"), queryFor(world, "absent"));
    expect(result.evidence_pack.resolved_evidence).toEqual([]);
    const unpromotedRow = await db
      .prepare("SELECT coverage_claim FROM retrieval_query_result WHERE principal_ref = ?1 AND idempotency_key = ?2")
      .bind(owner, "rq-sem-unpromoted")
      .first<{ readonly coverage_claim: string }>();
    expect(unpromotedRow?.coverage_claim).toBe("NONE");
    const trace = await traceOf(result.trace_ref);
    expect(trace.lanes_used).not.toContain("SEM");
    expect(trace.lanes_skipped).toContainEqual({ lane: "SEM", reason: "LANE_UNAVAILABLE" });
  });
});
