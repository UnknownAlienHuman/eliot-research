import { canonicalDigest, canonicalJson } from "@eliotr/platform-cloudflare";
import { createNavigationReadAuthority, loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { createArtifactSectionReviseWorkflowStore, ARTIFACT_SECTION_REVISE_PROTOCOL } from "@eliotr/cloudflare-workflows";
import { createArtifactCowDraftMaterialization, reconcileArtifactCowRevision, runArtifactCowRevision,
  startArtifactSectionReviseWorkflow } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createOwnerArtifactCowPorts } from "./artifact-section-revise-ports.js";
import { createOwnerArtifactCowModel } from "./artifact-section-revise-model.js";
import { prepareOwnerArtifactReportAdmission } from "./artifact-report-admission.js";
import type { ReviseArtifactSectionRequest } from "./artifact-product-http.js";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

const HANDLER = "eliotr.artifact-section-revise-handler.v1";
function deny(message: string): never { throw new HttpRequestError("ARTIFACT_SECTION_REVISE_STALE", 409, message); }

/** Retry starts by reading the exact W2 identity. Historical witnesses are never renewed. */
export async function reviseOwnerArtifactSection(env: Env, context: AuthenticatedRequestContext, request: ReviseArtifactSectionRequest) {
  if (context.client_class !== "owner_pwa") throw new HttpRequestError("ARTIFACT_SECTION_REVISE_DENIED", 403, "Section revision requires the owner");
  const workflow = createArtifactSectionReviseWorkflowStore(env.CORE_DB);
  const identity = await canonicalDigest({ protocol: ARTIFACT_SECTION_REVISE_PROTOCOL, principal_ref: context.principal_ref, request });
  let attempt = await workflow.read("artifact-cow-run-" + identity);
  const existing = attempt !== null;
  const principal = { principal_ref: context.principal_ref, credential_generation: context.credential_generation,
    deployment_generation: env.DEPLOYMENT_GENERATION, client_class: "owner_pwa" as const, signal: context.request.signal };
  if (attempt === null) {
    const report = await prepareOwnerArtifactReportAdmission(env, context, request);
    attempt = await startArtifactSectionReviseWorkflow({ request, report_admission: report, principal, handler_generation: HANDLER, store: workflow });
  }
  const boundAttempt = attempt;
  const witness = boundAttempt.request.report_admission_witness;
  if (canonicalJson(witness.request) !== canonicalJson(request) || boundAttempt.authority.principal_ref !== context.principal_ref ||
      boundAttempt.authority.credential_generation !== context.credential_generation ||
      boundAttempt.authority.deployment_generation !== env.DEPLOYMENT_GENERATION || boundAttempt.request.handler_generation !== HANDLER) {
    deny("Saved section revision belongs to different request or execution authority");
  }
  const scope = await loadScopeAuthority(env.CORE_DB, boundAttempt.request.scope_snapshot_ref);
  if (scope === null || scope.snapshot.digest !== witness.material.scope_snapshot_digest || scope.invalidated_at !== null) deny("Admitted REPORT scope is no longer available");
  const now = Date.now;
  const owner = createOwnerScopeAuthority(env.CORE_DB, context, now);
  const scopes = createD1ScopeService(env.CORE_DB, owner, { now });
  const scopeCurrent = (value: typeof scope.snapshot) => scopes.requireCurrent(value);
  const navigation = createNavigationReadAuthority({ database: env.CORE_DB, scope_snapshot: scope.snapshot,
    access: context, require_current: scopeCurrent, now });
  const requirePermission = async () => {
    if (context.request.signal.aborted || (context.access !== undefined && Date.parse(context.access.expires_at) <= Date.now())) deny("Owner request expired or was cancelled");
    const grant = await navigation.current();
    if (canonicalJson(grant) !== canonicalJson(witness.authorization) ||
        Date.now() >= Date.parse(String(witness.material.expires_at)) || Date.now() >= boundAttempt.budget.expires_at_ms) deny("Admitted REPORT execution permission expired or changed");
    const origin = await env.CORE_DB.prepare("SELECT 1 AS current FROM owner_artifact_read_origin WHERE artifact_id=?1 AND artifact_revision=?2 AND reader_principal_ref=?3 LIMIT 1")
      .bind(request.artifact_ref.id, request.artifact_ref.revision, context.principal_ref).first<{ current: number }>();
    if (origin?.current !== 1) deny("Current owner artifact origin is unavailable");
    const sources = await navigation.sources(navigation.scope.member_source_revision_refs, grant);
    const bindings = sources.map((source) => ({ source_revision_ref: source.source_revision_ref,
      source_owner_generation: source.source_owner_generation, content_sha256: source.content_sha256,
      object_residency_key_digest: source.object_residency_key_digest, admission_receipt_ref: source.admission_receipt_ref,
      allowed_use: [...source.allowed_use], disclosure_ceiling: source.disclosure_ceiling,
      admission_expires_at: source.admission_expires_at ?? null })).sort((left, right) => left.source_revision_ref.localeCompare(right.source_revision_ref));
    if (canonicalJson(bindings) !== canonicalJson(witness.source_bindings) || canonicalJson(await navigation.current()) !== canonicalJson(grant)) deny("Current REPORT source authority changed");
  };
  await requirePermission();
  const result = (value: typeof boundAttempt) => ({ protocol: "eliotr.artifact-section-revise-status.v1" as const,
    operation_id: value.request.operation_id, attempt_ref: value.attempt_ref, state: value.state,
    parent_artifact_ref: value.request.artifact_ref, section_id: value.request.section_id,
    ...(value.draft === undefined ? {} : { draft: value.draft }), disposition: existing ? "EXISTING" as const : "CREATED" as const });
  if (attempt.state === "UNKNOWN" || attempt.state === "CANCELLED") return result(attempt);
  const materialization = await createArtifactCowDraftMaterialization({ database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET, attempt, navigation });
  const requireCurrent = async () => { await requirePermission(); await materialization.requireCurrent(); };
  // Startup/retry recovery precedes parent production, model policy, prompts and W3 admission.
  attempt = await reconcileArtifactCowRevision({ requireCurrent, attempt, workflow,
    readFinalizedChild: materialization.readFinalizedChild });
  if (attempt.state === "COMMITTED") return result(attempt);
  const cow = await createOwnerArtifactCowPorts({ env, attempt, navigation, materialization });
  const model = await createOwnerArtifactCowModel({ env, context, attempt, navigation, cow });
  const committed = await runArtifactCowRevision({ requireCurrent, attempt, principal, workflow, ...model,
    ports: cow.ports, readFinalizedChild: materialization.readFinalizedChild });
  await requireCurrent();
  return result(committed);
}
