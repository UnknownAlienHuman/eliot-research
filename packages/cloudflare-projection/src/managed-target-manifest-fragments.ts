import {
  bufferBounded,
  type AiSearchInstanceProfile,
  type EvidenceObjectStore,
} from "@eliotr/platform-cloudflare";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";
import type {
  ManagedTargetManifestOperationBudgetReceipt,
  ManagedTargetManifestProfile,
  ManagedTargetManifestSourceAuthority,
} from "./managed-target-manifest-contract.js";
import type { ManagedRequiredProjectRevisionCopy } from "./managed-required-set.js";
import type {
  CanonicalSourceProjectionReceipt,
  ManagedProjectCopyMapPageV1,
  ManagedProjectCopyMapReceiptV1,
  ManagedProjectCopyMapSetReceiptV1,
  ManagedProjectCopyTargetReceipt,
} from "./types.js";
import { buildCanonicalProjectCopyMaps } from "./core-managed-item-intent.js";
import {
  canonicalProjectionJson,
  projectionByteStream,
  projectionDigest,
  projectionSha256Utf8,
  stableProjectionId,
  utf8ProjectionBytes,
} from "./canonical.js";

export const MANAGED_TARGET_MANIFEST_FRAGMENT_PROTOCOL =
  "eliotr.managed-target-manifest-fragment.v1" as const;
export const MANAGED_TARGET_MANIFEST_PROVIDER_CAPACITY_POLICY =
  "eliotr.ai-search-file-capacity-cloudflare-2026-10-01.v1" as const;

/** Published Cloudflare AI Search ceilings, retrieved 2026-10-14 from the 2026-10-01 limits page. */
export const MANAGED_TARGET_FREE_FILE_LIMIT = 100_000;
export const MANAGED_TARGET_HYBRID_FILE_LIMIT = 500_000;
export const MANAGED_TARGET_VECTOR_ONLY_FILE_LIMIT = 1_000_000;
export const MANAGED_TARGET_MANIFEST_FRAGMENT_MAX_BYTES = 2 * 1024 * 1024;
export const MANAGED_TARGET_CANONICAL_SOURCE_RECEIPT_MAX_BYTES = 64 * 1024;

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface ManagedTargetProviderCapacityReceipt {
  readonly protocol: "eliotr.managed-target-provider-capacity.v1";
  readonly account_tier: "FREE" | "PAID";
  readonly account_authority_ref: string;
  readonly account_authority_sha256: string;
  readonly checked_at: string;
  readonly max_files_per_instance: number;
  readonly documentation_modified_on: "2026-10-01";
}

export interface ManagedTargetProviderCapacityAuthorityPort {
  /**
   * Must return current trusted account-tier evidence and a fresh provider profile readback.
   * The readback identity is compared against the assigned physical profile before its index
   * method selects a documented file ceiling; a dashboard screenshot is not runtime authority.
   */
  read(
    target: ManagedTargetIdentity,
    profile: AiSearchInstanceProfile,
  ): Promise<{
    readonly receipt: unknown;
    readonly profile_readback: AiSearchInstanceProfile;
    readonly profile_authority_ref: string;
    readonly profile_authority_sha256: string;
    readonly profile_readback_checked_at: string;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  }>;
}

