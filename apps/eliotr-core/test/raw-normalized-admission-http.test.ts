import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApplication } from "../src/composition-root.js";
import { handleHttp } from "../src/http.js";
import type { Env } from "../src/env.js";
import { prepareQ1Namespace, type Q1Runtime } from "./retrieval-q1-fixture.js";

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
async function seedCompleteConversion(db: D1Database, bucket: R2Bucket, captureId: string, principal: string, contentSha: string, sizeBytes: number, operationId: string, output: Uint8Array): Promise<void> {
  const outputSha = await sha(output);
  const result = { protocol: "eliotr.raw-markdown-conversion.v1", state: "COMPLETE", operation_id: operationId, capture_id: captureId, content_sha256: contentSha, output_sha256: outputSha, output_bytes: output.byteLength, detected_mime: "text/markdown", format: "markdown", tokens: 3 };
  const resultJson = JSON.stringify(result);
  const outputKey = `raw-markdown/${operationId}/output.md`;
  await bucket.put(outputKey, output);
  await db.prepare("INSERT INTO raw_markdown_conversion(operation_id,principal_ref,capture_id,content_sha256,size_bytes,request_sha256,request_json,authority_sha256,attempt_id,state,result_json,result_sha256,output_object_key,receipt_object_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'COMPLETE',?10,?11,?12,?13,?14,?14)")
    .bind(operationId, principal, captureId, contentSha, sizeBytes, "1".repeat(64), "{}", "2".repeat(64), `attempt-${operationId}`, resultJson, await sha(new TextEncoder().encode(resultJson)), outputKey, `raw-markdown/${operationId}/receipt.json`, new Date().toISOString()).run();
}

describe("raw normalized admission actual Worker path", () => {
  it("reads one durable COMPLETE candidate, commits through D1/R2, replays, and fails closed on witness deletion", async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
    const principal = `raw-admission-owner-${crypto.randomUUID()}`;
    const namespace = await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, principal);
    await runtime.CORE_DB.prepare("UPDATE source_admission_policy SET minimum_quality_state='degraded' WHERE source_namespace_id=?1").bind(namespace.namespace).run();
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
    const replay = await handleHttp(admissionRequest(capture.capture_id, "raw-admission-key-1", conversionId), runtime, {} as ExecutionContext, { ...ownerAccess(principal), applicationFactory: factory });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { data: { admission_operation_id: string } }).data.admission_operation_id).toBe(firstData.admission_operation_id);
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
