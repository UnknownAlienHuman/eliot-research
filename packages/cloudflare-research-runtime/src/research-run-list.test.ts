import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
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
  runRows?: readonly { operation_id: string; created_at: string; query: unknown }[];
  draftRows?: readonly Record<string, unknown>[];
  workflowBindingRows?: readonly Record<string, unknown>[];
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
            first: async <T>() => null as T | null,
          };
        },
      };
    },
  } as unknown as D1Database;
  const run_status = vi.fn(async () => { throw new Error("full run status read must not be used by history"); });
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

  it("uses one reauthenticated status read per run and retains valid history metadata", async () => {
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
