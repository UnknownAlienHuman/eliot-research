import {
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import {
  WikiPublicationError,
  type DraftRiskClass,
  type WikiHeadCommit,
  type WikiProposalRecord,
} from "@eliotr/research";
import type { WikiOwnerPublicationGuardWitness } from "./wiki-owner-publication-guard.js";

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_MAP_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_STREAM_CHUNKS = 4096;
const DIGEST = /^[a-f0-9]{64}$/u;
export const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,511}$/u;
export const RISK_CLASSES = new Set<DraftRiskClass>([
  "D0_MECHANICAL",
  "D1_LOW_RISK_ADDITIVE",
  "D2_ANALYTICAL",
  "D3_AUTHORITY_SENSITIVE",
]);

export interface ProposalRow {
  proposal_id: string;
  proposal_revision: number;
  principal_ref: string;
  idempotency_key: string;
  request_sha256: string;
  page_id: string;
  page_revision: number;
  page_sha256: string;
  page_json: string;
  risk_class: string;
  body_size: number;
  evidence_map_sha256: string;
  evidence_map_size: number;
  dependency_refs_sha256: string;
  state: string;
  created_at: string;
}

export interface AuthorityRow {
  proposal_id: string;
  proposal_revision: number;
  evidence_receipt_ref: string;
  coverage_receipt_json: string;
  dependency_closure_receipt_ref: string;
  verifier_receipt_ref: string;
  policy_receipt_ref: string | null;
  coverage_complete: number;
  dependency_closure_complete: number;
  conflict_count: number;
  changes_current_state: number;
  state: string;
}

export interface HeadRow {
  page_id: string;
  revision: number;
  manifest_ref: string;
  outbox_ref: string;
}

export interface WikiStoreContext {
  readonly principal_ref: string;
  readonly idempotency_key: string;
  readonly now?: () => string;
  /** Build a fresh owner/source/policy/purge witness after R2 readback. */
  readonly read_owner_publication_guard_witness?: (
    input: WikiHeadCommit & { readonly page_sha256: string },
  ) => Promise<WikiOwnerPublicationGuardWitness>;
}

export interface WikiAuthorityAdmission {
  readonly proposal_ref: VersionedRef;
  readonly principal_ref: string;
  readonly evidence_receipt_ref: string;
  readonly dependency_closure_receipt_ref: string;
  readonly verifier_receipt_ref: string;
  readonly policy_receipt_ref?: string;
  readonly coverage_complete: boolean;
  readonly dependency_closure_complete: boolean;
  readonly conflict_count: number;
  readonly changes_current_state: boolean;
  readonly admitted_at?: string;
}

/** Immutable server-derived receipt which authorizes manual review coverage. */
export interface WikiOwnerReviewReceipt {
  readonly protocol: "eliotr.wiki.owner-review.v1";
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly principal_ref: string;
  readonly operation_id: string;
  readonly artifact_ref: VersionedRef;
  readonly coverage_receipt_ref: VersionedRef;
  readonly evidence_receipt_ref: string;
  readonly dependency_closure_receipt_ref: string;
  readonly verifier_receipt_ref: string;
  readonly coverage_complete: boolean;
  readonly dependency_closure_complete: boolean;
  readonly conflict_count: number;
  readonly changes_current_state: boolean;
  readonly supported_claim_count: number;
  readonly limitations: readonly string[];
  readonly provenance: Record<string, unknown>;
  readonly admitted_at: string;
}

/** Immutable server-derived receipt for the conservative owner-edit path. */
export interface WikiOwnerEditReviewReceipt {
  readonly protocol: "eliotr.wiki.owner-edit-review.v1";
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly principal_ref: string;
  readonly base_proposal_ref: VersionedRef;
  readonly base_page_ref: VersionedRef;
  readonly base_page_sha256: string;
  readonly body_sha256: string;
  readonly coverage_receipt_ref: VersionedRef;
  readonly evidence_receipt_ref: string;
  readonly dependency_closure_receipt_ref: string;
  readonly verifier_receipt_ref: string;
  readonly coverage_complete: false;
  readonly dependency_closure_complete: true;
  readonly conflict_count: 0;
  readonly changes_current_state: false;
  readonly supported_claim_count: 0;
  readonly limitations: readonly string[];
  readonly provenance: Record<string, unknown>;
  readonly admitted_at: string;
}

