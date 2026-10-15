import type {
  OperationReceipt,
  SourceRevision,
} from "@eliotr/contracts";
import type { MarkdownProjectionResult } from "@eliotr/retrieval";
import type {
  DeliveryMessage,
  ExecutionLease,
  ExecutionLeaseStore,
} from "@eliotr/platform-cloudflare";
import { DeliveryRuntimeError } from "@eliotr/platform-cloudflare";
import { describe, expect, it, vi } from "vitest";
import { projectionDigest } from "./canonical.js";
import { createProjectionExecutionHandler } from "./executor.js";
import type {
  CanonicalProjectionResourceBounds,
  CanonicalProjectionSourceContext,
  CanonicalSourceProjectionReceipt,
  ManagedProjectCopyPlan,
  ManagedProjectionReceipt,
  ManagedProjectCopyMapReceipt,
  ManagedProjectCopyTargetReceipt,
  ProjectionAuthorityPort,
  ProjectionExecutionProfile,
  ProjectionSearchReceipt,
  ProjectionSettlement,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
  ProjectionWorkReceipt,
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
  readonly project_membership_ids?: readonly string[];
  readonly work_receipt?: Partial<ProjectionWorkReceipt>;
  readonly search_receipt?: Partial<ProjectionSearchReceipt>;
} = {}) {
  const events: string[] = [];
  let settlement: ProjectionSettlement | undefined;
  const authority: ProjectionAuthorityPort = {
    load: vi.fn(async () => {
      events.push("load");
      return { ...context, project_membership_ids: input.project_membership_ids ?? [] };
    }),
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
      materialize: vi.fn(async (
        _context: CanonicalProjectionSourceContext,
        generation: string,
        projection: MarkdownProjectionResult,
        projectorProfileSha256: string,
        resourceBounds: CanonicalProjectionResourceBounds,
      ) => {
        events.push("work");
        const canonicalSource = {
          protocol: "eliotr.canonical-source-projection.v1" as const,
          source_revision_ref: revision.source_revision_ref,
          complete_residency_key_sha256: revision.object_residency_key_digest,
          projector_profile_sha256: projectorProfileSha256,
          canonical_projection_generation: generation,
          canonical_source_ref: workReceipt.manifest_ref,
          canonical_source_sha256: workReceipt.manifest_sha256,
          canonical_section_count: projection.items.length,
          canonical_section_set_sha256: projection.item_set_digest,
          resource_bounds: resourceBounds,
          sections: projection.items.map((item, index) => {
            const span = projection.spans[index];
            if (span === undefined) throw new Error("projection test span is missing");
            return {
              canonical_item_key: item.item_key,
              canonical_section_id: item.canonical_section_id,
              content_sha256: item.content_sha256,
              normalized_start_byte: span.normalized_start_byte,
              normalized_end_byte: span.normalized_end_byte,
              canonical_body_ref: `projection/${item.item_key}.md`,
              canonical_body_sha256: item.content_sha256,
            };
          }),
        };
        return {
          ...workReceipt,
          item_set_digest: projection.item_set_digest,
          item_count: projection.items.length,
          item_receipts: projection.items.map((item) => ({
            item_key: item.item_key,
            object_ref: `projection/${item.item_key}.md`,
            readback_sha256: item.content_sha256,
            size_bytes: new TextEncoder().encode(item.section_text).byteLength,
            etag: "etag-1",
          })),
          canonical_projection_generation: generation,
          canonical_source: canonicalSource,
          ...input.work_receipt,
        };
      }),
      materializeProjectCopyMapPages: vi.fn(async (
        canonical: CanonicalSourceProjectionReceipt,
        target: ManagedProjectCopyTargetReceipt,
        copies: readonly ManagedProjectCopyMapReceipt[],
      ) => {
        events.push("copy-map");
        const providerCopySetSha256 = await projectionDigest(copies.map((copy) => ({
          project_id: copy.project_id,
          project_membership_id: copy.project_membership_id,
          membership_generation: copy.membership_generation,
          provider_copy_set_sha256: copy.provider_copy_set_sha256,
        })));
        const providerItemSetSha256 = await projectionDigest(copies.flatMap((copy) =>
          copy.items.map((item) => ({
            item_key: item.item_key,
            canonical_section_id: item.canonical_section_id,
            content_sha256: item.content_sha256,
            start: item.normalized_start_byte,
            end: item.normalized_end_byte,
          }))
        ));
        const providerItemCount = copies.reduce((total, copy) => total + copy.provider_item_count, 0);
        const pages = copies.length === 0 ? [] : [{
          page_index: 0,
          page_ref: "projection/copy-page.json",
          page_sha256: B,
          provider_copy_count: copies.length,
          provider_item_count: providerItemCount,
        }];
        return {
          protocol: "eliotr.managed-project-copy-map-set.v1" as const,
          source_revision_ref: canonical.source_revision_ref,
          complete_residency_key_sha256: canonical.complete_residency_key_sha256,
          canonical_projection_generation: canonical.canonical_projection_generation,
          canonical_source_ref: canonical.canonical_source_ref,
          canonical_source_sha256: canonical.canonical_source_sha256,
          target,
          page_count: pages.length,
          page_set_sha256: await projectionDigest(pages),
          provider_copy_count: copies.length,
          provider_copy_set_sha256: providerCopySetSha256,
          provider_item_count: providerItemCount,
          provider_item_set_sha256: providerItemSetSha256,
          resource_bounds: {
            protocol: "eliotr.project-copy-resource-bounds.v1" as const,
            provider_copy_count: copies.length,
            provider_item_count: providerItemCount,
            copy_map_page_count: pages.length,
            copy_map_r2_put_count: pages.length,
            copy_map_r2_subrequest_bound: 2 * pages.length,
            cpu_time_budget_ms: 30_000 as const,
            maximum_subrequest_bound: 10_000 as const,
          },
          pages,
        };
      }),
    },
    search: {
      activate: vi.fn(async (_context, generation, projection) => {
        events.push("search");
        return {
          ...searchReceipt,
          item_set_digest: projection.item_set_digest,
          item_count: projection.items.length,
          projection_generation: generation,
          ...input.search_receipt,
        };
      }),
    },
    managed: {
      index: vi.fn(async (
        _context: ProjectionSourceContext,
        _executionGeneration: string,
        _canonicalGeneration: string,
        copyPlan: ManagedProjectCopyPlan,
      ) => {
        events.push("managed");
        return input.managed ?? { ...defaultManaged, item_count: copyPlan.items.length };
      }),
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
      "copy-map",
      "record-materialized",
      "search",
      "managed",
      "settle",
    ]);
    expect(f.settlement).toMatchObject({ outcome: "SUCCEEDED", reason_codes: [] });
  });

  it("projects one canonical source and maps its body to separate A/B physical provider items", async () => {
    const f = fixture({
      project_membership_ids: [
        "project:project-a:generation:1",
        "project:project-b:generation:1",
      ],
    });
    await createProjectionExecutionHandler(f.dependencies).execute(message);

    const materialization = f.dependencies.work.materialize.mock.calls[0];
    expect(materialization).toBeDefined();
    expect(f.dependencies.work.materialize).toHaveBeenCalledTimes(1);
    expect(materialization?.[0]).not.toHaveProperty("project_membership_ids");
    expect(materialization?.[2].items[0]?.project_membership_ids).toEqual([]);

    const plan = f.dependencies.managed.index.mock.calls[0]?.[3];
    expect(plan?.items).toHaveLength(2);
    expect(new Set(plan?.items.map((item) => item.canonical_body_ref)).size).toBe(1);
    expect(new Set(plan?.items.map((item) => item.provider_key)).size).toBe(2);
    expect(new Set(plan?.items.map((item) => item.canonical_projection_generation)).size).toBe(1);
    expect(f.dependencies.search.activate).toHaveBeenCalledTimes(1);
    expect(f.dependencies.search.activate.mock.calls[0]?.[1])
      .toBe(plan?.items[0]?.canonical_projection_generation);
    expect(f.dependencies.search.activate.mock.calls[0]?.[2].items[0]?.project_membership_ids)
      .toEqual([]);
    expect(f.dependencies.work.materializeProjectCopyMapPages).toHaveBeenCalledTimes(1);
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

  it("rejects a Work receipt whose required item set differs before Search activation", async () => {
    const f = fixture({ work_receipt: { item_set_digest: "0".repeat(64) } });

    await expect(createProjectionExecutionHandler(f.dependencies).execute(message)).rejects.toThrow();
    expect(f.dependencies.authority.recordMaterialized).not.toHaveBeenCalled();
    expect(f.dependencies.search.activate).not.toHaveBeenCalled();
    expect(f.dependencies.managed.index).not.toHaveBeenCalled();
  });

  it("does not invoke managed indexing when the D1 Search receipt has another generation digest", async () => {
    const f = fixture({ search_receipt: { item_set_digest: "0".repeat(64) } });

    await expect(createProjectionExecutionHandler(f.dependencies).execute(message)).rejects.toThrow();
    expect(f.dependencies.search.activate).toHaveBeenCalledOnce();
    expect(f.dependencies.managed.index).not.toHaveBeenCalled();
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

  it("keeps the primary failure and failed terminal readback separate without failing the lease", async () => {
    const f = fixture();
    const primary = new Error("managed provider outcome is uncertain");
    const readback = new Error("terminal receipt store is unavailable");
    vi.spyOn(f.dependencies.content, "read").mockRejectedValue(primary);
    const readTerminal = vi.spyOn(f.dependencies.authority, "readTerminal");
    readTerminal.mockResolvedValueOnce(null);
    readTerminal.mockRejectedValueOnce(readback);

    let observed: unknown;
    try {
      await createProjectionExecutionHandler(f.dependencies).execute(message);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(DeliveryRuntimeError);
    expect(observed).toMatchObject({ code: "DELIVERY_SETTLEMENT_UNCERTAIN" });
    expect((observed as Error & { readonly primary_error: unknown }).primary_error).toBe(primary);
    expect((observed as Error & { readonly reconciliation_error: unknown }).reconciliation_error)
      .toBe(readback);
    expect((observed as Error & { readonly cause: unknown }).cause).toBe(primary);
    expect(f.dependencies.leases.fail).not.toHaveBeenCalled();
  });

  it.each([
    ["null primary and undefined readback", null, undefined],
    ["undefined primary and null readback", undefined, null],
  ])("maps %s without throwing a secondary type error", async (_label, primary, readback) => {
    const f = fixture();
    vi.spyOn(f.dependencies.content, "read").mockRejectedValue(primary);
    const terminalRead = vi.spyOn(f.dependencies.authority, "readTerminal");
    terminalRead.mockResolvedValueOnce(null);
    terminalRead.mockRejectedValueOnce(readback);

    let observed: unknown;
    try {
      await createProjectionExecutionHandler(f.dependencies).execute(message);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(DeliveryRuntimeError);
    expect(observed).toMatchObject({ code: "DELIVERY_SETTLEMENT_UNCERTAIN" });
    expect((observed as Error & { readonly primary_error: unknown }).primary_error).toBe(primary);
    expect(Object.hasOwn(observed as object, "reconciliation_error")).toBe(true);
    expect((observed as Error & { readonly reconciliation_error: unknown }).reconciliation_error)
      .toBe(readback);
    expect(f.dependencies.leases.fail).not.toHaveBeenCalled();
  });

  it("returns the exact terminal receipt found after a processing failure", async () => {
    const f = fixture();
    const prior = terminal("PARTIAL");
    vi.spyOn(f.dependencies.content, "read").mockRejectedValue(new Error("processing failed"));
    const terminalRead = vi.spyOn(f.dependencies.authority, "readTerminal");
    terminalRead.mockResolvedValueOnce(null);
    terminalRead.mockResolvedValueOnce(prior);

    await expect(createProjectionExecutionHandler(f.dependencies).execute(message))
      .resolves.toEqual({ receipt_ref: prior.receipt_ref });
    expect(f.dependencies.leases.complete).toHaveBeenCalledWith(
      expect.objectContaining({ operation_id: "projection-execute-1" }),
      prior.receipt_ref,
      1_000,
    );
    expect(f.dependencies.leases.fail).not.toHaveBeenCalled();
  });
});
