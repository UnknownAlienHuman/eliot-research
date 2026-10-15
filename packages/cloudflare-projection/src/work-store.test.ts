import { describe, expect, it } from "vitest";
import type { SourceRevision } from "@eliotr/contracts";
import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import {
  projectionSha256Bytes,
  projectionSha256Utf8,
} from "./canonical.js";
import { managedProjectGenerationMetadataValue } from "./managed-project-path.js";
import { createR2CanonicalSourceProjectionWriter } from "./work-store.js";

describe("R2 canonical source writer", () => {
  it("writes each canonical section once and maps A/B memberships by body reference", async () => {
    const markdown = "# Heading\n\nOne canonical body.\n";
    const contentSha256 = await projectionSha256Utf8(markdown);
    const sourceRevision: SourceRevision = {
      source_revision_ref: "revision-writer-fixture",
      source_id: "source-writer-fixture",
      source_namespace_id: "namespace-writer-fixture",
      source_owner_system_id: "owner-writer-fixture",
      source_owner_generation: "owner-generation-writer-fixture",
      ownership_mode: "immutable_import",
      content_sha256: contentSha256,
      object_residency_key_digest: "b".repeat(64),
      normalized_artifact_ref: "normalized/manifest.json",
      captured_at: "2026-10-14T00:00:00.000Z",
      parser_profile_generation: "parser-writer-fixture",
      quality_state: "standard",
      purge_state: "LIVE",
    };
    const writes: { readonly key: string; readonly bytes: Uint8Array }[] = [];
    const store = {
      async putImmutable(write: {
        readonly key: string;
        readonly body: ReadableStream<Uint8Array>;
        readonly expected_sha256: string;
        readonly expected_size_bytes: number;
      }) {
        const bytes = new Uint8Array(await new Response(write.body).arrayBuffer());
        const readback = await projectionSha256Bytes(bytes);
        expect(bytes.byteLength).toBe(write.expected_size_bytes);
        expect(readback).toBe(write.expected_sha256);
        writes.push({ key: write.key, bytes });
        return {
          key: write.key,
          expected_sha256: write.expected_sha256,
          readback_sha256: readback,
          size_bytes: bytes.byteLength,
          etag: `etag-${writes.length}`,
          existed_identically: false,
        };
      },
    } as unknown as EvidenceObjectStore;
    const writer = createR2CanonicalSourceProjectionWriter({
      work_bucket: {} as R2Bucket,
      object_store: store,
    });
    const profile = {
      projector_profile: "structural-markdown-v1",
      target_item_utf8_bytes: 1024,
      maximum_item_utf8_bytes: 4096,
      maximum_markdown_bytes: 4096,
      maximum_synchronous_items: 64,
    } as const;
    const canonical = await writer.projectCanonicalSource({
      source: {
        source_revision: sourceRevision,
        source_title: "Shared source",
        source_class: "document",
        instruction_taint: "DATA_ONLY",
      },
      profile,
      normalized_markdown: markdown,
    });
    const target = {
      managed_instance_id: "items-instance-fixture",
      managed_generation: "managed-generation-fixture",
      metadata_generation_digest: await managedProjectGenerationMetadataValue("managed-generation-fixture"),
    };
    const copies = await writer.mapProjectCopies({
      canonical,
      target,
      memberships: [
        {
          project_id: "project-a",
          project_membership_id: "project:project-a:generation:1",
          membership_generation: 1,
        },
        {
          project_id: "project-b",
          project_membership_id: "project:project-b:generation:1",
          membership_generation: 1,
        },
      ],
    });

    expect(canonical.canonical_section_count).toBe(1);
    expect(canonical.resource_bounds.canonical_body_put_count).toBe(1);
    expect(canonical.resource_bounds.input_utf8_bytes).toBe(new TextEncoder().encode(markdown).byteLength);
    expect(copies.provider_copy_count).toBe(2);
    expect(copies.provider_item_count).toBe(2);
    expect(copies.pages).toHaveLength(1);
    expect(writes.filter((write) => write.key.includes("/items/")).map((write) => write.key)).toHaveLength(1);
    const page = writes.find((write) => write.key.includes("/copy-maps/"));
    expect(page).toBeDefined();
    const pageJson = new TextDecoder().decode(page?.bytes);
    expect(pageJson).toContain(canonical.sections[0]?.canonical_body_ref);
    expect(pageJson).not.toContain("One canonical body.");
    expect(page?.key).toContain("projection/");
    expect(copies.provider_item_set_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
