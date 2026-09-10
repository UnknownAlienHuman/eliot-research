import type {
  OperationReceipt,
  ProjectionItem,
  SourceRevision,
} from "@eliotr/contracts";
import type {
  DeliveryMessage,
  ExecutionLease,
  ExecutionLeaseStore,
} from "@eliotr/platform-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { createProjectionExecutionHandler } from "./executor.js";
import type {
  ManagedProjectionReceipt,
  ProjectionAuthorityPort,
  ProjectionExecutionProfile,
  ProjectionSettlement,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
} from "./types.js";

const A = "3f468ef0dde323a1504435da3aa02d387fc1e9f4f1475b5b3323112017806714";
const B = "b".repeat(64);
const message: DeliveryMessage = {
  protocol: "eliotr.delivery.message.v1",
  message_id: "outbox-1:1",
  topic: "source.revision.admitted",
  payload_ref: "revision-1",
  payload_sha256: A,
  idempotency_key: "projection-1",
  outbox_id: "outbox-1",
  outbox_attempt: 1,
  created_at_ms: 1,
};
const revision: SourceRevision = {
  source_revision_ref: "revision-1",
  source_id: "source-1",
  source_namespace_id: "namespace-1",
  source_owner_system_id: "owner-1",
  source_owner_generation: "owner-generation-1",
  ownership_mode: "immutable_import",
  content_sha256: A,
  object_residency_key_digest: B,
  normalized_artifact_ref: "normalized/manifest.json",
  captured_at: "2026-08-31T12:00:00.000Z",
  parser_profile_generation: "parser-1",
  quality_state: "standard",
  purge_state: "LIVE",
};
const context: ProjectionSourceContext = {
  message,
  intent_ref: { id: "intent-1", revision: 1 },
  job_id: "job-1",
  job_state: "ACCEPTED",
  acceptance_attempt_id: "attempt-1",
  source_revision: revision,
  source_title: "Document",
  source_class: "document",
  instruction_taint: "DATA_ONLY",
  project_membership_ids: [],
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

function terminal(outcome: "SUCCEEDED" | "PARTIAL"): ProjectionTerminalReceipt {
  const receipt: OperationReceipt = {
    receipt_ref: { id: `receipt-${outcome.toLowerCase()}`, revision: 1 },
    intent_ref: context.intent_ref,
    attempt_id: context.acceptance_attempt_id,
    outcome,
    output_refs: [context.job_id, "projection-generation:test"],
    readback_receipt_refs: [],
    reconciliation_required: outcome === "PARTIAL",
    reason_codes: outcome === "PARTIAL" ? ["MANAGED_INDEX_READBACK_FAILED"] : [],
    created_at: "2026-08-31T12:00:00.000Z",
  };
  return {
    receipt,
    receipt_ref: `receipt:${receipt.receipt_ref.id}:1`,
    outcome,
    projection_generation: "projection-test",
  };
}

function leaseStore(): ExecutionLeaseStore {
  const lease: ExecutionLease = {
    operation_id: "projection-execute-1",
    operation_kind: "PROJECTION_EXECUTE",
    lease_owner: "eliotr-projection-executor",
    lease_generation: 1,
    lease_until_ms: 301_000,
    attempt: 1,
    state: "LEASED",
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
  };
  return {
    acquire: vi.fn(async () => lease),
    renew: vi.fn(async () => lease),
    checkpoint: vi.fn(async () => lease),
    complete: vi.fn(async () => ({ ...lease, state: "COMPLETED" as const })),
    fail: vi.fn(async () => ({ ...lease, state: "FAILED" as const })),
    cancel: vi.fn(async () => ({ ...lease, state: "CANCELLED" as const })),
    read: vi.fn(async () => lease),
  };
}

function fixture(input: {
  readonly prior?: ProjectionTerminalReceipt | null;
  readonly managed?: ManagedProjectionReceipt;
  readonly sharded?: boolean;
} = {}) {
  const events: string[] = [];
  let settlement: ProjectionSettlement | undefined;
  const authority: ProjectionAuthorityPort = {
    load: vi.fn(async () => { events.push("load"); return context; }),
    readTerminal: vi.fn(async (_context, _generation, _profile) => input.prior ?? null),
    begin: vi.fn(async () => { events.push("begin"); }),
    recordMaterialized: vi.fn(async () => { events.push("record-materialized"); }),
    settle: vi.fn(async (_context, _generation, _profile, value) => {
      events.push("settle");
      settlement = value;
      return terminal(value.outcome);
    }),
  };
  const workReceipt = {
    manifest_ref: "projection/manifest.json",
    manifest_sha256: A,
    item_set_digest: B,
    item_count: 1,
    item_receipts: [{
      item_key: "item-1",
      object_ref: "projection/item-1.md",
      readback_sha256: A,
      size_bytes: 8,
      etag: "etag-1",
    }],
  } as const;
  const searchReceipt = {
    receipt_ref: "d1-search-receipt-1",
    readback_digest: B,
    item_set_digest: B,
    item_count: 1,
    projection_generation: "projection-test",
  } as const;
  const defaultManaged: ManagedProjectionReceipt = {
    state: "READY",
    receipt_ref: "managed-receipt-1",
    readback_digest: A,
    item_count: 1,
    instance_id: "private-prose-g1",
    managed_generation: "g1",
    reason_codes: [],
  };
  const dependencies = {
    authority,
    content: {
      read: vi.fn(async () => {
        events.push("content");
        return input.sharded
          ? {
              disposition: "SHARDED_WORKFLOW_REQUIRED" as const,
              normalized_object_ref: "normalized/content.md",
              size_bytes: 10_000_000,
              reason_codes: ["SHARDED_WORKFLOW_REQUIRED"] as const,
            }
          : {
              disposition: "READY" as const,
              markdown: "# Heading\n\nText.\n",
              normalized_object_ref: "normalized/content.md",
              readback_sha256: A,
              size_bytes: 17,
            };
      }),
    },
    work: {
      materialize: vi.fn(async (_context: ProjectionSourceContext, _generation: string, projection: { readonly items: readonly ProjectionItem[] }) => {
        events.push("work");
        return {
          ...workReceipt,
          item_count: projection.items.length,
          item_receipts: projection.items.map((item) => ({
            item_key: item.item_key,
            object_ref: `projection/${item.item_key}.md`,
            readback_sha256: item.content_sha256,
            size_bytes: new TextEncoder().encode(item.section_text).byteLength,
            etag: "etag-1",
          })),
        };
      }),
    },
    search: {
      activate: vi.fn(async () => { events.push("search"); return searchReceipt; }),
    },
    managed: {
      index: vi.fn(async () => { events.push("managed"); return input.managed ?? defaultManaged; }),
    },
    leases: leaseStore(),
    profile,
    now: () => 1_000,
  };
  return { dependencies, events, get settlement() { return settlement; } };
}

describe("projection execution coordinator", () => {
  it("materializes, activates D1 Search, verifies managed indexing, then settles success", async () => {
    const f = fixture();
    const result = await createProjectionExecutionHandler(f.dependencies).execute(message);
    expect(result.receipt_ref).toContain("receipt-succeeded");
    expect(f.events).toEqual([
      "load",
      "begin",
      "content",
      "work",
      "record-materialized",
      "search",
      "managed",
      "settle",
    ]);
    expect(f.settlement).toMatchObject({ outcome: "SUCCEEDED", reason_codes: [] });
  });

  it("settles a durable partial result when managed indexing cannot be read back", async () => {
    const managed: ManagedProjectionReceipt = {
      state: "DEGRADED",
      item_count: 1,
      instance_id: "private-prose-g1",
      managed_generation: "g1",
      reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
    };
    const f = fixture({ managed });
    await createProjectionExecutionHandler(f.dependencies).execute(message);
    expect(f.settlement).toMatchObject({
      outcome: "PARTIAL",
      reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
    });
  });

  it("requires a sharded workflow without creating projection or index side effects", async () => {
    const f = fixture({ sharded: true });
    await createProjectionExecutionHandler(f.dependencies).execute(message);
    expect(f.events).toEqual(["load", "begin", "content", "settle"]);
    expect(f.settlement).toEqual({
      outcome: "PARTIAL",
      reason_codes: ["SHARDED_WORKFLOW_REQUIRED"],
    });
  });

  it("returns an exact prior terminal receipt without acquiring a lease", async () => {
    const prior = terminal("SUCCEEDED");
    const f = fixture({ prior });
    const result = await createProjectionExecutionHandler(f.dependencies).execute(message);
    expect(result).toEqual({ receipt_ref: prior.receipt_ref });
    expect(f.events).toEqual(["load"]);
    expect(f.dependencies.leases.acquire).not.toHaveBeenCalled();
  });
});
