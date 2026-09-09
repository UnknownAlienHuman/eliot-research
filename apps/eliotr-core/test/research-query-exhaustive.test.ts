import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";
import { handleHttp } from "../src/http.js";
import { createExhaustiveQueryService } from "../src/exhaustive-query-service.js";

const runtime = env as unknown as Q1Runtime;

async function world(owner: string): Promise<Q1Namespace> {
  const value: Q1Namespace = {
    db: runtime.CORE_DB,
    searchDb: runtime.SEARCH_DB,
    runtime,
    owner,
    ...(await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, owner)),
  };
  await importAndProject(value);
  const decision = await runtime.CORE_DB.prepare(
    "SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref=?1 LIMIT 1",
  ).bind(value.revision).first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("missing source admission decision");
  const expiry = new Date(Date.now() + 86_400_000).toISOString();
  await runtime.CORE_DB.prepare(
    "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
  ).bind(value.namespace, owner, `read-${value.namespace}`, decision.allowed_use_json, decision.disclosure_ceiling, expiry, new Date().toISOString()).run();
  return value;
}

function queryRequest(worldValue: Q1Namespace, key: string, query = "Pinned", scopeExpression: unknown = { kind: "SELECTED_SOURCES", source_ids: [`source-${worldValue.namespace}`] }): Request {
  return new Request("https://research.example/api/v1/research/query", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      query,
      product: "EXHAUSTIVE_JOB",
      scope_expression: scopeExpression,
      literals: [],
      evidence_grade: "E0",
      budget_ref: "exhaustive-job-v1",
      max_results: 8,
    }),
  });
}

