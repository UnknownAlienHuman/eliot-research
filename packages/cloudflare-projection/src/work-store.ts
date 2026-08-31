import {
  createR2EvidenceObjectStore,
  type EvidenceObjectStore,
} from "@eliotr/platform-cloudflare";
import type { MarkdownProjectionResult } from "@eliotr/retrieval";
import {
  canonicalProjectionJson,
  projectionByteStream,
  projectionSha256Utf8,
  stableProjectionId,
  utf8ProjectionBytes,
} from "./canonical.js";
import type {
  MaterializedProjectionItem,
  ProjectionSourceContext,
  ProjectionWorkPort,
  ProjectionWorkReceipt,
} from "./types.js";

export interface R2ProjectionWorkDependencies {
  readonly work_bucket: R2Bucket;
  readonly object_store?: EvidenceObjectStore;
}

interface ProjectionManifestItem {
  readonly item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  readonly object_ref: string;
  readonly readback_sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
}

function safeProjectionPrefix(sourceToken: string, generationToken: string): string {
  return `projection/${sourceToken}/${generationToken}`;
}

async function materializeItem(
  store: EvidenceObjectStore,
  prefix: string,
  context: ProjectionSourceContext,
  projectionGeneration: string,
  projection: MarkdownProjectionResult,
  index: number,
): Promise<MaterializedProjectionItem> {
  const item = projection.items[index];
  const span = projection.spans[index];
  if (item === undefined || span === undefined || item.item_key !== span.item_key) {
    throw new Error("projection item/span alignment is invalid");
  }
  const bytes = utf8ProjectionBytes(item.section_text);
  const key = `${prefix}/items/${item.item_key}.md`;
  const receipt = await store.putImmutable({
    key,
    body: projectionByteStream(bytes),
    expected_sha256: item.content_sha256,
    expected_size_bytes: bytes.byteLength,
    content_type: "text/markdown; charset=utf-8",
    custom_metadata: {
      source_revision_ref: context.source_revision.source_revision_ref,
      projection_generation: projectionGeneration,
      item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
    },
  });
  return {
    item_key: item.item_key,
    object_ref: receipt.key,
    readback_sha256: receipt.readback_sha256,
    size_bytes: receipt.size_bytes,
    etag: receipt.etag,
  };
}

export function createR2ProjectionWorkPort(
  dependencies: R2ProjectionWorkDependencies,
): ProjectionWorkPort {
  const store = dependencies.object_store ?? createR2EvidenceObjectStore(dependencies.work_bucket);

  return {
    async materialize(context, projectionGeneration, projection) {
      const sourceToken = (await stableProjectionId(
        "source",
        context.source_revision.source_revision_ref,
      )).slice("source-".length);
      const generationToken = (await stableProjectionId(
        "generation",
        projectionGeneration,
      )).slice("generation-".length);
      const prefix = safeProjectionPrefix(sourceToken, generationToken);
      const itemReceipts: MaterializedProjectionItem[] = [];
      for (let index = 0; index < projection.items.length; index += 1) {
        itemReceipts.push(await materializeItem(
          store,
          prefix,
          context,
          projectionGeneration,
          projection,
          index,
        ));
      }

      const manifestItems: ProjectionManifestItem[] = itemReceipts.map((receipt, index) => {
        const item = projection.items[index];
        const span = projection.spans[index];
        if (item === undefined || span === undefined) {
          throw new Error("projection manifest item alignment is invalid");
        }
        return {
          item_key: item.item_key,
          canonical_section_id: item.canonical_section_id,
          content_sha256: item.content_sha256,
          normalized_start_byte: span.normalized_start_byte,
          normalized_end_byte: span.normalized_end_byte,
          object_ref: receipt.object_ref,
          readback_sha256: receipt.readback_sha256,
          size_bytes: receipt.size_bytes,
          etag: receipt.etag,
        };
      });
      const manifest = {
        protocol: "eliotr.projection-work-manifest.v1",
        source_revision_ref: context.source_revision.source_revision_ref,
        source_owner_generation: context.source_revision.source_owner_generation,
        content_sha256: context.source_revision.content_sha256,
        object_residency_key_digest: context.source_revision.object_residency_key_digest,
        projection_generation: projectionGeneration,
        item_set_digest: projection.item_set_digest,
        item_count: projection.items.length,
        items: manifestItems,
      } as const;
      const manifestJson = canonicalProjectionJson(manifest);
      const manifestSha = await projectionSha256Utf8(manifestJson);
      const manifestBytes = utf8ProjectionBytes(manifestJson);
      const manifestReceipt = await store.putImmutable({
        key: `${prefix}/manifests/${manifestSha}.json`,
        body: projectionByteStream(manifestBytes),
        expected_sha256: manifestSha,
        expected_size_bytes: manifestBytes.byteLength,
        content_type: "application/json; charset=utf-8",
        custom_metadata: {
          source_revision_ref: context.source_revision.source_revision_ref,
          projection_generation: projectionGeneration,
          item_set_digest: projection.item_set_digest,
          manifest_sha256: manifestSha,
        },
      });
      return {
        manifest_ref: manifestReceipt.key,
        manifest_sha256: manifestReceipt.readback_sha256,
        item_set_digest: projection.item_set_digest,
        item_count: projection.items.length,
        item_receipts: itemReceipts,
      };
    },
  };
}
