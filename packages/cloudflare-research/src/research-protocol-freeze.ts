import {
  EvidenceGradeSchema,
  InquiryProtocolProfileSchema,
  ScopeSnapshotSchema,
  VersionedRefSchema,
  type InquiryProtocolProfile,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore, LedgerHead } from "@eliotr/research";
import {
  digest,
  MAX_WORKFLOW_RECEIPT_BYTES,
  textDigest,
  type StageRequest,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "./types.js";
import { readWorkflowObject } from "./objects.js";
import { WorkflowCheckpointStore } from "./store.js";
import { z } from "zod";

/** The server-owned profile family for bounded corpus-only lookup. */
export const CORPUS_EXPLORATORY_LOOKUP_PROFILE_REF = Object.freeze({
  id: "eliotr.research.profile.corpus-exploratory-lookup",
  revision: 1,
}) satisfies VersionedRef;
export const CORPUS_EXPLORATORY_PROFILE_DEFINITION_REF = CORPUS_EXPLORATORY_LOOKUP_PROFILE_REF;

/**
 * These are definitions, rather than caller-provided labels.  The profile
 * below references every entry, so a reference cannot silently resolve to an
 * empty or ambient policy string.
 */
export const CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS = Object.freeze({
  independence_policy_ref: "eliotr.research.independence.corpus-source-v1",
  chronology_policy_ref: "eliotr.research.chronology.frozen-source-revisions-v1",
  fidelity_ceiling: "eliotr.research.fidelity.normalized-text-coordinates-v1",
  stop_rule_ref: "eliotr.research.stop.one-bounded-corpus-retrieval-v1",
  output_contract_ref: "eliotr.research.output.draft-answer-with-exact-handles-v1",
  completeness_test_ref: "eliotr.research.coverage.exploratory-membership-observation-v1",
  external_acquisition: "none",
} as const);

type CorpusDefinitionRef = keyof typeof CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS;
const DEFINITION_REFS: readonly CorpusDefinitionRef[] = [
  "independence_policy_ref", "chronology_policy_ref", "fidelity_ceiling",
  "stop_rule_ref", "output_contract_ref", "completeness_test_ref", "external_acquisition",
];

export const CorpusCoverageDenominatorSchema = z.object({
  denominator_ref: VersionedRefSchema,
  frozen_scope_snapshot_ref: VersionedRefSchema,
  eligible_source_revision_refs: z.array(z.string().min(1).max(256)),
  required_source_classes: z.array(z.string().min(1).max(256)),
  required_question_branches: z.array(z.string().min(1).max(256)),
  acquisition_method_generations: z.record(z.string().min(1).max(256), z.string().min(1).max(256)),
  excluded_sources: z.array(z.object({ source_ref: z.string().min(1).max(256), reason: z.string().min(1).max(256) }).strict()),
  completeness_test_ref: z.string().min(1).max(256),
  expires_at: z.string().datetime({ offset: true }),
}).strict();
export type CorpusCoverageDenominator = z.infer<typeof CorpusCoverageDenominatorSchema>;

const ProtocolScopeCheckpointSchema = z.object({
  protocol: z.literal("eliotr.research.protocol-scope.v1"),
  workflow_stage: z.literal("FREEZE_PROTOCOL_AND_SCOPE"),
  operation_id: z.string().min(1).max(128),
  attempt_ref: z.string().min(1).max(256),
  investigation_ref: VersionedRefSchema,
  principal_ref: z.string().min(1).max(256),
  scope_snapshot_ref: VersionedRefSchema,
  w1_protocol_version: z.string().min(1).max(256),
  w1_revision: z.number().int().positive(),
  requested_evidence_grade: EvidenceGradeSchema,
  external_acquisition: z.literal("none"),
  profile_definition_ref: VersionedRefSchema,
  profile_identity_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  protocol_profile: InquiryProtocolProfileSchema,
  protocol_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  coverage_denominator: CorpusCoverageDenominatorSchema,
  denominator_identity_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  denominator_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  observed_at: z.string().datetime({ offset: true }),
}).strict();
export type ProtocolScopeCheckpoint = z.infer<typeof ProtocolScopeCheckpointSchema>;

const RunPayloadSchema = z.object({
  investigation_id: z.string().min(1).max(256),
  operation_id: z.string().min(1).max(128),
  query: z.string().min(1).max(8192),
  scope_snapshot_ref: VersionedRefSchema,
  evidence_grade: EvidenceGradeSchema,
  principal_ref: z.string().min(1).max(256),
}).strict();
type RunPayload = z.infer<typeof RunPayloadSchema>;

export interface ResearchProtocolFreezeStageDependencies {
  readonly navigation: NavigationReadAuthority;
  /** The existing D1-backed W1 ledger reader; this is not a new authority table. */
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
}

export type ResearchProtocolFreezeErrorCode =
  | "RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID"
  | "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE"
  | "RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID";

export class ResearchProtocolFreezeError extends Error {
  public constructor(
    public readonly code: ResearchProtocolFreezeErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProtocolFreezeError";
  }
}

function fail(code: ResearchProtocolFreezeErrorCode, message: string, cause?: unknown): never {
  throw new ResearchProtocolFreezeError(code, message, cause);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function parsePayload(bytes: Uint8Array): RunPayload {
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "run payload exceeds the checkpoint bound");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "run payload is not valid JSON", cause);
  }
  const parsed = RunPayloadSchema.safeParse(value);
  if (!parsed.success) fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "run payload shape is invalid", parsed.error);
  return parsed.data;
}

