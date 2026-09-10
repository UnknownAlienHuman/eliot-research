import {
  ObjectResidencyKeySchema,
  type InquiryProtocolProfile,
  type ObjectResidencyKey,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256,
  evidenceSha256Bytes,
  type CloudflareEvidenceResolver,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import type { LedgerHead } from "@eliotr/research";
import type { ReferenceManifestStorageContext, ResearchReferenceManifestStore } from "./research-reference-manifest-store.js";
import {
  buildAllowedReferenceManifest,
  type ResearchEvidencePack,
} from "./research-reference-manifest.js";
import { CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS } from "./research-protocol-freeze.js";
import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";
import type {
  ModelProfileBinding as EvidenceFreezeModelBinding,
  ModelProfileDefinition as EvidenceFreezeModelDefinition,
} from "./research-model-profile-binding.js";
import type { StageRequest, WorkflowPrincipal } from "./types.js";

export type { EvidenceFreezeModelBinding, EvidenceFreezeModelDefinition };

const MAX_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface EvidenceFreezeStageFiveLineage {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly principal_ref: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly protocol_digest: string;
  readonly denominator_digest: string;
  readonly retrieval_request_digest: string;
  readonly evidence_pack: ResearchEvidencePack;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
}

export type EvidenceFreezeProtocolDefinition = typeof CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS;

export interface EvidenceFreezeLaneMaterial {
  readonly lane: LedgerHead["lane"];
  readonly lane_registrations: readonly string[];
}

export interface EvidenceFreezeManifestStoreFactory {
  create(context: ReferenceManifestStorageContext): ResearchReferenceManifestStore;
}

export type EvidenceFreezeResidencyTemplate = Omit<ObjectResidencyKey, "content_digest">;

export interface EvidenceFreezePreparationDependencies {
  readonly navigation: NavigationReadAuthority;
  readonly resolver: CloudflareEvidenceResolver;
  readonly stage_zero: ProtocolScopeCheckpoint;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
  readonly w1_head: LedgerHead;
  readonly model_binding: EvidenceFreezeModelBinding;
  readonly scope_snapshot_digest: string;
  readonly manifest_store: EvidenceFreezeManifestStoreFactory;
  readonly manifest_residency_template: EvidenceFreezeResidencyTemplate;
  readonly authorization_receipt_ref: string;
  readonly max_context_bytes: number;
  readonly now?: () => string;
}

export interface EvidenceFreezePreparationResult {
  readonly input_bytes: Uint8Array;
  readonly stage_input: {
    readonly protocol: "eliotr.evidence-freeze-input.v2";
    readonly freeze_ref: VersionedRef;
    readonly manifest_ref: VersionedRef;
    readonly coverage_denominator_ref: VersionedRef;
    readonly protocol_profile: InquiryProtocolProfile;
    readonly protocol_definition: EvidenceFreezeProtocolDefinition;
    readonly lane_material: EvidenceFreezeLaneMaterial;
    readonly protocol_digest: string;
    readonly contract_protocol_digest: string;
    readonly lane_digest: string;
    readonly stage_zero_attempt_ref: string;
    readonly stage_five_attempt_ref: string;
    readonly stage_five_request_sha256: string;
    readonly model_profile_binding_ref: VersionedRef;
    readonly model_profile_definition: EvidenceFreezeModelDefinition;
  };
  readonly manifest_digest: string;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(value: VersionedRef): string {
  return `${value.id}:${value.revision}`;
}

function validId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`${label} is invalid`);
}

function cleanW1(head: LedgerHead, checkpoint: ProtocolScopeCheckpoint, currentRef?: VersionedRef): void {
  if (head.status !== "OPEN" || head.lane !== "exploratory" || head.protocol_version !== checkpoint.w1_protocol_version ||
      head.investigation_id !== checkpoint.investigation_ref.id || head.revision < checkpoint.w1_revision ||
      (currentRef !== undefined && (head.investigation_id !== currentRef.id || head.revision !== currentRef.revision)) ||
      head.principal_ref !== checkpoint.principal_ref || head.evidence_grade !== checkpoint.requested_evidence_grade ||
      head.goal !== checkpoint.protocol_profile.question || head.model_profile_ref !== checkpoint.protocol_profile.model_profile_ref ||
      head.scope_snapshot_id !== checkpoint.scope_snapshot_ref.id || head.scope_snapshot_revision !== checkpoint.scope_snapshot_ref.revision ||
      head.lane_registrations.length !== 0 || head.obligations.length !== 0 || head.hypotheses.length !== 0 || head.debt_refs.length !== 0) {
    throw new Error("exploratory W1 authority is not eligible for evidence freeze");
  }
}