export interface ManagedTargetManifestObjectRef {
  readonly key: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

export async function sourceResidencyWorkPrefix(sourceRevisionRef: string): Promise<string> {
  const digest = await projectionSha256Utf8(["source", sourceRevisionRef].join("\u0000"));
  return `projection/${digest.slice(0, 48)}/`;
}

export async function canonicalSourceIdentityDigest(input: {
  readonly complete_residency_key_sha256: string;
  readonly source_revision_ref: string;
  readonly projector_profile_sha256: string;
}): Promise<string> {
  return projectionDigest({ protocol: "eliotr.canonical-source-reuse-identity.v1", ...input });
}

export function managedRequiredCopyIdentity(copy: ManagedRequiredProjectRevisionCopy): Readonly<Record<string, unknown>> {
  if (copy.project_membership_identity_version === 2) {
    return Object.freeze({
      project_id: copy.project_id,
      project_membership_id: copy.stable_project_membership_id,
      membership_revision: copy.membership_revision,
      source_id: copy.source_id,
      source_revision_ref: copy.source_revision_ref,
    });
  }
  return Object.freeze({
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    membership_generation: copy.membership_generation,
    source_id: copy.source_id,
    source_revision_ref: copy.source_revision_ref,
  });
}

export async function validateManagedTargetProviderCapacityReceipt(
  value: unknown,
  profile: AiSearchInstanceProfile,
): Promise<ManagedTargetProviderCapacityReceipt> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE: trusted current tier receipt is missing");
  }
  const raw = value as Record<string, unknown>;
  const keys = [
    "protocol", "account_tier", "account_authority_ref", "account_authority_sha256",
    "checked_at", "max_files_per_instance", "documentation_modified_on",
  ].sort();
  if (Object.keys(raw).sort().join("\n") !== keys.join("\n")) {
    throw new Error("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID: receipt fields are not exact");
  }
  if (
    raw.protocol !== "eliotr.managed-target-provider-capacity.v1" ||
    (raw.account_tier !== "FREE" && raw.account_tier !== "PAID") ||
    typeof raw.account_authority_ref !== "string" || !IDENTIFIER.test(raw.account_authority_ref) ||
    typeof raw.account_authority_sha256 !== "string" || !SHA256.test(raw.account_authority_sha256) ||
    typeof raw.checked_at !== "string" || !Number.isFinite(Date.parse(raw.checked_at)) ||
    new Date(raw.checked_at).toISOString() !== raw.checked_at ||
    !Number.isSafeInteger(raw.max_files_per_instance) ||
    raw.documentation_modified_on !== "2026-10-01"
  ) {
    throw new Error("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID: receipt is malformed");
  }
  const receipt = Object.freeze({
    protocol: "eliotr.managed-target-provider-capacity.v1" as const,
    account_tier: raw.account_tier,
    account_authority_ref: raw.account_authority_ref,
    account_authority_sha256: raw.account_authority_sha256,
    checked_at: raw.checked_at,
    max_files_per_instance: raw.max_files_per_instance as number,
    documentation_modified_on: "2026-10-01" as const,
  }) as ManagedTargetProviderCapacityReceipt;
  managedTargetProviderFileLimit(receipt, profile);
  return receipt;
}

export function managedTargetProviderFileLimit(
  receipt: ManagedTargetProviderCapacityReceipt,
  profile: AiSearchInstanceProfile,
): number {
  const expected = receipt.account_tier === "FREE"
    ? MANAGED_TARGET_FREE_FILE_LIMIT
    : profile.index_method.keyword
      ? MANAGED_TARGET_HYBRID_FILE_LIMIT
      : profile.index_method.vector
        ? MANAGED_TARGET_VECTOR_ONLY_FILE_LIMIT
        : null;
  if (
    receipt.protocol !== "eliotr.managed-target-provider-capacity.v1" ||
    !IDENTIFIER.test(receipt.account_authority_ref) || !SHA256.test(receipt.account_authority_sha256) ||
    !Number.isFinite(Date.parse(receipt.checked_at)) ||
    new Date(receipt.checked_at).toISOString() !== receipt.checked_at ||
    receipt.documentation_modified_on !== "2026-10-01" || expected === null ||
    receipt.max_files_per_instance !== expected
  ) {
    throw new Error("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID: tier/limit differs from the immutable profile and published plan ceiling");
  }
  return expected;
}

export function assertManagedTargetProviderCapacity(
  receipt: ManagedTargetProviderCapacityReceipt,
  profile: AiSearchInstanceProfile,
  currentFileCount: number,
  additionalFileCount: number,
): void {
  const limit = managedTargetProviderFileLimit(receipt, profile);
  if (
    !Number.isSafeInteger(currentFileCount) || currentFileCount < 0 ||
    !Number.isSafeInteger(additionalFileCount) || additionalFileCount < 0 ||
    currentFileCount > limit - additionalFileCount
  ) {
    throw new Error(`TARGET_CAPACITY_EXCEEDED: desired AI Search file count exceeds the qualified ${limit} file ceiling`);
  }
}