function assertDefinitionSet(profile: InquiryProtocolProfile): void {
  for (const key of DEFINITION_REFS) {
    const value = CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS[key];
    if (typeof value !== "string" || value.length === 0) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", `profile definition ${key} is unavailable`);
  }
  if (profile.independence_policy_ref !== CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.independence_policy_ref ||
      profile.chronology_policy_ref !== CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.chronology_policy_ref ||
      profile.fidelity_ceiling !== CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.fidelity_ceiling ||
      profile.stop_rule_ref !== CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.stop_rule_ref ||
      profile.output_contract_ref !== CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.output_contract_ref) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "profile references an unknown server definition");
  }
  if (profile.intended_decision_or_artifact !== "bounded corpus lookup draft with exact evidence handles" ||
      profile.protocol !== "lookup" || profile.lane !== "exploratory" || profile.source_mode !== "corpus_only" ||
      canonicalEvidenceJson(profile.admissible_provider_classes) !== canonicalEvidenceJson(["admitted-corpus"]) ||
      canonicalEvidenceJson(profile.truth_surfaces) !== canonicalEvidenceJson(["admitted-source-revisions"]) ||
      profile.source_policy.primary_required !== false || profile.source_policy.peer_reviewed_preferred !== false ||
      canonicalEvidenceJson(profile.source_policy.authority_classes) !== canonicalEvidenceJson(["owner-admitted-source"]) ||
      profile.source_policy.excluded_classes.length !== 0 || profile.coverage_goal !== "exploratory" ||
      profile.alternatives_required || profile.counter_search_required || profile.falsification_required ||
      profile.budget_ref !== "research-budget-v1") {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "profile does not match the server-owned exploratory definition");
  }
}

function profileFields(question: string, grade: RunPayload["evidence_grade"], modelProfileRef: string): Omit<InquiryProtocolProfile, "profile_ref"> {
  return {
    question,
    intended_decision_or_artifact: "bounded corpus lookup draft with exact evidence handles",
    protocol: "lookup",
    evidence_grade: grade,
    lane: "exploratory",
    source_mode: "corpus_only",
    admissible_provider_classes: ["admitted-corpus"],
    truth_surfaces: ["admitted-source-revisions"],
    source_policy: {
      primary_required: false,
      peer_reviewed_preferred: false,
      authority_classes: ["owner-admitted-source"],
      excluded_classes: [],
    },
    coverage_goal: "exploratory",
    alternatives_required: false,
    counter_search_required: false,
    falsification_required: false,
    independence_policy_ref: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.independence_policy_ref,
    chronology_policy_ref: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.chronology_policy_ref,
    fidelity_ceiling: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.fidelity_ceiling,
    model_profile_ref: modelProfileRef,
    budget_ref: "research-budget-v1",
    stop_rule_ref: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.stop_rule_ref,
    output_contract_ref: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.output_contract_ref,
    reopen_conditions: [
      "A changed ScopeSnapshot requires a new W1 investigation revision.",
      "Exploratory output cannot be promoted to a confirmatory claim without a declared protocol.",
    ],
  };
}