function access(owner: string) {
  return { accessVerifier: { async verify() {
    return { principal_ref: owner, credential_generation: "credential-1", authentication_method: "cloudflare_access" as const, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  } } };
}

describe("EXHAUSTIVE_JOB over the production Q1 boundary", () => {
  it("runs import -> projection -> default runtime -> HTTP and creates a durable Workflow", async () => {
    const owner = "exhaustive-http-owner";
    const value = await world(owner);
    const response = await handleHttp(queryRequest(value, "exhaustive-http-first"), runtime, {} as ExecutionContext, access(owner));
    expect(response.status).toBe(202);
    const body = await response.json() as { readonly data?: { readonly protocol?: string; readonly workflow_instance_id?: string; readonly workflow_status?: string } };
    expect(body.data?.protocol).toBe("eliotr.exhaustive-query.v1");
    expect(body.data?.workflow_instance_id).toMatch(/^exhaustive-workflow-[a-f0-9]{64}$/u);
    expect(["queued", "running", "waiting", "complete"]).toContain(body.data?.workflow_status);
    const replay = await handleHttp(queryRequest(value, "exhaustive-http-first"), runtime, {} as ExecutionContext, access(owner));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ data: {
      protocol: "eliotr.exhaustive-query.v1",
      workflow_instance_id: body.data?.workflow_instance_id,
      workflow_status: "complete",
      job: { status: "COMPLETE" },
    } });
    const changedScopeExpression = await handleHttp(
      queryRequest(value, "exhaustive-http-first", "Pinned", { kind: "GLOBAL_LIBRARY" }),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(changedScopeExpression.status).toBe(409);
    expect(await changedScopeExpression.json()).toMatchObject({ code: "RESEARCH_CONFLICT" });
  });

  it("refuses a new job after the owner policy is revoked", async () => {
    const owner = "exhaustive-revoked-owner";
    const value = await world(owner);
    await runtime.CORE_DB.prepare(
      "UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id=?1 AND principal_ref=?2 AND client_class='owner_pwa'",
    ).bind(value.namespace, owner).run();
    const response = await handleHttp(queryRequest(value, "exhaustive-http-revoked"), runtime, {} as ExecutionContext, access(owner));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "RESEARCH_OWNER_REQUIRED" });
  });

  it("keeps a cancelled job pending and resumes it from the persisted scope", async () => {
    const owner = "exhaustive-pending-owner";
    const value = await world(owner);
    const controller = new AbortController();
    controller.abort();
    const cancelled = queryRequest(value, "exhaustive-http-pending");
    const abortedRequest = new Request(cancelled, { signal: controller.signal });
    const first = await handleHttp(abortedRequest, runtime, {} as ExecutionContext, access(owner));
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { readonly data?: { readonly workflow_instance_id?: string } };
    expect(firstBody.data?.workflow_instance_id).toMatch(/^exhaustive-workflow-[a-f0-9]{64}$/u);
    const resumed = await handleHttp(queryRequest(value, "exhaustive-http-pending"), runtime, {} as ExecutionContext, access(owner));
    expect([200, 202]).toContain(resumed.status);
    expect(await resumed.json()).toMatchObject({ data: { protocol: "eliotr.exhaustive-query.v1" } });
  });

  it("rejects a projected range outside the admitted content object", async () => {
    const owner = "exhaustive-range-owner";
    const value = await world(owner);
    const item = await runtime.SEARCH_DB.prepare(
      "SELECT item_key FROM projection_item WHERE source_revision_ref=?1 AND active=1 LIMIT 1",
    ).bind(value.revision).first<{ readonly item_key: string }>();
    if (item === null) throw new Error("missing projected item");
    await runtime.SEARCH_DB.prepare(
      "UPDATE projection_span SET normalized_end_byte=normalized_end_byte+1000000 WHERE item_key=?1",
    ).bind(item.item_key).run();
    const request = queryRequest(value, "exhaustive-http-range");
    await expect(createExhaustiveQueryService(runtime).query({
      request,
      principal_ref: owner,
      client_class: "owner_pwa",
      credential_generation: "credential-1",
      trace_id: "range-test",
    }, await request.clone().json())).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
  });

  it("launches and reads the job through the actual ER09 Workflow binding", async () => {
    const owner = "exhaustive-workflow-owner";
    const value = await world(owner);
    const launched = await handleHttp(queryRequest(value, "exhaustive-workflow-job"), runtime, {} as ExecutionContext, access(owner));
    expect(launched.status).toBe(202);
    const launchedBody = await launched.json() as { readonly data?: { readonly workflow_instance_id?: string } };
    const workflowId = launchedBody.data?.workflow_instance_id;
    expect(workflowId).toMatch(/^exhaustive-workflow-[a-f0-9]{64}$/u);
    const status = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/${workflowId}`, { method: "GET" }),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ data: {
      protocol: "eliotr.exhaustive-query.v1",
      workflow_instance_id: workflowId,
    } });

    const cancelLaunch = await handleHttp(queryRequest(value, "exhaustive-workflow-cancel"), runtime, {} as ExecutionContext, access(owner));
    expect(cancelLaunch.status).toBe(202);
    const cancelBody = await cancelLaunch.json() as { readonly data?: { readonly workflow_instance_id?: string } };
    const cancelId = cancelBody.data?.workflow_instance_id;
    expect(cancelId).toMatch(/^exhaustive-workflow-[a-f0-9]{64}$/u);
    const canceled = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/${cancelId}`, { method: "DELETE" }),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(canceled.status).toBe(200);
    const binding = await runtime.CORE_DB.prepare(
      "SELECT state FROM retrieval_exhaustive_workflow WHERE workflow_id=?1 LIMIT 1",
    ).bind(cancelId).first<{ readonly state: string }>();
    expect(["BOUND", "CANCEL_REQUESTED"]).toContain(binding?.state);
    if (binding?.state === "CANCEL_REQUESTED") {
      const resumed = await handleHttp(queryRequest(value, "exhaustive-workflow-cancel"), runtime, {} as ExecutionContext, access(owner));
      expect(resumed.status).toBe(409);
      expect(await resumed.json()).toMatchObject({ code: "RESEARCH_CANCELLED" });
    }
  });
});
