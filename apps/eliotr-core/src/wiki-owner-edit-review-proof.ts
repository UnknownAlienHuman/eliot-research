import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { VersionedRefSchema, WikiPageRevisionSchema, type VersionedRef, type WikiPageRevision } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import { prepareOwnerScopeReadAuthorization } from "./wiki-proposal-reauthorization.js";
import {
  MAX_BODY_BYTES,
  MAX_EVIDENCE_MAP_BYTES,
  MAX_MANIFEST_BYTES,
  decodeProposal,
  dependencyDigest,
  loadProposalRow,
  pageJson,
  readObject,
  textDigest,
  validRef,
  type ProposalRow,
} from "./wiki-publication-store-support.js";
import {
  loadEditBinding,
  parseInput,
  parseMetadata,
  sameProposalPage,
  validateEditEvidence,
  validateEditProposalRow,
  verifyBinding,
  type EditMetadata,
  type OwnerEditInput,
} from "./wiki-owner-edit-proposal.js";

const PROVENANCE_KEYS = [
  "base_body_object_ref",
  "base_body_sha256",
  "base_coverage_receipt_ref",
  "base_dependency_refs",
  "base_dependency_refs_sha256",
  "base_evidence_map_ref",
  "base_evidence_map_sha256",
  "base_page_ref",
  "base_page_sha256",
  "base_proposal_ref",
  "original_scope_snapshot_ref",
] as const;

const SHA256 = /^[a-f0-9]{64}$/u;

export interface OwnerEditReviewProof {
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly principal_ref: string;
  readonly base_proposal_ref: VersionedRef;
  readonly base_page_ref: VersionedRef;
  readonly base_page_sha256: string;
  readonly body_sha256: string;
  readonly coverage_receipt_ref: VersionedRef;
  readonly evidence_receipt_ref: string;
  readonly limitations: readonly string[];
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly dependency_refs: readonly string[];
  readonly requireCurrent: () => Promise<void>;
}

interface HistoricalRevisionRow {
  readonly proposal_id: string;
  readonly proposal_revision: number;
  readonly manifest_ref: string;
  readonly page_sha256: string;
  readonly page_json: string;
  readonly body_object_ref: string;
  readonly body_sha256: string;
}

function fail(code: string, message: string, status = 409, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", message);
  }
  return value as Record<string, unknown>;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function decodeJson(bytes: Uint8Array, message: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", message);
  }
}

function editRequestObject(input: OwnerEditInput): Record<string, unknown> {
  return {
    base_proposal_ref: { ...input.base_proposal_ref },
    body_text: input.body_text,
    edit_note: input.edit_note,
    expected_head_revision: input.expected_head_revision,
    title: input.title,
  };
}

function parseProvenance(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  const evidence = record(decodeJson(bytes, "Wiki owner edit evidence map is malformed"), "Wiki owner edit evidence map is malformed");
  return record(evidence.provenance, "Wiki owner edit provenance is malformed");
}

function sameDependencyRefs(left: readonly string[], right: readonly string[]): boolean {
  return canonicalEvidenceJson([...left].sort()) === canonicalEvidenceJson([...right].sort());
}

function historicalRow(value: HistoricalRevisionRow | null): HistoricalRevisionRow {
  if (value === null || typeof value !== "object" ||
      typeof value.proposal_id !== "string" || !Number.isSafeInteger(value.proposal_revision) ||
      typeof value.manifest_ref !== "string" || typeof value.page_sha256 !== "string" ||
      typeof value.page_json !== "string" || typeof value.body_object_ref !== "string" ||
      typeof value.body_sha256 !== "string") {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "canonical Wiki base revision is missing or malformed");
  }
  validRef(value.manifest_ref, "canonical Wiki manifest reference");
  if (!SHA256.test(value.page_sha256) || !SHA256.test(value.body_sha256)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "canonical Wiki base revision digest is malformed");
  }
  return value;
}

async function loadHistoricalRevision(database: D1Database, pageRef: VersionedRef): Promise<HistoricalRevisionRow> {
  let row: HistoricalRevisionRow | null;
  try {
    row = await database.prepare(
      "SELECT proposal_id, proposal_revision, manifest_ref, page_sha256, page_json, body_object_ref, body_sha256 " +
      "FROM wiki_publication_revision WHERE page_id=?1 AND revision=?2 LIMIT 1",
    ).bind(pageRef.id, pageRef.revision).first<HistoricalRevisionRow>();
  } catch (cause) {
    fail("WIKI_SETTLEMENT_UNCERTAIN", "canonical Wiki base revision read is unavailable", 503, true);
  }
  return historicalRow(row);
}

