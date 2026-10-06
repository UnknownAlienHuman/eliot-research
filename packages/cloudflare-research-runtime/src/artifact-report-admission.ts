import {
  IdentifierSchema,
  OperationIntentSchema,
  PolicyDecisionSchema,
  type OperationIntent,
  type PolicyDecision,
  type VersionedRef,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { EvidenceSourceAuthority, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import type { ResearchModelSpendPolicy, ResearchReportAdmissionPolicy } from "@eliotr/cloudflare-research";
import { createBoundResearchOwnerReportConfigSource } from "@eliotr/cloudflare-research-configuration/research-owner-report-policy.js";
import { resolveResearchOwnerSpendPolicy } from "@eliotr/cloudflare-research-configuration/research-owner-spend-policy.js";

const TOPIC = "research.artifact-section-revise";
const MAX_WITNESS_BYTES = 48 * 1024;

export interface ArtifactSectionReportAdmissionRequest {
  readonly protocol: "eliotr.artifact-section-revise.v1";
  readonly artifact_ref: VersionedRef;
  readonly section_id: string;
  readonly expected_artifact_revision: number;
  readonly idempotency_key: string;
}

export interface ArtifactSectionReportAdmissionRunPin {
  readonly mode: "snapshot-v1" | "snapshot-v2";
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal_ref: string;
  readonly deployment_generation: string;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly model_selections: readonly unknown[];
}

export interface ArtifactSectionReportAdmissionPolicyVars {
  readonly ELIOTR_MODEL_SPEND_POLICY_JSON?: string;
  readonly ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF?: string;
  readonly ELIOTR_RESEARCH_REPORT_CONFIG_JSON?: string;
  readonly ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF?: string;
}

export function selectArtifactSectionReportAdmissionPolicyVars(
  vars: ArtifactSectionReportAdmissionPolicyVars,
): ArtifactSectionReportAdmissionPolicyVars {
  return Object.freeze({
    ...(vars.ELIOTR_MODEL_SPEND_POLICY_JSON === undefined ? {} : {
      ELIOTR_MODEL_SPEND_POLICY_JSON: vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
    }),
    ...(vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF === undefined ? {} : {
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
    }),
    ...(vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON === undefined ? {} : {
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    }),
    ...(vars.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF === undefined ? {} : {
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: vars.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF,
    }),
  });
}

export interface ArtifactSectionReportAdmissionDraft {
  readonly spec_digest: string;
  readonly evidence_freeze_ref: VersionedRef;
}

type NavigationAuthorization = Awaited<ReturnType<NavigationReadAuthority["current"]>>;

export interface ArtifactSectionReportAdmissionWitness {
  readonly protocol: "eliotr.artifact-section-report-admission.v1";
  readonly request: ArtifactSectionReportAdmissionRequest;
  readonly policy: ResearchReportAdmissionPolicy;
  readonly spend_policy: ResearchModelSpendPolicy;
  readonly authorization: NavigationAuthorization;
  readonly source_bindings: readonly ReturnType<typeof sourceBinding>[];
  readonly material: Readonly<Record<string, unknown>>;
  readonly input_sha256: string;
  readonly decision: PolicyDecision;
  readonly decision_sha256: string;
}

export type ArtifactSectionReportAdmissionErrorCode =
  | "ARTIFACT_REPORT_ADMISSION_STALE"
  | "ARTIFACT_REPORT_NOT_CONFIGURED"
  | "ARTIFACT_REPORT_ADMISSION_LIMIT"
  | "ARTIFACT_REPORT_ADMISSION_UNCERTAIN"
  | "ARTIFACT_REPORT_ADMISSION_DENIED";

export class ArtifactSectionReportAdmissionApplicationError extends Error {
  public readonly code: ArtifactSectionReportAdmissionErrorCode;
  public readonly status: 403 | 409 | 413 | 503;

  public constructor(code: ArtifactSectionReportAdmissionErrorCode, status: 403 | 409 | 413 | 503, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactSectionReportAdmissionApplicationError";
    this.code = code;
    this.status = status;
  }
}

export interface PreparedArtifactSectionReportOutbox<Readback> {
  readonly outbox_id: string;
  readback(): Promise<Readback | null>;
  /** Executes only the prepared D1 batch; the Core adapter owns the binding. */
  commit_batch(): Promise<void>;
}

export interface ArtifactSectionReportAdmissionApplicationInput<Readback> {
  readonly request: ArtifactSectionReportAdmissionRequest;
  readonly context: AuthenticatedRequestContext;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly draft: ArtifactSectionReportAdmissionDraft;
  readonly policy_vars: ArtifactSectionReportAdmissionPolicyVars;
  readonly run_configuration: ArtifactSectionReportAdmissionRunPin | null;
  readonly navigation: NavigationReadAuthority;
  readonly authorization: NavigationAuthorization;
  readonly sources: readonly EvidenceSourceAuthority[];
  /** Core performs the exact artifact-head/owner/policy/deployment D1 predicate. */
  readonly assert_current: () => Promise<void>;
  readonly outbox: {
    read_intent_created_at(intent_id: string): Promise<unknown | null>;
    prepare(input: Readonly<{ intent: OperationIntent; topic: string; payload_sha256: string }>):
      Promise<PreparedArtifactSectionReportOutbox<Readback>>;
  };
  readonly now?: () => number;
}

function snapshot<T>(value: T): T {
  const detached: T = JSON.parse(canonicalJson(value)) as T;
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(detached);
  return detached;
}

function stale(message: string): never {
  throw new ArtifactSectionReportAdmissionApplicationError("ARTIFACT_REPORT_ADMISSION_STALE", 409, message);
}

function configured(value: string | undefined): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new ArtifactSectionReportAdmissionApplicationError(
      "ARTIFACT_REPORT_NOT_CONFIGURED", 503, "Installed artifact REPORT policy is missing",
    );
  }
  return parsed.data;
}

