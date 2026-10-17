import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-research";
import { readHistoricalResearchArtifactLocator } from "@eliotr/cloudflare-research-stages";
import { readOwnerResearchRuns, type ResearchRunListPorts } from "./research-run-list.js";
import { prepareReauthenticatedRunMetadataRead } from "./research-run-read-authorization.js";
import { SERVER_OWNED_SEMANTIC_HANDLER_GENERATION } from "./research-stage-handlers.js";
import type { ResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import type * as RunReadAuthorization from "./research-run-read-authorization.js";
import type * as ResearchStages from "@eliotr/cloudflare-research-stages";

const { prepareReadMock, readAnswerMock, historicalLocatorMock } = vi.hoisted(() => ({
  prepareReadMock: vi.fn(),
  readAnswerMock: vi.fn(),
  historicalLocatorMock: vi.fn(),
}));

vi.mock("./research-run-read-authorization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunReadAuthorization>();
  return { ...actual, prepareReauthenticatedRunRead: prepareReadMock,
    prepareReauthenticatedRunMetadataRead: prepareReadMock,
    readReauthenticatedRunAnswer: readAnswerMock };
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
    principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1",
    scope_snapshot_id: "scope-1", scope_snapshot_revision: 2,
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
  historicalBindingRows?: readonly Record<string, unknown>[];
  projectGeneration?: number;
} = {}) {
  let historySql = "";
  let workflowBindingQueries = 0;
  const database = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            all: async <T>() => {
              if (query.includes("FROM research_workflow_run w JOIN research_report_admission r")) {
                return { success: true, results: (input.historicalBindingRows ?? []).filter(row => row.operation_id === values[0]) as T[] };
              }
              if (query.includes("FROM research_workflow_run r") && query.includes("investigation_ledger_head")) {
                historySql = query;
                return { success: true, results: [...(input.runRows ?? [])] as T[] };
              }
              if (query.includes("FROM artifact_draft_binding b")) {
                return { success: true, results: [...(input.draftRows ?? [])] as T[] };
              }
              if (query.includes("FROM research_report_admission r")) {
                workflowBindingQueries += 1;
                return { success: true, results: (input.workflowBindingRows ?? []).filter(row => row.intent_id === values[0]) as T[] };
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
    prepare_artifact_read,
    reopen_owner_artifact_draft: vi.fn(async () => { throw new Error("draft reopen is outside this locator test"); }),
    semantic_configuration_installed: () => true,
  } satisfies ResearchRunListPorts;
  return { ports, prepare_artifact_read, getHistorySql: () => historySql,
    getWorkflowBindingQueries: () => workflowBindingQueries };
}

function makeHistoryBeyondDraftWindow() {
  const runRows = Array.from({ length: 8 }, (_item, index) => ({ operation_id: `bounded-run-${index}`,
    created_at: `2026-10-15T12:0${7 - index}:00.000Z`, query: `Question ${index}` }));
  const draftRows = Array.from({ length: 8 }, (_item, index) => ({ artifact_id: `unrelated-cow-${index}`,
    revision: 1, scope_snapshot_id: "scope-1", scope_snapshot_revision: 2, origin_client_class: "owner_pwa",
    principal_ref: "owner-1", intent_id: `unrelated-intent-${index}`, intent_revision: 1,
    created_at: `2026-10-15T12:1${7 - index}:00.000Z` }));
  const hiddenArtifact = { id: "older-run-report", revision: 4 };
  const historicalBindingRows = [{ operation_id: "bounded-run-7", artifact_id: hiddenArtifact.id,
    revision: hiddenArtifact.revision, scope_snapshot_id: "scope-1", scope_snapshot_revision: 2,
    principal_ref: "owner-1", intent_id: "older-report-intent", intent_revision: 1,
    origin_client_class: "owner_pwa" }];
  const workflowBindingRows = [{ intent_id: "older-report-intent", admission_operation_id: "bounded-run-7",
    admission_principal_ref: "owner-1", admission_scope_snapshot_id: "scope-1", admission_scope_snapshot_revision: 2,
    workflow_operation_id: "bounded-run-7", workflow_principal_ref: "owner-1",
    workflow_scope_snapshot_id: "scope-1", workflow_scope_snapshot_revision: 2 }];
  return { ...makePorts({ runRows, draftRows, workflowBindingRows, historicalBindingRows }), draftRows, hiddenArtifact };
}

describe("owner research history", () => {
  beforeEach(() => {
    prepareReadMock.mockReset();
    readAnswerMock.mockReset();
    historicalLocatorMock.mockReset();
  });

  it("attaches eight completed report locators without opening their body graphs", async () => {
    const runRows = Array.from({ length: 8 }, (_item, index) => ({ operation_id: `completed-${index}`,
      created_at: `2026-10-15T12:0${7 - index}:00.000Z`, query: `Question ${index}` }));
    const draftRows = runRows.map((_run, index) => ({
      artifact_id: `artifact-${index}`, revision: 2, scope_snapshot_id: "scope-1", scope_snapshot_revision: 2,
      origin_client_class: "owner_pwa", principal_ref: "owner-1", intent_id: `intent-${index}`,
      intent_revision: 1, created_at: `2026-10-15T12:1${7 - index}:00.000Z`,
    }));
    const workflowBindingRows = draftRows.map((draft, index) => ({
      intent_id: draft.intent_id,
      admission_operation_id: `completed-${index}`, admission_principal_ref: "owner-1",
      admission_scope_snapshot_id: "scope-1", admission_scope_snapshot_revision: 2,
      workflow_operation_id: `completed-${index}`, workflow_principal_ref: "owner-1",
      workflow_scope_snapshot_id: "scope-1", workflow_scope_snapshot_revision: 2,
    }));
    const { ports } = makePorts({ runRows, draftRows, workflowBindingRows });
    const runFences = runRows.map(() => vi.fn(async () => undefined));
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => ({
      status: workflowStatus(operationId), handler_generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
      requireCurrent: runFences[runRows.findIndex(row => row.operation_id === operationId)],
    }));
    historicalLocatorMock.mockImplementation(async (input: { operation_id: string; artifact_ref: { id: string; revision: number } }) => input);

    const history = await readOwnerResearchRuns(ports, context);

    expect(history.runs).toHaveLength(8);
    expect(history.runs.map(run => run.status.answer)).toEqual(draftRows.map(draft => ({
      availability: "draft", artifact_ref: { id: draft.artifact_id, revision: draft.revision },
    })));
    expect(prepareReauthenticatedRunMetadataRead).toHaveBeenCalledTimes(8);
    // Preparation already completed its final currentness check. The list adds
    // exactly one run check per candidate, after both scans, before disclosure.
    for (const requireCurrent of runFences) expect(requireCurrent).toHaveBeenCalledTimes(1);
    expect(readAnswerMock).not.toHaveBeenCalled();
    expect(ports.reopen_owner_artifact_draft).not.toHaveBeenCalled();
  });

  it("finds a completed run's report when eight newer unrelated drafts exhaust the draft scan", async () => {
    const { ports, draftRows, hiddenArtifact } = makeHistoryBeyondDraftWindow();
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => ({
      status: workflowStatus(operationId), handler_generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
      requireCurrent: vi.fn(async () => undefined),
    }));
    historicalLocatorMock.mockImplementation(async (input: { operation_id: string; artifact_ref: { id: string; revision: number } }) => input);

    const history = await readOwnerResearchRuns(ports, context);

    expect(history.visibility_scan).toEqual({ runs: "TARGET_REACHED", saved_drafts: "TARGET_REACHED" });
    expect(history.saved_drafts.map(draft => draft.artifact_ref.id)).toEqual(draftRows.map(draft => draft.artifact_id));
    expect(history.runs[7]?.status.answer).toEqual({ availability: "draft", artifact_ref: hiddenArtifact });
  });

  it("does not disclose a fallback report without current report read rights", async () => {
    const { ports, hiddenArtifact } = makeHistoryBeyondDraftWindow();
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => ({
      status: workflowStatus(operationId), handler_generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
      requireCurrent: vi.fn(async () => undefined),
    }));
    const deniedPorts = { ...ports, prepare_artifact_read: vi.fn(async () => {
      throw new CatalogInputError("RESEARCH_HISTORY_AUTHORITY_STALE", "report read denied", 404);
    }) };

    const history = await readOwnerResearchRuns(deniedPorts, context);

    expect(history.runs[7]?.status.answer).toEqual({ availability: "unavailable" });
    expect(JSON.stringify(history)).not.toContain(hiddenArtifact.id);
  });

  it("rechecks fallback report rights after locator discovery", async () => {
    const { ports } = makeHistoryBeyondDraftWindow();
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => ({
      status: workflowStatus(operationId), handler_generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
      requireCurrent: vi.fn(async () => undefined),
    }));
    const revoked = new CatalogInputError("RESEARCH_HISTORY_AUTHORITY_STALE", "report permission changed", 409);
    const requireCurrent = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(revoked);
    const checkedPorts = { ...ports, prepare_artifact_read: vi.fn(async (_actor, ref) => ref.id === "older-run-report"
      ? { original_scope_snapshot_ref: { id: "scope-1", revision: 2 }, requireCurrent }
      : { original_scope_snapshot_ref: { id: "scope-1", revision: 2 }, requireCurrent: async () => undefined }) };
    historicalLocatorMock.mockImplementation(async (input: { operation_id: string; require_current: () => Promise<void> }) => {
      await input.require_current();
      return input;
    });

    await expect(readOwnerResearchRuns(checkedPorts, context)).rejects.toBe(revoked);
    expect(requireCurrent).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a fallback report has invalid materialization lineage", async () => {
    const { ports } = makeHistoryBeyondDraftWindow();
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => ({
      status: workflowStatus(operationId), handler_generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
      requireCurrent: vi.fn(async () => undefined),
    }));
    historicalLocatorMock.mockRejectedValue(new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT"));

    await expect(readOwnerResearchRuns(ports, context)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });

  it("omits the historical draft when the current source authority is revoked", async () => {
    const { ports } = makePorts({ runRows: [
      { operation_id: "revoked-source-run", created_at: "2026-10-15T12:01:00.000Z", query: "Revoked source question" },
    ] });
    prepareReadMock.mockRejectedValue(new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE"));

    const history = await readOwnerResearchRuns(ports, context);

    expect(history.runs).toEqual([]);
    expect(history.saved_drafts).toEqual([]);
    expect(JSON.stringify(history)).not.toContain("Revoked source question");
  });

  it("denies a report whose canonical materialization lineage is invalid", async () => {
    const runRows = [{ operation_id: "wrong-lineage-run", created_at: "2026-10-15T12:01:00.000Z", query: "Wrong lineage" }];
    const draftRows = [{ artifact_id: "wrong-lineage-artifact", revision: 1, scope_snapshot_id: "scope-1",
      scope_snapshot_revision: 2, origin_client_class: "owner_pwa", principal_ref: "owner-1", intent_id: "intent-1",
      intent_revision: 1, created_at: "2026-10-15T12:02:00.000Z" }];
    const workflowBindingRows = [{ intent_id: "intent-1", admission_operation_id: "wrong-lineage-run", admission_principal_ref: "owner-1",
      admission_scope_snapshot_id: "scope-1", admission_scope_snapshot_revision: 2,
      workflow_operation_id: "wrong-lineage-run", workflow_principal_ref: "owner-1",
      workflow_scope_snapshot_id: "scope-1", workflow_scope_snapshot_revision: 2 }];
    const { ports } = makePorts({ runRows, draftRows, workflowBindingRows });
    prepareReadMock.mockResolvedValue({ status: workflowStatus("wrong-lineage-run"),
      requireCurrent: vi.fn(async () => undefined) });
    historicalLocatorMock.mockRejectedValue(new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT"));

    await expect(readOwnerResearchRuns(ports, context)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(ports.prepare_artifact_read).toHaveBeenCalledWith(context,
      { id: "wrong-lineage-artifact", revision: 1 }, "report");
  });

  it("uses reauthenticated metadata for historical runs and retains valid history metadata", async () => {
    const question = "How did the saved source revisions change this evidence?";
    const rows = [
      { operation_id: "current-run", created_at: "2026-10-15T12:01:00.000Z", query: question },
      { operation_id: "legacy-run", created_at: "2026-10-15T12:00:00.000Z", query: null },
    ];
    const { ports, getHistorySql } = makePorts({ runRows: rows });
    prepareReadMock.mockImplementation(async (_environment, _requestContext, operationId: string) => ({
      status: workflowStatus(operationId), requireCurrent: async () => undefined,
    }));

    const history = await readOwnerResearchRuns(ports, context);

    expect(prepareReauthenticatedRunMetadataRead).toHaveBeenCalledTimes(2);
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

  it("uses the current-fenced metadata reader for same-owner current runs", async () => {
    const { ports } = makePorts({ runRows: [
      { operation_id: "current-run", created_at: "2026-10-15T12:01:00.000Z", query: "Authorized current question" },
    ] });
    prepareReadMock.mockResolvedValue({
      status: { ...workflowStatus("current-run"), state: "ACTIVE", next_stage_index: 3 },
      requireCurrent: vi.fn(async () => undefined),
    });

    const history = await readOwnerResearchRuns(ports, context);

    expect(prepareReauthenticatedRunMetadataRead).toHaveBeenCalledWith(ports.run_read, context, "current-run");
    expect(history.runs).toEqual([expect.objectContaining({
      query: "Authorized current question",
      status: expect.objectContaining({ workflow_instance_id: "current-run", execution_state: "ACTIVE" }),
    })]);
  });

  it("omits denied direct-owner candidates without disclosing their questions", async () => {
    const { ports } = makePorts({ runRows: [
      { operation_id: "denied-run", created_at: "2026-10-15T12:01:00.000Z", query: "Sensitive denied question" },
    ] });
    prepareReadMock.mockRejectedValue(new CatalogInputError("RESEARCH_AUTHORITY_STALE", "denied", 409));

    const history = await readOwnerResearchRuns(ports, context);

    expect(history.runs).toEqual([]);
    expect(JSON.stringify(history)).not.toContain("Sensitive denied question");
  });

  it("fails the whole result when a selected direct-owner run loses read rights before disclosure", async () => {
    const { ports } = makePorts({ runRows: [
      { operation_id: "current-run", created_at: "2026-10-15T12:01:00.000Z", query: "No late disclosure" },
    ] });
    const denial = new CatalogInputError("RESEARCH_AUTHORITY_STALE", "revoked", 409);
    const requireCurrent = vi.fn().mockRejectedValue(denial);
    prepareReadMock.mockResolvedValue({ status: workflowStatus("current-run"), requireCurrent });

    await expect(readOwnerResearchRuns(ports, context)).rejects.toBe(denial);
    expect(requireCurrent).toHaveBeenCalledTimes(1);
  });

  it("preserves canonical project filtering before any question or run read", async () => {
    const { ports } = makePorts({ projectGeneration: 1, runRows: [
      { operation_id: "excluded-run", created_at: "2026-10-15T12:02:00.000Z", query: "Excluded project question",
        scope_expression: { kind: "EXCEPT", left: { kind: "PROJECT", project_id: "other-project" },
          right: { kind: "PROJECT", project_id: "selected-project" } } },
      { operation_id: "selected-run", created_at: "2026-10-15T12:01:00.000Z", query: "Selected project question",
        scope_expression: { kind: "PROJECT", project_id: "selected-project" } },
    ] });
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => ({
      status: { ...workflowStatus(operationId), state: "ACTIVE", next_stage_index: 3 },
      requireCurrent: async () => undefined,
    }));

    const history = await readOwnerResearchRuns(ports, context, "selected-project");

    expect(history.runs.map(row => row.status.workflow_instance_id)).toEqual(["selected-run"]);
    expect(prepareReadMock).toHaveBeenCalledTimes(1);
    expect(prepareReadMock).not.toHaveBeenCalledWith(expect.anything(), context, "excluded-run");
    expect(JSON.stringify(history)).not.toContain("Excluded project question");
  });

  it("fails the whole history response when a selected run loses current authority", async () => {
    const { ports } = makePorts({ runRows: [
      { operation_id: "revoked-run", created_at: "2026-10-15T12:01:00.000Z", query: "Current query" },
    ] });
    const revoked = new Error("current authority was revoked");
    const requireCurrent = vi.fn().mockRejectedValue(revoked);
    prepareReadMock.mockResolvedValue({ status: workflowStatus("revoked-run"), requireCurrent });

    await expect(readOwnerResearchRuns(ports, context)).rejects.toBe(revoked);
    expect(requireCurrent).toHaveBeenCalledTimes(1);
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

  it("waits for concurrent final history fences and fails the response on revocation", async () => {
    const { ports } = makePorts({ runRows: [
      { operation_id: "first-run", created_at: "2026-10-15T12:01:00.000Z", query: "Private first question" },
      { operation_id: "second-run", created_at: "2026-10-15T12:00:00.000Z", query: "Private second question" },
    ] });
    const directFence = Promise.withResolvers<void>();
    const historyFence = Promise.withResolvers<void>();
    const allFinalStarted = Promise.withResolvers<void>();
    let finalStarted = 0;
    const finalCheck = async (gate: Promise<void>) => {
      if (++finalStarted === 2) allFinalStarted.resolve();
      await gate;
    };
    const firstCurrent = vi.fn(() => finalCheck(directFence.promise));
    const secondCurrent = vi.fn(() => finalCheck(historyFence.promise));
    prepareReadMock.mockImplementation(async (_environment, _actor, operationId: string) => ({
      status: workflowStatus(operationId), requireCurrent: operationId === "first-run" ? firstCurrent : secondCurrent,
    }));
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
    expect(firstCurrent).toHaveBeenCalledTimes(1);
    expect(secondCurrent).toHaveBeenCalledTimes(1);
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
      intent_id: "intent-1",
      admission_operation_id: "completed-run", admission_principal_ref: "owner-1",
      admission_scope_snapshot_id: "scope-1", admission_scope_snapshot_revision: 2,
      workflow_operation_id: "completed-run", workflow_principal_ref: "owner-1",
      workflow_scope_snapshot_id: "scope-1", workflow_scope_snapshot_revision: 2,
      query: "Why did the saved source revisions change?",
    }];
    const { ports, prepare_artifact_read, getWorkflowBindingQueries } = makePorts({ runRows, draftRows, workflowBindingRows });
    const requireCurrent = vi.fn(async () => undefined);
    prepareReadMock.mockResolvedValue({ status: workflowStatus("completed-run"), requireCurrent });
    historicalLocatorMock.mockResolvedValue({ operation_id: "completed-run", artifact_ref: artifactRef });

    const history = await readOwnerResearchRuns(ports, context, undefined, "v6");

    expect(history.protocol).toBe("eliotr.research-runs.v6");
    expect(prepare_artifact_read).toHaveBeenCalledWith(context, artifactRef, "report");
    expect(readHistoricalResearchArtifactLocator).toHaveBeenCalledWith(expect.objectContaining({
      operation_id: "completed-run", artifact_ref: artifactRef,
      original_scope_snapshot_ref: { id: "scope-1", revision: 2 }, require_current: expect.any(Function),
      owner: { principal_ref: "owner-1", client_class: "owner_pwa" },
    }));
    expect(history.saved_drafts).toContainEqual(expect.objectContaining({
      artifact_ref: artifactRef, workflow_instance_id: "completed-run",
      query: "Why did the saved source revisions change?",
    }));
    expect(getWorkflowBindingQueries()).toBe(1);
    expect(history.runs[0]?.status.answer).toEqual({ availability: "draft", artifact_ref: artifactRef });
    expect(requireCurrent).toHaveBeenCalled();

    const legacy = await readOwnerResearchRuns(ports, context);
    expect(legacy.protocol).toBe("eliotr.research-runs.v5");
    expect(legacy.saved_drafts[0]).not.toHaveProperty("query");
    expect(legacy.saved_drafts[0]).toMatchObject({ artifact_ref: artifactRef, workflow_instance_id: "completed-run" });
  });

  it("does not disclose a saved-draft question when its artifact/workflow locator is not verified", async () => {
    const artifactRef = { id: "artifact-unverified", revision: 1 };
    const draftRows = [{ origin_client_class: "owner_pwa", artifact_id: artifactRef.id, revision: artifactRef.revision,
      principal_ref: "owner-1", scope_snapshot_id: "scope-1", scope_snapshot_revision: 2,
      intent_id: "intent-unverified", intent_revision: 1, created_at: "2026-10-15T12:02:00.000Z" }];
    const workflowBindingRows = [{ intent_id: "intent-unverified", admission_operation_id: "unverified-run",
      admission_principal_ref: "owner-1", admission_scope_snapshot_id: "scope-1", admission_scope_snapshot_revision: 2,
      workflow_operation_id: "unverified-run", workflow_principal_ref: "owner-1",
      workflow_scope_snapshot_id: "scope-1", workflow_scope_snapshot_revision: 2,
      query: "Question that must remain hidden" }];
    const { ports } = makePorts({ draftRows, workflowBindingRows });
    historicalLocatorMock.mockResolvedValue(null);

    const history = await readOwnerResearchRuns(ports, context);

    expect(history.saved_drafts).toEqual([expect.objectContaining({ artifact_ref: artifactRef })]);
    expect(history.saved_drafts[0]).not.toHaveProperty("query");
    expect(history.saved_drafts[0]).not.toHaveProperty("workflow_instance_id");
  });
});
