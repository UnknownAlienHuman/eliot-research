import { decodeModelRouteDeployment, canonicalJson, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createD1ModelGatewayDeploymentRegistry,
  createD1DynamicRouteQualificationProofStore,
  decodeStoredDynamicRouteCandidate,
  readResearchModelSpendPolicy,
  readResearchOwnerSpendPolicyTemplate,
  type ResearchModelSpendPolicy,
  type ResearchOwnerSpendPolicyTemplate,
  type StoredDynamicRouteCandidate,
} from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type {
  ProviderNativeModelAuthorityPort,
  ProviderNativeModelCatalogV2AuthorityPort,
} from "@eliotr/cloudflare-native-models";
import type { ResearchRunModelSelection } from "./research-run-model-selection-codec.js";
import {
  captureResearchBranchQueryBudgetSelection,
  branchQueryBudgetSelectionMatchesRun,
  type SelectedResearchProjectConfigurationProvenance,
  type ResearchBranchQueryBudgetSelection,
} from "./research-branch-query-budget-selection.js";
import { RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON_KEY } from "./research-branch-query-budget-selection.js";
import {
  readResearchConfigurationStatus,
  type ResearchConfigurationRuntimeValues,
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
  | "QUALIFICATION_SELECTION_REFRESH_REQUIRED"
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

export const RESEARCH_CONFIGURATION_METHOD_READINESS_PROTOCOL =
  "eliotr.research-configuration-method-readiness.v1" as const;

export interface ResearchConfigurationMethodReadinessPin {
  readonly configuration_project_id: string;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly selection_revision: number;
}

export type EvidenceReviewHandlerGeneration = "V7" | "V9";
export type EvidenceReviewUnavailableReason = "CURRENT_SELECTION_REQUIRED" | "MODEL_READINESS_UNAVAILABLE" |
  "STAGE_BINDINGS_UNAVAILABLE" | "V9_BRANCH_BUDGET_UNAVAILABLE" | "V9_MANAGED_SEARCH_UNAVAILABLE";
export interface EvidenceReviewMethodDecision {
  readonly handler_generation: EvidenceReviewHandlerGeneration | null;
  readonly unavailable_reason: EvidenceReviewUnavailableReason | null;
}

/** Opt-in capability response; V1 readiness remains an unchanged wire contract. */
export interface ResearchConfigurationMethodReadiness {
  readonly protocol: typeof RESEARCH_CONFIGURATION_METHOD_READINESS_PROTOCOL;
  readonly project_id: string;
  readonly selected_pin: ResearchConfigurationMethodReadinessPin;
  readonly evidence_review_ready: boolean;
  readonly evidence_review_handler_generation: EvidenceReviewHandlerGeneration | null;
  readonly evidence_review_unavailable_reason: EvidenceReviewUnavailableReason | null;
  readonly checked_at: string;
}

/** Minimal structural evidence injected by Core after its authoritative managed-search preflight. */
export interface ManagedPrimaryReadinessEvidence {
  readonly namespace: "eliotr";
  readonly instance_id: "private-prose-g2";
  readonly index_generation: string;
  readonly registry_revision: number;
  readonly registry_artifact_sha256: string;
}

/** Capture the budget profile through the same strict provenance binder used by run snapshots. */
export function captureEvidenceReviewBudgetSelection(input: {
  readonly profile_json: unknown;
  readonly selected_configuration: SelectedResearchProjectConfigurationProvenance;
  readonly expected_owner_ref: string;
}): ResearchBranchQueryBudgetSelection | undefined {
  if (typeof input.profile_json !== "string") return undefined;
  try {
    return captureResearchBranchQueryBudgetSelection({ profile_json: input.profile_json,
      selected_configuration: input.selected_configuration, expected_owner_ref: input.expected_owner_ref });
  } catch {
    return undefined;
  }
}

export { RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON_KEY };

/** Select V7 when no V9 branch profile is configured; V9 requires its captured budget and managed registry. */
export function resolveEvidenceReviewMethod(input: {
  readonly readiness: ResearchConfigurationReadiness;
  readonly expected_pin: ResearchConfigurationMethodReadinessPin;
  readonly selected_pin: ResearchConfigurationMethodReadinessPin;
  readonly selected_provenance: SelectedResearchProjectConfigurationProvenance;
  readonly model_selections: readonly Pick<ResearchRunModelSelection, "stage">[];
  readonly branch_query_budget_profile_present: boolean;
  readonly branch_query_budget_selection?: ResearchBranchQueryBudgetSelection;
  readonly managed_primary?: ManagedPrimaryReadinessEvidence;
}): EvidenceReviewMethodDecision {
  const unavailable = (reason: EvidenceReviewUnavailableReason): EvidenceReviewMethodDecision =>
    Object.freeze({ handler_generation: null, unavailable_reason: reason });
  const samePin = input.expected_pin.configuration_project_id === input.selected_pin.configuration_project_id &&
    input.expected_pin.configuration_ref === input.selected_pin.configuration_ref &&
    input.expected_pin.configuration_sha256 === input.selected_pin.configuration_sha256 &&
    input.expected_pin.selection_revision === input.selected_pin.selection_revision &&
    input.selected_provenance.project_id === input.selected_pin.configuration_project_id &&
    input.selected_provenance.configuration_ref === input.selected_pin.configuration_ref &&
    input.selected_provenance.configuration_sha256 === input.selected_pin.configuration_sha256 &&
    input.selected_provenance.selection_revision === input.selected_pin.selection_revision;
  if (!samePin) return unavailable("CURRENT_SELECTION_REQUIRED");
  if (input.readiness.run_readiness !== "ready" || input.readiness.qualification_state !== "current" ||
      input.readiness.readiness_reason !== "QUALIFICATION_PROOFS_CURRENT") return unavailable("MODEL_READINESS_UNAVAILABLE");
  const requiredStages = ["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"] as const;
  const stagesComplete = requiredStages.every(stage => input.model_selections.filter(selection => selection.stage === stage).length === 1);
  if (!stagesComplete) return unavailable("STAGE_BINDINGS_UNAVAILABLE");
  if (!input.branch_query_budget_profile_present) {
    return Object.freeze({ handler_generation: "V7", unavailable_reason: null });
  }
  const budget = input.branch_query_budget_selection;
  const budgetMatches = budget !== undefined && budget.budgets.evidence_limit <= 16 &&
    branchQueryBudgetSelectionMatchesRun({ selection: budget, owner_ref: input.selected_provenance.owner_ref,
      project_configuration: input.selected_provenance });
  if (!budgetMatches) return unavailable("V9_BRANCH_BUDGET_UNAVAILABLE");
  const managed = input.managed_primary;
  const managedReady = managed?.namespace === "eliotr" && managed.instance_id === "private-prose-g2" &&
    managed.index_generation.length > 0 && Number.isSafeInteger(managed.registry_revision) &&
    /^[a-f0-9]{64}$/u.test(managed.registry_artifact_sha256);
  if (!managedReady) return unavailable("V9_MANAGED_SEARCH_UNAVAILABLE");
  return Object.freeze({ handler_generation: "V9", unavailable_reason: null });
}

export function isEvidenceReviewMethodReady(input: Parameters<typeof resolveEvidenceReviewMethod>[0]): boolean {
  return resolveEvidenceReviewMethod(input).handler_generation !== null;
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

function installedPolicy(values: ResearchConfigurationRuntimeValues): InstalledSpendPolicy {
  const raw = values.configuration_fields.ELIOTR_MODEL_SPEND_POLICY_JSON;
  const provenance = values.configuration_fields.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF;
  if (!hasText(raw) || !hasText(provenance)) failure("installed spend policy is unavailable");
  let protocol: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    protocol = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).protocol : undefined;
  } catch {
    failure("installed spend policy is invalid");
  }
  return protocol === "eliotr.research-owner-spend-template.v1" || protocol === "eliotr.research-owner-spend-template.v2"
    ? readResearchOwnerSpendPolicyTemplate(raw, provenance)
    : readResearchModelSpendPolicy(raw, provenance);
}

