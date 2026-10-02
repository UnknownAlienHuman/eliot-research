import {
  IdentifierSchema, OperationIntentSchema, PolicyDecisionSchema,
  type OperationIntent, type PolicyDecision,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { EvidenceSourceAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalDigest, canonicalJson, prepareIntentWithOutboxMutation } from "@eliotr/platform-cloudflare";
import {
  readReauthorizedArtifactDraft,
  type ResearchModelSpendPolicy, type ResearchReportAdmissionPolicy,
} from "@eliotr/cloudflare-research";
import { prepareArtifactReadReauthorization } from "./research-artifact-reauthorization-http.js";
import { resolveResearchOwnerSpendPolicy } from "./research-owner-spend-policy.js";
import { createBoundResearchOwnerReportConfigSource } from "./research-owner-report-policy.js";
import { parseReviseArtifactSectionRequest, type ReviseArtifactSectionRequest } from "./artifact-product-http.js";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

const TOPIC = "research.artifact-section-revise";
const MAX_WITNESS_BYTES = 48 * 1024;

function snapshot<T>(value: T): T {
  const detached: T = JSON.parse(canonicalJson(value));
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(detached);
  return detached;
}

function deny(message: string): never {
  throw new HttpRequestError("ARTIFACT_REPORT_ADMISSION_STALE", 409, message);
}
function configured(value: string | undefined): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) throw new HttpRequestError("ARTIFACT_REPORT_NOT_CONFIGURED", 503, "Installed artifact REPORT policy is missing");
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

export interface ArtifactSectionReportAdmissionWitness {
  readonly protocol: "eliotr.artifact-section-report-admission.v1";
  readonly request: ReviseArtifactSectionRequest;
  readonly policy: ResearchReportAdmissionPolicy;
  readonly spend_policy: ResearchModelSpendPolicy;
  readonly authorization: Awaited<ReturnType<Awaited<ReturnType<typeof prepareArtifactReadReauthorization>>["navigation"]["current"]>>;
  readonly source_bindings: readonly ReturnType<typeof sourceBinding>[];
  readonly material: Readonly<Record<string, unknown>>;
  readonly input_sha256: string;
  readonly decision: PolicyDecision;
  readonly decision_sha256: string;
}

/** Server admission for a dedicated artifact workflow. It creates no research run/stage.
 * The caller MUST persist the returned full witness in W2 before any model effect. */
