import {
  AllowedReferenceManifestSchema,
  ArtifactRevisionSchema,
  ArtifactSectionRevisionSchema,
  ArtifactSpecSchema,
  CoverageReceiptSchema,
  EvidenceFreezeSchema,
  ObjectResidencyKeySchema,
  OperationIntentSchema,
  ResolvedEvidenceSchema,
  VersionedRefSchema,
  type AllowedReferenceManifest,
  type ArtifactRevision,
  type ArtifactSectionRevision,
  type ArtifactSpec,
  type CoverageReceipt,
  type EvidenceFreeze,
  type ObjectResidencyKey,
  type OperationIntent,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import type { CloudflareEvidenceResolver, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import { decodeModelGatewayBody } from "@eliotr/cloudflare-ai";
import { encodeArtifactDraftVerification } from "@eliotr/cloudflare-artifacts";
import { decodeSynthesisSectionCandidateV1, SynthesisClaimsCandidateError, type SynthesisSectionCandidateV1 } from "@eliotr/research";
import { validateCoverageReceipt as validateDomainCoverageReceipt } from "@eliotr/domain";
import {
  createArtifactDraftStore,
  type ArtifactDraftReferencedObjectInput,
  type ArtifactDraftAdmissionPort,
  type PrepareArtifactDraftResult,
} from "./artifact-draft.js";
import type { ResearchEvidencePack } from "./research-reference-manifest.js";
import type { ResearchSynthesisOutputReadback } from "./research-synthesis-output-reader.js";

export interface ResearchArtifactDraftMaterializationInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_id: string;
  readonly intent: OperationIntent;
  readonly expected_draft_head_revision: number | null;
  readonly artifact_ref: VersionedRef;
  readonly spec: ArtifactSpec;
  readonly evidence_freeze: EvidenceFreeze;
  readonly reference_manifest: AllowedReferenceManifest;
  readonly evidence_pack: ResearchEvidencePack;
  /** Existing current-scope authority and resolver; both perform real D1/R2 readback. */
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  readonly synthesis_readback: ResearchSynthesisOutputReadback;
  /** Server-selected section identity and labels; body and verification identity are derived below. */
  readonly section: ArtifactSectionMaterializationTemplate;
  readonly section_residency: ObjectResidencyTemplate;
  readonly referenced_objects: readonly ArtifactDraftReferencedObjectInput[];
  readonly manifest_residency: ObjectResidencyTemplate;
  /** Optional server-owned Stage16 coverage accounting; never accepted from a report client. */
  readonly coverage_receipt?: CoverageReceipt;
  /** Optional server-only REPORT admission appended to the draft store's final batch. */
  readonly admission?: ArtifactDraftAdmissionPort;
  readonly created_at: string;
  readonly now?: () => number;
}

export type ArtifactSectionMaterializationTemplate = Omit<ArtifactSectionRevision, "body_sha256" | "verification_receipt_ref">;
export type ObjectResidencyTemplate = Omit<ObjectResidencyKey, "content_digest">;

export type ResearchArtifactDraftErrorCode =
  | "RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID"
  | "RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE"
  | "RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID";

export class ResearchArtifactDraftError extends Error {
  public readonly code: ResearchArtifactDraftErrorCode;

  public constructor(code: ResearchArtifactDraftErrorCode, message: string) {
    super(message);
    this.name = "ResearchArtifactDraftError";
    this.code = code;
  }
}

function fail(code: ResearchArtifactDraftErrorCode, message: string): never {
  throw new ResearchArtifactDraftError(code, message);
}

export type SynthesisSectionCandidate = SynthesisSectionCandidateV1;
export function decodeSynthesisSectionCandidate(content: string): SynthesisSectionCandidate {
  try { return decodeSynthesisSectionCandidateV1(content); }
  catch (cause) {
    if (cause instanceof SynthesisClaimsCandidateError) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", cause.message);
    throw cause;
  }
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function snapshotCoverageReceipt(value: CoverageReceipt | undefined): CoverageReceipt | undefined {
  if (value === undefined) return undefined;
  const parsed = CoverageReceiptSchema.safeParse(value);
  if (!parsed.success) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "coverage receipt is malformed");
  if (!validateDomainCoverageReceipt(parsed.data).ok) {
    fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "coverage receipt violates coverage rules");
  }
  try {
    return deepFreeze(JSON.parse(canonicalEvidenceJson(parsed.data)) as CoverageReceipt);
  } catch {
    fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "coverage receipt is not canonicalizable");
  }
}