async function derivedDigest(domain: string, value: unknown): Promise<string> {
  return evidenceSha256({ domain, value });
}

function generationBindings(binding: EvidenceFreezeModelBinding): Readonly<Record<string, string>> {
  const result: Record<string, string> = { ...binding.policy.provider_and_policy_generations };
  result.policy_generation = binding.policy_generation;
  result.deployment_generation = binding.deployment_generation;
  if (Object.keys(result).some((key) => !ID.test(key) || !ID.test(result[key] ?? ""))) {
    throw new Error("model generation binding is invalid");
  }
  return result;
}

async function modelDefinition(binding: EvidenceFreezeModelBinding): Promise<EvidenceFreezeModelDefinition> {
  const bindingMaterial = {
    schema: binding.schema,
    config_provenance_ref: binding.config_provenance_ref,
    definition_ref: binding.definition_ref,
    definition_sha256: binding.definition_sha256,
    model_profile_ref: binding.model_profile_ref,
    policy_authority_ref: binding.policy_authority_ref,
    policy_generation: binding.policy_generation,
    deployment_generation: binding.deployment_generation,
    scope_snapshot_ref: binding.scope_snapshot_ref,
    scope_snapshot_digest: binding.scope_snapshot_digest,
    expires_at: binding.expires_at,
    max_context_bytes: binding.max_context_bytes,
    deployment: binding.deployment,
    policy: binding.policy,
  };
  const definition = {
    schema: "eliotr.research.model-profile-definition.v1" as const,
    definition_ref: binding.definition_ref,
    definition_sha256: binding.definition_sha256,
    config_provenance_ref: binding.config_provenance_ref,
    model_profile_ref: binding.model_profile_ref,
    expires_at: binding.expires_at,
    max_context_bytes: binding.max_context_bytes,
    deployment: binding.deployment,
    policy: binding.policy,
  };
  const { definition_ref: _ref, definition_sha256: _sha, ...material } = definition;
  if (binding.binding_ref.revision !== 1 || binding.definition_ref.revision !== 1 ||
      binding.policy.expires_at !== binding.expires_at ||
      await modelGatewaySha256(canonicalModelGatewayJson(bindingMaterial)) !== binding.binding_sha256 ||
      binding.binding_ref.id !== `eliotr.research.model-profile-binding-${binding.binding_sha256}` ||
      await modelGatewaySha256(canonicalModelGatewayJson(material)) !== definition.definition_sha256 ||
      definition.definition_ref.id !== `eliotr.research.model-profile-definition-${definition.definition_sha256}`) {
    throw new Error("model profile definition identity is invalid");
  }
  return Object.freeze(definition);
}