async function profileFor(question: string, grade: RunPayload["evidence_grade"], modelProfileRef: string): Promise<{ profile: InquiryProtocolProfile; identity_digest: string }> {
  const fields = profileFields(question, grade, modelProfileRef);
  const identity_digest = await evidenceSha256(fields);
  const profile = InquiryProtocolProfileSchema.parse({
    profile_ref: { id: `eliotr.research.compiled-profile-${identity_digest}`, revision: 1 },
    ...fields,
  });
  assertDefinitionSet(profile);
  return { profile, identity_digest };
}

function scopeRef(scope: ScopeSnapshot): VersionedRef {
  return { id: scope.snapshot_id, revision: scope.revision };
}

function assertScopeMembers(scope: ScopeSnapshot): readonly string[] {
  const refs = [...scope.member_source_revision_refs];
  if (new Set(refs).size !== refs.length || refs.some((ref) => typeof ref !== "string" || ref.length === 0 || ref.length > 256)) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "scope source revisions are not a unique bounded set");
  }
  return refs.sort();
}

function assertHeadBinding(head: LedgerHead, payload: RunPayload, request: StageRequest, principal: WorkflowPrincipal, inputDigest: string, scope: ScopeSnapshot): void {
  if (head.status !== "OPEN" || head.lane !== "exploratory") fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "W1 ledger is not an exploratory open investigation");
  if (head.investigation_id !== payload.investigation_id || head.revision !== request.investigation_ref.revision ||
      head.principal_ref !== principal.principal_ref || head.principal_ref !== payload.principal_ref ||
      head.scope_snapshot_id !== scope.snapshot_id || head.scope_snapshot_revision !== scope.revision ||
      head.portfolio_ref !== request.input_manifest.object_ref || head.input_digest !== inputDigest ||
      head.evidence_grade !== payload.evidence_grade || head.goal !== payload.query) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "W1 ledger does not match the stage input");
  }
}

async function denominatorFor(scope: ScopeSnapshot): Promise<{ denominator: CorpusCoverageDenominator; identity_digest: string }> {
  const refs = assertScopeMembers(scope);
  const fields: Omit<CorpusCoverageDenominator, "denominator_ref"> = {
    frozen_scope_snapshot_ref: scopeRef(scope),
    eligible_source_revision_refs: [...refs],
    required_source_classes: [],
    required_question_branches: [],
    acquisition_method_generations: {},
    excluded_sources: [],
    completeness_test_ref: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.completeness_test_ref,
    expires_at: scope.expires_at,
  };
  const identity_digest = await evidenceSha256(fields);
  const denominatorRef: VersionedRef = { id: `eliotr.coverage.compiled-membership-${identity_digest}`, revision: 1 };
  return { denominator: CorpusCoverageDenominatorSchema.parse({ denominator_ref: denominatorRef, ...fields }), identity_digest };
}

function assertDenominatorDefinition(value: CorpusCoverageDenominator): void {
  if (value.required_source_classes.length !== 0 || value.required_question_branches.length !== 0 ||
      Object.keys(value.acquisition_method_generations).length !== 0 || value.excluded_sources.length !== 0 ||
      value.completeness_test_ref !== CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.completeness_test_ref) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "denominator is outside the exploratory corpus definition");
  }
}

interface WorkflowRunBinding {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly initial_revision: number;
  readonly current_revision: number;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly initial_manifest_json: string;
  readonly state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
}

