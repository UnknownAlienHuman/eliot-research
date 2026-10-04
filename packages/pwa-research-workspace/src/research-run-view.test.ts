import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@eliotr/pwa-http-client";
import { researchConfigurationErrorCopy, researchConfigurationViewCopy } from "./research-configuration-panel.js";
import type { ResearchConfigurationView } from "./research-configuration-api.js";
import { badgeText, failureDetailFields, failureText, historyErrorMessage, historyStatusText, idleBadgeText, idleProgressText, message, researchHistoryCards, statusText, wikiProposalErrorText } from "./research-run-view.js";
import type { ResearchRunHistoryView, ResearchRunStatusView } from "./research-run-api.js";

const status: ResearchRunStatusView = {
  workflow_instance_id: `run-${"a".repeat(48)}`, investigation_ref: { id: "investigation-1", revision: 1 },
  execution_state: "ENGINE_COMPLETED", engine_status: "complete", next_stage_index: 18,
  answer: { availability: "draft", artifact_ref: { id: "draft-1", revision: 1 } }, deployment_generation: "test-1",
};

function historyView(overrides: Partial<ResearchRunHistoryView> = {}): ResearchRunHistoryView {
  return {
    protocol: "eliotr.research-runs.v3", deployment_generation: "test-1", configuration_state: "INSTALLED", checked_at: "2026-09-23T00:00:00.000Z",
    runs: [], saved_drafts: [],
    ...overrides,
  };
}

function configurationView(overrides: Partial<ResearchConfigurationView> = {}): ResearchConfigurationView {
  return {
    protocol: "eliotr.research-configuration-readiness.v1",
    configuration: "present",
    model_transport: "available",
    qualification_state: "current",
    run_readiness: "ready",
    readiness_reason: "QUALIFICATION_PROOFS_CURRENT",
    model_route: "owner-route-v1",
    qualification_expires_at: "2026-10-10T00:00:00.000Z",
    missing_fields: [],
    invalid_fields: [],
    checked_at: "2026-10-03T12:00:00.000Z",
    trace_id: "trace-1",
    deployment_generation: "test-1",
    ...overrides,
  };
}

function apiError(status: number, code: string): ApiRequestError {
  return new ApiRequestError({ status, code, message: "request failed" });
}

