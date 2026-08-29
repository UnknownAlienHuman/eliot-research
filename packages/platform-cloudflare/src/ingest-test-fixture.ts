import type { NormalizedBundleManifest, ObjectResidencyKey } from "@eliotr/contracts";
import type { MultipartUploadSession, StagedBundlePort } from "./ingest.js";
import type { Sha256DigestSink } from "./r2.js";

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly customMetadata: Record<string, string>;
  readonly httpMetadata: { readonly contentType?: string };
}

interface PendingUpload {
  readonly key: string;
  readonly uploadId: string;
  readonly customMetadata: Record<string, string>;
  readonly httpMetadata: { readonly contentType?: string };
  readonly parts: Map<number, { readonly bytes: Uint8Array; readonly etag: string }>;
  aborted: boolean;
}

export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

async function readBytes(value: ReadableStream<Uint8Array> | string): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function testDigestSink(): Sha256DigestSink {
  const chunks: Uint8Array[] = [];
  let resolveDigest: (value: ArrayBuffer) => void = () => undefined;
  let rejectDigest: (reason: unknown) => void = () => undefined;
  const result = new Promise<ArrayBuffer>((resolve, reject) => {
    resolveDigest = resolve;
    rejectDigest = reject;
  });
  return {
    writable: new WritableStream<Uint8Array>({
      write(chunk) { chunks.push(chunk.slice()); },
      async close() {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try { resolveDigest(await crypto.subtle.digest("SHA-256", body)); }
        catch (error) { rejectDigest(error); }
      },
      abort(reason) { rejectDigest(reason); },
    }),
    digest: result,
  };
}

export function fakeBucket(behavior: { readonly throw_after_put_prefix?: string } = {}): {
  readonly binding: R2Bucket;
  readonly objects: Map<string, StoredObject>;
  readonly uploads: Map<string, PendingUpload>;
} {
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, PendingUpload>();
  let sequence = 0;
  let putFailureInjected = false;

  function objectMetadata(key: string, object: StoredObject): R2ObjectBody {
    return {
      key,
      version: object.etag,
      size: object.bytes.byteLength,
      etag: object.etag,
      httpEtag: `"${object.etag}"`,
      uploaded: new Date(0),
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      range: undefined,
      checksums: {} as R2Checksums,
      storageClass: "Standard",
      writeHttpMetadata() {},
      body: bytesStream(object.bytes),
      bodyUsed: false,
      arrayBuffer: async () => object.bytes.slice().buffer,
      text: async () => new TextDecoder().decode(object.bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(object.bytes)) as T,
      blob: async () => new Blob([object.bytes]),
    };
  }

  function multipart(pending: PendingUpload): R2MultipartUpload {
    return {
      key: pending.key,
      uploadId: pending.uploadId,
      async uploadPart(partNumber, value) {
        if (pending.aborted) throw new Error("upload aborted");
        const partBytes = value instanceof ReadableStream
          ? await readBytes(value as ReadableStream<Uint8Array>)
          : typeof value === "string"
            ? new TextEncoder().encode(value)
            : value instanceof Blob
              ? new Uint8Array(await value.arrayBuffer())
              : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer);
        const etag = `part-${pending.uploadId}-${partNumber}-${++sequence}`;
        pending.parts.set(partNumber, { bytes: partBytes, etag });
        return { partNumber, etag };
      },
      async abort() { pending.aborted = true; },
      async complete(parts) {
        if (pending.aborted) throw new Error("upload aborted");
        const selected = parts.map((part) => {
          const stored = pending.parts.get(part.partNumber);
          if (stored === undefined || stored.etag !== part.etag) throw new Error("part mismatch");
          return stored.bytes;
        });
        const total = selected.reduce((sum, part) => sum + part.byteLength, 0);
        const body = new Uint8Array(total);
        let offset = 0;
        for (const part of selected) { body.set(part, offset); offset += part.byteLength; }
        const etag = `object-${++sequence}`;
        const object: StoredObject = {
          bytes: body,
          etag,
          customMetadata: pending.customMetadata,
          httpMetadata: pending.httpMetadata,
        };
        objects.set(pending.key, object);
        return objectMetadata(pending.key, object);
      },
    };
  }

  const binding = {
    async head(key: string) {
      const object = objects.get(key);
      return object === undefined ? null : objectMetadata(key, object);
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const object = objects.get(key);
      if (object === undefined) return null;
      if (options?.range === undefined) return objectMetadata(key, object);
      const ranged: StoredObject = {
        ...object,
        bytes: object.bytes.slice(
          options.range.offset,
          options.range.offset + options.range.length,
        ),
      };
      return objectMetadata(key, ranged);
    },
    async put(key: string, value: ReadableStream<Uint8Array> | string, options?: R2PutOptions) {
      if (options?.onlyIf !== undefined
        && "etagDoesNotMatch" in options.onlyIf
        && options.onlyIf.etagDoesNotMatch === "*"
        && objects.has(key)) return null;
      const body = await readBytes(value);
      if (typeof options?.sha256 === "string" && await digest(body) !== options.sha256) {
        throw new Error("checksum mismatch");
      }
      const etag = `put-${++sequence}`;
      const object: StoredObject = {
        bytes: body,
        etag,
        customMetadata: options?.customMetadata ?? {},
        httpMetadata: options?.httpMetadata instanceof Headers
          ? {}
          : options?.httpMetadata ?? {},
      };
      objects.set(key, object);
      if (
        behavior.throw_after_put_prefix !== undefined &&
        key.startsWith(behavior.throw_after_put_prefix) &&
        !putFailureInjected
      ) {
        putFailureInjected = true;
        throw new Error("simulated lost acknowledgement after durable R2 write");
      }
      return objectMetadata(key, object);
    },
    async delete(input: string | string[]) {
      for (const key of typeof input === "string" ? [input] : input) objects.delete(key);
    },
    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? "";
      const all = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right));
      if (options?.delimiter !== undefined) {
        const prefixes = [...new Set(all.flatMap(([key]) => {
          const remainder = key.slice(prefix.length);
          const boundary = remainder.indexOf(options.delimiter ?? "");
          return boundary < 0 ? [] : [`${prefix}${remainder.slice(0, boundary + 1)}`];
        }))].sort();
        const selectedPrefixes = prefixes.slice(0, options.limit ?? 1000);
        return {
          objects: [],
          truncated: selectedPrefixes.length < prefixes.length,
          delimitedPrefixes: selectedPrefixes,
        };
      }
      const selected = all.slice(0, options?.limit ?? 1000);
      return {
        objects: selected.map(([key, object]) => objectMetadata(key, object)),
        truncated: selected.length < all.length,
        delimitedPrefixes: [],
      };
    },
    async createMultipartUpload(key: string, options?: R2MultipartOptions) {
      const uploadId = `upload-${++sequence}`;
      const pending: PendingUpload = {
        key,
        uploadId,
        customMetadata: options?.customMetadata ?? {},
        httpMetadata: options?.httpMetadata instanceof Headers
          ? {}
          : options?.httpMetadata ?? {},
        parts: new Map(),
        aborted: false,
      };
      uploads.set(uploadId, pending);
      return multipart(pending);
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const pending = uploads.get(uploadId);
      if (pending === undefined || pending.key !== key) throw new Error("unknown multipart upload");
      return multipart(pending);
    },
  } as unknown as R2Bucket;

  return { binding, objects, uploads };
}