function assertReadbackBinding(
  checkpoint: ProtocolScopeCheckpoint,
  head: LedgerHead,
  run: WorkflowRunBinding,
  scope: ScopeSnapshot,
  request: StageRequest,
  principal: WorkflowPrincipal,
): void {
  const expectedScope = scopeRef(scope);
  if (checkpoint.operation_id !== request.operation_id || checkpoint.workflow_stage !== request.stage ||
      !sameRef(checkpoint.investigation_ref, request.investigation_ref) || checkpoint.principal_ref !== principal.principal_ref ||
      !sameRef(checkpoint.scope_snapshot_ref, expectedScope) || checkpoint.w1_revision !== run.initial_revision ||
      request.investigation_ref.revision !== run.initial_revision || checkpoint.w1_protocol_version !== head.protocol_version ||
      checkpoint.requested_evidence_grade !== head.evidence_grade || checkpoint.protocol_profile.evidence_grade !== checkpoint.requested_evidence_grade ||
      checkpoint.protocol_profile.question !== head.goal || head.revision < run.initial_revision ||
      head.revision !== run.current_revision || head.status !== "OPEN" || head.lane !== "exploratory" ||
      head.investigation_id !== run.investigation_id || head.principal_ref !== principal.principal_ref ||
      head.scope_snapshot_id !== scope.snapshot_id || head.scope_snapshot_revision !== scope.revision ||
      run.operation_id !== request.operation_id || run.principal_ref !== principal.principal_ref ||
      run.credential_generation !== principal.credential_generation ||
      run.investigation_id !== request.investigation_ref.id || run.scope_snapshot_id !== scope.snapshot_id ||
      run.scope_snapshot_revision !== scope.revision || run.policy_generation !== head.policy_generation ||
      run.policy_authority_ref !== head.policy_authority_ref || run.deployment_generation !== head.deployment_generation ||
      run.initial_manifest_json !== JSON.stringify(request.input_manifest) ||
      checkpoint.protocol_profile.model_profile_ref !== head.model_profile_ref ||
      checkpoint.coverage_denominator.frozen_scope_snapshot_ref.id !== expectedScope.id ||
      checkpoint.coverage_denominator.frozen_scope_snapshot_ref.revision !== expectedScope.revision ||
      checkpoint.coverage_denominator.expires_at !== scope.expires_at) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "persisted protocol scope checkpoint is not bound to current W1 authority");
  }
  const eligible = assertScopeMembers(scope);
  if (canonicalEvidenceJson(checkpoint.coverage_denominator.eligible_source_revision_refs) !== canonicalEvidenceJson(eligible)) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "protocol scope denominator no longer matches the frozen scope");
  }
}

function checkpointBytes(value: ProtocolScopeCheckpoint): Uint8Array {
  const parsed = ProtocolScopeCheckpointSchema.parse(value);
  if (!sameRef(parsed.profile_definition_ref, CORPUS_EXPLORATORY_PROFILE_DEFINITION_REF) ||
      parsed.protocol_profile.profile_ref.id !== `eliotr.research.compiled-profile-${parsed.profile_identity_digest}` ||
      parsed.coverage_denominator.denominator_ref.id !== `eliotr.coverage.compiled-membership-${parsed.denominator_identity_digest}`) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "checkpoint content identities do not match their definitions");
  }
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "protocol scope checkpoint exceeds 64 KiB");
  return bytes;
}

/**
 * Produces the first W2 checkpoint document.  It is intentionally limited to
 * an exploratory corpus membership observation: no external acquisition,
 * confirmatory registration, provider generation or evidence claim is minted.
 */
export function createFreezeProtocolAndScopeStageHandler(
  dependencies: ResearchProtocolFreezeStageDependencies,
): WorkflowStageHandler {
  return async ({ request, principal, input_bytes, attempt_ref }) => {
    if (request.stage !== "FREEZE_PROTOCOL_AND_SCOPE") fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "handler called for another stage");
    const payload = parsePayload(input_bytes);
    const scope = ScopeSnapshotSchema.parse(dependencies.navigation.scope);
    if (payload.operation_id !== request.operation_id || payload.investigation_id !== request.investigation_ref.id ||
        payload.principal_ref !== principal.principal_ref || !sameRef(payload.scope_snapshot_ref, scopeRef(scope)) ||
        request.input_manifest.sha256 !== await digest(input_bytes)) {
      fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "run payload is not bound to the stage identity");
    }
    if (!sameRef(payload.scope_snapshot_ref, scopeRef(scope))) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "run payload scope is not the navigation scope");
    await dependencies.navigation.current();
    const initial = await dependencies.ledger.read(payload.investigation_id);
    if (initial === null) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "W1 investigation is unavailable");
    const inputDigest = await digest(input_bytes);
    assertHeadBinding(initial.head, payload, request, principal, inputDigest, scope);
    const profileResult = await profileFor(payload.query, initial.head.evidence_grade, initial.head.model_profile_ref);
    const denominatorResult = await denominatorFor(scope);
    const protocolDigest = await evidenceSha256(profileResult.profile);
    const denominatorDigest = await evidenceSha256(denominatorResult.denominator);
    await dependencies.navigation.current();
    const final = await dependencies.ledger.read(payload.investigation_id);
    if (final === null || canonicalEvidenceJson(final.head) !== canonicalEvidenceJson(initial.head)) {
      fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "W1 authority changed during protocol freeze");
    }
    const observedAt = dependencies.navigation.timestamp();
    if (Date.parse(scope.expires_at) <= Date.parse(observedAt)) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "scope expired during protocol freeze");
    return checkpointBytes({
      protocol: "eliotr.research.protocol-scope.v1",
      workflow_stage: "FREEZE_PROTOCOL_AND_SCOPE",
      operation_id: request.operation_id,
      attempt_ref,
      investigation_ref: { id: request.investigation_ref.id, revision: request.investigation_ref.revision },
      principal_ref: principal.principal_ref,
      scope_snapshot_ref: scopeRef(scope),
      w1_protocol_version: final.head.protocol_version,
      w1_revision: final.head.revision,
      requested_evidence_grade: payload.evidence_grade,
      external_acquisition: CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.external_acquisition,
      profile_definition_ref: CORPUS_EXPLORATORY_PROFILE_DEFINITION_REF,
      profile_identity_digest: profileResult.identity_digest,
      protocol_profile: profileResult.profile,
      protocol_digest: protocolDigest,
      coverage_denominator: denominatorResult.denominator,
      denominator_identity_digest: denominatorResult.identity_digest,
      denominator_digest: denominatorDigest,
      observed_at: observedAt,
    });
  };
}

