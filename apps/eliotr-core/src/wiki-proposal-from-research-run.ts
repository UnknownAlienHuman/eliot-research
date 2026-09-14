import {
  AllowedReferenceManifestSchema,
  VersionedRefSchema,
  type EvidenceLabel,
  type ArtifactRevision,
  type VersionedRef,
  type WikiPageRevision,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  createNavigationReadAuthority,
  loadScopeAuthority,
} from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import {
  createWikiPublisher,
  WikiPublicationError,
} from "@eliotr/research";
import {
  readHistoricalResearchCoverage,
} from "@eliotr/cloudflare-research-stages";
import { ArtifactReadNotFoundError, type AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { CatalogInputError } from "./catalog-service.js";
import {
  MAX_BODY_BYTES,
  MAX_EVIDENCE_MAP_BYTES,
  MAX_MANIFEST_BYTES,
  readObject,
  sha256,
  textDigest,
  validIdempotency,
  validRef,
} from "./wiki-publication-store-support.js";
import { createD1R2WikiPublicationPort } from "./wiki-publication-store.js";
import {
  reopenOwnerArtifactDraft,
  reopenOwnerArtifactSectionCitations,
} from "./research-artifact-reauthorization-http.js";
import type { WikiProposalResult } from "./wiki-service.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATOR = "wiki-from-research-run-v1";

interface DependencyObjectReceipt {
  readonly key: string;
  readonly expected_sha256: string;
  readonly readback_sha256: string;
  readonly size_bytes: number;
}

interface DependencyManifestRead {
  readonly object_ref: string;
  readonly physical_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly manifest: ReturnType<typeof AllowedReferenceManifestSchema.parse>;
}

interface SectionRead {
  readonly section_ref: VersionedRef;
  readonly body_object_ref: string;
  readonly body_sha256: string;
  readonly size_bytes: number;
  readonly text: string;
  readonly citations: Record<string, unknown>;
}

function fail(code: string, message: string, status = 409, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") {
    fail("WIKI_OWNER_REQUIRED", "Wiki proposals require an owner session", 403);
  }
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", `${label} is invalid`);
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function mapResearchFailure(error: unknown): never {
  if (error instanceof CatalogInputError) throw error;
  if (error instanceof ArtifactReadNotFoundError) {
    fail("WIKI_RESEARCH_RUN_NOT_FOUND", "completed research draft is unavailable", 404);
  }
  switch (errorCode(error)) {
    case "WORKFLOW_OUTPUT_CORRUPT":
    case "MATERIALIZE_OUTPUT_CORRUPT":
      fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "saved research output is inconsistent", 409);
    case "WORKFLOW_AUTHORITY_STALE":
    case "MATERIALIZE_OUTPUT_AUTHORITY_STALE":
    case "ARTIFACT_DRAFT_READ_STALE":
      fail("WIKI_POLICY_DENIED", "saved research authority is no longer current", 410);
    case "ARTIFACT_DRAFT_READ_INVALID":
    case "ARTIFACT_DRAFT_READ_INTEGRITY":
      fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "saved research output is inconsistent", 409);
    case "ARTIFACT_DRAFT_READ_DENIED":
      fail("WIKI_POLICY_DENIED", "saved research is not readable by this owner", 403);
    case "WORKFLOW_OUTPUT_UNAVAILABLE":
    case "MATERIALIZE_OUTPUT_UNCERTAIN":
    case "ARTIFACT_DRAFT_READ_UNAVAILABLE":
      fail("WIKI_SETTLEMENT_UNCERTAIN", "saved research output is temporarily unavailable", 503, true);
    default:
      fail("WIKI_SETTLEMENT_UNCERTAIN", "saved research readback is unavailable", 503, true);
  }
}

