import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ResearchPackage from "@eliotr/cloudflare-research";
import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  createResearchStageHandlerFactory,
  type ResearchStageHandlerFactoryMode,
} from "./research-stage-handlers.js";

const branchHandlers = vi.hoisted(() => ({
  w2Read: vi.fn(async () => new Uint8Array([1, 2, 3])),
  nativeRead: vi.fn(async () => new Uint8Array([4, 5, 6])),
}));

vi.mock("@eliotr/cloudflare-research", async (importOriginal) => {
  const actual = await importOriginal<typeof ResearchPackage>();
  return {
    ...actual,
    createFreezeProtocolAndScopeStageHandler: vi.fn(() => vi.fn()),
    createResearchBranchExecutionHandlers: vi.fn(() => ({
      read_and_extract: branchHandlers.w2Read,
      read_and_extract_native: branchHandlers.nativeRead,
      analyze_branches: vi.fn(),
      counter_search: vi.fn(),
      recover: vi.fn(),
    })),
  };
});

function mode(generation: string): ResearchStageHandlerFactoryMode {
  return {
    kind: "server-owned-exploratory",
    generation,
    navigation: {} as never,
    ledger: {} as never,
    branch_execution: {} as never,
  } as unknown as ResearchStageHandlerFactoryMode;
}

describe("READ_AND_EXTRACT native handler selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the existing read-only native branch handler for the exact v7 tuple", async () => {
    const factory = createResearchStageHandlerFactory(mode("research-handlers.exploratory.v7"));
    const handler = factory.native("READ_AND_EXTRACT");
    expect(handler).toBeTypeOf("function");
    if (handler === undefined) throw new Error("v7 native adapter is missing");

    const input = {
      request: {
        protocol: "eliotr.workflow-stage.v1",
        operation_id: "authorized-read-adapter",
        investigation_ref: { id: "authorized-read-investigation", revision: 7 },
        stage: "READ_AND_EXTRACT",
        idempotency_key: "authorized-read-adapter-key",
        handler_generation: "research-handlers.exploratory.v7",
        input_manifest: {} as never,
      } as StageRequest,
      principal: {
        principal_ref: "authorized-read-owner",
        credential_generation: "authorized-read-credential",
        deployment_generation: "authorized-read-deployment",
      } as WorkflowPrincipal,
      input_bytes: new Uint8Array(),
    };

    await expect(handler(input)).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(branchHandlers.nativeRead).toHaveBeenCalledOnce();
    expect(branchHandlers.nativeRead).toHaveBeenCalledWith(input);
    expect(branchHandlers.w2Read).not.toHaveBeenCalled();
  });

  it("does not offer the native adapter to the v9 role-query generation", () => {
    const factory = createResearchStageHandlerFactory(mode("research-handlers.exploratory.v9"));
    expect(factory.native("READ_AND_EXTRACT")).toBeUndefined();
  });
});
