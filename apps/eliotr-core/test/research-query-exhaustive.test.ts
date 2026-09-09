import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Q1Namespace, Q1Runtime } from "./retrieval-q1-fixture.js";
import { importAndProject, prepareQ1Namespace } from "./retrieval-q1-fixture.js";
import { handleHttp } from "../src/http.js";
import { createExhaustiveQueryService } from "../src/exhaustive-query-service.js";
import { validateExhaustiveJobCurrent } from "@eliotr/cloudflare-navigation";
import { canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { canonicalDigest, canonicalNormalizedBundleKey, objectResidencyKeyDigest } from "@eliotr/platform-cloudflare";
import { projectionDigest } from "@eliotr/cloudflare-projection";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";

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

async function waitForCompletedWorkflow(owner: string, workflowId: string): Promise<void> {
  let lastStatus = "unknown";
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const response = await handleHttp(
      new Request(`https://research.example/api/v1/research/query/${workflowId}`, { method: "GET" }),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
    const body = await response.json() as { readonly data?: { readonly workflow_status?: string; readonly job?: { readonly status?: string } } };
    lastStatus = `${body.data?.workflow_status ?? "unknown"}/${body.data?.job?.status ?? "missing"}`;
    if (body.data?.workflow_status === "complete" && body.data.job?.status === "COMPLETE") return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`exhaustive Workflow did not publish its completed job within the bounded wait: ${lastStatus}`);
}

function searchDbWithInventoryWithdrawal(
  database: D1Database,
  withdraw: () => Promise<void>,
  triggerRead = 1,
): D1Database {
  let projectionReads = 0;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "bind") {
        return (...values: unknown[]) => wrap(target.bind(...values), sql);
      }
      if (property === "all") {
        return async <T = unknown>() => {
          const result = await target.all<T>();
          if (/FROM projection_item/u.test(sql) && ++projectionReads === triggerRead) {
            await withdraw();
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    prepare(sql: string) { return wrap(database.prepare(sql), sql); },
  } as unknown as D1Database;
}

function exhaustiveContext(request: Request, owner: string, trace: string): AuthenticatedRequestContext {
  return {
    request,
    principal_ref: owner,
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    trace_id: trace,
  };
}

async function expectInventoryMutationRejected(
  owner: string,
  key: string,
  mutate: (value: Q1Namespace) => Promise<void>,
  expectedCode = "RESEARCH_AUTHORITY_STALE",
): Promise<void> {
  const value = await world(owner);
  const request = queryRequest(value, key);
  const hookedSearch = searchDbWithInventoryWithdrawal(runtime.SEARCH_DB, () => mutate(value));
  const service = createExhaustiveQueryService({ CORE_DB: runtime.CORE_DB, SEARCH_DB: hookedSearch, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
  await expect(service.query(exhaustiveContext(request, owner, key), await request.clone().json())).rejects.toMatchObject({ code: expectedCode });
  const persisted = await runtime.CORE_DB.prepare(
    "SELECT state FROM retrieval_exhaustive_job WHERE idempotency_key=?1 LIMIT 1",
  ).bind(key).first<{ readonly state: string }>();
  expect(persisted?.state).not.toBe("COMPLETE");
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
  const watermarks = await searchDb.prepare("SELECT * FROM projection_watermark WHERE source_revision_ref=?1 AND channel IN ('exact','lexical')").bind(revision).all<Record<string, unknown>>();
  if (!source || !sourceRevision || !operation || !decisionRow || !item || !span || !generation || !guard || watermarks.results.length !== 2) throw new Error("missing Q1 clone fixture rows");
  const sourceManifestKey = String(sourceRevision.normalized_artifact_ref);
  const manifestObject = await runtime.EVIDENCE_BUCKET.get(sourceManifestKey);
  if (manifestObject === null) throw new Error("missing Q1 manifest object");
  const originalManifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(originalManifestBytes)) as Record<string, unknown>;
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
    const cloneManifest: Record<string, unknown> = {
      ...manifest,
      origin: {
        ...(manifest.origin as Record<string, unknown>),
        source_namespace_id: namespace,
        source_revision_ref: revisionRef,
      },
      source: {
        ...(manifest.source as Record<string, unknown>),
        logical_id: sourceId,
      },
    };
    const manifestBytes = new TextEncoder().encode(canonicalEvidenceJson(cloneManifest));
    const manifestDigest = await evidenceSha256Bytes(manifestBytes);
    const residency = cloneManifest.residency_and_disclosure as Record<string, unknown>;
    const manifestResidencyDigest = await objectResidencyKeyDigest({
      scope_domain_id: String(residency.scope_domain_id),
      access_domain_id: String(residency.access_domain_id),
      confidentiality_domain_id: String(residency.confidentiality_domain_id),
      encryption_key_domain_id: String(residency.encryption_key_domain_id),
      retention_domain_id: String(residency.retention_domain_id),
      erasure_domain_id: String(residency.erasure_domain_id),
      content_digest: { algorithm: "sha256", digest: manifestDigest },
    });
    const contentDigest = await evidenceSha256Bytes(content);
    if (contentDigest !== String(sourceRevision.content_sha256)) throw new Error("Q8 clone content digest disagrees with admitted source");
    const contentResidencyDigest = await objectResidencyKeyDigest({
      scope_domain_id: String(residency.scope_domain_id),
      access_domain_id: String(residency.access_domain_id),
      confidentiality_domain_id: String(residency.confidentiality_domain_id),
      encryption_key_domain_id: String(residency.encryption_key_domain_id),
      retention_domain_id: String(residency.retention_domain_id),
      erasure_domain_id: String(residency.erasure_domain_id),
      content_digest: { algorithm: "sha256", digest: contentDigest },
    });
    if (contentResidencyDigest !== String(sourceRevision.object_residency_key_digest)) {
      throw new Error("Q8 clone content residency disagrees with admitted source");
    }
    const manifestKey = await canonicalNormalizedBundleKey(manifestResidencyDigest, {
      owner_system_id: String(source.source_owner_system_id), source_namespace_id: namespace,
      source_owner_generation: String(sourceRevision.source_owner_generation), source_logical_id: sourceId,
      source_revision_ref: revisionRef,
    }, "manifest.json");
    const contentKey = await canonicalNormalizedBundleKey(contentResidencyDigest, {
      owner_system_id: String(source.source_owner_system_id), source_namespace_id: namespace,
      source_owner_generation: String(sourceRevision.source_owner_generation), source_logical_id: sourceId,
      source_revision_ref: revisionRef,
    }, "content.md");
    const admissionReceiptRef = receiptRef;
    const immutableMetadata = {
      source_namespace_id: namespace,
      source_owner_generation: String(sourceRevision.source_owner_generation),
      admission_receipt_ref: admissionReceiptRef,
      eliotr_sha256: manifestDigest,
      eliotr_size_bytes: String(manifestBytes.byteLength),
      eliotr_immutable: "true",
    };
    await runtime.EVIDENCE_BUCKET.put(manifestKey, manifestBytes, {
      sha256: manifestDigest,
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: immutableMetadata,
    });
    await runtime.EVIDENCE_BUCKET.put(contentKey, content, {
      sha256: contentDigest,
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { ...immutableMetadata, eliotr_sha256: contentDigest, eliotr_size_bytes: String(content.byteLength) },
    });
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
    const sourceFileHashes = JSON.parse(String(operation.file_hashes_json)) as Record<string, unknown>;
    const clonedFileHashes = { ...sourceFileHashes, "manifest.json": manifestDigest };
    const totalBytes = Number(operation.total_bytes) - originalManifestBytes.byteLength + manifestBytes.byteLength;
    const inputFingerprint = await canonicalDigest({
      principal_ref: operation.principal_ref,
      origin_authentication_receipt_ref: operation.origin_authentication_receipt_ref,
      idempotency_key: `q8-${revisionRef}`,
      manifest: cloneManifest,
      file_hashes: clonedFileHashes,
      total_bytes: totalBytes,
      residency_key: JSON.parse(String(operation.residency_key_json)),
      residency_key_digest: operation.residency_key_digest,
      expected_head_revision_ref: operation.expected_head_revision_ref,
      policy_snapshot_sha256: operation.policy_snapshot_sha256,
    });
    const clonedOperation: Record<string, unknown> = { ...operation, operation_id: operationId, idempotency_key: `q8-${revisionRef}`, input_fingerprint: inputFingerprint,
      manifest_sha256: manifestDigest, manifest_json: canonicalEvidenceJson(cloneManifest), file_hashes_json: canonicalEvidenceJson(clonedFileHashes), total_bytes: totalBytes,
      source_revision_ref: revisionRef,
      source_id: sourceId, candidate_id: candidateId, staging_session_ref: null, qualification_report_ref: null,
      decision_receipt_ref: receiptRef, promotion_receipt_ref: null, created_at: now, updated_at: now };
    await db.prepare(`INSERT INTO bundle_ingest_operation (${operationKeys.join(",")}) VALUES (${operationKeys.map((_, i) => `?${i + 1}`).join(",")})`).bind(...operationKeys.map((key) => clonedOperation[key] ?? null)).run();
    const decision = { ...JSON.parse(String(decisionRow.decision_json)), source_revision_ref: revisionRef, decision_receipt_ref: receiptRef };
    const decisionJson = canonicalEvidenceJson(decision);
    const clonedDecision: Record<string, unknown> = { ...decisionRow, decision_receipt_ref: receiptRef, operation_id: operationId, source_revision_ref: revisionRef,
      decision_json: decisionJson, decision_sha256: await evidenceSha256(decision), created_at: now };
    await db.prepare(`INSERT INTO source_admission_decision (${decisionKeys.join(",")}) VALUES (${decisionKeys.map((_, i) => `?${i + 1}`).join(",")})`).bind(...decisionKeys.map((key) => clonedDecision[key] ?? null)).run();
    const clonedItem = { ...item, item_key: itemKey, source_revision_ref: revisionRef, projection_generation: generationRef };
    await searchDb.prepare(`INSERT INTO projection_item (${Object.keys(clonedItem).join(",")}) VALUES (${Object.keys(clonedItem).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedItem)).run();
    const clonedSpan = { ...span, item_key: itemKey, source_revision_ref: revisionRef, projection_generation: generationRef };
    await searchDb.prepare(`INSERT INTO projection_span (${Object.keys(clonedSpan).join(",")}) VALUES (${Object.keys(clonedSpan).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedSpan)).run();
    const digest = await projectionDigest([{ item_key: itemKey, canonical_section_id: item.canonical_section_id, content_sha256: item.content_sha256, start: span.normalized_start_byte, end: span.normalized_end_byte }]);
    const projectionReceiptRef = `projection-receipt-${revisionRef}`;
    const clonedGeneration = { ...generation, source_revision_ref: revisionRef, projection_generation: generationRef, item_set_digest: digest, readback_digest: digest, receipt_ref: projectionReceiptRef };
    await searchDb.prepare(`INSERT INTO projection_generation_receipt (${Object.keys(clonedGeneration).join(",")}) VALUES (${Object.keys(clonedGeneration).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedGeneration)).run();
    const clonedGuard = { ...guard, source_revision_ref: revisionRef, projection_generation: generationRef, readback_digest: digest, receipt_ref: projectionReceiptRef };
    await searchDb.prepare(`INSERT INTO projection_activation_guard (${Object.keys(clonedGuard).join(",")}) VALUES (${Object.keys(clonedGuard).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedGuard)).run();
    for (const watermark of watermarks.results) {
      const clonedWatermark = { ...watermark, source_revision_ref: revisionRef, projection_generation: generationRef,
        projected_item_count: 1, state: "READY", readback_receipt_ref: projectionReceiptRef, updated_at: now };
      await searchDb.prepare(`INSERT INTO projection_watermark (${Object.keys(clonedWatermark).join(",")}) VALUES (${Object.keys(clonedWatermark).map((_, i) => `?${i + 1}`).join(",")})`).bind(...Object.values(clonedWatermark)).run();
    }
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
    const workflowId = body.data?.workflow_instance_id;
    if (workflowId === undefined) throw new Error("missing exhaustive workflow id");
    await waitForCompletedWorkflow(owner, workflowId);
    const replay = await handleHttp(queryRequest(value, "exhaustive-http-first"), runtime, {} as ExecutionContext, access(owner));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ data: {
      protocol: "eliotr.exhaustive-query.v1",
      workflow_instance_id: workflowId,
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
  }, 20_000);

  it("does not disclose a cached result when withdrawal races async inventory", async () => {
    const owner = "exhaustive-withdrawal-race-owner";
    const value = await world(owner);
    const request = queryRequest(value, "exhaustive-withdrawal-race");
    const context = exhaustiveContext(request, owner, "exhaustive-withdrawal-race");
    const service = createExhaustiveQueryService(runtime);
    const completed = await service.query(context, await request.clone().json());
    expect(completed.job.status).toBe("COMPLETE");
    const job = await runtime.CORE_DB.prepare(
      "SELECT job_id,scope_snapshot_id,scope_snapshot_revision FROM retrieval_exhaustive_job WHERE idempotency_key=?1 LIMIT 1",
    ).bind("exhaustive-withdrawal-race").first<{ readonly job_id: string; readonly scope_snapshot_id: string; readonly scope_snapshot_revision: number }>();
    if (job === null) throw new Error("missing completed withdrawal race job");
    const hookedSearch = searchDbWithInventoryWithdrawal(runtime.SEARCH_DB, async () => {
      await runtime.CORE_DB.prepare(
        "UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason=?2 WHERE snapshot_id=?3 AND revision=?4",
      ).bind(new Date().toISOString(), "test-withdrawal-during-inventory", job.scope_snapshot_id, job.scope_snapshot_revision).run();
    });
    await expect(validateExhaustiveJobCurrent({
      CORE_DB: runtime.CORE_DB,
      SEARCH_DB: hookedSearch,
      EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET,
    }, context, job.job_id)).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
    const persisted = await runtime.CORE_DB.prepare(
      "SELECT state,result_artifact_ref,coverage_receipt_ref FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
    ).bind(job.job_id).first<{ readonly state: string; readonly result_artifact_ref: string | null; readonly coverage_receipt_ref: string | null }>();
    expect(persisted).toEqual({ state: "INVALIDATED", result_artifact_ref: null, coverage_receipt_ref: null });
  }, 20_000);

  it("rejects a missing or stale canonical generation during inventory", async () => {
    await expectInventoryMutationRejected("exhaustive-missing-generation-owner", "exhaustive-missing-generation", async (value) => {
      await runtime.SEARCH_DB.prepare(
        "DELETE FROM projection_watermark WHERE channel='exact' AND source_revision_ref=?1",
      ).bind(value.revision).run();
    }, "RESEARCH_EXHAUSTIVE_NOT_READY");
    await expectInventoryMutationRejected("exhaustive-stale-generation-owner", "exhaustive-stale-generation", async (value) => {
      await runtime.SEARCH_DB.prepare(
        "UPDATE projection_watermark SET state='STALE' WHERE channel='exact' AND source_revision_ref=?1",
      ).bind(value.revision).run();
    });
  }, 20_000);

  it("rejects receipt, item-set, count, and tuple mutations after pinning", async () => {
    await expectInventoryMutationRejected("exhaustive-receipt-owner", "exhaustive-receipt", async (value) => {
      await runtime.SEARCH_DB.prepare(
        "UPDATE projection_activation_guard SET receipt_ref='forged-projection-receipt' WHERE source_revision_ref=?1",
      ).bind(value.revision).run();
    });
    await expectInventoryMutationRejected("exhaustive-item-set-owner", "exhaustive-item-set", async (value) => {
      await runtime.SEARCH_DB.prepare(
        "UPDATE projection_generation_receipt SET item_set_digest=?1 WHERE source_revision_ref=?2",
      ).bind("0".repeat(64), value.revision).run();
    });
    await expectInventoryMutationRejected("exhaustive-count-owner", "exhaustive-count", async (value) => {
      await runtime.SEARCH_DB.prepare(
        "UPDATE projection_generation_receipt SET item_count=2 WHERE source_revision_ref=?1",
      ).bind(value.revision).run();
    });
    await expectInventoryMutationRejected("exhaustive-tuple-owner", "exhaustive-tuple", async (value) => {
      await runtime.SEARCH_DB.prepare(
        "UPDATE projection_span SET projection_generation='foreign-generation' WHERE source_revision_ref=?1",
      ).bind(value.revision).run();
    });
  }, 20_000);

  it("rejects partial canonical coverage across the 65-source scope", async () => {
    const owner = "exhaustive-partial-generation-owner";
    const value = await world(owner);
    await addAdmittedProjectedSources(value, 64);
    const request = queryRequest(value, "exhaustive-partial-generation", "Pinned", { kind: "GLOBAL_LIBRARY" });
    const hookedSearch = searchDbWithInventoryWithdrawal(runtime.SEARCH_DB, async () => {
      await runtime.SEARCH_DB.prepare(
        "DELETE FROM projection_watermark WHERE channel='exact' AND source_revision_ref=?1",
      ).bind(`revision-${value.namespace}-q8-64`).run();
    });
    const service = createExhaustiveQueryService({ CORE_DB: runtime.CORE_DB, SEARCH_DB: hookedSearch, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    await expect(service.query(exhaustiveContext(request, owner, "exhaustive-partial-generation"), await request.clone().json())).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
  }, 20_000);

  it("rechecks owner withdrawal after the final pinned read", async () => {
    const owner = "exhaustive-final-fence-owner";
    const value = await world(owner);
    const request = queryRequest(value, "exhaustive-final-fence");
    const context = exhaustiveContext(request, owner, "exhaustive-final-fence");
    const hookedSearch = searchDbWithInventoryWithdrawal(runtime.SEARCH_DB, async () => {
      const pending = await runtime.CORE_DB.prepare(
        "SELECT snapshot_id,revision FROM scope_snapshot ORDER BY created_at DESC LIMIT 1",
      ).first<{ readonly snapshot_id: string; readonly revision: number }>();
      if (pending === null) throw new Error("missing final-fence scope");
      await runtime.CORE_DB.prepare(
        "UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason='test-final-fence' WHERE snapshot_id=?2 AND revision=?3",
      ).bind(new Date().toISOString(), pending.snapshot_id, pending.revision).run();
    }, 3);
    const service = createExhaustiveQueryService({ CORE_DB: runtime.CORE_DB, SEARCH_DB: hookedSearch, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    await expect(service.query(context, await request.clone().json())).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
  }, 20_000);

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
  }, 20_000);

  it("keeps a small selected scope valid with more than 64 active owner policies", async () => {
    const owner = "exhaustive-65-policy-owner";
    const value = await world(owner);
    const expiry = new Date(Date.now() + 86_400_000).toISOString();
    const statements = Array.from({ length: 64 }, (_, index) => runtime.CORE_DB.prepare(
      "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,'1',?4,?5,'ACTIVE',?6,?7)",
    ).bind(
      `q8-policy-namespace-${owner}-${index + 1}`, owner, `q8-policy-ref-${owner}-${index + 1}`,
      '["research"]', "private", expiry, new Date().toISOString(),
    ));
    await runtime.CORE_DB.batch(statements);
    const response = await handleHttp(
      queryRequest(value, "exhaustive-65-policy-selected"),
      runtime,
      {} as ExecutionContext,
      access(owner),
    );
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
  }, 20_000);

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
  }, 20_000);
});
