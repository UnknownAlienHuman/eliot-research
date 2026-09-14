import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { WikiPublicationError, type WikiPublicationErrorCode } from "@eliotr/research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import {
  readOwnerEditReviewProof,
} from "./wiki-owner-edit-review-proof.js";
import {
  MAX_MANIFEST_BYTES,
  decodeProposal,
  decodeWikiOwnerEditReviewReceipt,
  loadAuthority,
  loadProposalRow,
  readObject,
  recordWikiPublicationAuthority,
  sha256,
  validRef,
  type WikiOwnerEditReviewReceipt,
} from "./wiki-publication-store-support.js";

const OWNER_EDIT_PROTOCOL = "eliotr.wiki-owner-edit.v1" as const;
const REVIEW_RECEIPT_PROTOCOL = "eliotr.wiki.owner-edit-review.v1" as const;
const INTEGRITY_RECEIPT_PROTOCOL = "eliotr.wiki.owner-edit-integrity.v1" as const;

/** The proof reader owns source/body/evidence/binding checks and current scope. */
type OwnerEditReviewProof = Awaited<ReturnType<typeof readOwnerEditReviewProof>>;

export interface WikiOwnerEditReviewAdmissionResult {
  readonly protocol: typeof REVIEW_RECEIPT_PROTOCOL;
  readonly proposal_ref: VersionedRef;
  readonly review_receipt_ref: string;
  readonly coverage_complete: false;
  readonly supported_claim_count: 0;
}

function fail(code: WikiPublicationErrorCode, message: string, retryable = false): never {
  throw new WikiPublicationError(code, message, retryable);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function exactString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length < 1) fail("WIKI_PROPOSAL_READBACK_MISMATCH", message);
  return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function writeImmutable(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
): Promise<void> {
  validRef(key, "Wiki owner edit receipt reference");
  try {
    await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
      httpMetadata: { contentType: "application/json" },
      customMetadata: { immutable: "true", sha256: digest, size_bytes: String(bytes.byteLength) },
    });
  } catch {
    // The immutable readback below settles a conditional collision or lost put.
  }
  const observed = await readObject(bucket, key, MAX_MANIFEST_BYTES);
  if (observed.sha256 !== digest || !bytesEqual(observed.bytes, bytes)) {
    fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "Wiki owner edit receipt failed exact readback");
  }
}

function integrityObject(proof: OwnerEditReviewProof): Record<string, unknown> {
  return {
    base_page_ref: { ...proof.base_page_ref },
    base_page_sha256: proof.base_page_sha256,
    base_proposal_ref: { ...proof.base_proposal_ref },
    body_sha256: proof.body_sha256,
    coverage_receipt_ref: { ...proof.coverage_receipt_ref },
    dependency_refs: [...proof.dependency_refs].sort(),
    evidence_receipt_ref: proof.evidence_receipt_ref,
    page_ref: { ...proof.page_ref },
    principal_ref: proof.principal_ref,
    proposal_ref: { ...proof.proposal_ref },
    protocol: INTEGRITY_RECEIPT_PROTOCOL,
    provenance: proof.provenance,
  };
}

function receiptMatches(
  receipt: WikiOwnerEditReviewReceipt,
  proof: OwnerEditReviewProof,
  admittedAt: string,
  integrityRef: string,
): boolean {
  return receipt.protocol === REVIEW_RECEIPT_PROTOCOL &&
    sameRef(receipt.proposal_ref, proof.proposal_ref) && sameRef(receipt.page_ref, proof.page_ref) &&
    receipt.principal_ref === proof.principal_ref && sameRef(receipt.base_proposal_ref, proof.base_proposal_ref) &&
    sameRef(receipt.base_page_ref, proof.base_page_ref) && receipt.base_page_sha256 === proof.base_page_sha256 &&
    receipt.body_sha256 === proof.body_sha256 && sameRef(receipt.coverage_receipt_ref, proof.coverage_receipt_ref) &&
    receipt.evidence_receipt_ref === proof.evidence_receipt_ref &&
    receipt.dependency_closure_receipt_ref === integrityRef && receipt.verifier_receipt_ref === integrityRef &&
    receipt.coverage_complete === false && receipt.dependency_closure_complete === true &&
    receipt.conflict_count === 0 && receipt.changes_current_state === false &&
    receipt.supported_claim_count === 0 &&
    canonicalEvidenceJson(receipt.limitations) === canonicalEvidenceJson(proof.limitations) &&
    canonicalEvidenceJson(receipt.provenance) === canonicalEvidenceJson(proof.provenance) &&
    receipt.admitted_at === admittedAt;
}

/**
 * Owner-edit admission deliberately records provenance integrity only.  It
 * does not turn the inherited research coverage into a verified result.
 */
