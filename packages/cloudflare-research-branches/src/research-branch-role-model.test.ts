import { beforeEach, describe, expect, it, vi } from "vitest";
import { StageRequestSchema } from "@eliotr/cloudflare-workflows";
import type { ResearchBranchRole } from "@eliotr/contracts";
import {
  createResearchBranchRoleModelExecutor,
  deriveBranchRoleStageRequest,
  type ResearchBranchRoleModelDependencies,
  type ResearchBranchRoleModelInput,
} from "./research-branch-role-model.js";
import {
  createResearchModelStageHandler,
  type ResearchModelStageHandler,
  type ResearchModelStageHandlerDependencies,
} from "@eliotr/cloudflare-model-execution";

vi.mock("@eliotr/cloudflare-model-execution", () => ({
  createResearchModelStageHandler: vi.fn(),
}));

const createHandler = vi.mocked(createResearchModelStageHandler);

const REQUEST = StageRequestSchema.parse({
  protocol: "eliotr.workflow-stage.v1",
  operation_id: "op-1",
  investigation_ref: { id: "inv-1", revision: 2 },
  stage: "ANALYZE_BRANCHES",
  idempotency_key: "stage-key",
  handler_generation: "server-owned-branch-v1",
  input_manifest: {
    object_ref: "obj-1",
    sha256: "a".repeat(64),
    byte_length: 10,
    residency: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "conf-1",
      encryption_key_domain_id: "enc-1",
      retention_domain_id: "ret-1",
      erasure_domain_id: "era-1",
      content_digest: { algorithm: "sha256", digest: "a".repeat(64) },
    },
  },
});

const PRINCIPAL = { principal_ref: "principal-1", credential_generation: "cred-1", deployment_generation: "dep-1" };
const PROMPT_SUPPORT = { marker: "support-prompt" };
const PROMPT_COUNTER = { marker: "counter-prompt" };

describe("deriveBranchRoleStageRequest", () => {
  it("scopes the idempotency key per role", () => {
    const derived = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    expect(derived.idempotency_key).toBe("stage-key:branch-role:SUPPORT");
    expect(derived.operation_id).toBe(REQUEST.operation_id);
    expect(derived.stage).toBe(REQUEST.stage);
  });

  it("gives every role a distinct key", () => {
    const support = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const counter = deriveBranchRoleStageRequest(REQUEST, "COUNTER");
    expect(support.idempotency_key).not.toBe(counter.idempotency_key);
  });

  it("is deterministic: a restart replays the same key", () => {
    const first = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const second = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    expect(first.idempotency_key).toBe(second.idempotency_key);
  });

  it("rejects unknown roles", () => {
    expect(() => deriveBranchRoleStageRequest(REQUEST, "NOPE" as never))
      .toThrow();
  });
});

describe("createResearchBranchRoleModelExecutor", () => {
  let createdDeps: ResearchModelStageHandlerDependencies[];
  let handlerInputs: unknown[];
  let prepareCalls: Array<{ context: unknown; role: ResearchBranchRole }>;

  beforeEach(() => {
    vi.clearAllMocks();
    createdDeps = [];
    handlerInputs = [];
    prepareCalls = [];
    createHandler.mockImplementation((dependencies) => {
      createdDeps.push(dependencies);
      const fake: ResearchModelStageHandler = {
        handler: async (input) => {
          handlerInputs.push(input);
          return new TextEncoder().encode("role-output-bytes");
        },
        recoverStartedAttempt: async () => null,
      };
      return fake;
    });
  });

  function dependencies(): ResearchBranchRoleModelDependencies {
    return {
      database: {} as never,
      work_bucket: {} as never,
      gateway: {} as never,
      prompt: ((role: ResearchBranchRole) =>
        (role === "SUPPORT" ? PROMPT_SUPPORT : PROMPT_COUNTER)) as never,
      prepare: (async (context: unknown, role: ResearchBranchRole) => {
        prepareCalls.push({ context, role });
        return { marker: "reservation" };
      }) as never,
      spend_authorization: {} as never,
      pricing: {} as never,
    } as unknown as ResearchBranchRoleModelDependencies;
  }

  function input(role: ResearchBranchRole): ResearchBranchRoleModelInput {
    return {
      role,
      request: REQUEST,
      principal: PRINCIPAL,
      attempt_ref: "attempt-1",
      budget_receipt_ref: "budget-1",
      input_bytes: new Uint8Array(),
    };
  }

  it("creates one handler per role and reuses the cached handler per role", async () => {
    const executor = createResearchBranchRoleModelExecutor(dependencies());
    await executor.executeRole(input("SUPPORT"));
    await executor.executeRole(input("SUPPORT"));
    await executor.executeRole(input("COUNTER"));
    expect(createHandler).toHaveBeenCalledTimes(2);
    expect(handlerInputs).toHaveLength(3);
    const keys = handlerInputs.map(
      (seen) => (seen as { request: { idempotency_key: string } }).request.idempotency_key,
    );
    expect(keys).toEqual([
      "stage-key:branch-role:SUPPORT",
      "stage-key:branch-role:SUPPORT",
      "stage-key:branch-role:COUNTER",
    ]);
  });

  it("returns the handler's raw output bytes", async () => {
    const executor = createResearchBranchRoleModelExecutor(dependencies());
    const bytes = await executor.executeRole(input("SUPPORT"));
    expect(bytes).toEqual(new TextEncoder().encode("role-output-bytes"));
  });

  it("binds the prepare closure to each role so one role's handler never prepares another role", async () => {
    const executor = createResearchBranchRoleModelExecutor(dependencies());
    await executor.executeRole(input("SUPPORT"));
    await executor.executeRole(input("COUNTER"));
    expect(createdDeps).toHaveLength(2);
    const [supportDeps, counterDeps] = createdDeps;
    if (supportDeps === undefined || counterDeps === undefined) {
      throw new Error("expected one handler per role");
    }
    const context = { marker: "context" };
    await supportDeps.prepare(context as never);
    await counterDeps.prepare(context as never);
    expect(prepareCalls).toEqual([
      { context, role: "SUPPORT" },
      { context, role: "COUNTER" },
    ]);
  });

  it("installs the per-role prompt compiler dependencies", async () => {
    const executor = createResearchBranchRoleModelExecutor(dependencies());
    await executor.executeRole(input("SUPPORT"));
    await executor.executeRole(input("COUNTER"));
    expect(createdDeps).toHaveLength(2);
    const [supportDeps, counterDeps] = createdDeps;
    if (supportDeps === undefined || counterDeps === undefined) {
      throw new Error("expected one handler per role");
    }
    expect(supportDeps.prompt).toBe(PROMPT_SUPPORT);
    expect(counterDeps.prompt).toBe(PROMPT_COUNTER);
  });
});
