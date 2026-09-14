import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { VersionedRefSchema, type VersionedRef, type WikiPageRevision } from "@eliotr/contracts";
import { createWikiPublisher, WikiPublicationError, type WikiPublicationPort } from "@eliotr/research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import { prepareOwnerScopeReadAuthorization } from "./wiki-proposal-reauthorization.js";
import { createD1R2WikiPublicationPort } from "./wiki-publication-store.js";
import type { WikiProposalResult } from "./wiki-service.js";
import { MAX_BODY_BYTES, MAX_EVIDENCE_MAP_BYTES, decodeProposal, dependencyDigest, loadProposalRow,
  pageJson, readObject, sha256, textDigest, validIdempotency, validRef, type ProposalRow } from "./wiki-publication-store-support.js";
export const WIKI_OWNER_EDIT_GENERATOR = "wiki-owner-edit-v1";
export const WIKI_OWNER_EDIT_PROTOCOL = "eliotr.wiki-owner-edit.v1";
export const WIKI_OWNER_EDIT_EVIDENCE_PROTOCOL = "eliotr.wiki-owner-edit-evidence.v1";
const EDIT_LIMITATION = "This owner edit is not covered by the inherited research audit; changed and new statements remain UNRESOLVED, while the original coverage and evidence are retained as provenance only.";
const EDIT_LABEL_PREFIX = "owner-edit-body:";
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_TITLE_CHARS = 512;
const MAX_EDIT_NOTE_CHARS = 4_096;
const EDIT_METADATA_KEYS = ["base_body_sha256", "base_coverage_receipt_ref", "base_dependency_refs_sha256", "base_evidence_map_ref", "base_evidence_map_sha256", "base_page_ref", "base_page_sha256", "base_proposal_ref", "edit_note", "edit_request_sha256", "expected_head_revision", "protocol"] as const;
const EDIT_EVIDENCE_KEYS = ["edit_note", "edit_request_sha256", "edited_body_object_ref", "edited_body_sha256", "edited_body_size", "edited_page_ref", "provenance", "protocol", "statement_labels"] as const;
const EDIT_PROVENANCE_KEYS = ["base_body_object_ref", "base_body_sha256", "base_coverage_receipt_ref", "base_dependency_refs", "base_dependency_refs_sha256", "base_evidence_map_ref", "base_evidence_map_sha256", "base_page_ref", "base_page_sha256", "base_proposal_ref", "original_scope_snapshot_ref"] as const;
export interface OwnerEditInput { readonly base_proposal_ref: VersionedRef; readonly expected_head_revision: number; readonly title: string; readonly body_text: string; readonly edit_note: string; readonly body_bytes: Uint8Array; }
export interface EditMetadata { readonly base_body_sha256: string; readonly base_coverage_receipt_ref: VersionedRef; readonly base_dependency_refs_sha256: string; readonly base_evidence_map_ref: string; readonly base_evidence_map_sha256: string; readonly base_page_ref: VersionedRef; readonly base_page_sha256: string; readonly base_proposal_ref: VersionedRef; readonly edit_note: string; readonly edit_request_sha256: string; readonly expected_head_revision: number; readonly protocol: typeof WIKI_OWNER_EDIT_PROTOCOL; }
export interface EditBindingRow { readonly proposal_id: string; readonly proposal_revision: number; readonly principal_ref: string; readonly idempotency_key: string; readonly request_sha256: string; readonly proposal_page_sha256: string; readonly base_proposal_id: string; readonly base_proposal_revision: number; readonly base_page_id: string; readonly base_page_revision: number; readonly base_page_sha256: string; readonly created_at: string; }
export interface PublishedRevisionRow { readonly proposal_id: string; readonly proposal_revision: number; readonly page_sha256: string; readonly page_json: string; readonly body_object_ref: string; readonly body_sha256: string; }
export interface CanonicalBase { readonly proposal: ProposalRow; readonly page: WikiPageRevision; readonly page_sha256: string; readonly evidence_map_sha256: string; readonly dependency_refs_sha256: string; readonly authorization: Awaited<ReturnType<typeof prepareOwnerScopeReadAuthorization>>; readonly port: WikiPublicationPort; readonly head: { readonly page_ref: VersionedRef; readonly manifest_ref: string; readonly outbox_ref: string; }; }
function fail(code: string, message: string, status = 400, retryable = false): never { throw new CatalogInputError(code, message, status, retryable); }
function requireOwner(context: AuthenticatedRequestContext): void { if (context.client_class !== "owner_pwa") fail("WIKI_OWNER_REQUIRED", "Wiki owner edit requires an owner session", 403); }
function sameRef(left: VersionedRef, right: VersionedRef): boolean { return left.id === right.id && left.revision === right.revision; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedText(value: unknown, label: string, maximumChars: number, allowEmpty = false): string {
  if (typeof value !== "string" || hasLoneSurrogate(value) || value.length > maximumChars || (!allowEmpty && value.trim().length === 0) || value.includes("\u0000")) {
    fail("WIKI_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]); }

function record(value: unknown, message: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail("WIKI_PROPOSAL_READBACK_MISMATCH", message, 409); return value as Record<string, unknown>; }

export function parseInput(raw: unknown): OwnerEditInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("WIKI_INPUT_INVALID", "Wiki owner edit must be an object");
  const value = raw as Record<string, unknown>;
  const expected = ["base_proposal_ref", "expected_head_revision", "title", "body_text", "edit_note"];
  if (!exactKeys(value, expected)) fail("WIKI_INPUT_INVALID", "Wiki owner edit has unknown or missing fields");
  const base = VersionedRefSchema.safeParse(value.base_proposal_ref);
  if (!base.success || base.data.revision !== 1) fail("WIKI_INPUT_INVALID", "base proposal reference is invalid");
  if (typeof value.expected_head_revision !== "number" || !Number.isSafeInteger(value.expected_head_revision) || value.expected_head_revision < 1) {
    fail("WIKI_INPUT_INVALID", "expected Wiki head revision is invalid");
  }
  const title = boundedText(value.title, "Wiki edit title", MAX_TITLE_CHARS);
  if (title !== title.trim()) fail("WIKI_INPUT_INVALID", "Wiki edit title must not have surrounding whitespace");
  const bodyText = boundedText(value.body_text, "Wiki edit body", MAX_BODY_BYTES, false);
  const bodyBytes = new TextEncoder().encode(bodyText);
  if (bodyBytes.byteLength < 1 || bodyBytes.byteLength > MAX_BODY_BYTES || bodyText.trim().length === 0) {
    fail("WIKI_INPUT_INVALID", "Wiki edit body exceeds its byte bound or is blank");
  }
  const editNote = boundedText(value.edit_note, "Wiki edit note", MAX_EDIT_NOTE_CHARS, true);
  return {
    base_proposal_ref: { ...base.data },
    expected_head_revision: value.expected_head_revision as number,
    title,
    body_text: bodyText,
    edit_note: editNote,
    body_bytes: bodyBytes,
  };
}

function editRequestObject(input: OwnerEditInput): Record<string, unknown> { return { base_proposal_ref: { ...input.base_proposal_ref }, body_text: input.body_text, edit_note: input.edit_note, expected_head_revision: input.expected_head_revision, title: input.title }; }

export function parseMetadata(value: unknown): EditMetadata {
  const metadata = record(value, "Wiki owner edit metadata is malformed");
  if (!exactKeys(metadata, EDIT_METADATA_KEYS) || metadata.protocol !== WIKI_OWNER_EDIT_PROTOCOL) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit metadata is invalid", 409);
  }
  const baseProposal = VersionedRefSchema.safeParse(metadata.base_proposal_ref);
  const basePage = VersionedRefSchema.safeParse(metadata.base_page_ref);
  const baseCoverage = VersionedRefSchema.safeParse(metadata.base_coverage_receipt_ref);
  if (!baseProposal.success || baseProposal.data.revision !== 1 || !basePage.success || !baseCoverage.success ||
      typeof metadata.base_page_sha256 !== "string" || !SHA256.test(metadata.base_page_sha256) ||
      typeof metadata.base_body_sha256 !== "string" || !SHA256.test(metadata.base_body_sha256) ||
      typeof metadata.base_evidence_map_sha256 !== "string" || !SHA256.test(metadata.base_evidence_map_sha256) ||
      typeof metadata.base_dependency_refs_sha256 !== "string" || !SHA256.test(metadata.base_dependency_refs_sha256) ||
      typeof metadata.base_evidence_map_ref !== "string" || typeof metadata.edit_request_sha256 !== "string" ||
      !SHA256.test(metadata.edit_request_sha256) || typeof metadata.expected_head_revision !== "number" ||
      !Number.isSafeInteger(metadata.expected_head_revision) || metadata.expected_head_revision < 1) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit metadata identity is invalid", 409);
  }
  validRef(metadata.base_evidence_map_ref, "base evidence map reference");
  const editNote = boundedText(metadata.edit_note, "Wiki edit note", MAX_EDIT_NOTE_CHARS, true);
  return {
    base_body_sha256: metadata.base_body_sha256,
    base_coverage_receipt_ref: { ...baseCoverage.data },
    base_dependency_refs_sha256: metadata.base_dependency_refs_sha256,
    base_evidence_map_ref: metadata.base_evidence_map_ref,
    base_evidence_map_sha256: metadata.base_evidence_map_sha256,
    base_page_ref: { ...basePage.data },
    base_page_sha256: metadata.base_page_sha256,
    base_proposal_ref: { ...baseProposal.data },
    edit_note: editNote,
    edit_request_sha256: metadata.edit_request_sha256,
    expected_head_revision: metadata.expected_head_revision,
    protocol: WIKI_OWNER_EDIT_PROTOCOL,
  };
}

function pageWithoutPublicationState(page: WikiPageRevision): Record<string, unknown> { const value: Record<string, unknown> = { ...page }; delete value.status; delete value.reviewer_ref; delete value.supersedes_ref; return value; }

export function sameProposalPage(left: WikiPageRevision, right: WikiPageRevision): boolean { return canonicalEvidenceJson(pageWithoutPublicationState(left)) === canonicalEvidenceJson(pageWithoutPublicationState(right)); }

function expectedLabel(bodySha256: string): string { return `${EDIT_LABEL_PREFIX}${bodySha256}`; }

export async function loadProposalByIdempotency(
  database: D1Database,
  principal: string,
  idempotencyKey: string,
): Promise<ProposalRow | null> {
  try {
    return await database.prepare(
      "SELECT proposal_id, proposal_revision, principal_ref, idempotency_key, request_sha256, page_id, " +
      "page_revision, page_sha256, page_json, risk_class, body_size, evidence_map_sha256, " +
      "evidence_map_size, dependency_refs_sha256, state, created_at FROM wiki_publication_proposal " +
      "WHERE principal_ref=?1 AND idempotency_key=?2 LIMIT 1",
    ).bind(principal, idempotencyKey).first<ProposalRow>();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki owner edit idempotency read is unavailable", 503, true);
  }
}

export async function loadPublishedRevision(
  database: D1Database,
  pageRef: VersionedRef,
  manifestRef: string,
): Promise<PublishedRevisionRow | null> {
  try {
    return await database.prepare(
      "SELECT proposal_id, proposal_revision, page_sha256, page_json, body_object_ref, body_sha256 " +
      "FROM wiki_publication_revision WHERE page_id=?1 AND revision=?2 AND manifest_ref=?3 LIMIT 1",
    ).bind(pageRef.id, pageRef.revision, manifestRef).first<PublishedRevisionRow>();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki base revision read is unavailable", 503, true);
  }
}

export async function readCanonicalBase(
  env: Env,
  context: AuthenticatedRequestContext,
  input: OwnerEditInput,
  idempotencyKey: string,
): Promise<CanonicalBase> {
  const proposal = await loadProposalRow(env.CORE_DB, input.base_proposal_ref, context.principal_ref);
  if (proposal === null) fail("WIKI_PROPOSAL_NOT_FOUND", "base Wiki proposal does not exist", 404);
  if (proposal.state !== "PUBLISHED") fail("WIKI_PUBLICATION_INCOMPLETE", "base Wiki proposal is not published", 422);
  const baseDraft = decodeProposal(proposal).page;
  if (proposal.page_id !== baseDraft.page_ref.id || proposal.page_revision !== baseDraft.page_ref.revision ||
      baseDraft.page_ref.revision !== input.expected_head_revision) {
    fail("WIKI_HEAD_CONFLICT", "base Wiki proposal is not the expected head", 409);
  }
  const authorization = await prepareOwnerScopeReadAuthorization(env, context, baseDraft.scope_snapshot_ref);
  await authorization.requireCurrent();
  const port = createD1R2WikiPublicationPort(env.CORE_DB, env.WORK_BUCKET, {
    principal_ref: context.principal_ref,
    idempotency_key: idempotencyKey,
  });
  const head = await port.readHead(baseDraft.page_ref.id);
  if (head === null || !sameRef(head.page_ref, baseDraft.page_ref) ||
      head.page_ref.revision !== input.expected_head_revision) {
    fail("WIKI_HEAD_CONFLICT", "base Wiki head changed", 409);
  }
  const page = await port.readImmutableRevision(head.page_ref, head.manifest_ref);
  if (page === null || page.status !== "PUBLISHED" || !sameRef(page.page_ref, head.page_ref) ||
      !sameProposalPage(baseDraft, page)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "base Wiki revision is not the canonical published proposal", 409);
  }
  const encodedPage = pageJson(page);
  const pageSha256 = await textDigest(encodedPage);
  const revision = await loadPublishedRevision(env.CORE_DB, page.page_ref, head.manifest_ref);
  if (revision === null || revision.proposal_id !== proposal.proposal_id ||
      revision.proposal_revision !== proposal.proposal_revision || revision.page_sha256 !== pageSha256 ||
      revision.page_json !== encodedPage || revision.body_object_ref !== page.body_object_ref ||
      revision.body_sha256 !== page.body_sha256) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "base Wiki revision lineage is inconsistent", 409);
  }
  const body = await readObject(env.WORK_BUCKET, page.body_object_ref, MAX_BODY_BYTES);
  if (body.sha256 !== page.body_sha256) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "base Wiki body digest is inconsistent", 409);
  }
  const evidence = await readObject(env.WORK_BUCKET, page.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
  if (evidence.sha256 !== proposal.evidence_map_sha256 || evidence.bytes.byteLength !== proposal.evidence_map_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "base Wiki evidence map identity is inconsistent", 409);
  }
  const dependencyRefsSha256 = await dependencyDigest(page);
  if (dependencyRefsSha256 !== proposal.dependency_refs_sha256) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "base Wiki dependency identity is inconsistent", 409);
  }
  await authorization.requireCurrent();
  const settledHead = await port.readHead(page.page_ref.id);
  if (settledHead === null || !sameRef(settledHead.page_ref, head.page_ref) ||
      settledHead.manifest_ref !== head.manifest_ref || settledHead.outbox_ref !== head.outbox_ref) {
    fail("WIKI_HEAD_CONFLICT", "base Wiki head changed during readback", 409);
  }
  return {
    proposal,
    page,
    page_sha256: pageSha256,
    evidence_map_sha256: evidence.sha256,
    dependency_refs_sha256: dependencyRefsSha256,
    authorization,
    port,
    head: {
      page_ref: { ...head.page_ref },
      manifest_ref: head.manifest_ref,
      outbox_ref: head.outbox_ref,
    },
  };
}