export async function admitWikiOwnerEditReview(
  env: Env,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
): Promise<WikiOwnerEditReviewAdmissionResult | null> {
  if (context.client_class !== "owner_pwa") {
    fail("WIKI_POLICY_DENIED", "Wiki owner edit review requires an owner session");
  }
  const ref = VersionedRefSchema.safeParse(proposalRef);
  if (!ref.success || ref.data.revision !== 1) fail("WIKI_INPUT_INVALID", "Wiki proposal reference is invalid");
  const row = await loadProposalRow(env.CORE_DB, ref.data, context.principal_ref);
  if (row === null) fail("WIKI_PROPOSAL_NOT_FOUND", "Wiki proposal does not exist");
  const proposal = decodeProposal(row);
  if (proposal.page.publication_metadata.protocol !== OWNER_EDIT_PROTOCOL) return null;

  const proof = await readOwnerEditReviewProof(env, context, ref.data);
  if (!sameRef(proof.proposal_ref, ref.data) || proof.principal_ref !== context.principal_ref ||
      !sameRef(proof.page_ref, proposal.page.page_ref) ||
      !sameRef(proof.coverage_receipt_ref, proposal.page.coverage_receipt_ref) ||
      proof.evidence_receipt_ref !== proposal.page.evidence_map_ref) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit proof is not bound to the proposal");
  }

  const integrityEncoded = canonicalEvidenceJson(integrityObject(proof));
  const integrityBytes = new TextEncoder().encode(integrityEncoded);
  const integrityDigest = await sha256(integrityBytes);
  const integrityRef = `wiki/owner-edit-review/${ref.data.id}/${integrityDigest}.integrity.json`;
  await writeImmutable(env.WORK_BUCKET, integrityRef, integrityBytes, integrityDigest);

  const existingAuthority = await loadAuthority(env.CORE_DB, row);
  const existingReceiptRef = existingAuthority?.policy_receipt_ref ?? null;
  let admittedAt = new Date().toISOString();
  if (existingReceiptRef !== null) {
    const existingObject = await readObject(env.WORK_BUCKET, existingReceiptRef, MAX_MANIFEST_BYTES);
    const existingReceipt = decodeWikiOwnerEditReviewReceipt(existingObject.bytes);
    if (existingReceipt === null) fail("WIKI_PROPOSAL_READBACK_MISMATCH", "existing Wiki owner edit receipt is malformed");
    admittedAt = exactString(existingReceipt.admitted_at, "existing Wiki owner edit receipt timestamp is invalid");
  }

  const receipt: WikiOwnerEditReviewReceipt = {
    protocol: REVIEW_RECEIPT_PROTOCOL,
    proposal_ref: { ...proof.proposal_ref },
    page_ref: { ...proof.page_ref },
    principal_ref: proof.principal_ref,
    base_proposal_ref: { ...proof.base_proposal_ref },
    base_page_ref: { ...proof.base_page_ref },
    base_page_sha256: proof.base_page_sha256,
    body_sha256: proof.body_sha256,
    coverage_receipt_ref: { ...proof.coverage_receipt_ref },
    evidence_receipt_ref: proof.evidence_receipt_ref,
    dependency_closure_receipt_ref: integrityRef,
    verifier_receipt_ref: integrityRef,
    coverage_complete: false,
    dependency_closure_complete: true,
    conflict_count: 0,
    changes_current_state: false,
    supported_claim_count: 0,
    limitations: [...proof.limitations],
    provenance: { ...proof.provenance },
    admitted_at: admittedAt,
  };
  const receiptEncoded = canonicalEvidenceJson(receipt);
  const receiptBytes = new TextEncoder().encode(receiptEncoded);
  const receiptDigest = await sha256(receiptBytes);
  const receiptRef = `wiki/owner-edit-review/${ref.data.id}/${receiptDigest}.json`;
  if (existingReceiptRef !== null && existingReceiptRef !== receiptRef) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "existing Wiki owner edit receipt is bound to different proof");
  }
  await writeImmutable(env.WORK_BUCKET, receiptRef, receiptBytes, receiptDigest);
  const receiptReadback = decodeWikiOwnerEditReviewReceipt(
    (await readObject(env.WORK_BUCKET, receiptRef, MAX_MANIFEST_BYTES)).bytes,
  );
  if (receiptReadback === null || !receiptMatches(receiptReadback, proof, admittedAt, integrityRef)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit receipt failed exact readback");
  }
  await proof.requireCurrent();
  await recordWikiPublicationAuthority(env.CORE_DB, {
    proposal_ref: ref.data,
    principal_ref: context.principal_ref,
    evidence_receipt_ref: receipt.evidence_receipt_ref,
    dependency_closure_receipt_ref: receipt.dependency_closure_receipt_ref,
    verifier_receipt_ref: receipt.verifier_receipt_ref,
    policy_receipt_ref: receiptRef,
    coverage_complete: false,
    dependency_closure_complete: true,
    conflict_count: 0,
    changes_current_state: false,
    admitted_at: admittedAt,
  });
  await proof.requireCurrent();
  return {
    protocol: REVIEW_RECEIPT_PROTOCOL,
    proposal_ref: { ...ref.data },
    review_receipt_ref: receiptRef,
    coverage_complete: false,
    supported_claim_count: 0,
  };
}