function sourceBinding(source: EvidenceSourceAuthority) {
  return {
    source_revision_ref: source.source_revision_ref,
    source_owner_generation: source.source_owner_generation,
    content_sha256: source.content_sha256,
    object_residency_key_digest: source.object_residency_key_digest,
    admission_receipt_ref: source.admission_receipt_ref,
    allowed_use: [...source.allowed_use],
    disclosure_ceiling: source.disclosure_ceiling,
    admission_expires_at: source.admission_expires_at ?? null,
  };
}

/** Builds the immutable private-REPORT witness after Core has reauthorized the artifact and run pin. */
export async function prepareArtifactSectionReportAdmissionApplication<Readback>(
  input: ArtifactSectionReportAdmissionApplicationInput<Readback>,
) {
  const now = input.now ?? Date.now;
  if (input.context.client_class !== "owner_pwa") {
    throw new ArtifactSectionReportAdmissionApplicationError(
      "ARTIFACT_REPORT_ADMISSION_DENIED", 403, "Artifact revision requires an authenticated owner",
    );
  }
  if (input.request.artifact_ref.revision !== input.request.expected_artifact_revision) {
    stale("Artifact revision changed");
  }
  const scope = input.navigation.scope;
  const grant = input.authorization;
  const sources = input.sources;
  if (sources.length !== scope.member_source_revision_refs.length ||
      canonicalJson(sources.map((source) => source.source_revision_ref).sort()) !==
        canonicalJson([...scope.member_source_revision_refs].sort()) ||
      sources.some((source) => source.purge_state !== "LIVE" || !source.allowed_use.includes("research") ||
        source.disclosure_ceiling !== grant.disclosure_ceiling)) {
    stale("Current sources do not permit artifact research");
  }

  const spendResolution = resolveResearchOwnerSpendPolicy({
    raw: input.policy_vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
    provenance: configured(input.policy_vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF),
    access: input.context,
    deployment_generation: input.deployment_generation,
    policy_generation: input.policy_generation,
    policy_authority_ref: grant.policy_authority_ref,
    scope_expires_at: scope.expires_at,
    authorization: grant,
    now_ms: now(),
  });
  const spend = spendResolution.policy;
  if (spendResolution.mode === "template-v2" &&
      (input.run_configuration === null || input.run_configuration.mode !== "snapshot-v2")) {
    throw new ArtifactSectionReportAdmissionApplicationError(
      "ARTIFACT_REPORT_ADMISSION_STALE", 409,
      "Stable model settings require the artifact's exact original snapshot-v2 selection",
    );
  }
  if (spend.principal_ref !== input.context.principal_ref || spend.client_class !== "owner_pwa" ||
      spend.credential_generation !== input.context.credential_generation ||
      spend.deployment_generation !== input.deployment_generation || spend.policy_generation !== input.policy_generation ||
      spend.policy_authority_ref !== grant.policy_authority_ref) {
    stale("Installed model approval is bound to another authority");
  }

  const reportSource = createBoundResearchOwnerReportConfigSource({
    raw: input.policy_vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    provenance_ref: configured(input.policy_vars.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF),
    current_spend_authority: spend,
    now_ms: now(),
  });
  const policy = await reportSource.read();
  if (policy === null || policy.principal_ref !== input.context.principal_ref || policy.client_class !== "owner_pwa" ||
      policy.policy_generation !== input.policy_generation || policy.policy_authority_ref !== grant.policy_authority_ref ||
      policy.requested_output_class !== "private-draft" || policy.purpose !== "research-report-materialization" ||
      !policy.allowed_use.includes("research") || !grant.allowed_use.includes("research") ||
      policy.disclosure_ceiling !== grant.disclosure_ceiling) {
    stale("Installed private REPORT policy does not authorize this owner revision");
  }

  const sourceBindings = sources.map(sourceBinding).sort((left, right) =>
    left.source_revision_ref.localeCompare(right.source_revision_ref));
  const expiryMs = Math.min(Date.parse(policy.expires_at), Date.parse(spend.expires_at), Date.parse(scope.expires_at),
    Date.parse(grant.expires_at), ...sources.flatMap((source) => source.admission_expires_at === undefined
      ? [] : [Date.parse(source.admission_expires_at)]));
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= now()) stale("REPORT authority has expired");

  const material = snapshot({
    request: input.request,
    principal_ref: input.context.principal_ref,
    credential_generation: input.context.credential_generation,
    deployment_generation: input.deployment_generation,
    policy_generation: input.policy_generation,
    policy_authority_ref: grant.policy_authority_ref,
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    scope_snapshot_digest: scope.digest,
    purge_revision: scope.purge_ledger_revision,
    spec_digest: input.draft.spec_digest,
    evidence_freeze_ref: input.draft.evidence_freeze_ref,
    source_bindings: sourceBindings,
    policy,
    spend_policy: spend,
    authorization: grant,
    run_configuration: input.run_configuration,
    expires_at: new Date(expiryMs).toISOString(),
  });
  const inputSha = await canonicalDigest(material);
  const decision = PolicyDecisionSchema.parse({
    decision_id: "artifact-cow-report-decision-" + inputSha,
    policy_revision: policy.policy_revision,
    decision: "ALLOW",
    reason_codes: ["REPORT_PRIVATE_DRAFT_POLICY_ALLOWED"],
    admitted_source_revision_refs: sourceBindings.map((source) => source.source_revision_ref),
    denied_source_revision_refs: [],
    output_disclosure_ceiling: grant.disclosure_ceiling,
    expires_at: material.expires_at,
  });
  const decisionSha = await canonicalDigest(decision);
  const witness: ArtifactSectionReportAdmissionWitness = snapshot({
    protocol: "eliotr.artifact-section-report-admission.v1",
    request: input.request,
    policy,
    spend_policy: spend,
    authorization: grant,
    source_bindings: sourceBindings,
    material,
    input_sha256: inputSha,
    decision,
    decision_sha256: decisionSha,
  });
  if (new TextEncoder().encode(canonicalJson(witness)).byteLength > MAX_WITNESS_BYTES) {
    throw new ArtifactSectionReportAdmissionApplicationError(
      "ARTIFACT_REPORT_ADMISSION_LIMIT", 413, "Artifact revision authority exceeds the bounded workflow envelope",
    );
  }
  const maxTotalUsd = spend.rules.filter((rule) => rule.stage === "SYNTHESIZE" || rule.stage === "AUDIT_CLAIMS")
    .reduce((sum, rule) => sum + rule.quote.max_total_usd, 0);
  if (!Number.isFinite(maxTotalUsd) || maxTotalUsd < 0) stale("Artifact REPORT budget is invalid");

  const identity = await canonicalDigest({ principal_ref: input.context.principal_ref,
    idempotency_key: input.request.idempotency_key, request: input.request });
  const intentId = "artifact-cow-report-" + identity;
  const priorCreatedAt = await input.outbox.read_intent_created_at(intentId);
  const intent: OperationIntent = OperationIntentSchema.parse({
    intent_ref: { id: intentId, revision: 1 },
    operation_kind: "REPORT",
    principal_ref: input.context.principal_ref,
    idempotency_key: "artifact-cow-report-key-" + identity,
    payload_ref: "artifact-cow-request-" + identity,
    policy_decision_ref: decisionSha,
    created_at: priorCreatedAt === null ? new Date(now()).toISOString() : priorCreatedAt,
  });
  const plan = await input.outbox.prepare({ intent, topic: TOPIC, payload_sha256: inputSha });

  const requireCurrent = async () => {
    await input.assert_current();
    if (now() >= expiryMs || canonicalJson(await input.navigation.sources(scope.member_source_revision_refs, grant)) !==
        canonicalJson(sources)) {
      stale("Artifact REPORT source authority changed");
    }
  };
  const budget = Object.freeze({ receipt_ref: "artifact-cow-budget-" + inputSha,
    expires_at_ms: expiryMs, max_total_usd: maxTotalUsd });
  return Object.freeze({
    intent,
    outbox_id: plan.outbox_id,
    decision,
    decision_sha256: decisionSha,
    admission_witness: witness,
    policy_generation: input.policy_generation,
    policy_authority_ref: grant.policy_authority_ref,
    purge_revision: scope.purge_ledger_revision,
    navigation: input.navigation,
    authorization: grant,
    budget,
    requireCurrent,
    readback: plan.readback,
    async commit(): Promise<Readback> {
      await requireCurrent();
      const existing = await plan.readback();
      if (existing !== null) return existing;
      try {
        await plan.commit_batch();
      } catch (cause) {
        const raced = await plan.readback();
        if (raced === null) throw cause;
      }
      await requireCurrent();
      const saved = await plan.readback();
      if (saved === null) {
        throw new ArtifactSectionReportAdmissionApplicationError(
          "ARTIFACT_REPORT_ADMISSION_UNCERTAIN", 503, "REPORT intent/outbox could not be read back",
        );
      }
      return saved;
    },
  });
}