function installedProfileDeployment(values: ResearchConfigurationRuntimeValues): ModelRouteDeployment {
  const raw = values.configuration_fields.ELIOTR_MODEL_PROFILE_DEFINITION_JSON;
  if (!hasText(raw)) failure("installed model profile is unavailable");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { failure("installed model profile is invalid"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) failure("installed model profile is invalid");
  return decodeModelRouteDeployment((parsed as Record<string, unknown>).deployment);
}

function activeCandidateQuery(): string {
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
  const row = await database.prepare(activeCandidateQuery())
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

function ownerPolicyMatches(policy: InstalledSpendPolicy, deploymentGeneration: string | undefined,
  owner: Pick<AuthenticatedRequestContext, "principal_ref" | "credential_generation">): boolean {
  if (policy.principal_ref !== owner.principal_ref || policy.client_class !== "owner_pwa") return false;
  if (policy.protocol !== "eliotr.research-owner-spend-template.v2" &&
      policy.deployment_generation !== deploymentGeneration) return false;
  return !("credential_generation" in policy) || policy.credential_generation === owner.credential_generation;
}

/**
 * Reads installed configuration and the two persisted qualification proofs.
 * This never renews a proof, calls a provider, or performs a model request.
 */
export async function readResearchConfigurationReadiness(
  input: {
    readonly database: D1Database;
    readonly configuration: ResearchConfigurationRuntimeValues;
    readonly deployment_generation?: string;
    readonly model_gateway_read_token?: string;
  },
  owner: Pick<AuthenticatedRequestContext, "principal_ref" | "credential_generation" | "client_class">,
  options: Readonly<{
    readonly selected_model_selections?: readonly ResearchRunModelSelection[];
    readonly mode?: "snapshot-v1" | "snapshot-v2";
    readonly project_owner_ref?: string;
    readonly project_id?: string;
    readonly native_model_authority?: ProviderNativeModelAuthorityPort;
    readonly catalog_native_model_authority_v2?: ProviderNativeModelCatalogV2AuthorityPort;
  }> = {},
): Promise<ResearchConfigurationReadiness> {
  const status = readResearchConfigurationStatus(input.configuration, owner);
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
    policy = installedPolicy(input.configuration);
    profileDeployment = installedProfileDeployment(input.configuration);
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
  if (synthesis === undefined || audit === undefined || !ownerPolicyMatches(policy, input.deployment_generation, owner) ||
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

  const proofStore = createD1DynamicRouteQualificationProofStore(input.database, {
    now: () => new Date().toISOString(),
  });
  let proofs: readonly ProofCheck[];
  try {
    if (options.selected_model_selections !== undefined) {
      const selectedModelSelections = options.selected_model_selections;
      const spendV2 = policy.protocol === "eliotr.research-owner-spend-template.v2";
      const mode = options.mode ?? (spendV2 ? "snapshot-v2" : "snapshot-v1");
      if ((spendV2 && mode !== "snapshot-v2") || (!spendV2 && mode !== "snapshot-v1")) {
        failure("selected run snapshot mode differs from the installed owner setting version");
      }
      const registry = createD1ModelGatewayDeploymentRegistry(input.database, { environment: "PRODUCTION" });
      const pinned = async (stage: "SYNTHESIZE" | "AUDIT_CLAIMS", route: ModelRouteDeployment): Promise<ProofCheck> => {
        const matches = selectedModelSelections.filter((selection) => selection.stage === stage);
        if (matches.length !== 1) failure(`selected project configuration has no exact ${stage} tuple`);
        const selection = matches[0];
        if (selection === undefined) failure(`selected project configuration has no exact ${stage} tuple`);
        if (selection.route_ref !== route.route_ref || selection.route_version !== route.route_version) {
          failure(`selected project configuration ${stage} route differs from the installed spend rule`);
        }
        if (selection.candidate_kind === "provider-native-v1") {
          if (mode !== "snapshot-v2" || options.project_owner_ref === undefined || options.project_id === undefined ||
              options.native_model_authority === undefined) {
            failure(`selected ${stage} provider-native authority is unavailable`);
          }
          const resolvedNative = await options.native_model_authority.resolvePinned({ selection,
            owner_ref: options.project_owner_ref, project_id: options.project_id,
            allow_expired_snapshot_v2: true });
          const preparation = resolvedNative.candidate.candidate.preparation;
          if (resolvedNative.selection.stage !== stage || preparation.owner_ref !== options.project_owner_ref ||
              preparation.project_id !== options.project_id || preparation.stage !== stage ||
              canonicalJson(preparation.deployment) !== canonicalJson(route)) {
            failure(`selected ${stage} provider-native candidate differs from the exact installed tuple`);
          }
          const expiresAt = resolvedNative.proof.qualification.qualification.expires_at;
          const expires = Date.parse(expiresAt);
          if (!Number.isFinite(expires) || (mode !== "snapshot-v2" && expires <= Date.now())) failure(`selected ${stage} provider-native proof has expired`);
          return Object.freeze({ qualification_state: mode === "snapshot-v2" || expires > Date.now() + RENEWAL_WINDOW_MS
            ? "current" : "renewal_required", expires_at: expiresAt });
        }
        if (selection.candidate_kind === "provider-native-v2") {
          if (mode !== "snapshot-v2" || options.project_owner_ref === undefined || options.project_id === undefined ||
              options.catalog_native_model_authority_v2 === undefined) {
            failure(`selected ${stage} provider-native v2 authority is unavailable`);
          }
          const resolvedCatalog = await options.catalog_native_model_authority_v2.resolvePinned({ selection,
            owner_ref: options.project_owner_ref, project_id: options.project_id, allow_expired_snapshot_v2: true });
          const preparation = resolvedCatalog.candidate.candidate.preparation;
          if (resolvedCatalog.selection.stage !== stage || preparation.owner_ref !== options.project_owner_ref ||
              preparation.project_id !== options.project_id || preparation.stage !== stage ||
              canonicalJson(preparation.deployment) !== canonicalJson(route)) {
            failure(`selected ${stage} provider-native v2 candidate differs from the exact installed tuple`);
          }
          const expiresAt = resolvedCatalog.proof.qualification.expires_at;
          const expires = Date.parse(expiresAt);
          if (!Number.isFinite(expires)) failure(`selected ${stage} provider-native v2 proof expiry is invalid`);
          return Object.freeze({ qualification_state: "current", expires_at: expiresAt });
        }
        const proof = await proofStore.readPinned({ route_ref: selection.route_ref, route_version: selection.route_version,
          candidate_ref: selection.candidate_ref, candidate_sha256: selection.candidate_sha256,
          qualification_ref: selection.qualification_ref, qualification_sha256: selection.qualification_sha256 });
        if (proof === null || proof.qualification.tier !== "LIVE") failure(`selected ${stage} qualification proof is unavailable`);
        const revoked = await input.database.prepare("SELECT 1 AS revoked FROM dynamic_route_qualification_revocation " +
          "WHERE qualification_ref=?1 AND qualification_sha256=?2 LIMIT 1")
          .bind(selection.qualification_ref, selection.qualification_sha256).first<{ readonly revoked: unknown }>();
        if (revoked !== null) failure(`selected ${stage} qualification proof was explicitly revoked`);
        const resolved = await registry.resolvePinned(route, selection, {
          allow_expired_qualification: mode === "snapshot-v2",
        });
        if (resolved === null || canonicalJson(decodeModelRouteDeployment(resolved)) !== canonicalJson(route)) {
          failure(`selected ${stage} model candidate differs from the installed route`);
        }
        const expiresAt = proof.qualification.expires_at;
        return Object.freeze({
          qualification_state: mode === "snapshot-v2" || Date.parse(expiresAt) > Date.now() + RENEWAL_WINDOW_MS
            ? "current" : "renewal_required",
          expires_at: expiresAt,
        });
      };
      proofs = await Promise.all([pinned("SYNTHESIZE", synthesis.deployment), pinned("AUDIT_CLAIMS", audit.deployment)]);
    } else {
      proofs = await Promise.all([
        readRouteProof(input.database, proofStore, synthesis.deployment),
        readRouteProof(input.database, proofStore, audit.deployment),
      ]);
    }
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
  if (options.selected_model_selections !== undefined) {
    return baseResult(status, {
      qualification_state: "renewal_required",
      run_readiness: "blocked",
      readiness_reason: "QUALIFICATION_SELECTION_REFRESH_REQUIRED",
      model_route: synthesis.deployment.route_ref,
      qualification_expires_at: expiresAt,
    });
  }
  if (!hasText(input.model_gateway_read_token)) {
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
