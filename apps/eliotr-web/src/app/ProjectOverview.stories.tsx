import { StrictMode, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ProjectGuideView } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "./privacy";
import { createWorkspaceQueryClient } from "../query/client";
import { ProjectOverview } from "./ProjectOverview";

const context: SessionContext = { principal: "synthetic-owner", credentialGeneration: "synthetic-credential",
  deploymentGeneration: "synthetic-deployment", cacheEpoch: 1, expiresAt: "2027-01-01T00:00:00.000Z" };
const privacy = { isCurrent: (value: SessionContext) => value === context } as PrivacyController;
const ref = (id: string) => ({ id, revision: 1 });
function view(state: "PARTIAL" | "EMPTY" | "UNKNOWN" | "INVALID"): ProjectGuideView {
  const refs = Array.from({ length: 10 }, (_, i) => `source-revision-${i + 1}`);
  return { protocol: "eliotr.project-guide.v1", project_id: "synthetic-project", language: "en", state,
    corpus_digest: "a".repeat(64), identity_digest: state === "EMPTY" ? null : "b".repeat(64),
    source_count: state === "EMPTY" ? 0 : 10, workflow_instance_id: state === "EMPTY" ? null : "synthetic-guide-run",
    artifact_ref: state === "PARTIAL" || state === "INVALID" ? ref("synthetic-report") : null,
    reason_code: null, guide: state !== "PARTIAL" ? null : {
      summary: [{ claim_ref: ref("summary"), section_ref: ref("section"), text: "The reviewed studies compare how source revisions preserve evidence. Their reported results depend on the source versions used.",
        label: "SOURCE_SUPPORTED", support_handle_refs: [ref("evidence")], counterevidence_handle_refs: [] }],
      questions: ["How do the studies measure evidence preservation?", "Where do the reviewed studies report different results?", "Which limitations follow from the source versions reviewed?"]
        .map((text, i) => ({ claim_ref: ref(`question-${i}`), section_ref: ref("section"), text,
          label: "EDITORIAL_RECOMMENDATION" as const, support_handle_refs: [ref("evidence")], counterevidence_handle_refs: [] })),
      source_basis: refs.slice(0, 3).map((source_revision_ref, i) => ({ source_revision_ref,
        title: ["Evidence across immutable source revisions", "Comparing source-based findings", "Limits of revision-aware evaluation"][i] ?? "Reviewed study" })),
      coverage: { receipt_ref: ref("coverage"), requested_scope_expression: { kind: "PROJECT", project_id: "synthetic-project" },
        frozen_scope_snapshot_ref: ref("scope"), coverage_denominator_ref: ref("denominator"), denominator_kind: "sampled_with_method",
        eligible_source_refs: refs, represented_source_refs: refs.slice(0, 3), cited_source_refs: refs.slice(0, 3),
        omitted_sources: refs.slice(3).map(source_ref => ({ source_ref, reason: "BUDGET_LIMIT" })),
        source_families_and_independence_profile_ref: "family", lanes_used: ["semantic"], stale_or_skipped_lanes: [],
        failed_acquisition_refs: [], provider_degradation_refs: [], parser_degradation_refs: [], redacted_dependency_refs: [],
        counter_search_status: "NOT_REQUIRED", budget_limitations: ["This synthetic guide represents three of ten sources under the retained Research budget."],
        terminal_disposition: "INCOMPLETE_COVERAGE" },
    } };
}
function Preview({ state = "PARTIAL", locale = "en" }: { state?: "PARTIAL" | "EMPTY" | "UNKNOWN" | "INVALID"; locale?: "en" | "ru" }) {
  const [client] = useState(createWorkspaceQueryClient), [draft, setDraft] = useState(""), [report, setReport] = useState(false);
  return <QueryClientProvider client={client}><StrictMode>
    <ProjectOverview locale={locale} onSuggest={setDraft} guide={{ context, privacy, projectId: "synthetic-project",
      hasSourceEvidence: state !== "EMPTY", isProjectCurrent: () => true,
      api: { read: async () => ({ ...view(state), language: locale }), ensure: async () => { throw new Error("Synthetic guide never dispatches Research"); } },
      onOpenReport: () => setReport(true) }} />
    <label>Question draft<textarea aria-label="Question draft" value={draft} readOnly /></label>
    {report && <p>The existing report/evidence reader would open here.</p>}
  </StrictMode></QueryClientProvider>;
}
export default { title: "Workspace/Project source guide", component: Preview, parameters: { layout: "padded" } };
export const PartialEvidence = { args: { state: "PARTIAL", locale: "en" } };
export const PartialEvidenceRussian = { args: { state: "PARTIAL", locale: "ru" } };
export const EmptyProject = { args: { state: "EMPTY" } };
export const UnknownLaunch = { args: { state: "UNKNOWN" } };
export const InvalidQuestions = { args: { state: "INVALID" } };
