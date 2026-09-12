import {
  CitationResolutionReceiptSchema,
  ResolvedEvidenceSchema,
  type CitationResolutionReceipt,
  type CitationResolutionItem,
  type EvidenceHandle,
  type EvidenceResolutionReceipt,
  type ResolvedEvidence,
  type ScopeSnapshot,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceRefKey,
  evidenceSha256,
  evidenceSha256Bytes,
  evidenceUtf8Bytes,
  exactEvidenceRef,
} from "./canonical.js";
import { loadEvidenceHandle } from "./authority-load.js";
import { readEvidenceResolutionReceipt } from "./resolution-readback.js";
import type {
  EvidenceAccessContext,
  EvidenceContentPort,
  EvidenceSourceAuthority,
  ScopeAuthorization,
} from "./types.js";
import { EvidenceRuntimeError } from "./types.js";
import type { NavigationReadAuthority } from "./navigation-storage-authority.js";

export interface MaterializeSavedCitationResolutionInput {
  readonly database: D1Database;
  readonly content: EvidenceContentPort;
  readonly navigation: NavigationReadAuthority;
  /** Must be obtained through the immutable Stage15 binding readback. */
  readonly citation: CitationResolutionReceipt;
}

interface PreparedEvidence {
  readonly item: CitationResolutionItem;
  readonly evidenceReceipt: EvidenceResolutionReceipt;
  readonly handle: EvidenceHandle;
  readonly source: EvidenceSourceAuthority;
  readonly materialized: Awaited<ReturnType<EvidenceContentPort["materialize"]>>;
}

function fail(
  code: EvidenceRuntimeError["code"],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function detached<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalEvidenceJson(value)) as T);
}

function snapshotCitation(raw: CitationResolutionReceipt): CitationResolutionReceipt {
  try {
    return detached(CitationResolutionReceiptSchema.parse(JSON.parse(canonicalEvidenceJson(raw))));
  } catch (cause) {
    fail("EVIDENCE_INPUT_INVALID", "saved citation resolution receipt failed strict validation", { cause });
  }
}

function citationDigestPayload(receipt: CitationResolutionReceipt): unknown {
  const { receipt_digest: _digest, ...payload } = receipt;
  return payload;
}

function sameScope(scope: ScopeSnapshot, receipt: CitationResolutionReceipt): boolean {
  return exactEvidenceRef(receipt.scope_snapshot_ref, {
    id: scope.snapshot_id,
    revision: scope.revision,
  });
}

function sourceMap(
  sources: readonly EvidenceSourceAuthority[],
): Map<string, { readonly value: EvidenceSourceAuthority; readonly fingerprint: string }> {
  const result = new Map<string, { readonly value: EvidenceSourceAuthority; readonly fingerprint: string }>();
  for (const raw of sources) {
    const value = detached(raw);
    const key = value.source_revision_ref;
    if (result.has(key)) fail("EVIDENCE_INPUT_INVALID", "navigation returned duplicate source authority");
    result.set(key, { value, fingerprint: canonicalEvidenceJson(value) });
  }
  return result;
}

function requireLiveHandle(handle: EvidenceHandle, nowIso: string): void {
  if (handle.terminal_state !== "LIVE") {
    fail("EVIDENCE_HANDLE_NOT_LIVE", "saved citation handle is terminal and exposes no content");
  }
  if (handle.expires_at !== undefined && Date.parse(handle.expires_at) <= Date.parse(nowIso)) {
    fail("EVIDENCE_HANDLE_NOT_LIVE", "saved citation handle expired", {
      invalidation_state: "STALE",
    });
  }
}

function drift(label: string): never {
  fail("EVIDENCE_SETTLEMENT_UNCERTAIN", `${label} changed during saved citation materialization`, {
    retryable: true,
  });
}

function requireSameSources(
  expected: ReadonlyMap<string, { readonly value: EvidenceSourceAuthority; readonly fingerprint: string }>,
  actual: ReadonlyMap<string, { readonly value: EvidenceSourceAuthority; readonly fingerprint: string }>,
): void {
  if (expected.size !== actual.size) drift("source authority");
  for (const [sourceRef, before] of expected) {
    const after = actual.get(sourceRef);
    if (after === undefined || after.fingerprint !== before.fingerprint) drift("source authority");
  }
}

