import {
  AllowedReferenceManifestSchema,
  ArtifactSectionRevisionSchema,
  ObjectResidencyKeySchema,
  type AllowedReferenceManifest,
  type EvidenceLabel,
  type ObjectResidencyKey,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { canonicalDigest, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  decodeArtifactDraftVerificationV2,
  encodeArtifactDraftVerificationV2,
  type ArtifactCowCompilation,
  type ArtifactCowEvidencePack,
  type ArtifactCowParent,
  type ArtifactCowSectionObject,
  type ArtifactDraftReferencedObjectInput,
  type ArtifactDraftSemanticAudit,
} from "@eliotr/cloudflare-artifacts";
import type { ArtifactSectionContract } from "@eliotr/contracts";
import { decodeModelGatewayBody } from "@eliotr/cloudflare-ai";
import {
  decodeSemanticVerifierBatch,
  decodeSynthesisClaimsCandidateAny,
  normalizeSynthesisClaimsCandidateAny,
  translateSemanticVerifierBatch,
  type NormalizedSynthesisClaims,
  type TrustedSemanticClaimAuditInput,
} from "@eliotr/research";
import type { WorkflowPrincipal, ArtifactSectionReviseAttempt } from "@eliotr/cloudflare-workflows";
import type { ResidencyDomainProfile } from "./research-model-output-store.js";
import type { ModelAttemptAuthority } from "./model-attempt-types.js";
import type { ArtifactCowModelCallContext, ArtifactCowModelOutput } from "./artifact-cow-model-executor.js";

const MAX_MODEL_INPUT_BYTES = 256 * 1024;

export interface ArtifactCowSectionProducerDependencies {
  readonly execute: (context: ArtifactCowModelCallContext) => Promise<ArtifactCowModelOutput>;
  readonly attempt: ArtifactSectionReviseAttempt;
  readonly principal: WorkflowPrincipal;
  readonly model_authority: ModelAttemptAuthority;
  readonly output_residency_domains: ResidencyDomainProfile;
  readonly historical_freeze: {
    readonly operation_id: string;
    readonly investigation_ref: VersionedRef;
    readonly freeze_sha256: string;
  };
  readonly verifier: {
    readonly verifier_ref: string;
    readonly schema_generation: string;
    readonly deployment: ModelRouteDeployment;
  };
  readonly normalization_constraints: (contract: ArtifactSectionContract) => {
    readonly required_precision: string;
    readonly required_source_class: string;
  };
  readonly trusted_audit_inputs: (input: {
    readonly claims: ArtifactCowNormalizedClaims["claims"];
    readonly evidence_pack: ArtifactCowEvidencePack;
  }) => readonly TrustedSemanticClaimAuditInput[];
  readonly validate_evidence_classes: (input: {
    readonly contract: ArtifactSectionContract;
    readonly claims: ArtifactCowNormalizedClaims["claims"];
    readonly evidence_pack: ArtifactCowEvidencePack;
  }) => Promise<void>;
  readonly validate_required_evidence_pack: (input: {
    readonly contract: ArtifactSectionContract;
    readonly evidence_pack: ArtifactCowEvidencePack;
  }) => Promise<void>;
  readonly resolve_current_evidence: (handle_ref: VersionedRef) => Promise<ResolvedEvidence>;
}

export interface ArtifactCowSectionProducer {
  readonly compileSection: (input: {
    readonly parent: ArtifactCowParent;
    readonly contract: ArtifactSectionContract;
    readonly previous: ArtifactCowSectionObject;
    readonly evidence_pack: ArtifactCowEvidencePack;
  }) => Promise<ArtifactCowCompilation>;
  readonly modelOutputs: () => {
    readonly synthesis: ArtifactCowModelOutput | null;
    readonly independent_verification: ArtifactCowModelOutput | null;
  };
}

type ArtifactCowNormalizedClaims = NormalizedSynthesisClaims;

function fail(message: string): never {
  throw new Error(`ARTIFACT_COW_SECTION_PRODUCER_INVALID: ${message}`);
}

function refKey(ref: VersionedRef): string { return `${ref.id}:${ref.revision}`; }
function sameRef(left: VersionedRef, right: VersionedRef): boolean { return left.id === right.id && left.revision === right.revision; }

function stableEvidence(value: ResolvedEvidence): unknown {
  return {
    handle: value.handle,
    exact_excerpt: value.exact_excerpt,
    source_revision_content_sha256: value.source_revision_content_sha256,
    scope_snapshot_digest: value.scope_snapshot_digest,
    instruction_taint: value.instruction_taint,
    allowed_effects: value.allowed_effects,
    authorization_receipt_ref: value.authorization_receipt_ref,
    credential_generation: value.credential_generation,
  };
}

async function validateCitedEvidence(
  refs: readonly VersionedRef[],
  pack: ArtifactCowEvidencePack,
  parent: ArtifactCowParent,
  resolver: ArtifactCowSectionProducerDependencies["resolve_current_evidence"],
): Promise<readonly ResolvedEvidence[]> {
  const byRef = new Map(pack.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
  const output: ResolvedEvidence[] = [];
  for (const ref of refs) {
    const expected = byRef.get(refKey(ref));
    if (expected === undefined || expected.handle.terminal_state !== "LIVE" ||
        !sameRef(expected.handle.scope_snapshot_ref, parent.spec.scope_snapshot_ref)) {
      fail("synthesis cited evidence absent from the current scoped EvidencePack");
    }
    const current = await resolver(ref);
    if (current.handle.terminal_state !== "LIVE" || !sameRef(current.handle.handle_ref, ref) ||
        !sameRef(current.handle.scope_snapshot_ref, parent.spec.scope_snapshot_ref) ||
        current.handle.excerpt_sha256 !== expected.handle.excerpt_sha256 ||
        canonicalEvidenceJson(stableEvidence(current)) !== canonicalEvidenceJson(stableEvidence(expected))) {
      fail("cited evidence no longer resolves to the exact current owner-authorized bytes");
    }
    output.push(current);
  }
  return Object.freeze(output);
}

async function validateCurrentEvidencePack(
  pack: ArtifactCowEvidencePack,
  parent: ArtifactCowParent,
  resolver: ArtifactCowSectionProducerDependencies["resolve_current_evidence"],
): Promise<void> {
  for (const item of pack.resolved_evidence) {
    const current = await resolver(item.handle.handle_ref);
    if (current.handle.terminal_state !== "LIVE" || !sameRef(current.handle.handle_ref, item.handle.handle_ref) ||
        !sameRef(current.handle.scope_snapshot_ref, parent.spec.scope_snapshot_ref) ||
        current.handle.excerpt_sha256 !== item.handle.excerpt_sha256 ||
        canonicalEvidenceJson(stableEvidence(current)) !== canonicalEvidenceJson(stableEvidence(item))) {
      fail("EvidencePack contains purged, changed, or no-longer-authorized evidence");
    }
  }
}

function modelContext(
  input: ArtifactCowSectionProducerDependencies,
  call_slot: ArtifactCowModelCallContext["call_slot"],
  input_bytes: Uint8Array,
): ArtifactCowModelCallContext {
  const attempt = input.attempt;
  if (attempt.state !== "STARTED" && attempt.state !== "OUTPUT_RECORDED") fail("COW W2 attempt is not effect-eligible");
  return Object.freeze({
    request: attempt.request,
    workflow_attempt: Object.freeze({
      request: attempt.request,
      request_json: attempt.request_json,
      request_sha256: attempt.request_sha256,
      authority: attempt.authority,
      budget: Object.freeze({ receipt_ref: attempt.budget.receipt_ref, expires_at_ms: attempt.budget.expires_at_ms }),
      attempt_ref: attempt.attempt_ref,
      state: attempt.state,
    }),
    principal: input.principal,
    authority: input.model_authority,
    call_slot,
    input_bytes: new Uint8Array(input_bytes),
    output_residency_domains: input.output_residency_domains,
  });
}

function canonicalBytes(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(value));
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_MODEL_INPUT_BYTES) fail("trusted model input exceeds its bound");
  return bytes;
}

