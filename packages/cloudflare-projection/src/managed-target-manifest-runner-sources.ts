import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type {
  ManagedRequiredProjectRevisionCopy,
  ManagedRequiredSetReceiptV1,
  ManagedRequiredSetReceiptV2,
  ManagedRequiredSetReceipt,
} from "./managed-required-set.js";
import type {
  ManagedTargetManifestInput,
  ManagedTargetManifestCandidatePayloadV2,
  ManagedTargetManifestProviderEmptyReadback,
  ManagedTargetManifestReadyCandidate,
  ManagedTargetManifestShadowFence,
  ManagedTargetManifestSourceAuthority,
} from "./managed-target-manifest-contract.js";
import {
  MANAGED_TARGET_MANIFEST_CANDIDATE_PROTOCOL_V2,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2,
} from "./managed-target-manifest-contract.js";
import {
  assertManagedTargetProviderCapacity,
  canonicalSourceIdentityDigest,
  MANAGED_TARGET_MANIFEST_PROVIDER_CAPACITY_POLICY,
  readCanonicalManifestObject,
  validateCanonicalSourceProjectionReceipt,
  validateOperationBudgetReceipt,
  type ManagedTargetProviderCapacityReceipt,
} from "./managed-target-manifest-fragments.js";
import type {
  CanonicalProjectionSourceContext,
  CanonicalSourceProjectionReceipt,
} from "./types.js";
import type {
  ManifestInvocationBudget,
} from "./managed-target-manifest-step-support.js";
import {
  MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE,
  MANAGED_TARGET_MANIFEST_SUMMARY_PAGE_SIZE,
  sourceAuthorityDigest,
  shadowFenceDigest,
  type ManifestContinuationState,
} from "./managed-target-manifest-step-support.js";
import { ManagedTargetManifestTreeWriter } from "./managed-target-manifest-tree.js";
import { projectionDigest, projectionSha256Utf8, canonicalProjectionJson, utf8ProjectionBytes } from "./canonical.js";
import { canonicalSourceIndexKey, validateSourceIndex } from "./managed-target-manifest-runner-scans.js";
import {
  assertFreshAuthorityTimestamp,
  CANDIDATE_PROTOCOL,
  IDENTIFIER,
  MANIFEST_PROTOCOL,
  MANIFEST_PROTOCOL_V3,
  SHA256,
  SOURCE_INDEX_PROTOCOL,
  fail,
  putBuildObject,
  sameJson,
  type StoredCanonicalSourceIndex,
} from "./managed-target-manifest-runner-shared.js";
export async function sourceAuthoritiesForCopies(
  input: ManagedTargetManifestInput,
  copies: readonly ManagedRequiredProjectRevisionCopy[],
  asOf: string,
  budget: ManifestInvocationBudget,
): Promise<readonly { readonly authority: ManagedTargetManifestSourceAuthority; readonly digest: string }[]> {
  if (copies.length < 1 || copies.length > MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "source authority batch exceeds the fixed 24-copy microstep envelope");
  }
  budget.reserveOperations(1);
  const read = await input.documents.readAuthorityBatch({
    target: input.target,
    profile: input.profile,
    copies,
    as_of: asOf,
  });
  const receipt = validateOperationBudgetReceipt(read.budget);
  if (receipt.subrequest_upper_bound !== 1) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE", "source authority batch must report exactly one bounded Core read");
  }
  if (!Array.isArray(read.authorities) || read.authorities.length !== copies.length) {
    fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "source authority batch is not positionally complete");
  }
  budget.addOwnerAuthorityRead(copies.length, 1);
  budget.addLocalCpu(receipt.cpu_upper_bound_ms);
  budget.addInputBytes(receipt.input_bytes_upper_bound);
  budget.addRequiredRows(copies.length);
  budget.snapshot(true);
  const output: { readonly authority: ManagedTargetManifestSourceAuthority; readonly digest: string }[] = [];
  for (let index = 0; index < copies.length; index += 1) {
    const copy = copies[index];
    const authority = read.authorities[index];
    if (copy === undefined || authority === undefined) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "source authority batch order or row is invalid");
    }
    output.push({ authority, digest: await sourceAuthorityDigest({ target: input.target, profile: input.profile, copy, authority }) });
  }
  return Object.freeze(output);
}