async function requireFreshOwnerScope(
  env: Pick<Env, "CORE_DB">,
  context: AuthenticatedRequestContext,
  operationId: string,
): Promise<void> {
  if (context.request.signal.aborted) fail("WIKI_RESEARCH_CANCELLED", "Wiki proposal was cancelled", 409);
  let row: { readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown } | null;
  try {
    row = await env.CORE_DB.prepare(
      "SELECT scope_snapshot_id, scope_snapshot_revision FROM research_workflow_run " +
      "WHERE operation_id=?1 AND principal_ref=?2 LIMIT 1",
    ).bind(operationId, context.principal_ref)
      .first<{ readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown }>();
  } catch (error) {
    throw error;
  }
  if (row === null) fail("WIKI_RESEARCH_RUN_NOT_FOUND", "research run is unavailable", 404);
  const scopeRef = VersionedRefSchema.safeParse({
    id: row.scope_snapshot_id,
    revision: row.scope_snapshot_revision,
  });
  if (!scopeRef.success) fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research scope binding is malformed", 409);
  const stored = await loadScopeAuthority(env.CORE_DB, scopeRef.data);
  if (stored === null || stored.invalidated_at !== null) {
    fail("WIKI_POLICY_DENIED", "research scope is no longer available", 410);
  }
  const access = {
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  } as const;
  const now = Date.now;
  const owner = createOwnerScopeAuthority(env.CORE_DB, access, now);
  await owner.requireReadPolicy();
  const scopes = createD1ScopeService(env.CORE_DB, owner, { now, max_snapshot_members: 64 });
  const fresh = await scopes.freeze(stored.snapshot.resolved_scope_expression, context.credential_generation);
  await scopes.requireCurrent(fresh);
  await owner.grant(fresh);
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB,
    scope_snapshot: fresh,
    access,
    require_current: (scope) => scopes.requireCurrent(scope),
    now,
  });
  await navigation.current();
}

function parseDependencyReceipt(raw: unknown): DependencyObjectReceipt {
  if (typeof raw !== "string") fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency object receipt is missing", 409);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency object receipt is malformed", 409); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency object receipt is malformed", 409);
  }
  const record = value as Record<string, unknown>;
  const expected = ["etag", "existed_identically", "expected_sha256", "key", "readback_sha256", "size_bytes"];
  const expectedKeys = [...expected].sort();
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
      typeof record.key !== "string" || typeof record.expected_sha256 !== "string" ||
      !SHA256.test(record.expected_sha256) || typeof record.readback_sha256 !== "string" ||
      !SHA256.test(record.readback_sha256) || typeof record.etag !== "string" ||
      typeof record.existed_identically !== "boolean" || !Number.isSafeInteger(record.size_bytes) ||
      (record.size_bytes as number) < 1 || (record.size_bytes as number) > MAX_MANIFEST_BYTES) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency object receipt is invalid", 409);
  }
  return {
    key: record.key,
    expected_sha256: record.expected_sha256 as string,
    readback_sha256: record.readback_sha256 as string,
    size_bytes: record.size_bytes as number,
  };
}

async function readDependencyManifest(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
  artifact: ArtifactRevision,
): Promise<DependencyManifestRead> {
  let row: { readonly object_ref: unknown; readonly object_kind: unknown; readonly section_ordinal: unknown; readonly receipt_json: unknown } | null;
  try {
    row = await env.CORE_DB.prepare(
      "SELECT object_ref, object_kind, section_ordinal, receipt_json FROM artifact_draft_object " +
      "WHERE artifact_id=?1 AND revision=?2 AND object_ref=?3 LIMIT 1",
    ).bind(artifact.artifact_ref.id, artifact.artifact_ref.revision, artifact.dependency_manifest_ref)
      .first<{ readonly object_ref: unknown; readonly object_kind: unknown; readonly section_ordinal: unknown; readonly receipt_json: unknown }>();
  } catch (error) { throw error; }
  if (row === null || row.object_ref !== artifact.dependency_manifest_ref ||
      row.object_kind !== "DEPENDENCY_MANIFEST" || row.section_ordinal !== null) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency manifest binding is missing", 409);
  }
  const receipt = parseDependencyReceipt(row.receipt_json);
  const observed = await readObject(env.WORK_BUCKET, receipt.key, MAX_MANIFEST_BYTES);
  if (receipt.expected_sha256 !== receipt.readback_sha256 || observed.sha256 !== receipt.expected_sha256 ||
      observed.bytes.byteLength !== receipt.size_bytes) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency manifest readback differs from its receipt", 409);
  }
  let decoded: unknown;
  let encoded: string;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes);
    decoded = JSON.parse(encoded);
  } catch {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency manifest bytes are malformed", 409);
  }
  const parsed = AllowedReferenceManifestSchema.safeParse(decoded);
  if (!parsed.success || canonicalEvidenceJson(parsed.data) !== encoded ||
      refKey(parsed.data.manifest_ref) !== artifact.dependency_manifest_ref) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency manifest contract is inconsistent", 409);
  }
  const { manifest_digest: manifestDigest, ...manifestPayload } = parsed.data;
  if (await textDigest(canonicalEvidenceJson(manifestPayload)) !== manifestDigest) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "dependency manifest digest is inconsistent", 409);
  }
  return {
    object_ref: artifact.dependency_manifest_ref,
    physical_key: receipt.key,
    sha256: observed.sha256,
    size_bytes: observed.bytes.byteLength,
    manifest: parsed.data,
  };
}

