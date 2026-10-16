import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/composition-root.js";
import { handleHttp } from "../src/http.js";
import type { Env } from "../src/env.js";
import { prepareQ1Namespace, type Q1Runtime } from "./retrieval-q1-fixture.js";
import { canonicalDigest } from '@eliotr/platform-cloudflare';

const runtime = env as unknown as Q1Runtime & Env;
const ownerAccess = (principal: string) => ({ accessVerifier: { async verify() {
  return { principal_ref: principal, credential_generation: "credential-raw-admission-1", authentication_method: "cloudflare_access" as const, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
} } });
async function sha(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function captureRequest(bytes: Uint8Array, digest: string, key: string): Request {
  return new Request("https://research.example/api/v1/ingest/raw", { method: "POST", headers: {
    "content-type": "application/pdf", "content-length": String(bytes.byteLength), "idempotency-key": key,
    "x-eliotr-original-file-name": `${key}.pdf`, "x-eliotr-content-sha256": digest,
  }, body: bytes.buffer as ArrayBuffer });
}
function admissionRequest(captureId: string, idempotencyKey: string, conversionOperationId: string, signal?: AbortSignal): Request {
  return new Request(`https://research.example/api/v1/ingest/raw/${captureId}/admission`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: idempotencyKey, conversion_operation_id: conversionOperationId }),
    ...(signal === undefined ? {} : { signal }),
  });
}
function sourceIdentityRequest(captureId: string, admissionOperationId: string): Request {
  return new Request(`https://research.example/api/v1/ingest/raw/${captureId}/admission/${admissionOperationId}/source-identity`);
}
async function seedCompleteConversion(db: D1Database, bucket: R2Bucket, captureId: string, principal: string, contentSha: string, sizeBytes: number, operationId: string, output: Uint8Array): Promise<void> {
  const outputSha = await sha(output);
  const result = { protocol: "eliotr.raw-markdown-conversion.v1", state: "COMPLETE", operation_id: operationId, capture_id: captureId, content_sha256: contentSha, output_sha256: outputSha, output_bytes: output.byteLength, detected_mime: "text/markdown", format: "markdown", tokens: 3 };
  const resultJson = JSON.stringify(result);
  const outputKey = `raw-markdown/${operationId}/output.md`;
  const requestJson = JSON.stringify({ idempotency_key: `raw-markdown-${operationId}`,
    max_output_bytes: 8 * 1024 * 1024, max_tokens: 4096, timeout_ms: 120000 });
  await bucket.put(outputKey, output);
  await db.prepare("INSERT INTO raw_markdown_conversion(operation_id,principal_ref,capture_id,content_sha256,size_bytes,request_sha256,request_json,authority_sha256,attempt_id,state,result_json,result_sha256,output_object_key,receipt_object_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'COMPLETE',?10,?11,?12,?13,?14,?14)")
    .bind(operationId, principal, captureId, contentSha, sizeBytes, await sha(new TextEncoder().encode(requestJson)), requestJson, "2".repeat(64), `attempt-${operationId}`, resultJson, await sha(new TextEncoder().encode(resultJson)), outputKey, `raw-markdown/${operationId}/receipt.json`, new Date().toISOString()).run();
}