export async function canonicalSourceForCopy(input: {
  readonly manifest: ManagedTargetManifestInput;
  readonly state: ManifestContinuationState;
  readonly copy: ManagedRequiredProjectRevisionCopy;
  readonly authority: ManagedTargetManifestSourceAuthority;
  readonly profile_sha256: string;
  readonly as_of: string;
  readonly store: EvidenceObjectStore;
  readonly budget: ManifestInvocationBudget;
  readonly require_existing?: boolean;
}): Promise<{ readonly identity: string; readonly receipt: CanonicalSourceProjectionReceipt }> {
  const sourceRevision = input.authority.source_revision;
  const identity = await canonicalSourceIdentityDigest({
    complete_residency_key_sha256: sourceRevision.object_residency_key_digest,
    source_revision_ref: input.copy.source_revision_ref,
    projector_profile_sha256: input.profile_sha256,
  });
  const key = canonicalSourceIndexKey(input.state, identity);
  const existing = await readCanonicalManifestObject(input.store, key);
  if (existing !== null) {
    const indexed = validateSourceIndex(existing.value, key, identity);
    const receipt = await validateCanonicalSourceProjectionReceipt({
      receipt: indexed.receipt,
      source_authority: input.authority,
      copy: input.copy,
      profile: input.manifest.profile,
      projector_profile_sha256: input.profile_sha256,
    });
    return { identity, receipt };
  }
  if (input.require_existing === true) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "completed copy fragment lost its canonical source index reference");
  }
  input.budget.reserveOperations(1);
  const contentRead = await input.manifest.documents.readNormalizedContent({
    target: input.manifest.target,
    profile: input.manifest.profile,
    copy: input.copy,
    source_authority: input.authority,
    as_of: input.as_of,
  });
  const contentBudget = validateOperationBudgetReceipt(contentRead.budget);
  const normalizedBytes = utf8ProjectionBytes(contentRead.normalized_markdown).byteLength;
  if (contentBudget.subrequest_upper_bound !== 1 ||
      contentBudget.input_bytes_upper_bound < normalizedBytes ||
      contentBudget.input_bytes_upper_bound > input.budget.remainingInputBytes() ||
      normalizedBytes !== contentRead.size_bytes ||
      contentRead.readback_sha256 !== sourceRevision.content_sha256 ||
      contentRead.normalized_object_ref !== sourceRevision.normalized_artifact_ref ||
      normalizedBytes > input.manifest.profile.projection_profile.maximum_markdown_bytes) {
    fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "normalized source bytes or exact Evidence readback differ from current Core authority");
  }
  input.budget.addWriter(contentBudget);
  input.budget.snapshot(true);
  const producerBudget = Object.freeze({
    operation_budget_remaining: input.budget.remainingOperations(),
    subrequest_budget_remaining: input.budget.remainingSubrequests(),
    cpu_budget_remaining_ms: input.budget.remainingCpuMilliseconds(),
    input_bytes_budget_remaining: input.budget.remainingInputBytes(),
  });
  const source: CanonicalProjectionSourceContext = Object.freeze({
    source_revision: sourceRevision,
    source_title: input.authority.source_title,
    source_class: input.authority.source_class,
    instruction_taint: input.authority.instruction_taint,
  });
  const result = await input.manifest.canonical_projection.projectCanonicalSource({
    source,
    profile: input.manifest.profile.projection_profile,
    normalized_markdown: contentRead.normalized_markdown,
    ...producerBudget,
  });
  const resultBudget = validateOperationBudgetReceipt(result.budget);
  const canonicalWorkSubrequests = result.receipt.resource_bounds.canonical_r2_subrequest_bound -
    result.receipt.resource_bounds.source_content_r2_get_bound;
  if (resultBudget.subrequest_upper_bound < 1 ||
      resultBudget.subrequest_upper_bound > producerBudget.subrequest_budget_remaining ||
      resultBudget.cpu_upper_bound_ms > producerBudget.cpu_budget_remaining_ms ||
      resultBudget.input_bytes_upper_bound > producerBudget.input_bytes_budget_remaining ||
      canonicalWorkSubrequests < 1 || resultBudget.subrequest_upper_bound !== canonicalWorkSubrequests ||
      result.receipt.resource_bounds.input_utf8_bytes !== normalizedBytes) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "canonical source reader exceeded its supplied operation budget");
  }
  input.budget.addWriter(resultBudget);
  input.budget.snapshot(true);
  const receipt = await validateCanonicalSourceProjectionReceipt({
    receipt: result.receipt,
    source_authority: input.authority,
    copy: input.copy,
    profile: input.manifest.profile,
    projector_profile_sha256: input.profile_sha256,
  });
  const record: StoredCanonicalSourceIndex = Object.freeze({
    protocol: SOURCE_INDEX_PROTOCOL,
    source_identity_sha256: identity,
    receipt,
  });
  const bytes = utf8ProjectionBytes(canonicalProjectionJson(record)).byteLength;
  if (bytes > 64 * 1024) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source receipt exceeds 64 KiB");
  input.budget.addFragmentBytes(bytes);
  await putBuildObject(input.store, key, record, {
    manifest_kind: "managed-target-manifest-canonical-source-ref",
    source_identity_sha256: identity,
    source_revision_ref: input.copy.source_revision_ref,
    residency_key_sha256: sourceRevision.object_residency_key_digest,
  });
  return { identity, receipt };
}

