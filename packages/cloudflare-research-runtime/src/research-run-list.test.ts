import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import { readHistoricalResearchArtifactLocator } from "@eliotr/cloudflare-research-stages";
import { readOwnerResearchRuns, type ResearchRunListPorts } from "./research-run-list.js";
import { prepareReauthenticatedRunRead } from "./research-run-read-authorization.js";
import type { ResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import type * as RunReadAuthorization from "./research-run-read-authorization.js";
import type * as ResearchStages from "@eliotr/cloudflare-research-stages";

const { prepareReadMock, historicalLocatorMock } = vi.hoisted(() => ({
  prepareReadMock: vi.fn(),
  historicalLocatorMock: vi.fn(),
}));

vi.mock("./research-run-read-authorization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunReadAuthorization>();
  return { ...actual, prepareReauthenticatedRunRead: prepareReadMock };
});

vi.mock("@eliotr/cloudflare-research-stages", async (importOriginal) => {
  const actual = await importOriginal<typeof ResearchStages>();
  return { ...actual, readHistoricalResearchArtifactLocator: historicalLocatorMock };
});

const context = {
  principal_ref: "owner-1",
  client_class: "owner_pwa",
  credential_generation: "credential-1",
  request: new Request("https://owner.invalid/api/v1/research/runs"),
} as unknown as AuthenticatedRequestContext;

function workflowStatus(operationId: string) {
  return {
    operation_id: operationId,
    investigation_id: `investigation-${operationId}`,
    current_revision: 4,
    state: "ENGINE_COMPLETED",
    next_stage_index: 18,
    cancellation_receipt_ref: null,
  };
}

function makePorts(input: {
  runRows?: readonly { operation_id: string; created_at: string; query: unknown; scope_expression?: unknown }[];
  draftRows?: readonly Record<string, unknown>[];
  workflowBindingRows?: readonly Record<string, unknown>[];
  projectGeneration?: number;
} = {}) {
  let historySql = "";
  const database = {
    prepare(query: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            all: async <T>() => {
              if (query.includes("FROM research_workflow_run r") && query.includes("investigation_ledger_head")) {
                historySql = query;
                return { success: true, results: [...(input.runRows ?? [])] as T[] };
              }
              if (query.includes("FROM artifact_draft_binding b")) {
                return { success: true, results: [...(input.draftRows ?? [])] as T[] };
              }
              if (query.includes("FROM research_report_admission r")) {
                return { success: true, results: [...(input.workflowBindingRows ?? [])] as T[] };
              }
              return { success: true, results: [] as T[] };
            },
            first: async <T>() => query.includes("SELECT p.generation") && input.projectGeneration !== undefined
              ? { generation: input.projectGeneration } as T : null,
          };
        },
      };
    },
  } as unknown as D1Database;
  const run_status = vi.fn(async (_actor: AuthenticatedRequestContext, operationId: string): Promise<ResearchRunStatus> => ({
    protocol: "eliotr.research-run-status.v1", workflow_instance_id: operationId,
    investigation_ref: { id: `investigation-${operationId}`, revision: 4 }, execution_state: "ACTIVE",
    engine_status: "errored", next_stage_index: 3, answer: { availability: "unavailable" },
  }));
  const prepare_artifact_read = vi.fn(async () => ({
    original_scope_snapshot_ref: { id: "scope-1", revision: 2 },
    requireCurrent: async () => undefined,
  }));
  const ports = {
    database,
    work_bucket: {} as R2Bucket,
    deployment_generation: "deployment-1",
    run_read: { database } as ResearchRunReadEnvironment,
    authorize_owner_read: vi.fn(),
    run_status,
    prepare_artifact_read,
    reopen_owner_artifact_draft: vi.fn(async () => { throw new Error("draft reopen is outside this locator test"); }),
    semantic_configuration_installed: () => true,
  } satisfies ResearchRunListPorts;
  return { ports, run_status, prepare_artifact_read, getHistorySql: () => historySql };
}