describe("raw normalized admission actual Worker path", () => {
  const principal = `raw-admission-owner-${crypto.randomUUID()}`;
  beforeAll(async () => {
    // The namespace fixture applies both complete migration streams. Prepare
    // its authority separately from the timed actual Worker mutation cases.
    const namespace = await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, principal);
    await runtime.CORE_DB.prepare("UPDATE source_admission_policy SET minimum_quality_state='degraded' WHERE source_namespace_id=?1").bind(namespace.namespace).run();
  });
  it("reuses an exact committed source for a new conversion and reconciles an unbound UNKNOWN without another ingest", async () => {
    const bytes = new TextEncoder().encode('%PDF duplicate-source reuse fixture');
    const contentSha = await sha(bytes), normalized = new TextEncoder().encode('# Exact reusable output\n');
    const response = await handleHttp(captureRequest(bytes, contentSha, 'reuse-capture'), runtime, {} as ExecutionContext, ownerAccess(principal));
    expect(response.status).toBe(200);
    const capture = (await response.json() as { data: { capture_id: string } }).data;
    const factory = () => createApplication({ env: runtime, executionContext: {} as ExecutionContext });
    const access = { ...ownerAccess(principal), applicationFactory: factory };
    const post = (key: string, conversion: string) => handleHttp(admissionRequest(capture.capture_id, key, conversion), runtime, {} as ExecutionContext, access);
    const originalConversion = '4'.repeat(64), nextConversion = '5'.repeat(64), unknownConversion = '6'.repeat(64);
    for (const conversion of [originalConversion, nextConversion, unknownConversion]) {
      await seedCompleteConversion(runtime.CORE_DB, runtime.EVIDENCE_BUCKET, capture.capture_id, principal, contentSha, bytes.byteLength, conversion, normalized);
    }
    const first = await post('reuse-original', originalConversion);
    expect(first.status).toBe(200);
    const original = (await first.json() as { data: { admission_operation_id: string; source_revision_ref: string; admission_receipt: unknown } }).data;
    const canonical = () => runtime.CORE_DB.prepare('SELECT operation_id,manifest_sha256,bundle_receipt_json,bundle_receipt_sha256,updated_at FROM bundle_ingest_operation WHERE source_revision_ref=?1')
      .bind(original.source_revision_ref).all();
    const before = (await canonical()).results;
    expect(before).toHaveLength(1);
    const reused = await post('reuse-next', nextConversion);
    expect(reused.status, await reused.clone().text()).toBe(200);
    const reusedData = (await reused.json() as { data: { admission_operation_id: string; admission_receipt: unknown } }).data;
    expect(reusedData).toMatchObject({ state: 'COMMITTED', conversion_operation_id: nextConversion, admission_receipt: original.admission_receipt });
    expect(reusedData.admission_operation_id).not.toBe(original.admission_operation_id);
    const sourceIdentity = await handleHttp(sourceIdentityRequest(capture.capture_id, reusedData.admission_operation_id), runtime, {} as ExecutionContext, access);
    expect(sourceIdentity.status).toBe(200);
    expect(await sourceIdentity.json()).toMatchObject({ data: { source_revision_ref: original.source_revision_ref } });

    // Reproduce the live ledger after bundle prepare hit the unique SourceRevision fence.
    const prior = await runtime.CORE_DB.prepare('SELECT source_view_ref,policy_snapshot_sha256 FROM raw_normalized_admission WHERE admission_operation_id=?1')
      .bind(original.admission_operation_id).first<{ source_view_ref: string; policy_snapshot_sha256: string }>();
    if (prior === null) throw new Error('Missing original source witness');
    const unknownId = await canonicalDigest(['eliotr.raw-normalized-admission.v1', principal, 'reuse-unknown']);
    const candidate = 'raw-normalized-candidate:' + await canonicalDigest(['eliotr.raw-normalized-candidate.v1', capture.capture_id,
      unknownConversion, prior.source_view_ref, await sha(normalized)]);
    const fingerprint = await canonicalDigest([candidate, prior.source_view_ref, prior.policy_snapshot_sha256, contentSha, unknownConversion]);
    await runtime.CORE_DB.prepare(`INSERT INTO raw_normalized_admission SELECT ?1,principal_ref,capture_id,?2,?3,?4,?5,
      source_revision_ref,source_view_ref,snapshot_view_json,snapshot_view_sha256,policy_snapshot_json,policy_snapshot_sha256,
      policy_revision,NULL,'UNKNOWN','["ADMISSION_OUTCOME_UNKNOWN"]',NULL,created_at,updated_at,expires_at
      FROM raw_normalized_admission WHERE admission_operation_id=?6`)
      .bind(unknownId, unknownConversion, 'reuse-unknown', fingerprint, candidate, original.admission_operation_id).run();
    const read = () => handleHttp(new Request(`https://research.example/api/v1/ingest/raw/${capture.capture_id}/admission/${unknownId}`), runtime, {} as ExecutionContext, access);
    const reconciled = await read();
    expect(reconciled.status, await reconciled.clone().text()).toBe(200);
    expect(await reconciled.json()).toMatchObject({ data: { state: 'COMMITTED', conversion_operation_id: unknownConversion,
      admission_receipt: original.admission_receipt } });
    const replay = await read();
    expect(replay.status).toBe(200);
    expect((await canonical()).results).toEqual(before);
    const linked = await runtime.CORE_DB.prepare('SELECT admission_operation_id,ingest_operation_id,state FROM raw_normalized_admission WHERE capture_id=?1 ORDER BY created_at')
      .bind(capture.capture_id).all<{ admission_operation_id: string; ingest_operation_id: string | null; state: string }>();
    expect(linked.results).toHaveLength(3);
    expect(linked.results.filter(row => row.ingest_operation_id !== null)).toHaveLength(1);
    expect(linked.results.every(row => row.state === 'COMMITTED')).toBe(true);

    const differentConversion = '7'.repeat(64);
    await seedCompleteConversion(runtime.CORE_DB, runtime.EVIDENCE_BUCKET, capture.capture_id, principal, contentSha, bytes.byteLength,
      differentConversion, new TextEncoder().encode('# Different normalization\n'));
    expect((await post('reuse-different-output', differentConversion)).status).toBe(409);
    const foreign = await handleHttp(new Request(`https://research.example/api/v1/ingest/raw/${capture.capture_id}/admission/${unknownId}`),
      runtime, {} as ExecutionContext, { ...ownerAccess(principal + '-foreign'), applicationFactory: factory });
    expect(foreign.status).toBe(404);
    expect((await canonical()).results).toEqual(before);
    const policy = await runtime.CORE_DB.prepare(`SELECT p.source_namespace_id,p.revision,p.allowed_use_json
      FROM source_admission_policy p JOIN bundle_ingest_operation b ON b.source_namespace_id=p.source_namespace_id
      AND b.policy_revision=p.revision WHERE b.source_revision_ref=?1`).bind(original.source_revision_ref)
      .first<{ source_namespace_id: string; revision: number; allowed_use_json: string }>();
    if (policy === null) throw new Error('Missing current admission policy');
    try {
      await runtime.CORE_DB.prepare('UPDATE source_admission_policy SET allowed_use_json=?1 WHERE source_namespace_id=?2 AND revision=?3')
        .bind('["catalog_only"]', policy.source_namespace_id, policy.revision).run();
      expect((await read()).status).toBe(409);
    } finally {
      await runtime.CORE_DB.prepare('UPDATE source_admission_policy SET allowed_use_json=?1 WHERE source_namespace_id=?2 AND revision=?3')
        .bind(policy.allowed_use_json, policy.source_namespace_id, policy.revision).run();
    }
    await runtime.CORE_DB.prepare("UPDATE source_revision SET purge_state='QUARANTINED' WHERE source_revision_ref=?1")
      .bind(original.source_revision_ref).run();
    expect((await read()).status).toBe(403);
    const purgedIdentity = await handleHttp(sourceIdentityRequest(capture.capture_id, unknownId), runtime, {} as ExecutionContext, access);
    expect(purgedIdentity.status).toBe(403);
    expect((await canonical()).results).toEqual(before);
  }, 30_000);
  it("reads one durable COMPLETE candidate, commits through D1/R2, replays, and fails closed on witness deletion", async () => {
    const sourceBytes = new TextEncoder().encode("%PDF source bytes are not the normalized output");
    const sourceSha = await sha(sourceBytes);
    const captureResponse = await handleHttp(captureRequest(sourceBytes, sourceSha, "raw-admission-capture-1"), runtime, {} as ExecutionContext, ownerAccess(principal));
    expect(captureResponse.status).toBe(200);
    const capture = (await captureResponse.json() as { data: { capture_id: string } }).data;
    const conversionId = "a".repeat(64);
    const normalizedBytes = new TextEncoder().encode("# Durable candidate\n");
    await seedCompleteConversion(runtime.CORE_DB, runtime.EVIDENCE_BUCKET, capture.capture_id, principal, sourceSha, sourceBytes.byteLength, conversionId, normalizedBytes);
    const factory = () => createApplication({ env: runtime, executionContext: {} as ExecutionContext });
    const first = await handleHttp(admissionRequest(capture.capture_id, "raw-admission-key-1", conversionId), runtime, {} as ExecutionContext, { ...ownerAccess(principal), applicationFactory: factory });
    expect(first.status).toBe(200);
    const firstData = (await first.json() as { data: { admission_operation_id: string; state: string; status?: { state: string } } }).data;
    expect(firstData.state).toBe("COMMITTED");
    expect(firstData.status?.state).toBe("COMMITTED");
    expect(firstData).not.toHaveProperty("source_id");
    const firstLedger = await runtime.CORE_DB.prepare(
      "SELECT reason_codes_json,receipt_json FROM raw_normalized_admission WHERE admission_operation_id=?1 LIMIT 1",
    ).bind(firstData.admission_operation_id).first<{ readonly reason_codes_json: string; readonly receipt_json: string }>();
    expect(firstLedger).not.toBeNull();
    if (firstLedger === null) return;
    expect(JSON.parse(firstLedger.reason_codes_json)).toEqual(JSON.parse(firstLedger.receipt_json).reason_codes);
    const replay = await handleHttp(admissionRequest(capture.capture_id, "raw-admission-key-1", conversionId), runtime, {} as ExecutionContext, { ...ownerAccess(principal), applicationFactory: factory });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { data: { admission_operation_id: string } }).data.admission_operation_id).toBe(firstData.admission_operation_id);
    const expectedSource = await runtime.CORE_DB.prepare("SELECT source_logical_id,source_revision_ref FROM raw_file_capture WHERE capture_id=?1 LIMIT 1")
      .bind(capture.capture_id).first<{ source_logical_id: string; source_revision_ref: string }>();
    const identityResponse = await handleHttp(sourceIdentityRequest(capture.capture_id, firstData.admission_operation_id), runtime, {} as ExecutionContext, { ...ownerAccess(principal), applicationFactory: factory });
    expect(identityResponse.status).toBe(200);
    expect(await identityResponse.json()).toMatchObject({ data: {
      protocol: "eliotr.raw-source-identity.v1", admission_operation_id: firstData.admission_operation_id,
      capture_id: capture.capture_id, source_id: expectedSource?.source_logical_id,
      source_revision_ref: expectedSource?.source_revision_ref,
    } });
    const foreignIdentity = await handleHttp(sourceIdentityRequest(capture.capture_id, firstData.admission_operation_id), runtime, {} as ExecutionContext, { ...ownerAccess(`${principal}-foreign`), applicationFactory: factory });
    expect(foreignIdentity.status).toBe(404);
    const conflict = await handleHttp(admissionRequest(capture.capture_id, "raw-admission-key-1", "b".repeat(64)), runtime, {} as ExecutionContext, { ...ownerAccess(principal), applicationFactory: factory });
    expect(conflict.status).toBe(409);

    const secondBytes = new TextEncoder().encode("%PDF second source");
    const secondSha = await sha(secondBytes);
    const secondCaptureResponse = await handleHttp(captureRequest(secondBytes, secondSha, "raw-admission-capture-2"), runtime, {} as ExecutionContext, ownerAccess(principal));
    const secondCapture = (await secondCaptureResponse.json() as { data: { capture_id: string } }).data;
    const secondConversionId = "c".repeat(64);
    await seedCompleteConversion(runtime.CORE_DB, runtime.EVIDENCE_BUCKET, secondCapture.capture_id, principal, secondSha, secondBytes.byteLength, secondConversionId, new TextEncoder().encode("# Witness deletion\n"));
    const triggerName = `test_delete_raw_witness_${crypto.randomUUID().replaceAll("-", "")}`;
    await runtime.CORE_DB.prepare(`CREATE TRIGGER ${triggerName} AFTER UPDATE OF state ON bundle_ingest_operation WHEN NEW.state='COMMITTED' BEGIN DELETE FROM raw_normalized_admission WHERE capture_id='${secondCapture.capture_id}'; END`).run();
    const deletedWitness = await handleHttp(admissionRequest(secondCapture.capture_id, "raw-admission-key-2", secondConversionId), runtime, {} as ExecutionContext, { ...ownerAccess(principal), applicationFactory: factory });
    await runtime.CORE_DB.prepare(`DROP TRIGGER ${triggerName}`).run();
    expect([409, 503]).toContain(deletedWitness.status);
    expect((await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM source_revision WHERE source_revision_ref=(SELECT source_revision_ref FROM raw_file_capture WHERE capture_id=?1)").bind(secondCapture.capture_id).first<{ count: number }>())?.count).toBe(0);
    // The trigger runs inside the guarded D1 batch. A failed CHECK on the guard
    // rolls the delete back, while the source revision and terminal receipt stay
    // absent. The service records recoverable UNKNOWN after the uncertain batch;
    // this proves the reserved witness cannot be deleted at commit time and that
    // the transaction fails closed rather than accepting a generic row.
    const witnessAfterRollback = await runtime.CORE_DB.prepare("SELECT state, receipt_json FROM raw_normalized_admission WHERE capture_id=?1").bind(secondCapture.capture_id).first<{ state: string; receipt_json: string | null }>();
    expect(witnessAfterRollback?.state).toBe("UNKNOWN");
    expect(witnessAfterRollback?.receipt_json).toBeNull();

    const thirdBytes = new TextEncoder().encode("%PDF third source");
    const thirdSha = await sha(thirdBytes);
    const thirdCaptureResponse = await handleHttp(captureRequest(thirdBytes, thirdSha, "raw-admission-capture-3"), runtime, {} as ExecutionContext, ownerAccess(principal));
    const thirdCapture = (await thirdCaptureResponse.json() as { data: { capture_id: string } }).data;
    const thirdConversionId = "d".repeat(64);
    await seedCompleteConversion(runtime.CORE_DB, runtime.EVIDENCE_BUCKET, thirdCapture.capture_id, principal, thirdSha, thirdBytes.byteLength, thirdConversionId, new TextEncoder().encode("# Witness mutation\n"));
    const mutationTriggerName = `test_mutate_raw_witness_${crypto.randomUUID().replaceAll("-", "")}`;
    const mutatedDigest = "f".repeat(64);
    await runtime.CORE_DB.prepare(`CREATE TRIGGER ${mutationTriggerName} AFTER UPDATE OF state ON bundle_ingest_operation WHEN NEW.state='COMMITTED' BEGIN UPDATE raw_normalized_admission SET snapshot_view_json=json_set(snapshot_view_json,'$.observation_freshness','unknown'), snapshot_view_sha256='${mutatedDigest}' WHERE ingest_operation_id=NEW.operation_id; END`).run();
    const mutatedWitness = await handleHttp(admissionRequest(thirdCapture.capture_id, "raw-admission-key-3", thirdConversionId), runtime, {} as ExecutionContext, { ...ownerAccess(principal), applicationFactory: factory });
    await runtime.CORE_DB.prepare(`DROP TRIGGER ${mutationTriggerName}`).run();
    expect([409, 503]).toContain(mutatedWitness.status);
    expect((await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM source_revision WHERE source_revision_ref=(SELECT source_revision_ref FROM raw_file_capture WHERE capture_id=?1)").bind(thirdCapture.capture_id).first<{ count: number }>())?.count).toBe(0);
    const witnessAfterMutationRollback = await runtime.CORE_DB.prepare("SELECT state, receipt_json, snapshot_view_json, snapshot_view_sha256 FROM raw_normalized_admission WHERE capture_id=?1").bind(thirdCapture.capture_id).first<{ state: string; receipt_json: string | null; snapshot_view_json: string; snapshot_view_sha256: string }>();
    expect(witnessAfterMutationRollback?.state).toBe("UNKNOWN");
    expect(witnessAfterMutationRollback?.receipt_json).toBeNull();
    expect(JSON.parse(witnessAfterMutationRollback?.snapshot_view_json ?? "{}").observation_freshness).toBe("observed_with_age");
    expect(witnessAfterMutationRollback?.snapshot_view_sha256).not.toBe(mutatedDigest);
    const recovered = await handleHttp(admissionRequest(thirdCapture.capture_id, "raw-admission-key-3", thirdConversionId), runtime, {} as ExecutionContext, { ...ownerAccess(principal), applicationFactory: factory });
    expect(recovered.status).toBe(200);
    expect((await recovered.json() as { data: { state: string } }).data.state).toBe("COMMITTED");
  });
});
