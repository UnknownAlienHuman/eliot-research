import {
  type ComputerAgentDispatchList,
  type ComputerAgentDispatchSummary,
} from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createComputerAgentDispatchReadApi } from "./computer-agent-dispatch";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const PROJECT_ID = "project-1";
const envelope = (data: unknown, deploymentGeneration = "deploy-1") => ({
  data,
  trace_id: "trace-dispatch-list-1",
  deployment_generation: deploymentGeneration,
});

function summary(
  dispatchId: string,
  state: ComputerAgentDispatchSummary["state"] = "PENDING",
  projectId = PROJECT_ID,
): ComputerAgentDispatchSummary {
  const preview = "User approved question";
  return {
    protocol: "eliotr.computer-agent-dispatch-summary.v2",
    dispatch_id: dispatchId,
    project_id: projectId,
    connection_id: "connection-1",
    connection_revision: 2,
    state,
    created_at: "2026-10-14T12:00:00.000Z",
    expires_at: "2026-10-14T12:10:00.000Z",
    question_preview: preview,
    question_utf8_bytes: new TextEncoder().encode(preview).byteLength,
    question_truncated: false,
    accepted_workflow: state === "ACCEPTED" ? {
      workflow_instance_id: "workflow-1",
      investigation_ref: { id: "investigation-1", revision: 1 },
    } : null,
  };
}

function page(
  items: readonly ComputerAgentDispatchSummary[],
  next: string | null = null,
): ComputerAgentDispatchList {
  return {
    protocol: "eliotr.computer-agent-dispatch-list.v2",
    items: [...items],
    next_after_dispatch_id: next,
  };
}

class LegacyError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly traceId: string | null;
  public readonly retryable: boolean;
  public constructor(details: LegacyErrorDetails) {
    super(details.message);
    this.name = "LegacyError";
    this.status = details.status;
    this.code = details.code;
    this.traceId = details.traceId;
    this.retryable = details.retryable;
  }
}

const errors: LegacyErrorFactory = (details) => new LegacyError(details);
type Responder = (path: string, init: RequestInit | undefined,
  statuses: readonly number[]) => Promise<unknown>;

function liveEpoch() {
  let current = true;
  const stamp = Object.freeze({});
  const epoch: EpochPort = {
    capture: () => current ? stamp : undefined,
    isCurrent: (value) => current && value === stamp,
  };
  return { epoch, close: () => { current = false; } };
}

function makeApi(respond: Responder, options: { readonly epoch?: EpochPort } = {}) {
  const active = options.epoch === undefined ? liveEpoch() : undefined;
  const epoch = options.epoch ?? active?.epoch;
  if (epoch === undefined) throw new Error("test epoch was not initialized");
  const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>(
    async (path, init, statuses) => respond(String(path), init, statuses),
  );
  const api = createComputerAgentDispatchReadApi({ requestApiWithStatuses }, errors, epoch);
  return { api, requestApiWithStatuses, close: active?.close };
}

