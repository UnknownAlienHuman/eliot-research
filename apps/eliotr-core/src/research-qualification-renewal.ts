import {
  DYNAMIC_ROUTE_GATEWAY_ID,
  createCloudflareDynamicRouteRestControlPlane,
  validateModelGatewayToken,
  type DynamicRouteRestBinding,
  type DynamicRouteRestResponse,
} from "@eliotr/cloudflare-ai";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  createD1DynamicRouteRestBindingStore,
  createD1DynamicRouteQualificationProofStore,
  decodeStoredDynamicRouteCandidate,
  createPersistedModelProfileBindingProducer,
  createResearchModelQualificationRenewal,
  createResearchOwnerQualificationRenewalAssembler,
  type ResearchModelQualificationRenewalResult,
  type ReferenceManifestPolicyProfile,
  type ResearchModelGatewayBinding,
  type ResearchModelGatewayRuntimeConfig,
  type ResearchOwnerQualificationRenewalAssembler,
  type ResearchOwnerQualificationRenewalAssembly,
  type StoredDynamicRouteCandidate,
} from "@eliotr/cloudflare-research";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { LedgerHead, LedgerSnapshot } from "@eliotr/research";
import { retrieveWithHeldScope } from "./research-retrieval-composition.js";
import { SERVER_RETRIEVAL_SCOPE_PROFILE } from "./research-stage-handlers.js";
import {
  parseResearchSemanticConfiguration,
  researchSemanticPromptParameters,
} from "./research-semantic-server.js";
import { readResearchSemanticConfiguration, type Env } from "./env.js";
import { resolveResearchOwnerSpendPolicy } from "./research-owner-spend-policy.js";
import type { WorkflowObject, WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import type { ResearchQualificationPromptConfig } from "@eliotr/cloudflare-research";

const RENEWAL_MARKER = "LAZY_OWNER_V1" as const;
const RENEWAL_WINDOW_MS = 5 * 60 * 1000;
const RETRIEVAL_DEADLINE_MS = 30_000;
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

async function readActiveCandidate(
  database: D1Database,
  routeRef: string,
): Promise<StoredDynamicRouteCandidate> {
  let row: ActiveCandidateRow | null;
  try {
    row = await database.prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM dynamic_route_active_generation a ` +
      "JOIN dynamic_route_candidate c ON c.candidate_ref=a.candidate_ref AND " +
      "c.candidate_sha256=a.candidate_sha256 AND c.route_ref=a.route_ref AND c.route_version=a.route_version " +
      "WHERE a.route_ref=?1 LIMIT 1",
    ).bind(routeRef).first<ActiveCandidateRow>();
  } catch (cause) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "active qualification candidate could not be read", true, cause);
  }
  if (row === null) fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "active qualification candidate is unavailable");
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
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "active qualification candidate is malformed", false, cause);
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
  head: LedgerHead,
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
  config: ReturnType<typeof parseResearchSemanticConfiguration>,
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

function modelGateway(env: Env): ResearchModelGatewayRuntimeConfig {
  const token = env.ELIOTR_MODEL_GATEWAY_TOKEN;
  if (typeof token === "string" && token.trim() !== "") {
    try { validateModelGatewayToken(token); }
    catch (cause) { fail("RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE", "model execution gateway credential is invalid", false, cause); }
    return Object.freeze({
      reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
      gateway_token: token,
    });
  }
  const binding = env.AI as Partial<ResearchModelGatewayBinding> | undefined;
  if (typeof binding?.gateway !== "function") {
    fail("RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE", "model execution gateway is not installed");
  }
  return Object.freeze({
    reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
    ai_gateway_binding: binding as ResearchModelGatewayBinding,
  });
}

async function controlPlaneFor(
  env: Env,
  candidate: Awaited<ReturnType<typeof readActiveCandidate>>,
) {
  const readToken = requiredText(
    env.ELIOTR_MODEL_GATEWAY_READ_TOKEN,
    "ELIOTR_MODEL_GATEWAY_READ_TOKEN",
    "RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
  );
  const bindings = createD1DynamicRouteRestBindingStore(env.CORE_DB);
  let rawBinding: unknown | null;
  try {
    rawBinding = await bindings.get(candidate.candidate.provider_route_id);
  } catch (cause) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "dynamic route binding readback is unavailable", true, cause);
  }
  if (rawBinding === null || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "dynamic route binding is unavailable");
  }
  const binding = rawBinding as Partial<DynamicRouteRestBinding>;
  if (typeof binding.account_id !== "string" || binding.gateway_id !== DYNAMIC_ROUTE_GATEWAY_ID ||
      binding.provider_route_id !== candidate.candidate.provider_route_id) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "dynamic route binding is not exact");
  }
  const fetchPort = Object.freeze({
    async fetch(url: string, init: { readonly method: "GET" | "POST"; readonly headers: Readonly<Record<string, string>>; readonly body?: string }): Promise<DynamicRouteRestResponse> {
      let response: Response;
      try {
        response = await globalThis.fetch(url, { ...init, redirect: "error" });
      } catch (cause) {
        fail("RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE", "dynamic route readback transport failed", true, cause);
      }
      return response as unknown as DynamicRouteRestResponse;
    },
  });
  return createCloudflareDynamicRouteRestControlPlane({
    account_id: binding.account_id,
    fetch: fetchPort,
    credentials: { readApiToken: async () => readToken },
    bindings,
  });
}

async function freshEvidence(
  env: Env,
  navigation: NavigationReadAuthority,
  head: LedgerHead,
  operationId: string,
): Promise<Awaited<ReturnType<typeof retrieveWithHeldScope>>["evidence_pack"]> {
  if (typeof head.goal !== "string" || head.goal.length === 0) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "workflow question is unavailable");
  }
  try {
    const result = await retrieveWithHeldScope(env, {
      access: navigation.access,
      scope_snapshot: navigation.scope,
      raw_query: head.goal,
      product: "FAST_SEARCH",
      literals: [],
      requested_limit: SERVER_RETRIEVAL_SCOPE_PROFILE.max_results,
      deadline_ms: Date.now() + RETRIEVAL_DEADLINE_MS,
      idempotency_key: `research-qualification-evidence-${operationId}`,
      signal: new Request("https://workflow.internal/qualification-evidence").signal,
      profile: SERVER_RETRIEVAL_SCOPE_PROFILE,
    });
    if (result.evidence_pack.resolved_evidence.length === 0) {
      fail("RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE", "owner evidence query returned no resolved evidence");
    }
    return result.evidence_pack;
  } catch (cause) {
    if (cause instanceof ResearchQualificationRenewalError) throw cause;
    fail("RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE", "owner evidence query failed", true, cause);
  }
}

async function renewStage(
  env: Env,
  input: {
    readonly stage: "SYNTHESIZE" | "AUDIT_CLAIMS";
    readonly candidate: Awaited<ReturnType<typeof readActiveCandidate>>;
    readonly max_input_bytes: number;
    readonly max_output_bytes: number;
    readonly evidence_pack: Awaited<ReturnType<typeof freshEvidence>>;
    readonly config: ReturnType<typeof parseResearchSemanticConfiguration>;
    readonly profile: Awaited<ReturnType<ReturnType<typeof createPersistedModelProfileBindingProducer>["resolve"]>>;
    readonly manifest: WorkflowObject;
    readonly principal: WorkflowPrincipal;
    readonly operation_id: string;
    readonly gateway: ReturnType<typeof modelGateway>;
  },
): Promise<ResearchModelQualificationRenewalResult> {
  const controlPlane = await controlPlaneFor(env, input.candidate);
  const prompt = promptConfig(
    input.config,
    input.stage,
    input.profile.policy,
    input.profile.binding.definition_ref,
    ownerAccess(input.principal),
    withoutContentDigest(input.manifest),
  );
  const assembler: ResearchOwnerQualificationRenewalAssembler = createResearchOwnerQualificationRenewalAssembler({
    database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    work_bucket: env.WORK_BUCKET,
    control_plane: controlPlane,
    prompt,
    max_input_bytes: input.max_input_bytes,
    max_output_bytes: input.max_output_bytes,
    now: canonicalNow,
  });
  const assembly: ResearchOwnerQualificationRenewalAssembly = await assembler.assemble({
    candidate_ref: input.candidate.row.candidate_ref,
    candidate_sha256: input.candidate.sha256,
    renewal_ref: `research-qualification-renewal-${input.operation_id}-${input.stage.toLowerCase()}`,
    evidence_pack: input.evidence_pack,
  });
  const renewed = createResearchModelQualificationRenewal({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    gateway: input.gateway,
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

export interface ResearchQualificationRenewalRunInput {
  readonly operation_id: string;
  readonly investigation: LedgerSnapshot;
  readonly principal: WorkflowPrincipal;
  readonly navigation: NavigationReadAuthority;
  readonly initial_manifest: WorkflowObject;
}

/**
 * Durable first-step owner qualification renewal. It reads both latest proofs
 * before touching the dedicated route-read credential or running retrieval.
 * The Workflow caller wraps this in one step so a 30-second launch request is
 * never held open by the possible two provider probes.
 */
export async function renewResearchQualifications(
  env: Env,
  input: ResearchQualificationRenewalRunInput,
): Promise<void> {
  const { investigation, navigation, principal } = input;
  if (investigation.head.lane !== "exploratory" || principal.deployment_generation !== env.DEPLOYMENT_GENERATION) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "research qualification authority is not current");
  }
  if (navigation.access.principal_ref !== principal.principal_ref ||
      navigation.access.credential_generation !== principal.credential_generation ||
      navigation.scope.snapshot_id !== investigation.head.scope_snapshot_id ||
      navigation.scope.revision !== investigation.head.scope_snapshot_revision) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "research qualification scope is not current");
  }
  const configRaw = readResearchSemanticConfiguration(env);
  const config = (() => {
    try { return parseResearchSemanticConfiguration(requiredText(configRaw, "research semantic configuration")); }
    catch (cause) { fail("RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE", "research semantic configuration is invalid", false, cause); }
  })();
  const access = ownerAccess(principal);
  const grant = await navigation.current();
  const policy = (() => {
    try {
      return resolveResearchOwnerSpendPolicy({
        raw: env.ELIOTR_MODEL_SPEND_POLICY_JSON,
        provenance: requiredText(env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF, "model spend policy provenance"),
        access,
        deployment_generation: principal.deployment_generation,
        policy_generation: investigation.head.policy_generation,
        policy_authority_ref: investigation.head.policy_authority_ref,
        scope_expires_at: navigation.scope.expires_at,
        authorization: grant,
      }).policy;
    } catch (cause) {
      fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "installed model spend policy is not current", false, cause);
    }
  })();
  const synthesisRule = policy.rules.find((rule) => rule.stage === "SYNTHESIZE");
  const auditRule = policy.rules.find((rule) => rule.stage === "AUDIT_CLAIMS");
  if (synthesisRule === undefined || auditRule === undefined) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE", "installed model spend policy has no synthesis/audit routes");
  }
  const profile = createPersistedModelProfileBindingProducer({
    config: {
      raw: requiredText(env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON, "model profile definition"),
      provenance_ref: requiredText(env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF, "model profile provenance"),
    },
    authority: {
      database: env.CORE_DB,
      navigation,
      operation_id: input.operation_id,
      investigation_id: investigation.head.investigation_id,
      principal,
    },
    routeAuthority: routeAuthority(env.CORE_DB),
    now: () => Date.now(),
  });
  const resolvedProfile = await profile.resolve(authorityStage(investigation.head, navigation));
  if (canonicalJson(resolvedProfile.deployment) !== canonicalJson(synthesisRule.deployment)) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "synthesis route differs from the installed model profile");
  }
  const proofStore = createD1DynamicRouteQualificationProofStore(env.CORE_DB, { now: canonicalNow });
  const candidates = [
    { stage: "SYNTHESIZE" as const, route: synthesisRule.deployment, rule: synthesisRule },
    { stage: "AUDIT_CLAIMS" as const, route: auditRule.deployment, rule: auditRule },
  ];
  const pending: Array<{
    readonly stage: "SYNTHESIZE" | "AUDIT_CLAIMS";
    readonly candidate: Awaited<ReturnType<typeof readActiveCandidate>>;
    readonly rule: typeof synthesisRule;
  }> = [];
  const now = Date.parse(canonicalNow());
  for (const item of candidates) {
    const candidate = await readActiveCandidate(env.CORE_DB, item.route.route_ref);
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
  const evidencePack = await freshEvidence(env, navigation, investigation.head, input.operation_id);
  const gateway = modelGateway(env);
  for (const item of pending) {
    await renewStage(env, {
      stage: item.stage,
      candidate: item.candidate,
      evidence_pack: evidencePack,
      config,
      profile: resolvedProfile,
      manifest: input.initial_manifest,
      principal,
      operation_id: input.operation_id,
      gateway,
      max_input_bytes: item.rule.max_input_bytes,
      max_output_bytes: item.rule.max_output_bytes,
    });
  }
  await navigation.current();
}

export const RESEARCH_QUALIFICATION_RENEWAL_MARKER = RENEWAL_MARKER;