async function writeImmutableObject(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
  maximumBytes: number,
  contentType: string,
): Promise<void> {
  validRef(key, "Wiki owner edit object reference");
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes || await sha256(bytes) !== digest) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit object identity is invalid", 409);
  }
  try {
    await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
      httpMetadata: { contentType },
      customMetadata: { immutable: "true", sha256: digest, size_bytes: String(bytes.byteLength) },
    });
  } catch {
    // Exact readback settles conditional collisions and lost acknowledgements.
  }
  const observed = await readObject(bucket, key, maximumBytes);
  if (observed.sha256 !== digest || !sameBytes(observed.bytes, bytes)) {
    fail("WIKI_IMMUTABLE_READBACK_MISMATCH", "Wiki owner edit object failed exact readback", 409);
  }
}

export function parseEditEvidenceObject(value: unknown, page: WikiPageRevision, metadata: EditMetadata, bodySize: number): void {
  const evidence = record(value, "Wiki owner edit evidence map is malformed");
  if (!exactKeys(evidence, EDIT_EVIDENCE_KEYS) || evidence.protocol !== WIKI_OWNER_EDIT_EVIDENCE_PROTOCOL ||
      evidence.edit_request_sha256 !== metadata.edit_request_sha256 || evidence.edit_note !== metadata.edit_note ||
      typeof evidence.edited_body_object_ref !== "string" || evidence.edited_body_object_ref !== page.body_object_ref ||
      typeof evidence.edited_body_sha256 !== "string" || evidence.edited_body_sha256 !== page.body_sha256 ||
      evidence.edited_page_ref === undefined || evidence.edited_body_size !== bodySize) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit evidence map is not bound to the edited page", 409);
  }
  const editedPage = VersionedRefSchema.safeParse(evidence.edited_page_ref);
  if (!editedPage.success || !sameRef(editedPage.data, page.page_ref)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit evidence page identity is invalid", 409);
  }
  const labels = record(evidence.statement_labels, "Wiki owner edit labels are malformed");
  const labelKeys = Object.keys(labels);
  if (labelKeys.length !== 1 || labels[labelKeys[0] ?? ""] !== "UNRESOLVED" ||
      labelKeys[0] !== expectedLabel(page.body_sha256)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit labels are not unresolved", 409);
  }
  const provenance = record(evidence.provenance, "Wiki owner edit provenance is malformed");
  if (!exactKeys(provenance, EDIT_PROVENANCE_KEYS)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit provenance shape is invalid", 409);
  }
  const baseProposal = VersionedRefSchema.safeParse(provenance.base_proposal_ref);
  const basePage = VersionedRefSchema.safeParse(provenance.base_page_ref);
  const baseCoverage = VersionedRefSchema.safeParse(provenance.base_coverage_receipt_ref);
  const originalScope = VersionedRefSchema.safeParse(provenance.original_scope_snapshot_ref);
  const dependencyRefs = provenance.base_dependency_refs;
  if (!baseProposal.success || !sameRef(baseProposal.data, metadata.base_proposal_ref) ||
      !basePage.success || !sameRef(basePage.data, metadata.base_page_ref) ||
      !baseCoverage.success || !sameRef(baseCoverage.data, metadata.base_coverage_receipt_ref) ||
      !originalScope.success || !sameRef(originalScope.data, page.scope_snapshot_ref) ||
      provenance.base_page_sha256 !== metadata.base_page_sha256 ||
      provenance.base_body_sha256 !== metadata.base_body_sha256 ||
      provenance.base_evidence_map_ref !== metadata.base_evidence_map_ref ||
      provenance.base_evidence_map_sha256 !== metadata.base_evidence_map_sha256 ||
      provenance.base_dependency_refs_sha256 !== metadata.base_dependency_refs_sha256 ||
      typeof provenance.base_body_object_ref !== "string" || typeof provenance.base_body_sha256 !== "string" ||
      !SHA256.test(provenance.base_body_sha256) || typeof provenance.base_evidence_map_ref !== "string" ||
      typeof provenance.base_evidence_map_sha256 !== "string" || !SHA256.test(provenance.base_evidence_map_sha256) ||
      typeof provenance.base_dependency_refs_sha256 !== "string" || !SHA256.test(provenance.base_dependency_refs_sha256) ||
      typeof dependencyRefs !== "object" || !Array.isArray(dependencyRefs) || dependencyRefs.some((ref) => typeof ref !== "string")) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit provenance identity is invalid", 409);
  }
  validRef(provenance.base_body_object_ref, "base body reference");
  validRef(provenance.base_evidence_map_ref, "base evidence map reference");
  const sortedDependencies = [...dependencyRefs as string[]].sort();
  if (new Set(sortedDependencies).size !== sortedDependencies.length ||
      canonicalEvidenceJson(sortedDependencies) !== canonicalEvidenceJson(dependencyRefs)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit provenance dependencies are not canonical", 409);
  }
}