export function fail(code: ConstructorParameters<typeof WikiPublicationError>[0], message: string, retryable = false, cause?: unknown): never {
  throw new WikiPublicationError(code, message, retryable, cause);
}

export function validRef(value: string, label: string): string {
  if (!SAFE_REF.test(value) || value.includes("..") || value.includes("\\")) {
    fail("WIKI_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

export function validPrincipal(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value !== value.trim()) {
    fail("WIKI_INPUT_INVALID", "principal reference is invalid");
  }
  return value;
}

export function validIdempotency(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    fail("WIKI_INPUT_INVALID", "idempotency key is invalid");
  }
  return value;
}

export function nowIso(context: WikiStoreContext): string {
  const value = context.now?.() ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(value)) || !value.endsWith("Z")) fail("WIKI_INPUT_INVALID", "Wiki clock is invalid");
  return value;
}

export function pageJson(page: WikiPageRevision): string {
  const parsed = WikiPageRevisionSchema.safeParse(page);
  if (!parsed.success) fail("WIKI_INPUT_INVALID", "Wiki page failed strict validation");
  const encoded = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(encoded).byteLength > MAX_MANIFEST_BYTES) {
    fail("WIKI_INPUT_INVALID", "Wiki page manifest exceeds its byte bound");
  }
  return encoded;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const stable = Uint8Array.from(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", stable.buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function textDigest(value: string): Promise<string> {
  return sha256(new TextEncoder().encode(value));
}

export async function dependencyDigest(page: WikiPageRevision): Promise<string> {
  const refs = [...page.dependency_refs];
  refs.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return textDigest(JSON.stringify(refs));
}

export async function readObject(bucket: R2Bucket, key: string, maximumBytes: number): Promise<{ bytes: Uint8Array; sha256: string }> {
  validRef(key, "R2 object reference");
  let object: R2ObjectBody | null;
  try { object = await bucket.get(key); }
  catch (cause) { fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki R2 read is unavailable", true, cause); }
  if (object === null) fail("WIKI_PUBLICATION_INCOMPLETE", "required Wiki object is absent");
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > maximumBytes) {
    object.body.cancel().catch(() => undefined);
    fail("WIKI_PUBLICATION_INCOMPLETE", "required Wiki object exceeds its byte bound");
  }
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let count = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      count += 1;
      length += part.value.byteLength;
      if (count > MAX_STREAM_CHUNKS || !Number.isSafeInteger(length) || length > maximumBytes || length > object.size) {
        await reader.cancel().catch(() => undefined);
        fail("WIKI_PUBLICATION_INCOMPLETE", "required Wiki object stream exceeds its bounds");
      }
      chunks.push(part.value.slice());
    }
  } catch (cause) {
    if (cause instanceof WikiPublicationError) throw cause;
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki R2 stream is unavailable", true, cause);
  } finally {
    reader.releaseLock();
  }
  if (length !== object.size) fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "Wiki R2 object size changed during readback");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, sha256: await sha256(bytes) };
}

