import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import {
  MANAGED_RANKING_OUTCOME_PROTOCOL,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  ManagedRankingOutcomeSchema,
  ManagedRetrievalTraceSchema,
  type RetrievalTrace,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import { canonicalRetrievalJson, managedRetrievalRefIdV1 } from "@eliotr/retrieval";
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

async function getTrace(id: string, who?: string, coreDatabase: D1Database = db): Promise<Response> {
  return handleHttp(
    new Request(`https://research.example/api/v1/research/trace/${id}`),
    { ...runtime, CORE_DB: coreDatabase } as Env,
    {} as ExecutionContext,
    who === undefined ? { accessVerifier: traceVerifier("rt-trace-owner") } : { accessVerifier: traceVerifier(who) },
  );
}

function managedTraceReadDatabase(input: {
  readonly owner: string;
  readonly trace_id: string;
  readonly trace_json: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_digest: string;
  readonly scope_expires_at: string;
}) {
  const authority = {
    grant_state: "ACTIVE",
    purge_ledger_revision: 0,
    purge_frontier: 0,
    trace_json: input.trace_json,
  };
  const database = {
    prepare(query: string) {
      const first = async <T>(parameters: readonly unknown[]): Promise<T | null> => {
        if (query.includes("FROM retrieval_query_trace WHERE")) {
          return parameters[0] === input.trace_id && parameters[1] === 1
            ? {
              trace_json: authority.trace_json,
              scope_snapshot_id: input.scope_snapshot_id,
              scope_snapshot_revision: input.scope_snapshot_revision,
            } as T
            : null;
        }
        if (query.includes("FROM retrieval_query_result WHERE")) {
          return parameters[0] === input.trace_id && parameters[1] === 1 &&
              parameters[2] === input.owner && parameters[3] === "owner_pwa" && parameters[4] === CREDENTIAL
            ? { coverage_claim: "SAMPLED", state: "COMPLETE" } as T
            : null;
        }
        if (query.includes("FROM scope_snapshot s LEFT JOIN scope_access_grant_effective")) {
          return parameters[0] === input.scope_snapshot_id && parameters[1] === input.scope_snapshot_revision &&
              parameters[2] === input.owner && parameters[3] === "owner_pwa" && parameters[4] === CREDENTIAL
            ? {
              snapshot_digest: input.scope_digest,
              invalidated_at: null,
              expires_at: input.scope_expires_at,
              purge_ledger_revision: authority.purge_ledger_revision,
              policy_authority_ref: "managed-trace-policy-1",
              grant_state: authority.grant_state,
              grant_expires_at: input.scope_expires_at,
              grant_policy_ref: "managed-trace-policy-1",
              purge_frontier: authority.purge_frontier,
              stale_members: 0,
            } as T
            : null;
        }
        const statement = db.prepare(query);
        return parameters.length === 0
          ? statement.first<T>()
          : statement.bind(...parameters).first<T>();
      };
      return {
        first: <T>() => first<T>([]),
        bind: (...parameters: unknown[]) => ({
          first: <T>() => first<T>(parameters),
        }),
      };
    },
  } as unknown as D1Database;
  return { database, authority };
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

  it("dispatches a strictly decoded managed mrt1 trace through owner and current-scope checks", async () => {
    await setupOrientationDatabase();
    const owner = "rt-managed-trace-owner";
    const world = await worldWithPolicy(owner);
    const service = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const legacy = await service.query(queryContext(owner, "rt-managed-trace-seed"), retrievalQuery(world, "Pinned"));
    const storedTrace = await db.prepare(
      "SELECT trace_json FROM retrieval_query_trace WHERE trace_id = ?1 AND revision = ?2 LIMIT 1",
    ).bind(legacy.trace_ref.id, legacy.trace_ref.revision).first<{ readonly trace_json: string }>();
    if (storedTrace === null) throw new Error("managed trace seed row is missing");
    const legacyTrace = JSON.parse(storedTrace.trace_json) as RetrievalTrace;
    const invocationId = "managed-trace-read-invocation";
    const traceId = await managedRetrievalRefIdV1(invocationId, "trace");
    const packId = await managedRetrievalRefIdV1(invocationId, "pack");
    const outcome = ManagedRankingOutcomeSchema.parse({
      protocol: MANAGED_RANKING_OUTCOME_PROTOCOL,
      provider: "cloudflare_ai_search",
      request_digest: "a".repeat(64),
      scoped_invocation_id: invocationId,
      provider_execution_identity: {
        available: false,
        provider_execution_id: null,
        reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
      },
      output_digest: "b".repeat(64),
      provider_authority: {
        namespace: "research",
        instance_id: "managed-trace-search",
        registry_revision: 1,
        registry_artifact_sha256: "c".repeat(64),
      },
      authority_generations: {
        policy_generation: null,
        execution_generation: null,
        index_generation: "managed-trace-index",
        query_compiler_generation: null,
      },
      executed_query: "Pinned",
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
    const trace = ManagedRetrievalTraceSchema.parse({
      ...legacyTrace,
      trace_ref: { id: traceId, revision: 1 },
      evidence_pack_ref: packId,
      index_generations: [...legacyTrace.index_generations, "managed-trace-index"],
      protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
      managed_ranking_outcomes: [outcome],
    });
    const readState = managedTraceReadDatabase({
      owner,
      trace_id: traceId,
      trace_json: canonicalRetrievalJson(trace),
      scope_snapshot_id: trace.scope_snapshot.snapshot_id,
      scope_snapshot_revision: trace.scope_snapshot.revision,
      scope_digest: trace.scope_snapshot.digest,
      scope_expires_at: trace.scope_snapshot.expires_at,
    });

    const response = await getTrace(traceId, owner, readState.database);
    expect(response.status, await response.clone().text()).toBe(200);
    const payload = await response.json() as { data: {
      readonly trace_ref: { readonly id: string; readonly revision: number };
      readonly managed_ranking_outcomes: readonly unknown[];
    } };
    expect(payload.data.trace_ref).toEqual({ id: traceId, revision: 1 });
    expect(payload.data.managed_ranking_outcomes).toEqual([outcome]);
    expect(await getTrace(traceId, "rt-managed-trace-stranger", readState.database).then((item) => item.status)).toBe(404);
    expect(await getTrace("mrt1-short", owner, readState.database).then((item) => item.status)).toBe(400);

    readState.authority.grant_state = "REVOKED";
    expect(await getTrace(traceId, owner, readState.database).then((item) => item.status)).toBe(409);
    readState.authority.grant_state = "ACTIVE";
    readState.authority.purge_ledger_revision = 1;
    expect(await getTrace(traceId, owner, readState.database).then((item) => item.status)).toBe(409);
    readState.authority.purge_ledger_revision = 0;
    readState.authority.trace_json = JSON.stringify({ ...trace, unexpected_load_bearing_field: true });
    expect(await getTrace(traceId, owner, readState.database).then((item) => item.status)).toBe(409);
  });
});