function requirePreBinding(
  item: CitationResolutionItem,
  receipt: EvidenceResolutionReceipt,
  handle: EvidenceHandle,
  source: EvidenceSourceAuthority,
  scope: ScopeSnapshot,
  grant: ScopeAuthorization,
): void {
  if (evidenceRefKey(receipt.receipt_ref) !== item.verification_receipt_ref) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "saved citation verification reference differs from its receipt", {
      retryable: true,
    });
  }
  if (!exactEvidenceRef(receipt.handle_ref, item.handle_ref) || !exactEvidenceRef(handle.handle_ref, item.handle_ref)) {
    fail("EVIDENCE_IDENTITY_CONFLICT", "saved citation handle identity differs from its receipt");
  }
  const scopeRef = { id: scope.snapshot_id, revision: scope.revision };
  if (!exactEvidenceRef(receipt.scope_snapshot_ref, scopeRef) || !exactEvidenceRef(handle.scope_snapshot_ref, scopeRef)) {
    fail("EVIDENCE_SCOPE_MISMATCH", "saved citation is bound to another ScopeSnapshot");
  }
  if (
    receipt.authorization_receipt_ref !== grant.authorization_receipt_ref ||
    receipt.scope_snapshot_digest !== scope.digest
  ) {
    fail("EVIDENCE_AUTHORIZATION_DENIED", "saved citation authorization no longer matches the current grant");
  }
  if (
    receipt.source_revision_ref !== handle.source_revision_ref ||
    receipt.source_revision_ref !== source.source_revision_ref ||
    receipt.source_owner_generation !== handle.source_owner_generation ||
    receipt.source_owner_generation !== source.source_owner_generation
  ) {
    fail("EVIDENCE_OWNER_GENERATION_MISMATCH", "saved citation source owner or revision changed", {
      invalidation_state: "STALE",
    });
  }
  if (
    source.source_namespace_id !== handle.source_namespace_id ||
    source.object_residency_key_digest !== handle.object_residency_key_digest
  ) {
    fail("EVIDENCE_OWNER_GENERATION_MISMATCH", "saved citation source residency changed", {
      invalidation_state: "STALE",
    });
  }
  if (receipt.source_revision_content_sha256 !== source.content_sha256) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "saved citation source digest differs from current authority", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
  if (
    receipt.excerpt_sha256 !== item.excerpt_sha256 ||
    receipt.excerpt_sha256 !== handle.excerpt_sha256 ||
    receipt.excerpt_byte_length !== handle.excerpt_byte_length
  ) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "saved citation excerpt binding differs from its handle", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
}