export async function sourceIndexSummaryPage(input: {
  readonly state: ManifestContinuationState;
  readonly input: ManagedTargetManifestInput;
  readonly store: EvidenceObjectStore;
  readonly budget: ManifestInvocationBudget;
}): Promise<ManifestContinuationState["source_summary"]> {
  input.budget.reserveOperations(1);
  const result = await input.input.work_index.list({
    prefix: `${input.state.build_prefix}canonical-sources/`,
    cursor: input.state.source_summary.cursor,
    limit: MANAGED_TARGET_MANIFEST_SUMMARY_PAGE_SIZE,
  });
  input.budget.addR2List();
  if (!Array.isArray(result.objects) || result.objects.length > MANAGED_TARGET_MANIFEST_SUMMARY_PAGE_SIZE) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source index listing exceeded its 256-object bound");
  }
  if (result.truncated && (typeof result.cursor !== "string" || result.cursor.length === 0 ||
      result.cursor === input.state.source_summary.cursor || input.state.source_summary.seen_cursors.includes(result.cursor))) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source index cursor is cyclic or incomplete");
  }
  if (!result.truncated && result.cursor !== null) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "terminal canonical source index page has a continuation cursor");
  }
  let count = input.state.source_summary.count;
  let sectionCount = input.state.source_summary.section_count;
  let sourceDigest = input.state.source_summary.source_set_sha256;
  let sectionDigest = input.state.source_summary.section_set_sha256;
  let lastKey = input.state.source_summary.last_key;
  for (const object of result.objects) {
    if (!object.key.startsWith(`${input.state.build_prefix}canonical-sources/`) ||
        (lastKey !== null && object.key <= lastKey)) {
      fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source index listing escaped scope or lost canonical order");
    }
    const stored = await readCanonicalManifestObject(input.store, object.key);
    if (stored === null) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "listed canonical source index object is absent on exact readback");
    input.budget.addInputBytes(stored.ref.size_bytes);
    const sourceIdentity = object.key.slice(object.key.lastIndexOf("/") + 1, -".json".length);
    if (!SHA256.test(sourceIdentity)) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source identity key is malformed");
    const indexed = validateSourceIndex(stored.value, object.key, sourceIdentity);
    const receipt = indexed.receipt;
    sourceDigest = await projectionSha256Utf8(`${sourceDigest}\n${canonicalProjectionJson({
      source_identity_sha256: sourceIdentity,
      source_revision_ref: receipt.source_revision_ref,
      complete_residency_key_sha256: receipt.complete_residency_key_sha256,
      projector_profile_sha256: receipt.projector_profile_sha256,
      canonical_projection_generation: receipt.canonical_projection_generation,
      canonical_source_ref: receipt.canonical_source_ref,
      canonical_source_sha256: receipt.canonical_source_sha256,
      canonical_section_count: receipt.canonical_section_count,
      canonical_section_set_sha256: receipt.canonical_section_set_sha256,
    })}`);
    sectionDigest = await projectionSha256Utf8(`${sectionDigest}\n${canonicalProjectionJson({
      source_identity_sha256: sourceIdentity,
      canonical_section_set_sha256: receipt.canonical_section_set_sha256,
      canonical_section_count: receipt.canonical_section_count,
    })}`);
    sectionCount += receipt.canonical_section_count;
    count += 1;
    lastKey = object.key;
    input.budget.addItems(receipt.canonical_section_count);
  }
  return Object.freeze({
    cursor: result.truncated ? result.cursor : null,
    seen_cursors: result.truncated && result.cursor !== null
      ? Object.freeze([...input.state.source_summary.seen_cursors, result.cursor])
      : input.state.source_summary.seen_cursors,
    last_key: lastKey,
    count,
    section_count: sectionCount,
    source_set_sha256: sourceDigest,
    section_set_sha256: sectionDigest,
    complete: !result.truncated,
  });
}

