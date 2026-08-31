import {
  bufferBounded,
  canonicalNormalizedBundleKey,
} from "@eliotr/platform-cloudflare";
import {
  projectionFail,
  projectionSha256Bytes,
} from "./canonical.js";
import type {
  ProjectionContentPort,
  ProjectionSourceContext,
} from "./types.js";

export interface R2ProjectionContentDependencies {
  readonly evidence_bucket: R2Bucket;
}

async function normalizedContentKey(context: ProjectionSourceContext): Promise<string> {
  return canonicalNormalizedBundleKey(
    context.source_revision.object_residency_key_digest,
    {
      owner_system_id: context.source_revision.source_owner_system_id,
      source_namespace_id: context.source_revision.source_namespace_id,
      source_owner_generation: context.source_revision.source_owner_generation,
      source_logical_id: context.source_revision.source_id,
      source_revision_ref: context.source_revision.source_revision_ref,
    },
    "content.md",
  );
}

export function createR2ProjectionContentPort(
  dependencies: R2ProjectionContentDependencies,
): ProjectionContentPort {
  return {
    async read(context, maximumBytes) {
      const key = await normalizedContentKey(context);
      const object = await dependencies.evidence_bucket.get(key);
      if (object === null) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "normalized content is missing from immutable Evidence storage",
          true,
        );
      }
      if (!Number.isSafeInteger(object.size) || object.size < 1) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "normalized content has an invalid stored size",
        );
      }
      if (object.size > maximumBytes) {
        try { await object.body.cancel(); } catch { /* the size authority is already known */ }
        return {
          disposition: "SHARDED_WORKFLOW_REQUIRED",
          normalized_object_ref: key,
          size_bytes: object.size,
          reason_codes: ["SHARDED_WORKFLOW_REQUIRED"],
        };
      }
      const bytes = await bufferBounded(object.body, maximumBytes);
      if (bytes.byteLength !== object.size) {
        projectionFail(
          "PROJECTION_SETTLEMENT_UNCERTAIN",
          "normalized content streamed size differs from R2 authority",
          true,
        );
      }
      const digest = await projectionSha256Bytes(bytes);
      if (digest !== context.source_revision.content_sha256) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "normalized content digest differs from the admitted SourceRevision",
        );
      }
      let markdown: string;
      try {
        markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (cause) {
        projectionFail(
          "PROJECTION_AUTHORITY_CONFLICT",
          "normalized content is not valid UTF-8",
          false,
          cause,
        );
      }
      if (markdown.length === 0) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "normalized content is empty");
      }
      return {
        disposition: "READY",
        markdown,
        normalized_object_ref: key,
        readback_sha256: digest,
        size_bytes: bytes.byteLength,
      };
    },
  };
}