export async function validateEditEvidence(bytes: Uint8Array, page: WikiPageRevision, metadata: EditMetadata, bodySize: number): Promise<void> {
  let encoded: string;
  let value: unknown;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(encoded);
  } catch {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit evidence map is malformed", 409);
  }
  try {
    if (canonicalEvidenceJson(value) !== encoded) {
      fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit evidence map is not canonical", 409);
    }
  } catch {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit evidence map is not canonical", 409);
  }
  parseEditEvidenceObject(value, page, metadata, bodySize);
  const provenance = record(record(value, "Wiki owner edit evidence map is malformed").provenance, "Wiki owner edit provenance is malformed");
  const dependencyRefs = provenance.base_dependency_refs as string[];
  const dependencyDigestValue = provenance.base_dependency_refs_sha256;
  if (typeof dependencyDigestValue !== "string" || await textDigest(JSON.stringify([...dependencyRefs].sort())) !== dependencyDigestValue) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit provenance dependency digest is invalid", 409);
  }
}

export async function validateEditProposalRow(
  row: ProposalRow,
  context: AuthenticatedRequestContext,
  input: OwnerEditInput,
  requestSha256: string,
  bodySha256: string,
): Promise<{ readonly page: WikiPageRevision; readonly metadata: EditMetadata }> {
  if (row.principal_ref !== context.principal_ref || row.idempotency_key.length < 1 ||
      (row.state !== "PROPOSED" && row.state !== "PUBLISHED") || row.risk_class !== "D2_ANALYTICAL") {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit proposal row is invalid", 409);
  }
  const page = decodeProposal(row).page;
  const metadata = parseMetadata(page.publication_metadata);
  if (metadata.edit_request_sha256 !== requestSha256 || !sameRef(metadata.base_proposal_ref, input.base_proposal_ref) ||
      metadata.expected_head_revision !== input.expected_head_revision ||
      page.status !== "DRAFT" || page.generator_generation !== WIKI_OWNER_EDIT_GENERATOR ||
      page.title !== input.title || page.body_sha256 !== bodySha256 ||
      page.page_ref.id !== metadata.base_page_ref.id || page.page_ref.revision !== metadata.base_page_ref.revision + 1 ||
      page.supersedes_ref === undefined || !sameRef(page.supersedes_ref, metadata.base_page_ref) ||
      page.coverage_receipt_ref.id !== metadata.base_coverage_receipt_ref.id || page.coverage_receipt_ref.revision !== metadata.base_coverage_receipt_ref.revision ||
      page.counterposition_refs.length !== 0 || !page.limitations.includes(EDIT_LIMITATION) ||
      !exactKeys(page.statement_labels, [expectedLabel(bodySha256)]) ||
      page.statement_labels[expectedLabel(bodySha256)] !== "UNRESOLVED" ||
      page.dependency_refs.length !== 1 || page.dependency_refs[0] !== page.evidence_map_ref ||
      await textDigest(pageJson(page)) !== row.page_sha256 || await dependencyDigest(page) !== row.dependency_refs_sha256) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit proposal is not bound to the request", 409);
  }
  return { page, metadata };
}

