import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";
import { handleHttp } from "../src/http.js";

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

function access(owner: string) {
  return { accessVerifier: { async verify() {
    return { principal_ref: owner, credential_generation: "credential-1", authentication_method: "cloudflare_access" as const,
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
    for (const response of [first, second]) {
      const launched = await response.clone().json() as { readonly data?: { readonly workflow_instance_id?: string } };
      const workflowId = launched.data?.workflow_instance_id;
      expect(workflowId).toMatch(/^exhaustive-workflow-[a-f0-9]{64}$/u);
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
    expect(JSON.stringify(nextItems)).not.toMatch(/query|source|digest|artifact|receipt/iu);
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
});