export async function deriveEvidenceFreezeAuthorityBinding(input: {
  readonly stage_zero: ProtocolScopeCheckpoint;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
  readonly w1_head: LedgerHead;
  readonly model_binding: EvidenceFreezeModelBinding;
  readonly scope_snapshot_digest: string;
  readonly current_investigation_ref: VersionedRef;
  readonly stage_input: {
    readonly coverage_denominator_ref: VersionedRef;
    readonly protocol_profile: InquiryProtocolProfile;
    readonly protocol_definition: EvidenceFreezeProtocolDefinition;
    readonly lane_material: EvidenceFreezeLaneMaterial;
    readonly protocol_digest: string;
    readonly contract_protocol_digest: string;
    readonly lane_digest: string;
    readonly stage_zero_attempt_ref: string;
    readonly stage_five_attempt_ref: string;
    readonly stage_five_request_sha256: string;
    readonly model_profile_binding_ref: VersionedRef;
    readonly model_profile_definition: EvidenceFreezeModelDefinition;
  };
}): Promise<{
  readonly scope_snapshot_ref: VersionedRef;
  readonly coverage_denominator_ref: VersionedRef;
  readonly protocol_digest: string;
  readonly contract_protocol_digest: string;
  readonly lane_digest: string;
  readonly stage_zero_attempt_ref: string;
  readonly stage_five_attempt_ref: string;
  readonly stage_five_request_sha256: string;
  readonly model_profile_binding_ref: VersionedRef;
  readonly model_profile_definition: EvidenceFreezeModelDefinition;
  readonly protocol_profile: InquiryProtocolProfile;
  readonly protocol_definition: EvidenceFreezeProtocolDefinition;
  readonly lane_material: EvidenceFreezeLaneMaterial;
  readonly excluded_evidence: readonly { evidence_ref: string; reason: string }[];
  readonly unresolved_contradiction_refs: readonly string[];
  readonly open_research_debt_refs: readonly VersionedRef[];
  readonly provider_model_prompt_tool_generations: Readonly<Record<string, string>>;
}> {
  cleanW1(input.w1_head, input.stage_zero, input.current_investigation_ref);
  if (input.stage_five.operation_id !== input.stage_zero.operation_id || input.stage_five.principal_ref !== input.stage_zero.principal_ref ||
      !sameRef(input.stage_five.scope_snapshot_ref, input.stage_zero.scope_snapshot_ref) ||
      input.stage_five.protocol_digest !== input.stage_zero.protocol_digest || input.stage_five.denominator_digest !== input.stage_zero.denominator_digest ||
      !sameRef(input.stage_five.evidence_pack.scope_snapshot_ref, input.stage_zero.scope_snapshot_ref) ||
      !sameRef(input.model_binding.scope_snapshot_ref, input.stage_zero.scope_snapshot_ref) ||
      input.model_binding.scope_snapshot_digest !== input.scope_snapshot_digest ||
      input.model_binding.model_profile_ref !== input.stage_zero.protocol_profile.model_profile_ref ||
      input.model_binding.policy_authority_ref !== input.w1_head.policy_authority_ref ||
      input.model_binding.policy_generation !== input.w1_head.policy_generation ||
      input.model_binding.deployment_generation !== input.w1_head.deployment_generation ||
      !sameRef(input.stage_input.coverage_denominator_ref, input.stage_zero.coverage_denominator.denominator_ref) ||
      canonicalEvidenceJson(input.stage_input.protocol_profile) !== canonicalEvidenceJson(input.stage_zero.protocol_profile) ||
      canonicalEvidenceJson(input.stage_input.protocol_definition) !== canonicalEvidenceJson(CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS) ||
      canonicalEvidenceJson(input.stage_input.lane_material) !== canonicalEvidenceJson({ lane: input.w1_head.lane, lane_registrations: [...input.w1_head.lane_registrations] }) ||
      input.stage_input.protocol_digest !== input.stage_zero.protocol_digest || input.stage_input.stage_zero_attempt_ref !== input.stage_zero.attempt_ref ||
      input.stage_input.stage_five_attempt_ref !== input.stage_five.stage_attempt_ref || input.stage_input.stage_five_request_sha256 !== input.stage_five.stage_request_sha256 ||
      !sameRef(input.stage_input.model_profile_binding_ref, input.model_binding.binding_ref)) {
    throw new Error("freeze authority binding differs from persisted workflow material");
  }
  const definition = await modelDefinition(input.model_binding);
  if (canonicalEvidenceJson(input.stage_input.model_profile_definition) !== canonicalEvidenceJson(definition)) {
    throw new Error("model profile definition differs from persisted binding");
  }
  const contractProtocolDigest = await derivedDigest("eliotr.evidence-freeze.contract-protocol.v1", {
    w1_protocol_version: input.w1_head.protocol_version,
    profile_definition_ref: input.stage_zero.profile_definition_ref,
    protocol_profile: input.stage_zero.protocol_profile,
    protocol_definition: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS,
    protocol_digest: input.stage_zero.protocol_digest,
  });
  const laneDigest = await derivedDigest("eliotr.evidence-freeze.lane.v1", {
    lane: input.w1_head.lane,
    lane_registrations: [...input.w1_head.lane_registrations],
  });
  if (input.stage_input.contract_protocol_digest !== contractProtocolDigest || input.stage_input.lane_digest !== laneDigest) {
    throw new Error("freeze authority digest differs from persisted workflow material");
  }
  return {
    scope_snapshot_ref: input.stage_zero.scope_snapshot_ref,
    coverage_denominator_ref: input.stage_zero.coverage_denominator.denominator_ref,
    protocol_digest: input.stage_zero.protocol_digest,
    contract_protocol_digest: contractProtocolDigest,
    lane_digest: laneDigest,
    stage_zero_attempt_ref: input.stage_zero.attempt_ref,
    stage_five_attempt_ref: input.stage_five.stage_attempt_ref,
    stage_five_request_sha256: input.stage_five.stage_request_sha256,
    model_profile_binding_ref: input.model_binding.binding_ref,
    model_profile_definition: definition,
    protocol_profile: input.stage_zero.protocol_profile,
    protocol_definition: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS,
    lane_material: { lane: input.w1_head.lane, lane_registrations: [...input.w1_head.lane_registrations] },
    excluded_evidence: input.stage_five.evidence_pack.omitted_candidates.map((candidate) => ({
      evidence_ref: candidate.candidate_id,
      reason: candidate.reason_code,
    })),
    unresolved_contradiction_refs: [],
    open_research_debt_refs: [],
    provider_model_prompt_tool_generations: generationBindings(input.model_binding),
  };
}

