import {
  createD1DynamicRouteQualificationProofStore,
  decodeStoredDynamicRouteCandidate,
  createPersistedModelProfileBindingProducer,
  createResearchModelQualificationRenewal,
  createResearchOwnerQualificationRenewalAssembler,
  type ResearchEvidencePack,
  type ResearchModelGatewayRuntimeConfig,
  type ResearchOwnerQualificationRenewalAssembler,
  type ResearchOwnerQualificationRenewalAssembly,
  type ResearchOwnerQualificationRenewalAssemblerDependencies,
  type ResearchModelQualificationRenewalResult,
  type StoredDynamicRouteCandidate,
  type ResearchQualificationPromptConfig,
  type ReferenceManifestPolicyProfile,
} from "@eliotr/cloudflare-research";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { WorkflowCheckpointError, type WorkflowObject, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  parseResearchSemanticConfiguration,
  researchSemanticPromptParameters,
  type ResearchSemanticConfiguration,
} from "./research-semantic-configuration-schema.js";
import { ResearchOwnerSpendPolicyError, resolveResearchOwnerSpendPolicy } from "./research-owner-spend-policy.js";

const RENEWAL_MARKER = "LAZY_OWNER_V1" as const;
const RENEWAL_WINDOW_MS = 5 * 60 * 1000;
const CANDIDATE_COLUMNS = "c.candidate_ref,c.candidate_sha256,c.candidate_json,c.route_ref,c.route_version,c.staged_at";

export type ResearchQualificationRenewalMarker = typeof RENEWAL_MARKER;

export class ResearchQualificationRenewalError extends Error {
  public readonly code:
    | "RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED"
    | "RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE"
    | "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE"
    | "RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE";
  public readonly retryable: boolean;

  public constructor(
    code: ResearchQualificationRenewalError["code"],
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchQualificationRenewalError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(
  code: ResearchQualificationRenewalError["code"],
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchQualificationRenewalError(code, message, retryable, cause);
}

function canonicalNow(): string {
  return new Date().toISOString();
}

function canonicalMilliseconds(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", `${label} is not canonical UTC time`);
  }
  return milliseconds;
}

function requiredText(
  value: string | undefined,
  label: string,
  code: ResearchQualificationRenewalError["code"] = "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    if (code === "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE") {
      throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_MISSING");
    }
    fail(code, `${label} is not installed`);
  }
  return value;
}

interface ActiveCandidateRow {
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly candidate_json: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly staged_at: unknown;
}

