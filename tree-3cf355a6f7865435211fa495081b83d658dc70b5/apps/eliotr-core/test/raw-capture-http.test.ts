import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleHttp } from "../src/http.js";
import { prepareQ1Namespace, type Q1Runtime } from "./retrieval-q1-fixture.js";

const runtime = env as unknown as Q1Runtime & Env;

function access(principal: string) {
  return { accessVerifier: { async verify() {
    return {
      principal_ref: principal,
      credential_generation: "credential-raw-1",
      authentication_method: "cloudflare_access" as const,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
  } } };
}

async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function request(
  bytes: Uint8Array,
  idempotencyKey: string,
  filename: string,
  contentSha256: string,
): Request {
  return new Request("https://research.example/api/v1/ingest/raw", {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(bytes.byteLength),
      "idempotency-key": idempotencyKey,
      "x-eliotr-original-file-name": encodeURIComponent(filename),
      "x-eliotr-content-sha256": contentSha256,
    },
    body: bytes.buffer as ArrayBuffer,
  });
}

function readRequest(captureId: string): Request {
  return new Request(`https://research.example/api/v1/ingest/raw/${captureId}`);
}

function readByKeyRequest(idempotencyKey: string): Request {
  return new Request("https://research.example/api/v1/ingest/raw", {
    headers: { "idempotency-key": idempotencyKey },
  });
}

describe("owner raw capture HTTP boundary", () => {
  it("captures through actual Worker D1/R2 and reads back by server capture identity", async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    const owner = `raw-owner-${crypto.randomUUID()}`;
    await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, owner);
    const bytes = new TextEncoder().encode("raw transport bytes\n");
    const sha256 = await digest(bytes);
    const first = await handleHttp(request(bytes, "raw-http-1", "исследование note.pdf", sha256), runtime, {} as ExecutionContext, access(owner));
    expect(first.status).toBe(200);
    const firstEnvelope = await first.json() as { readonly data: {
      readonly protocol: string; readonly capture_id: string; readonly original_file_name: string;
      readonly content_sha256: string; readonly size_bytes: number;
    } };
    expect(firstEnvelope.data).toMatchObject({
      protocol: "eliotr.raw-file-capture.v1", original_file_name: "исследование note.pdf",
      content_sha256: sha256, size_bytes: bytes.byteLength,
    });
    const row = await runtime.CORE_DB.prepare(
      "SELECT object_key,state,receipt_json FROM raw_file_capture WHERE capture_id=?1 LIMIT 1",
    ).bind(firstEnvelope.data.capture_id).first<{ readonly object_key: string; readonly state: string; readonly receipt_json: string }>();
    expect(row?.state).toBe("CAPTURED");
    expect(row?.receipt_json).toContain("исследование note.pdf");
    const object = row === null || row === undefined ? null : await runtime.EVIDENCE_BUCKET.get(row.object_key);
    expect(object).not.toBeNull();
    expect(object === null ? null : new Uint8Array(await object.arrayBuffer())).toEqual(bytes);

    const readback = await handleHttp(readRequest(firstEnvelope.data.capture_id), runtime, {} as ExecutionContext, access(owner));
    expect(readback.status).toBe(200);
    expect((await readback.json() as { readonly data: unknown }).data).toEqual(firstEnvelope.data);
    const idempotencyReadback = await handleHttp(readByKeyRequest("raw-http-1"), runtime, {} as ExecutionContext, access(owner));
    expect(idempotencyReadback.status).toBe(200);
    expect((await idempotencyReadback.json() as { readonly data: unknown }).data).toEqual(firstEnvelope.data);

    const replay = await handleHttp(request(bytes, "raw-http-1", "исследование note.pdf", sha256), runtime, {} as ExecutionContext, access(owner));
    expect(replay.status).toBe(200);
    expect((await replay.json() as { readonly data: { readonly capture_id: string } }).data.capture_id)
      .toBe(firstEnvelope.data.capture_id);

    const changed = new TextEncoder().encode("changed bytes\n");
    const changedResponse = await handleHttp(request(changed, "raw-http-1", "исследование note.pdf", await digest(changed)), runtime, {} as ExecutionContext, access(owner));
    expect(changedResponse.status).toBe(409);

    const foreignRead = await handleHttp(readRequest(firstEnvelope.data.capture_id), runtime, {} as ExecutionContext, access(`foreign-${crypto.randomUUID()}`));
    expect(foreignRead.status).toBe(404);
  });

  it("fails closed on owner withdrawal during capture readback", async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    const owner = `raw-withdraw-${crypto.randomUUID()}`;
    const world = await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, owner);
    const bytes = new TextEncoder().encode("withdrawal boundary\n");
    const sha256 = await digest(bytes);
    const captured = await handleHttp(request(bytes, "raw-withdraw-1", "withdrawn.txt", sha256), runtime, {} as ExecutionContext, access(owner));
    expect(captured.status).toBe(200);
    await runtime.CORE_DB.prepare(
      "UPDATE source_namespace_ownership SET status='FENCED' WHERE source_namespace_id=?1",
    ).bind(world.namespace).run();
    const denied = await handleHttp(readRequest((await captured.clone().json() as { readonly data: { readonly capture_id: string } }).data.capture_id), runtime, {} as ExecutionContext, access(owner));
    expect(denied.status).toBe(403);
  });

  it("does not treat a policy without immutable_import as raw capture authority", async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    const owner = `raw-policy-${crypto.randomUUID()}`;
    const world = await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, owner);
    await runtime.CORE_DB.prepare(
      "UPDATE source_admission_policy SET allowed_ownership_modes_json=?1 WHERE source_namespace_id=?2 AND revision=1",
    ).bind('["federated_reference"]', world.namespace).run();
    const bytes = new TextEncoder().encode("policy boundary\n");
    const response = await handleHttp(request(bytes, "raw-policy-1", "policy.txt", await digest(bytes)), runtime, {} as ExecutionContext, access(owner));
    expect(response.status).toBe(403);
  });
});