export function decodeProposal(row: ProposalRow): WikiProposalRecord {
  if (row.proposal_revision !== 1 || row.state !== "PROPOSED" && row.state !== "PUBLISHED" || !RISK_CLASSES.has(row.risk_class as DraftRiskClass)
      || !DIGEST.test(row.request_sha256) || !DIGEST.test(row.page_sha256) || !DIGEST.test(row.evidence_map_sha256)
      || !DIGEST.test(row.dependency_refs_sha256)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal row is malformed");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.page_json); }
  catch (cause) { fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal JSON is malformed", false, cause); }
  const page = WikiPageRevisionSchema.safeParse(parsed);
  if (!page.success || page.data.page_ref.id !== row.page_id || page.data.page_ref.revision !== row.page_revision) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki proposal page identity is inconsistent");
  }
  return {
    proposal_ref: { id: row.proposal_id, revision: 1 },
    page: page.data,
    risk_class: row.risk_class as DraftRiskClass,
  };
}

export async function loadAuthority(database: D1Database, proposal: ProposalRow): Promise<AuthorityRow | null> {
  try {
    return await database.prepare(
      "SELECT proposal_id, proposal_revision, evidence_receipt_ref, coverage_receipt_json, " +
      "dependency_closure_receipt_ref, verifier_receipt_ref, policy_receipt_ref, coverage_complete, " +
      "dependency_closure_complete, conflict_count, changes_current_state, state " +
      "FROM wiki_publication_authority WHERE proposal_id = ?1 AND proposal_revision = ?2 LIMIT 1",
    ).bind(proposal.proposal_id, proposal.proposal_revision).first<AuthorityRow>();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki authority readback is unavailable", true, cause);
  }
}

export function sameCoverage(page: WikiPageRevision, encoded: string): boolean {
  try {
    const parsed = VersionedRefSchema.safeParse(JSON.parse(encoded));
    return parsed.success && parsed.data.id === page.coverage_receipt_ref.id
      && parsed.data.revision === page.coverage_receipt_ref.revision;
  } catch { return false; }
}

export async function loadProposalRow(database: D1Database, proposalRef: VersionedRef, principalRef: string): Promise<ProposalRow | null> {
  try {
    return await database.prepare(
      "SELECT proposal_id, proposal_revision, principal_ref, idempotency_key, request_sha256, page_id, " +
      "page_revision, page_sha256, page_json, risk_class, body_size, evidence_map_sha256, " +
      "evidence_map_size, dependency_refs_sha256, state, created_at FROM wiki_publication_proposal " +
      "WHERE proposal_id = ?1 AND proposal_revision = ?2 AND principal_ref = ?3 LIMIT 1",
    ).bind(proposalRef.id, proposalRef.revision, principalRef).first<ProposalRow>();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki proposal readback is unavailable", true, cause);
  }
}

export function decodeWikiOwnerReviewReceipt(bytes: Uint8Array): WikiOwnerReviewReceipt | null {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const expected = [
    "admitted_at", "artifact_ref", "changes_current_state", "conflict_count", "coverage_complete",
    "coverage_receipt_ref", "dependency_closure_complete", "dependency_closure_receipt_ref",
    "evidence_receipt_ref", "limitations", "operation_id", "page_ref", "principal_ref", "provenance",
    "proposal_ref", "protocol", "supported_claim_count", "verifier_receipt_ref",
  ].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      value.protocol !== "eliotr.wiki.owner-review.v1" ||
      typeof value.principal_ref !== "string" || !value.principal_ref.trim() ||
      typeof value.operation_id !== "string" || !SAFE_REF.test(value.operation_id) ||
      typeof value.evidence_receipt_ref !== "string" || !SAFE_REF.test(value.evidence_receipt_ref) ||
      typeof value.dependency_closure_receipt_ref !== "string" || !SAFE_REF.test(value.dependency_closure_receipt_ref) ||
      typeof value.verifier_receipt_ref !== "string" || !SAFE_REF.test(value.verifier_receipt_ref) ||
      !VersionedRefSchema.safeParse(value.proposal_ref).success || !VersionedRefSchema.safeParse(value.page_ref).success ||
      !VersionedRefSchema.safeParse(value.artifact_ref).success || !VersionedRefSchema.safeParse(value.coverage_receipt_ref).success ||
      typeof value.coverage_complete !== "boolean" || typeof value.dependency_closure_complete !== "boolean" ||
      value.conflict_count !== 0 || value.changes_current_state !== false ||
      !Number.isSafeInteger(value.supported_claim_count) || (value.supported_claim_count as number) < 0 ||
      !Array.isArray(value.limitations) || value.limitations.some((item) => typeof item !== "string") ||
      value.provenance === null || typeof value.provenance !== "object" || Array.isArray(value.provenance) ||
      typeof value.admitted_at !== "string" || Number.isNaN(Date.parse(value.admitted_at)) || !value.admitted_at.endsWith("Z")) {
    return null;
  }
  return value as unknown as WikiOwnerReviewReceipt;
}