export function validateOperationBudgetReceipt(
  value: ManagedTargetManifestOperationBudgetReceipt,
): ManagedTargetManifestOperationBudgetReceipt {
  if (
    typeof value !== "object" || value === null ||
    value.protocol !== "eliotr.managed-target-operation-budget.v1" ||
    !Number.isSafeInteger(value.subrequest_upper_bound) || value.subrequest_upper_bound < 0 ||
    value.subrequest_upper_bound >= 10_000 ||
    !Number.isSafeInteger(value.cpu_upper_bound_ms) || value.cpu_upper_bound_ms < 0 || value.cpu_upper_bound_ms >= 30_000 ||
    !Number.isSafeInteger(value.input_bytes_upper_bound) || value.input_bytes_upper_bound < 0 ||
    value.input_bytes_upper_bound > 4 * 1024 * 1024
  ) {
    throw new Error("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE: operation has no accepted bounded budget receipt");
  }
  return value;
}

export async function validateCanonicalSourceProjectionReceipt(input: {
  readonly receipt: CanonicalSourceProjectionReceipt;
  readonly source_authority: ManagedTargetManifestSourceAuthority;
  readonly copy: ManagedRequiredProjectRevisionCopy;
  readonly profile: ManagedTargetManifestProfile;
  readonly projector_profile_sha256: string;
}): Promise<CanonicalSourceProjectionReceipt> {
  const { receipt, source_authority: authority, copy, profile } = input;
  const prefix = await sourceResidencyWorkPrefix(copy.source_revision_ref);
  const bounds = receipt.resource_bounds;
  if (
    receipt.protocol !== "eliotr.canonical-source-projection.v1" ||
    receipt.source_revision_ref !== copy.source_revision_ref ||
    receipt.complete_residency_key_sha256 !== authority.source_revision.object_residency_key_digest ||
    receipt.complete_residency_key_sha256 !== input.source_authority.source_revision.object_residency_key_digest ||
    receipt.projector_profile_sha256 !== input.projector_profile_sha256 ||
    !IDENTIFIER.test(receipt.canonical_projection_generation) ||
    !receipt.canonical_source_ref.startsWith(prefix) ||
    !SHA256.test(receipt.canonical_source_sha256) ||
    !SHA256.test(receipt.canonical_section_set_sha256) ||
    !Number.isSafeInteger(receipt.canonical_section_count) ||
    receipt.canonical_section_count < 1 ||
    receipt.canonical_section_count > profile.projection_profile.maximum_synchronous_items ||
    !Array.isArray(receipt.sections) || receipt.sections.length !== receipt.canonical_section_count ||
    bounds.protocol !== "eliotr.canonical-source-resource-bounds.v1" ||
    !Number.isSafeInteger(bounds.input_utf8_bytes) || bounds.input_utf8_bytes < 1 ||
    bounds.input_utf8_bytes > profile.projection_profile.maximum_markdown_bytes ||
    bounds.maximum_input_utf8_bytes !== profile.projection_profile.maximum_markdown_bytes ||
    bounds.section_count !== receipt.canonical_section_count ||
    bounds.maximum_section_count !== profile.projection_profile.maximum_synchronous_items ||
    !Number.isSafeInteger(bounds.largest_section_utf8_bytes) || bounds.largest_section_utf8_bytes < 1 ||
    bounds.maximum_section_utf8_bytes !== profile.projection_profile.maximum_item_utf8_bytes ||
    bounds.largest_section_utf8_bytes > bounds.maximum_section_utf8_bytes ||
    bounds.canonical_body_put_count !== receipt.canonical_section_count ||
    bounds.canonical_manifest_put_count !== 1 ||
    bounds.maximum_provider_copy_count !== 256 ||
    bounds.maximum_provider_item_count < receipt.canonical_section_count ||
    bounds.maximum_copy_map_page_count !== 256 ||
    bounds.cpu_time_budget_ms !== 30_000 ||
    bounds.source_content_r2_get_bound !== 1 ||
    bounds.canonical_r2_subrequest_bound !== 1 + 2 * (receipt.canonical_section_count + 1) ||
    bounds.canonical_r2_subrequest_bound >= 10_000 ||
    bounds.maximum_subrequest_bound !== 10_000
  ) {
    throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: canonical source receipt is outside the source-residency/profile identity");
  }
  const sourceBytes = canonicalProjectionJson(receipt);
  if (utf8ProjectionBytes(sourceBytes).byteLength > MANAGED_TARGET_CANONICAL_SOURCE_RECEIPT_MAX_BYTES) {
    throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: canonical source receipt exceeds its fixed byte bound");
  }
  let lastEnd = 0;
  const sectionIds = new Set<string>();
  for (const section of receipt.sections) {
    if (
      !IDENTIFIER.test(section.canonical_section_id) || sectionIds.has(section.canonical_section_id) ||
      !IDENTIFIER.test(section.canonical_item_key) ||
      !SHA256.test(section.content_sha256) || !SHA256.test(section.canonical_body_sha256) ||
      section.canonical_body_sha256 !== section.content_sha256 ||
      !Number.isSafeInteger(section.normalized_start_byte) || section.normalized_start_byte < lastEnd ||
      !Number.isSafeInteger(section.normalized_end_byte) || section.normalized_end_byte <= section.normalized_start_byte ||
      !section.canonical_body_ref.startsWith(prefix) || section.canonical_body_ref.length > 1024
    ) {
      throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: canonical section reference is malformed or outside source residency");
    }
    sectionIds.add(section.canonical_section_id);
    lastEnd = section.normalized_end_byte;
  }
  const expectedSections = await projectionDigest(receipt.sections.map((section) => ({
    item_key: section.canonical_item_key,
    canonical_section_id: section.canonical_section_id,
    content_sha256: section.content_sha256,
    start: section.normalized_start_byte,
    end: section.normalized_end_byte,
  })));
  if (expectedSections !== receipt.canonical_section_set_sha256) {
    throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: canonical section set digest differs from its references");
  }
  return receipt;
}

