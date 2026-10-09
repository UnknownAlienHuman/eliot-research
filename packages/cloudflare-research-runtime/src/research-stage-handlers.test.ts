import { describe, expect, it, vi } from "vitest";
import type * as CloudflareResearch from "@eliotr/cloudflare-research";

const readWorkflowObjectMock = vi.hoisted(() => vi.fn());

vi.mock("@eliotr/cloudflare-research", async (importOriginal) => {
  const actual = await importOriginal<typeof CloudflareResearch>();
  return {
    ...actual,
    decodeProtocolScopeCheckpoint: (bytes: Uint8Array) => ({
      protocol_profile: { source_mode: new TextDecoder().decode(bytes) },
    } as ReturnType<typeof actual.decodeProtocolScopeCheckpoint>),
    readWorkflowObject: readWorkflowObjectMock,
  };
});

import {
  createResearchStageHandlerFactory,
  SERVER_OWNED_PROTOCOL_HANDLER_GENERATION,
  type ResearchStageHandlerFactoryMode,
} from "./research-stage-handlers.js";

type AcquisitionRoute = NonNullable<Extract<ResearchStageHandlerFactoryMode, {
  readonly kind: "server-owned-exploratory";
}>["acquisition_route"]>;

function factoryFor(acquisition_route: AcquisitionRoute, withEnvironment = false) {
  return createResearchStageHandlerFactory({
    kind: "server-owned-exploratory",
    generation: SERVER_OWNED_PROTOCOL_HANDLER_GENERATION,
    navigation: {} as never,
    ledger: {} as never,
    ...(withEnvironment ? { environment: { WORK_BUCKET: {} } as never } : {}),
    acquisition_route,
  });
}

function stageInput(sourceMode = "corpus_only") {
  return {
    request: {
      operation_id: "research-op-1",
      stage: "ACQUIRE_AND_CAPTURE",
      handler_generation: SERVER_OWNED_PROTOCOL_HANDLER_GENERATION,
    } as never,
    principal: {} as never,
    input_bytes: new TextEncoder().encode(sourceMode),
    attempt_ref: "attempt-1",
    budget_receipt_ref: "budget-1",
  } as never;
}

describe("ACQUIRE_AND_CAPTURE stage route", () => {
  it("keeps an explicit corpus-only selection on the deterministic zero-call path", async () => {
    const forbiddenWebHandler = vi.fn(async () => new Uint8Array([9]));
    const handler = factoryFor({ source_mode: "corpus_only", handler: forbiddenWebHandler })("ACQUIRE_AND_CAPTURE");

    const output = await handler(stageInput());

    expect(output).toBeInstanceOf(Uint8Array);
    expect(forbiddenWebHandler).not.toHaveBeenCalled();
  });

  it("rejects a frozen source mode that differs from the installed corpus-only selection on execution and recovery", async () => {
    const forbiddenWebHandler = vi.fn(async () => new Uint8Array([9]));
    const route = { source_mode: "corpus_only", handler: forbiddenWebHandler } as const;
    const handler = factoryFor(route)("ACQUIRE_AND_CAPTURE");
    await expect(Promise.resolve().then(() => handler(stageInput("web_discovery"))))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(forbiddenWebHandler).not.toHaveBeenCalled();

    readWorkflowObjectMock.mockResolvedValueOnce(new TextEncoder().encode("web_discovery"));
    const recovery = factoryFor(route, true).recoverStartedAttempt;
    await expect(recovery?.({
      request: {
        operation_id: "research-op-1",
        stage: "ACQUIRE_AND_CAPTURE",
        handler_generation: SERVER_OWNED_PROTOCOL_HANDLER_GENERATION,
        input_manifest: {},
      },
      attempt_ref: "attempt-1",
    } as never)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(forbiddenWebHandler).not.toHaveBeenCalled();
  });

  it("fails before dispatch when a selected web mode has no composed handler", async () => {
    const handler = factoryFor({ source_mode: "corpus_plus_web" })("ACQUIRE_AND_CAPTURE");

    await expect(handler(stageInput())).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_MISSING" });
  });

  it("passes the existing Workflow attempt identity to the composed web route", async () => {
    const input = stageInput();
    const output = new Uint8Array([7]);
    const webHandler = vi.fn(async () => output);
    const handler = factoryFor({ source_mode: "web_discovery", handler: webHandler })("ACQUIRE_AND_CAPTURE");

    await expect(handler(input)).resolves.toBe(output);
    expect(webHandler).toHaveBeenCalledOnce();
    expect(webHandler).toHaveBeenCalledWith(input);
  });

  it("uses only the supplied readback during recovery and never invokes the web handler", async () => {
    const webHandler = vi.fn(async () => new Uint8Array([7]));
    const recoveryBytes = new Uint8Array([8]);
    const recoverStartedAttempt = vi.fn(async () => recoveryBytes);
    const factory = factoryFor({ source_mode: "web_discovery", handler: webHandler, recoverStartedAttempt });
    const recoveryInput = {
      request: {
        operation_id: "research-op-1",
        stage: "ACQUIRE_AND_CAPTURE",
        handler_generation: SERVER_OWNED_PROTOCOL_HANDLER_GENERATION,
      },
      attempt_ref: "attempt-1",
    } as never;

    await expect(factory.recoverStartedAttempt?.(recoveryInput)).resolves.toBe(recoveryBytes);
    expect(recoverStartedAttempt).toHaveBeenCalledOnce();
    expect(recoverStartedAttempt).toHaveBeenCalledWith(recoveryInput);
    expect(webHandler).not.toHaveBeenCalled();
  });

  it("leaves a started web attempt uncertain when exact readback is unavailable", async () => {
    const webHandler = vi.fn(async () => new Uint8Array([7]));
    const factory = factoryFor({ source_mode: "web_discovery", handler: webHandler });
    const recoveryInput = {
      request: {
        operation_id: "research-op-1",
        stage: "ACQUIRE_AND_CAPTURE",
        handler_generation: SERVER_OWNED_PROTOCOL_HANDLER_GENERATION,
      },
      attempt_ref: "attempt-1",
    } as never;

    await expect(factory.recoverStartedAttempt?.(recoveryInput)).resolves.toBeNull();
    expect(webHandler).not.toHaveBeenCalled();
  });
});
