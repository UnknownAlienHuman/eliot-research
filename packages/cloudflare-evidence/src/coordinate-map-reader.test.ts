import { expect, test } from "vitest";
import type { EvidenceSourceAuthority } from "./types.js";
import {
  CoordinateMapSchema,
  type NormalizedBundleManifest,
  type ObjectResidencyKey,
} from "@eliotr/contracts";
import {
  canonicalNormalizedBundleKey,
  objectResidencyKeyDigest,
} from "@eliotr/platform-cloudflare";
import { evidenceSha256Bytes } from "./canonical.js";
import { readAdmittedCoordinateMap } from "./coordinate-map-reader.js";

interface Stored {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly namespace: string;
  readonly generation: string;
  readonly admission: string;
  readonly contentType: string;
  readonly etag: string;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } });
}

function checksum(digest: string): ArrayBuffer {
  const bytes = new Uint8Array(digest.match(/../gu)?.map((part) => Number.parseInt(part, 16)) ?? []);
  return bytes.buffer;
}

function bucket(objects: Map<string, Stored>): R2Bucket {
  return {
    async head(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        key, version: value.etag, etag: value.etag, httpEtag: `"${value.etag}"`, size: value.bytes.byteLength,
        checksums: { sha256: checksum(value.digest) },
        customMetadata: {
          eliotr_immutable: "true", eliotr_sha256: value.digest, eliotr_size_bytes: String(value.bytes.byteLength),
          source_namespace_id: value.namespace, source_owner_generation: value.generation,
          admission_receipt_ref: value.admission,
        },
        httpMetadata: { contentType: value.contentType },
      } as unknown as R2Object;
    },
    async get(key: string, options?: R2GetOptions) {
      const value = objects.get(key);
      if (value === undefined) return null;
      const range = options?.range && !(options.range instanceof Headers) && "offset" in options.range
        ? { offset: options.range.offset, length: options.range.length }
        : undefined;
      const bytes = range === undefined ? value.bytes : value.bytes.slice(range.offset, range.offset + (range.length ?? 0));
      return {
        key, version: value.etag, etag: value.etag, httpEtag: `"${value.etag}"`, size: bytes.byteLength,
        checksums: { sha256: checksum(value.digest) },
        customMetadata: {
          eliotr_immutable: "true", eliotr_sha256: value.digest, eliotr_size_bytes: String(value.bytes.byteLength),
          source_namespace_id: value.namespace, source_owner_generation: value.generation,
          admission_receipt_ref: value.admission,
        },
        httpMetadata: { contentType: value.contentType }, range, body: stream(bytes),
        arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

async function fixture() {
  const markdown = new TextEncoder().encode("A😀B\n");
  const contentDigest = await evidenceSha256Bytes(markdown);
  const mapWithoutDigest = {
    protocol: "eliotr.coordinate-map.v1" as const,
    source_owner_system_id: "owner-1", source_namespace_id: "namespace-1",
    source_owner_generation: "generation-1", source_logical_id: "source-1",
    source_revision_ref: "revision-1", source_content_sha256: contentDigest,
    normalized_content_path: "content.md", precision_ceiling: "table_cell" as const,
    generator_generation: "coordinate-map-v1", created_at: "2026-09-09T00:00:00.000Z",
    entries: [{
      anchor: { kind: "table_cell" as const, table_id: "table-1", row: 0, column: 0 },
      normalized_start_byte: 1, normalized_end_byte: 5,
      excerpt_sha256: await evidenceSha256Bytes(markdown.slice(1, 5)), section_ref: "section-1",
    }],
  };
  const map = CoordinateMapSchema.parse(mapWithoutDigest);
  const mapBytes = new TextEncoder().encode(JSON.stringify(map));
  const mapDigest = await evidenceSha256Bytes(mapBytes);
  const manifest: NormalizedBundleManifest = {
    protocol: "eliotr.normalized.v1",
    origin: {
      owner_system_id: "owner-1", source_namespace_id: "namespace-1", source_owner_generation: "generation-1",
      source_revision_ref: "revision-1", source_view_ref: "view-1", ownership_mode: "immutable_import",
    },
    source: { logical_id: "source-1", original_name: "source.md", original_sha256: contentDigest, origin_location_class: "external", mime_type: "text/markdown" },
    residency_and_disclosure: {
      scope_domain_id: "scope-1", access_domain_id: "access-1", confidentiality_domain_id: "confidential",
      encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erase-1",
      disclosure_ceiling: "owner-only", allowed_use: ["research"],
    },
    normalization: { analyzer: "fixture", analyzer_version: "1", profile: "native-map", config_hash: "a".repeat(64), created_at: "2026-09-09T00:00:00.000Z" },
    content: { markdown: "content.md", markdown_sha256: contentDigest, mappings: "coordinate-map.json", tables: "tables.json", coordinate_map_digest: mapDigest },
    capabilities: { text_ranges: true, pages: false, bounding_boxes: false, tables: true, figures: false },
    quality: { state: "standard", assurance_ceiling: "source-local", warnings: [] },
    export: { purpose: "test", receipt_ref: "export-1" },
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestDigest = await evidenceSha256Bytes(manifestBytes);
  const admission = "admission-1";
  const authority = {
    source_id: "source-1", owner_system_id: "owner-1", source_namespace_id: "namespace-1",
    source_owner_generation: "generation-1", source_revision_ref: "revision-1", source_title: "Fixture",
    source_class: "document", content_sha256: contentDigest, object_residency_key_digest: "pending",
    normalized_artifact_ref: "manifest-key", purge_state: "LIVE", admission_receipt_ref: admission,
    source_assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", allowed_use: ["research"], disclosure_ceiling: "owner-only",
  } as EvidenceSourceAuthority;
  const residency: ObjectResidencyKey = {
    scope_domain_id: "scope-1", access_domain_id: "access-1", confidentiality_domain_id: "confidential",
    encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erase-1",
    content_digest: { algorithm: "sha256", digest: mapDigest },
  };
  const mapDigestKey = await objectResidencyKeyDigest(residency);
  const contentResidencyDigest = await objectResidencyKeyDigest({
    ...residency,
    content_digest: { algorithm: "sha256", digest: contentDigest },
  });
  (authority as { object_residency_key_digest: string }).object_residency_key_digest = contentResidencyDigest;
  const mapKey = await canonicalNormalizedBundleKey(mapDigestKey, {
    owner_system_id: "owner-1", source_namespace_id: "namespace-1", source_owner_generation: "generation-1",
    source_logical_id: "source-1", source_revision_ref: "revision-1",
  }, "coordinate-map.json");
  const objects = new Map<string, Stored>();
  const manifestResidencyDigest = await objectResidencyKeyDigest({
    scope_domain_id: manifest.residency_and_disclosure.scope_domain_id,
    access_domain_id: manifest.residency_and_disclosure.access_domain_id,
    confidentiality_domain_id: manifest.residency_and_disclosure.confidentiality_domain_id,
    encryption_key_domain_id: manifest.residency_and_disclosure.encryption_key_domain_id,
    retention_domain_id: manifest.residency_and_disclosure.retention_domain_id,
    erasure_domain_id: manifest.residency_and_disclosure.erasure_domain_id,
    content_digest: { algorithm: "sha256", digest: manifestDigest },
  });
  const manifestKey = await canonicalNormalizedBundleKey(manifestResidencyDigest, {
    owner_system_id: "owner-1", source_namespace_id: "namespace-1", source_owner_generation: "generation-1",
    source_logical_id: "source-1", source_revision_ref: "revision-1",
  }, "manifest.json");
  (authority as { normalized_artifact_ref: string }).normalized_artifact_ref = manifestKey;
  objects.set(manifestKey, { bytes: manifestBytes, digest: manifestDigest, namespace: "namespace-1", generation: "generation-1", admission, contentType: "application/json", etag: "manifest" });
  objects.set(mapKey, { bytes: mapBytes, digest: mapDigest, namespace: "namespace-1", generation: "generation-1", admission, contentType: "application/json", etag: "map" });
  const tablesBytes = new TextEncoder().encode("[{\"table_id\":\"table-1\",\"rows\":1,\"columns\":1}]");
  const tablesDigest = await evidenceSha256Bytes(tablesBytes);
  const tablesKey = await canonicalNormalizedBundleKey(await objectResidencyKeyDigest({
    scope_domain_id: manifest.residency_and_disclosure.scope_domain_id,
    access_domain_id: manifest.residency_and_disclosure.access_domain_id,
    confidentiality_domain_id: manifest.residency_and_disclosure.confidentiality_domain_id,
    encryption_key_domain_id: manifest.residency_and_disclosure.encryption_key_domain_id,
    retention_domain_id: manifest.residency_and_disclosure.retention_domain_id,
    erasure_domain_id: manifest.residency_and_disclosure.erasure_domain_id,
    content_digest: { algorithm: "sha256", digest: tablesDigest },
  }), {
    owner_system_id: "owner-1", source_namespace_id: "namespace-1", source_owner_generation: "generation-1",
    source_logical_id: "source-1", source_revision_ref: "revision-1",
  }, "tables.json");
  objects.set(tablesKey, { bytes: tablesBytes, digest: tablesDigest, namespace: "namespace-1", generation: "generation-1", admission, contentType: "application/json", etag: "tables" });
  const contentKey = await canonicalNormalizedBundleKey(contentResidencyDigest, {
    owner_system_id: "owner-1", source_namespace_id: "namespace-1", source_owner_generation: "generation-1",
    source_logical_id: "source-1", source_revision_ref: "revision-1",
  }, "content.md");
  objects.set(contentKey, { bytes: markdown, digest: contentDigest, namespace: "namespace-1", generation: "generation-1", admission, contentType: "text/markdown; charset=utf-8", etag: "content" });
  return { authority, objects, mapKey, mapDigestKey };
}

test("reads an admitted table-cell map from its per-file R2 residency key", async () => {
  const f = await fixture();
  const result = await readAdmittedCoordinateMap(bucket(f.objects), f.authority);
  expect(result.map.entries[0]?.anchor.kind).toBe("table_cell");
  expect(result.map_object_ref).toBe(f.mapKey);
  expect(result.map_object_residency_key_digest).toBe(f.mapDigestKey);
});

test("coordinate map read rechecks the current owner boundary", async () => {
  const f = await fixture();
  let checks = 0;
  await expect(readAdmittedCoordinateMap(bucket(f.objects), f.authority, {
    require_current: async () => { checks += 1; if (checks === 2) throw new Error("withdrawn"); },
  })).rejects.toThrow("withdrawn");
  expect(checks).toBe(2);
});

test("manifest readback hashes the bounded body and rejects bytes rewritten under old metadata", async () => {
  const f = await fixture();
  const key = f.authority.normalized_artifact_ref;
  const original = f.objects.get(key);
  if (original === undefined) throw new Error("missing admitted manifest");
  const replacement = original.bytes.slice();
  replacement[replacement.length - 1] = replacement[replacement.length - 1] === 0x7d ? 0x20 : 0x7d;
  f.objects.set(key, { ...original, bytes: replacement });
  await expect(readAdmittedCoordinateMap(bucket(f.objects), f.authority))
    .rejects.toMatchObject({ code: "EVIDENCE_OBJECT_INTEGRITY" });
});

test("manifest readback rejects a different valid manifest whose checksum and metadata were rewritten under the old key", async () => {
  const f = await fixture();
  const key = f.authority.normalized_artifact_ref;
  const original = f.objects.get(key);
  if (original === undefined) throw new Error("missing admitted manifest");
  const replacement = new TextEncoder().encode(
    new TextDecoder().decode(original.bytes).replace('"state":"standard"', '"state":"degraded"'),
  );
  const digest = await evidenceSha256Bytes(replacement);
  f.objects.set(key, { ...original, bytes: replacement, digest });
  await expect(readAdmittedCoordinateMap(bucket(f.objects), f.authority))
    .rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
});

test("manifest readback binds the source logical identity before selecting native coordinates", async () => {
  const f = await fixture();
  const key = f.authority.normalized_artifact_ref;
  const original = f.objects.get(key);
  if (original === undefined) throw new Error("missing admitted manifest");
  const replacement = new TextEncoder().encode(
    new TextDecoder().decode(original.bytes).replace('"logical_id":"source-1"', '"logical_id":"source-x"'),
  );
  const digest = await evidenceSha256Bytes(replacement);
  f.objects.set(key, { ...original, bytes: replacement, digest });
  await expect(readAdmittedCoordinateMap(bucket(f.objects), f.authority))
    .rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
});
