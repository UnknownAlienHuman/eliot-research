import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";
import { handleHttp } from "../src/http.js";
import { ResearchWorkflow } from "../src/research-workflow.js";
import { digest } from "@eliotr/cloudflare-research";

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
  it("runs import -> projection -> default runtime -> HTTP and persists an exact COMPLETE receipt", async () => {
    const owner = "exhaustive-http-owner";
    const value = await world(owner);
    const beforeHandles = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM evidence_handle").first<{ readonly n: number }>();
    const response = await handleHttp(queryRequest(value, "exhaustive-http-first"), runtime, {} as ExecutionContext, access(owner));
    expect(response.status).toBe(200);
    const body = await response.json() as { readonly data?: { readonly protocol?: string; readonly job?: { readonly status?: string; readonly receipt?: { readonly coverage_claim?: string; readonly total_matches?: number } } } };
    expect(body.data?.protocol).toBe("eliotr.exhaustive-query.v1");
    expect(body.data?.job).toMatchObject({ status: "COMPLETE", receipt: { coverage_claim: "COMPLETE", total_matches: 1 } });
    const afterHandles = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS n FROM evidence_handle").first<{ readonly n: number }>();
    expect((afterHandles?.n ?? 0)).toBe((beforeHandles?.n ?? 0) + 1);
    const replay = await handleHttp(queryRequest(value, "exhaustive-http-first"), runtime, {} as ExecutionContext, access(owner));
    expect(replay.status).toBe(200);
    expect((await replay.json() as { readonly data?: unknown }).data).toEqual(body.data);
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
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ code: "RESEARCH_CANCELLED" });
    const pending = await runtime.CORE_DB.prepare(
      "SELECT state, scope_snapshot_id FROM retrieval_exhaustive_job WHERE idempotency_key=?1 LIMIT 1",
    ).bind("exhaustive-http-pending").first<{ readonly state: string; readonly scope_snapshot_id: string }>();
    expect(pending).toMatchObject({ state: "PENDING" });
    const resumed = await handleHttp(queryRequest(value, "exhaustive-http-pending"), runtime, {} as ExecutionContext, access(owner));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ data: { job: { status: "COMPLETE" } } });
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
    const response = await handleHttp(queryRequest(value, "exhaustive-http-range"), runtime, {} as ExecutionContext, access(owner));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
  });

  it("runs the same job through the canonical ER09 Workflow host", async () => {
    const owner = "exhaustive-workflow-owner";
    const value = await world(owner);
    const inputBytes = new TextEncoder().encode("workflow exhaustive input");
    const inputHash = await digest(inputBytes);
    const inputRef = `exhaustive-workflow-input-${value.namespace}`;
    await runtime.WORK_BUCKET.put(inputRef, inputBytes);
    const params = {
      operation_id: `exhaustive-workflow-${value.namespace}`,
      investigation_ref: { id: `exhaustive-investigation-${value.namespace}`, revision: 1 },
      idempotency_key: "exhaustive-workflow-job",
      handler_generation: "exhaustive-q8.v1",
      initial_input_manifest: {
        object_ref: inputRef,
        sha256: inputHash,
        byte_length: inputBytes.byteLength,
        residency: {
          scope_domain_id: "workflow-scope",
          access_domain_id: owner,
          confidentiality_domain_id: "private",
          encryption_key_domain_id: "key-1",
          retention_domain_id: "retention-1",
          erasure_domain_id: "erasure-1",
          content_digest: { algorithm: "sha256" as const, digest: inputHash },
        },
      },
      principal_ref: owner,
      credential_generation: "credential-1",
      deployment_generation: "test-generation",
      exhaustive_request: {
        query: "Pinned",
        product: "EXHAUSTIVE_JOB",
        scope_expression: { kind: "SELECTED_SOURCES", source_ids: [`source-${value.namespace}`] },
        literals: [],
        evidence_grade: "E0",
        budget_ref: "exhaustive-job-v1",
        max_results: 8,
      },
    };
    const fakeStep = {
      do: async (name: string, callback: () => Promise<unknown>) => {
        expect(name).toBe("q8-exhaustive-job");
        return callback();
      },
    };
    const result = await ResearchWorkflow.prototype.run.call({ env: runtime }, { payload: params } as never, fakeStep as never);
    expect(result).toMatchObject({ protocol: "eliotr.exhaustive-query.v1", job: { status: "COMPLETE" } });
  });
});