export async function loadEditBinding(database: D1Database, proposalRef: VersionedRef): Promise<EditBindingRow | null> {
  try {
    return await database.prepare(
      "SELECT proposal_id, proposal_revision, principal_ref, idempotency_key, request_sha256, " +
      "proposal_page_sha256, base_proposal_id, base_proposal_revision, base_page_id, base_page_revision, " +
      "base_page_sha256, created_at FROM wiki_owner_edit_binding " +
      "WHERE proposal_id=?1 AND proposal_revision=?2 LIMIT 1",
    ).bind(proposalRef.id, proposalRef.revision).first<EditBindingRow>();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki owner edit binding read is unavailable", 503, true);
  }
}

export function verifyBinding(
  row: EditBindingRow,
  proposal: ProposalRow,
  context: AuthenticatedRequestContext,
  idempotencyKey: string,
  requestSha256: string,
  metadata: EditMetadata,
): void {
  if (row.proposal_id !== proposal.proposal_id || row.proposal_revision !== proposal.proposal_revision ||
      row.principal_ref !== context.principal_ref || row.idempotency_key !== idempotencyKey ||
      row.request_sha256 !== requestSha256 || row.proposal_page_sha256 !== proposal.page_sha256 ||
      row.base_proposal_id !== metadata.base_proposal_ref.id ||
      row.base_proposal_revision !== metadata.base_proposal_ref.revision ||
      row.base_page_id !== metadata.base_page_ref.id || row.base_page_revision !== metadata.base_page_ref.revision ||
      row.base_page_sha256 !== metadata.base_page_sha256 || row.created_at !== proposal.created_at) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit binding is occupied by different identity", 409);
  }
}

