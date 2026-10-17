import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import type { CoverageReceipt, VersionedRef } from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import {
  PROJECT_GUIDE_PROTOCOL, PROJECT_GUIDE_PROMPT_REVISION, ProjectGuideViewSchema,
  type ProjectGuideLanguage, type ProjectGuideView,
} from "@eliotr/contracts/project-guide";
import { projectGuideFromReport, ProjectGuideProjectionError, type ProjectGuideVerifiedSection } from "./project-guide-projection.js";
import type { ProjectGuideRecord, ProjectGuideStore } from "./project-guide-store.js";
export { prepareReauthenticatedRunMetadataRead } from "./research-run-read-authorization.js";
export { runControlStatus } from "./research-run-control.js";
export { createProjectGuideStore } from "./project-guide-store.js";
export type { ProjectGuideRecord } from "./project-guide-store.js";
function fail(code: string): never { throw new CatalogInputError(code, "Project guide could not be verified", 503); }

export interface ProjectGuideModelPin {
  readonly configuration_project_id: string; readonly configuration_ref: string;
  readonly configuration_sha256: string; readonly selection_revision: number;
}
export interface ProjectGuideCorpus {
  readonly digest: string; readonly atom_generation_ref: string;
  readonly source_revision_refs: readonly string[];
  readonly source_owner_generations: Readonly<Record<string, string>>;
  readonly disclosure_closure_digest: string; readonly purge_ledger_revision: number;
}
export interface ProjectGuideObservation {
  readonly corpus: ProjectGuideCorpus; readonly selection: ProjectGuideModelPin | null;
  readonly source_titles: Readonly<Record<string, string>>;
  /** Rechecks source, project, owner and exact qualified model identity. No grant creation. */
  readonly requireCurrent: () => Promise<void>;
}
export interface ProjectGuidePorts {
  readonly store: ProjectGuideStore;
  readonly observe: (context: AuthenticatedRequestContext, project: string) => Promise<ProjectGuideObservation>;
  readonly prepare: (context: AuthenticatedRequestContext, project: string, language: ProjectGuideLanguage,
    identity: string, observation: ProjectGuideObservation) => Promise<{ body: string; key: string; workflow_instance_id: string }>;
  readonly launch: (context: AuthenticatedRequestContext, record: ProjectGuideRecord) => Promise<{ workflow_instance_id: string }>;
  readonly readRun: (context: AuthenticatedRequestContext, record: ProjectGuideRecord) => Promise<{
    status: ResearchRunStatus; scope_matches: boolean; requireCurrent: () => Promise<void>;
  } | null>;
  readonly readReport: (context: AuthenticatedRequestContext, record: ProjectGuideRecord) => Promise<{
    artifact_ref: VersionedRef; sections: readonly ProjectGuideVerifiedSection[]; coverage: CoverageReceipt;
    requireCurrent: () => Promise<void>;
  }>;
  readonly now?: () => string;
}

/** This is a normal Research question, frozen into the existing run identity and report. */
export function projectGuideQuestion(language: ProjectGuideLanguage): string {
  return language === "ru"
    ? "Создай единый путеводитель по источникам этого проекта. Сначала дай связное краткое содержание основных тем, результатов, разногласий и ограничений, опираясь на доступные доказательства. Затем сформулируй от 3 до 5 конкретных дальнейших исследовательских вопросов, вытекающих из источников и пробелов в них. Каждое утверждение содержания должно быть observation или interpretation с подтверждающими ссылками. Каждый дальнейший вопрос должен быть отдельным recommendation material_claim, оканчиваться знаком вопроса и иметь подтверждающие ссылки на источники, из которых он вытекает. Не добавляй других рекомендаций и не дополняй число вопросов без доказательств. При частичном охвате описывай только прочитанные доказательства; не утверждай, что прочитан весь корпус. Сохрани фактические ограничения охвата. Не используй названия источников вместо чтения доказательств."
    : "Create one combined guide to this project's sources. First provide a coherent concise summary of their main topics, findings, disagreements and limitations using the available evidence. Then give 3 to 5 concrete further research questions arising from the sources and their gaps. Each summary claim must be an observation or interpretation with supporting evidence references. Each further question must be a separate recommendation material_claim ending with a question mark and carrying supporting evidence references for what motivates the question. Include no other recommendations and do not pad the question count without evidence. For partial coverage describe only reviewed evidence; do not claim the whole corpus was read. Preserve actual coverage limitations. Do not substitute source titles for reading evidence.";
}