describe("Research presentation preserves execution facts", () => {
  it.each([
    [false, false, "WAITING"], [false, true, "WAITING"], [true, false, "BLOCKED"], [true, true, "READY"],
  ] as const)("requires health=%s and configuration=%s for %s", (health, configured, expected) => {
    expect(idleBadgeText(health, configured)).toBe(expected);
  });
  it("directs a blocked question to Connections without asserting readiness", () => {
    expect(idleProgressText(true, false)).toContain("Connections");
    expect(idleProgressText(true, false)).toContain("unavailable");
  });
  it("does not promote an engine completion or an unverified draft to an answer", () => {
    expect(badgeText(status)).toBe("DRAFT");
    expect(statusText(status)).toContain("review");
    expect(statusText({ ...status, answer: { availability: "unavailable" } })).toContain("No answer");
    expect(badgeText({ ...status, execution_state: "CANCELLED" })).toBe("CANCELLED");
  });
  it("shows one failed-stage headline and retains all failure context in run details", () => {
    const failed: ResearchRunStatusView = {
      ...status,
      execution_state: "ACTIVE",
      engine_status: "errored",
      next_stage_index: 8,
      answer: { availability: "unavailable" },
      failure: {
        code: "WORKFLOW_STAGE_OUT_OF_ORDER",
        stage: "ANALYZE_BRANCHES",
        phase: "STAGE",
        consequence: { code: "WORKFLOW_CONFLICT", stage: "ANALYZE_BRANCHES", phase: "RECOVERY" },
      },
    };
    expect(statusText(failed)).toBe("Research failed at Analyzing findings (WORKFLOW_STAGE_OUT_OF_ORDER).");
    const fields = failureDetailFields(failed);
    expect(fields).toEqual(expect.arrayContaining([
      { label: "Failure code", value: "WORKFLOW_STAGE_OUT_OF_ORDER" },
      { label: "Failed stage", value: "Analyzing findings (ANALYZE_BRANCHES)" },
      { label: "Failure phase", value: "STAGE" },
      { label: "Later failure code", value: "WORKFLOW_CONFLICT" },
      { label: "Later failure phase", value: "RECOVERY" },
      { label: "Answer", value: "Unavailable" },
    ]));
    expect(fields.find((field) => field.label === "Diagnostic")?.value).toContain("Later failure (WORKFLOW_CONFLICT)");
    expect(failureText(failed.failure)).toContain("At ANALYZE BRANCHES.");
  });
  it("sorts history without mutating it or collapsing different artifact revisions", () => {
    const view: ResearchRunHistoryView = historyView({
      runs: [{ created_at: "2026-09-21T00:00:00.000Z", status }],
      saved_drafts: [
        { artifact_ref: { id: "draft-1", revision: 1 }, created_at: "2026-09-21T00:00:00.000Z" },
        { artifact_ref: { id: "draft-1", revision: 2 }, created_at: "2026-09-22T00:00:00.000Z" },
      ],
    });
    const original = structuredClone(view);
    const cards = researchHistoryCards(view);
    expect(cards).toEqual([{ created_at: view.saved_drafts[1]?.created_at, draft: view.saved_drafts[1] }, { created_at: view.runs[0]?.created_at, entry: view.runs[0] }]);
    expect(view).toEqual(original);
  });

  it("describes only saved history even when current configuration is missing or no runs exist", () => {
    const missingWithSavedDraft = historyView({
      configuration_state: "MISSING",
      saved_drafts: [{ artifact_ref: { id: "draft-1", revision: 1 }, created_at: "2026-09-22T00:00:00.000Z" }],
    });
    const installedWithNoRuns = historyView();

    expect(historyStatusText(missingWithSavedDraft)).toBe("Saved drafts are available below.");
    expect(researchHistoryCards(missingWithSavedDraft)).toEqual([{
      created_at: "2026-09-22T00:00:00.000Z",
      draft: missingWithSavedDraft.saved_drafts[0],
    }]);
    expect(historyStatusText(installedWithNoRuns)).toBe("No saved research runs or drafts are available yet.");
    expect(historyStatusText(installedWithNoRuns)).not.toMatch(/installed|ready/i);
    expect(idleBadgeText(true, false)).toBe("BLOCKED");
  });

  it("keeps a saved draft message separate from a ready or blocked start state", () => {
    const withSavedDraft = historyView({
      saved_drafts: [{ artifact_ref: { id: "draft-1", revision: 1 }, created_at: "2026-09-22T00:00:00.000Z" }],
    });
    const invalidConfiguration = configurationView({
      configuration: "invalid",
      run_readiness: "blocked",
      readiness_reason: "CONFIGURATION_NOT_READY",
      model_route: null,
      qualification_expires_at: null,
      invalid_fields: ["ELIOTR_MODEL_PROFILE"],
    });

    expect(historyStatusText(withSavedDraft)).toBe("Saved drafts are available below.");
    expect(historyStatusText(withSavedDraft)).not.toMatch(/ready|blocked|configuration installed/i);
    expect(researchHistoryCards(withSavedDraft)).toHaveLength(1);
    expect(researchConfigurationViewCopy(invalidConfiguration).summary).toContain("needs attention");
    expect(idleBadgeText(true, false)).toBe("BLOCKED");
    expect(researchConfigurationViewCopy(configurationView()).summary).toContain("ready to start");
    expect(researchConfigurationViewCopy(configurationView({
      qualification_state: "renewal_required",
      run_readiness: "lazy_renewal",
      readiness_reason: "QUALIFICATION_RENEWAL_AT_RUN",
    })).summary).toContain("can start");
  });

  it("gives missing, invalid, expired qualification, unavailable proofs, and transport distinct next steps", () => {
    const missing = researchConfigurationViewCopy(configurationView({
      configuration: "missing",
      run_readiness: "blocked",
      readiness_reason: "CONFIGURATION_NOT_READY",
      model_route: null,
      qualification_expires_at: null,
    }));
    const invalid = researchConfigurationViewCopy(configurationView({
      configuration: "invalid",
      run_readiness: "blocked",
      readiness_reason: "CONFIGURATION_NOT_READY",
      model_route: null,
      qualification_expires_at: null,
      invalid_fields: ["ELIOTR_MODEL_PROFILE"],
    }));
    const expired = researchConfigurationViewCopy(configurationView({
      qualification_state: "renewal_required",
      run_readiness: "blocked",
      readiness_reason: "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
    }));
    const unavailableProof = researchConfigurationViewCopy(configurationView({
      qualification_state: "unavailable",
      run_readiness: "blocked",
      readiness_reason: "QUALIFICATION_UNAVAILABLE",
    }));
    const unavailableTransport = researchConfigurationViewCopy(configurationView({
      model_transport: "unavailable",
      run_readiness: "blocked",
      readiness_reason: "MODEL_TRANSPORT_UNAVAILABLE",
    }));

    expect(missing.summary).toContain("not configured");
    expect(invalid.summary).toContain("needs attention");
    expect(expired.summary).toContain("renewal");
    expect(expired.explanation).toContain("Read token");
    expect(unavailableProof.summary).toContain("readiness could not be established");
    expect(unavailableTransport.summary).toContain("model transport is unavailable");
    expect(unavailableTransport.explanation).toContain("model binding");
  });

  it("distinguishes sign-in loss, resource denial, server failure, and malformed responses", () => {
    const accessDenied = researchConfigurationErrorCopy(apiError(403, "ACCESS_SESSION_REQUIRED"));
    const policyDenied = researchConfigurationErrorCopy(apiError(403, "RESEARCH_READ_DENIED"));
    const unreachable = researchConfigurationErrorCopy(apiError(503, "API_UNREACHABLE"));
    const serverFailure = researchConfigurationErrorCopy(apiError(503, "CONFIGURATION_LOOKUP_FAILED"));
    const malformed = researchConfigurationErrorCopy(apiError(502, "API_RESPONSE_SCHEMA_MISMATCH"));

    expect(researchConfigurationErrorCopy(apiError(401, "OWNER_SESSION_EXPIRED")).summary).toContain("Sign in again");
    expect(accessDenied.summary).toContain("Sign in again");
    expect(policyDenied.summary).toContain("access policy");
    expect(policyDenied.summary).not.toContain("Sign in");
    expect(unreachable.summary).toContain("unavailable");
    expect(unreachable.explanation).toContain("server connection");
    expect(serverFailure.summary).toContain("server could not check");
    expect(malformed.summary).toContain("invalid configuration response");
    expect(malformed.summary).not.toContain("Sign in");
    expect(historyErrorMessage(apiError(403, "RESEARCH_READ_DENIED"))).toContain("access policy");
    expect(message(apiError(403, "RESEARCH_READ_DENIED"))).toContain("access policy");
    expect(wikiProposalErrorText(apiError(403, "WIKI_POLICY_DENIED"))).toContain("access policy");
  });
});