async function settleBinding(
  env: Env,
  context: AuthenticatedRequestContext,
  proposal: ProposalRow,
  metadata: EditMetadata,
  idempotencyKey: string,
  requestSha256: string,
): Promise<void> {
  const proposalRef = { id: proposal.proposal_id, revision: proposal.proposal_revision };
  const existing = await loadEditBinding(env.CORE_DB, proposalRef);
  if (existing !== null) {
    verifyBinding(existing, proposal, context, idempotencyKey, requestSha256, metadata);
    return;
  }
  let mutationError: unknown;
  try {
    await env.CORE_DB.prepare(
      "INSERT OR IGNORE INTO wiki_owner_edit_binding " +
      "(proposal_id, proposal_revision, principal_ref, idempotency_key, request_sha256, proposal_page_sha256, " +
      "base_proposal_id, base_proposal_revision, base_page_id, base_page_revision, base_page_sha256, created_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
    ).bind(
      proposal.proposal_id, proposal.proposal_revision, context.principal_ref, idempotencyKey, requestSha256,
      proposal.page_sha256, metadata.base_proposal_ref.id, metadata.base_proposal_ref.revision,
      metadata.base_page_ref.id, metadata.base_page_ref.revision, metadata.base_page_sha256, proposal.created_at,
    ).run();
  } catch (cause) {
    mutationError = cause;
  }
  const settled = await loadEditBinding(env.CORE_DB, proposalRef);
  if (settled !== null) {
    verifyBinding(settled, proposal, context, idempotencyKey, requestSha256, metadata);
    return;
  }
  void mutationError;
  fail("WIKI_SETTLEMENT_UNCERTAIN", "Wiki owner edit binding did not settle", 503, true);
}

