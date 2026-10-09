import { afterEach, describe, expect, it, vi } from "vitest";
import * as httpClient from "@eliotr/pwa-http-client";
import { ApiRequestError } from "@eliotr/pwa-http-client";
import { createResearchConnection } from "./research-run-connection.js";
import {
  decodeResearchArtifactDraftReauthorization,
  decodeResearchRunStatus,
  readResearchRunStatus,
  researchRunBody,
  startResearchRun,
} from "./research-run-api.js";

// C0.3 legacy characterization of the current HTTP run wire plus one lifecycle guard test.
// It freezes accepted behavior, records the current epoch gap, and drives the real
// createResearchConnection guard. It invokes no ResearchSession projection, chat, history frame
// or transcript.

const generation = "deployment-1";
const workflow = `run-${"a".repeat(48)}`;
const investigation = { id: `research-${"b".repeat(48)}`, revision: 1 };
const artifactRef = { id: "artifact-report-1", revision: 1 };

function envelope(data: Record<string, unknown>, generationValue = generation): Response {
  return new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generationValue }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

function status(state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED" = "ENGINE_COMPLETED"): Record<string, unknown> {
  return { protocol: "eliotr.research-run-status.v1", workflow_instance_id: workflow, investigation_ref: investigation,
    execution_state: state, next_stage_index: state === "ENGINE_COMPLETED" ? 18 : 3, answer: { availability: "unavailable" } };
}

function failureBody(): Record<string, unknown> {
  return { code: "MODEL_ATTEMPT_INPUT_INVALID", stage: "RETRIEVE_BRANCHES" };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("C0.3 research run identity and mutation identity", () => {
  it("freezes the server-owned run body and the idempotency identity per call", async () => {
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      expect(init).toBeDefined();
      return path === "/api/v1/research/run"
        ? envelope({ investigation_ref: investigation, workflow_instance_id: workflow })
        : envelope(status());
    });
    vi.stubGlobal("fetch", fetch);
    const body = researchRunBody("What changed?", ["source-1"]);
    await expect(startResearchRun(body, "run-key", generation)).resolves.toMatchObject({ workflow_instance_id: workflow });
    await expect(startResearchRun(body, "other-key", generation)).resolves.toMatchObject({ workflow_instance_id: workflow });
    const posts = fetch.mock.calls.filter((call) => call[0] === "/api/v1/research/run")
      .map((call) => (call[1] as RequestInit).headers as Record<string, string>);
    expect(posts.map((headers) => headers["idempotency-key"])).toEqual(["run-key", "other-key"]);
    expect(posts.every((headers) => headers["content-type"] === "application/json")).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/v1/research/run", expect.objectContaining({ method: "POST" }));
  });
});

describe("C0.3 run completion is not artifact acceptance", () => {
  it("accepts ENGINE_COMPLETED with no answer and refuses to invent an artifact", () => {
    const view = decodeResearchRunStatus({ data: status(), trace_id: "trace-1", deployment_generation: generation }, generation);
    expect(view.execution_state).toBe("ENGINE_COMPLETED");
    expect(view.answer).toEqual({ availability: "unavailable" });
    expect(view).not.toHaveProperty("artifact_ref");
    const draft = status();
    draft.answer = { availability: "draft", artifact_ref: artifactRef };
    expect(decodeResearchRunStatus({ data: draft, trace_id: "trace-1", deployment_generation: generation }, generation).answer)
      .toEqual({ availability: "draft", artifact_ref: artifactRef });
  });
});

describe("C0.3 currentness fails closed on a late generation", () => {
  it("rejects a foreign generation on decode and on transport read", async () => {
    expect(() => decodeResearchRunStatus({ data: status(), trace_id: "trace-1", deployment_generation: "deployment-2" }, generation))
      .toThrowError(/Application changed/);
    const fetch = vi.fn(async () => envelope(status(), "deployment-2"));
    vi.stubGlobal("fetch", fetch);
    await expect(readResearchRunStatus(workflow, generation)).rejects.toMatchObject({
      status: 409, code: "RESEARCH_RUN_DEPLOYMENT_CHANGED",
    });
    await expect(readResearchRunStatus(workflow, generation)).rejects.toBeInstanceOf(ApiRequestError);
    expect(fetch).toHaveBeenCalledWith(`/api/v1/research/run/${workflow}`, expect.anything());
  });
});

describe("C0.3 failure cause is immutable and typed", () => {
  it("binds failure to an errored active run and rejects an out-of-range stage index", () => {
    const active = status("ACTIVE");
    active.engine_status = "errored";
    active.failure = failureBody();
    const view = decodeResearchRunStatus({ data: active, trace_id: "trace-1", deployment_generation: generation }, generation);
    expect(view.failure?.code).toBe("MODEL_ATTEMPT_INPUT_INVALID");
    expect(view.failure).not.toHaveProperty("consequence");
    const overflow = status("ACTIVE");
    overflow.engine_status = "errored";
    overflow.next_stage_index = 19;
    overflow.failure = failureBody();
    expect(() => decodeResearchRunStatus({ data: overflow, trace_id: "trace-1", deployment_generation: generation })).toThrow(ApiRequestError);
    const terminal = status("ENGINE_COMPLETED");
    terminal.failure = failureBody();
    expect(() => decodeResearchRunStatus({ data: terminal, trace_id: "trace-1", deployment_generation: generation })).toThrow(ApiRequestError);
  });
});

