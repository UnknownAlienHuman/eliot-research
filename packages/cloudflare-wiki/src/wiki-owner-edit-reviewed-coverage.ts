import { VersionedRefSchema, type WikiPageRevision } from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import {
  MAX_BODY_BYTES,
  MAX_MANIFEST_BYTES,
  SAFE_REF,
  decodeWikiOwnerEditReviewReceipt,
  dependencyDigest,
  fail,
  pageJson,
  readObject,
  sameCoverage,
  textDigest,
  type AuthorityRow,
  type ProposalRow,
  type WikiOwnerEditReviewReceipt,
} from "./wiki-publication-store-support.js";
export const WIKI_OWNER_EDIT_PROTOCOL = "eliotr.wiki-owner-edit.v1" as const;
const WIKI_OWNER_EDIT_GENERATOR = "wiki-owner-edit-v1" as const;
const OWNER_EDIT_DIGEST = /^[a-f0-9]{64}$/u;
const OWNER_EDIT_METADATA_KEYS = [
  "base_body_sha256", "base_coverage_receipt_ref", "base_dependency_refs_sha256",
  "base_evidence_map_ref", "base_evidence_map_sha256", "base_page_ref", "base_page_sha256",
  "base_proposal_ref", "edit_note", "edit_request_sha256", "expected_head_revision", "protocol",
] as const;

interface OwnerEditMetadata {
  readonly base_body_sha256: string;
  readonly base_coverage_receipt_ref: { readonly id: string; readonly revision: number };
  readonly base_dependency_refs_sha256: string;
  readonly base_evidence_map_ref: string;
  readonly base_evidence_map_sha256: string;
  readonly base_page_ref: { readonly id: string; readonly revision: number };
  readonly base_page_sha256: string;
  readonly base_proposal_ref: { readonly id: string; readonly revision: number };
  readonly edit_request_sha256: string;
  readonly expected_head_revision: number;
}

interface OwnerEditBindingRow {
  readonly proposal_id: string;
  readonly proposal_revision: number;
  readonly principal_ref: string;
  readonly idempotency_key: string;
  readonly request_sha256: string;
  readonly proposal_page_sha256: string;
  readonly base_proposal_id: string;
  readonly base_proposal_revision: number;
  readonly base_page_id: string;
  readonly base_page_revision: number;
  readonly base_page_sha256: string;
  readonly created_at: string;
}

function sameRef(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeOwnerEditRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_REF.test(value) && !value.includes("..") && !value.includes("\\");
}

function parseOwnerEditMetadata(page: WikiPageRevision): OwnerEditMetadata | null {
  const value = page.publication_metadata;
  if (!exactKeys(value, OWNER_EDIT_METADATA_KEYS) || value.protocol !== WIKI_OWNER_EDIT_PROTOCOL) return null;
  const baseProposal = VersionedRefSchema.safeParse(value.base_proposal_ref);
  const basePage = VersionedRefSchema.safeParse(value.base_page_ref);
  const baseCoverage = VersionedRefSchema.safeParse(value.base_coverage_receipt_ref);
  if (!baseProposal.success || baseProposal.data.revision !== 1 || !basePage.success || !baseCoverage.success ||
      typeof value.base_body_sha256 !== "string" || !OWNER_EDIT_DIGEST.test(value.base_body_sha256) ||
      typeof value.base_page_sha256 !== "string" || !OWNER_EDIT_DIGEST.test(value.base_page_sha256) ||
      typeof value.base_evidence_map_sha256 !== "string" || !OWNER_EDIT_DIGEST.test(value.base_evidence_map_sha256) ||
      typeof value.base_dependency_refs_sha256 !== "string" || !OWNER_EDIT_DIGEST.test(value.base_dependency_refs_sha256) ||
      typeof value.base_evidence_map_ref !== "string" || !safeOwnerEditRef(value.base_evidence_map_ref) ||
      typeof value.edit_request_sha256 !== "string" || !OWNER_EDIT_DIGEST.test(value.edit_request_sha256) ||
      typeof value.edit_note !== "string" || value.edit_note.length > 4_096 ||
      !Number.isSafeInteger(value.expected_head_revision) || (value.expected_head_revision as number) < 1) {
    return null;
  }
  return {
    base_body_sha256: value.base_body_sha256,
    base_coverage_receipt_ref: baseCoverage.data,
    base_dependency_refs_sha256: value.base_dependency_refs_sha256,
    base_evidence_map_ref: value.base_evidence_map_ref,
    base_evidence_map_sha256: value.base_evidence_map_sha256,
    base_page_ref: basePage.data,
    base_page_sha256: value.base_page_sha256,
    base_proposal_ref: baseProposal.data,
    edit_request_sha256: value.edit_request_sha256,
    expected_head_revision: value.expected_head_revision as number,
  };
}

async function loadOwnerEditBinding(
  database: D1Database,
  proposal: ProposalRow,
  principal: string,
): Promise<OwnerEditBindingRow | null> {
  try {
    return await database.prepare(
      "SELECT proposal_id, proposal_revision, principal_ref, idempotency_key, request_sha256, " +
      "proposal_page_sha256, base_proposal_id, base_proposal_revision, base_page_id, base_page_revision, " +
      "base_page_sha256, created_at FROM wiki_owner_edit_binding " +
      "WHERE proposal_id=?1 AND proposal_revision=?2 AND principal_ref=?3 LIMIT 1",
    ).bind(proposal.proposal_id, proposal.proposal_revision, principal).first<OwnerEditBindingRow>();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki owner edit binding readback is unavailable", true, cause);
  }
}