function coverageList(values: readonly string[]): string {
  return values.length === 0 ? "none recorded" : values.join(", ");
}

function coverageCount(values: readonly string[]): string {
  return `${values.length} (${coverageList(values)})`;
}

function describeDenominator(kind: CoverageReceipt["denominator_kind"]): string {
  switch (kind) {
    case "complete_scope": return "a complete frozen scope was used as the denominator";
    case "sampled_with_method": return "a sampled scope with a declared method was used";
    case "unknown": return "the available coverage completeness is unknown";
  }
}

function describeDisposition(disposition: CoverageReceipt["terminal_disposition"]): string {
  switch (disposition) {
    case "ANSWERED_WITH_SUPPORTED_RESULT": return "a supported result was recorded";
    case "NO_MATCH_IN_COMPLETE_SCOPE": return "no match was found in the recorded complete scope";
    case "NO_NEW_USEFUL_EVIDENCE": return "no new useful evidence was recorded";
    case "SOURCE_UNAVAILABLE": return "a source needed for the request was unavailable";
    case "STALE_SOURCE_OR_INDEX": return "a source or index became stale";
    case "POLICY_OR_DISCLOSURE_DENIED": return "policy or disclosure rules prevented the result";
    case "INCOMPLETE_COVERAGE": return "coverage remained incomplete";
    case "INCONCLUSIVE": return "the recorded evidence was inconclusive";
    case "CANCELLED": return "the coverage run was cancelled";
  }
}

function describeCounterSearch(status: CoverageReceipt["counter_search_status"]): string {
  switch (status) {
    case "NOT_REQUIRED": return "not required";
    case "NOT_RUN": return "not run";
    case "PARTIAL": return "partially completed";
    case "COMPLETE": return "completed for the recorded method";
  }
}

function describeOmissionReason(reason: string): string {
  return reason === "NOT_REPRESENTED_IN_EVIDENCE_PACK"
    ? "this source was not represented in the evidence pack"
    : `recorded reason ${reason}`;
}

function describeUnknownReason(reason: string | undefined): string {
  if (reason === undefined) return "none recorded";
  return reason === "EXPLORATORY_MEMBERSHIP_OBSERVATION_DOES_NOT_PROVE_COMPLETE_SCOPE"
    ? "the exploratory membership observation does not prove complete scope"
    : reason;
}

function coverageMethodologyBlock(receipt: CoverageReceipt): string {
  const omitted = receipt.omitted_sources.length === 0
    ? "none recorded"
    : receipt.omitted_sources.map((item) => `${item.source_ref} (${describeOmissionReason(item.reason)})`).join(", ");
  const missing = [
    ...receipt.stale_or_skipped_lanes.map((value) => `lane ${value}`),
    ...receipt.failed_acquisition_refs.map((value) => `acquisition ${value}`),
    ...receipt.provider_degradation_refs.map((value) => `provider ${value}`),
    ...receipt.parser_degradation_refs.map((value) => `parser ${value}`),
    ...receipt.redacted_dependency_refs.map((value) => `redacted dependency ${value}`),
    ...receipt.budget_limitations.map((value) => `budget: ${value}`),
  ];
  return [
    "## Coverage and method",
    "This report is a DRAFT. The coverage receipt records the inspected scope and limits; it does not establish completion.",
    `Coverage basis: ${describeDenominator(receipt.denominator_kind)}.`,
    `Represented sources: ${coverageCount(receipt.represented_source_refs)}.`,
    `Cited sources: ${coverageCount(receipt.cited_source_refs)}.`,
    `Omitted sources: ${receipt.omitted_sources.length} (${omitted}).`,
    `Recorded limits or gaps: ${missing.length === 0 ? "none recorded" : `${missing.length} (${missing.join(", ")})`}.`,
    `Counter-search: ${describeCounterSearch(receipt.counter_search_status)}.`,
    `Recorded outcome: ${describeDisposition(receipt.terminal_disposition)}.`,
    `Why coverage may be unknown: ${describeUnknownReason(receipt.unknown_coverage_reason)}.`,
  ].join("\n");
}

