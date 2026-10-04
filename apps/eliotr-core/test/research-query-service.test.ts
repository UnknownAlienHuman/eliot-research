import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createResearchQueryService, FAST_SEARCH_PROFILE } from "../src/research-session.js";
import { mcpFastSearchResponse } from "../src/mcp-research-service.js";
import { createProjectOwnerService } from "@eliotr/cloudflare-navigation";
import { importAndProject, prepareQ1Namespace, type Q1Namespace, type Q1Runtime } from "./retrieval-q1-fixture.js";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";

const runtime = env as unknown as Q1Runtime;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;

async function namespaceWithReadPolicy(owner: string): Promise<Q1Namespace> {
  const world: Q1Namespace = {
    db,
    searchDb,
    runtime,
    owner,
    ...(await prepareQ1Namespace(runtime, db, searchDb, owner)),
  };
  await importAndProject(world);
  const decision = await db.prepare(
    "SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref=?1 LIMIT 1",
  ).bind(world.revision).first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("Projected source has no admission decision");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await db.prepare(
    "INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation,allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
  ).bind(world.namespace, owner, `read-${world.namespace}`, decision.allowed_use_json,
    decision.disclosure_ceiling, expiresAt, createdAt).run();
  return world;
}

function contextFor(owner: string, key: string): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.example/api/v1/research/query", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
    }),
    principal_ref: owner,
    client_class: "owner_pwa",
    credential_generation: "mcp-query-test-credential",
    trace_id: `trace-${key}`,
  };
}

function fastSearch(scope_expression: QueryRequest["scope_expression"], query: string): QueryRequest {
  return {
    query,
    product: "FAST_SEARCH",
    scope_expression,
    literals: [],
    evidence_grade: "E0",
    budget_ref: FAST_SEARCH_PROFILE,
    max_results: 8,
  };
}

async function storedCoverage(owner: string, key: string): Promise<string | null> {
  const row = await db.prepare(
    "SELECT coverage_claim FROM retrieval_query_result WHERE principal_ref=?1 AND idempotency_key=?2 LIMIT 1",
  ).bind(owner, key).first<{ readonly coverage_claim: string }>();
  return row?.coverage_claim ?? null;
}

async function storedResultCount(owner: string): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM retrieval_query_result WHERE principal_ref=?1",
  ).bind(owner).first<{ readonly count: number }>();
  return row?.count ?? -1;
}

describe("MCP FAST_SEARCH query result contract", () => {
  it("forwards persisted coverage on fresh and replayed reads without changing the HTTP result shape", async () => {
    const owner = "mcp-query-coverage-owner";
    const world = await namespaceWithReadPolicy(owner);
    const service = createResearchQueryService({
      CORE_DB: db,
      SEARCH_DB: searchDb,
      EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET,
    });
    const sampledKey = "mcp-query-coverage-sampled";
    const sampledRequest = fastSearch(
      { kind: "SELECTED_SOURCES", source_ids: [`source-${world.namespace}`] },
      "Pinned content.",
    );

    const sampled = await service.queryForMcp(contextFor(owner, sampledKey), sampledRequest);
    expect(sampled.coverage_claim).toBe("SAMPLED");
    expect(await storedCoverage(owner, sampledKey)).toBe(sampled.coverage_claim);
    expect(sampled.evidence_pack.resolved_evidence).toHaveLength(1);
    const countAfterFresh = await storedResultCount(owner);
    const sampledResponse = mcpFastSearchResponse(sampled);
    expect(Object.keys(sampledResponse).sort()).toEqual([
      "coverage_claim", "evidence_pack", "synthesis_note", "synthesis_status", "trace_ref",
    ]);
    expect(sampledResponse).toMatchObject({
      coverage_claim: "SAMPLED",
      synthesis_status: "NOT_REQUESTED",
      synthesis_note: "FAST_SEARCH returns retrieved evidence and trace references; it does not generate an answer.",
    });
    expect(sampledResponse).not.toHaveProperty("answer");

    const publicReplay = await service.query(contextFor(owner, sampledKey), sampledRequest);
    expect(Object.keys(publicReplay).sort()).toEqual(["evidence_pack", "trace_ref"]);
    expect(publicReplay).toEqual({ evidence_pack: sampled.evidence_pack, trace_ref: sampled.trace_ref });
    expect(await service.queryForMcp(contextFor(owner, sampledKey), sampledRequest)).toEqual(sampled);
    expect(await storedResultCount(owner)).toBe(countAfterFresh);

    const emptyProject = await createProjectOwnerService({
      database: db,
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
    }).create(contextFor(owner, "mcp-query-coverage-empty-project"), {
      idempotency_key: "mcp-query-coverage-empty-project",
      title: "Empty coverage test project",
      source_ids: [],
    });
    const noneKey = "mcp-query-coverage-none";
    const noneRequest = fastSearch(
      { kind: "PROJECT", project_id: emptyProject.project_ref.id },
      "No admitted sources.",
    );
    const none = await service.queryForMcp(contextFor(owner, noneKey), noneRequest);
    expect(none.coverage_claim).toBe("NONE");
    expect(none.evidence_pack.resolved_evidence).toEqual([]);
    expect(await storedCoverage(owner, noneKey)).toBe("NONE");
    expect(await service.queryForMcp(contextFor(owner, noneKey), noneRequest)).toEqual(none);
    expect(Object.keys(await service.query(contextFor(owner, noneKey), noneRequest)).sort())
      .toEqual(["evidence_pack", "trace_ref"]);
  });
});