async function requireReferenceManifest(parent: ArtifactCowParent): Promise<AllowedReferenceManifest> {
  const matches = parent.referenced_objects.filter((item) => item.object_ref === parent.revision.dependency_manifest_ref && item.object_kind === "DEPENDENCY_MANIFEST");
  if (matches.length !== 1) fail("exact parent dependency manifest is absent or duplicated");
  const bytes = matches[0]?.bytes;
  if (!(bytes instanceof Uint8Array)) fail("dependency manifest bytes are missing");
  let manifest: AllowedReferenceManifest;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    manifest = AllowedReferenceManifestSchema.parse(JSON.parse(text));
    if (canonicalEvidenceJson(manifest) !== text || !sameRef(manifest.scope_snapshot_ref, parent.spec.scope_snapshot_ref)) fail("dependency manifest bytes are not canonical or scope bound");
    const { manifest_digest: manifestDigest, ...payload } = manifest;
    if (await evidenceSha256(payload) !== manifestDigest) fail("dependency manifest digest is invalid");
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("ARTIFACT_COW_SECTION_PRODUCER_INVALID:")) throw cause;
    fail("dependency manifest failed strict decoding");
  }
  return manifest;
}

function assertRequiredClaimKinds(contract: ArtifactSectionContract, claims: ArtifactCowNormalizedClaims["claims"]): void {
  const kinds = new Set<string>(claims.map((item) => item.kind));
  if (contract.required_claim_kinds.some((kind) => !kinds.has(kind))) fail("normalized synthesis omitted a required claim kind");
}