export async function sameInitialAndVerifiedReceipt(
  initial: ManagedRequiredSetReceipt,
  verified: ManagedRequiredSetReceipt,
): Promise<boolean> {
  const selectionMatches = "target_selection" in initial
    ? "target_selection" in verified && sameJson(initial.target_selection, verified.target_selection) &&
      initial.target_fence.target_selection_sha256 === verified.target_fence.target_selection_sha256
    : !("target_selection" in verified);
  return selectionMatches && initial.protocol === verified.protocol &&
    initial.required_set_digest === verified.required_set_digest &&
    initial.project_revision_copy_count === verified.project_revision_copy_count &&
    initial.assigned_project_count === verified.assigned_project_count &&
    initial.page_count === verified.page_count &&
    initial.target_fence.digest === verified.target_fence.digest &&
    initial.target_fence.page_provenance_sha256 === verified.target_fence.page_provenance_sha256;
}

export async function readyCandidate(input: {
  readonly state: ManifestContinuationState;
  readonly manifest: ManagedTargetManifestInput;
  readonly store: EvidenceObjectStore;
  readonly budget: ManifestInvocationBudget;
  readonly capacityReceipt: ManagedTargetProviderCapacityReceipt;
  readonly capacityReceiptSha256: string;
  readonly shadowFence: ManagedTargetManifestShadowFence;
  readonly profileSha: string;
  readonly nowMs: number;
}): Promise<ManagedTargetManifestReadyCandidate> {
  const { state, manifest, store, budget, capacityReceipt, capacityReceiptSha256, shadowFence, profileSha, nowMs } = input;
  const requiredSet = state.verified_required_set;
  if (requiredSet === null || !state.source_summary.complete || state.post_source_authority_sha256 === null) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "candidate requested before ordered coverage and source summary completed");
  }
  const targetSelection = state.target_selection;
  if (targetSelection !== undefined) {
    const layout = manifest.profile.copy_layout as string;
    if (layout !== MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2) {
      fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "V2 selection requires the V2 canonical project-copy writer layout");
    }
    if (!("target_selection" in requiredSet) ||
        !sameJson(requiredSet.target_selection, targetSelection) ||
        !sameJson(targetSelection.target, manifest.target) ||
        !sameJson(requiredSet.target, manifest.target)) {
      fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "V2 candidate selection, required-set receipt, and target differ");
    }
  } else if ("target_selection" in requiredSet) {
    fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "V1 candidate cannot carry a V2 required-set receipt");
  }
  const treeWriter = new ManagedTargetManifestTreeWriter(
    store,
    `${state.build_prefix}tree`,
    putBuildObject,
    state.tree_frontier,
  );
  const tree = await treeWriter.finish();
  if (tree === null && state.copy_ordinal !== 0) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "non-empty ordered coverage has no tree root");
  }
  if (tree !== null && (tree.copy_count !== state.copy_ordinal || tree.item_count !== state.desired_item_count)) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "manifest tree count differs from complete copy/item coverage");
  }
  if (state.copy_ordinal !== requiredSet.project_revision_copy_count ||
      state.desired_item_count > state.capacity_limit) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "candidate counts differ from the exact required set or verified capacity");
  }
  let emptyReadback: ManagedTargetManifestProviderEmptyReadback | null = null;
  if (state.copy_ordinal === 0) {
    if (manifest.empty_provider_readback === undefined) {
      fail("MANAGED_TARGET_MANIFEST_EMPTY_PROVIDER_READBACK_REQUIRED", "an exact empty manifest requires stale-provider removal and absence readback authority");
    }
    budget.reserveOperations(1);
    const response = await manifest.empty_provider_readback.readExactEmpty({
      target: manifest.target,
      profile: manifest.profile.target_profile,
      as_of: state.as_of,
      operation_budget_remaining: budget.remainingOperations(),
    });
    if (response.budget.subrequest_upper_bound < 1 ||
        response.budget.subrequest_upper_bound > budget.remainingOperations()) {
      fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "empty provider readback exceeded its supplied operation budget");
    }
    budget.addWriter(response.budget);
    const receipt = response.receipt;
    if (
      receipt.protocol !== "eliotr.managed-target-provider-empty-readback.v1" ||
      !sameJson(receipt.target, manifest.target) || receipt.provider_item_count !== 0 ||
      !Number.isSafeInteger(receipt.stale_provider_removal_count) || receipt.stale_provider_removal_count < 0 ||
      !SHA256.test(receipt.absence_readback_sha256) || !IDENTIFIER.test(receipt.authority_ref) ||
      !SHA256.test(receipt.authority_sha256)
    ) fail("MANAGED_TARGET_MANIFEST_EMPTY_PROVIDER_READBACK_REQUIRED", "empty provider readback does not bind exact target absence");
    assertFreshAuthorityTimestamp(receipt.checked_at, nowMs, "empty provider absence readback");
    emptyReadback = receipt;
  }
  if (shadowFence.expected_item_count !== null && shadowFence.expected_item_count !== state.desired_item_count) {
    fail("MANAGED_TARGET_MANIFEST_EXPECTED_COUNT_MISMATCH", "SEARCH_DB shadow count differs from the exact desired denominator");
  }
  assertManagedTargetProviderCapacity(capacityReceipt, manifest.profile.target_profile, 0, state.desired_item_count);
  const canonicalSourceSummary = Object.freeze({
    protocol: "eliotr.managed-target-canonical-source-summary.v1" as const,
    canonical_projection_generation_count: state.source_summary.count,
    canonical_section_count: state.source_summary.section_count,
    canonical_source_set_sha256: state.source_summary.source_set_sha256,
    canonical_section_set_sha256: state.source_summary.section_set_sha256,
  });
  const providerCopySummary = Object.freeze({
    protocol: "eliotr.managed-target-provider-copy-summary.v1" as const,
    provider_copy_count: state.provider_copy_count,
    provider_copy_set_sha256: state.provider_copy_set_sha256,
    provider_item_count: state.desired_item_count,
    provider_item_set_sha256: state.provider_item_set_sha256,
  });
  const shadowSha = await shadowFenceDigest(shadowFence);
  const capacitySha = capacityReceiptSha256;
  const authoritySha = await projectionDigest({
    protocol: "eliotr.managed-target-manifest-candidate-authority.v1",
    target: manifest.target,
    as_of: state.as_of,
    required_set: requiredSet,
    source_authority_sha256: state.source_authority_sha256,
    post_source_authority_sha256: state.post_source_authority_sha256,
    shadow_fence_sha256: shadowSha,
    capacity_policy: MANAGED_TARGET_MANIFEST_PROVIDER_CAPACITY_POLICY,
    capacity_receipt_sha256: capacitySha,
    empty_provider_readback: emptyReadback,
  });
  const candidatePayload = targetSelection === undefined
    ? {
      protocol: CANDIDATE_PROTOCOL,
      manifest_protocol: MANIFEST_PROTOCOL,
      target: manifest.target,
      target_profile_sha256: state.target_profile_sha256,
      projection_profile_sha256: profileSha,
      copy_layout: manifest.profile.copy_layout,
      as_of: state.as_of,
      required_set: requiredSet as ManagedRequiredSetReceiptV1,
      desired_item_count: state.desired_item_count,
      desired_item_set_sha256: state.desired_item_set_sha256,
      canonical_source_summary: canonicalSourceSummary,
      provider_copy_summary: providerCopySummary,
      source_authority_sha256: state.source_authority_sha256,
      post_source_authority_sha256: state.post_source_authority_sha256,
      shadow_fence_sha256: shadowSha,
      provider_capacity_policy: MANAGED_TARGET_MANIFEST_PROVIDER_CAPACITY_POLICY,
      provider_capacity_receipt_sha256: capacitySha,
      empty_provider_readback: emptyReadback,
      tree,
      authority_sha256: authoritySha,
      finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS" as const,
    }
    : {
      protocol: MANAGED_TARGET_MANIFEST_CANDIDATE_PROTOCOL_V2,
      manifest_protocol: MANIFEST_PROTOCOL_V3,
      target: manifest.target,
      target_profile_sha256: state.target_profile_sha256,
      projection_profile_sha256: profileSha,
      copy_layout: MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2,
      target_selection: targetSelection,
      as_of: state.as_of,
      required_set: requiredSet as ManagedRequiredSetReceiptV2,
      desired_item_count: state.desired_item_count,
      desired_item_set_sha256: state.desired_item_set_sha256,
      canonical_source_summary: canonicalSourceSummary,
      provider_copy_summary: providerCopySummary,
      source_authority_sha256: state.source_authority_sha256,
      post_source_authority_sha256: state.post_source_authority_sha256,
      shadow_fence_sha256: shadowSha,
      provider_capacity_policy: MANAGED_TARGET_MANIFEST_PROVIDER_CAPACITY_POLICY,
      provider_capacity_receipt_sha256: capacitySha,
      empty_provider_readback: emptyReadback,
      tree,
      authority_sha256: authoritySha,
      finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS" as const,
    } satisfies ManagedTargetManifestCandidatePayloadV2;
  const digest = await projectionDigest(candidatePayload);
  const stored = await putBuildObject(
    store,
    `${state.build_prefix}candidates/${digest}.json`,
    candidatePayload,
    { manifest_kind: "managed-target-manifest-non-authoritative-candidate", candidate_sha256: digest },
  );
  if (targetSelection === undefined) {
    if ("target_selection" in requiredSet) {
      fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "V1 candidate receipt cannot carry a V2 required-set receipt");
    }
    return Object.freeze({
      protocol: MANIFEST_PROTOCOL,
      target: manifest.target,
      as_of: state.as_of,
      required_set: requiredSet as ManagedRequiredSetReceiptV1,
      desired_item_count: state.desired_item_count,
      desired_item_set_sha256: state.desired_item_set_sha256,
      canonical_source_summary: canonicalSourceSummary,
      provider_copy_summary: providerCopySummary,
      tree: tree === null ? null : Object.freeze({
        key: tree.key,
        sha256: tree.sha256,
        copy_count: tree.copy_count,
        item_count: tree.item_count,
      }),
      authority_sha256: authoritySha,
      candidate_ref: stored.key,
      candidate_sha256: stored.sha256,
      candidate_size_bytes: stored.size_bytes,
      finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS",
    });
  }
  if (!("target_selection" in requiredSet)) {
    fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "V2 candidate lost its V2 required-set receipt");
  }
  return Object.freeze({
    protocol: MANIFEST_PROTOCOL_V3,
    candidate_protocol: MANAGED_TARGET_MANIFEST_CANDIDATE_PROTOCOL_V2,
    copy_layout: MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2,
    target: manifest.target,
    as_of: state.as_of,
    target_selection: targetSelection,
    required_set: requiredSet,
    desired_item_count: state.desired_item_count,
    desired_item_set_sha256: state.desired_item_set_sha256,
    canonical_source_summary: canonicalSourceSummary,
    provider_copy_summary: providerCopySummary,
    tree: tree === null ? null : Object.freeze({
      key: tree.key,
      sha256: tree.sha256,
      copy_count: tree.copy_count,
      item_count: tree.item_count,
    }),
    authority_sha256: authoritySha,
    candidate_ref: stored.key,
    candidate_sha256: stored.sha256,
    candidate_size_bytes: stored.size_bytes,
    finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS",
  });
}