export function createProjectGuideService(ports: ProjectGuidePorts) {
  async function operation(context: AuthenticatedRequestContext, project: string, language: ProjectGuideLanguage,
    ensure: boolean): Promise<ProjectGuideView> {
    if (context.client_class !== "owner_pwa" || context.request.signal.aborted) throw new CatalogInputError("PROJECT_GUIDE_OWNER_REQUIRED", "Current owner access is required", 403);
    const observed = await ports.observe(context, project);
    const sourceCount = observed.corpus.source_revision_refs.length;
    let observedIdentity: string | null = null;
    const view = (state: ProjectGuideView["state"], record: ProjectGuideRecord | null = null,
      reason: string | null = null, guide: ProjectGuideView["guide"] = null, artifact: VersionedRef | null = null) =>
      ProjectGuideViewSchema.parse({ protocol: PROJECT_GUIDE_PROTOCOL, project_id: project, language, state,
        corpus_digest: observed.corpus.digest, source_count: sourceCount,
        identity_digest: record?.identity_digest ?? observedIdentity, workflow_instance_id: record?.workflow_instance_id ?? null,
        artifact_ref: artifact, reason_code: reason, guide });
    if (sourceCount === 0) { await observed.requireCurrent(); return view("EMPTY"); }
    if (observed.selection === null) { await observed.requireCurrent(); return view("BLOCKED", null, "QUALIFIED_PROJECT_MODEL_REQUIRED"); }
    const identity = await evidenceSha256({ owner: context.principal_ref, project, corpus: observed.corpus.digest,
      model: observed.selection, language, prompt: PROJECT_GUIDE_PROMPT_REVISION });
    observedIdentity = identity;
    let record = await ports.store.read(identity, context.principal_ref);
    if (record === null) {
      // An unacknowledged earlier launch remains discoverable even if the project/model changed.
      const held = await ports.store.held(context.principal_ref, project);
      if (held !== null) {
        const run = await ports.readRun(context, held);
        await run?.requireCurrent();
        if (run === null) { await observed.requireCurrent(); return view("UNKNOWN", held, "GUIDE_LAUNCH_UNCONFIRMED"); }
        await ports.store.update(held, run.status.execution_state === "ACTIVE" ? "RUNNING" : "STALE");
        await observed.requireCurrent();
        return view(run.status.execution_state === "ACTIVE" ? "PENDING" : "STALE", held, "PREVIOUS_GUIDE_ATTEMPT_HELD");
      }
      if (!ensure) { await observed.requireCurrent(); return view("MISSING"); }
      const prepared = await ports.prepare(context, project, language, identity, observed);
      const stamp = ports.now?.() ?? new Date().toISOString();
      const pending: ProjectGuideRecord = { identity_digest: identity, owner_principal_ref: context.principal_ref,
        project_id: project, language, prompt_revision: PROJECT_GUIDE_PROMPT_REVISION, corpus_digest: observed.corpus.digest,
        corpus_json: canonicalEvidenceJson(observed.corpus), selection_json: canonicalEvidenceJson(observed.selection),
        idempotency_key: prepared.key, request_body: prepared.body, workflow_instance_id: prepared.workflow_instance_id,
        state: "HELD", artifact_id: null, artifact_revision: null, created_at: stamp, updated_at: stamp };
      await observed.requireCurrent();
      const winner = await ports.store.reserve(pending);
      record = await ports.store.read(identity, context.principal_ref);
      if (record === null) fail("PROJECT_GUIDE_RESERVATION_UNCONFIRMED");
      if (winner) {
        try {
          await observed.requireCurrent();
          const launched = await ports.launch(context, record);
          if (launched.workflow_instance_id !== record.workflow_instance_id) fail("PROJECT_GUIDE_RUN_IDENTITY_CHANGED");
          await ports.store.update(record, "RUNNING");
        } catch (error) {
          // Persist-before-dispatch is the only allocation. Neither GET nor another ensure retries this call.
          await ports.store.update(record, "UNKNOWN");
          if (error instanceof CatalogInputError && error.code === "PROJECT_GUIDE_RUN_IDENTITY_CHANGED") throw error;
          await observed.requireCurrent();
          return view("UNKNOWN", record, "GUIDE_LAUNCH_UNCONFIRMED");
        }
      }
    }
    const expected = await ports.prepare(context, project, language, identity, observed);
    if (record.corpus_json !== canonicalEvidenceJson(observed.corpus) ||
        record.selection_json !== canonicalEvidenceJson(observed.selection) || record.project_id !== project ||
        record.language !== language || record.prompt_revision !== PROJECT_GUIDE_PROMPT_REVISION ||
        record.idempotency_key !== expected.key || record.request_body !== expected.body ||
        record.workflow_instance_id !== expected.workflow_instance_id) fail("PROJECT_GUIDE_STORAGE_CORRUPT");
    const run = await ports.readRun(context, record);
    if (run === null) {
      if (!["HELD", "UNKNOWN"].includes(record.state)) fail("PROJECT_GUIDE_RUN_MISSING");
      await observed.requireCurrent(); return view("UNKNOWN", record, "GUIDE_LAUNCH_UNCONFIRMED");
    }
    await run.requireCurrent();
    if (!run.scope_matches) {
      await ports.store.update(record, "STALE"); await observed.requireCurrent();
      return view("STALE", record, "GUIDE_ACCEPTED_SCOPE_CHANGED");
    }
    if (run.status.execution_state !== "ENGINE_COMPLETED") {
      const failed = run.status.execution_state === "CANCELLED" || run.status.engine_status === "errored";
      await ports.store.update(record, failed ? "FAILED" : "RUNNING");
      await run.requireCurrent(); await observed.requireCurrent();
      return view(failed ? "FAILED" : "PENDING", record, failed ? "GUIDE_RESEARCH_FAILED" : null);
    }
    const report = await ports.readReport(context, record);
    let guide: ProjectGuideView["guide"];
    try { guide = await projectGuideFromReport(report.sections, report.coverage, observed.source_titles); }
    catch (error) {
      if (!(error instanceof ProjectGuideProjectionError)) throw error;
      await report.requireCurrent(); await run.requireCurrent(); await observed.requireCurrent();
      await ports.store.update(record, "INVALID", report.artifact_ref);
      await report.requireCurrent(); await run.requireCurrent(); await observed.requireCurrent();
      return view("INVALID", record, error.code, null, report.artifact_ref);
    }
    await report.requireCurrent(); await run.requireCurrent(); await observed.requireCurrent();
    const partial = guide.coverage.denominator_kind !== "complete_scope" ||
      guide.coverage.represented_source_refs.length !== sourceCount || guide.coverage.omitted_sources.length !== 0;
    await ports.store.update(record, partial ? "PARTIAL" : "READY", report.artifact_ref);
    await report.requireCurrent(); await run.requireCurrent(); await observed.requireCurrent();
    return view(partial ? "PARTIAL" : "READY", record, null, guide, report.artifact_ref);
  }
  return {
    read: (context: AuthenticatedRequestContext, project: string, language: ProjectGuideLanguage) => operation(context, project, language, false),
    ensure: (context: AuthenticatedRequestContext, project: string, language: ProjectGuideLanguage) => operation(context, project, language, true),
  };
}
