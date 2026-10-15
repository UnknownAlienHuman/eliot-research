import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import { projectionDigest } from "./canonical.js";
import { AI_SEARCH_PRIMARY_PROJECTION_PROFILE } from "./ai-search-primary-profile.js";
import { aiSearchPhysicalProfileDigest } from "./ai-search-profile-identity-digest.js";
import {
  advanceManagedTargetManifest,
  type ManagedTargetManifestProfile,
} from "./managed-target-manifest.js";
import {
  MANAGED_TARGET_FREE_FILE_LIMIT,
  MANAGED_TARGET_HYBRID_FILE_LIMIT,
  assertManagedTargetProviderCapacity,
  validateManagedTargetProviderCapacityReceipt,
} from "./managed-target-manifest-fragments.js";
import { foldManagedTargetManifestPage, initialManagedTargetManifestScan } from "./managed-target-manifest-continuation.js";
import { validateManifestProfile, validateShadowFence } from "./managed-target-manifest-step-support.js";
import { AS_OF, SHA_A, copy, runToReady, setup, shadowFence } from "./managed-target-manifest-test-support.js";

describe("managed target manifest continuation", () => {
  it("batches 24 durable microsteps inside one Workflow invocation and reuses readback on replay", async () => {
    const state = await setup(Array.from({ length: 270 }, (_, index) => ({
      project_id: `project-${String(index).padStart(2, "0")}`,
      source_id: "source-shared",
    })));
    let step = await advanceManagedTargetManifest(state.input);
    while (step.phase !== "BUILD_SCAN") {
      if (step.continuation === null) throw new Error("manifest ended before its build scan");
      step = await advanceManagedTargetManifest({ ...state.input, continuation: step.continuation });
    }
    if (step.continuation === null) throw new Error("build continuation is missing");

    const buildInput = { ...state.input, continuation: step.continuation };
    const firstBatch = await advanceManagedTargetManifest(buildInput);
    expect(firstBatch.status).toBe("CONTINUE");
    expect(firstBatch.budget.maximums.copies_processed).toBe(24);
    expect(firstBatch.budget.maximums.microsteps_processed).toBe(24);
    expect(firstBatch.budget.invocation_index).toBe(3);
    expect(firstBatch.budget.calls.core_d1).toBe(2);
    expect(firstBatch.budget.calls.core_d1_statements).toBe(25);
    expect(firstBatch.budget.calls.owner_authority_reads).toBe(24);
    if (firstBatch.continuation === null) throw new Error("first batch continuation is missing");
    const durable = JSON.parse(state.store.objects.get(firstBatch.continuation.ref) ?? "null") as {
      readonly copy_ordinal?: number;
      readonly budget_summary?: { readonly workflow_step_count?: number; readonly microstep_count?: number };
    };
    expect(durable.copy_ordinal).toBe(24);
    expect(durable.budget_summary).toMatchObject({ workflow_step_count: 3, microstep_count: 26 });

    const writerMapCalls = state.counters.copyMapReads;
    const canonicalProjectionCalls = state.counters.canonicalReads;
    const copyPuts = state.store.putKeys.filter((key) => key.includes("/copies/")).length;
    const pagePuts = state.store.putKeys.filter((key) => key.includes("/pages/")).length;
    const replay = await advanceManagedTargetManifest(buildInput);
    expect(replay.budget.invocation_index).toBe(firstBatch.budget.invocation_index);
    expect(replay.budget.maximums.microsteps_processed).toBe(24);
    expect(replay.budget.calls.core_d1).toBe(2);
    expect(replay.budget.calls.core_d1_statements).toBe(25);
    expect(state.counters.copyMapReads).toBe(writerMapCalls);
    expect(state.counters.canonicalReads).toBe(canonicalProjectionCalls);
    expect(state.store.putKeys.filter((key) => key.includes("/copies/")).length).toBe(copyPuts);
    expect(state.store.putKeys.filter((key) => key.includes("/pages/")).length).toBe(pagePuts);

    const budgets = [firstBatch.budget, replay.budget];
    let beforeBoundary = replay;
    const readCopyOrdinal = (receipt: typeof replay) => {
      if (receipt.continuation === null) throw new Error("build continuation is missing");
      const value = JSON.parse(state.store.objects.get(receipt.continuation.ref) ?? "null") as { readonly copy_ordinal?: number };
      if (!Number.isSafeInteger(value.copy_ordinal)) throw new Error("durable copy ordinal is missing");
      return value.copy_ordinal as number;
    };
    while (readCopyOrdinal(beforeBoundary) < 240) {
      if (beforeBoundary.continuation === null) throw new Error("build continuation is missing");
      beforeBoundary = await advanceManagedTargetManifest({ ...state.input, continuation: beforeBoundary.continuation });
      budgets.push(beforeBoundary.budget);
    }
    expect(readCopyOrdinal(beforeBoundary)).toBe(240);
    if (beforeBoundary.continuation === null) throw new Error("page-boundary continuation is missing");
    const boundaryInput = { ...state.input, continuation: beforeBoundary.continuation };
    const boundaryBatch = await advanceManagedTargetManifest(boundaryInput);
    budgets.push(boundaryBatch.budget);
    expect(boundaryBatch.budget.maximums.copies_processed).toBe(24);
    expect(boundaryBatch.budget.calls.core_d1).toBe(2);
    expect(boundaryBatch.budget.calls.core_d1_statements).toBe(25);
    expect(readCopyOrdinal(boundaryBatch)).toBe(264);
    const boundaryWriterCalls = state.counters.copyMapReads;
    const boundaryReplay = await advanceManagedTargetManifest(boundaryInput);
    budgets.push(boundaryReplay.budget);
    expect(state.counters.copyMapReads).toBe(boundaryWriterCalls);

    let next = boundaryReplay;
    while (next.status === "CONTINUE") {
      if (next.continuation === null) throw new Error("continuation receipt is missing");
      next = await advanceManagedTargetManifest({ ...state.input, continuation: next.continuation });
      budgets.push(next.budget);
    }
    expect(next.status).toBe("READY_FOR_FINALIZATION");
    expect(budgets.some((budget) => budget.maximums.copies_processed === 24)).toBe(true);
    expect(budgets.every((budget) => budget.maximums.microsteps_processed <= 24 &&
      budget.subrequest_upper_bound < 10_000 && budget.cpu_upper_bound_ms < 30_000)).toBe(true);
  });

  it("resumes exact Work checkpoints and reuses a completed copy without reprojection", async () => {
    const state = await setup([{ project_id: "project-a", source_id: "source-a" }]);
    let step = await advanceManagedTargetManifest(state.input);
    const seenBudgets = [step.budget];
    while (step.phase !== "BUILD_SCAN") {
      if (step.continuation === null) throw new Error("manifest ended before its build scan");
      step = await advanceManagedTargetManifest({ ...state.input, continuation: step.continuation });
      seenBudgets.push(step.budget);
    }
    if (step.continuation === null) throw new Error("build continuation is missing");
    const buildInput = { ...state.input, continuation: step.continuation };
    const firstBuild = await advanceManagedTargetManifest(buildInput);
    seenBudgets.push(firstBuild.budget);
    const copyReadCount = state.counters.copyMapReads;
    const canonicalReadCount = state.counters.canonicalReads;
    const copyObjectPuts = state.store.putKeys.filter((key) => key.includes("/copies/")).length;

    const restartedBuild = await advanceManagedTargetManifest(buildInput);
    seenBudgets.push(restartedBuild.budget);
    expect(state.counters.copyMapReads).toBe(copyReadCount);
    expect(state.counters.canonicalReads).toBe(canonicalReadCount);
    expect(state.store.putKeys.filter((key) => key.includes("/copies/")).length).toBe(copyObjectPuts);

    if (restartedBuild.continuation === null) throw new Error("replayed build continuation is missing");
    const ready = await runToReady({ ...state.input, continuation: restartedBuild.continuation });
    seenBudgets.push(ready.budget);
    expect(ready.candidate).toMatchObject({
      protocol: "eliotr.managed-target-desired-items.v2",
      desired_item_count: 1,
      finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS",
    });
    expect(seenBudgets.every((budget) => budget.operation_upper_bound <= 386 && budget.subrequest_upper_bound < 10_000 && budget.cpu_upper_bound_ms < 30_000)).toBe(true);
  });

  it("projects one source once and binds two project copies to the same canonical body refs", async () => {
    const state = await setup([
      { project_id: "project-a", source_id: "source-shared" },
      { project_id: "project-b", source_id: "source-shared" },
    ]);
    const ready = await runToReady(state.input);

    expect(state.counters.canonicalReads).toBe(1);
    expect(state.counters.copyMapReads).toBe(2);
    expect(ready.candidate?.canonical_source_summary).toMatchObject({
      canonical_projection_generation_count: 1,
      canonical_section_count: 1,
    });
    expect(ready.candidate?.provider_copy_summary).toMatchObject({
      provider_copy_count: 2,
      provider_item_count: 2,
    });

    const copyFragments = [...state.store.objects.entries()]
      .filter(([key]) => key.includes("/copies/"))
      .map(([, json]) => JSON.parse(json) as {
        readonly provider_copy_map: {
          readonly items: readonly {
            readonly canonical_item_key: string;
            readonly canonical_body_ref: string;
            readonly provider_key: string;
          }[];
        };
      });
    const mappedItems = copyFragments.flatMap((fragment) => fragment.provider_copy_map.items);
    expect(copyFragments).toHaveLength(2);
    expect(mappedItems).toHaveLength(2);
    expect(new Set(mappedItems.map((item) => item.canonical_item_key)).size).toBe(1);
    expect(new Set(mappedItems.map((item) => item.canonical_body_ref)).size).toBe(1);
    expect(new Set(mappedItems.map((item) => item.provider_key)).size).toBe(2);
    expect(copyFragments.every((fragment) => !JSON.stringify(fragment).includes("section_text"))).toBe(true);
  });

  it("fails closed on missing trusted capacity before required-set reads or Work writes", async () => {
    const state = await setup([{ project_id: "project-a", source_id: "source-a" }], { unavailableCapacity: true });
    await expect(advanceManagedTargetManifest(state.input)).rejects.toMatchObject({
      code: "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE",
    });
    expect(state.counters.pageReads).toBe(0);
    expect(state.store.objects.size).toBe(0);
  });

  it("rejects a fresh profile readback whose physical index method differs from assignment", async () => {
    const targetProfile = {
      ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
      index_method: {
        ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method,
        keyword: !AI_SEARCH_PRIMARY_PROJECTION_PROFILE.index_method.keyword,
      },
    } as AiSearchInstanceProfile;
    const state = await setup([{ project_id: "project-a", source_id: "source-a" }], {
      profileReadback: targetProfile,
    });
    await expect(advanceManagedTargetManifest(state.input)).rejects.toMatchObject({
      code: "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID",
    });
    expect(state.counters.pageReads).toBe(0);
    expect(state.store.objects.size).toBe(0);
  });

  it("rejects the exact 102400-row ceiling without a terminal empty page proof", async () => {
    const state = await setup([{ project_id: "project-a", source_id: "source-a" }]);
    const fence = {
      assignment_heads_sha256: SHA_A,
      assigned_project_count: 102_400,
      stale_assignment_count: 0,
      profile_mismatch_count: 0,
    };
    const scan = await initialManagedTargetManifestScan(state.input.target, AS_OF, fence);
    const atLimit = {
      ...scan,
      pages: 400,
      count: 102_400,
      after: {
        project_id: "project-z",
        source_id: "source-z",
        membership_generation: 1,
        source_revision_ref: "revision-z",
      },
    };
    const terminal = await foldManagedTargetManifestPage(
      atLimit,
      { rows: [], next_cursor: null },
      state.input.target,
      AS_OF,
    );
    expect(terminal.state.pages).toBe(401);
    await expect(foldManagedTargetManifestPage(
      atLimit,
      { rows: [copy("project-z", "source-z", state.input.target)], next_cursor: null },
      state.input.target,
      AS_OF,
    )).rejects.toMatchObject({ code: "MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED" });
  });

  it("distinguishes physical identity from exact legacy assignment hashes", async () => {
    const state = await setup([]);
    const profile = state.input.profile;
    const logicalTarget = {
      ...state.input.target,
      managed_generation: "logical-generation-b",
      target_profile_identity_sha256: await aiSearchPhysicalProfileDigest(profile.target_profile),
    };
    const logicalProfile: ManagedTargetManifestProfile = {
      ...profile,
      projection_profile: { ...profile.projection_profile, managed_generation: "logical-generation-b" },
    };
    const physical = await validateManifestProfile({ target: logicalTarget, profile: logicalProfile });
    expect(physical.target_profile_sha256).toBe(logicalTarget.target_profile_identity_sha256);
    expect(() => validateShadowFence(shadowFence({
      registry_revision: 1,
      registry_sha256: SHA_A,
      generation_state: "SHADOW_BUILDING",
      generation_profile_identity_sha256: physical.target_profile_sha256,
      expected_item_count: 0,
    }), logicalTarget, physical.target_profile_sha256)).not.toThrow();

    const legacyHash = await projectionDigest(profile.target_profile);
    const legacyTarget = { ...state.input.target, target_profile_identity_sha256: legacyHash };
    await expect(validateManifestProfile({ target: legacyTarget, profile })).resolves.toMatchObject({
      target_profile_sha256: await aiSearchPhysicalProfileDigest(profile.target_profile),
    });
    await expect(validateManifestProfile({
      target: { ...legacyTarget, managed_generation: "logical-generation-b" },
      profile: logicalProfile,
    })).rejects.toMatchObject({ code: "MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH" });
  });

  it("keeps documented file ceilings separate from account tier authority", async () => {
    const state = await setup([]);
    const profile = state.input.profile.target_profile;
    const free = await validateManagedTargetProviderCapacityReceipt({
      protocol: "eliotr.managed-target-provider-capacity.v1",
      account_tier: "FREE",
      account_authority_ref: "fixture:verified-free-tier",
      account_authority_sha256: SHA_A,
      checked_at: AS_OF,
      max_files_per_instance: MANAGED_TARGET_FREE_FILE_LIMIT,
      documentation_modified_on: "2026-10-01",
    }, profile);
    expect(free.max_files_per_instance).toBe(100_000);
    expect(() => assertManagedTargetProviderCapacity(free, profile, 100_000, 1)).toThrow("TARGET_CAPACITY_EXCEEDED");
    await expect(validateManagedTargetProviderCapacityReceipt({
      ...free,
      max_files_per_instance: MANAGED_TARGET_HYBRID_FILE_LIMIT,
    }, profile)).rejects.toThrow("CAPACITY_AUTHORITY_INVALID");
  });
});