export async function validateManagedProjectCopyMapReceipt(input: {
  readonly receipt: ManagedProjectCopyMapReceiptV1;
  readonly canonical_source: CanonicalSourceProjectionReceipt;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly copy: ManagedRequiredProjectRevisionCopy;
}): Promise<ManagedProjectCopyMapReceiptV1> {
  const expected = await buildCanonicalProjectCopyMaps(
    input.canonical_source,
    input.target,
    [input.copy.project_membership_id],
  );
  const expectedCopy = expected[0];
  if (expectedCopy === undefined || canonicalProjectionJson(input.receipt) !== canonicalProjectionJson(expectedCopy)) {
    throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: provider-copy map differs from the writer-owned membership derivation");
  }
  return input.receipt;
}

function providerCopySetDigest(copies: readonly ManagedProjectCopyMapReceiptV1[]): Promise<string> {
  return projectionDigest(copies.map((copy) => ({
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    membership_generation: copy.membership_generation,
    provider_copy_set_sha256: copy.provider_copy_set_sha256,
  })));
}

function providerItemSetDigest(copies: readonly ManagedProjectCopyMapReceiptV1[]): Promise<string> {
  return projectionDigest(copies.flatMap((copy) => copy.items.map((item) => ({
    item_key: item.item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    start: item.normalized_start_byte,
    end: item.normalized_end_byte,
  }))));
}