describe("C0.3 draft reauthorization identity", () => {
  it("rejects reauthorization identity drift and a foreign generation", () => {
    const artifact = {
      artifact_ref: artifactRef,
      spec_ref: { id: "spec-1", revision: 1 },
      spec_digest: "b".repeat(64),
      evidence_freeze_ref: { id: "freeze-1", revision: 1 },
      sections: [{ section_ref: { id: "section-intro", revision: 1 }, contract_id: "contract-1",
        body_object_ref: "report-1/section-intro.md", body_sha256: "c".repeat(64),
        statement_labels: {}, evidence_ledger_ref: "ledger-1", verification_receipt_ref: "receipt-1" }],
      dependency_manifest_ref: "manifest-1",
      deterministic_export_refs: {},
      status: "DRAFT",
      created_at: "2026-10-09T12:00:00.000Z",
    };
    const draft = {
      protocol: "eliotr.artifact-draft-reauthorization.v2",
      artifact_ref: artifactRef,
      artifact,
      original_scope_snapshot_ref: { id: "scope-1", revision: 1 },
      authorization_scope_snapshot_ref: { id: "scope-1", revision: 1 },
      authorization: { authorization_receipt_ref: "receipt-1", policy_authority_ref: "policy-1",
        allowed_use: ["OWNER_DISPLAY"], disclosure_ceiling: "owner", expires_at: "2026-10-10T12:00:00.000Z" },
      source_freshness: { state: "CURRENT_REVISIONS", checked_at: "2026-10-09T12:00:00.000Z", changed_sources: [] },
      deployment_generation: generation,
    };
    const decode = (raw: unknown, expected: unknown, generationValue: string): unknown =>
      decodeResearchArtifactDraftReauthorization(raw, expected as { readonly id: string; readonly revision: number }, generationValue);
    expect(decode({ data: draft, trace_id: "trace-1", deployment_generation: generation }, artifactRef, generation))
      .toMatchObject({ artifact_ref: artifactRef });
    const drifted = { ...draft, artifact_ref: { id: "artifact-report-2", revision: 1 } };
    expect(() => decode({ data: drifted, trace_id: "trace-1", deployment_generation: generation }, artifactRef, generation))
      .toThrow(ApiRequestError);
    expect(() => decode({ data: draft, trace_id: "trace-1", deployment_generation: "deployment-2" }, artifactRef, generation))
      .toThrowError(/Application changed/);
  });
});

describe("C0.3 mandatory lifecycle negative: an old session cannot become current", () => {
  it("drops a resolved old-epoch session after dispose and keeps protected state closed", async () => {
    // Mock transport only for this lifecycle test; the decoder characterization above runs against
    // the real legacy module. This exercises the actual serial/aborted guard at
    // research-run-connection.ts lines 54-56 rather than documenting a decoder gap.
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("document", { visibilityState: "visible" });
    let settle: ((session: Awaited<ReturnType<typeof httpClient.readOwnerSession>>) => void) | undefined;
    const readOwnerSession = vi.spyOn(httpClient, "readOwnerSession")
      .mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    let ready = true;
    const connection = createResearchConnection({
      generation: () => generation,
      healthReady: () => ready,
      changed: () => undefined,
      suspended: () => { ready = false; },
      denied: () => undefined,
    });

    const refresh = connection.refresh();
    await Promise.resolve();
    expect(readOwnerSession).toHaveBeenCalledTimes(1);
    expect(connection.checking).toBe(true);

    // Dispose before the same-generation session from the old lifecycle resolves.
    connection.dispose();
    expect(connection.ready).toBe(false);

    // Late arrival of a valid same-generation session from the disposed epoch.
    settle?.({ principal_ref: "principal-1", credential_generation: "cred-1",
      expires_at: "2026-10-10T12:00:00.000Z", client_class: "owner_pwa" });
    await expect(refresh).resolves.toBe(false);

    expect(connection.ready).toBe(false);
    expect(connection.hasIdentity).toBe(false);
    expect(connection.checking).toBe(false);
    expect(readOwnerSession).toHaveBeenCalledTimes(1);
  });

  it("drops a resolved old-epoch session after reset", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("document", { visibilityState: "visible" });
    let settle: ((session: Awaited<ReturnType<typeof httpClient.readOwnerSession>>) => void) | undefined;
    const readOwnerSession = vi.spyOn(httpClient, "readOwnerSession")
      .mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    let ready = true;
    const connection = createResearchConnection({
      generation: () => generation,
      healthReady: () => ready,
      changed: () => undefined,
      suspended: () => { ready = false; },
      denied: () => undefined,
    });

    const refresh = connection.refresh();
    await Promise.resolve();
    connection.reset();
    settle?.({ principal_ref: "principal-1", credential_generation: "cred-1",
      expires_at: "2026-10-10T12:00:00.000Z", client_class: "owner_pwa" });
    await expect(refresh).resolves.toBe(false);

    expect(connection.ready).toBe(false);
    expect(connection.hasIdentity).toBe(false);
    expect(readOwnerSession).toHaveBeenCalledTimes(1);
  });
});
