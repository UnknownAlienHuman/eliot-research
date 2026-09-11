import {
  VersionedRefSchema,
  WikiPageRevisionSchema,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import {
  WikiPublicationError,
  type DraftRiskClass,
  type WikiProposalRecord,
} from "@eliotr/research";

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
      "evidence_map_size, dependency_refs_sha256, state FROM wiki_publication_proposal " +
      "WHERE proposal_id = ?1 AND proposal_revision = ?2 AND principal_ref = ?3 LIMIT 1",
    ).bind(proposalRef.id, proposalRef.revision, principalRef).first<ProposalRow>();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki proposal readback is unavailable", true, cause);
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
