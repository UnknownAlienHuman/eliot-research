import type { AiSearchInstanceProfile, EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { ManagedRequiredProjectRevisionCopy } from "./managed-required-set.js";
import { ManagedTargetManifestError } from "./managed-target-manifest-contract.js";
import { aiSearchPhysicalProfileDigest } from "./ai-search-profile-identity-digest.js";
import { putCanonicalManifestObjectIfAbsent } from "./managed-target-manifest-fragments.js";
import { canonicalProjectionJson } from "./canonical.js";
import type { ManagedTargetManifestScanState } from "./managed-target-manifest-continuation.js";
import type { CanonicalSourceProjectionReceipt, ManagedProjectCopyMapReceipt } from "./types.js";
import { MANAGED_TARGET_MANIFEST_MAX_PAGES } from "./managed-target-manifest-step-support.js";
export const MANIFEST_PROTOCOL = "eliotr.managed-target-desired-items.v2" as const;
export const CANDIDATE_PROTOCOL = "eliotr.managed-target-manifest-candidate.v1" as const;
export const CONTINUATION_PROTOCOL = "eliotr.managed-target-manifest-continuation.v2" as const;
export const PAGE_PROTOCOL = "eliotr.managed-target-manifest-required-page.v2" as const;
export const COPY_PROTOCOL = "eliotr.managed-target-manifest-copy.v2" as const;
export const SOURCE_INDEX_PROTOCOL = "eliotr.managed-target-manifest-source-index.v1" as const;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export const MAX_CAPACITY_RECEIPT_AGE_MS = 5 * 60 * 1000;
export const MAX_CAPACITY_RECEIPT_FUTURE_MS = 30 * 1000;
export const MAX_MANIFEST_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_ASSIGNMENT_FENCE_PAGES = MANAGED_TARGET_MANIFEST_MAX_PAGES + 1;

export interface StoredRequiredPage {
  readonly protocol: typeof PAGE_PROTOCOL;
  readonly scan_identity_sha256: string;
  readonly phase: "BUILD_SCAN" | "VERIFY_SCAN";
  readonly page_index: number;
  readonly page_sha256: string;
  readonly after: ManagedTargetManifestScanState["after"];
  readonly next_cursor: ManagedTargetManifestScanState["after"];
  readonly rows: readonly ManagedRequiredProjectRevisionCopy[];
}

export interface StoredCanonicalSourceIndex {
  readonly protocol: typeof SOURCE_INDEX_PROTOCOL;
  readonly source_identity_sha256: string;
  readonly receipt: CanonicalSourceProjectionReceipt;
}

export interface StoredCopyFragment {
  readonly protocol: typeof COPY_PROTOCOL;
  readonly scan_identity_sha256: string;
  readonly copy_ordinal: number;
  readonly microstep_ordinal: number;
  readonly copy_identity_sha256: string;
  readonly required_copy: ManagedRequiredProjectRevisionCopy;
  readonly source_identity_sha256: string;
  readonly source_authority_sha256: string;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly canonical_projection_generation: string;
  readonly canonical_section_count: number;
  readonly canonical_section_set_sha256: string;
  readonly provider_copy_map: ManagedProjectCopyMapReceipt;
}

export function fail(
  code: ConstructorParameters<typeof ManagedTargetManifestError>[0],
  message: string,
  cause?: unknown,
): never {
  throw new ManagedTargetManifestError(code, message, cause);
}

export function putBuildObject(
  store: EvidenceObjectStore,
  key: string,
  value: unknown,
  metadata: Readonly<Record<string, string>>,
) {
  return putCanonicalManifestObjectIfAbsent(store, key, value, metadata, true);
}

export async function profileDigest(profile: AiSearchInstanceProfile): Promise<string> {
  return aiSearchPhysicalProfileDigest(profile);
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalProjectionJson(left) === canonicalProjectionJson(right);
}

export function capacityIdentity(receipt: {
  readonly protocol: string;
  readonly account_tier: string;
  readonly account_authority_ref: string;
  readonly account_authority_sha256: string;
  readonly max_files_per_instance: number;
  readonly documentation_modified_on: string;
}) {
  return {
    protocol: receipt.protocol,
    account_tier: receipt.account_tier,
    account_authority_ref: receipt.account_authority_ref,
    account_authority_sha256: receipt.account_authority_sha256,
    max_files_per_instance: receipt.max_files_per_instance,
    documentation_modified_on: receipt.documentation_modified_on,
  };
}

export function assertFreshAuthorityTimestamp(value: string, nowMs: number, label: string): void {
  const checked = Date.parse(value);
  if (!Number.isFinite(checked) || checked > nowMs + MAX_CAPACITY_RECEIPT_FUTURE_MS ||
      nowMs - checked > MAX_CAPACITY_RECEIPT_AGE_MS) {
    fail("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE", `${label} is not a fresh trusted receipt`);
  }
}