async function readSection(
  env: Env,
  context: AuthenticatedRequestContext,
  artifact: ArtifactRevision,
  expectedScope: VersionedRef,
  section: ArtifactRevision["sections"][number],
): Promise<SectionRead> {
  const reopened = await reopenOwnerArtifactDraft(env, context, artifact.artifact_ref, section.section_ref);
  if (!sameRef(reopened.original_scope_snapshot_ref, expectedScope) || !sameRef(reopened.artifact_ref, artifact.artifact_ref)) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research section readback is inconsistent", 409);
  }
  if (!("body" in reopened.artifact)) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research section readback is inconsistent", 409);
  }
  const body = reopened.artifact;
  if (!sameRef(body.section_ref, section.section_ref) || body.body_sha256 !== section.body_sha256 ||
      body.size_bytes !== body.body.byteLength) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research section readback is inconsistent", 409);
  }
  let sectionText: string;
  try { sectionText = new TextDecoder("utf-8", { fatal: true }).decode(body.body); }
  catch { fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research section encoding is invalid", 409); }
  if (await sha256(body.body) !== section.body_sha256) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research section digest is inconsistent", 409);
  }
  const citations = await reopenOwnerArtifactSectionCitations(env, context, artifact.artifact_ref, section.section_ref);
  if (!sameRef(citations.original_scope_snapshot_ref, expectedScope) || !sameRef(citations.artifact_ref, artifact.artifact_ref) ||
      !sameRef(citations.section_ref, section.section_ref) || citations.verification_receipt_ref !== section.verification_receipt_ref) {
    fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research section citations are inconsistent", 409);
  }
  const citationRecord: Record<string, unknown> = {
    // The reauthorization result contains fresh scope and handle refs for the
    // access check.  The Wiki evidence map must retain the saved identities so
    // a retry of the same run produces the same immutable object.
    original_scope_snapshot_ref: { ...citations.original_scope_snapshot_ref },
    verification_receipt_ref: citations.verification_receipt_ref,
    cited_evidence: citations.cited_evidence.map((item) => ({
      handle_ref: { ...item.original_handle_ref },
      excerpt_sha256: item.excerpt_sha256,
    })),
    semantic_verification: citations.semantic_verification,
    ...(citations.semantic_verification === "EXECUTED" ? { audit: citations.audit } : {}),
  };
  return {
    section_ref: { ...section.section_ref },
    body_object_ref: section.body_object_ref,
    body_sha256: section.body_sha256,
    size_bytes: body.body.byteLength,
    text: sectionText,
    citations: citationRecord,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function writeImmutableObject(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  digest: string,
  maximumBytes: number,
  contentType: string,
): Promise<void> {
  validRef(key, "Wiki object reference");
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes || await sha256(bytes) !== digest) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "generated Wiki object is outside its byte identity", 409);
  }
  try {
    await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
      httpMetadata: { contentType },
      customMetadata: { immutable: "true", sha256: digest, size_bytes: String(bytes.byteLength) },
    });
  } catch {
    // Exact readback below settles both a conditional collision and a lost put acknowledgement.
  }
  const observed = await readObject(bucket, key, maximumBytes);
  if (observed.sha256 !== digest || !bytesEqual(observed.bytes, bytes)) {
    fail("WIKI_PROPOSAL_READBACK_MISMATCH", "generated Wiki object failed exact readback", 409);
  }
}

function mapWikiFailure(error: unknown): never {
  if (!(error instanceof WikiPublicationError)) throw error;
  const status = error.code === "WIKI_POLICY_DENIED" ? 403
    : error.code === "WIKI_PROPOSAL_NOT_FOUND" ? 404
      : error.code === "WIKI_PUBLICATION_INCOMPLETE" ? 422
        : error.code === "WIKI_SETTLEMENT_UNCERTAIN" ? 503 : 409;
  fail(error.code, "Wiki proposal could not be stored", status, error.retryable || status === 503);
}

