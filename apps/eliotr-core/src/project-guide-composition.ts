import { canonicalEvidenceJson, evidenceSha256, loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { OWNER_RESEARCH_SCOPE_PROFILE } from "@eliotr/cloudflare-navigation";
import { readHistoricalResearchCoverage } from "@eliotr/cloudflare-research-stages";
import {
  createProjectGuideService, createProjectGuideStore, projectGuideQuestion,
  PROJECT_GUIDE_REQUEST_CONTRACT,
  prepareReauthenticatedRunMetadataRead, runControlStatus,
  type ProjectGuideCorpus, type ProjectGuideObservation, type ProjectGuideRecord,
} from "@eliotr/cloudflare-research-runtime/project-guide-service.js";
import type { ProjectGuideVerifiedSection } from "@eliotr/cloudflare-research-runtime/project-guide-projection.js";
import type { ArtifactRevision, ScopeSnapshot, VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createOwnerResearchProjectConfigurationService } from "./research-project-configuration-composition.js";
import { ResearchProjectModelConfigurationAuthorityError } from "./research-project-configuration.js";
import { createResearchRunService, parseResearchRunTransportRequest, researchRunIdentityDigest,
  selectResearchRunHandlerGeneration } from "./research-run-service.js";
import { RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON_KEY,
  type ResearchBranchQueryBudgetSelection } from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import { ResearchServiceError } from "./research-service-error.js";
import { createResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import { prepareArtifactReadReauthorization, reopenOwnerArtifactDraft, reopenOwnerArtifactSectionCitations } from "./research-artifact-reauthorization-http.js";
import { HttpRequestError } from "./http-errors.js";
import type { Env } from "./env.js";

function same(left: unknown, right: unknown) { return canonicalEvidenceJson(left) === canonicalEvidenceJson(right); }
function fail(code: string): never { throw new HttpRequestError(code, 409, "Project guide authority changed"); }
function active(context: AuthenticatedRequestContext) {
  if (context.client_class !== "owner_pwa" || context.request.signal.aborted ||
      (context.access !== undefined && (context.access.principal_ref !== context.principal_ref ||
        context.access.credential_generation !== context.credential_generation ||
        !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= Date.now()))) {
    fail("PROJECT_GUIDE_OWNER_REQUIRED");
  }
}
function scopeMatches(snapshot: ScopeSnapshot, corpus: ProjectGuideCorpus, project: string) {
  return same(snapshot.resolved_scope_expression, { kind: "PROJECT", project_id: project }) &&
    same(snapshot.member_source_revision_refs, corpus.source_revision_refs) &&
    same(snapshot.source_owner_generations, corpus.source_owner_generations) &&
    snapshot.disclosure_closure_digest === corpus.disclosure_closure_digest &&
    snapshot.purge_ledger_revision === corpus.purge_ledger_revision &&
    Object.values(snapshot.participant_generations).includes(corpus.atom_generation_ref);
}

export function createOwnerProjectGuideService(env: Env) {
  async function observe(context: AuthenticatedRequestContext, project: string): Promise<ProjectGuideObservation> {
    async function current() {
      active(context);
      const authority = createOwnerScopeAuthority(env.CORE_DB, context);
      await authority.exhaustiveRequireReadPolicy();
      const observedAt = new Date().toISOString(), expression = { kind: "PROJECT" as const, project_id: project };
      const atom = await authority.exhaustiveResolveAtom(expression, observedAt);
      const members = [...atom.members].sort((a, b) => a.source_revision_ref < b.source_revision_ref ? -1 : a.source_revision_ref > b.source_revision_ref ? 1 : 0);
      const refs = members.map(member => member.source_revision_ref);
      const sources = await authority.exhaustiveSources(refs);
      const source_titles = Object.fromEntries(sources.map(source => [source.revision.source_revision_ref, source.title]));
      if (sources.length !== refs.length || refs.some(ref => typeof source_titles[ref] !== "string" || source_titles[ref].length === 0)) {
        fail("PROJECT_GUIDE_SOURCE_IDENTITY_CHANGED");
      }
      const closure = await authority.exhaustiveResolveAuthorityClosure({ expression, canonical_expression: canonicalEvidenceJson(expression),
        member_source_revision_refs: refs,
        member_policy_closure_refs: Object.fromEntries(members.map(member => [member.source_revision_ref, member.policy_closure_ref])),
        observed_at: observedAt, client_fence_ref: context.credential_generation });
      if (!closure.client_fence_valid || closure.denied_source_revision_refs.length !== 0) fail("PROJECT_GUIDE_SOURCE_DENIED");
      const basis = { atom_generation_ref: atom.atom_generation_ref, source_revision_refs: refs,
        source_owner_generations: Object.fromEntries(members.map(member => [member.source_revision_ref, member.source_owner_generation])),
        disclosure_closure_digest: closure.disclosure_closure_digest, purge_ledger_revision: closure.purge_ledger_revision };
      const corpus: ProjectGuideCorpus = { ...basis, digest: await evidenceSha256({ project, ...basis }) };
      let selection: ProjectGuideObservation["selection"] = null;
      if (refs.length !== 0) {
        try {
          const selected = await createOwnerResearchProjectConfigurationService(env, context, project).readSelected(context, project);
          if (selected !== null) {
            const native = selected.configuration.vars.ELIOTR_RESEARCH_NATIVE_ACQUISITION_SELECTION_JSON;
            // Do not override a selected acquisition mode to make a guide launch.
            if (native === undefined || JSON.parse(native).source_mode === "corpus_only") selection = {
              configuration_project_id: project, configuration_ref: selected.configuration_ref,
              configuration_sha256: selected.configuration_sha256, selection_revision: selected.selection_revision,
            };
          }
        } catch (error) {
          if (!(error instanceof ResearchProjectModelConfigurationAuthorityError) ||
              error.code !== "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED") throw error;
        }
      }
      active(context);
      return { corpus, selection, source_titles };
    }
    const captured = await current();
    return { ...captured, requireCurrent: async () => {
      const latest = await current();
      if (!same(latest, captured)) fail("PROJECT_GUIDE_AUTHORITY_CHANGED");
    } };
  }
  async function authorizedRun(context: AuthenticatedRequestContext, record: ProjectGuideRecord) {
    active(context);
    const read = await prepareReauthenticatedRunMetadataRead(createResearchRunReadEnvironment(env), context, record.workflow_instance_id);
    if (read === null) return null;
    if (read.status.principal_ref !== context.principal_ref || read.status.operation_id !== record.workflow_instance_id) {
      fail("PROJECT_GUIDE_RUN_IDENTITY_CHANGED");
    }
    await read.requireCurrent();
    return read;
  }
  return createProjectGuideService({
    store: createProjectGuideStore(env.CORE_DB), observe,
    async prepare(context, project, language, identity, observation, persistedRequestBody) {
      if (observation.selection === null) fail("PROJECT_GUIDE_MODEL_REQUIRED");
      const legacyRequest = { query: projectGuideQuestion(language), product: "RESEARCH",
        scope_expression: { kind: "PROJECT", project_id: project }, literals: [], evidence_grade: "E0",
        budget_ref: "research-budget-v1", max_results: OWNER_RESEARCH_SCOPE_PROFILE.max_results,
        request_version: "eliotr.research-run-request.v4", selection: observation.selection, output_language: language };
      const legacyBody = canonicalEvidenceJson(legacyRequest);
      // Only byte-exact legacy reservations retain their original envelope/derived run ID.
      // New admissions use the existing explicit lookup method so captured branch budgets have a consumer.
      const body = persistedRequestBody === legacyBody ? legacyBody : canonicalEvidenceJson({ ...legacyRequest,
        ...PROJECT_GUIDE_REQUEST_CONTRACT });
      const key = `project-guide:${identity}`;
      const parsed = parseResearchRunTransportRequest(JSON.parse(body));
      const digest = await researchRunIdentityDigest(parsed.request, parsed.selection);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${context.principal_ref}|${key}|${digest}`));
      const hex = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
      return { body, key, workflow_instance_id: `run-${hex.slice(0, 48)}` };
    },
    async legacyContractBlocked(context, record, observation) {
      active(context);
      await observation.requireCurrent();
      const selected = await createOwnerResearchProjectConfigurationService(env, context, record.project_id)
        .readSelected(context, record.project_id);
      if (selected === null || observation.selection === null) return false;
      if (!same(observation.selection, { configuration_project_id: selected.project_id,
        configuration_ref: selected.configuration_ref, configuration_sha256: selected.configuration_sha256,
        selection_revision: selected.selection_revision })) fail("PROJECT_GUIDE_AUTHORITY_CHANGED");
      const profileJson = selected.configuration.vars[RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON_KEY];
      if (profileJson === undefined) return false;
      // readSelected has strictly validated the canonical profile and exact qualified bundle.
      const profile = JSON.parse(profileJson) as Pick<ResearchBranchQueryBudgetSelection, "profile_id" | "profile_generation" | "budgets">;
      const parsed = parseResearchRunTransportRequest(JSON.parse(record.request_body));
      if (parsed.selection?.request_version !== "eliotr.research-run-request.v4" || parsed.request.inquiry_protocol_ref !== undefined) return false;
      let rejected = false;
      try {
        selectResearchRunHandlerGeneration({ lane: "exploratory", prior_handler_generation: null,
          explicit_protocol: false, delegated: false, request_max_results: parsed.request.max_results,
          managed_primary_available: false, branch_query_budget_selection: { ...profile,
            protocol: "eliotr.research.branch-query-budget-selection.v1", selected_configuration: {
              owner_ref: context.principal_ref, project_id: selected.project_id, configuration_ref: selected.configuration_ref,
              configuration_sha256: selected.configuration_sha256, selection_revision: selected.selection_revision } } });
      } catch (error) {
        if (!(error instanceof ResearchServiceError) || error.code !== "RESEARCH_CONFLICT" || error.status !== 409 ||
            error.message !== "the selected branch budget profile requires a new explicit exploratory protocol run") throw error;
        rejected = true;
      }
      if (!rejected) return false;
      const row = await env.CORE_DB.prepare("SELECT (EXISTS(SELECT 1 FROM research_workflow_run WHERE operation_id=?1 OR idempotency_key=?2) " +
        "OR EXISTS(SELECT 1 FROM investigation_ledger_head WHERE investigation_id=?3)) AS present")
        .bind(record.workflow_instance_id, record.idempotency_key, `research-${record.workflow_instance_id.slice(4)}`)
        .first<{ present: number }>();
      if (row === null || (row.present !== 0 && row.present !== 1)) fail("PROJECT_GUIDE_ADMISSION_UNAVAILABLE");
      if (row.present !== 0) return false;
      try {
        const instance = await env.RESEARCH_WORKFLOW.get(record.workflow_instance_id);
        if (instance.id !== record.workflow_instance_id) fail("PROJECT_GUIDE_RUN_IDENTITY_CHANGED");
        return false;
      } catch (error) {
        // The binding's exact missing-instance error is distinct from an unavailable status read.
        if (!(error instanceof Error) || error.message !== "instance.not_found") throw error;
      }
      await observation.requireCurrent(); active(context);
      return true;
    },
    async launch(context, record) {
      const headers = new Headers(context.request.headers);
      headers.set("idempotency-key", record.idempotency_key); headers.set("content-type", "application/json");
      const request = new Request(context.request.url, { method: "POST", headers, body: record.request_body,
        signal: context.request.signal });
      return createResearchRunService(env).run({ ...context, request }, JSON.parse(record.request_body));
    },
    async readRun(context, record) {
      const read = await authorizedRun(context, record);
      if (read === null) return null;
      const scope = await loadScopeAuthority(env.CORE_DB, { id: read.status.scope_snapshot_id, revision: read.status.scope_snapshot_revision });
      if (scope === null) fail("PROJECT_GUIDE_SCOPE_UNAVAILABLE");
      // Completed guides are validated once below through the full report path.
      // Active runs still use canonical native status/failure observation.
      const status = read.status.state === "ACTIVE"
        ? await createResearchRunService(env).runStatus(context, record.workflow_instance_id)
        : runControlStatus(read.status);
      if (status.workflow_instance_id !== record.workflow_instance_id) fail("PROJECT_GUIDE_RUN_IDENTITY_CHANGED");
      await read.requireCurrent();
      return { status, scope_matches: scopeMatches(scope.snapshot, JSON.parse(record.corpus_json) as ProjectGuideCorpus, record.project_id),
        requireCurrent: read.requireCurrent };
    },
    async readReport(context, record) {
      const read = await authorizedRun(context, record);
      if (read === null || read.status.state !== "ENGINE_COMPLETED") fail("PROJECT_GUIDE_REPORT_UNAVAILABLE");
      let artifact: ArtifactRevision | undefined, artifactRef: VersionedRef | undefined;
      let reportCurrent: (() => Promise<void>) | undefined;
      const historical = await readHistoricalResearchCoverage({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET,
        operation_id: record.workflow_instance_id, owner: { principal_ref: context.principal_ref, client_class: "owner_pwa" },
        require_current: read.requireCurrent,
        require_artifact: async ({ artifact_ref, original_scope_snapshot_ref }) => {
          const prepared = await prepareArtifactReadReauthorization(env, context, artifact_ref, "report");
          if (!same(prepared.original_scope_snapshot_ref, original_scope_snapshot_ref)) fail("PROJECT_GUIDE_REPORT_SCOPE_CHANGED");
          const reopened = await reopenOwnerArtifactDraft(env, context, artifact_ref);
          if (!("sections" in reopened.artifact) || reopened.artifact.status !== "DRAFT" ||
              !same(reopened.artifact_ref, artifact_ref) || !same(reopened.original_scope_snapshot_ref, original_scope_snapshot_ref)) {
            fail("PROJECT_GUIDE_REPORT_IDENTITY_CHANGED");
          }
          artifact = reopened.artifact; artifactRef = artifact_ref; reportCurrent = prepared.requireCurrent;
          await reportCurrent();
          return { artifact_ref, original_scope_snapshot_ref, status: "DRAFT", evidence_freeze_ref: artifact.evidence_freeze_ref,
            dependency_manifest_ref: artifact.dependency_manifest_ref };
        } });
      if (historical === null || artifact === undefined || artifactRef === undefined || reportCurrent === undefined ||
          !same(historical.artifact_ref, artifactRef)) fail("PROJECT_GUIDE_REPORT_IDENTITY_CHANGED");
      const sections: ProjectGuideVerifiedSection[] = [];
      for (const declared of artifact.sections) {
        const section = await reopenOwnerArtifactDraft(env, context, artifactRef, declared.section_ref);
        if (!("body" in section.artifact) || section.artifact.body_sha256 !== declared.body_sha256 ||
            !same(section.artifact.section_ref, declared.section_ref)) fail("PROJECT_GUIDE_SECTION_CHANGED");
        const citations = await reopenOwnerArtifactSectionCitations(env, context, artifactRef, declared.section_ref);
        if (!same(citations.artifact_ref, artifactRef) || !same(citations.section_ref, declared.section_ref) ||
            citations.verification_receipt_ref !== declared.verification_receipt_ref) fail("PROJECT_GUIDE_CITATIONS_CHANGED");
        sections.push({ section_ref: declared.section_ref, body: section.artifact.body, body_sha256: declared.body_sha256,
          statement_labels: declared.statement_labels, semantic_verification: citations.semantic_verification,
          claims: citations.audit?.claims ?? [], citations: citations.cited_evidence });
      }
      await reportCurrent(); await read.requireCurrent();
      const requireReportCurrent = reportCurrent;
      const requireCurrent = async () => { active(context); await requireReportCurrent(); await read.requireCurrent(); };
      return { artifact_ref: artifactRef, sections, coverage: historical.coverage_receipt, requireCurrent };
    },
  });
}