export async function prepareEvidenceFreezeInput(
  dependencies: EvidenceFreezePreparationDependencies,
  request: StageRequest,
  principal: WorkflowPrincipal,
): Promise<EvidenceFreezePreparationResult> {
  if (request.stage !== "RECONCILE" || request.operation_id !== dependencies.stage_zero.operation_id ||
      request.operation_id !== dependencies.stage_five.operation_id || principal.principal_ref !== dependencies.stage_zero.principal_ref ||
      principal.principal_ref !== dependencies.stage_five.principal_ref ||
      !sameRef(dependencies.stage_zero.scope_snapshot_ref, dependencies.stage_five.scope_snapshot_ref) ||
      dependencies.stage_zero.protocol_digest !== dependencies.stage_five.protocol_digest ||
      dependencies.stage_zero.denominator_digest !== dependencies.stage_five.denominator_digest ||
      !sameRef(dependencies.stage_five.evidence_pack.scope_snapshot_ref, dependencies.stage_zero.scope_snapshot_ref)) {
    throw new Error("freeze predecessor lineage is inconsistent");
  }
  cleanW1(dependencies.w1_head, dependencies.stage_zero, request.investigation_ref);
  validId(dependencies.authorization_receipt_ref, "authorization receipt");
  const scopeRef = dependencies.stage_zero.scope_snapshot_ref;
  if (dependencies.navigation.scope.snapshot_id !== scopeRef.id || dependencies.navigation.scope.revision !== scopeRef.revision ||
      dependencies.navigation.scope.digest === undefined || !sameRef(dependencies.model_binding.scope_snapshot_ref, scopeRef) ||
      dependencies.model_binding.scope_snapshot_digest !== dependencies.navigation.scope.digest ||
      dependencies.manifest_residency_template.scope_domain_id !== scopeRef.id ||
      dependencies.manifest_residency_template.access_domain_id !== principal.principal_ref) throw new Error("freeze scope authority is inconsistent");
  const binding = dependencies.model_binding;
  validId(binding.model_profile_ref, "model profile");
  validId(binding.policy_authority_ref, "policy authority");
  validId(binding.policy_generation, "policy generation");
  validId(binding.deployment_generation, "deployment generation");
  validId(binding.deployment.route_ref, "model route");
  if (!Number.isSafeInteger(binding.max_context_bytes) || binding.max_context_bytes < 1 ||
      dependencies.max_context_bytes !== binding.max_context_bytes) throw new Error("model context bound is invalid");
  const contractProtocolDigest = await derivedDigest("eliotr.evidence-freeze.contract-protocol.v1", {
    w1_protocol_version: dependencies.w1_head.protocol_version,
    profile_definition_ref: dependencies.stage_zero.profile_definition_ref,
    protocol_profile: dependencies.stage_zero.protocol_profile,
    protocol_definition: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS,
    protocol_digest: dependencies.stage_zero.protocol_digest,
  });
  const laneDigest = await derivedDigest("eliotr.evidence-freeze.lane.v1", {
    lane: dependencies.w1_head.lane,
    lane_registrations: [...dependencies.w1_head.lane_registrations],
  });
  const lineage = {
    operation_id: request.operation_id,
    stage_zero_attempt_ref: dependencies.stage_zero.attempt_ref,
    stage_five_attempt_ref: dependencies.stage_five.stage_attempt_ref,
    stage_five_request_sha256: dependencies.stage_five.stage_request_sha256,
    scope_snapshot_ref: scopeRef,
    protocol_digest: dependencies.stage_zero.protocol_digest,
    denominator_digest: dependencies.stage_zero.denominator_digest,
    model_profile_binding_ref: binding.binding_ref,
  };
  const manifestRef: VersionedRef = { id: `eliotr.reference-manifest-${await derivedDigest("eliotr.evidence-freeze.manifest-ref.v1", lineage)}`, revision: 1 };
  const built = await buildAllowedReferenceManifest({
    evidence_pack: dependencies.stage_five.evidence_pack,
    navigation: dependencies.navigation,
    resolver: dependencies.resolver,
    policy: binding.policy,
    manifest_ref: manifestRef,
    model_route_ref: binding.deployment.route_ref,
    max_context_bytes: dependencies.max_context_bytes,
  });
  const manifestBytes = new TextEncoder().encode(canonicalEvidenceJson(built.manifest));
  if (manifestBytes.byteLength > MAX_BYTES * 4) throw new Error("reference manifest exceeds bounded storage input");
  const manifestContentDigest = await evidenceSha256Bytes(manifestBytes);
  const residency = ObjectResidencyKeySchema.parse({
    ...dependencies.manifest_residency_template,
    content_digest: { algorithm: "sha256", digest: manifestContentDigest },
  });
  const createdAt = dependencies.now?.() ?? new Date().toISOString();
  const store = dependencies.manifest_store.create({
    principal_ref: principal.principal_ref,
    credential_generation: dependencies.navigation.access.credential_generation,
    scope_snapshot_ref: scopeRef,
    manifest_residency_key: residency,
    policy_authority_ref: binding.policy_authority_ref,
    authorization_receipt_ref: dependencies.authorization_receipt_ref,
    scope_snapshot_digest: dependencies.navigation.scope.digest,
    pack_ref: dependencies.stage_five.evidence_pack.pack_ref,
    trace_ref: dependencies.stage_five.evidence_pack.trace_ref,
    stage_attempt_ref: dependencies.stage_five.stage_attempt_ref,
    stage_request_sha256: dependencies.stage_five.stage_request_sha256,
    created_at: createdAt,
  });
  const persisted = await store.persist(built.manifest);
  if (!sameRef(persisted.manifest_ref, manifestRef) || persisted.manifest_digest !== built.manifest.manifest_digest ||
      persisted.r2_content_sha256 !== manifestContentDigest) throw new Error("reference manifest persistence readback is not exact");
  const freezeRef: VersionedRef = { id: `eliotr.evidence-freeze-${await derivedDigest("eliotr.evidence-freeze.ref.v1", { ...lineage, manifest_ref: manifestRef, manifest_digest: built.manifest.manifest_digest })}`, revision: 1 };
  const stageInput: EvidenceFreezePreparationResult["stage_input"] = {
    protocol: "eliotr.evidence-freeze-input.v2",
    freeze_ref: freezeRef,
    manifest_ref: manifestRef,
    coverage_denominator_ref: dependencies.stage_zero.coverage_denominator.denominator_ref,
    protocol_profile: dependencies.stage_zero.protocol_profile,
    protocol_definition: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS,
    lane_material: { lane: dependencies.w1_head.lane, lane_registrations: [...dependencies.w1_head.lane_registrations] },
    protocol_digest: dependencies.stage_zero.protocol_digest,
    contract_protocol_digest: contractProtocolDigest,
    lane_digest: laneDigest,
    stage_zero_attempt_ref: dependencies.stage_zero.attempt_ref,
    stage_five_attempt_ref: dependencies.stage_five.stage_attempt_ref,
    stage_five_request_sha256: dependencies.stage_five.stage_request_sha256,
    model_profile_binding_ref: binding.binding_ref,
    model_profile_definition: await modelDefinition(binding),
  };
  const inputBytes = new TextEncoder().encode(canonicalEvidenceJson(stageInput));
  if (inputBytes.byteLength > MAX_BYTES) throw new Error("freeze input exceeds the receipt bound");
  return { input_bytes: inputBytes, stage_input: Object.freeze(stageInput), manifest_digest: built.manifest.manifest_digest };
}

export function protocolProfileIsExploratory(profile: InquiryProtocolProfile): boolean {
  return profile.profile_ref.id.startsWith("eliotr.research.compiled-profile-") && profile.profile_ref.revision === 1;
}

export function evidenceFreezeRefKey(value: VersionedRef): string {
  return refKey(value);
}