/** Create one stable PROPOSED Wiki page from a durably completed owner research run. */
export async function proposeWikiFromResearchRun(
  env: Env,
  context: AuthenticatedRequestContext,
  operationId: string,
  idempotencyKey: string,
): Promise<WikiProposalResult> {
  requireOwner(context);
  const operation = text(operationId, "operation_id");
  const idempotency = validIdempotency(idempotencyKey);
  let reopenedArtifact: ArtifactRevision | undefined;
  try {
    const historical = await readHistoricalResearchCoverage({
      database: env.CORE_DB,
      work_bucket: env.WORK_BUCKET,
      operation_id: operation,
      owner: { principal_ref: context.principal_ref, client_class: "owner_pwa" },
      require_current: () => requireFreshOwnerScope(env, context, operation),
      require_artifact: async ({ artifact_ref, original_scope_snapshot_ref }) => {
        const reopened = await reopenOwnerArtifactDraft(env, context, artifact_ref);
        if (!("artifact_ref" in reopened.artifact) || "body" in reopened.artifact) {
          fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research artifact readback is incomplete", 409);
        }
        const artifact = reopened.artifact;
        if (artifact.status !== "DRAFT" || !sameRef(artifact.artifact_ref, artifact_ref) ||
            !sameRef(reopened.original_scope_snapshot_ref, original_scope_snapshot_ref)) {
          fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research artifact identity is inconsistent", 409);
        }
        if (reopenedArtifact !== undefined && canonicalEvidenceJson(reopenedArtifact) !== canonicalEvidenceJson(artifact)) {
          fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research artifact changed during readback", 409);
        }
        reopenedArtifact = artifact;
        return {
          artifact_ref: artifact.artifact_ref,
          original_scope_snapshot_ref: reopened.original_scope_snapshot_ref,
          status: "DRAFT" as const,
          evidence_freeze_ref: artifact.evidence_freeze_ref,
          dependency_manifest_ref: artifact.dependency_manifest_ref,
        };
      },
    }).catch(mapResearchFailure);
    if (historical === null || reopenedArtifact === undefined) {
      fail("WIKI_RESEARCH_RUN_NOT_FOUND", "completed research draft is unavailable", 404);
    }
    const artifact = reopenedArtifact;
    if (artifact.status !== "DRAFT" || !sameRef(historical.artifact_ref, artifact.artifact_ref) ||
        !sameRef(historical.coverage_receipt.frozen_scope_snapshot_ref, historical.provenance.original_scope_snapshot_ref)) {
      fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research draft and coverage identity differ", 409);
    }
    const dependency = await readDependencyManifest(env, artifact);
    const expectedScope = historical.provenance.original_scope_snapshot_ref;
    const sections: SectionRead[] = [];
    const labels: Record<string, EvidenceLabel> = {};
    for (const section of artifact.sections) {
      const sectionRead = await readSection(env, context, artifact, expectedScope, section);
      sections.push(sectionRead);
      for (const [claimRef, label] of Object.entries(section.statement_labels)) {
        const pageClaimRef = `${section.section_ref.id}:${section.section_ref.revision}:${claimRef}`;
        if (Object.hasOwn(labels, pageClaimRef)) fail("WIKI_RESEARCH_OUTPUT_CORRUPT", "research claim labels are duplicated", 409);
        labels[pageClaimRef] = label;
      }
    }
    if (Object.keys(labels).length === 0) fail("WIKI_PUBLICATION_INCOMPLETE", "research draft has no statement labels", 422);
    if (Object.values(labels).some((label) => label === "CONTESTED" || label === "REDACTED_DEPENDENCY")) {
      fail("WIKI_PUBLICATION_INCOMPLETE", "research draft requires an explicit counterposition or dependency review", 422);
    }
    const bodyBytes = new TextEncoder().encode(sections.map((section) => section.text).join("\n\n"));
    if (bodyBytes.byteLength < 1 || bodyBytes.byteLength > MAX_BODY_BYTES) {
      fail("WIKI_PUBLICATION_INCOMPLETE", "research draft body exceeds the Wiki bound", 422);
    }
    const bodyDigest = await sha256(bodyBytes);
    const evidencePayload = {
      protocol: "eliotr.wiki-evidence-map.v1",
      operation_id: operation,
      artifact_ref: artifact.artifact_ref,
      artifact,
      coverage_receipt_ref: historical.coverage_receipt_ref,
      coverage_receipt: historical.coverage_receipt,
      provenance: historical.provenance,
      dependency_manifest: dependency,
      sections: sections.map(({ text: _text, ...section }) => section),
    };
    const evidenceEncoded = canonicalEvidenceJson(evidencePayload);
    const evidenceBytes = new TextEncoder().encode(evidenceEncoded);
    if (evidenceBytes.byteLength < 1 || evidenceBytes.byteLength > MAX_EVIDENCE_MAP_BYTES) {
      fail("WIKI_PUBLICATION_INCOMPLETE", "research evidence map exceeds the Wiki bound", 422);
    }
    const evidenceDigest = await sha256(evidenceBytes);
    const pageId = `research-wiki-${(await textDigest(`${operation}|${refKey(artifact.artifact_ref)}`)).slice(0, 48)}`;
    const bodyKey = `wiki/research/${pageId}/body/${bodyDigest}.md`;
    const evidenceKey = `wiki/research/${pageId}/evidence/${evidenceDigest}.json`;
    await writeImmutableObject(env.WORK_BUCKET, bodyKey, bodyBytes, bodyDigest, MAX_BODY_BYTES, "text/markdown; charset=utf-8");
    await writeImmutableObject(env.WORK_BUCKET, evidenceKey, evidenceBytes, evidenceDigest, MAX_EVIDENCE_MAP_BYTES, "application/json");
    await requireFreshOwnerScope(env, context, operation);
    const dependencies = new Set<string>([
      dependency.object_ref,
      dependency.physical_key,
      refKey(historical.coverage_receipt_ref),
      refKey(artifact.evidence_freeze_ref),
      historical.provenance.coverage_stage_attempt_ref,
      historical.provenance.coverage_stage_request_sha256,
      historical.provenance.coverage_output_sha256,
      historical.provenance.materialize_stage_attempt_ref,
      historical.provenance.materialize_stage_request_sha256,
      historical.provenance.materialize_output_sha256,
      ...artifact.sections.flatMap((section) => [section.body_object_ref, section.evidence_ledger_ref, section.verification_receipt_ref]),
    ]);
    const page: WikiPageRevision = {
      page_ref: { id: pageId, revision: 1 },
      page_type: "Report",
      title: `Research draft · ${artifact.created_at.slice(0, 10)}`,
      scope_snapshot_ref: { ...historical.coverage_receipt.frozen_scope_snapshot_ref },
      body_object_ref: bodyKey,
      body_sha256: bodyDigest,
      statement_labels: labels,
      evidence_map_ref: evidenceKey,
      counterposition_refs: [],
      coverage_receipt_ref: { ...historical.coverage_receipt_ref },
      limitations: ["This analytical research draft remains PROPOSED pending human review."],
      dependency_refs: [...dependencies].sort(),
      generator_generation: GENERATOR,
      status: "DRAFT",
      publication_metadata: {
        protocol: "eliotr.wiki-proposal-from-research-run.v1",
        operation_id: operation,
        artifact_ref: refKey(artifact.artifact_ref),
        coverage_receipt_ref: refKey(historical.coverage_receipt_ref),
        materialize_output_sha256: historical.provenance.materialize_output_sha256,
      },
      created_at: artifact.created_at,
    };
    const port = createD1R2WikiPublicationPort(env.CORE_DB, env.WORK_BUCKET, {
      principal_ref: context.principal_ref,
      idempotency_key: idempotency,
      now: () => artifact.created_at,
    });
    const proposalRef = await createWikiPublisher(port).propose(page, "D2_ANALYTICAL");
    return {
      protocol: "eliotr.wiki-proposal.v1",
      proposal_ref: proposalRef,
      page_ref: { ...page.page_ref },
      risk_class: "D2_ANALYTICAL",
      state: "PROPOSED",
    };
  } catch (error) {
    if (error instanceof CatalogInputError) throw error;
    if (error instanceof WikiPublicationError) return mapWikiFailure(error);
    return mapResearchFailure(error);
  }
}
