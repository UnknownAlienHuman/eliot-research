import { decodeModelRouteDeployment, canonicalJson, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createD1DynamicRouteQualificationProofStore,
  decodeStoredDynamicRouteCandidate,
  readResearchModelSpendPolicy,
  readResearchOwnerSpendPolicyTemplate,
  type ResearchModelSpendPolicy,
  type ResearchOwnerSpendPolicyTemplate,
  type StoredDynamicRouteCandidate,
} from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import {
  readResearchConfigurationStatus,
  type ResearchConfigurationStatus,
} from "./research-configuration-status.js";

const RESEARCH_CONFIGURATION_READINESS_PROTOCOL = "eliotr.research-configuration-readiness.v1" as const;
const RENEWAL_WINDOW_MS = 5 * 60 * 1000;

export type ResearchQualificationReadiness = "current" | "renewal_required" | "unavailable";
export type ResearchRunReadiness = "ready" | "lazy_renewal" | "blocked";
export type ResearchConfigurationReadinessReason =
  | "CONFIGURATION_NOT_READY"
  | "MODEL_TRANSPORT_UNAVAILABLE"
  | "QUALIFICATION_PROOFS_CURRENT"
  | "QUALIFICATION_RENEWAL_AT_RUN"
  | "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED"
  | "QUALIFICATION_UNAVAILABLE";

export interface ResearchConfigurationReadiness {
  readonly protocol: typeof RESEARCH_CONFIGURATION_READINESS_PROTOCOL;
  readonly configuration: ResearchConfigurationStatus["configuration"];
  readonly model_transport: ResearchConfigurationStatus["model_transport"];
  readonly qualification_state: ResearchQualificationReadiness;
  readonly run_readiness: ResearchRunReadiness;
  readonly readiness_reason: ResearchConfigurationReadinessReason;
  /** The installed application route; this is not a provider/model assertion. */
  readonly model_route: string | null;
  readonly qualification_expires_at: string | null;
  readonly missing_fields: readonly string[];
  readonly invalid_fields: readonly string[];
  readonly checked_at: string;
}

type InstalledSpendPolicy = ResearchModelSpendPolicy | ResearchOwnerSpendPolicyTemplate;

interface ActiveCandidateRow {
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly candidate_json: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly staged_at: unknown;
}

interface ProofCheck {
  readonly qualification_state: ResearchQualificationReadiness;
  readonly expires_at: string;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function failure(message: string): never {
  throw new Error(message);
}

function baseResult(
  status: ResearchConfigurationStatus,
  readiness: Omit<ResearchConfigurationReadiness, "protocol" | "configuration" | "model_transport" | "missing_fields" | "invalid_fields" | "checked_at">,
): ResearchConfigurationReadiness {
  return Object.freeze({
    protocol: RESEARCH_CONFIGURATION_READINESS_PROTOCOL,
    configuration: status.configuration,
    model_transport: status.model_transport,
    ...readiness,
    missing_fields: status.missing_fields,
    invalid_fields: status.invalid_fields,
    checked_at: status.checked_at,
  });
}

function installedPolicy(env: Env): InstalledSpendPolicy {
  const raw = env.ELIOTR_MODEL_SPEND_POLICY_JSON;
  const provenance = env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF;
  if (!hasText(raw) || !hasText(provenance)) failure("installed spend policy is unavailable");
  let protocol: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    protocol = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).protocol : undefined;
  } catch {
    failure("installed spend policy is invalid");
  }
  return protocol === "eliotr.research-owner-spend-template.v1"
    ? readResearchOwnerSpendPolicyTemplate(raw, provenance)
    : readResearchModelSpendPolicy(raw, provenance);
}