async function readActiveCandidate(database: D1Database, routeRef: string): Promise<StoredDynamicRouteCandidate> {
  let row: ActiveCandidateRow | null;
  try {
    row = await database.prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM dynamic_route_active_generation a ` +
      "JOIN dynamic_route_candidate c ON c.candidate_ref=a.candidate_ref AND " +
      "c.candidate_sha256=a.candidate_sha256 AND c.route_ref=a.route_ref AND c.route_version=a.route_version " +
      "WHERE a.route_ref=?1 LIMIT 1",
    ).bind(routeRef).first<ActiveCandidateRow>();
  } catch {
    throw new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
  }
  if (row === null) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "active qualification candidate is unavailable");
  }
  try {
    const candidate = await decodeStoredDynamicRouteCandidate(
      row as StoredDynamicRouteCandidate["row"],
      "active qualification candidate",
      "DYNAMIC_ROUTE_PROMOTION_CONFLICT",
    );
    if (candidate.row.route_ref !== routeRef) {
      fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "active qualification candidate targets another route");
    }
    return candidate;
  } catch (cause) {
    if (cause instanceof ResearchQualificationRenewalError) throw cause;
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
}

function routeAuthority(database: D1Database) {
  return Object.freeze({
    async resolve(routeRef: string): Promise<unknown | null> {
      const candidate = await readActiveCandidate(database, routeRef);
      return candidate.candidate.deployment;
    },
  });
}

function authorityStage(
  head: ResearchQualificationRenewalHead,
  navigation: NavigationReadAuthority,
): Parameters<ReturnType<typeof createPersistedModelProfileBindingProducer>["resolve"]>[0] {
  return Object.freeze({
    model_profile_ref: head.model_profile_ref,
    policy_generation: head.policy_generation,
    policy_authority_ref: head.policy_authority_ref,
    deployment_generation: head.deployment_generation,
    scope_snapshot_ref: { id: head.scope_snapshot_id, revision: head.scope_snapshot_revision },
    scope_snapshot_digest: navigation.scope.digest,
  });
}

function withoutContentDigest(
  manifest: WorkflowObject,
): ResearchQualificationPromptConfig["manifest_residency_template"] {
  const { content_digest: _contentDigest, ...template } = manifest.residency;
  void _contentDigest;
  if (template.scope_domain_id.length === 0 || template.access_domain_id.length === 0) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "workflow residency is not owner-bound");
  }
  return Object.freeze(template);
}

function ownerAccess(principal: WorkflowPrincipal): ResearchQualificationPromptConfig["access"] {
  return Object.freeze({
    principal_ref: principal.principal_ref,
    client_class: "owner_pwa" as const,
    credential_generation: principal.credential_generation,
  });
}

function promptConfig(
  config: ResearchSemanticConfiguration,
  stage: "SYNTHESIZE" | "AUDIT_CLAIMS",
  profilePolicy: ReferenceManifestPolicyProfile,
  profileDefinitionRef: ResearchQualificationPromptConfig["manifest_ref"],
  access: ResearchQualificationPromptConfig["access"],
  residency: ResearchQualificationPromptConfig["manifest_residency_template"],
): ResearchQualificationPromptConfig {
  const source = stage === "SYNTHESIZE" ? config.synthesis : config.audit;
  const parameters = researchSemanticPromptParameters(source.trusted_parameters);
  const { stop, ...parametersWithoutStop } = parameters;
  return Object.freeze({
    access,
    policy: Object.freeze({
      allowed_tool_definition_refs: [...profilePolicy.allowed_tool_definition_refs],
      allowed_verifier_refs: [...profilePolicy.allowed_verifier_refs],
      permitted_anchor_and_precision_ceilings: [...profilePolicy.permitted_anchor_and_precision_ceilings],
      provider_and_policy_generations: { ...profilePolicy.provider_and_policy_generations },
      ...(profilePolicy.stale_or_revoked_entries === undefined ? {} : {
        stale_or_revoked_entries: [...profilePolicy.stale_or_revoked_entries],
      }),
      permitted_acquisition_or_expansion_routes: [...profilePolicy.permitted_acquisition_or_expansion_routes],
      disclosure_ceiling: profilePolicy.disclosure_ceiling,
      allowed_use: [...profilePolicy.allowed_use],
      expires_at: profilePolicy.expires_at,
    }),
    manifest_ref: profileDefinitionRef,
    manifest_residency_template: residency,
    trusted_parameters: Object.freeze({
      ...parametersWithoutStop,
      ...(stop === undefined ? {} : { stop: typeof stop === "string" ? stop : [...stop] }),
    }),
    request_timeout_ms: source.request_timeout_ms,
  });
}

export interface ResearchQualificationRenewalHead {
  readonly lane: "confirmatory" | "exploratory" | "mixed_with_declared_split";
  readonly deployment_generation: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly investigation_id: string;
  readonly model_profile_ref: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly goal: string;
}

export interface ResolvedResearchQualificationSemanticConfiguration {
  readonly config_json: string;
  readonly revision_ref: string | null;
  readonly config_sha256: string;
}

export interface ResearchQualificationRenewalServiceInput {
  readonly operation_id: string;
  readonly investigation: { readonly head: ResearchQualificationRenewalHead };
  readonly principal: WorkflowPrincipal;
  readonly navigation: NavigationReadAuthority;
  readonly initial_manifest: WorkflowObject;
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly deployment_generation: string;
  readonly load_semantic: () => Promise<ResolvedResearchQualificationSemanticConfiguration>;
  readonly spend_policy: { readonly raw: string | undefined; readonly provenance: string | undefined };
  readonly model_profile: { readonly raw: string | undefined; readonly provenance_ref: string | undefined };
  /** Composition-root adapters retain Env, held-scope retrieval and model credentials. */
  readonly retrieve_evidence: (input: {
    readonly navigation: NavigationReadAuthority;
    readonly goal: string;
    readonly operation_id: string;
  }) => Promise<ResearchEvidencePack>;
  readonly model_gateway: () => ResearchModelGatewayRuntimeConfig;
  readonly control_plane_for: (
    candidate: StoredDynamicRouteCandidate,
  ) => Promise<ResearchOwnerQualificationRenewalAssemblerDependencies["control_plane"]>;
}

async function renewStage(
  input: ResearchQualificationRenewalServiceInput,
  stageInput: {
    readonly stage: "SYNTHESIZE" | "AUDIT_CLAIMS";
    readonly candidate: StoredDynamicRouteCandidate;
    readonly max_input_bytes: number;
    readonly max_output_bytes: number;
    readonly evidence_pack: ResearchEvidencePack;
    readonly config: ResearchSemanticConfiguration;
    readonly profile: Awaited<ReturnType<ReturnType<typeof createPersistedModelProfileBindingProducer>["resolve"]>>;
    readonly gateway: ResearchModelGatewayRuntimeConfig;
  },
): Promise<ResearchModelQualificationRenewalResult> {
  const controlPlane = await input.control_plane_for(stageInput.candidate);
  const prompt = promptConfig(
    stageInput.config,
    stageInput.stage,
    stageInput.profile.policy,
    stageInput.profile.binding.definition_ref,
    ownerAccess(input.principal),
    withoutContentDigest(input.initial_manifest),
  );
  const assembler: ResearchOwnerQualificationRenewalAssembler = createResearchOwnerQualificationRenewalAssembler({
    database: input.database,
    search_database: input.search_database,
    evidence_bucket: input.evidence_bucket,
    work_bucket: input.work_bucket,
    control_plane: controlPlane,
    prompt,
    max_input_bytes: stageInput.max_input_bytes,
    max_output_bytes: stageInput.max_output_bytes,
    now: canonicalNow,
  });
  const assembly: ResearchOwnerQualificationRenewalAssembly = await assembler.assemble({
    candidate_ref: stageInput.candidate.row.candidate_ref,
    candidate_sha256: stageInput.candidate.sha256,
    renewal_ref: `research-qualification-renewal-${input.operation_id}-${stageInput.stage.toLowerCase()}`,
    evidence_pack: stageInput.evidence_pack,
  });
  const renewed = createResearchModelQualificationRenewal({
    database: input.database,
    work_bucket: input.work_bucket,
    gateway: stageInput.gateway,
    control_plane: controlPlane,
    prompt_compiler: assembly.prompt_compiler,
    now: canonicalNow,
  });
  return renewed.renew({
    candidate_ref: assembly.candidate_ref,
    candidate_sha256: assembly.candidate_sha256,
    fresh: assembly.fresh,
    expected_latest: assembly.expected_latest,
  });
}

/** Renewal stays lazy: no evidence read, credential loading or model probe occurs when proofs are fresh. */
export async function createResearchQualificationRenewal(
  input: ResearchQualificationRenewalServiceInput,
): Promise<void> {
  const { investigation, navigation, principal } = input;
  if (investigation.head.lane !== "exploratory" || principal.deployment_generation !== input.deployment_generation) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "research qualification authority is not current");
  }
  if (navigation.access.principal_ref !== principal.principal_ref ||
      navigation.access.credential_generation !== principal.credential_generation ||
      navigation.scope.snapshot_id !== investigation.head.scope_snapshot_id ||
      navigation.scope.revision !== investigation.head.scope_snapshot_revision) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "research qualification scope is not current");
  }
  const semantic = await input.load_semantic();
  const config = parseResearchSemanticConfiguration(semantic.config_json);
  const access = ownerAccess(principal);
  const grant = await navigation.current();
  const policy = (() => {
    try {
      return resolveResearchOwnerSpendPolicy({
        raw: input.spend_policy.raw,
        provenance: requiredText(input.spend_policy.provenance, "model spend policy provenance"),
        access,
        deployment_generation: principal.deployment_generation,
        policy_generation: investigation.head.policy_generation,
        policy_authority_ref: investigation.head.policy_authority_ref,
        scope_expires_at: navigation.scope.expires_at,
        authorization: grant,
      }).policy;
    } catch (cause) {
      if (cause instanceof WorkflowCheckpointError) throw cause;
      if (cause instanceof ResearchOwnerSpendPolicyError && cause.code === "INVALID") {
        throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_INVALID");
      }
      fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "installed model spend policy is not current", false, cause);
    }
  })();
  const synthesisRule = policy.rules.find((rule) => rule.stage === "SYNTHESIZE");
  const auditRule = policy.rules.find((rule) => rule.stage === "AUDIT_CLAIMS");
  if (synthesisRule === undefined || auditRule === undefined) {
    throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_INVALID");
  }
  const profile = createPersistedModelProfileBindingProducer({
    config: {
      raw: requiredText(input.model_profile.raw, "model profile definition"),
      provenance_ref: requiredText(input.model_profile.provenance_ref, "model profile provenance"),
    },
    authority: {
      database: input.database,
      navigation,
      operation_id: input.operation_id,
      investigation_id: investigation.head.investigation_id,
      principal,
    },
    routeAuthority: routeAuthority(input.database),
    now: () => Date.now(),
  });
  const resolvedProfile = await profile.resolve(authorityStage(investigation.head, navigation));
  if (canonicalJson(resolvedProfile.deployment) !== canonicalJson(synthesisRule.deployment)) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "synthesis route differs from the installed model profile");
  }
  const proofStore = createD1DynamicRouteQualificationProofStore(input.database, { now: canonicalNow });
  const candidates = [
    { stage: "SYNTHESIZE" as const, route: synthesisRule.deployment, rule: synthesisRule },
    { stage: "AUDIT_CLAIMS" as const, route: auditRule.deployment, rule: auditRule },
  ];
  const pending: Array<{
    readonly stage: "SYNTHESIZE" | "AUDIT_CLAIMS";
    readonly candidate: StoredDynamicRouteCandidate;
    readonly rule: typeof synthesisRule;
  }> = [];
  const now = Date.parse(canonicalNow());
  for (const item of candidates) {
    const candidate = await readActiveCandidate(input.database, item.route.route_ref);
    if (canonicalJson(candidate.candidate.deployment) !== canonicalJson(item.route)) {
      fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", `${item.stage} active candidate deployment is not installed`);
    }
    const latest = await proofStore.readLatest({
      route_ref: candidate.row.route_ref,
      route_version: candidate.row.route_version,
      candidate_ref: candidate.row.candidate_ref,
      candidate_sha256: candidate.sha256,
    });
    const expiresAt = latest?.qualification.expires_at ?? candidate.candidate.qualification_expires_at;
    if (canonicalMilliseconds(expiresAt, `${item.stage} qualification expiry`) <= now + RENEWAL_WINDOW_MS) {
      pending.push({ stage: item.stage, candidate, rule: item.rule });
    }
  }
  if (pending.length === 0) return;
  await navigation.current();
  const evidencePack = await input.retrieve_evidence({
    navigation,
    goal: typeof investigation.head.goal === "string" ? investigation.head.goal : "",
    operation_id: input.operation_id,
  });
  if (evidencePack.resolved_evidence.length === 0) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE", "owner evidence query returned no resolved evidence");
  }
  const gateway = input.model_gateway();
  for (const item of pending) {
    await renewStage(input, {
      stage: item.stage,
      candidate: item.candidate,
      evidence_pack: evidencePack,
      config,
      profile: resolvedProfile,
      gateway,
      max_input_bytes: item.rule.max_input_bytes,
      max_output_bytes: item.rule.max_output_bytes,
    });
  }
  await navigation.current();
}

export const RESEARCH_QUALIFICATION_RENEWAL_MARKER = RENEWAL_MARKER;