function parseEvidencePack(pack: ResearchEvidencePack, expectedScope: VersionedRef, cited: readonly VersionedRef[]): void {
  if (!VersionedRefSchema.safeParse(pack.pack_ref).success || !VersionedRefSchema.safeParse(pack.scope_snapshot_ref).success ||
      !VersionedRefSchema.safeParse(pack.trace_ref).success || !sameRef(pack.scope_snapshot_ref, expectedScope) ||
      !Array.isArray(pack.resolved_evidence) || !Array.isArray(pack.omitted_candidates) || !Number.isSafeInteger(pack.total_utf8_bytes) || pack.total_utf8_bytes < 0) {
    fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack is malformed or bound to another scope");
  }
  const present = new Set<string>();
  for (const item of pack.resolved_evidence) {
    const parsed = ResolvedEvidenceSchema.safeParse(item);
    if (!parsed.success || parsed.data.handle.terminal_state !== "LIVE") fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack contains non-live evidence");
    const key = refKey(parsed.data.handle.handle_ref);
    if (present.has(key)) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "EvidencePack repeats an evidence handle");
    present.add(key);
  }
  for (const ref of cited) if (!present.has(refKey(ref))) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "cited handle is absent from EvidencePack");
}

async function derivedVerificationObject(input: {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly output_sha256: string;
  readonly freeze: EvidenceFreeze;
  readonly freeze_sha256: string;
  readonly manifest: AllowedReferenceManifest;
  readonly evidence_pack: ResearchEvidencePack;
  readonly cited: readonly ResearchEvidencePack["resolved_evidence"][number][];
  readonly section_sha256: string;
  readonly residency_template: ObjectResidencyTemplate;
}): Promise<{ readonly section_verification_ref: string; readonly object: ArtifactDraftReferencedObjectInput }> {
  const verification = await encodeArtifactDraftVerification({
    schema: "eliotr.research.draft-verification.v1",
    semantic_verification: "NOT_EXECUTED",
    source_readback: "AUTHORITATIVE_RESOLVED",
    operation_id: input.operation_id,
    investigation_ref: input.investigation_ref,
    output_sha256: input.output_sha256,
    freeze_ref: input.freeze.freeze_ref,
    freeze_sha256: input.freeze_sha256,
    manifest_ref: input.manifest.manifest_ref,
    manifest_sha256: input.manifest.manifest_digest,
    evidence_pack_ref: input.evidence_pack.pack_ref,
    trace_ref: input.evidence_pack.trace_ref,
    cited_evidence: input.cited.map((evidence) => ({
      handle_ref: evidence.handle.handle_ref,
      excerpt_sha256: evidence.handle.excerpt_sha256,
      source_revision_content_sha256: evidence.source_revision_content_sha256,
      scope_snapshot_digest: evidence.scope_snapshot_digest,
      authorization_receipt_ref: evidence.authorization_receipt_ref,
      credential_generation: evidence.credential_generation,
    })),
    section_sha256: input.section_sha256,
  });
  const { bytes, sha256: digest, verification_receipt_ref: ref } = verification;
  const residency: ObjectResidencyKey = {
    ...input.residency_template,
    content_digest: { algorithm: "sha256", digest },
  };
  return {
    section_verification_ref: ref,
    object: { object_ref: ref, object_kind: "VERIFICATION_RECEIPT", bytes, residency },
  };
}

