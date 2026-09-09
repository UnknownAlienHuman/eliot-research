import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";
import { handleHttp } from "../src/http.js";
import { createExhaustiveQueryService } from "../src/exhaustive-query-service.js";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { canonicalNormalizedBundleKey } from "@eliotr/platform-cloudflare";
import { projectionDigest } from "@eliotr/cloudflare-projection";

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

/** Extend one admitted Q1 source into real, independently addressed source revisions. */
async function addAdmittedProjectedSources(worldValue: Q1Namespace, count: number): Promise<readonly string[]> {
  const { db, searchDb, runtime, namespace, revision } = worldValue;
  const source = await db.prepare("SELECT * FROM source WHERE source_namespace_id=?1 LIMIT 1").bind(namespace).first<Record<string, unknown>>();
  const sourceRevision = await db.prepare("SELECT * FROM source_revision WHERE source_revision_ref=?1 LIMIT 1").bind(revision).first<Record<string, unknown>>();
  const operation = await db.prepare("SELECT * FROM bundle_ingest_operation WHERE source_revision_ref=?1 LIMIT 1").bind(revision).first<Record<string, unknown>>();
  const decisionRow = await db.prepare("SELECT * FROM source_admission_decision WHERE source_revision_ref=?1 LIMIT 1").bind(revision).first<Record<string, unknown>>();
  const item = await searchDb.prepare("SELECT * FROM projection_item WHERE source_revision_ref=?1 AND active=1 LIMIT 1").bind(revision).first<Record<string, unknown>>();
  const span = await searchDb.prepare("SELECT * FROM projection_span WHERE item_key=?1 LIMIT 1").bind(item?.item_key).first<Record<string, unknown>>();
  const generation = await searchDb.prepare("SELECT * FROM projection_generation_receipt WHERE source_revision_ref=?1 LIMIT 1").bind(revision).first<Record<string, unknown>>();
  const guard = await searchDb.prepare("SELECT * FROM projection_activation_guard WHERE source_revision_ref=?1 LIMIT 1").bind(revision).first<Record<string, unknown>>();
  if (!source || !sourceRevision || !operation || !decisionRow || !item || !span || !generation || !guard) throw new Error("missing Q1 clone fixture rows");
  const sourceManifestKey = String(sourceRevision.normalized_artifact_ref);
  const manifestObject = await runtime.EVIDENCE_BUCKET.get(sourceManifestKey);
  if (manifestObject === null) throw new Error("missing Q1 manifest object");
  const manifest = JSON.parse(new TextDecoder().decode(await manifestObject.arrayBuffer())) as Record<string, unknown>;
  const sourceContentKey = await canonicalNormalizedBundleKey(String(sourceRevision.object_residency_key_digest), {
    owner_system_id: String(source.source_owner_system_id), source_namespace_id: namespace,
    source_owner_generation: String(sourceRevision.source_owner_generation), source_logical_id: String(source.source_id),
    source_revision_ref: revision,
  }, "content.md");
  const contentObject = await runtime.EVIDENCE_BUCKET.get(sourceContentKey);
  if (contentObject === null) throw new Error("missing Q1 content object");
  const content = new Uint8Array(await contentObject.arrayBuffer());
  const revisionRefs: string[] = [];
  const now = new Date().toISOString();
  const operationKeys = ["operation_id", "principal_ref", "origin_authentication_receipt_ref", "idempotency_key", "input_fingerprint", "manifest_sha256", "manifest_json", "file_hashes_json", "total_bytes", "source_namespace_id", "owner_system_id", "source_owner_generation", "source_revision_ref", "source_id", "expected_head_revision_ref", "residency_key_json", "residency_key_digest", "policy_revision", "policy_snapshot_json", "policy_snapshot_sha256", "candidate_id", "staging_session_ref", "qualification_report_ref", "decision_receipt_ref", "promotion_receipt_ref", "state", "bundle_receipt_json", "bundle_receipt_sha256", "created_at", "updated_at", "expires_at"];
  const sourceKeys = ["source_id", "source_namespace_id", "source_owner_system_id", "source_owner_generation", "ownership_mode", "kind", "origin_uri", "title", "default_storage_policy", "default_residency_profile_id", "source_class", "license_policy_ref", "default_retention_policy_id", "head_rev", "created_at"];
  const revisionKeys = ["source_revision_ref", "source_id", "source_owner_generation", "content_sha256", "object_residency_key_digest", "original_r2_key", "normalized_artifact_ref", "captured_at", "parser_profile_generation", "quality_state", "purge_state", "currentness_state", "source_view_ref", "workspace_view_revision_ref", "admitted_at"];
  const decisionKeys = ["decision_receipt_ref", "operation_id", "source_namespace_id", "owner_system_id", "source_owner_generation", "source_revision_ref", "origin_authentication_receipt_ref", "source_class", "assurance_ceiling", "instruction_taint", "allowed_effects", "object_residency_key_digest", "allowed_use_json", "disclosure_ceiling", "license_policy_ref", "expires_at", "decision", "reason_codes_json", "decision_json", "decision_sha256", "created_at"];
  for (let index = 0; index < count; index += 1) {
    const sourceId = `source-${namespace}-q8-${index + 1}`;
    const revisionRef = `revision-${namespace}-q8-${index + 1}`;
    const operationId = `operation-${namespace}-q8-${index + 1}`;
    const candidateId = `candidate-${namespace}-q8-${index + 1}`;
    const receiptRef = `decision-${namespace}-q8-${index + 1}`;
    const itemKey = `item-${namespace}-q8-${index + 1}`;
    const generationRef = String(generation.projection_generation);
    const manifestKey = await canonicalNormalizedBundleKey(String(sourceRevision.object_residency_key_digest), {
      owner_system_id: String(source.source_owner_system_id), source_namespace_id: namespace,
      source_owner_generation: String(sourceRevision.source_owner_generation), source_logical_id: sourceId,
      source_revision_ref: revisionRef,
    }, "manifest.json");
    const contentKey = await canonicalNormalizedBundleKey(String(sourceRevision.object_residency_key_digest), {
      owner_system_id: String(source.source_owner_system_id), source_namespace_id: namespace,
      source_owner_generation: String(sourceRevision.source_owner_generation), source_logical_id: sourceId,
      source_revision_ref: revisionRef,
    }, "content.md");
    const cloneManifest = { ...manifest, origin: { ...(manifest.origin as Record<string, unknown>), source_revision_ref: revisionRef } };
    const manifestBytes = new TextEncoder().encode(canonicalEvidenceJson(cloneManifest));
    await runtime.EVIDENCE_BUCKET.put(manifestKey, manifestBytes);
    await runtime.EVIDENCE_BUCKET.put(contentKey, content);
    await db.prepare(`INSERT INTO source (${sourceKeys.join(",")}) VALUES (${sourceKeys.map((_, i) => `?${i + 1}`).join(",")})`).bind(
      sourceId, namespace, source.source_owner_system_id, source.source_owner_generation, source.ownership_mode, source.kind,
      source.origin_uri, source.title, source.default_storage_policy, source.default_residency_profile_id, source.source_class,
      source.license_policy_ref, source.default_retention_policy_id, revisionRef, now,
    ).run();
    await db.prepare(`INSERT INTO source_revision (${revisionKeys.join(",")}) VALUES (${revisionKeys.map((_, i) => `?${i + 1}`).join(",")})`).bind(
      revisionRef, sourceId, sourceRevision.source_owner_generation, sourceRevision.content_sha256, sourceRevision.object_residency_key_digest,
      sourceRevision.original_r2_key, manifestKey, sourceRevision.captured_at, sourceRevision.parser_profile_generation,
      sourceRevision.quality_state, sourceRevision.purge_state, sourceRevision.currentness_state, sourceRevision.source_view_ref,
      sourceRevision.workspace_view_revision_ref, now,
    ).run();
    const clonedOperation = { ...operation, operation_id: operationId, idempotency_key: `q8-${revisionRef}`, source_revision_ref: revisionRef,
      source_id: sourceId, candidate_id: candidateId, staging_session_ref: null, qualification_report_ref: null,
      decision_receipt_ref: receiptRef, promotion_receipt_ref: null, created_at: now, updated_at: now };
    await db.prepare(`INSERT INTO bundle_ingest_operation (${operationKeys.join(",")}) VALUES (${operationKeys.map((_, i) => `?${i + 1}`).join(",")})`).bind(...operationKeys.map((key) => clonedOperation[key] ?? null)).run();
    const decision = { ...JSON.parse(String(decisionRow.decision_json)), source_revision_ref: revisionRef, decision_receipt_ref: receiptRef };
    const decisionJson = canonicalEvidenceJson(decision);
    const clonedDecision = { ...decisionRow, decision_receipt_ref: receiptRef, operation_id: operationId, source_revision_ref: revisionRef,
      decision_json: decisionJson, decision_sha256: await evidenceSha256(decision), created_at: now };
    await db.prepare(`INSERT INTO source_admission_decision (${decisionKeys.join(",")}) VALUES (${decisionKeys.map((_, i) => `?${i + 1}`).join(",")})`).bind(...decisionKeys.map((key) => clonedDecision[key] ?? null)).run();
    const clonedItem = { ...item, item_key: itemKey, source_revision_ref: revisionRef, projection_generation: generationRef };
    await searchDb.prepare(`INSERT INTO projection_item (${Object.keys(clonedItem).join(",")}) VALUES (${Object.keys(clonedItem).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedItem)).run();
    const clonedSpan = { ...span, item_key: itemKey, source_revision_ref: revisionRef, projection_generation: generationRef };
    await searchDb.prepare(`INSERT INTO projection_span (${Object.keys(clonedSpan).join(",")}) VALUES (${Object.keys(clonedSpan).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedSpan)).run();
    const digest = await projectionDigest([{ item_key: itemKey, canonical_section_id: item.canonical_section_id, content_sha256: item.content_sha256, start: span.normalized_start_byte, end: span.normalized_end_byte }]);
    const clonedGeneration = { ...generation, source_revision_ref: revisionRef, projection_generation: generationRef, item_set_digest: digest, readback_digest: digest };
    await searchDb.prepare(`INSERT INTO projection_generation_receipt (${Object.keys(clonedGeneration).join(",")}) VALUES (${Object.keys(clonedGeneration).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedGeneration)).run();
    const clonedGuard = { ...guard, source_revision_ref: revisionRef, projection_generation: generationRef, readback_digest: digest };
    await searchDb.prepare(`INSERT INTO projection_activation_guard (${Object.keys(clonedGuard).join(",")}) VALUES (${Object.keys(clonedGuard).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedGuard)).run();
    revisionRefs.push(revisionRef);
  }
  return revisionRefs;
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

    const boundJob = await runtime.CORE_DB.prepare(
      "SELECT job_id,scope_snapshot_id,scope_snapshot_revision FROM retrieval_exhaustive_job WHERE idempotency_key=?1 LIMIT 1",
    ).bind("exhaustive-http-first").first<{ readonly job_id: string; readonly scope_snapshot_id: string; readonly scope_snapshot_revision: number }>();
    if (boundJob === null) throw new Error("missing completed exhaustive job");
    await runtime.CORE_DB.prepare(
      "UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason=?2 WHERE snapshot_id=?3 AND revision=?4",
    ).bind(new Date().toISOString(), "test-revocation", boundJob.scope_snapshot_id, boundJob.scope_snapshot_revision).run();
    const revokedRead = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/${body.data?.workflow_instance_id}`, { method: "GET" }),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
    expect(revokedRead.status).toBe(200);
    const revokedBody = await revokedRead.json() as { readonly data?: { readonly workflow_status?: string; readonly job?: unknown } };
    expect(revokedBody.data?.workflow_status).toBe("complete");
    expect(revokedBody.data?.job).toBeUndefined();
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

  it("freezes and launches across the second 64-source authority batch", async () => {
    const owner = "exhaustive-65-source-owner";
    const value = await world(owner);
    await addAdmittedProjectedSources(value, 64);
    const directRequest = queryRequest(value, "exhaustive-direct-65", "Pinned", { kind: "GLOBAL_LIBRARY" });
    const direct = await createExhaustiveQueryService(runtime).query({
      request: directRequest,
      principal_ref: owner,
      client_class: "owner_pwa",
      credential_generation: "credential-1",
      trace_id: "exhaustive-65-direct",
    }, await directRequest.clone().json());
    expect(["COMPLETE", "UNFINISHED"]).toContain(direct.job.status);
    const frozen = await runtime.CORE_DB.prepare(
      "SELECT s.member_source_revision_refs_json FROM retrieval_exhaustive_job j JOIN scope_snapshot s ON s.snapshot_id=j.scope_snapshot_id AND s.revision=j.scope_snapshot_revision WHERE j.idempotency_key=?1 LIMIT 1",
    ).bind("exhaustive-direct-65").first<{ readonly member_source_revision_refs_json: string }>();
    expect(frozen).not.toBeNull();
    expect(JSON.parse(frozen?.member_source_revision_refs_json ?? "[]")).toHaveLength(65);

    const staleRef = `revision-${value.namespace}-q8-64`;
    await runtime.CORE_DB.prepare(
      "UPDATE source_revision SET source_owner_generation='owner-generation-stale' WHERE source_revision_ref=?1",
    ).bind(staleRef).run();
    const staleRequest = queryRequest(value, "exhaustive-direct-65-stale", "Pinned", { kind: "GLOBAL_LIBRARY" });
    await expect(createExhaustiveQueryService(runtime).query({
      request: staleRequest,
      principal_ref: owner,
      client_class: "owner_pwa",
      credential_generation: "credential-1",
      trace_id: "exhaustive-65-stale",
    }, await staleRequest.clone().json())).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
    await runtime.CORE_DB.prepare(
      "UPDATE source_revision SET source_owner_generation='owner-generation-1' WHERE source_revision_ref=?1",
    ).bind(staleRef).run();
    const global = queryRequest(value, "exhaustive-http-65", "Pinned", { kind: "GLOBAL_LIBRARY" });
    const response = await handleHttp(global, runtime, {} as ExecutionContext, access(owner));
    expect([200, 202]).toContain(response.status);
    expect(await response.json()).toMatchObject({ data: { protocol: "eliotr.exhaustive-query.v1" } });
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

    const workflowControl = await introspectWorkflow(runtime.RESEARCH_WORKFLOW);
    await workflowControl.modifyAll(async (modifier) => {
      await modifier.forceStepTimeout({ name: "q8-exhaustive-job" });
    });
    try {
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
      expect(binding?.state).toBe("CANCEL_REQUESTED");
      expect(await canceled.json()).toMatchObject({ data: {
        protocol: "eliotr.exhaustive-query.v1",
        workflow_instance_id: cancelId,
        workflow_status: "terminated",
      } });
      const reread = await handleHttp(
        new Request(`https://research.example/api/v1/research/query/${cancelId}`, { method: "GET" }),
        runtime,
        {} as ExecutionContext,
        access(owner),
      );
      expect(await reread.json()).toMatchObject({ data: { workflow_status: "terminated" } });
      const resumed = await handleHttp(queryRequest(value, "exhaustive-workflow-cancel"), runtime, {} as ExecutionContext, access(owner));
      expect(resumed.status).toBe(409);
      expect(await resumed.json()).toMatchObject({ code: "RESEARCH_CANCELLED" });
    } finally {
      await workflowControl.dispose();
    }
  });
});