describe("createComputerAgentDispatchReadApi", () => {
  it("reads the project cursor route and deeply freezes the strict page", async () => {
    const controller = new AbortController();
    const observed = page([
      summary("dispatch-101"),
      summary("dispatch-102", "ACCEPTED"),
    ]);
    const { api, requestApiWithStatuses } = makeApi(async () => envelope(observed));

    const result = await api.readComputerAgentDispatches(
      PROJECT_ID, "deploy-1", "dispatch-100", controller.signal,
    );

    const [path, init, statuses] = requestApiWithStatuses.mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/research/projects/project-1/computer-agent-dispatches?after_dispatch_id=dispatch-100");
    expect(init?.method).toBe("GET");
    expect(init?.signal).toBe(controller.signal);
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
    expect(statuses).toEqual([200]);
    expect(result.items.map((item) => item.dispatch_id)).toEqual(["dispatch-101", "dispatch-102"]);
    expect(result.items[0]?.project_id).toBe(PROJECT_ID);
    expect(result.items[1]?.state).toBe("ACCEPTED");
    expect(result.items[1]?.accepted_workflow).toEqual({
      workflow_instance_id: "workflow-1",
      investigation_ref: { id: "investigation-1", revision: 1 },
    });
    expect(result.items[0]?.question_preview).toBe("User approved question");
    expect(result.items[0]?.question_utf8_bytes).toBe(22);
    expect(result.items[0]?.question_truncated).toBe(false);
    expect(result.items[0]).not.toHaveProperty("question");
    expect(result.items[1]).not.toHaveProperty("scientific_completion");
    expect(result.items[1]).not.toHaveProperty("completed");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(Object.isFrozen(result.items[1]?.accepted_workflow)).toBe(true);
    expect(Object.isFrozen(result.items[1]?.accepted_workflow?.investigation_ref)).toBe(true);
  });

  it("accepts a complete-codepoint V2 preview and preserves its original UTF-8 size", async () => {
    const preview = "🧪".repeat(256);
    expect(new TextEncoder().encode(preview).byteLength).toBe(1024);
    const observed = page([{
      ...summary("dispatch-101"),
      question_preview: preview,
      question_utf8_bytes: 1025,
      question_truncated: true,
    }]);
    const { api } = makeApi(async () => envelope(observed));

    const result = await api.readComputerAgentDispatches(PROJECT_ID, "deploy-1");

    expect(result.items[0]?.question_preview).toBe(preview);
    expect(result.items[0]?.question_utf8_bytes).toBe(1025);
    expect(result.items[0]?.question_truncated).toBe(true);
  });

  it("rejects invalid project, generation, and cursor inputs before HTTP", async () => {
    const { api, requestApiWithStatuses } = makeApi(async () => envelope(page([])));
    await expect(api.readComputerAgentDispatches("bad project", "deploy-1"))
      .rejects.toMatchObject({ code: "COMPUTER_AGENT_DISPATCH_INPUT_INVALID" });
    await expect(api.readComputerAgentDispatches(PROJECT_ID, "bad generation"))
      .rejects.toMatchObject({ code: "COMPUTER_AGENT_DISPATCH_INPUT_INVALID" });
    await expect(api.readComputerAgentDispatches(PROJECT_ID, "deploy-1", "bad cursor"))
      .rejects.toMatchObject({ code: "COMPUTER_AGENT_DISPATCH_INPUT_INVALID" });
    expect(requestApiWithStatuses).not.toHaveBeenCalled();
  });

  it("rejects foreign projects, stale cursors, wrong generations, and unknown fields", async () => {
    const foreignProject = makeApi(async () => envelope(page([summary("dispatch-101", "PENDING", "project-2")])));
    await expect(foreignProject.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const staleCursor = makeApi(async () => envelope(page([summary("dispatch-099")])));
    await expect(staleCursor.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1", "dispatch-100"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const wrongGeneration = makeApi(async () => envelope(page([]), "deploy-2"));
    await expect(wrongGeneration.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_GENERATION_MISMATCH" });

    const unknownItem = makeApi(async () => envelope({
      ...page([summary("dispatch-101")]),
      items: [{ ...summary("dispatch-101"), run_request: { query: "hidden" } }],
    }));
    await expect(unknownItem.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const unknownEnvelope = makeApi(async () => ({ ...envelope(page([])), request_id: "extra" }));
    await expect(unknownEnvelope.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const unsupportedV1 = makeApi(async () => envelope({
      protocol: "eliotr.computer-agent-dispatch-list.v1",
      items: [{
        dispatch_id: "dispatch-101",
        project_id: PROJECT_ID,
        connection_id: "connection-1",
        connection_revision: 2,
        state: "PENDING",
        created_at: "2026-10-14T12:00:00.000Z",
        expires_at: "2026-10-14T12:10:00.000Z",
        question: "User approved question",
        accepted_workflow: null,
        protocol: "eliotr.computer-agent-dispatch-summary.v1",
      }],
      next_after_dispatch_id: null,
    }));
    await expect(unsupportedV1.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const inconsistentPreview = makeApi(async () => envelope({
      ...page([summary("dispatch-101")]),
      items: [{ ...summary("dispatch-101"), question_truncated: true }],
    }));
    await expect(inconsistentPreview.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const acceptedWithoutLocator = makeApi(async () => envelope({
      protocol: "eliotr.computer-agent-dispatch-list.v2",
      items: [{ ...summary("dispatch-101", "ACCEPTED"), accepted_workflow: null }],
      next_after_dispatch_id: null,
    }));
    await expect(acceptedWithoutLocator.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
  });

  it("requires strict ordering and a monotonic next cursor", async () => {
    const outOfOrder = makeApi(async () => envelope(page([
      summary("dispatch-102"), summary("dispatch-101"),
    ])));
    await expect(outOfOrder.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const repeatedCursor = makeApi(async () => envelope(page(
      Array.from({ length: 20 }, (_, index) => summary(`dispatch-${String(index + 1).padStart(3, "0")}`)),
      "dispatch-020",
    )));
    await expect(repeatedCursor.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1", "dispatch-020"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const oversizedPage = makeApi(async () => envelope({
      protocol: "eliotr.computer-agent-dispatch-list.v2",
      items: Array.from({ length: 21 }, (_, index) =>
        summary(`dispatch-${String(index + 1).padStart(3, "0")}`)),
      next_after_dispatch_id: "dispatch-020",
    }));
    await expect(oversizedPage.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const invalidNext = makeApi(async () => envelope(page(
      Array.from({ length: 20 }, (_, index) => summary(`dispatch-${String(index + 101).padStart(3, "0")}`)),
      "dispatch-100",
    )));
    await expect(invalidNext.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1", "dispatch-050"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
  });

  it("cannot dispatch without a current epoch or return a late response after epoch loss", async () => {
    const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>();
    const missingEpoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
    const unavailable = createComputerAgentDispatchReadApi({ requestApiWithStatuses }, errors, missingEpoch);
    await expect(unavailable.readComputerAgentDispatches(PROJECT_ID, "deploy-1"))
      .rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(requestApiWithStatuses).not.toHaveBeenCalled();

    let release: (value: unknown) => void = () => {};
    const gate = new Promise<unknown>((resolve) => { release = resolve; });
    const late = makeApi(async () => gate);
    const pending = late.api.readComputerAgentDispatches(PROJECT_ID, "deploy-1");
    late.close?.();
    release(envelope(page([summary("dispatch-101")])));
    await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
  });

  it("forwards caller cancellation and preserves the transport abort error", async () => {
    const controller = new AbortController();
    const abort = new LegacyError({ code: "API_REQUEST_ABORTED", status: 499,
      message: "Caller interrupted the request", traceId: null, retryable: false });
    const { api, requestApiWithStatuses } = makeApi(async (_path, init) =>
      new Promise<unknown>((_resolve, reject) => {
        expect(init?.signal).toBe(controller.signal);
        init?.signal?.addEventListener("abort", () => reject(abort), { once: true });
      }));
    const pending = api.readComputerAgentDispatches(PROJECT_ID, "deploy-1", undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBe(abort);
    expect(requestApiWithStatuses).toHaveBeenCalledTimes(1);
  });
});
