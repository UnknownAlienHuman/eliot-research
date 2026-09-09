import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleHttp } from "../src/http.js";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";

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

function request(value: Q1Namespace, key: string): Request {
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

describe("durable exhaustive Workflow output boundary", () => {
  it("exposes a genuine COMPLETE receipt and omits forged terminal payloads", async () => {
    const owner = "exhaustive-output-boundary-owner";
    const value = await world(owner);
    const launched = await handleHttp(request(value, "exhaustive-output-boundary"), runtime, {} as ExecutionContext, access(owner));
    expect(launched.status).toBe(202);
    const launchBody = await launched.json() as { readonly data?: { readonly workflow_instance_id?: string } };
    const workflowId = launchBody.data?.workflow_instance_id;
    expect(workflowId).toMatch(/^exhaustive-workflow-[a-f0-9]{64}$/u);
    if (typeof workflowId !== "string") return;
    const binding = await runtime.CORE_DB.prepare(
      "SELECT job_id FROM retrieval_exhaustive_workflow WHERE workflow_id=?1 LIMIT 1",
    ).bind(workflowId).first<{ readonly job_id: string }>();
    expect(binding).not.toBeNull();
    if (binding === null) return;
    const genuine = await handleHttp(request(value, "exhaustive-output-boundary"), runtime, {} as ExecutionContext, access(owner));
    expect(genuine.status).toBe(200);
    const genuineBody = await genuine.json() as { readonly data?: { readonly job?: Record<string, unknown> } };
    expect(genuineBody.data?.job?.status).toBe("COMPLETE");
    const receipt = genuineBody.data?.job?.receipt;
    expect(receipt).toMatchObject({ job_id: binding.job_id, coverage_claim: "COMPLETE" });
    if (receipt === null || typeof receipt !== "object") return;
    const canonicalReceipt = receipt as Record<string, unknown>;
    const durable = await runtime.CORE_DB.prepare(
      "SELECT state FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
    ).bind(binding.job_id).first<{ readonly state: string }>();
    expect(durable?.state).toBe("COMPLETE");
    const original = runtime.RESEARCH_WORKFLOW;
    let forged: Record<string, unknown> = {
      protocol: "eliotr.exhaustive-query.v1",
      job: {
        status: "COMPLETE",
        receipt: { ...canonicalReceipt, result_artifact_ref: "forged-artifact" },
      },
    };
    const fencedWorkflow = {
      create: (options: Parameters<typeof original.create>[0]) => original.create(options),
      async get(id: string) {
        const instance = await original.get(id);
        return {
          id: instance.id,
          async status() {
            return { status: "complete" as const, output: forged };
          },
          terminate: (options?: { readonly rollback?: boolean }) => instance.terminate(options),
        };
      },
    } as typeof original;
    const fencedRuntime = { ...runtime, RESEARCH_WORKFLOW: fencedWorkflow } as unknown as Q1Runtime;
    const statusUrl = `https://research.example/api/v1/research/query/${workflowId}`;
    const complete = await handleHttp(new Request(statusUrl, { method: "GET" }), fencedRuntime, {} as ExecutionContext, access(owner));
    expect(complete.status).toBe(200);
    expect((await complete.json() as { readonly data?: { readonly job?: unknown } }).data?.job).toBeUndefined();

    forged = {
      protocol: "eliotr.exhaustive-query.v1",
      job: {
        status: "UNFINISHED",
        job_id: binding.job_id,
        coverage_denominator_ref: canonicalReceipt.coverage_denominator_ref,
        denominator_shards: canonicalReceipt.denominator_shards,
        settled_shards: Math.max(0, Number(canonicalReceipt.denominator_shards) - 1),
        unsettled_shard_ids: ["forged-shard"],
      },
    };
    const unfinished = await handleHttp(new Request(statusUrl, { method: "GET" }), fencedRuntime, {} as ExecutionContext, access(owner));
    expect(unfinished.status).toBe(200);
    expect((await unfinished.json() as { readonly data?: { readonly job?: unknown } }).data?.job).toBeUndefined();
  }, 20_000);
});