function residency(template: ObjectResidencyKey): Omit<ObjectResidencyKey, "content_digest"> {
  const { content_digest: _digest, ...domains } = ObjectResidencyKeySchema.parse(template);
  return domains;
}

/**
 * Creates the concrete synthesis + independent-verification producer consumed
 * by CloudflareArtifactCowAdapter.compileSection. It uses actual durable W3
 * model output and the repository's strict candidate/verifier normalizers.
 */
export function createArtifactCowSectionProducer(dependencies: ArtifactCowSectionProducerDependencies) {
  let synthesisOutput: ArtifactCowModelOutput | null = null;
  let verificationOutput: ArtifactCowModelOutput | null = null;
  const compileSection = async (input: {
    readonly parent: ArtifactCowParent;
    readonly contract: ArtifactSectionContract;
    readonly previous: ArtifactCowSectionObject;
    readonly evidence_pack: ArtifactCowEvidencePack;
  }): Promise<ArtifactCowCompilation> => {
    const { parent, contract, previous, evidence_pack: pack } = input;
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u.test(dependencies.historical_freeze.operation_id) ||
        !/^[a-f0-9]{64}$/u.test(dependencies.historical_freeze.freeze_sha256) ||
        !sameRef(parent.freeze.freeze_ref, dependencies.attempt.request.evidence_freeze_ref)) {
      fail("historical freeze origin is invalid or differs from the exact admitted freeze");
    }
    if (!sameRef(pack.scope_snapshot_ref, parent.spec.scope_snapshot_ref) ||
        !sameRef(parent.freeze.scope_snapshot_ref, parent.spec.scope_snapshot_ref) ||
        dependencies.attempt.request.spec_digest !== parent.revision.spec_digest ||
        !sameRef(dependencies.attempt.request.evidence_freeze_ref, parent.freeze.freeze_ref) ||
        !sameRef(dependencies.model_authority.scope_snapshot_ref, dependencies.attempt.request.scope_snapshot_ref)) {
      fail("COW model producer is not bound to the exact spec, freeze and scope");
    }
    const manifest = await requireReferenceManifest(parent);
    if (!sameRef(manifest.scope_snapshot_ref, pack.scope_snapshot_ref)) fail("dependency manifest scope differs from EvidencePack");
    // Recheck every reusable/source candidate under current authority before either model call.
    await validateCurrentEvidencePack(pack, parent, dependencies.resolve_current_evidence);
    await dependencies.validate_required_evidence_pack({ contract, evidence_pack: pack });
    const synthesisInput = canonicalBytes({
      protocol: "eliotr.artifact-section-synthesis-input.v1",
      operation_id: dependencies.attempt.request.operation_id,
      artifact_ref: parent.revision.artifact_ref,
      spec_digest: parent.revision.spec_digest,
      freeze_ref: parent.freeze.freeze_ref,
      section_contract: contract,
      previous_section: previous.section,
      previous_section_text: new TextDecoder("utf-8", { fatal: true }).decode(previous.bytes),
      reference_manifest_ref: manifest.manifest_ref,
      evidence_pack_ref: pack.pack_ref,
      evidence: pack.resolved_evidence,
    });
    const synthesis = await dependencies.execute(modelContext(dependencies, "SYNTHESIZE", synthesisInput));
    synthesisOutput = synthesis;
    const synthesisAssistant = (await decodeModelGatewayBody(synthesis.bytes)).assistant_content;
    const constraints = dependencies.normalization_constraints(contract);
    const normalizedRaw = await normalizeSynthesisClaimsCandidateAny({
      candidate: decodeSynthesisClaimsCandidateAny(synthesisAssistant),
      operation_id: dependencies.attempt.request.operation_id,
      section_ref: { id: previous.section.section_ref.id, revision: previous.section.section_ref.revision + 1 },
      allowed_handle_refs: pack.resolved_evidence.map((item) => item.handle.handle_ref),
      required_precision: constraints.required_precision,
      required_source_class: constraints.required_source_class,
    });
    const normalized = normalizedRaw as ArtifactCowNormalizedClaims;
    assertRequiredClaimKinds(contract, normalized.claims);
    for (const ref of normalized.cited_handle_refs) {
      if (!manifest.allowed_evidence_handle_refs.some((allowed) => sameRef(allowed, ref)) ||
          !parent.freeze.included_evidence.some((included) => sameRef(included.handle_ref, ref))) {
        fail("normalized synthesis cites evidence outside the exact dependency manifest or historical freeze");
      }
    }
    await dependencies.validate_evidence_classes({ contract, claims: normalized.claims, evidence_pack: pack });
    const cited = await validateCitedEvidence(normalized.cited_handle_refs, pack, parent, dependencies.resolve_current_evidence);
    const auditInputBytes = canonicalBytes({
      protocol: "eliotr.artifact-section-independent-verification-input.v1",
      operation_id: dependencies.attempt.request.operation_id,
      contract,
      section_text: normalized.section_text,
      claims: normalized.claims,
      cited_evidence: cited,
      evidence_pack_ref: pack.pack_ref,
      freeze_ref: parent.freeze.freeze_ref,
    });
    const verificationCall = await dependencies.execute(modelContext(dependencies, "INDEPENDENT_VERIFY", auditInputBytes));
    verificationOutput = verificationCall;
    const expectedInputSha = await evidenceSha256Bytes(auditInputBytes);
    const semanticBatch = decodeSemanticVerifierBatch((await decodeModelGatewayBody(verificationCall.bytes)).assistant_content, {
      verifier_ref: dependencies.verifier.verifier_ref,
      verifier_schema_generation: dependencies.verifier.schema_generation,
      evidence_input_sha256: expectedInputSha,
      claims: normalized.claims as never,
    });
    const trusted = dependencies.trusted_audit_inputs({ claims: normalized.claims, evidence_pack: pack });
    if (trusted.length !== normalized.claims.length || trusted.some((item, index) =>
      !sameRef(item.claim.claim_ref, normalized.claims[index]?.claim_ref ?? { id: "", revision: 0 }))) {
      fail("trusted independent-verifier inputs do not exactly cover normalized claims");
    }
    const translated = translateSemanticVerifierBatch(semanticBatch, trusted);
    const bodyBytes = new TextEncoder().encode(normalized.section_text);
    const bodySha = await evidenceSha256Bytes(bodyBytes);
    if (bodyBytes.byteLength > contract.maximum_utf8_bytes) fail("normalized section exceeds its contract byte limit");
    const ledgerBytes = new TextEncoder().encode(canonicalEvidenceJson(pack));
    const ledgerSha = await evidenceSha256Bytes(ledgerBytes);
    const identity = await canonicalDigest({
      protocol: "eliotr.artifact-section-revise-compiled.v1",
      operation_id: dependencies.attempt.request.operation_id,
      attempt_ref: dependencies.attempt.attempt_ref,
      call_request_sha256: dependencies.attempt.request_sha256,
      section_ref: { id: previous.section.section_ref.id, revision: previous.section.section_ref.revision + 1 },
      body_sha256: bodySha,
      synthesis_sha256: synthesis.output.output_sha256,
      verifier_sha256: verificationCall.output.output_sha256,
    });
    const bodyRef = `eliotr.artifact-section-body-${identity}`;
    const ledgerRef = `eliotr.artifact-section-ledger-${identity}`;
    // Project the existing verifier disposition for each exact normalized claim;
    // claim kinds are contract requirements, not statement identities.
    const statementLabels: Record<string, EvidenceLabel> = Object.fromEntries(translated.map((item) => {
      const label: EvidenceLabel = item.disposition === "SUPPORTED"
        ? item.claim_kind === "recommendation" ? "EDITORIAL_RECOMMENDATION"
          : item.claim_kind === "interpretation" ? "DERIVED_INFERENCE"
            : item.claim_kind === "assumption" ? "HYPOTHESIS" : "SOURCE_SUPPORTED"
        : item.disposition === "PARTIALLY_SUPPORTED" || item.disposition === "CONTRADICTED" ? "CONTESTED"
          : item.disposition === "UNSUPPORTED" ? "HYPOTHESIS" : "UNRESOLVED";
      return [item.claim_id, label];
    }));
    const section = ArtifactSectionRevisionSchema.parse({
      section_ref: { id: previous.section.section_ref.id, revision: previous.section.section_ref.revision + 1 },
      contract_id: contract.section_id,
      body_object_ref: bodyRef,
      body_sha256: bodySha,
      statement_labels: statementLabels,
      evidence_ledger_ref: ledgerRef,
      verification_receipt_ref: "pending-verification-ref",
    });
    const claimAudit: ArtifactDraftSemanticAudit = {
      stage_attempt_ref: dependencies.attempt.attempt_ref,
      stage_request_sha256: dependencies.attempt.request_sha256,
      output_sha256: verificationCall.output.output_sha256,
      synthesis_output_sha256: synthesis.output.output_sha256,
      normalization_binding_sha256: await canonicalDigest(normalizedRaw),
      verifier_ref: dependencies.verifier.verifier_ref,
      verifier_schema_generation: dependencies.verifier.schema_generation,
      model_receipt_ref: verificationCall.receipt.receipt_ref,
      claims: translated.map((item) => ({
        claim_ref: normalized.claims.find((claim) => claim.claim_ref.id === item.claim_id)?.claim_ref as VersionedRef,
        claim_text: normalized.claims.find((claim) => claim.claim_ref.id === item.claim_id)?.text as string,
        claim_text_digest: item.claim_text_digest,
        disposition: item.disposition,
        support_handle_refs: item.exact_support_handles.map((handle) => handle.handle_ref),
        counterevidence_handle_refs: item.counterevidence_handles.map((handle) => handle.handle_ref),
      })),
    };
    const verificationEncoded = await encodeArtifactDraftVerificationV2({
      schema: "eliotr.research.draft-verification.v2",
      semantic_verification: "EXECUTED",
      source_readback: "AUTHORITATIVE_RESOLVED",
      operation_id: dependencies.attempt.request.operation_id,
      investigation_ref: dependencies.historical_freeze.investigation_ref,
      output_sha256: synthesis.output.output_sha256,
      freeze_ref: parent.freeze.freeze_ref,
      freeze_sha256: dependencies.historical_freeze.freeze_sha256,
      manifest_ref: manifest.manifest_ref,
      manifest_sha256: manifest.manifest_digest,
      evidence_pack_ref: pack.pack_ref,
      trace_ref: pack.trace_ref,
      cited_evidence: cited.map((item) => ({
        handle_ref: item.handle.handle_ref,
        excerpt_sha256: item.handle.excerpt_sha256,
        source_revision_content_sha256: item.source_revision_content_sha256,
        scope_snapshot_digest: item.scope_snapshot_digest,
        authorization_receipt_ref: item.authorization_receipt_ref,
        credential_generation: item.credential_generation,
      })),
      section_sha256: bodySha,
      audit: claimAudit,
    });
    const verified = await decodeArtifactDraftVerificationV2(verificationEncoded.bytes, verificationEncoded.verification_receipt_ref);
    const verificationResidency = residency(previous.residency);
    const ledgerObject: ArtifactDraftReferencedObjectInput = {
      object_ref: ledgerRef,
      object_kind: "EVIDENCE_LEDGER",
      bytes: ledgerBytes,
      residency: { ...residency(previous.residency), content_digest: { algorithm: "sha256", digest: ledgerSha } },
    };
    const verificationObject: ArtifactDraftReferencedObjectInput = {
      object_ref: verified.verification_receipt_ref,
      object_kind: "VERIFICATION_RECEIPT",
      bytes: verified.bytes,
      residency: { ...verificationResidency, content_digest: { algorithm: "sha256", digest: verified.sha256 } },
    };
    const compiledSection = ArtifactSectionRevisionSchema.parse({
      ...section,
      verification_receipt_ref: verified.verification_receipt_ref,
    });
    const template = residency(previous.residency);
    const bodyResidency = { ...template, content_digest: { algorithm: "sha256" as const, digest: bodySha } };
    return Object.freeze({
      section: compiledSection,
      bytes: new Uint8Array(bodyBytes),
      residency: bodyResidency,
      referenced_objects: Object.freeze([ledgerObject, verificationObject]),
      dependency_manifest_ref: parent.revision.dependency_manifest_ref,
    });
  };
  return Object.freeze({
    compileSection,
    modelOutputs: () => Object.freeze({ synthesis: synthesisOutput, independent_verification: verificationOutput }),
  }) satisfies ArtifactCowSectionProducer;
}
