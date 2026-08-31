import type { ProjectionItem } from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createManagedProjectionPort } from "./managed-index.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const context = {
  intent_ref: { id: "intent-1", revision: 1 },
  job_id: "job-1",
  job_state: "ACCEPTED",
  acceptance_attempt_id: "attempt-1",
  source_revision: {
    source_revision_ref: "revision-1",
    source_id: "source-1",
    source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-1",
    source_owner_generation: "generation-1",
    ownership_mode: "immutable_import",
    content_sha256: A,
    object_residency_key_digest: B,
    captured_at: "2026-08-31T12:00:00.000Z",
    quality_state: "standard",
    purge_state: "LIVE",
  },
  source_title: "Document",
  source_class: "document",
  instruction_taint: "DATA_ONLY",
  project_membership_ids: [],
  message: {
    protocol: "eliotr.delivery.message.v1",
    message_id: "outbox-1:1",
    topic: "source.revision.admitted",
    payload_ref: "revision-1",
    payload_sha256: A,
    idempotency_key: "projection-1",
    outbox_id: "outbox-1",
    outbox_attempt: 1,
    created_at_ms: 1,
  },
} satisfies ProjectionSourceContext;
const item: ProjectionItem = {
  item_key: "projection-item-1",
  canonical_section_id: "section-1",
  source_revision_ref: "revision-1",
  project_membership_ids: [],
  heading_path: ["Heading"],
  document_context_header: "Document › Heading",
  section_text: "Exact section text.",
  normalized_offset_map_ref: "normalized-bytes:0:19",
  content_sha256: A,
  instruction_taint: "DATA_ONLY",
  projection_generation: "projection-g1",
};
const profile: ProjectionExecutionProfile = {
  projector_profile: "structural-markdown-v1",
  managed_instance_id: "private-prose-g1",
  managed_generation: "g1",
  managed_generation_active: true,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  managed_poll_interval_ms: 100,
  managed_timeout_ms: 1_000,
};

describe("managed AI Search projection adapter", () => {
  it("requires upload completion and exact item-info readback", async () => {
    let key = "";
    let size = 0;
    let metadata: Readonly<Record<string, string>> = {};
    const info = vi.fn(async () => ({
      id: "provider-item-1",
      key,
      status: "completed",
      chunks_count: 1,
      file_size: size,
      metadata,
    }));
    const uploadAndPoll = vi.fn(async (
      uploadedKey: string,
      content: string,
      options?: { readonly metadata?: Readonly<Record<string, string>> },
    ) => {
      key = uploadedKey;
      size = new TextEncoder().encode(content).byteLength;
      metadata = options?.metadata ?? {};
      return {
        id: "provider-item-1",
        key,
        status: "completed",
        chunks_count: 1,
        file_size: size,
        metadata,
      };
    });
    const port = createManagedProjectionPort({
      profile,
      namespace: {
        get() {
          return {
            items: {
              uploadAndPoll,
              get() { return { info }; },
            },
          };
        },
      },
    });
    const result = await port.index(context, "projection-g1", [item]);
    expect(result).toMatchObject({
      state: "READY",
      item_count: 1,
      instance_id: "private-prose-g1",
      managed_generation: "g1",
    });
    expect(uploadAndPoll).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
  });

  it("degrades instead of advertising semantic readiness on mismatched readback", async () => {
    const port = createManagedProjectionPort({
      profile,
      namespace: {
        get() {
          return {
            items: {
              async uploadAndPoll(
                uploadedKey: string,
                content: string,
                options?: { readonly metadata?: Readonly<Record<string, string>> },
              ) {
                return {
                  id: "provider-item-1",
                  key: uploadedKey,
                  status: "completed",
                  chunks_count: 1,
                  file_size: new TextEncoder().encode(content).byteLength,
                  metadata: options?.metadata ?? {},
                };
              },
              get() {
                return {
                  async info() {
                    return {
                      id: "provider-item-1",
                      key: "foreign-key.md",
                      status: "completed",
                      chunks_count: 1,
                      file_size: 1,
                      metadata: {},
                    };
                  },
                };
              },
            },
          };
        },
      },
    });
    await expect(port.index(context, "projection-g1", [item])).resolves.toEqual({
      state: "DEGRADED",
      item_count: 1,
      instance_id: "private-prose-g1",
      managed_generation: "g1",
      reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
    });
  });


  it("keeps exact item readback in shadow state until the managed generation is promoted", async () => {
    let key = "";
    let size = 0;
    let metadata: Readonly<Record<string, string>> = {};
    const port = createManagedProjectionPort({
      profile: { ...profile, managed_generation_active: false },
      namespace: {
        get() {
          return {
            items: {
              async uploadAndPoll(
                uploadedKey: string,
                content: string,
                options?: { readonly metadata?: Readonly<Record<string, string>> },
              ) {
                key = uploadedKey;
                size = new TextEncoder().encode(content).byteLength;
                metadata = options?.metadata ?? {};
                return {
                  id: "provider-item-1",
                  key,
                  status: "completed",
                  chunks_count: 1,
                  file_size: size,
                  metadata,
                };
              },
              get() {
                return {
                  async info() {
                    return {
                      id: "provider-item-1",
                      key,
                      status: "completed",
                      chunks_count: 1,
                      file_size: size,
                      metadata,
                    };
                  },
                };
              },
            },
          };
        },
      },
    });
    await expect(port.index(context, "projection-g1", [item])).resolves.toMatchObject({
      state: "DEGRADED",
      shadow_receipt_ref: expect.any(String),
      shadow_readback_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
    });
  });

});
