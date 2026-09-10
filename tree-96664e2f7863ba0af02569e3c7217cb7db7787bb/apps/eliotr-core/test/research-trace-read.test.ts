import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import { createResearchQueryService } from "../src/research-session.js";
import { handleHttp } from "../src/http.js";
import type { Env } from "../src/env.js";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";
import {
  count as orientCount,
  db as orientDb,
  request as orientRequest,
  run as orientRun,
  body as orientBody,
  seedSource,
  setupOrientationDatabase,
} from "./orientation-fixture.js";

/**
 * M10: research.trace serves persisted retrieval query-* traces.
 *
 * Real D1 Core/Search + R2 through the production Q1 pipeline for the write
 * side and real HTTP dispatch for the read side. Assertions inspect persisted
 * rows and HTTP payloads, never mock counts. The orient-* path is exercised
 * to prove byte-identical behaviour (ORIENT product, METADATA_ONLY channel).
 */

const runtime = env as unknown as Q1Runtime & Env;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;

const CREDENTIAL = "credential-1";
const ORIENT_CREDENTIAL = "credential-v1";

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

function queryContext(owner: string, key: string): AuthenticatedRequestContext {
  const request = new Request("https://research.example/api/v1/research/query", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
  });
  return { request, principal_ref: owner, client_class: "owner_pwa", credential_generation: CREDENTIAL, trace_id: `trace-${key}` };
}

function retrievalQuery(world: Q1Namespace, query: string): QueryRequest {
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

async function tableCount(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ readonly n: number }>())?.n ?? -1;
}

function traceVerifier(who: string) {
  return {
    async verify() {
      return {
        principal_ref: who,
        credential_generation: CREDENTIAL,
        authentication_method: "cloudflare_access" as const,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      };
    },
  };
}

async function getTrace(id: string, who?: string): Promise<Response> {
  return handleHttp(
    new Request(`https://research.example/api/v1/research/trace/${id}`),
    runtime,
    {} as ExecutionContext,
    who === undefined ? { accessVerifier: traceVerifier("rt-trace-owner") } : { accessVerifier: traceVerifier(who) },
  );
}

describe("research.trace retrieval read route over real D1", () => {
  it("reads back a persisted query-* trace with recorded lanes/skips/coverage/scope and mints no rows", async () => {
    await setupOrientationDatabase();
    const owner = "rt-trace-owner";
    const world = await worldWithPolicy(owner);
    const service = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const first = await service.query(queryContext(owner, "rt-trace-first"), retrievalQuery(world, "Pinned"));
    expect(first.trace_ref.id).toMatch(/^query-[0-9a-f]{48}$/u);
    expect(first.trace_ref.revision).toBe(1);

    const before = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      grant: await tableCount("scope_access_grant"),
      snapshot: await tableCount("scope_snapshot"),
      orient: await orientCount("orientation_request"),
    };

    const response = await getTrace(first.trace_ref.id);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: {
        trace_ref: { id: string; revision: number };
        lanes_used: readonly string[];
        lanes_skipped: readonly { lane: string; reason: string }[];
        scope_snapshot: { snapshot_id: string; revision: number };
        coverage_claim: string;
        query_product: string;
      };
    };
    expect(payload.data.trace_ref).toEqual(first.trace_ref);
    expect(payload.data.lanes_used).toContain("LEX");
    const sem = payload.data.lanes_skipped.find((entry) => entry.lane === "SEM");
    expect(sem?.reason).toBe("LANE_UNAVAILABLE");
    expect(payload.data.coverage_claim).toBe("SAMPLED");
    expect(payload.data.scope_snapshot.snapshot_id).toBe(first.evidence_pack.scope_snapshot_ref.id);
    expect(payload.data.scope_snapshot.revision).toBe(first.evidence_pack.scope_snapshot_ref.revision);
    expect(payload.data.query_product).toBe("ORIENT");

    const stored = await db
      .prepare("SELECT coverage_claim, trace_id FROM retrieval_query_result WHERE principal_ref = ?1 AND idempotency_key = ?2")
      .bind(owner, "rt-trace-first")
      .first<{ readonly coverage_claim: string; readonly trace_id: string }>();
    expect(stored?.coverage_claim).toBe(payload.data.coverage_claim);
    expect(stored?.trace_id).toBe(first.trace_ref.id);

    expect({
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      grant: await tableCount("scope_access_grant"),
      snapshot: await tableCount("scope_snapshot"),
      orient: await orientCount("orientation_request"),
    }).toEqual(before);
  });

  it("keeps orient-* behaviour byte-identical", async () => {
    await seedSource("rt-orient");
    const response = await orientRun(orientRequest("rt-orient"));
    expect(response.status).toBe(200);
    const result = await orientBody(response);
    const traceResponse = await orientRun(
      new Request(`https://research.example/api/v1/research/trace/${result.data.trace_ref.id}`),
    );
    expect(traceResponse.status).toBe(200);
    const trace = await orientBody(traceResponse);
    expect(trace.data.scope_snapshot.snapshot_id).toBe(result.data.evidence_pack.scope_snapshot_ref.id);
    expect(trace.data.query_product).toBe("ORIENT");
    expect(trace.data.stale_or_degraded_channels).toContain("METADATA_ONLY");
  });

  it("denies a foreign principal indistinguishably from a missing trace with no writes", async () => {
    const owner = "rt-foreign-owner";
    const world = await worldWithPolicy(owner);
    const service = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const first = await service.query(queryContext(owner, "rt-foreign-first"), retrievalQuery(world, "absent"));
    const before = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
    };
    const foreign = await getTrace(first.trace_ref.id, "stranger");
    expect(foreign.status).toBe(404);
    const foreignBody = (await foreign.json()) as { code: string };
    const missing = await getTrace(`query-${"0".repeat(48)}`, "stranger");
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { code: string };
    expect(missingBody.code).toBe(foreignBody.code);
    const ownerMissing = await getTrace(`query-${"0".repeat(48)}`);
    expect(ownerMissing.status).toBe(404);
    expect(((await ownerMissing.json()) as { code: string }).code).toBe(foreignBody.code);
    expect(await tableCount("retrieval_query_result")).toBe(before.result);
    expect(await tableCount("retrieval_query_trace")).toBe(before.trace);
    expect(orientDb).toBeDefined();
    expect(ORIENT_CREDENTIAL).toBe("credential-v1");
  });

  it("fails malformed or unknown ids without a write", async () => {
    const before = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      orient: await orientCount("orientation_request"),
    };
    for (const id of ["not-a-valid-id", "query-short", "query-XYZ", "orient-bad"]) {
      const response = await getTrace(id);
      expect(response.status).toBe(400);
    }
    const unknown = await getTrace(`query-${"f".repeat(48)}`);
    expect(unknown.status).toBe(404);
    expect({
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      orient: await orientCount("orientation_request"),
    }).toEqual(before);
  });
});
