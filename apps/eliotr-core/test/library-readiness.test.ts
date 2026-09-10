import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { LibraryReadinessSchema } from "@eliotr/contracts";
import { createApplication } from "../src/composition-root.js";
import { handleHttp } from "../src/http.js";
import { readLibraryReadiness } from "../src/library-readiness.js";
import type { Env } from "../src/env.js";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";

const runtime = env as unknown as Q1Runtime & Env;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;
let world: Q1Namespace;

beforeEach(async () => {
  const owner = `readiness-owner-${crypto.randomUUID()}`;
  world = { db, searchDb, runtime, owner, ...(await prepareQ1Namespace(runtime, db, searchDb, owner)) };
  await importAndProject(world);
  await db.prepare("INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation,allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,'owner_pwa',?3,1,'[\"research\"]','owner-only','ACTIVE',?4,?5)")
    .bind(world.namespace, owner, `readiness-${world.namespace}`, new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString()).run();
});

function context(): Parameters<typeof readLibraryReadiness>[2] {
  return {
    request: new Request("https://research.example/api/v1/library/readiness"),
    principal_ref: world.owner,
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    trace_id: "readiness-test",
  };
}

function sourceId(): string {
  return `source-${world.namespace}`;
}

async function sha(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function access(principal: string) {
  return { accessVerifier: { async verify() {
    return { principal_ref: principal, credential_generation: "credential-1", authentication_method: "cloudflare_access" as const, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  } } };
}

function captureRequest(bytes: Uint8Array, digest: string): Request {
  return new Request("https://research.example/api/v1/ingest/raw", { method: "POST", headers: {
    "content-type": "application/pdf", "content-length": String(bytes.byteLength), "idempotency-key": "readiness-raw-capture",
    "x-eliotr-original-file-name": "readiness-raw.pdf", "x-eliotr-content-sha256": digest,
  }, body: bytes.buffer as ArrayBuffer });
}

function admissionRequest(captureId: string, conversionId: string): Request {
  return new Request(`https://research.example/api/v1/ingest/raw/${captureId}/admission`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotency_key: "readiness-raw-admission", conversion_operation_id: conversionId }),
  });
}

async function seedCompleteConversion(
  captureId: string,
  principal: string,
  contentSha: string,
  sizeBytes: number,
  operationId: string,
  output: Uint8Array,
): Promise<void> {
  const outputSha = await sha(output);
  const result = { protocol: "eliotr.raw-markdown-conversion.v1", state: "COMPLETE", operation_id: operationId, capture_id: captureId,
    content_sha256: contentSha, output_sha256: outputSha, output_bytes: output.byteLength, detected_mime: "text/markdown", format: "markdown", tokens: 3 };
  const resultJson = JSON.stringify(result);
  const outputKey = `raw-markdown/${operationId}/output.md`;
  await runtime.EVIDENCE_BUCKET.put(outputKey, output);
  await db.prepare("INSERT INTO raw_markdown_conversion(operation_id,principal_ref,capture_id,content_sha256,size_bytes,request_sha256,request_json,authority_sha256,attempt_id,state,result_json,result_sha256,output_object_key,receipt_object_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'COMPLETE',?10,?11,?12,?13,?14,?14)")
    .bind(operationId, principal, captureId, contentSha, sizeBytes, "1".repeat(64), "{}", "2".repeat(64), `attempt-${operationId}`, resultJson, await sha(new TextEncoder().encode(resultJson)), outputKey, `raw-markdown/${operationId}/receipt.json`, new Date().toISOString()).run();
}

