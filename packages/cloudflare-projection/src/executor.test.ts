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
import { projectionDigest, stableProjectionId } from "./canonical.js";
import {
  managedProjectFolderPrefixV2,
  managedProjectGenerationMetadataValue,
} from "./managed-project-path.js";
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
  ProjectionExecutorDependencies,
  ProjectionExecutionProfile,
  ManagedTargetSelectionV2,
  ProjectionServingTargetDeltaPort,
  ProjectCopyScopeV2,
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
    settle: vi.fn(async (_context, generation, _profile, value) => {
      events.push("settle");
      settlement = value;
      return { ...terminal(value.outcome), projection_generation: generation };
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
        scope?: ProjectCopyScopeV2,
      ) => {
        events.push("copy-map");
        const providerCopySetSha256 = await projectionDigest(copies.map((copy) =>
          copy.protocol === "eliotr.managed-project-copy-map.v2"
            ? {
                project_id: copy.project_id,
                project_membership_id: copy.project_membership_id,
                membership_identity_version: copy.membership_identity_version,
                legacy_project_membership_id: copy.membership_identity_version === 1
                  ? copy.legacy_project_membership_id
                  : null,
                stable_project_membership_id: copy.membership_identity_version === 2
                  ? copy.stable_project_membership_id
                  : null,
                membership_revision: copy.membership_identity_version === 2 ? copy.membership_revision : null,
                membership_generation: copy.membership_generation,
                project_membership_generation: copy.project_membership_generation,
                folder_prefix: copy.folder_prefix,
                provider_copy_set_sha256: copy.provider_copy_set_sha256,
              }
            : {
                project_id: copy.project_id,
                project_membership_id: copy.project_membership_id,
                membership_generation: copy.membership_generation,
                provider_copy_set_sha256: copy.provider_copy_set_sha256,
              }
        ));
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
        if (scope !== undefined) {
          const copyMapIndexRef = `projection/${canonical.source_revision_ref}/copy-maps/index/` +
            `${target.managed_generation}/${scope.scope_snapshot_digest}/${providerCopySetSha256}.json`;
          return {
            protocol: "eliotr.managed-project-copy-map-set.v2" as const,
            layout: "PROJECT_COPY_V2" as const,
            source_revision_ref: canonical.source_revision_ref,
            complete_residency_key_sha256: canonical.complete_residency_key_sha256,
            canonical_projection_generation: canonical.canonical_projection_generation,
            canonical_source_ref: canonical.canonical_source_ref,
            canonical_source_sha256: canonical.canonical_source_sha256,
            target,
            target_selection: scope.target_selection,
            scope_snapshot_id: scope.scope_snapshot_id,
            scope_snapshot_revision: scope.scope_snapshot_revision,
            scope_snapshot_digest: scope.scope_snapshot_digest,
            page_count: pages.length,
            page_set_sha256: await projectionDigest(pages),
            copy_map_index_ref: copyMapIndexRef,
            copy_map_index_sha256: B,
            provider_copy_count: copies.length,
            provider_copy_set_sha256: providerCopySetSha256,
            provider_item_count: providerItemCount,
            provider_item_set_sha256: providerItemSetSha256,
            resource_bounds: {
              protocol: "eliotr.project-copy-resource-bounds.v2" as const,
              provider_copy_count: copies.length,
              provider_item_count: providerItemCount,
              copy_map_page_count: pages.length,
              copy_map_index_put_count: 1 as const,
              copy_map_r2_put_count: pages.length + 1,
              copy_map_r2_subrequest_bound: 2 * (pages.length + 1),
              cpu_time_budget_ms: 30_000 as const,
              maximum_subrequest_bound: 10_000 as const,
            },
            pages,
          };
        }
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

function rootSelectedSelections(): readonly ManagedTargetSelectionV2[] {
  const base = {
    protocol: "eliotr.managed-target-selection.v2" as const,
    domain: "MANAGED_SEARCH_PRODUCT" as const,
    decision_version: 2 as const,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
    product_alias: "primary" as const,
    registry_revision: 2,
    registry_artifact_sha256: B,
  };
  const physical = {
    namespace: "ai-search-primary",
    managed_instance_id: profile.managed_instance_id,
    target_profile_identity_sha256: "c".repeat(64),
  };
  return [
    {
      ...base,
      purpose: "ACTIVE",
      target: { ...physical, managed_generation: "g1" },
    },
    {
      ...base,
      purpose: "SHADOW",
      target: { ...physical, managed_generation: "g2" },
    },
  ];
}

async function rootSelectedProjectCopyScopes(
  selections: readonly ManagedTargetSelectionV2[],
): Promise<readonly ProjectCopyScopeV2[]> {
  const projectId = "project-root-selected";
  const stableMembershipId = await stableProjectionId(
    "project-membership",
    JSON.stringify([projectId, revision.source_id]),
  );
  const scopes: ProjectCopyScopeV2[] = [];
  for (const selection of selections) {
    const target = selection.target;
    const folderPrefix = await managedProjectFolderPrefixV2({
      instance_id: target.managed_instance_id,
      projection_generation: target.managed_generation,
      source_revision_ref: revision.source_revision_ref,
      project_id: projectId,
      stable_project_membership_id: stableMembershipId,
      membership_revision: 1,
    });
    scopes.push({
      layout: "PROJECT_COPY_V2",
      scope_snapshot_id: "scope-root-selected-fixture",
      scope_snapshot_revision: 1,
      scope_snapshot_digest: B,
      target,
      generation_metadata_value: await managedProjectGenerationMetadataValue(target.managed_generation),
      representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION",
      target_selection: selection,
      copies: [{
        source_revision_ref: revision.source_revision_ref,
        source_owner_generation: revision.source_owner_generation,
        project_id: projectId,
        project_membership_id: stableMembershipId,
        membership_generation: 1,
        project_membership_generation: 1,
        membership_identity_version: 2,
        stable_project_membership_id: stableMembershipId,
        membership_revision: 1,
        folder_prefix: folderPrefix,
      }],
    });
  }
  return scopes;
}

async function withServingTargetPorts(
  f: ReturnType<typeof fixture>,
  apply?: (input: Parameters<ProjectionServingTargetDeltaPort["apply"]>[0]) => Promise<ManagedProjectionReceipt>,
  copyScopes?: readonly ProjectCopyScopeV2[],
) {
  const selections = rootSelectedSelections();
  const scopes = copyScopes ?? await rootSelectedProjectCopyScopes(selections);
  const originalLoad = f.dependencies.authority.load.bind(f.dependencies.authority);
  f.dependencies.authority.load = vi.fn(async (deliveryMessage) => ({
    ...await originalLoad(deliveryMessage),
    project_copy_scopes_v2: scopes,
  }));
  const applyMock = vi.fn<ProjectionServingTargetDeltaPort["apply"]>(async (input) => {
      f.events.push(`delta-${input.profile.managed_generation_active ? "ACTIVE" : "SHADOW"}`);
      if (apply !== undefined) return apply(input);
      return {
        state: "READY",
        receipt_ref: `managed-${input.profile.managed_generation}`,
        readback_digest: A,
        item_count: input.copy_plan.items.length,
        instance_id: input.profile.managed_instance_id,
        managed_generation: input.profile.managed_generation,
        reason_codes: [],
      };
    });
  const servingTargetDelta: ProjectionServingTargetDeltaPort = { apply: applyMock };
  const dependencies: ProjectionExecutorDependencies = {
    ...f.dependencies,
    serving_target_delta: servingTargetDelta,
  };
  return { dependencies, servingTargetDelta, applyMock, selections };
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

  it("applies one canonical source to the Root-selected ACTIVE and SHADOW", async () => {
    const f = fixture({ project_membership_ids: ["project:project-a:generation:1"] });
    const selected = await withServingTargetPorts(f);

    const result = await createProjectionExecutionHandler(selected.dependencies).execute(message, selected.selections);

    expect(result.receipt_ref).toContain("receipt-succeeded");
    expect(selected.applyMock).toHaveBeenCalledTimes(2);
    const activeCall = selected.applyMock.mock.calls[0]?.[0];
    const shadowCall = selected.applyMock.mock.calls[1]?.[0];
    expect(activeCall?.canonical_source.canonical_source_ref).toBe(shadowCall?.canonical_source.canonical_source_ref);
    expect(activeCall?.copy_plan.items[0]?.canonical_body_ref).toBe(shadowCall?.copy_plan.items[0]?.canonical_body_ref);
    expect(activeCall?.copy_plan.items[0]?.provider_key).not.toBe(shadowCall?.copy_plan.items[0]?.provider_key);
    expect(activeCall?.copy_plan.target.managed_generation).toBe("g1");
    expect(shadowCall?.copy_plan.target.managed_generation).toBe("g2");
    expect(f.dependencies.content.read).toHaveBeenCalledTimes(1);
    expect(f.dependencies.work.materialize).toHaveBeenCalledTimes(1);
    expect(f.dependencies.work.materializeProjectCopyMapPages).toHaveBeenCalledTimes(2);
    expect(f.dependencies.search.activate).toHaveBeenCalledTimes(1);
    expect(f.dependencies.authority.recordMaterialized).toHaveBeenCalledTimes(2);
    expect(f.dependencies.authority.settle).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched Root V2 copy scope before Core, Work, Search, or provider writes", async () => {
    const f = fixture({ project_membership_ids: [] });
    const validScopes = await rootSelectedProjectCopyScopes(rootSelectedSelections());
    const malformedScopes = validScopes.map((scope, index) => index === 0
      ? {
          ...scope,
          copies: scope.copies.map((copy) => ({ ...copy, folder_prefix: "projection/foreign/" })),
        }
      : scope);
    const selected = await withServingTargetPorts(f, undefined, malformedScopes);

    await expect(createProjectionExecutionHandler(selected.dependencies).execute(message, selected.selections)).rejects.toThrow();

    expect(f.dependencies.authority.begin).not.toHaveBeenCalled();
    expect(f.dependencies.work.materialize).not.toHaveBeenCalled();
    expect(f.dependencies.work.materializeProjectCopyMapPages).not.toHaveBeenCalled();
    expect(f.dependencies.search.activate).not.toHaveBeenCalled();
    expect(selected.applyMock).not.toHaveBeenCalled();
  });

  it("continues the ACTIVE write when the SHADOW fails and leaves the delivery unsettled", async () => {
    const f = fixture({ project_membership_ids: ["project:project-a:generation:1"] });
    const selected = await withServingTargetPorts(f, async (input) => {
      if (!input.profile.managed_generation_active) throw new Error("shadow delta failed");
      return {
        state: "READY",
        receipt_ref: "managed-active-g1",
        readback_digest: A,
        item_count: input.copy_plan.items.length,
        instance_id: input.profile.managed_instance_id,
        managed_generation: input.profile.managed_generation,
        reason_codes: [],
      };
    });

    const settleMock = vi.spyOn(f.dependencies.authority, "settle");
    await expect(createProjectionExecutionHandler(selected.dependencies).execute(message, selected.selections))
      .rejects.toMatchObject({ code: "DELIVERY_SETTLEMENT_UNCERTAIN" });

    expect(selected.applyMock).toHaveBeenCalledTimes(2);
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(settleMock.mock.calls[0]?.[2].managed_generation).toBe("g1");
    expect(f.dependencies.leases.fail).toHaveBeenCalledTimes(1);
  });

  it("keeps the ACTIVE partial terminal visible when the SHADOW succeeds", async () => {
    const f = fixture({ project_membership_ids: ["project:project-a:generation:1"] });
    const selected = await withServingTargetPorts(f, async (input) => input.profile.managed_generation_active
      ? {
          state: "DEGRADED",
          item_count: 0,
          instance_id: input.profile.managed_instance_id,
          managed_generation: input.profile.managed_generation,
          reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
        }
      : {
          state: "READY",
          receipt_ref: "managed-shadow-g2",
          readback_digest: A,
          item_count: input.copy_plan.items.length,
          instance_id: input.profile.managed_instance_id,
          managed_generation: input.profile.managed_generation,
          reason_codes: [],
        });
    const settleMock = vi.spyOn(f.dependencies.authority, "settle");

    const result = await createProjectionExecutionHandler(selected.dependencies).execute(message, selected.selections);

    expect(result.receipt_ref).toContain("receipt-partial");
    expect(settleMock.mock.calls.map((call) => [call[2].managed_generation, call[3].outcome])).toEqual([
      ["g1", "PARTIAL"],
      ["g2", "SUCCEEDED"],
    ]);
  });

  it("reconciles a duplicate Queue delivery from both target terminal receipts without repeating provider effects", async () => {
    const f = fixture({ project_membership_ids: ["project:project-a:generation:1"] });
    const selected = await withServingTargetPorts(f);
    const terminalByGeneration = new Map<string, ProjectionTerminalReceipt>();
    vi.spyOn(f.dependencies.authority, "readTerminal").mockImplementation(async (_context, generation) =>
      terminalByGeneration.get(generation) ?? null);
    const settleMock = vi.spyOn(f.dependencies.authority, "settle").mockImplementation(async (_context, generation, _profile, value) => {
      const stored = {
        ...terminal(value.outcome),
        receipt_ref: `terminal:${generation}`,
        projection_generation: generation,
      };
      terminalByGeneration.set(generation, stored);
      return stored;
    });
    const handler = createProjectionExecutionHandler(selected.dependencies);

    const first = await handler.execute(message, selected.selections);
    const replay = await handler.execute(message, selected.selections);

    expect(first.receipt_ref).toBe(replay.receipt_ref);
    expect(selected.applyMock).toHaveBeenCalledTimes(2);
    expect(settleMock).toHaveBeenCalledTimes(2);
    expect(f.dependencies.content.read).toHaveBeenCalledTimes(1);
    expect(f.dependencies.work.materialize).toHaveBeenCalledTimes(1);
    expect(f.dependencies.search.activate).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost ACTIVE settlement acknowledgement before moving to the SHADOW", async () => {
    const f = fixture({ project_membership_ids: ["project:project-a:generation:1"] });
    const selected = await withServingTargetPorts(f);
    const terminalByGeneration = new Map<string, ProjectionTerminalReceipt>();
    vi.spyOn(f.dependencies.authority, "readTerminal").mockImplementation(async (_context, generation) =>
      terminalByGeneration.get(generation) ?? null);
    let loseActiveAck = true;
    const settleMock = vi.spyOn(f.dependencies.authority, "settle").mockImplementation(async (_context, generation, targetProfile, value) => {
      const stored = {
        ...terminal(value.outcome),
        receipt_ref: `terminal:${generation}`,
        projection_generation: generation,
      };
      terminalByGeneration.set(generation, stored);
      if (targetProfile.managed_generation === "g1" && loseActiveAck) {
        loseActiveAck = false;
        throw new Error("ACTIVE terminal write acknowledgement was lost");
      }
      return stored;
    });

    const result = await createProjectionExecutionHandler(selected.dependencies).execute(message, selected.selections);

    expect(result.receipt_ref).toContain("terminal:");
    expect(selected.applyMock).toHaveBeenCalledTimes(2);
    expect(settleMock).toHaveBeenCalledTimes(2);
    expect(f.dependencies.authority.readTerminal).toHaveBeenCalledTimes(3);
    expect(f.dependencies.leases.complete).toHaveBeenCalledTimes(2);
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