export function decodeWikiOwnerEditReviewReceipt(bytes: Uint8Array): WikiOwnerEditReviewReceipt | null {
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_MANIFEST_BYTES) return null;
  let encoded: string;
  let parsed: unknown;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(encoded);
    if (canonicalEvidenceJson(parsed) !== encoded) return null;
  } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const expected = [
    "admitted_at", "base_page_ref", "base_page_sha256", "base_proposal_ref", "body_sha256",
    "changes_current_state", "conflict_count", "coverage_complete", "coverage_receipt_ref",
    "dependency_closure_complete", "dependency_closure_receipt_ref", "evidence_receipt_ref",
    "limitations", "page_ref", "principal_ref", "provenance", "proposal_ref", "protocol",
    "supported_claim_count", "verifier_receipt_ref",
  ].sort();
  const keys = Object.keys(value).sort();
  const proposal = VersionedRefSchema.safeParse(value.proposal_ref);
  const page = VersionedRefSchema.safeParse(value.page_ref);
  const baseProposal = VersionedRefSchema.safeParse(value.base_proposal_ref);
  const basePage = VersionedRefSchema.safeParse(value.base_page_ref);
  const coverage = VersionedRefSchema.safeParse(value.coverage_receipt_ref);
  const limitations = value.limitations;
  const provenance = value.provenance;
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      value.protocol !== "eliotr.wiki.owner-edit-review.v1" ||
      !proposal.success || proposal.data.revision !== 1 || !page.success ||
      !baseProposal.success || baseProposal.data.revision !== 1 || !basePage.success ||
      !coverage.success ||
      typeof value.principal_ref !== "string" || value.principal_ref.length < 1 || value.principal_ref.length > 256 ||
      value.principal_ref !== value.principal_ref.trim() ||
      typeof value.base_page_sha256 !== "string" || !DIGEST.test(value.base_page_sha256) ||
      typeof value.body_sha256 !== "string" || !DIGEST.test(value.body_sha256) ||
      typeof value.evidence_receipt_ref !== "string" || !SAFE_REF.test(value.evidence_receipt_ref) ||
      typeof value.dependency_closure_receipt_ref !== "string" || !SAFE_REF.test(value.dependency_closure_receipt_ref) ||
      typeof value.verifier_receipt_ref !== "string" || !SAFE_REF.test(value.verifier_receipt_ref) ||
      value.coverage_complete !== false || value.dependency_closure_complete !== true ||
      value.conflict_count !== 0 || value.changes_current_state !== false || value.supported_claim_count !== 0 ||
      !Array.isArray(limitations) || limitations.length < 1 ||
      limitations.some((item) => typeof item !== "string" || item.trim().length === 0) ||
      provenance === null || typeof provenance !== "object" || Array.isArray(provenance) ||
      typeof value.admitted_at !== "string" || Number.isNaN(Date.parse(value.admitted_at)) ||
      !value.admitted_at.endsWith("Z")) {
    return null;
  }
  return value as unknown as WikiOwnerEditReviewReceipt;
}