async function readExistingEdit(
  env: Env,
  context: AuthenticatedRequestContext,
  input: OwnerEditInput,
  idempotencyKey: string,
  requestSha256: string,
  bodySha256: string,
  row: ProposalRow,
): Promise<WikiProposalResult> {
  const checked = await validateEditProposalRow(row, context, input, requestSha256, bodySha256);
  const authorization = await prepareOwnerScopeReadAuthorization(env, context, checked.page.scope_snapshot_ref);
  await authorization.requireCurrent();
  const body = await readObject(env.WORK_BUCKET, checked.page.body_object_ref, MAX_BODY_BYTES);
  if (body.sha256 !== bodySha256 || body.bytes.byteLength !== row.body_size || !sameBytes(body.bytes, input.body_bytes)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit body differs from the request", 409);
  }
  const evidence = await readObject(env.WORK_BUCKET, checked.page.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
  if (evidence.sha256 !== row.evidence_map_sha256 || evidence.bytes.byteLength !== row.evidence_map_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit evidence map differs from its durable identity", 409);
  }
  await validateEditEvidence(evidence.bytes, checked.page, checked.metadata, body.bytes.byteLength);
  await authorization.requireCurrent();
  await settleBinding(env, context, row, checked.metadata, idempotencyKey, requestSha256);
  await authorization.requireCurrent();
  return {
    protocol: "eliotr.wiki-proposal.v1",
    proposal_ref: { id: row.proposal_id, revision: row.proposal_revision },
    page_ref: { ...checked.page.page_ref },
    risk_class: "D2_ANALYTICAL",
    state: "PROPOSED",
  };
}

export async function proposeWikiFromOwnerEdit(
  env: Env,
  context: AuthenticatedRequestContext,
  raw: unknown,
  idempotencyKey: string,
): Promise<WikiProposalResult> {
  requireOwner(context);
  const input = parseInput(raw);
  const idempotency = validIdempotency(idempotencyKey);
  const requestSha256 = await textDigest(canonicalEvidenceJson(editRequestObject(input)));
  const bodySha256 = await sha256(input.body_bytes);
  const existing = await loadProposalByIdempotency(env.CORE_DB, context.principal_ref, idempotency);
  if (existing !== null) {
    return readExistingEdit(env, context, input, idempotency, requestSha256, bodySha256, existing);
  }

  const base = await readCanonicalBase(env, context, input, idempotency);
  if (base.page.page_ref.revision >= Number.MAX_SAFE_INTEGER) {
    fail("WIKI_INPUT_INVALID", "base Wiki page revision cannot be incremented");
  }
  const pageRef = { id: base.page.page_ref.id, revision: base.page.page_ref.revision + 1 } as const;
  const pageKey = (await textDigest(base.page.page_ref.id)).slice(0, 32);
  const bodyKey = `wiki/owner-edit/${pageKey}/${pageRef.revision}/body/${bodySha256}.md`;
  const labels = { [expectedLabel(bodySha256)]: "UNRESOLVED" as const };
  const metadata: EditMetadata = {
    base_body_sha256: base.page.body_sha256,
    base_coverage_receipt_ref: { ...base.page.coverage_receipt_ref },
    base_dependency_refs_sha256: base.dependency_refs_sha256,
    base_evidence_map_ref: base.page.evidence_map_ref,
    base_evidence_map_sha256: base.evidence_map_sha256,
    base_page_ref: { ...base.page.page_ref },
    base_page_sha256: base.page_sha256,
    base_proposal_ref: { ...input.base_proposal_ref },
    edit_note: input.edit_note,
    edit_request_sha256: requestSha256,
    expected_head_revision: input.expected_head_revision,
    protocol: WIKI_OWNER_EDIT_PROTOCOL,
  };
  const evidencePayload = {
    edit_note: input.edit_note,
    edit_request_sha256: requestSha256,
    edited_body_object_ref: bodyKey,
    edited_body_sha256: bodySha256,
    edited_body_size: input.body_bytes.byteLength,
    edited_page_ref: pageRef,
    provenance: {
      base_body_object_ref: base.page.body_object_ref,
      base_body_sha256: base.page.body_sha256,
      base_coverage_receipt_ref: { ...base.page.coverage_receipt_ref },
      base_dependency_refs: [...base.page.dependency_refs].sort(),
      base_dependency_refs_sha256: base.dependency_refs_sha256,
      base_evidence_map_ref: base.page.evidence_map_ref,
      base_evidence_map_sha256: base.evidence_map_sha256,
      base_page_ref: { ...base.page.page_ref },
      base_page_sha256: base.page_sha256,
      base_proposal_ref: { ...input.base_proposal_ref },
      original_scope_snapshot_ref: { ...base.page.scope_snapshot_ref },
    },
    protocol: WIKI_OWNER_EDIT_EVIDENCE_PROTOCOL,
    statement_labels: labels,
  };
  const evidenceEncoded = canonicalEvidenceJson(evidencePayload);
  const evidenceBytes = new TextEncoder().encode(evidenceEncoded);
  if (evidenceBytes.byteLength > MAX_EVIDENCE_MAP_BYTES) {
    fail("WIKI_PUBLICATION_INCOMPLETE", "Wiki owner edit evidence map exceeds its byte bound", 422);
  }
  const evidenceSha256 = await sha256(evidenceBytes);
  const evidenceKey = `wiki/owner-edit/${pageKey}/${pageRef.revision}/evidence/${evidenceSha256}.json`;
  const page: WikiPageRevision = {
    page_ref: pageRef,
    page_type: base.page.page_type,
    title: input.title,
    scope_snapshot_ref: { ...base.page.scope_snapshot_ref },
    body_object_ref: bodyKey,
    body_sha256: bodySha256,
    statement_labels: labels,
    evidence_map_ref: evidenceKey,
    counterposition_refs: [],
    coverage_receipt_ref: { ...base.page.coverage_receipt_ref },
    limitations: [EDIT_LIMITATION, ...base.page.limitations.filter((limitation) => limitation !== EDIT_LIMITATION)],
    dependency_refs: [evidenceKey],
    generator_generation: WIKI_OWNER_EDIT_GENERATOR,
    status: "DRAFT",
    supersedes_ref: { ...base.page.page_ref },
    publication_metadata: { ...metadata },
    created_at: new Date().toISOString(),
  };
  await writeImmutableObject(env.WORK_BUCKET, bodyKey, input.body_bytes, bodySha256, MAX_BODY_BYTES, "text/markdown; charset=utf-8");
  await writeImmutableObject(env.WORK_BUCKET, evidenceKey, evidenceBytes, evidenceSha256, MAX_EVIDENCE_MAP_BYTES, "application/json");
  await base.authorization.requireCurrent();
  const currentHead = await base.port.readHead(base.page.page_ref.id);
  if (currentHead === null || !sameRef(currentHead.page_ref, base.head.page_ref) ||
      currentHead.manifest_ref !== base.head.manifest_ref || currentHead.outbox_ref !== base.head.outbox_ref) {
    fail("WIKI_HEAD_CONFLICT", "base Wiki head changed before owner edit proposal", 409);
  }
  let proposalRef: VersionedRef;
  try {
    proposalRef = await createWikiPublisher(base.port).propose(page, "D2_ANALYTICAL");
  } catch (cause) {
    if (!(cause instanceof WikiPublicationError) || cause.code !== "WIKI_PROPOSAL_READBACK_MISMATCH") throw cause;
    const concurrent = await loadProposalByIdempotency(env.CORE_DB, context.principal_ref, idempotency); if (concurrent === null) throw cause;
    return readExistingEdit(env, context, input, idempotency, requestSha256, bodySha256, concurrent);
  }
  const proposal = await loadProposalRow(env.CORE_DB, proposalRef, context.principal_ref);
  if (proposal === null) fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit proposal is missing after propose", 409);
  const checked = await validateEditProposalRow(proposal, context, input, requestSha256, bodySha256);
  const storedBody = await readObject(env.WORK_BUCKET, checked.page.body_object_ref, MAX_BODY_BYTES);
  if (storedBody.sha256 !== bodySha256 || storedBody.bytes.byteLength !== input.body_bytes.byteLength ||
      !sameBytes(storedBody.bytes, input.body_bytes)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit body failed exact readback", 409);
  }
  const storedEvidence = await readObject(env.WORK_BUCKET, checked.page.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
  if (storedEvidence.sha256 !== proposal.evidence_map_sha256 || storedEvidence.bytes.byteLength !== proposal.evidence_map_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit evidence failed exact readback", 409);
  }
  await validateEditEvidence(storedEvidence.bytes, checked.page, checked.metadata, storedBody.bytes.byteLength);
  await settleBinding(env, context, proposal, checked.metadata, idempotency, requestSha256);
  await base.authorization.requireCurrent();
  return {
    protocol: "eliotr.wiki-proposal.v1",
    proposal_ref: { id: proposal.proposal_id, revision: proposal.proposal_revision },
    page_ref: { ...checked.page.page_ref },
    risk_class: "D2_ANALYTICAL",
    state: "PROPOSED",
  };
}
