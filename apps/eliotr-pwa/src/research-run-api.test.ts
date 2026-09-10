import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactSectionRevision } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { decodeResearchRunStatus, readResearchArtifactSection, researchRunBody, readResearchRunStatus, startResearchRun } from "./research-run-api.js";

const generation = "deployment-1";
const workflow = `run-${"a".repeat(48)}`;

function envelope(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }), { status: 200, headers: { "content-type": "application/json" } });
}

function status(state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED" = "ENGINE_COMPLETED"): Record<string, unknown> {
  return { protocol: "eliotr.research-run-status.v1", workflow_instance_id: workflow, investigation_ref: { id: `research-${"b".repeat(48)}`, revision: 1 }, execution_state: state, next_stage_index: state === "ENGINE_COMPLETED" ? 18 : 3, answer: { availability: "unavailable" } };
}

afterEach(() => vi.unstubAllGlobals());

describe("research run transport", () => {
  it("builds the server-owned run DTO and reads status through the owner route", async () => {
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => path === "/api/v1/research/run" ? envelope({ investigation_ref: { id: `research-${"b".repeat(48)}`, revision: 1 }, workflow_instance_id: workflow }) : envelope(status()));
    vi.stubGlobal("fetch", fetch);
    const body = JSON.parse(researchRunBody("What changed?", ["source-1"]));
    expect(body).toMatchObject({ product: "RESEARCH", budget_ref: "research-budget-v1", max_results: 16, scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] } });
    await expect(startResearchRun(JSON.stringify(body), "run-key", generation)).resolves.toMatchObject({ workflow_instance_id: workflow });
    await expect(readResearchRunStatus(workflow, generation)).resolves.toMatchObject({ execution_state: "ENGINE_COMPLETED", answer: { availability: "unavailable" } });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/v1/research/run", expect.objectContaining({ method: "POST" }));
    expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify(body), headers: expect.objectContaining({ "content-type": "application/json", "idempotency-key": "run-key" }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/v1/research/run/${workflow}`, expect.anything());
  });

  it("rejects answer claims, foreign generation, and malformed workflow IDs", async () => {
    const bad = status(); bad.answer = { availability: "available" };
    expect(() => decodeResearchRunStatus({ data: bad, trace_id: "trace-1", deployment_generation: generation })).toThrow(ApiRequestError);
    expect(() => decodeResearchRunStatus({ data: status(), trace_id: "trace-1", deployment_generation: "deployment-2" }, generation)).toThrowError(/Application changed/);
    const cancelled = status("CANCELLED"); cancelled.cancellation_receipt_ref = `workflow-cancelled:${workflow}`;
    expect(decodeResearchRunStatus({ data: cancelled, trace_id: "trace-1", deployment_generation: generation }, generation).execution_state).toBe("CANCELLED");
    const activeAtTerminal = status("ACTIVE"); activeAtTerminal.next_stage_index = 18;
    expect(() => decodeResearchRunStatus({ data: activeAtTerminal, trace_id: "trace-1", deployment_generation: generation })).toThrow(ApiRequestError);
    await expect(readResearchRunStatus("../foreign", generation)).rejects.toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });
  });

  it("accepts only a completed server-bound draft artifact", () => {
    const draft = status();
    draft.answer = { availability: "draft", artifact_ref: { id: "artifact-report-1", revision: 1 } };
    expect(decodeResearchRunStatus({ data: draft, trace_id: "trace-1", deployment_generation: generation }, generation).answer)
      .toEqual({ availability: "draft", artifact_ref: { id: "artifact-report-1", revision: 1 } });
    const active = status("ACTIVE");
    active.answer = { availability: "draft", artifact_ref: { id: "artifact-report-1", revision: 1 } };
    expect(() => decodeResearchRunStatus({ data: active, trace_id: "trace-1", deployment_generation: generation })).toThrow(ApiRequestError);
  });

  it("opens a declared draft section only when headers and bytes match", async () => {
    const artifactRef = { id: "artifact-report-1", revision: 1 };
    const sectionRef = { id: "section-intro", revision: 1 };
    const bytes = new TextEncoder().encode("# Draft report\n");
    const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", owned))].map((part) => part.toString(16).padStart(2, "0")).join("");
    const section: ArtifactSectionRevision = {
      section_ref: sectionRef,
      contract_id: "intro",
      body_object_ref: "artifact-draft/section/section-intro:1",
      body_sha256: digest,
      statement_labels: { statement: "SOURCE_SUPPORTED" },
      evidence_ledger_ref: "ledger-1",
      verification_receipt_ref: "verification-1",
    };
    const fetch = vi.fn(async () => new Response(bytes, { status: 200, headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "x-eliotr-artifact-ref": encodeURIComponent("artifact-report-1:1"),
      "x-eliotr-section-ref": encodeURIComponent("section-intro:1"),
      "x-eliotr-section-object-ref": encodeURIComponent(section.body_object_ref),
      "x-eliotr-section-sha256": digest,
    } }));
    vi.stubGlobal("fetch", fetch);
    await expect(readResearchArtifactSection(artifactRef, section)).resolves.toMatchObject({ artifact_ref: artifactRef, section_ref: sectionRef, body_object_ref: section.body_object_ref, body_sha256: digest, size_bytes: bytes.byteLength, bytes });
    expect(fetch).toHaveBeenCalledWith("/api/v1/research/artifact/artifact-report-1%3A1/sections/section-intro%3A1", expect.anything());
    fetch.mockImplementationOnce(async () => new Response(bytes, { status: 200, headers: {
      "content-type": "application/octet-stream", "content-length": String(bytes.byteLength),
      "x-eliotr-artifact-ref": encodeURIComponent("artifact-report-1:1"), "x-eliotr-section-ref": encodeURIComponent("section-intro:1"),
      "x-eliotr-section-object-ref": encodeURIComponent(section.body_object_ref), "x-eliotr-section-sha256": "0".repeat(64),
    } }));
    await expect(readResearchArtifactSection(artifactRef, section)).rejects.toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });
  });
});