describe("owner active Library readiness", () => {
  it("reports independently verified exact and lexical channels through HTTP", async () => {
    const response = await handleHttp(
      new Request(`https://research.example/api/v1/library/readiness?source_id=${encodeURIComponent(sourceId())}`),
      runtime,
      {} as ExecutionContext,
      { accessVerifier: { async verify() {
        return { principal_ref: world.owner, credential_generation: "credential-1", authentication_method: "cloudflare_access", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      } } },
    );
    expect(response.status).toBe(200);
    const envelope = await response.json() as { readonly data?: unknown };
    const readiness = LibraryReadinessSchema.parse(envelope.data);
    expect(readiness.source_revision_ref).toBe(world.revision);
    expect(readiness.channels.map((channel) => [channel.channel, channel.state])).toEqual([
      ["exact_ready", "ready"], ["lexical_ready", "ready"], ["semantic_ready", "not_requested"],
    ]);
    expect(readiness.readiness_basis).toBe("ACTIVE_VERIFIED");
    expect(readiness.currentness.verification).toBe("NOT_VERIFIED");
  });

  it("keeps exact readiness when lexical projection is absent", async () => {
    await searchDb.prepare(
      "DELETE FROM projection_watermark WHERE channel='lexical' AND source_revision_ref=?1",
    ).bind(world.revision).run();
    const readiness = await readLibraryReadiness(
      db,
      searchDb,
      context(),
      { source_id: sourceId() },
      runtime.DEPLOYMENT_GENERATION,
    );
    expect(readiness.channels.find((channel) => channel.channel === "exact_ready")?.state).toBe("ready");
    expect(readiness.channels.find((channel) => channel.channel === "lexical_ready")?.state).toBe("not_requested");
  });

  it("fails closed when the current owner authority is fenced", async () => {
    await db.prepare(
      "UPDATE source_namespace_ownership SET status='FENCED' WHERE source_namespace_id=?1",
    ).bind(world.namespace).run();
    await expect(readLibraryReadiness(
      db,
      searchDb,
      context(),
      { source_id: sourceId() },
      runtime.DEPLOYMENT_GENERATION,
    )).rejects.toMatchObject({ status: 404, code: "LIBRARY_SOURCE_NOT_FOUND" });
  });

  it("preserves the observed_at from an admitted raw snapshot witness", async () => {
    await db.prepare("UPDATE source_admission_policy SET minimum_quality_state='degraded' WHERE source_namespace_id=?1").bind(world.namespace).run();
    const sourceBytes = new TextEncoder().encode("%PDF raw readiness input");
    const sourceSha = await sha(sourceBytes);
    const captureResponse = await handleHttp(captureRequest(sourceBytes, sourceSha), runtime, {} as ExecutionContext, access(world.owner));
    expect(captureResponse.status).toBe(200);
    const capture = (await captureResponse.json() as { readonly data: { readonly capture_id: string } }).data;
    const captureRow = await db.prepare("SELECT source_logical_id,source_revision_ref,receipt_json FROM raw_file_capture WHERE capture_id=?1 LIMIT 1")
      .bind(capture.capture_id).first<{ readonly source_logical_id: string; readonly source_revision_ref: string; readonly receipt_json: string }>();
    expect(captureRow).not.toBeNull();
    if (captureRow === null) return;
    const capturedAt = (JSON.parse(captureRow.receipt_json) as { readonly captured_at: string }).captured_at;
    const conversionId = "e".repeat(64);
    const output = new TextEncoder().encode("# Raw readiness normalized\n");
    await seedCompleteConversion(capture.capture_id, world.owner, sourceSha, sourceBytes.byteLength, conversionId, output);
    const admission = await handleHttp(admissionRequest(capture.capture_id, conversionId), runtime, {} as ExecutionContext, {
      ...access(world.owner), applicationFactory: () => createApplication({ env: runtime, executionContext: {} as ExecutionContext }),
    });
    expect(admission.status).toBe(200);
    expect((await admission.json() as { readonly data: { readonly state: string } }).data.state).toBe("COMMITTED");
    // The raw admission commit records a current source row separately from the
    // historical snapshot witness. Seed the durable recorded freshness to match
    // this admitted observation before exercising the readiness reader.
    await db.prepare("UPDATE source_revision SET currentness_state='observed_with_age' WHERE source_revision_ref=?1").bind(captureRow.source_revision_ref).run();
    const readiness = await handleHttp(
      new Request(`https://research.example/api/v1/library/readiness?source_id=${encodeURIComponent(captureRow.source_logical_id)}`),
      runtime,
      {} as ExecutionContext,
      access(world.owner),
    );
    expect(readiness.status).toBe(200);
    const envelope = await readiness.json() as { readonly data?: unknown };
    const value = LibraryReadinessSchema.parse(envelope.data);
    expect(value.source_revision_ref).toBe(captureRow.source_revision_ref);
    expect(value.currentness.verification).toBe("VERIFIED");
    if (value.currentness.verification === "VERIFIED") {
      expect(value.currentness.value.observed_at).toBe(capturedAt);
      expect(value.currentness.value.observation_freshness).toBe("observed_with_age");
    }
  });
});