function requiredObject(objects: readonly ArtifactDraftReferencedObjectInput[], objectRef: string, kind: ArtifactDraftReferencedObjectInput["object_kind"]): ArtifactDraftReferencedObjectInput {
  const matches = objects.filter((object) => object.object_ref === objectRef && object.object_kind === kind);
  if (matches.length !== 1) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", `missing unique ${kind} object`);
  return matches[0] as ArtifactDraftReferencedObjectInput;
}

function evidenceIdentity(evidence: ResearchEvidencePack["resolved_evidence"][number]): Record<string, unknown> {
  return {
    handle: evidence.handle,
    exact_excerpt: evidence.exact_excerpt,
    source_revision_content_sha256: evidence.source_revision_content_sha256,
    scope_snapshot_digest: evidence.scope_snapshot_digest,
    instruction_taint: evidence.instruction_taint,
    allowed_effects: evidence.allowed_effects,
  };
}

export function sameEvidence(left: ResearchEvidencePack["resolved_evidence"][number], right: ResearchEvidencePack["resolved_evidence"][number]): boolean {
  return canonicalEvidenceJson(evidenceIdentity(left)) === canonicalEvidenceJson(evidenceIdentity(right));
}

function requireCurrentEvidenceAuthority(
  evidence: ResearchEvidencePack["resolved_evidence"][number],
  scope: VersionedRef,
  access: NavigationReadAuthority["access"],
  grant: Awaited<ReturnType<NavigationReadAuthority["current"]>>,
): void {
  if (!sameRef(evidence.handle.scope_snapshot_ref, scope) ||
      evidence.authorization_receipt_ref !== grant.authorization_receipt_ref ||
      evidence.credential_generation !== access.credential_generation) {
    fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "evidence authority does not match the current owner grant");
  }
}