async function requireMaterializedBinding(
  item: CitationResolutionItem,
  receipt: EvidenceResolutionReceipt,
  handle: EvidenceHandle,
  source: EvidenceSourceAuthority,
  materialized: PreparedEvidence["materialized"],
): Promise<void> {
  if (typeof materialized.exact_excerpt !== "string") {
    fail("EVIDENCE_OBJECT_INTEGRITY", "materialized excerpt is not valid text", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
  const excerptBytes = evidenceUtf8Bytes(materialized.exact_excerpt);
  const excerptSha256 = await evidenceSha256Bytes(excerptBytes);
  if (
    materialized.source_object_sha256 !== source.content_sha256 ||
    materialized.source_object_sha256 !== receipt.source_revision_content_sha256 ||
    materialized.source_object_size !== receipt.source_object_size ||
    materialized.normalized_object_ref_digest !== receipt.normalized_object_ref_digest
  ) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "materialized source bytes differ from saved authority", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
  if (
    excerptSha256 !== materialized.excerpt_sha256 ||
    excerptBytes.byteLength !== materialized.excerpt_byte_length ||
    excerptSha256 !== item.excerpt_sha256 ||
    excerptSha256 !== receipt.excerpt_sha256 ||
    excerptBytes.byteLength !== receipt.excerpt_byte_length ||
    excerptSha256 !== handle.excerpt_sha256 ||
    excerptBytes.byteLength !== handle.excerpt_byte_length ||
    materialized.excerpt_sha256 !== item.excerpt_sha256 ||
    materialized.excerpt_sha256 !== receipt.excerpt_sha256 ||
    materialized.excerpt_byte_length !== receipt.excerpt_byte_length ||
    materialized.excerpt_sha256 !== handle.excerpt_sha256 ||
    materialized.excerpt_byte_length !== handle.excerpt_byte_length
  ) {
    fail("EVIDENCE_OBJECT_INTEGRITY", "materialized excerpt bytes differ from saved authority", {
      invalidation_state: "BROKEN_INTEGRITY",
    });
  }
}

function buildResolvedEvidence(
  prepared: PreparedEvidence,
  access: EvidenceAccessContext,
): ResolvedEvidence {
  return ResolvedEvidenceSchema.parse({
    handle: prepared.handle,
    exact_excerpt: prepared.materialized.exact_excerpt,
    source_title: prepared.source.source_title,
    verification_receipt_ref: prepared.item.verification_receipt_ref,
    authorization_receipt_ref: prepared.evidenceReceipt.authorization_receipt_ref,
    credential_generation: access.credential_generation,
    source_revision_content_sha256: prepared.evidenceReceipt.source_revision_content_sha256,
    scope_snapshot_digest: prepared.evidenceReceipt.scope_snapshot_digest,
    instruction_taint: prepared.source.instruction_taint,
    allowed_effects: prepared.source.allowed_effects,
    resolved_at: prepared.evidenceReceipt.resolved_at,
  });
}

/**
 * Re-materialize already-resolved citation evidence without resolving or persisting it again.
 * The citation receipt must come from the immutable Stage15 attempt binding readback.
 */
export async function readResolvedCitationEvidence(
  rawInput: MaterializeSavedCitationResolutionInput,
): Promise<readonly ResolvedEvidence[]> {
  // Detach all caller-owned values before the first awaited authority read.
  const database = rawInput.database;
  const content = rawInput.content;
  const navigation = rawInput.navigation;
  const citation = snapshotCitation(rawInput.citation);
  const scope = detached(navigation.scope);
  const access = detached({
    principal_ref: navigation.access.principal_ref,
    client_class: navigation.access.client_class,
    credential_generation: navigation.access.credential_generation,
  });
  if (!sameScope(scope, citation)) {
    fail("EVIDENCE_SCOPE_MISMATCH", "saved citation is bound to another navigation scope");
  }
  if (await evidenceSha256(citationDigestPayload(citation)) !== citation.receipt_digest) {
    fail("EVIDENCE_INPUT_INVALID", "saved citation receipt digest mismatch");
  }

  const beforeGrant = detached(await navigation.current(scope));
  const beforeHandles = new Map<string, EvidenceHandle>();
  const evidenceReceipts = new Map<string, EvidenceResolutionReceipt>();
  const unresolvedItems: Array<{ readonly item: CitationResolutionItem; readonly handle: EvidenceHandle }> = [];
  const beforeNow = navigation.timestamp();
  for (const item of citation.resolved) {
    const key = evidenceRefKey(item.handle_ref);
    const handle = await loadEvidenceHandle(database, item.handle_ref);
    if (handle === null) fail("EVIDENCE_HANDLE_NOT_FOUND", "saved citation handle is missing");
    const detachedHandle = detached(handle);
    requireLiveHandle(detachedHandle, beforeNow);
    const receipt = await readEvidenceResolutionReceipt(database, {
      verification_receipt_ref: item.verification_receipt_ref,
      expected_handle_ref: item.handle_ref,
    });
    if (receipt === null) {
      fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "saved citation evidence receipt is missing", { retryable: true });
    }
    const detachedReceipt = detached(receipt);
    beforeHandles.set(key, detachedHandle);
    evidenceReceipts.set(key, detachedReceipt);
    unresolvedItems.push({ item, handle: detachedHandle });
  }

  const sourceRevisionRefs = [...new Set(unresolvedItems.map(({ handle }) => handle.source_revision_ref))].sort();
  const beforeSourceMap = sourceMap(await navigation.sources(sourceRevisionRefs, beforeGrant));
  const prepared: PreparedEvidence[] = [];
  for (const { item, handle } of unresolvedItems) {
    const key = evidenceRefKey(item.handle_ref);
    const receipt = evidenceReceipts.get(key);
    if (receipt === undefined) fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "saved citation receipt readback disappeared", { retryable: true });
    const sourceEntry = beforeSourceMap.get(handle.source_revision_ref);
    if (sourceEntry === undefined) fail("EVIDENCE_SOURCE_NOT_FOUND", "saved citation source authority is missing");
    const source = sourceEntry.value;
    requirePreBinding(item, receipt, handle, source, scope, beforeGrant);
    const anchorDigest = await evidenceSha256(handle.anchor);
    if (anchorDigest !== receipt.anchor_digest) {
      fail("EVIDENCE_OBJECT_INTEGRITY", "saved citation anchor digest differs from its handle", {
        invalidation_state: "BROKEN_INTEGRITY",
      });
    }
    const materialized = detached(await content.materialize(source, handle.anchor));
    await requireMaterializedBinding(item, receipt, handle, source, materialized);
    prepared.push({ item, evidenceReceipt: receipt, handle, source, materialized });
  }

  const afterGrant = detached(await navigation.current(scope));
  const afterSourceMap = sourceMap(await navigation.sources(sourceRevisionRefs, afterGrant));
  requireSameSources(beforeSourceMap, afterSourceMap);
  for (const { item } of unresolvedItems) {
    const key = evidenceRefKey(item.handle_ref);
    const afterHandle = await loadEvidenceHandle(database, item.handle_ref);
    if (afterHandle === null) drift("evidence handle");
    const detachedAfterHandle = detached(afterHandle);
    requireLiveHandle(detachedAfterHandle, navigation.timestamp());
    const beforeHandle = beforeHandles.get(key);
    if (beforeHandle === undefined || canonicalEvidenceJson(detachedAfterHandle) !== canonicalEvidenceJson(beforeHandle)) {
      drift("evidence handle");
    }
  }
  const lateGrant = detached(await navigation.current(scope));
  const lateSourceMap = sourceMap(await navigation.sources(sourceRevisionRefs, lateGrant));
  requireSameSources(beforeSourceMap, lateSourceMap);
  const finalGrant = detached(await navigation.current(scope));
  if (canonicalEvidenceJson(afterGrant) !== canonicalEvidenceJson(beforeGrant) ||
      canonicalEvidenceJson(lateGrant) !== canonicalEvidenceJson(beforeGrant) ||
      canonicalEvidenceJson(finalGrant) !== canonicalEvidenceJson(beforeGrant)) {
    drift("scope authorization");
  }
  return prepared.map((item) => buildResolvedEvidence(item, access));
}
