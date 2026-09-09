import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";
import { handleHttp } from "../src/http.js";
import { validateExhaustiveWorkflowJobCurrent } from "@eliotr/cloudflare-navigation";

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
  const now = new Date().toISOString();
  await runtime.CORE_DB.prepare(
    "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
  ).bind(value.namespace, owner, `read-${value.namespace}`, decision.allowed_use_json, decision.disclosure_ceiling,
    new Date(Date.now() + 86_400_000).toISOString(), now).run();
  return value;
}

function access(owner: string, credential_generation = "credential-1") {
  return { accessVerifier: { async verify() {
    return { principal_ref: owner, credential_generation, authentication_method: "cloudflare_access" as const,
      expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  } } };
}

function launchRequest(value: Q1Namespace, key: string): Request {
  return new Request("https://research.example/api/v1/research/query", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      query: "Pinned",
      product: "EXHAUSTIVE_JOB",
      scope_expression: { kind: "SELECTED_SOURCES", source_ids: [`source-${value.namespace}`] },
      literals: [], evidence_grade: "E0", budget_ref: "exhaustive-job-v1", max_results: 8,
    }),
  });
}

describe("owner exhaustive workflow discovery", () => {
  it("lists actual Workflow bindings with keyset continuation and metadata fences", async () => {
    const owner = "jobs-discovery-owner";
    const value = await world(owner);
    const first = await handleHttp(launchRequest(value, "jobs-discovery-first"), runtime, {} as ExecutionContext, access(owner));
    const second = await handleHttp(launchRequest(value, "jobs-discovery-second"), runtime, {} as ExecutionContext, access(owner));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const launchedIds: string[] = [];
    for (const response of [first, second]) {
      const launched = await response.clone().json() as { readonly data?: { readonly workflow_instance_id?: string } };
      const workflowId = launched.data?.workflow_instance_id;
      expect(workflowId).toMatch(/^exhaustive-workflow-[a-f0-9]{64}$/u);
      launchedIds.push(String(workflowId));
      const status = await handleHttp(
        new Request(`https://research.example/api/v1/research/query/${workflowId}`, { method: "GET" }),
        runtime,
        {} as ExecutionContext,
        access(owner),
      );
      expect(status.status).toBe(200);
    }
    const page = await handleHttp(
      new Request("https://research.example/api/v1/research/query/jobs?limit=1"),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(page.status).toBe(200);
    const document = await page.json() as { readonly data?: Record<string, unknown> };
    expect(document.data).toMatchObject({ protocol: "eliotr.exhaustive-workflow-page.v1" });
    const items = document.data?.items as readonly Record<string, unknown>[] | undefined;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      workflow_status: expect.any(String),
      binding_state: "BOUND",
      recoverable: expect.any(Boolean),
      cancelable: expect.any(Boolean),
    });
    if (items?.[0]?.job_state !== undefined) expect(items[0].job_state).toEqual(expect.any(String));
    expect(JSON.stringify(items)).not.toMatch(/query|source|digest|artifact|receipt/iu);
    const cursor = document.data?.next_cursor;
    expect(typeof cursor).toBe("string");
    const next = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/jobs?limit=1&cursor=${encodeURIComponent(String(cursor))}`),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(next.status).toBe(200);
    const nextDocument = await next.json() as { readonly data?: Record<string, unknown> };
    expect(nextDocument.data?.protocol).toBe("eliotr.exhaustive-workflow-page.v1");
    const nextItems = nextDocument.data?.items as readonly Record<string, unknown>[] | undefined;
    expect(nextItems).toHaveLength(1);
    const firstId = items?.[0]?.workflow_instance_id;
    const secondId = nextItems?.[0]?.workflow_instance_id;
    expect(firstId).toEqual(expect.any(String));
    expect(secondId).toEqual(expect.any(String));
    expect(secondId).not.toBe(firstId);
    expect(new Set([firstId, secondId])).toEqual(new Set(launchedIds));
    expect(nextDocument.data?.next_cursor).toBeUndefined();
    expect(JSON.stringify(nextItems)).not.toMatch(/query|source|digest|artifact|receipt/iu);

    const foreignOwner = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/jobs?limit=1&cursor=${encodeURIComponent(String(cursor))}`),
      runtime,
      {} as ExecutionContext,
      access("jobs-discovery-other-owner"),
    );
    expect(foreignOwner.status).toBe(403);
    const rotatedCredential = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/jobs?limit=1&cursor=${encodeURIComponent(String(cursor))}`),
      runtime,
      {} as ExecutionContext,
      access(owner, "credential-2"),
    );
    expect(rotatedCredential.status).toBe(403);
    const deploymentRotated = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/jobs?limit=1&cursor=${encodeURIComponent(String(cursor))}`),
      { ...runtime, DEPLOYMENT_GENERATION: "deployment-rotated" } as unknown as Q1Runtime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(deploymentRotated.status).toBe(403);
  }, 20_000);

  it("rejects service and malformed cursor access without listing another owner", async () => {
    const owner = "jobs-discovery-fenced-owner";
    const value = await world(owner);
    const service = await handleHttp(
      new Request("https://research.example/api/v1/research/query/jobs"),
      runtime,
      {} as ExecutionContext,
      { accessVerifier: { async verify() {
        return { principal_ref: "service-client", client_class: "trusted_agent", credential_generation: "credential-1",
          authentication_method: "cloudflare_access" as const, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      } } },
    );
    expect(service.status).toBe(403);
    const malformed = await handleHttp(
      new Request("https://research.example/api/v1/research/query/jobs?cursor=not-base64"),
      runtime,
      {} as ExecutionContext,
      access(value.owner),
    );
    expect(malformed.status).toBe(400);
  });

  it("refuses an expired canonical job before exposing workflow metadata", async () => {
    const owner = "jobs-discovery-owner";
    const value = await world(owner);
    const launched = await handleHttp(launchRequest(value, "jobs-discovery-expired"), runtime, {} as ExecutionContext, access(owner));
    expect(launched.status).toBe(202);
    const body = await launched.clone().json() as { readonly data?: { readonly workflow_instance_id?: string } };
    const workflowId = body.data?.workflow_instance_id;
    expect(workflowId).toMatch(/^exhaustive-workflow-[a-f0-9]{64}$/u);
    const status = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/${workflowId}`, { method: "GET" }),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(status.status).toBe(200);
    const scope = await runtime.CORE_DB.prepare(
      "SELECT s.snapshot_id,s.revision,s.snapshot_digest FROM scope_snapshot s JOIN scope_access_grant g ON g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision WHERE g.principal_ref=?1 AND g.client_class='owner_pwa' AND g.credential_generation='credential-1' ORDER BY s.created_at DESC LIMIT 1",
    ).bind(owner).first<{
      readonly snapshot_id: string; readonly revision: number; readonly snapshot_digest: string;
    }>();
    expect(scope).not.toBeNull();
    if (scope === null) return;
    const expiredJobId = `expired-job-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await runtime.CORE_DB.prepare(
      "INSERT INTO retrieval_exhaustive_job (job_id,principal_ref,client_class,credential_generation,idempotency_key,request_digest,scope_snapshot_id,scope_snapshot_revision,scope_digest,plan_id,coverage_denominator_ref,denominator_shard_ids_json,state,denominator_shards,settled_shards,total_scanned_sections,total_matches,result_artifact_ref,coverage_receipt_ref,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'PENDING',?13,NULL,NULL,NULL,NULL,NULL,?14,?15)",
    ).bind(expiredJobId, owner, "owner_pwa", "credential-1", `expired-key-${crypto.randomUUID()}`, "f".repeat(64),
      scope.snapshot_id, scope.revision, scope.snapshot_digest, "expired-plan", "expired-denominator", "[\"expired-shard\"]", 1,
      now, new Date(Date.now() - 1_000).toISOString()).run();
    await expect(validateExhaustiveWorkflowJobCurrent(runtime, {
      request: new Request("https://research.example/api/v1/research/query/jobs"), principal_ref: owner,
      client_class: "owner_pwa", credential_generation: "credential-1", trace_id: "expired-job-test",
    }, expiredJobId)).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE", status: 409 });
  });

  it("drops a cached job when its owner grant is withdrawn during Workflow status", async () => {
    const owner = "jobs-discovery-owner";
    const current = await runtime.CORE_DB.prepare(
      "SELECT w.workflow_id FROM retrieval_exhaustive_workflow w JOIN retrieval_exhaustive_job j ON j.job_id=w.job_id WHERE w.principal_ref=?1 AND j.state='COMPLETE' ORDER BY w.created_at DESC LIMIT 1",
    ).bind(owner).first<{ readonly workflow_id: string }>();
    expect(current).not.toBeNull();
    if (current === null) return;
    const original = runtime.RESEARCH_WORKFLOW;
    let withdrawn = false;
    const interleavingWorkflow = {
      create: (options: Parameters<typeof original.create>[0]) => original.create(options),
      async get(id: string) {
        const instance = await original.get(id);
        return {
          id: instance.id,
          async status() {
            if (!withdrawn) {
              withdrawn = true;
              await runtime.CORE_DB.prepare(
                "UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1 AND client_class='owner_pwa' AND state='ACTIVE'",
              ).bind(owner).run();
            }
            return instance.status();
          },
          terminate: (options?: { readonly rollback?: boolean }) => instance.terminate(options),
        };
      },
    } as typeof original;
    const fencedRuntime = { ...runtime, RESEARCH_WORKFLOW: interleavingWorkflow } as unknown as Q1Runtime;
    const response = await handleHttp(
      new Request("https://research.example/api/v1/research/query/jobs?limit=20"),
      fencedRuntime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(response.status).toBe(200);
    const document = await response.json() as { readonly data?: { readonly items?: readonly { readonly workflow_instance_id: string }[] } };
    expect(document.data?.items?.some((item) => item.workflow_instance_id === current.workflow_id)).toBe(false);
    const invalidated = await runtime.CORE_DB.prepare(
      "SELECT state FROM retrieval_exhaustive_job WHERE job_id=(SELECT job_id FROM retrieval_exhaustive_workflow WHERE workflow_id=?1)",
    ).bind(current.workflow_id).first<{ readonly state: string }>();
    expect(invalidated?.state).toBe("INVALIDATED");
  });
});