/** Converts one committed SYNTHESIZE output into one DRAFT section. */
export async function materializeResearchArtifactDraft(input: ResearchArtifactDraftMaterializationInput): Promise<PrepareArtifactDraftResult> {
  /* Snapshot the optional server-owned receipt before any awaited readback. */
  const coverageReceipt = snapshotCoverageReceipt(input.coverage_receipt);
  const readback = input.synthesis_readback;
  if (typeof input.operation_id !== "string" || input.operation_id.length < 1 || readback.operation_id !== input.operation_id || readback.stage !== "SYNTHESIZE" ||
      readback.workflow_receipt.operation_id !== input.operation_id || readback.workflow_receipt.stage !== "SYNTHESIZE" ||
      readback.output.output_object_ref.length < 1 || !/^[a-f0-9]{64}$/u.test(readback.output.output_sha256)) {
    fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "SYNTHESIZE readback is not bound to the selected operation");
  }
  if (readback.output.readback_sha256 !== readback.output.output_sha256 || !Number.isSafeInteger(readback.output.output_size_bytes) ||
      readback.output.output_size_bytes < 1 || readback.bytes.byteLength !== readback.output.output_size_bytes ||
      await evidenceSha256Bytes(readback.bytes) !== readback.output.output_sha256) {
    fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "SYNTHESIZE bytes differ from durable output digest");
  }
  let assistantContent: string;
  try {
    assistantContent = (await decodeModelGatewayBody(readback.bytes)).assistant_content;
  } catch (cause) {
    fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", `SYNTHESIZE gateway output is invalid: ${cause instanceof Error ? cause.message : "decode failed"}`);
  }
  const candidate = decodeSynthesisSectionCandidate(assistantContent);
  try {
    OperationIntentSchema.parse(input.intent);
    ArtifactSpecSchema.parse(input.spec);
    EvidenceFreezeSchema.parse(input.evidence_freeze);
    AllowedReferenceManifestSchema.parse(input.reference_manifest);
    ArtifactSectionRevisionSchema.omit({ body_sha256: true, verification_receipt_ref: true }).parse(input.section);
    ObjectResidencyKeySchema.omit({ content_digest: true }).parse(input.section_residency);
    ObjectResidencyKeySchema.omit({ content_digest: true }).parse(input.manifest_residency);
    VersionedRefSchema.parse(input.artifact_ref);
  } catch {
    fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "materialization input failed its versioned contracts");
  }
  const now = input.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now)) fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "materialization clock is invalid");
  const scope = input.spec.scope_snapshot_ref;
  if (coverageReceipt !== undefined &&
      (!sameRef(coverageReceipt.frozen_scope_snapshot_ref, input.evidence_freeze.scope_snapshot_ref) ||
       !sameRef(coverageReceipt.coverage_denominator_ref, input.evidence_freeze.coverage_denominator_ref))) {
    fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "coverage receipt is not bound to the evidence freeze");
  }
  const navigationScope = { id: input.navigation.scope.snapshot_id, revision: input.navigation.scope.revision };
  if (!sameRef(scope, input.evidence_freeze.scope_snapshot_ref) || !sameRef(scope, input.reference_manifest.scope_snapshot_ref) || !sameRef(scope, input.evidence_pack.scope_snapshot_ref) ||
      !sameRef(scope, navigationScope) || readback.workflow_receipt.investigation_ref.id !== readback.investigation_ref.id || readback.model_attempt.authority.principal_ref !== input.intent.principal_ref ||
      !sameRef(readback.model_attempt.authority.scope_snapshot_ref, scope) || readback.model_attempt.output?.output_object_ref !== readback.output.output_object_ref ||
      readback.model_attempt.output?.output_sha256 !== readback.output.output_sha256) {
    fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "SYNTHESIZE lineage is not bound to the selected authority");
  }
  if (Date.parse(input.reference_manifest.expires_at) <= now) fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "reference manifest is expired");
  const { manifest_digest: manifestDigest, ...manifestPayload } = input.reference_manifest;
  if (await evidenceSha256(manifestPayload) !== manifestDigest) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "reference manifest digest is invalid");
  const citedKeys = new Set<string>();
  for (const ref of candidate.cited_handle_refs) {
    const key = refKey(ref);
    if (citedKeys.has(key) || !input.reference_manifest.allowed_evidence_handle_refs.some((allowed) => sameRef(allowed, ref)) ||
        !input.evidence_freeze.included_evidence.some((included) => sameRef(included.handle_ref, ref))) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "SYNTHESIZE cites an unverified handle");
    citedKeys.add(key);
  }
  parseEvidencePack(input.evidence_pack, scope, candidate.cited_handle_refs);
  if (Object.values(input.section.statement_labels).some((label) => label !== "UNRESOLVED")) {
    fail("RESEARCH_ARTIFACT_DRAFT_INPUT_INVALID", "DRAFT section labels require semantic verification before promotion");
  }
  if (input.navigation.access.principal_ref !== input.intent.principal_ref || input.navigation.access.client_class !== "owner_pwa") {
    fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "draft authority is not owner-bound");
  }
  let initialGrant;
  try { initialGrant = await input.navigation.current(input.navigation.scope); }
  catch { fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "current scope authority is unavailable"); }
  if (!initialGrant.allowed_use.includes("research")) fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "current scope does not permit research");
  const authoritativeEvidence: Array<ResearchEvidencePack["resolved_evidence"][number]> = [];
  for (const ref of candidate.cited_handle_refs) {
    const expected = input.evidence_pack.resolved_evidence.find((item) => sameRef(item.handle.handle_ref, ref));
    if (expected === undefined) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "cited evidence readback is missing");
    const included = input.evidence_freeze.included_evidence.find((item) => sameRef(item.handle_ref, ref));
    if (included === undefined || included.digest !== expected.handle.excerpt_sha256) {
      fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "freeze evidence digest differs from persisted EvidencePack");
    }
    requireCurrentEvidenceAuthority(expected, scope, input.navigation.access, initialGrant);
    let actual;
    try {
      actual = await input.evidence_resolver.resolveHandle({ handle_ref: ref, expected_scope_snapshot_ref: scope, access: input.navigation.access });
    } catch { fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "cited evidence is no longer currently resolvable"); }
    requireCurrentEvidenceAuthority(actual, scope, input.navigation.access, initialGrant);
    if (included.digest !== actual.handle.excerpt_sha256) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "freeze evidence digest differs from current evidence readback");
    if (!sameEvidence(expected, actual)) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "cited evidence differs from current authoritative readback");
    authoritativeEvidence.push(actual);
  }
  let finalGrant;
  try { finalGrant = await input.navigation.current(input.navigation.scope); }
  catch { fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "current scope authority changed during evidence readback"); }
  if (canonicalEvidenceJson(initialGrant) !== canonicalEvidenceJson(finalGrant)) fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "scope authority changed during evidence readback");
  const sectionText = coverageReceipt === undefined
    ? candidate.section_text
    : `${candidate.section_text}\n\n${coverageMethodologyBlock(coverageReceipt)}`;
  const sectionBytes = new TextEncoder().encode(sectionText);
  for (const evidence of input.evidence_pack.resolved_evidence) {
    if (candidate.cited_handle_refs.some((ref) => sameRef(ref, evidence.handle.handle_ref)) && evidence.handle.expires_at !== undefined && Date.parse(evidence.handle.expires_at) <= now) fail("RESEARCH_ARTIFACT_DRAFT_AUTHORITY_STALE", "cited evidence handle is expired");
  }
  const dependencyRef = refKey(input.reference_manifest.manifest_ref);
  const dependency = requiredObject(input.referenced_objects, dependencyRef, "DEPENDENCY_MANIFEST");
  const ledger = requiredObject(input.referenced_objects, input.section.evidence_ledger_ref, "EVIDENCE_LEDGER");
  let dependencyText: string;
  try { dependencyText = new TextDecoder("utf-8", { fatal: true }).decode(dependency.bytes); }
  catch { fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "dependency manifest encoding is invalid"); }
  if (dependencyText !== canonicalEvidenceJson(input.reference_manifest)) fail("RESEARCH_ARTIFACT_DRAFT_EVIDENCE_INVALID", "dependency manifest bytes differ from the verified manifest");
  const sectionSha256 = await evidenceSha256Bytes(sectionBytes);
  const verification = await derivedVerificationObject({
    operation_id: input.operation_id,
    investigation_ref: readback.investigation_ref,
    output_sha256: readback.output.output_sha256,
    freeze: input.evidence_freeze,
    freeze_sha256: await canonicalDigest(input.evidence_freeze),
    manifest: input.reference_manifest,
    evidence_pack: input.evidence_pack,
    cited: authoritativeEvidence,
    section_sha256: sectionSha256,
    residency_template: input.section_residency,
  });
  const draftSection: ArtifactSectionRevision = {
    ...input.section,
    body_sha256: sectionSha256,
    verification_receipt_ref: verification.section_verification_ref,
  };
  const revision: ArtifactRevision = ArtifactRevisionSchema.parse({
    artifact_ref: input.artifact_ref, spec_ref: input.spec.spec_ref, spec_digest: await canonicalDigest(input.spec),
    evidence_freeze_ref: input.evidence_freeze.freeze_ref, sections: [draftSection], dependency_manifest_ref: dependencyRef,
    deterministic_export_refs: {}, status: "DRAFT", created_at: input.created_at,
  });
  const manifestSha256 = await canonicalDigest({ spec: input.spec, revision });
  const manifestResidency: ObjectResidencyKey = {
    ...input.manifest_residency,
    content_digest: { algorithm: "sha256", digest: manifestSha256 },
  };
  return createArtifactDraftStore(input.database, input.work_bucket, input.admission).prepare({
    intent: input.intent, expected_draft_head_revision: input.expected_draft_head_revision, spec: input.spec, revision,
    sections: [{ section: draftSection, bytes: sectionBytes, residency: { ...input.section_residency, content_digest: { algorithm: "sha256", digest: sectionSha256 } } }],
    referenced_objects: [dependency, ledger, verification.object], manifest_residency: manifestResidency,
  });
}