function installedProfileDeployment(env: Env): ModelRouteDeployment {
  const raw = env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON;
  if (!hasText(raw)) failure("installed model profile is unavailable");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { failure("installed model profile is invalid"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) failure("installed model profile is invalid");
  return decodeModelRouteDeployment((parsed as Record<string, unknown>).deployment);
}

function activeCandidateQuery(route: ModelRouteDeployment): string {
  return "SELECT c.candidate_ref,c.candidate_sha256,c.candidate_json,c.route_ref,c.route_version,c.staged_at " +
    "FROM dynamic_route_active_generation a JOIN dynamic_route_candidate c ON " +
    "c.candidate_ref=a.candidate_ref AND c.candidate_sha256=a.candidate_sha256 " +
    "AND c.route_ref=a.route_ref AND c.route_version=a.route_version " +
    "WHERE a.route_ref=?1 AND a.route_version=?2 LIMIT 1";
}

async function readActiveCandidate(
  database: D1Database,
  route: ModelRouteDeployment,
): Promise<StoredDynamicRouteCandidate> {
  const row = await database.prepare(activeCandidateQuery(route))
    .bind(route.route_ref, route.route_version)
    .first<ActiveCandidateRow>();
  if (row === null) failure("active model route candidate is unavailable");
  const candidate = await decodeStoredDynamicRouteCandidate(
    row,
    "active readiness candidate",
    "DYNAMIC_ROUTE_PROMOTION_CONFLICT",
  );
  if (candidate.row.route_ref !== route.route_ref || candidate.row.route_version !== route.route_version ||
      candidate.candidate.qualification_tier !== "LIVE" ||
      canonicalJson(candidate.candidate.deployment) !== canonicalJson(route)) {
    failure("active model route candidate is not bound to the installed route");
  }
  return candidate;
}

async function readRouteProof(
  database: D1Database,
  proofStore: ReturnType<typeof createD1DynamicRouteQualificationProofStore>,
  route: ModelRouteDeployment,
): Promise<ProofCheck> {
  const candidate = await readActiveCandidate(database, route);
  const proof = await proofStore.readLatest({
    route_ref: candidate.row.route_ref,
    route_version: candidate.row.route_version,
    candidate_ref: candidate.row.candidate_ref,
    candidate_sha256: candidate.sha256,
  });
  const expiresAt = proof?.qualification.expires_at ?? candidate.candidate.qualification_expires_at;
  const expires = Date.parse(expiresAt);
  if (!Number.isSafeInteger(expires)) failure("qualification expiry is invalid");
  return Object.freeze({
    qualification_state: expires > Date.now() + RENEWAL_WINDOW_MS ? "current" : "renewal_required",
    expires_at: expiresAt,
  });
}

function ownerPolicyMatches(policy: InstalledSpendPolicy, env: Env, owner: Pick<AuthenticatedRequestContext, "principal_ref" | "credential_generation">): boolean {
  if (policy.principal_ref !== owner.principal_ref || policy.client_class !== "owner_pwa" ||
      policy.deployment_generation !== env.DEPLOYMENT_GENERATION) return false;
  return !("credential_generation" in policy) || policy.credential_generation === owner.credential_generation;
}

/**
 * Reads installed configuration and the two persisted qualification proofs.
 * This never renews a proof, calls a provider, or performs a model request.
 */
export async function readResearchConfigurationReadiness(
  env: Env,
  owner: Pick<AuthenticatedRequestContext, "principal_ref" | "credential_generation" | "client_class">,
): Promise<ResearchConfigurationReadiness> {
  const status = readResearchConfigurationStatus(env, owner);
  if (status.configuration !== "present") {
    return baseResult(status, {
      qualification_state: "unavailable",
      run_readiness: "blocked",
      readiness_reason: "CONFIGURATION_NOT_READY",
      model_route: null,
      qualification_expires_at: null,
    });
  }
  if (status.model_transport !== "available") {
    return baseResult(status, {
      qualification_state: "unavailable",
      run_readiness: "blocked",
      readiness_reason: "MODEL_TRANSPORT_UNAVAILABLE",
      model_route: null,
      qualification_expires_at: null,
    });
  }

  let policy: InstalledSpendPolicy;
  let profileDeployment: ModelRouteDeployment;
  try {
    policy = installedPolicy(env);
    profileDeployment = installedProfileDeployment(env);
  } catch {
    return baseResult(status, {
      qualification_state: "unavailable",
      run_readiness: "blocked",
      readiness_reason: "QUALIFICATION_UNAVAILABLE",
      model_route: null,
      qualification_expires_at: null,
    });
  }
  const synthesis = policy.rules.find((rule) => rule.stage === "SYNTHESIZE");
  const audit = policy.rules.find((rule) => rule.stage === "AUDIT_CLAIMS");
  if (synthesis === undefined || audit === undefined || !ownerPolicyMatches(policy, env, owner) ||
      canonicalJson(profileDeployment) !== canonicalJson(synthesis.deployment) ||
      canonicalJson(synthesis.deployment) === canonicalJson(audit.deployment)) {
    return baseResult(status, {
      qualification_state: "unavailable",
      run_readiness: "blocked",
      readiness_reason: "QUALIFICATION_UNAVAILABLE",
      model_route: synthesis?.deployment.route_ref ?? null,
      qualification_expires_at: null,
    });
  }

  const proofStore = createD1DynamicRouteQualificationProofStore(env.CORE_DB, {
    now: () => new Date().toISOString(),
  });
  let proofs: readonly ProofCheck[];
  try {
    proofs = await Promise.all([
      readRouteProof(env.CORE_DB, proofStore, synthesis.deployment),
      readRouteProof(env.CORE_DB, proofStore, audit.deployment),
    ]);
  } catch {
    return baseResult(status, {
      qualification_state: "unavailable",
      run_readiness: "blocked",
      readiness_reason: "QUALIFICATION_UNAVAILABLE",
      model_route: synthesis.deployment.route_ref,
      qualification_expires_at: null,
    });
  }

  const expiresAt = proofs.map((proof) => proof.expires_at)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
  const renewalRequired = proofs.some((proof) => proof.qualification_state === "renewal_required");
  if (!renewalRequired) {
    return baseResult(status, {
      qualification_state: "current",
      run_readiness: "ready",
      readiness_reason: "QUALIFICATION_PROOFS_CURRENT",
      model_route: synthesis.deployment.route_ref,
      qualification_expires_at: expiresAt,
    });
  }
  if (!hasText(env.ELIOTR_MODEL_GATEWAY_READ_TOKEN)) {
    return baseResult(status, {
      qualification_state: "renewal_required",
      run_readiness: "blocked",
      readiness_reason: "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
      model_route: synthesis.deployment.route_ref,
      qualification_expires_at: expiresAt,
    });
  }
  return baseResult(status, {
    qualification_state: "renewal_required",
    run_readiness: "lazy_renewal",
    readiness_reason: "QUALIFICATION_RENEWAL_AT_RUN",
    model_route: synthesis.deployment.route_ref,
    qualification_expires_at: expiresAt,
  });
}