describe("owner research history", () => {
  beforeEach(() => {
    prepareReadMock.mockReset();
    historicalLocatorMock.mockReset();
  });

  it("uses reauthenticated metadata for historical runs and retains valid history metadata", async () => {
    const question = "How did the saved source revisions change this evidence?";
    const rows = [
      { operation_id: "current-run", created_at: "2026-10-15T12:01:00.000Z", query: question },
      { operation_id: "legacy-run", created_at: "2026-10-15T12:00:00.000Z", query: null },
    ];
    const { ports, run_status, getHistorySql } = makePorts({ runRows: rows });
    prepareReadMock.mockImplementation(async (_environment, _requestContext, operationId: string) => ({
      status: workflowStatus(operationId), requireCurrent: async () => undefined,
    }));

    const history = await readOwnerResearchRuns(ports, context);

    expect(run_status).not.toHaveBeenCalled();
    expect(prepareReauthenticatedRunRead).toHaveBeenCalledTimes(2);
    expect(history.runs).toHaveLength(2);
    expect(history.runs[0]).toMatchObject({
      created_at: rows[0]?.created_at, query: question,
      status: { workflow_instance_id: "current-run", execution_state: "ENGINE_COMPLETED" },
    });
    expect(history.runs[1]).toMatchObject({
      created_at: rows[1]?.created_at, status: { workflow_instance_id: "legacy-run" },
    });
    expect(history.runs[1]).not.toHaveProperty("query");
    expect(getHistorySql()).toContain("LEFT JOIN investigation_ledger_head");
    expect(getHistorySql()).not.toContain("research_deployment_compatible");
  });

  it("uses the canonical direct status port when current owner reauthentication is unnecessary", async () => {
    const { ports, run_status } = makePorts({ runRows: [
      { operation_id: "current-run", created_at: "2026-10-15T12:01:00.000Z", query: "Authorized current question" },
    ] });
    prepareReadMock.mockResolvedValue(null);

    const history = await readOwnerResearchRuns(ports, context);

    expect(run_status).toHaveBeenCalledTimes(2);
    expect(run_status).toHaveBeenCalledWith(context, "current-run");
    expect(history.runs).toEqual([expect.objectContaining({
      query: "Authorized current question",
      status: expect.objectContaining({ workflow_instance_id: "current-run", engine_status: "errored" }),
    })]);
  });

  it("omits denied direct-owner candidates without disclosing their questions", async () => {
    const { ports, run_status } = makePorts({ runRows: [
      { operation_id: "denied-run", created_at: "2026-10-15T12:01:00.000Z", query: "Sensitive denied question" },
    ] });
    prepareReadMock.mockResolvedValue(null);
    run_status.mockRejectedValue(new CatalogInputError("RESEARCH_AUTHORITY_STALE", "denied", 409));

    const history = await readOwnerResearchRuns(ports, context);

    expect(history.runs).toEqual([]);
    expect(JSON.stringify(history)).not.toContain("Sensitive denied question");
    expect(run_status).toHaveBeenCalledTimes(1);
  });

  it("fails the whole result when a selected direct-owner run loses read rights before disclosure", async () => {
    const { ports, run_status } = makePorts({ runRows: [
      { operation_id: "current-run", created_at: "2026-10-15T12:01:00.000Z", query: "No late disclosure" },
    ] });
    prepareReadMock.mockResolvedValue(null);
    const status = await run_status(context, "current-run");
    run_status.mockClear();
    const denial = new CatalogInputError("RESEARCH_AUTHORITY_STALE", "revoked", 409);
    run_status.mockResolvedValueOnce(status).mockRejectedValueOnce(denial);

    await expect(readOwnerResearchRuns(ports, context)).rejects.toBe(denial);
    expect(run_status).toHaveBeenCalledTimes(2);
  });

  it("preserves canonical project filtering before any question or run read", async () => {
    const { ports, run_status } = makePorts({ projectGeneration: 1, runRows: [
      { operation_id: "excluded-run", created_at: "2026-10-15T12:02:00.000Z", query: "Excluded project question",
        scope_expression: { kind: "EXCEPT", left: { kind: "PROJECT", project_id: "other-project" },
          right: { kind: "PROJECT", project_id: "selected-project" } } },
      { operation_id: "selected-run", created_at: "2026-10-15T12:01:00.000Z", query: "Selected project question",
        scope_expression: { kind: "PROJECT", project_id: "selected-project" } },
    ] });
    prepareReadMock.mockResolvedValue(null);

    const history = await readOwnerResearchRuns(ports, context, "selected-project");

    expect(history.runs.map(row => row.status.workflow_instance_id)).toEqual(["selected-run"]);
    expect(prepareReadMock).toHaveBeenCalledTimes(1);
    expect(run_status).not.toHaveBeenCalledWith(context, "excluded-run");
    expect(JSON.stringify(history)).not.toContain("Excluded project question");
  });

  it("fails the whole history response when a selected run loses current authority", async () => {
    const { ports, run_status } = makePorts({ runRows: [
      { operation_id: "revoked-run", created_at: "2026-10-15T12:01:00.000Z", query: "Current query" },
    ] });
    const revoked = new Error("current authority was revoked");
    const requireCurrent = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(revoked);
    prepareReadMock.mockResolvedValue({ status: workflowStatus("revoked-run"), requireCurrent });

    await expect(readOwnerResearchRuns(ports, context)).rejects.toBe(revoked);
    expect(requireCurrent).toHaveBeenCalledTimes(2);
    expect(run_status).not.toHaveBeenCalled();
  });

  it("overlaps eight candidate reads while retaining SQL order after reverse completion", async () => {
    const rows = Array.from({ length: 8 }, (_item, index) => ({ operation_id: `run-${index}`,
      created_at: `2026-10-15T12:0${7 - index}:00.000Z`, query: `Question ${index}` }));
    const { ports } = makePorts({ runRows: rows });
    const gates = rows.map(() => Promise.withResolvers<void>());
    const allStarted = Promise.withResolvers<void>();
    let started = 0;
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => {
      const index = rows.findIndex(row => row.operation_id === operationId);
      if (++started === 8) allStarted.resolve();
      await gates[index]?.promise;
      return { status: workflowStatus(operationId), requireCurrent: async () => undefined };
    });
    let completed = false;
    const response = readOwnerResearchRuns(ports, context).then(value => { completed = true; return value; });
    await allStarted.promise;
    expect(completed).toBe(false);
    for (const gate of [...gates].reverse()) gate.resolve();
    const history = await response;
    expect(history.runs.map(row => row.status.workflow_instance_id)).toEqual(rows.map(row => row.operation_id));
    expect(history.visibility_scan.runs).toBe("TARGET_REACHED");
    expect(prepareReadMock).toHaveBeenCalledTimes(8);
  });

  it("overlaps saved-report reads and preserves report order after reverse completion", async () => {
    const rows = Array.from({ length: 8 }, (_item, index) => ({ artifact_id: `draft-${index}`, revision: 1,
      scope_snapshot_id: "scope-1", scope_snapshot_revision: 2, origin_client_class: "owner_pwa", principal_ref: "owner-1",
      intent_id: `intent-${index}`, intent_revision: 1, created_at: `2026-10-15T12:0${7 - index}:00.000Z` }));
    const { ports } = makePorts({ draftRows: rows });
    const gates = rows.map(() => Promise.withResolvers<void>());
    const allStarted = Promise.withResolvers<void>();
    let started = 0;
    const prepareDraft: ResearchRunListPorts["prepare_artifact_read"] = async (_actor, ref) => {
      const index = rows.findIndex(row => row.artifact_id === ref.id);
      if (++started === 8) allStarted.resolve();
      await gates[index]?.promise;
      return { original_scope_snapshot_ref: { id: "scope-1", revision: 2 }, requireCurrent: async () => undefined };
    };
    const response = readOwnerResearchRuns({ ...ports, prepare_artifact_read: prepareDraft }, context);
    await allStarted.promise;
    for (const gate of [...gates].reverse()) gate.resolve();
    const history = await response;
    expect(history.saved_drafts.map(row => row.artifact_ref.id)).toEqual(rows.map(row => row.artifact_id));
    expect(history.visibility_scan.saved_drafts).toBe("TARGET_REACHED");
  });

  it("waits for concurrent final direct/historical fences and fails the response on revocation", async () => {
    const { ports, run_status } = makePorts({ runRows: [
      { operation_id: "direct-run", created_at: "2026-10-15T12:01:00.000Z", query: "Private direct question" },
      { operation_id: "historical-run", created_at: "2026-10-15T12:00:00.000Z", query: "Private old question" },
    ] });
    const directFence = Promise.withResolvers<void>();
    const historyFence = Promise.withResolvers<void>();
    const allFinalStarted = Promise.withResolvers<void>();
    let finalStarted = 0;
    const finalCheck = async (gate: Promise<void>) => {
      if (++finalStarted === 2) allFinalStarted.resolve();
      await gate;
    };
    const requireCurrent = vi.fn().mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => finalCheck(historyFence.promise));
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => operationId === "direct-run"
      ? null : { status: workflowStatus(operationId), requireCurrent });
    const initial = await run_status(context, "direct-run");
    run_status.mockClear();
    run_status.mockResolvedValueOnce(initial).mockImplementationOnce(async () => {
      await finalCheck(directFence.promise);
      return initial;
    });
    let disclosed = false;
    const response = readOwnerResearchRuns(ports, context).then(value => { disclosed = true; return value; });
    const denied = new CatalogInputError("RESEARCH_HISTORY_AUTHORITY_STALE", "revoked", 409);
    const rejected = expect(response).rejects.toBe(denied);
    await allFinalStarted.promise;
    expect(disclosed).toBe(false);
    directFence.resolve();
    historyFence.reject(denied);
    await rejected;
    expect(disclosed).toBe(false);
    expect(requireCurrent).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an unexpected error in a concurrent candidate read", async () => {
    const { ports } = makePorts({ runRows: [
      { operation_id: "readable", created_at: "2026-10-15T12:01:00.000Z", query: "Authorized question" },
      { operation_id: "unavailable", created_at: "2026-10-15T12:00:00.000Z", query: "Unverified question" },
    ] });
    const failure = new Error("storage unavailable");
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => {
      if (operationId === "unavailable") throw failure;
      return { status: workflowStatus(operationId), requireCurrent: async () => undefined };
    });
    await expect(readOwnerResearchRuns(ports, context)).rejects.toBe(failure);
    expect(prepareReadMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the four-query/32-candidate budget while parallelizing denied batches", async () => {
    const { ports } = makePorts();
    const rows = Array.from({ length: 33 }, (_item, index) => ({ operation_id: `run-${String(33 - index).padStart(2, "0")}`,
      created_at: "2026-10-15T12:00:00.000Z", query: "Denied question" }));
    let candidateQueries = 0;
    const database = { prepare(query: string) {
      if (!query.includes("FROM research_workflow_run r") || !query.includes("investigation_ledger_head")) {
        return ports.database.prepare(query);
      }
      return { bind(...values: unknown[]) { return { all: async () => {
        candidateQueries += 1;
        const after = values[2];
        const start = after === null ? 0 : rows.findIndex(row => row.operation_id === after) + 1;
        return { success: true, results: rows.slice(start, start + Number(values[3])) };
      } }; } };
    } } as unknown as D1Database;
    prepareReadMock.mockRejectedValue(new CatalogInputError("RESEARCH_HISTORY_AUTHORITY_STALE", "denied", 403));
    const result = await readOwnerResearchRuns({ ...ports, database }, context);
    expect(result.runs).toEqual([]);
    expect(result.visibility_scan.runs).toBe("BUDGET_STOPPED");
    expect(candidateQueries).toBe(4);
    expect(prepareReadMock).toHaveBeenCalledTimes(32);
    expect(JSON.stringify(result)).not.toContain("Denied question");
  });

  it("attaches a complete run only through its verified saved-draft locator", async () => {
    const artifactRef = { id: "artifact-1", revision: 7 };
    const runRows = [{ operation_id: "completed-run", created_at: "2026-10-15T12:01:00.000Z", query: "Saved query" }];
    const draftRows = [{
      origin_client_class: "owner_pwa", artifact_id: artifactRef.id, revision: artifactRef.revision,
      principal_ref: "owner-1",
      scope_snapshot_id: "scope-1", scope_snapshot_revision: 2,
      intent_id: "intent-1", intent_revision: 3, created_at: "2026-10-15T12:02:00.000Z",
    }];
    const workflowBindingRows = [{
      admission_operation_id: "completed-run", admission_principal_ref: "owner-1",
      admission_scope_snapshot_id: "scope-1", admission_scope_snapshot_revision: 2,
      workflow_operation_id: "completed-run", workflow_principal_ref: "owner-1",
      workflow_scope_snapshot_id: "scope-1", workflow_scope_snapshot_revision: 2,
    }];
    const { ports, run_status, prepare_artifact_read } = makePorts({ runRows, draftRows, workflowBindingRows });
    const requireCurrent = vi.fn(async () => undefined);
    prepareReadMock.mockResolvedValue({ status: workflowStatus("completed-run"), requireCurrent });
    historicalLocatorMock.mockResolvedValue({ operation_id: "completed-run", artifact_ref: artifactRef });

    const history = await readOwnerResearchRuns(ports, context);

    expect(run_status).not.toHaveBeenCalled();
    expect(prepare_artifact_read).toHaveBeenCalledWith(context, artifactRef, "report");
    expect(readHistoricalResearchArtifactLocator).toHaveBeenCalledWith(expect.objectContaining({
      operation_id: "completed-run", artifact_ref: artifactRef,
      original_scope_snapshot_ref: { id: "scope-1", revision: 2 }, require_current: expect.any(Function),
      owner: { principal_ref: "owner-1", client_class: "owner_pwa" },
    }));
    expect(history.saved_drafts).toContainEqual(expect.objectContaining({
      artifact_ref: artifactRef, workflow_instance_id: "completed-run",
    }));
    expect(history.runs[0]?.status.answer).toEqual({ availability: "draft", artifact_ref: artifactRef });
    expect(requireCurrent).toHaveBeenCalled();
  });
});