/** Read back and validate the writer-owned source/canonical/target page set. */
export async function readManagedProjectCopyMapSet(input: {
  readonly receipt: ManagedProjectCopyMapSetReceiptV1;
  readonly canonical_source: CanonicalSourceProjectionReceipt;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly memberships: readonly { readonly project_id: string; readonly project_membership_id: string; readonly membership_generation: number }[];
  readonly store: EvidenceObjectStore;
}): Promise<{ readonly copies: readonly ManagedProjectCopyMapReceiptV1[]; readonly page_object_bytes: number }> {
  const { receipt, canonical_source: canonical, target, memberships, store } = input;
  if (!Array.isArray(receipt.pages) || !Array.isArray(memberships)) {
    throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: copy-map page or membership list is malformed");
  }
  const expectedCopies = await buildCanonicalProjectCopyMaps(
    canonical,
    target,
    memberships.map((membership) => membership.project_membership_id),
  );
  const resource = receipt.resource_bounds;
  if (
    receipt.protocol !== "eliotr.managed-project-copy-map-set.v1" ||
    receipt.source_revision_ref !== canonical.source_revision_ref ||
    receipt.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
    receipt.canonical_projection_generation !== canonical.canonical_projection_generation ||
    receipt.canonical_source_ref !== canonical.canonical_source_ref ||
    receipt.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
    canonicalProjectionJson(receipt.target) !== canonicalProjectionJson(target) ||
    receipt.provider_copy_count !== expectedCopies.length ||
    receipt.page_count !== receipt.pages.length || receipt.page_count < 1 || receipt.page_count > 256 ||
    !SHA256.test(receipt.page_set_sha256) ||
    !SHA256.test(receipt.provider_copy_set_sha256) || !SHA256.test(receipt.provider_item_set_sha256) ||
    resource.protocol !== "eliotr.project-copy-resource-bounds.v1" ||
    resource.provider_copy_count !== receipt.provider_copy_count ||
    resource.provider_item_count !== receipt.provider_item_count ||
    resource.copy_map_page_count !== receipt.page_count ||
    resource.copy_map_r2_put_count !== receipt.page_count ||
    resource.copy_map_r2_subrequest_bound !== 2 * receipt.page_count ||
    resource.copy_map_r2_subrequest_bound >= 10_000 ||
    resource.cpu_time_budget_ms !== 30_000 || resource.maximum_subrequest_bound !== 10_000 ||
    receipt.provider_item_count !== expectedCopies.reduce((total, copy) => total + copy.provider_item_count, 0) ||
    receipt.provider_copy_set_sha256 !== await providerCopySetDigest(expectedCopies) ||
    receipt.provider_item_set_sha256 !== await providerItemSetDigest(expectedCopies) ||
    receipt.page_set_sha256 !== await projectionDigest(receipt.pages)
  ) {
    throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: copy-map set receipt differs from its exact source, target, membership, or resource bounds");
  }

  const manifestMarker = "/manifests/";
  const manifestMarkerIndex = canonical.canonical_source_ref.lastIndexOf(manifestMarker);
  if (manifestMarkerIndex < 1) throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: canonical manifest ref has no generation prefix");
  const generationPrefix = canonical.canonical_source_ref.slice(0, manifestMarkerIndex);
  const targetToken = (await stableProjectionId("copy-target", target.managed_instance_id, target.managed_generation))
    .slice("copy-target-".length);
  const pagePrefix = `${generationPrefix}/copy-maps/${targetToken}/${receipt.provider_copy_set_sha256}/pages/`;
  const sourcePrefix = await sourceResidencyWorkPrefix(canonical.source_revision_ref);
  if (!generationPrefix.startsWith(sourcePrefix)) {
    throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: canonical manifest escaped its source-residency prefix");
  }
  const copies: ManagedProjectCopyMapReceiptV1[] = [];
  let pageObjectBytes = 0;
  let previousPageSha256: string | null = null;
  for (let pageIndex = 0; pageIndex < receipt.pages.length; pageIndex += 1) {
    const pageRef = receipt.pages[pageIndex];
    if (pageRef === undefined || !Number.isSafeInteger(pageRef.provider_copy_count) ||
        pageRef.provider_copy_count < 1 || pageRef.provider_copy_count > 256 ||
        !Number.isSafeInteger(pageRef.provider_item_count) || pageRef.provider_item_count < 1 ||
        pageRef.page_index !== pageIndex || !SHA256.test(pageRef.page_sha256) ||
        pageRef.page_ref !== `${pagePrefix}${String(pageIndex).padStart(4, "0")}-${pageRef.page_sha256}.json`) {
      throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: copy-map page locator is malformed or outside source residency");
    }
    const stored = await readCanonicalManifestObject(store, pageRef.page_ref);
    if (stored === null) throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: listed copy-map page is absent on exact readback");
    pageObjectBytes += stored.ref.size_bytes;
    const page = stored.value as ManagedProjectCopyMapPageV1;
    const { page_sha256: pageSha256, ...payload } = page;
    const start = copies.length;
    const expectedPageCopies = expectedCopies.slice(start, start + pageRef.provider_copy_count);
    if (
      page.protocol !== "eliotr.managed-project-copy-map-page.v1" ||
      page.source_revision_ref !== canonical.source_revision_ref ||
      page.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
      page.canonical_projection_generation !== canonical.canonical_projection_generation ||
      page.canonical_source_ref !== canonical.canonical_source_ref ||
      page.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
      canonicalProjectionJson(page.target) !== canonicalProjectionJson(target) ||
      page.page_index !== pageIndex || page.page_sha256 !== pageRef.page_sha256 ||
      page.provider_copy_count !== page.copies.length || page.provider_copy_count !== pageRef.provider_copy_count ||
      page.provider_item_count !== pageRef.provider_item_count ||
      page.previous_page_sha256 !== previousPageSha256 ||
      page.cursor_start_project_membership_id !== (page.copies[0]?.project_membership_id ?? null) ||
      page.cursor_end_project_membership_id !== (page.copies.at(-1)?.project_membership_id ?? null) ||
      !Array.isArray(page.copies) || page.copies.length > 256 ||
      pageSha256 !== await projectionSha256Utf8(canonicalProjectionJson(payload)) ||
      page.provider_copy_set_sha256 !== await providerCopySetDigest(page.copies) ||
      page.provider_item_set_sha256 !== await providerItemSetDigest(page.copies) ||
      page.copies.length !== expectedPageCopies.length ||
      expectedPageCopies.some((copy, index) => canonicalProjectionJson(copy) !== canonicalProjectionJson(page.copies[index]))
    ) {
      throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: copy-map page content or chain differs from its source-set receipt");
    }
    copies.push(...page.copies);
    previousPageSha256 = page.page_sha256;
  }
  if (copies.length !== expectedCopies.length) {
    throw new Error("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID: copy-map pages omit a membership mapping");
  }
  return Object.freeze({ copies: Object.freeze(copies), page_object_bytes: pageObjectBytes });
}