/** Strict parser shared by a later FREEZE_EVIDENCE authority reader. */
export function decodeProtocolScopeCheckpoint(bytes: Uint8Array): ProtocolScopeCheckpoint {
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "protocol scope checkpoint exceeds 64 KiB");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "protocol scope checkpoint is not valid JSON", cause); }
  try {
    const parsed = ProtocolScopeCheckpointSchema.parse(value);
    if (canonicalEvidenceJson(parsed) !== new TextDecoder().decode(bytes)) fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "protocol scope checkpoint is not canonical");
    if (!sameRef(parsed.profile_definition_ref, CORPUS_EXPLORATORY_PROFILE_DEFINITION_REF) ||
        parsed.protocol_profile.profile_ref.revision !== 1 ||
        parsed.protocol_profile.profile_ref.id !== `eliotr.research.compiled-profile-${parsed.profile_identity_digest}` ||
        parsed.coverage_denominator.denominator_ref.id !== `eliotr.coverage.compiled-membership-${parsed.denominator_identity_digest}` ||
        parsed.coverage_denominator.denominator_ref.revision !== 1 ||
        parsed.external_acquisition !== CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.external_acquisition) {
      fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "protocol scope checkpoint is not the server-owned corpus profile");
    }
    assertDefinitionSet(parsed.protocol_profile);
    assertDenominatorDefinition(parsed.coverage_denominator);
    return parsed;
  } catch (cause) {
    if (cause instanceof ResearchProtocolFreezeError) throw cause;
    fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "protocol scope checkpoint failed strict validation", cause);
  }
}

export interface ResearchProtocolFreezeReadbackInput {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
}

/**
 * Reads the already-committed stage-0 checkpoint without acquiring a budget or
 * invoking a handler. The D1 receipt and immutable R2 object are both required;
 * decoding bytes alone is never treated as persisted authority.
 */