export interface BundleFixture {
  readonly manifest: NormalizedBundleManifest;
  readonly residency: ObjectResidencyKey;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly hashes: Readonly<Record<string, string>>;
  readonly totalBytes: number;
}

export async function bundleFixture(hashesTextOverride?: string): Promise<BundleFixture> {
  const content = new TextEncoder().encode("# Evidence\n\nPinned content.\n");
  const contentDigest = await digest(content);
  const manifest: NormalizedBundleManifest = {
    protocol: "eliotr.normalized.v1",
    origin: {
      owner_system_id: "fixture-owner",
      source_namespace_id: "fixture-namespace",
      source_owner_generation: "owner-generation-1",
      source_revision_ref: "source-revision-1",
      source_view_ref: "source-view-1",
      ownership_mode: "immutable_import",
    },
    source: {
      logical_id: "source-a",
      original_name: "source.md",
      original_sha256: contentDigest,
      origin_location_class: "external",
      mime_type: "text/markdown",
    },
    residency_and_disclosure: {
      scope_domain_id: "scope-a",
      access_domain_id: "access-a",
      confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-a",
      retention_domain_id: "retention-a",
      erasure_domain_id: "erasure-a",
      disclosure_ceiling: "owner-only",
      allowed_use: ["research"],
    },
    normalization: {
      analyzer: "fixture",
      analyzer_version: "1",
      profile: "standard",
      config_hash: "1".repeat(64),
      created_at: "2026-08-29T00:00:00Z",
    },
    content: { markdown: "content.md", markdown_sha256: contentDigest },
    capabilities: {
      text_ranges: true,
      pages: false,
      bounding_boxes: false,
      tables: false,
      figures: false,
    },
    quality: { state: "standard", assurance_ceiling: "source-local", warnings: [] },
    export: { purpose: "test", receipt_ref: "export-receipt-1" },
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestDigest = await digest(manifestBytes);
  const hashesText = hashesTextOverride
    ?? `${contentDigest}  content.md\n${manifestDigest}  manifest.json\n`;
  const hashesBytes = new TextEncoder().encode(hashesText);
  const files = {
    "content.md": content,
    "manifest.json": manifestBytes,
    "hashes.sha256": hashesBytes,
  } as const;
  const hashes = {
    "content.md": contentDigest,
    "manifest.json": manifestDigest,
    "hashes.sha256": await digest(hashesBytes),
  } as const;
  return {
    manifest,
    residency: {
      scope_domain_id: "scope-a",
      access_domain_id: "access-a",
      confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-a",
      retention_domain_id: "retention-a",
      erasure_domain_id: "erasure-a",
      content_digest: { algorithm: "sha256", digest: contentDigest },
    },
    files,
    hashes,
    totalBytes: Object.values(files).reduce((sum, file) => sum + file.byteLength, 0),
  };
}

export async function uploadAll(
  port: StagedBundlePort,
  session: MultipartUploadSession,
  files: Readonly<Record<string, Uint8Array>>,
): Promise<void> {
  for (const upload of session.uploads) {
    const file = files[upload.path];
    if (file === undefined) throw new Error(`missing fixture file ${upload.path}`);
    const part = await port.uploadPart({
      session_id: session.session_id,
      path: upload.path,
      part_number: 1,
      size_bytes: file.byteLength,
      final_part: true,
      body: bytesStream(file),
    });
    await port.completeFile(session.session_id, upload.path, [{
      part_number: 1,
      size_bytes: file.byteLength,
      etag: part.etag,
    }]);
  }
}