export async function prepareOwnerArtifactReportAdmission(
  env: Env, context: AuthenticatedRequestContext, request: ReviseArtifactSectionRequest,
) {
  context = Object.freeze({ ...context, ...(context.access === undefined ? {} : { access: Object.freeze({ ...context.access }) }) });
  request = snapshot(parseReviseArtifactSectionRequest({ protocol: request.protocol,
    expected_artifact_revision: request.expected_artifact_revision }, request.artifact_ref, request.section_id, request.idempotency_key));
  if (context.client_class !== "owner_pwa") {
    throw new HttpRequestError("ARTIFACT_REPORT_ADMISSION_DENIED", 403, "Artifact revision requires an authenticated owner");
  }
  if (request.artifact_ref.revision !== request.expected_artifact_revision) deny("Artifact revision changed");
  const current = await prepareArtifactReadReauthorization(env, context, request.artifact_ref, "report");
  await current.requireCurrent();
  const scope = current.navigation.scope;
  const grant = current.authorization;
  const sources = await current.navigation.sources(scope.member_source_revision_refs, grant);
  if (sources.length !== scope.member_source_revision_refs.length ||
      canonicalJson(sources.map((s) => s.source_revision_ref).sort()) !== canonicalJson([...scope.member_source_revision_refs].sort()) ||
      sources.some((s) => s.purge_state !== "LIVE" || !s.allowed_use.includes("research") || s.disclosure_ceiling !== grant.disclosure_ceiling)) {
    deny("Current sources do not permit artifact research");
  }
  const policies = await env.CORE_DB.prepare(
    "SELECT policy_generation FROM investigation_current_policy WHERE policy_authority_ref=?1 AND state='ACTIVE' LIMIT 2",
  ).bind(grant.policy_authority_ref).all<{ policy_generation: unknown }>();
  if (policies.success !== true || !Array.isArray(policies.results) || policies.results.length !== 1) deny("Current REPORT policy authority is ambiguous or unavailable");
  const policyGeneration = configured(typeof policies.results[0]?.policy_generation === "string" ? policies.results[0].policy_generation : undefined);
  const spend = resolveResearchOwnerSpendPolicy({
    raw: env.ELIOTR_MODEL_SPEND_POLICY_JSON,
    provenance: configured(env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF),
    access: context, deployment_generation: env.DEPLOYMENT_GENERATION,
    policy_generation: policyGeneration, policy_authority_ref: grant.policy_authority_ref,
    scope_expires_at: scope.expires_at, authorization: grant,
  }).policy;
  if (spend.principal_ref !== context.principal_ref || spend.client_class !== "owner_pwa" ||
      spend.credential_generation !== context.credential_generation || spend.deployment_generation !== env.DEPLOYMENT_GENERATION ||
      spend.policy_generation !== policyGeneration || spend.policy_authority_ref !== grant.policy_authority_ref) deny("Installed model approval is bound to another authority");
  const reportSource = createBoundResearchOwnerReportConfigSource({
    raw: env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    provenance_ref: configured(env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF),
    current_spend_authority: spend,
  });
  const policy = await reportSource.read();
  if (policy === null || policy.principal_ref !== context.principal_ref || policy.client_class !== "owner_pwa" ||
      policy.policy_generation !== policyGeneration || policy.policy_authority_ref !== grant.policy_authority_ref ||
      policy.requested_output_class !== "private-draft" || policy.purpose !== "research-report-materialization" ||
      !policy.allowed_use.includes("research") || !grant.allowed_use.includes("research") || policy.disclosure_ceiling !== grant.disclosure_ceiling) {
    deny("Installed private REPORT policy does not authorize this owner revision");
  }
  const draftRead = await readReauthorizedArtifactDraft({
    database: env.CORE_DB, work_bucket: env.WORK_BUCKET, artifact_ref: request.artifact_ref,
    access: context, current_navigation: current.navigation, current_authorization: grant,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  });
  if (draftRead === null || !("sections" in draftRead.artifact) || draftRead.artifact.status !== "DRAFT" ||
      draftRead.artifact.sections.filter((s) => s.contract_id === request.section_id).length !== 1) {
    deny("Exact parent draft and stable section contract are unavailable");
  }
  const draft = draftRead.artifact;
  const sourceBindings = sources.map(sourceBinding).sort((a, b) => a.source_revision_ref.localeCompare(b.source_revision_ref));
  const expiryMs = Math.min(Date.parse(policy.expires_at), Date.parse(spend.expires_at), Date.parse(scope.expires_at),
    Date.parse(grant.expires_at), ...sources.flatMap((s) => s.admission_expires_at === undefined ? [] : [Date.parse(s.admission_expires_at)]));
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= Date.now()) deny("REPORT authority has expired");
  const material = snapshot({
    request, principal_ref: context.principal_ref, credential_generation: context.credential_generation,
    deployment_generation: env.DEPLOYMENT_GENERATION, policy_generation: policyGeneration,
    policy_authority_ref: grant.policy_authority_ref, scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    scope_snapshot_digest: scope.digest, purge_revision: scope.purge_ledger_revision,
    spec_digest: draft.spec_digest, evidence_freeze_ref: draft.evidence_freeze_ref,
    source_bindings: sourceBindings, policy, spend_policy: spend, authorization: grant,
    expires_at: new Date(expiryMs).toISOString(),
  });
  const inputSha = await canonicalDigest(material);
  const decision = PolicyDecisionSchema.parse({
    decision_id: "artifact-cow-report-decision-" + inputSha, policy_revision: policy.policy_revision,
    decision: "ALLOW", reason_codes: ["REPORT_PRIVATE_DRAFT_POLICY_ALLOWED"],
    admitted_source_revision_refs: sourceBindings.map((s) => s.source_revision_ref), denied_source_revision_refs: [],
    output_disclosure_ceiling: grant.disclosure_ceiling, expires_at: material.expires_at,
  });
  const decisionSha = await canonicalDigest(decision);
  const witness: ArtifactSectionReportAdmissionWitness = snapshot({
    protocol: "eliotr.artifact-section-report-admission.v1", request, policy, spend_policy: spend,
    authorization: grant, source_bindings: sourceBindings, material,
    input_sha256: inputSha, decision, decision_sha256: decisionSha,
  });
  if (new TextEncoder().encode(canonicalJson(witness)).byteLength > MAX_WITNESS_BYTES) {
    throw new HttpRequestError("ARTIFACT_REPORT_ADMISSION_LIMIT", 413, "Artifact revision authority exceeds the bounded workflow envelope");
  }
  const identity = await canonicalDigest({ principal_ref: context.principal_ref, idempotency_key: request.idempotency_key, request });
  const intentId = "artifact-cow-report-" + identity;
  const prior = await env.CORE_DB.prepare("SELECT created_at FROM operation_intent WHERE intent_id=?1 AND revision=1 LIMIT 1")
    .bind(intentId).first<{ created_at: unknown }>();
  const intent: OperationIntent = OperationIntentSchema.parse({
    intent_ref: { id: intentId, revision: 1 }, operation_kind: "REPORT", principal_ref: context.principal_ref,
    idempotency_key: "artifact-cow-report-key-" + identity, payload_ref: "artifact-cow-request-" + identity,
    policy_decision_ref: decisionSha,
    created_at: prior === null ? new Date().toISOString() : prior.created_at,
  });
  const plan = await prepareIntentWithOutboxMutation(env.CORE_DB, { intent, topic: TOPIC, payload_sha256: inputSha });
  const requireCurrent = async () => {
    await current.requireCurrent();
    if (Date.now() >= expiryMs || canonicalJson(await current.navigation.sources(scope.member_source_revision_refs, grant)) !== canonicalJson(sources)) {
      deny("Artifact REPORT source authority changed");
    }
    const row = await env.CORE_DB.prepare(
      "SELECT 1 AS current FROM artifact_draft_head h JOIN artifact_revision a ON (a.artifact_id,a.revision)=(h.artifact_id,h.head_revision) " +
      "JOIN owner_artifact_read_origin o ON (o.artifact_id,o.artifact_revision,o.reader_principal_ref)=(a.artifact_id,a.revision,?3) " +
      "WHERE h.artifact_id=?1 AND h.head_revision=?2 AND a.spec_digest=?4 " +
      "AND EXISTS (SELECT 1 FROM investigation_current_policy WHERE policy_generation=?5 AND policy_authority_ref=?6 AND state='ACTIVE') " +
      "AND EXISTS (SELECT 1 FROM research_deployment_compatible WHERE origin_deployment_generation=?7) LIMIT 1",
    ).bind(request.artifact_ref.id, request.expected_artifact_revision, context.principal_ref, draft.spec_digest,
      policyGeneration, grant.policy_authority_ref, env.DEPLOYMENT_GENERATION).first<{ current: unknown }>();
    if (row?.current !== 1) deny("Artifact head, owner, policy or deployment changed before REPORT admission");
  };
  return Object.freeze({
    intent, outbox_id: plan.outbox_id, decision, decision_sha256: decisionSha, admission_witness: witness,
    policy_generation: policyGeneration, policy_authority_ref: grant.policy_authority_ref,
    purge_revision: scope.purge_ledger_revision, navigation: current.navigation, authorization: grant,
    budget: Object.freeze({ receipt_ref: "artifact-cow-budget-" + inputSha, expires_at_ms: expiryMs,
      max_total_usd: spend.rules.filter((r) => r.stage === "SYNTHESIZE" || r.stage === "AUDIT_CLAIMS")
        .reduce((sum, r) => sum + r.quote.max_total_usd, 0) }),
    requireCurrent, readback: plan.readback,
    async commit() {
      await requireCurrent();
      const existing = await plan.readback();
      if (existing !== null) return existing;
      try { plan.assertBatchResults(await env.CORE_DB.batch([...plan.statements])); }
      catch (cause) {
        const raced = await plan.readback();
        if (raced === null) throw cause;
      }
      await requireCurrent();
      const saved = await plan.readback();
      if (saved === null) throw new HttpRequestError("ARTIFACT_REPORT_ADMISSION_UNCERTAIN", 503, "REPORT intent/outbox could not be read back");
      return saved;
    },
  });
}