async function verifyHistoricalBase(
  env: Env,
  context: AuthenticatedRequestContext,
  metadata: EditMetadata,
  baseProposal: ProposalRow,
  baseDraft: WikiPageRevision,
): Promise<{ readonly page: WikiPageRevision; readonly row: HistoricalRevisionRow; readonly dependency_refs_sha256: string }> {
  if (baseProposal.state !== "PUBLISHED" || baseProposal.principal_ref !== context.principal_ref ||
      baseProposal.page_id !== metadata.base_page_ref.id || baseProposal.page_revision !== metadata.base_page_ref.revision ||
      baseDraft.status !== "DRAFT" || !sameRef(baseDraft.page_ref, metadata.base_page_ref) ||
      !sameRef(baseDraft.coverage_receipt_ref, metadata.base_coverage_receipt_ref) ||
      baseDraft.body_sha256 !== metadata.base_body_sha256 || baseDraft.evidence_map_ref !== metadata.base_evidence_map_ref) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base proposal is not canonical");
  }

  const revision = await loadHistoricalRevision(env.CORE_DB, metadata.base_page_ref);
  if (revision.proposal_id !== baseProposal.proposal_id || revision.proposal_revision !== baseProposal.proposal_revision ||
      revision.page_sha256 !== metadata.base_page_sha256 || revision.body_object_ref !== baseDraft.body_object_ref ||
      revision.body_sha256 !== metadata.base_body_sha256) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base revision lineage is inconsistent");
  }
  if (await textDigest(revision.page_json) !== revision.page_sha256) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base page digest is inconsistent");
  }

  const manifest = await readObject(env.WORK_BUCKET, revision.manifest_ref, MAX_MANIFEST_BYTES);
  if (manifest.sha256 !== revision.page_sha256 || new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes) !== revision.page_json) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base manifest failed exact readback");
  }
  const parsed = WikiPageRevisionSchema.safeParse(decodeJson(manifest.bytes, "historical Wiki base manifest is malformed"));
  if (!parsed.success || parsed.data.status !== "PUBLISHED" || !sameRef(parsed.data.page_ref, metadata.base_page_ref) ||
      !sameProposalPage(baseDraft, parsed.data) || pageJson(parsed.data) !== revision.page_json) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base manifest is not the published base");
  }

  const body = await readObject(env.WORK_BUCKET, parsed.data.body_object_ref, MAX_BODY_BYTES);
  if (body.sha256 !== metadata.base_body_sha256 || body.sha256 !== parsed.data.body_sha256 ||
      body.bytes.byteLength !== baseProposal.body_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base body failed exact readback");
  }
  const evidence = await readObject(env.WORK_BUCKET, parsed.data.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
  if (evidence.sha256 !== metadata.base_evidence_map_sha256 || evidence.sha256 !== baseProposal.evidence_map_sha256 ||
      evidence.bytes.byteLength !== baseProposal.evidence_map_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base evidence failed exact readback");
  }
  const dependencies = await dependencyDigest(parsed.data);
  if (dependencies !== metadata.base_dependency_refs_sha256 || dependencies !== baseProposal.dependency_refs_sha256 ||
      !sameDependencyRefs(baseDraft.dependency_refs, parsed.data.dependency_refs)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base dependency identity is inconsistent");
  }
  return { page: parsed.data, row: revision, dependency_refs_sha256: dependencies };
}

function verifyProvenance(
  provenance: Readonly<Record<string, unknown>>,
  metadata: EditMetadata,
  basePage: WikiPageRevision,
  baseRow: HistoricalRevisionRow,
  dependencyRefsSha256: string,
): void {
  if (!exactKeys(provenance, PROVENANCE_KEYS) ||
      provenance.base_body_object_ref !== basePage.body_object_ref ||
      provenance.base_body_sha256 !== basePage.body_sha256 ||
      provenance.base_coverage_receipt_ref === undefined ||
      provenance.base_evidence_map_ref !== basePage.evidence_map_ref ||
      provenance.base_evidence_map_sha256 !== metadata.base_evidence_map_sha256 ||
      provenance.base_page_sha256 !== baseRow.page_sha256 ||
      provenance.base_proposal_ref === undefined || provenance.base_page_ref === undefined ||
      provenance.original_scope_snapshot_ref === undefined ||
      provenance.base_dependency_refs_sha256 !== dependencyRefsSha256) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit provenance is not bound to the canonical base");
  }
  const baseProposal = VersionedRefSchema.safeParse(provenance.base_proposal_ref);
  const basePageRef = VersionedRefSchema.safeParse(provenance.base_page_ref);
  const coverageRef = VersionedRefSchema.safeParse(provenance.base_coverage_receipt_ref);
  const scopeRef = VersionedRefSchema.safeParse(provenance.original_scope_snapshot_ref);
  const dependencies = provenance.base_dependency_refs;
  if (!baseProposal.success || !sameRef(baseProposal.data, metadata.base_proposal_ref) ||
      !basePageRef.success || !sameRef(basePageRef.data, metadata.base_page_ref) ||
      !coverageRef.success || !sameRef(coverageRef.data, metadata.base_coverage_receipt_ref) ||
      !scopeRef.success || !sameRef(scopeRef.data, basePage.scope_snapshot_ref) ||
      !Array.isArray(dependencies) || dependencies.some((ref) => typeof ref !== "string") ||
      !sameDependencyRefs(dependencies as string[], basePage.dependency_refs) ||
      canonicalEvidenceJson(provenance) !== canonicalEvidenceJson({
        base_body_object_ref: basePage.body_object_ref,
        base_body_sha256: basePage.body_sha256,
        base_coverage_receipt_ref: { ...basePage.coverage_receipt_ref },
        base_dependency_refs: [...basePage.dependency_refs].sort(),
        base_dependency_refs_sha256: dependencyRefsSha256,
        base_evidence_map_ref: basePage.evidence_map_ref,
        base_evidence_map_sha256: metadata.base_evidence_map_sha256,
        base_page_ref: { ...basePage.page_ref },
        base_page_sha256: baseRow.page_sha256,
        base_proposal_ref: { ...metadata.base_proposal_ref },
        original_scope_snapshot_ref: { ...basePage.scope_snapshot_ref },
      })) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit provenance values are inconsistent");
  }
}

