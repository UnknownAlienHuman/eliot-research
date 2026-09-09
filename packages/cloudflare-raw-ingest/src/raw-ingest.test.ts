import { describe, expect, it } from "vitest";
import type { ObjectResidencyKey } from "@eliotr/contracts";
import { createR2EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import { createRawCapturePort } from "./raw-ingest.js";
import { RawCaptureError, type RawCaptureInput } from "./raw-ingest-types.js";

type Row = Record<string, unknown>;
interface D1Options { readonly throwAfterCaptureUpdate?: boolean; }

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } });
}

function testDigestSink() {
  const chunks: Uint8Array[] = [];
  let resolveDigest: (value: ArrayBuffer) => void = () => undefined;
  const digestResult = new Promise<ArrayBuffer>((resolve) => { resolveDigest = resolve; });
  return {
    writable: new WritableStream<Uint8Array>({
      write(chunk) { chunks.push(chunk.slice()); },
      async close() {
        const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        resolveDigest(await crypto.subtle.digest("SHA-256", body.buffer));
      },
    }),
    digest: digestResult,
  };
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly customMetadata: Record<string, string>;
  readonly contentType: string;
}

function fakeBucket(): { readonly binding: R2Bucket; readonly objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  let sequence = 0;
  const binding = {
    async put(key: string, value: ReadableStream<Uint8Array> | string, options?: R2PutOptions) {
      if (options?.onlyIf !== undefined && objects.has(key)) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await new Response(value).arrayBuffer());
      if (options?.sha256 !== undefined && await digest(bytes) !== options.sha256) throw new Error("checksum mismatch");
      const metadata = options?.httpMetadata;
      const contentType = metadata !== undefined && "contentType" in metadata && typeof metadata.contentType === "string"
        ? metadata.contentType : "application/octet-stream";
      const stored = {
        bytes,
        etag: `etag-${++sequence}`,
        customMetadata: options?.customMetadata ?? {},
        contentType,
      };
      objects.set(key, stored);
      return { etag: stored.etag } as R2Object;
    },
    async get(key: string) {
      const stored = objects.get(key);
      if (stored === undefined) return null;
      return {
        key, size: stored.bytes.byteLength, etag: stored.etag, customMetadata: stored.customMetadata,
        httpMetadata: { contentType: stored.contentType }, body: bytesStream(stored.bytes),
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
  return { binding, objects };
}

function d1(rows: Map<string, Row>, options: D1Options = {}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("WHERE capture_id")) return rows.get(String(values[0])) as T | null ?? null;
              return [...rows.values()].find((row) => row.principal_ref === values[0] && row.idempotency_key === values[1]) as T | null ?? null;
            },
            async run<T>() {
              if (sql.startsWith("INSERT INTO raw_file_capture")) {
                const row: Row = {
                  capture_id: values[0], principal_ref: values[1], owner_system_id: values[2],
                  source_namespace_id: values[3], source_revision_ref: values[4], source_logical_id: values[5],
                  source_owner_generation: values[6], idempotency_key: values[7], request_digest: values[8],
                  residency_key_json: values[9], residency_key_digest: values[10], content_sha256: values[11],
                  size_bytes: values[12], content_type: values[13], state: "INTENT", object_key: values[14],
                  receipt_json: null, receipt_sha256: null, created_at: values[15], updated_at: values[15], expires_at: values[16],
                };
                if (rows.has(String(values[0])) || [...rows.values()].some((existing) => existing.principal_ref === values[1] && existing.idempotency_key === values[7])) {
                  throw new Error("UNIQUE constraint failed: raw_file_capture");
                }
                rows.set(String(values[0]), row);
              } else if (sql.startsWith("UPDATE raw_file_capture")) {
                const row = rows.get(String(values[0]));
                if (row?.state === "INTENT") {
                  row.state = "CAPTURED"; row.object_key = values[1]; row.receipt_json = values[2];
                  row.receipt_sha256 = values[3]; row.updated_at = values[4];
                  if (options.throwAfterCaptureUpdate) throw new Error("lost capture update acknowledgement");
                }
              }
              return { success: true, meta: { changes: 1 } } as D1Result<T>;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function residency(contentSha256: string): ObjectResidencyKey {
  return {
    scope_domain_id: "scope-a", access_domain_id: "access-a", confidentiality_domain_id: "private",
    encryption_key_domain_id: "key-a", retention_domain_id: "retention-a", erasure_domain_id: "erasure-a",
    content_digest: { algorithm: "sha256", digest: contentSha256 },
  };
}

async function fixture(): Promise<{ readonly input: RawCaptureInput; readonly bytes: Uint8Array; readonly rows: Map<string, Row>; readonly evidence: ReturnType<typeof fakeBucket>; readonly calls: { count: number } }> {
  const bytes = new TextEncoder().encode("raw source bytes\n");
  const contentSha256 = await digest(bytes);
  const rows = new Map<string, Row>();
  const evidence = fakeBucket();
  const calls = { count: 0 };
  const input: RawCaptureInput = {
    principal_ref: "principal-a", owner_system_id: "owner-a", source_namespace_id: "namespace-a",
    source_revision_ref: "revision-a", source_logical_id: "document-a", source_owner_generation: "generation-a",
    idempotency_key: "raw-a", residency_key: residency(contentSha256), content_sha256: contentSha256,
    size_bytes: bytes.byteLength, content_type: "application/pdf", body: bytesStream(bytes),
  };
  return { input, bytes, rows, evidence, calls };
}

function port(f: Awaited<ReturnType<typeof fixture>>, onCurrent?: () => Promise<void>, d1Options?: D1Options) {
  return createRawCapturePort({
    database: d1(f.rows, d1Options),
    evidence_store: createR2EvidenceObjectStore(f.evidence.binding, { createSha256Sink: testDigestSink }),
    now: () => Date.parse("2026-09-09T00:00:00.000Z"),
    assertCurrent: async () => { f.calls.count += 1; await onCurrent?.(); },
  });
}

describe("raw-file capture intent and immutable readback", () => {
  it("persists one intent, publishes exact R2 bytes, and replays the same receipt", async () => {
    const f = await fixture();
    const capture = port(f);
    const first = await capture.capture(f.input);
    expect(first.disposition).toBe("CAPTURED");
    expect(first.receipt.content_sha256).toBe(f.input.content_sha256);
    expect(f.evidence.objects.size).toBe(1);
    const row = f.rows.get(first.receipt.capture_id) as { state: string; object_key: string; receipt_sha256: string };
    expect(row.state).toBe("CAPTURED");
    expect(row.object_key).toBe(first.receipt.object_key);
    expect(row.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);

    const replay = await capture.capture({ ...f.input, body: bytesStream(f.bytes) });
    expect(replay.receipt).toEqual(first.receipt);
    expect(await capture.read({ principal_ref: f.input.principal_ref, idempotency_key: f.input.idempotency_key })).toEqual(first.receipt);
    expect(await capture.read({ principal_ref: "principal-b", idempotency_key: f.input.idempotency_key })).toBeNull();
  });

  it("rejects changed bytes bound to an existing idempotency key before any new R2 object", async () => {
    const f = await fixture();
    const capture = port(f);
    await capture.capture(f.input);
    const changed = new TextEncoder().encode("different raw bytes\n");
    const changedSha256 = await digest(changed);
    await expect(capture.capture({ ...f.input, content_sha256: changedSha256, size_bytes: changed.byteLength, residency_key: residency(changedSha256), body: bytesStream(changed) }))
      .rejects.toMatchObject({ code: "RAW_CAPTURE_IDEMPOTENCY_CONFLICT" });
    expect(f.evidence.objects.size).toBe(1);
  });

  it("leaves the durable intent non-captured when owner currentness is withdrawn after R2", async () => {
    const f = await fixture();
    let calls = 0;
    const capture = port(f, async () => {
      calls += 1;
      if (calls === 2) throw new RawCaptureError("RAW_CAPTURE_OWNER_NOT_CURRENT", "owner withdrawn");
    });
    await expect(capture.capture(f.input)).rejects.toMatchObject({ code: "RAW_CAPTURE_OWNER_NOT_CURRENT" });
    expect(f.evidence.objects.size).toBe(1);
    expect([...f.rows.values()][0]?.state).toBe("INTENT");

    const retry = port(f, async () => { /* current again */ });
    const result = await retry.capture({ ...f.input, body: bytesStream(f.bytes) });
    expect(result.disposition).toBe("CAPTURED");
  });

  it("rejects a residency digest that is not bound to the claimed bytes", async () => {
    const f = await fixture();
    await expect(port(f).capture({ ...f.input, residency_key: residency("f".repeat(64)), body: bytesStream(f.bytes) }))
      .rejects.toMatchObject({ code: "RAW_CAPTURE_RESIDENCY_MISMATCH" });
  });

  it("rejects a stream that exceeds its declared size before recording CAPTURED", async () => {
    const f = await fixture();
    await expect(port(f).capture({ ...f.input, size_bytes: f.bytes.byteLength - 1, body: bytesStream(f.bytes) }))
      .rejects.toMatchObject({ code: "RAW_CAPTURE_INPUT_INVALID" });
    expect(f.rows.size).toBe(1);
    expect([...f.rows.values()][0]?.state).toBe("INTENT");
  });

  it("reconciles a lost receipt update without minting another capture identity", async () => {
    const f = await fixture();
    const result = await port(f, undefined, { throwAfterCaptureUpdate: true }).capture(f.input);
    expect(result.disposition).toBe("CAPTURED");
    expect(result.receipt.capture_id).toMatch(/^raw-capture-/u);
    expect(f.rows.size).toBe(1);
    expect(f.evidence.objects.size).toBe(1);
  });
});