export async function readFreezeProtocolAndScopeCheckpoint(
  input: ResearchProtocolFreezeReadbackInput,
): Promise<ProtocolScopeCheckpoint> {
  if (input.request.stage !== "FREEZE_PROTOCOL_AND_SCOPE") {
    fail("RESEARCH_PROTOCOL_FREEZE_INPUT_INVALID", "readback requested for another workflow stage");
  }
  const scope = ScopeSnapshotSchema.parse(input.navigation.scope);
  if (input.navigation.access.principal_ref !== input.principal.principal_ref) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "navigation principal differs from workflow principal");
  }
  if (input.request.input_manifest.residency.scope_domain_id !== scope.snapshot_id ||
      input.request.input_manifest.residency.access_domain_id !== input.principal.principal_ref) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "stage input residency is not bound to current navigation authority");
  }
  await input.navigation.current();
  const initial = await input.ledger.read(input.request.investigation_ref.id);
  if (initial === null) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "W1 investigation is unavailable");
  const run = await input.database.prepare(`SELECT operation_id, investigation_id, initial_revision, current_revision,
      principal_ref, credential_generation, deployment_generation, policy_generation, policy_authority_ref,
      scope_snapshot_id, scope_snapshot_revision, initial_manifest_json, state
    FROM research_workflow_run WHERE operation_id = ?1`).bind(input.request.operation_id).first<WorkflowRunBinding>();
  if (run === null || run.credential_generation !== input.navigation.access.credential_generation ||
      run.credential_generation !== input.principal.credential_generation ||
      run.deployment_generation !== input.principal.deployment_generation) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "persisted workflow identity is unavailable or mismatched");
  }
  if (initial.head.principal_ref !== input.principal.principal_ref || initial.head.scope_snapshot_id !== scope.snapshot_id ||
      initial.head.scope_snapshot_revision !== scope.revision || initial.head.status !== "OPEN" || initial.head.lane !== "exploratory" ||
      run.initial_revision !== input.request.investigation_ref.revision || run.state === "CANCELLED") {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "W1 authority is not eligible for protocol scope readback");
  }
  const currentRow = await input.database.prepare("SELECT operation_id FROM research_workflow_current WHERE operation_id = ?1")
    .bind(input.request.operation_id).first<{ readonly operation_id: string }>();
  if (currentRow === null) fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "workflow currentness is unavailable");
  const requestDigest = await textDigest(JSON.stringify(input.request));
  const receipt = await new WorkflowCheckpointStore(input.database).receipt(input.request, requestDigest);
  if (receipt === null || receipt.stage !== "FREEZE_PROTOCOL_AND_SCOPE" || receipt.request_sha256 !== requestDigest) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "committed stage-0 checkpoint receipt is unavailable");
  }
  const manifest = receipt.output_manifest;
  if (manifest.residency.scope_domain_id !== scope.snapshot_id || manifest.residency.access_domain_id !== input.principal.principal_ref) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "checkpoint output residency is not bound to current authority");
  }
  const bytes = await readWorkflowObject(input.bucket, manifest, true);
  const checkpoint = decodeProtocolScopeCheckpoint(bytes);
  assertReadbackBinding(checkpoint, initial.head, run, scope, input.request, input.principal);
  const { profile_ref: _profileRef, ...profileIdentity } = checkpoint.protocol_profile;
  const { denominator_ref: _denominatorRef, ...denominatorIdentity } = checkpoint.coverage_denominator;
  if (await evidenceSha256(profileIdentity) !== checkpoint.profile_identity_digest ||
      await evidenceSha256(denominatorIdentity) !== checkpoint.denominator_identity_digest) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "checkpoint content identity digests do not match its documents");
  }
  const protocolDigest = await evidenceSha256(checkpoint.protocol_profile);
  const denominatorDigest = await evidenceSha256(checkpoint.coverage_denominator);
  if (checkpoint.protocol_digest !== protocolDigest || checkpoint.denominator_digest !== denominatorDigest) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_INVALID", "checkpoint canonical digests do not match its decoded documents");
  }
  await input.navigation.current();
  const final = await input.ledger.read(input.request.investigation_ref.id);
  const finalRun = await input.database.prepare(`SELECT operation_id, investigation_id, initial_revision, current_revision,
      principal_ref, credential_generation, deployment_generation, policy_generation, policy_authority_ref,
      scope_snapshot_id, scope_snapshot_revision, initial_manifest_json, state
    FROM research_workflow_run WHERE operation_id = ?1`).bind(input.request.operation_id).first<WorkflowRunBinding>();
  const finalCurrentRow = await input.database.prepare("SELECT operation_id FROM research_workflow_current WHERE operation_id = ?1")
    .bind(input.request.operation_id).first<{ readonly operation_id: string }>();
  if (final === null || finalRun === null || finalCurrentRow === null || canonicalEvidenceJson(final.head) !== canonicalEvidenceJson(initial.head) ||
      canonicalEvidenceJson(finalRun) !== canonicalEvidenceJson(run)) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "workflow or W1 authority changed during protocol scope readback");
  }
  const observedAt = input.navigation.timestamp();
  if (Date.parse(checkpoint.coverage_denominator.expires_at) <= Date.parse(observedAt)) {
    fail("RESEARCH_PROTOCOL_FREEZE_AUTHORITY_STALE", "protocol scope denominator expired during readback");
  }
  return checkpoint;
}