function bindingMatches(
  binding: OwnerEditBindingRow,
  proposal: ProposalRow,
  principal: string,
  metadata: OwnerEditMetadata,
): boolean {
  return safeOwnerEditRef(binding.proposal_id) && binding.proposal_id === proposal.proposal_id &&
    binding.proposal_revision === proposal.proposal_revision && binding.principal_ref === principal &&
    typeof binding.idempotency_key === "string" && binding.idempotency_key.length > 0 &&
    binding.idempotency_key.length <= 256 && binding.idempotency_key === proposal.idempotency_key &&
    OWNER_EDIT_DIGEST.test(binding.request_sha256) &&
    binding.request_sha256 === metadata.edit_request_sha256 &&
    OWNER_EDIT_DIGEST.test(binding.proposal_page_sha256) && binding.proposal_page_sha256 === proposal.page_sha256 &&
    binding.base_proposal_id === metadata.base_proposal_ref.id &&
    binding.base_proposal_revision === metadata.base_proposal_ref.revision &&
    binding.base_page_id === metadata.base_page_ref.id &&
    binding.base_page_revision === metadata.base_page_ref.revision &&
    OWNER_EDIT_DIGEST.test(binding.base_page_sha256) && binding.base_page_sha256 === metadata.base_page_sha256 &&
    binding.created_at === proposal.created_at;
}

export async function validateOwnerEditReviewedCoverage(
  bucket: R2Bucket,
  database: D1Database,
  principal: string,
  proposal: ProposalRow,
  page: WikiPageRevision,
  authority: AuthorityRow | null,
): Promise<boolean> {
  if (page.generator_generation !== WIKI_OWNER_EDIT_GENERATOR || page.status !== "DRAFT" ||
      proposal.state !== "PROPOSED" || proposal.risk_class !== "D2_ANALYTICAL") return false;
  const metadata = parseOwnerEditMetadata(page);
  if (metadata === null || page.page_ref.id !== metadata.base_page_ref.id ||
      page.page_ref.revision !== metadata.base_page_ref.revision + 1 ||
      page.supersedes_ref === undefined || !sameRef(page.supersedes_ref, metadata.base_page_ref) ||
      !sameRef(page.coverage_receipt_ref, metadata.base_coverage_receipt_ref) ||
      metadata.expected_head_revision !== metadata.base_page_ref.revision ||
      page.counterposition_refs.length !== 0 || page.limitations.length < 1 ||
      Object.keys(page.statement_labels).length < 1 ||
      Object.values(page.statement_labels).some((label) => label !== "UNRESOLVED") ||
      page.dependency_refs.length !== 1 || page.dependency_refs[0] !== page.evidence_map_ref ||
      authority === null || authority.state !== "VERIFIED" || authority.policy_receipt_ref === null ||
      authority.coverage_complete !== 0 || authority.dependency_closure_complete !== 1 ||
      authority.conflict_count !== 0 || authority.changes_current_state !== 0 ||
      !safeOwnerEditRef(authority.evidence_receipt_ref) || authority.evidence_receipt_ref !== page.evidence_map_ref ||
      !safeOwnerEditRef(authority.dependency_closure_receipt_ref) || !safeOwnerEditRef(authority.verifier_receipt_ref) ||
      !safeOwnerEditRef(authority.policy_receipt_ref) || !sameCoverage(page, authority.coverage_receipt_json)) return false;

  if (await textDigest(pageJson(page)) !== proposal.page_sha256 || await dependencyDigest(page) !== proposal.dependency_refs_sha256) {
    return false;
  }
  const receiptObject = await readObject(bucket, authority.policy_receipt_ref, MAX_MANIFEST_BYTES);
  const receipt = decodeWikiOwnerEditReviewReceipt(receiptObject.bytes);
  if (receipt === null || !ownerEditReceiptMatches(receipt, proposal, page, principal, metadata, authority)) return false;
  const body = await readObject(bucket, page.body_object_ref, MAX_BODY_BYTES);
  if (body.sha256 !== page.body_sha256 || body.sha256 !== receipt.body_sha256 || body.bytes.byteLength !== proposal.body_size) {
    return false;
  }
  const binding = await loadOwnerEditBinding(database, proposal, principal);
  return binding !== null && bindingMatches(binding, proposal, principal, metadata);
}

function ownerEditReceiptMatches(
  receipt: WikiOwnerEditReviewReceipt,
  proposal: ProposalRow,
  page: WikiPageRevision,
  principal: string,
  metadata: OwnerEditMetadata,
  authority: AuthorityRow,
): boolean {
  return receipt.proposal_ref.id === proposal.proposal_id && receipt.proposal_ref.revision === proposal.proposal_revision &&
    sameRef(receipt.page_ref, page.page_ref) && receipt.principal_ref === principal &&
    sameRef(receipt.base_proposal_ref, metadata.base_proposal_ref) && sameRef(receipt.base_page_ref, metadata.base_page_ref) &&
    receipt.base_page_sha256 === metadata.base_page_sha256 && receipt.body_sha256 === page.body_sha256 &&
    sameRef(receipt.coverage_receipt_ref, page.coverage_receipt_ref) &&
    receipt.evidence_receipt_ref === authority.evidence_receipt_ref &&
    receipt.dependency_closure_receipt_ref === authority.dependency_closure_receipt_ref &&
    receipt.verifier_receipt_ref === authority.verifier_receipt_ref && receipt.coverage_complete === false &&
    receipt.dependency_closure_complete === true && receipt.conflict_count === 0 &&
    receipt.changes_current_state === false && receipt.supported_claim_count === 0 &&
    canonicalEvidenceJson(receipt.limitations) === canonicalEvidenceJson(page.limitations);
}