export async function putCanonicalManifestObjectIfAbsent(
  store: EvidenceObjectStore,
  key: string,
  value: unknown,
  metadata: Readonly<Record<string, string>>,
  knownAbsent = false,
): Promise<ManagedTargetManifestObjectRef> {
  const json = canonicalProjectionJson(value);
  const bytes = utf8ProjectionBytes(json);
  if (bytes.byteLength > MANAGED_TARGET_MANIFEST_FRAGMENT_MAX_BYTES) {
    throw new Error("managed target manifest fragment exceeds its fixed byte bound");
  }
  const sha256 = await projectionSha256Utf8(json);
  const existing = knownAbsent ? null : await store.open(key);
  if (existing !== null) {
    if (existing.size !== bytes.byteLength || existing.size > MANAGED_TARGET_MANIFEST_FRAGMENT_MAX_BYTES) {
      try { await existing.body.cancel(); } catch { /* stored size already fails closed */ }
      throw new Error("existing managed target fragment has an unexpected size");
    }
    const storedBytes = await bufferBounded(existing.body, MANAGED_TARGET_MANIFEST_FRAGMENT_MAX_BYTES);
    const storedText = new TextDecoder("utf-8", { fatal: true }).decode(storedBytes);
    if (storedText !== json || storedBytes.byteLength !== bytes.byteLength || await projectionSha256Utf8(storedText) !== sha256) {
      throw new Error("existing managed target fragment differs from its content-addressed identity");
    }
    return Object.freeze({ key, sha256, size_bytes: bytes.byteLength });
  }
  const receipt = await store.putImmutable({
    key,
    body: projectionByteStream(bytes),
    expected_sha256: sha256,
    expected_size_bytes: bytes.byteLength,
    content_type: "application/json; charset=utf-8",
    custom_metadata: { ...metadata, manifest_sha256: sha256 },
  });
  if (receipt.key !== key || receipt.readback_sha256 !== sha256 || receipt.size_bytes !== bytes.byteLength) {
    throw new Error("immutable managed target fragment readback differs from staged bytes");
  }
  return Object.freeze({ key, sha256, size_bytes: bytes.byteLength });
}

export async function readCanonicalManifestObject(
  store: EvidenceObjectStore,
  key: string,
): Promise<{ readonly value: unknown; readonly ref: ManagedTargetManifestObjectRef } | null> {
  const existing = await store.open(key);
  if (existing === null) return null;
  if (!Number.isSafeInteger(existing.size) || existing.size < 2 || existing.size > MANAGED_TARGET_MANIFEST_FRAGMENT_MAX_BYTES) {
    try { await existing.body.cancel(); } catch { /* invalid size is enough to fail closed */ }
    throw new Error("existing managed target fragment is outside its fixed byte bound");
  }
  const bytes = await bufferBounded(existing.body, MANAGED_TARGET_MANIFEST_FRAGMENT_MAX_BYTES);
  if (bytes.byteLength !== existing.size) throw new Error("existing managed target fragment readback is incomplete");
  const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try { value = JSON.parse(json) as unknown; }
  catch (cause) { throw new Error("existing managed target fragment is not valid JSON", { cause }); }
  if (canonicalProjectionJson(value) !== json) throw new Error("existing managed target fragment is not canonical JSON");
  return Object.freeze({
    value,
    ref: Object.freeze({ key, sha256: await projectionSha256Utf8(json), size_bytes: bytes.byteLength }),
  });
}