export async function readOwnerEditReviewProof(
  env: Env,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
): Promise<OwnerEditReviewProof> {
  if (context.client_class !== "owner_pwa") fail("WIKI_OWNER_REQUIRED", "Wiki owner edit review requires an owner session", 403);
  const ref = VersionedRefSchema.safeParse(proposalRef);
  if (!ref.success || ref.data.revision !== 1) fail("WIKI_INPUT_INVALID", "Wiki proposal reference is invalid");

  const row = await loadProposalRow(env.CORE_DB, ref.data, context.principal_ref);
  if (row === null) fail("WIKI_PROPOSAL_NOT_FOUND", "Wiki proposal does not exist", 404);
  const decoded = decodeProposal(row);
  const metadata = parseMetadata(decoded.page.publication_metadata);
  if (row.state !== "PROPOSED" && row.state !== "PUBLISHED") {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit proposal is not reviewable");
  }

  const authorization = await prepareOwnerScopeReadAuthorization(env, context, decoded.page.scope_snapshot_ref);
  await authorization.requireCurrent();
  const body = await readObject(env.WORK_BUCKET, decoded.page.body_object_ref, MAX_BODY_BYTES);
  if (body.sha256 !== decoded.page.body_sha256 || body.bytes.byteLength !== row.body_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit body failed exact readback");
  }
  let bodyText: string;
  try { bodyText = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes); }
  catch { fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit body is not valid UTF-8"); }
  const input = parseInput({
    base_proposal_ref: { ...metadata.base_proposal_ref },
    expected_head_revision: metadata.expected_head_revision,
    title: decoded.page.title,
    body_text: bodyText,
    edit_note: metadata.edit_note,
  });
  if (!sameBytes(input.body_bytes, body.bytes)) fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit body changed during readback");
  const requestSha256 = await textDigest(canonicalEvidenceJson(editRequestObject(input)));
  if (requestSha256 !== metadata.edit_request_sha256) fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit request identity is inconsistent");
  const checked = await validateEditProposalRow(row, context, input, requestSha256, body.sha256);

  const binding = await loadEditBinding(env.CORE_DB, ref.data);
  if (binding === null) fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit binding is missing");
  verifyBinding(binding, row, context, row.idempotency_key, requestSha256, checked.metadata);

  const evidence = await readObject(env.WORK_BUCKET, checked.page.evidence_map_ref, MAX_EVIDENCE_MAP_BYTES);
  if (evidence.sha256 !== row.evidence_map_sha256 || evidence.bytes.byteLength !== row.evidence_map_size) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "Wiki owner edit evidence failed exact readback");
  }
  await validateEditEvidence(evidence.bytes, checked.page, checked.metadata, body.bytes.byteLength);
  const provenance = parseProvenance(evidence.bytes);

  const baseRow = await loadProposalRow(env.CORE_DB, metadata.base_proposal_ref, context.principal_ref);
  if (baseRow === null) fail("WIKI_PROPOSAL_READBACK_MISMATCH", "historical Wiki base proposal is missing");
  const baseDraft = decodeProposal(baseRow).page;
  const historical = await verifyHistoricalBase(env, context, metadata, baseRow, baseDraft);
  verifyProvenance(provenance, metadata, historical.page, historical.row, historical.dependency_refs_sha256);

  await authorization.requireCurrent();
  return {
    proposal_ref: { ...ref.data },
    page_ref: { ...checked.page.page_ref },
    principal_ref: context.principal_ref,
    base_proposal_ref: { ...metadata.base_proposal_ref },
    base_page_ref: { ...metadata.base_page_ref },
    base_page_sha256: metadata.base_page_sha256,
    body_sha256: checked.page.body_sha256,
    coverage_receipt_ref: { ...checked.page.coverage_receipt_ref },
    evidence_receipt_ref: checked.page.evidence_map_ref,
    limitations: [...checked.page.limitations],
    provenance: { ...provenance },
    dependency_refs: [...checked.page.dependency_refs],
    requireCurrent: authorization.requireCurrent,
  };
}
