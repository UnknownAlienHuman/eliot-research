import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createExhaustiveWorkflowBinding } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { handleHttp } from "../src/http.js";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";
import { exhaustiveJobId, readExhaustiveJobCoverage } from "@eliotr/retrieval";
import { validateExhaustiveWorkflowOutput } from "@eliotr/cloudflare-navigation";

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
    let workflowStatus: "complete" | "running" = "complete";
    const fencedWorkflow = {
      create: (options: Parameters<typeof original.create>[0]) => original.create(options),
      async get(id: string) {
        const instance = await original.get(id);
        return {
          id: instance.id,
          async status() {
            return { status: workflowStatus, output: forged };
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

    workflowStatus = "running";
    const running = await handleHttp(new Request(statusUrl, { method: "GET" }), fencedRuntime, {} as ExecutionContext, access(owner));
    expect(running.status).toBe(200);
    expect((await running.json() as { readonly data?: { readonly job?: unknown } }).data?.job).toBeUndefined();

    // Insert a fresh pending baseline under the already admitted scope. The
    // denominator is read from the genuine completed job, while the pending
    // row itself is the canonical source for the positive UNFINISHED case.
    const denominatorRow = await runtime.CORE_DB.prepare(
      "SELECT scope_snapshot_id,scope_snapshot_revision,scope_digest,denominator_shard_ids_json,denominator_shards,expires_at FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
    ).bind(binding.job_id).first<{ readonly scope_snapshot_id: string; readonly scope_snapshot_revision: number; readonly scope_digest: string; readonly denominator_shard_ids_json: string; readonly denominator_shards: number; readonly expires_at: string }>();
    expect(denominatorRow).not.toBeNull();
    if (denominatorRow === null) return;
    const denominatorIds = JSON.parse(denominatorRow.denominator_shard_ids_json) as string[];
    expect(denominatorIds.length).toBe(denominatorRow.denominator_shards);

    // A terminal row without its immutable shard journal is not a receipt.
    // The row shape alone must not let a missing journal masquerade as COMPLETE.
    const orphanKey = "exhaustive-output-orphan";
    const orphanJobId = await exhaustiveJobId({ principal_ref: owner, client_class: "owner_pwa", credential_generation: "credential-1" }, orphanKey);
    await runtime.CORE_DB.prepare(
      "INSERT INTO retrieval_exhaustive_job (job_id,principal_ref,client_class,credential_generation,idempotency_key,request_digest,scope_snapshot_id,scope_snapshot_revision,scope_digest,plan_id,coverage_denominator_ref,denominator_shard_ids_json,state,denominator_shards,settled_shards,total_scanned_sections,total_matches,result_artifact_ref,coverage_receipt_ref,created_at,expires_at) VALUES (?1,?2,'owner_pwa','credential-1',?3,?4,?5,?6,?7,'orphan-output-plan',?8,?9,'COMPLETE',?10,?10,0,0,'orphan-artifact','orphan-receipt',?11,?12)",
    ).bind(orphanJobId, owner, orphanKey, canonicalReceipt.request_digest, denominatorRow.scope_snapshot_id,
      denominatorRow.scope_snapshot_revision, denominatorRow.scope_digest, canonicalReceipt.coverage_denominator_ref,
      denominatorRow.denominator_shard_ids_json, denominatorRow.denominator_shards, new Date().toISOString(), denominatorRow.expires_at).run();
    await expect(readExhaustiveJobCoverage(runtime.CORE_DB,
      { principal_ref: owner, client_class: "owner_pwa", credential_generation: "credential-1" }, orphanKey,
    )).rejects.toMatchObject({ code: "RETRIEVAL_RESOLUTION_UNCERTAIN" });

    const pendingKey = "exhaustive-output-pending";
    const pendingJobId = await exhaustiveJobId({ principal_ref: owner, client_class: "owner_pwa", credential_generation: "credential-1" }, pendingKey);
    await runtime.CORE_DB.prepare(
      "INSERT INTO retrieval_exhaustive_job (job_id,principal_ref,client_class,credential_generation,idempotency_key,request_digest,scope_snapshot_id,scope_snapshot_revision,scope_digest,plan_id,coverage_denominator_ref,denominator_shard_ids_json,state,denominator_shards,settled_shards,total_scanned_sections,total_matches,result_artifact_ref,coverage_receipt_ref,created_at,expires_at) VALUES (?1,?2,'owner_pwa','credential-1',?3,?4,?5,?6,?7,'pending-output-plan',?8,?9,'PENDING',?10,NULL,NULL,NULL,NULL,NULL,?11,?12)",
    ).bind(pendingJobId, owner, pendingKey, "e".repeat(64), denominatorRow.scope_snapshot_id, denominatorRow.scope_snapshot_revision,
      denominatorRow.scope_digest, canonicalReceipt.coverage_denominator_ref, denominatorRow.denominator_shard_ids_json,
      denominatorRow.denominator_shards, new Date().toISOString(), denominatorRow.expires_at).run();
    const callbackContext: AuthenticatedRequestContext = {
      request: new Request(statusUrl), principal_ref: owner, client_class: "owner_pwa",
      credential_generation: "credential-1", trace_id: "output-boundary-trace",
    };
    const unfinishedValidOutput = {
      protocol: "eliotr.exhaustive-query.v1",
      job: {
        status: "UNFINISHED",
        job_id: pendingJobId,
        coverage_denominator_ref: canonicalReceipt.coverage_denominator_ref,
        denominator_shards: denominatorRow.denominator_shards,
        settled_shards: 0,
        unsettled_shard_ids: denominatorIds,
      },
    };
    const pendingBinding = { job_id: pendingJobId, principal_ref: owner, credential_generation: "credential-1" };
    const pendingResult = await validateExhaustiveWorkflowOutput(runtime.CORE_DB, pendingBinding, callbackContext, unfinishedValidOutput);
    expect(pendingResult?.job).toEqual(unfinishedValidOutput.job);

    // A foreign journal row is counted by the pending loader but excluded by
    // denominator readback; the disagreement must remain UNKNOWN.
    const foreignJson = JSON.stringify({ shard_id: "foreign-shard", disposition: "SETTLED" });
    const foreignDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(foreignJson)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await runtime.CORE_DB.prepare(
      "INSERT INTO retrieval_exhaustive_shard (job_id,shard_id,outcome_json,outcome_digest,created_at) VALUES (?1,?2,?3,?4,?5)",
    ).bind(pendingJobId, "foreign-shard", foreignJson, foreignDigest, new Date().toISOString()).run();
    await expect(readExhaustiveJobCoverage(runtime.CORE_DB,
      { principal_ref: owner, client_class: "owner_pwa", credential_generation: "credential-1" }, pendingKey,
    )).rejects.toMatchObject({ code: "RETRIEVAL_RESOLUTION_UNCERTAIN" });

    await expect(validateExhaustiveWorkflowOutput(runtime.CORE_DB, pendingBinding, callbackContext, {
      ...unfinishedValidOutput,
      job: { ...unfinishedValidOutput.job, unsettled_shard_ids: ["forged-shard"] },
    })).rejects.toMatchObject({ code: "RETRIEVAL_RESOLUTION_UNCERTAIN" });

    // A persisted mutation after the first output read must invalidate the
    // second readback; status callbacks cannot turn a stale result into a
    // disclosed receipt.
    let callbackCalls = 0;
    const callbackBinding = createExhaustiveWorkflowBinding({
      database: runtime.CORE_DB,
      workflow: fencedWorkflow,
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
      parseRequest: () => { throw new Error("not used"); },
      idempotencyKey: () => "exhaustive-output-boundary",
      validateCurrentWorkflowJob: async () => {
        callbackCalls += 1;
        await runtime.CORE_DB.prepare(
          "UPDATE retrieval_exhaustive_job SET state='INVALIDATED', settled_shards=NULL, total_scanned_sections=NULL, total_matches=NULL, result_artifact_ref=NULL, coverage_receipt_ref=NULL WHERE job_id=?1",
        )
          .bind(binding.job_id).run();
      },
    });
    // A well-shaped terminal payload from a still-running Workflow is not
    // eligible for disclosure, and must not trigger the terminal callback.
    forged = { protocol: "eliotr.exhaustive-query.v1", job: { status: "COMPLETE", receipt: canonicalReceipt } };
    workflowStatus = "running";
    const runningThroughBinding = await callbackBinding.status(callbackContext, workflowId);
    expect(runningThroughBinding.job).toBeUndefined();
    expect(callbackCalls).toBe(0);

    workflowStatus = "complete";
    const callbackResult = await callbackBinding.status(callbackContext, workflowId);
    expect(callbackResult.job).toBeUndefined();
    expect(callbackCalls).toBe(1);
  }, 20_000);
});