export async function loadProposalRows(
  database: D1Database,
  principalRef: string,
  limit: number,
): Promise<readonly ProposalRow[]> {
  const principal = validPrincipal(principalRef);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    fail("WIKI_INPUT_INVALID", "Wiki proposal list limit is invalid");
  }
  try {
    const result = await database.prepare(
      "SELECT proposal_id, proposal_revision, principal_ref, idempotency_key, request_sha256, page_id, " +
      "page_revision, page_sha256, page_json, risk_class, body_size, evidence_map_sha256, " +
      "evidence_map_size, dependency_refs_sha256, state, created_at FROM wiki_publication_proposal " +
      "WHERE principal_ref = ?1 ORDER BY created_at DESC, proposal_id DESC LIMIT ?2",
    ).bind(principal, limit + 1).all<ProposalRow>();
    if (!result.success || !Array.isArray(result.results) || result.results.length > limit + 1) {
      fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki proposal list readback is unavailable", true);
    }
    return result.results;
  } catch (cause) {
    if (cause instanceof WikiPublicationError) throw cause;
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki proposal list readback is unavailable", true, cause);
  }
}

export async function recordWikiPublicationAuthority(
  database: D1Database,
  input: WikiAuthorityAdmission,
): Promise<void> {
  const ref = VersionedRefSchema.safeParse(input.proposal_ref);
  if (!ref.success || ref.data.revision !== 1) fail("WIKI_INPUT_INVALID", "proposal reference is invalid");
  const principal = validPrincipal(input.principal_ref);
  for (const value of [input.evidence_receipt_ref, input.dependency_closure_receipt_ref, input.verifier_receipt_ref]) {
    validRef(value, "Wiki authority receipt reference");
  }
  if (input.policy_receipt_ref !== undefined) validRef(input.policy_receipt_ref, "Wiki policy receipt reference");
  if (!Number.isSafeInteger(input.conflict_count) || input.conflict_count < 0) {
    fail("WIKI_INPUT_INVALID", "Wiki conflict count is invalid");
  }
  const proposal = await loadProposalRow(database, ref.data, principal);
  if (proposal === null) fail("WIKI_PROPOSAL_NOT_FOUND", "Wiki proposal does not exist");
  const page = decodeProposal(proposal).page;
  const encodedCoverage = JSON.stringify(page.coverage_receipt_ref);
  const admittedAt = input.admitted_at ?? new Date().toISOString();
  try {
    await database.prepare(
      "INSERT OR IGNORE INTO wiki_publication_authority " +
      "(proposal_id, proposal_revision, evidence_receipt_ref, coverage_receipt_json, " +
      "dependency_closure_receipt_ref, verifier_receipt_ref, policy_receipt_ref, coverage_complete, " +
      "dependency_closure_complete, conflict_count, changes_current_state, state, admitted_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'VERIFIED',?12)",
    ).bind(
      proposal.proposal_id, proposal.proposal_revision, input.evidence_receipt_ref, encodedCoverage,
      input.dependency_closure_receipt_ref, input.verifier_receipt_ref, input.policy_receipt_ref ?? null,
      input.coverage_complete ? 1 : 0, input.dependency_closure_complete ? 1 : 0,
      input.conflict_count, input.changes_current_state ? 1 : 0, admittedAt,
    ).run();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki authority mutation is uncertain", true, cause);
  }
  const stored = await loadAuthority(database, proposal);
  if (stored === null || stored.state !== "VERIFIED" || stored.evidence_receipt_ref !== input.evidence_receipt_ref
      || stored.dependency_closure_receipt_ref !== input.dependency_closure_receipt_ref
      || stored.verifier_receipt_ref !== input.verifier_receipt_ref || stored.coverage_receipt_json !== encodedCoverage
      || stored.coverage_complete !== (input.coverage_complete ? 1 : 0)
      || stored.dependency_closure_complete !== (input.dependency_closure_complete ? 1 : 0)
      || stored.conflict_count !== input.conflict_count
      || stored.changes_current_state !== (input.changes_current_state ? 1 : 0)
      || stored.policy_receipt_ref !== (input.policy_receipt_ref ?? null)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki authority failed exact readback");
  }
}
