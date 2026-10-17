/// <reference types="node" />
/// <reference types="vite/client" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowCheckpointError, WorkflowCheckpointStore, type WorkflowRunStatus } from "@eliotr/cloudflare-research";
import { ScopeServiceError } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type * as Evidence from "@eliotr/cloudflare-evidence";
import type * as Navigation from "@eliotr/cloudflare-navigation";
import type * as ResearchStages from "@eliotr/cloudflare-research-stages";
import compatibilityMigration from "../../../infra/d1/core/migrations/0068_research_deployment_compatibility.sql?raw";
import { prepareReauthenticatedRunCancellation, prepareReauthenticatedRunMetadataRead, prepareReauthenticatedRunRead, readReauthenticatedRunAnswer,
  type ReauthenticatedRunRead, type ResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import { readOwnerResearchRuns, type ResearchRunListPorts } from "./research-run-list.js";
import { recoverResearchRun, type ResearchRunControlEnvironment } from "./research-run-control.js";

const authority = vi.hoisted(() => ({
  load: vi.fn(), navigation: vi.fn(), current: vi.fn(), sources: vi.fn(),
  owner: vi.fn(), machine: vi.fn(), requireCurrent: vi.fn(),
}));
const { historicalCoverageMock } = vi.hoisted(() => ({ historicalCoverageMock: vi.fn() }));
vi.mock("@eliotr/cloudflare-research-stages", async importOriginal => ({
  ...await importOriginal<typeof ResearchStages>(),
  readHistoricalResearchCoverage: historicalCoverageMock,
}));
vi.mock("@eliotr/cloudflare-evidence", async importOriginal => ({
  ...await importOriginal<typeof Evidence>(), loadScopeAuthority: authority.load,
  createNavigationReadAuthority: authority.navigation,
}));
vi.mock("@eliotr/cloudflare-navigation", async importOriginal => ({
  ...await importOriginal<typeof Navigation>(), reauthorizeOwnerHistoricalScope: authority.owner,
  reauthorizeOwnerRunScope: authority.machine,
}));

let sqlite: DatabaseSync;
afterEach(() => { sqlite?.close(); vi.restoreAllMocks(); });

function setup() {
  for (const mock of Object.values(authority)) mock.mockReset();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE investigation_current_deployment(deployment_generation TEXT PRIMARY KEY,state TEXT,backend_fingerprint TEXT);
    CREATE TABLE research_workflow_run(operation_id TEXT,principal_ref TEXT,credential_generation TEXT,
      deployment_generation TEXT,handler_generation TEXT,scope_snapshot_id TEXT,scope_snapshot_revision INTEGER,
      authorization_receipt_ref TEXT,created_at TEXT,investigation_id TEXT);
    CREATE TABLE scope_access_grant(snapshot_id TEXT,snapshot_revision INTEGER,principal_ref TEXT,
      credential_generation TEXT,authorization_receipt_ref TEXT,client_class TEXT,project_client_grant_id TEXT);
    CREATE TABLE owner_machine_run_origin(operation_id TEXT,reader_principal_ref TEXT,origin_client_class TEXT);
    CREATE TABLE scope_snapshot(snapshot_id TEXT,revision INTEGER,resolved_scope_expression_json TEXT);
    CREATE TABLE investigation_ledger_head(investigation_id TEXT,principal_ref TEXT,goal TEXT);
    CREATE TABLE project(project_id TEXT,generation INTEGER);
    CREATE TABLE project_owner(project_id TEXT,principal_ref TEXT);
    CREATE TABLE artifact_draft_binding(artifact_id TEXT,revision INTEGER,intent_id TEXT,intent_revision INTEGER,
      scope_snapshot_id TEXT,scope_snapshot_revision INTEGER,created_at TEXT,principal_ref TEXT);
    CREATE TABLE owner_artifact_read_origin(artifact_id TEXT,artifact_revision INTEGER,reader_principal_ref TEXT,origin_client_class TEXT);
    CREATE TABLE schema_state(key TEXT,value TEXT);
    CREATE TABLE investigation_current_policy(policy_generation TEXT,policy_authority_ref TEXT,state TEXT);
    CREATE TABLE investigation_ledger_epoch(singleton INTEGER,generation INTEGER);
    CREATE TABLE orientation_authority_epoch(singleton INTEGER,generation INTEGER);
    INSERT INTO schema_state VALUES ('project_client_run_control_generation','project-client-run-control-v2'),
      ('project_client_spend_generation','project-client-spend-v2');
    INSERT INTO investigation_ledger_epoch VALUES (1,7);
    INSERT INTO orientation_authority_epoch VALUES (1,9);
    INSERT INTO investigation_current_policy VALUES ('policy-1','authority-1','ACTIVE');
    INSERT INTO research_workflow_run VALUES ('old-run','owner-1','old-credential','origin-generation',
      'research-handlers.exploratory.v7','scope-1',1,'original-read','2026-10-15T12:00:00.000Z','investigation-1');
    INSERT INTO scope_access_grant VALUES ('scope-1',1,'owner-1','old-credential','original-read','owner_pwa',NULL);
    INSERT INTO scope_snapshot VALUES ('scope-1',1,'{"kind":"PROJECT","project_id":"6668"}');
    INSERT INTO investigation_ledger_head VALUES ('investigation-1','owner-1','Retained failed O1 question');
    INSERT INTO project VALUES ('6668',1);
    INSERT INTO project_owner VALUES ('6668','owner-1');
  `);
  sqlite.prepare("INSERT INTO investigation_current_deployment VALUES (?,?,?)").run("origin-generation", "RETIRED", "a".repeat(64));
  sqlite.prepare("INSERT INTO investigation_current_deployment VALUES (?,?,?)").run("active-generation", "ACTIVE", "b".repeat(64));
  // Use the existing execution-compatibility view verbatim. Only its read-only
  // metadata users change; no fingerprint or compatibility rule is substituted.
  sqlite.exec(compatibilityMigration.slice(compatibilityMigration.indexOf("CREATE VIEW research_deployment_compatible AS"),
    compatibilityMigration.indexOf("DROP VIEW research_workflow_current;")));

  const statements: string[] = [];
  const database = {
    prepare(sql: string) {
      if (!sql.trimStart().startsWith("SELECT")) throw new Error("History must not mutate D1");
      statements.push(sql);
      const statement = sqlite.prepare(sql);
      const bind = (...values: unknown[]) => {
        const parameters = Object.fromEntries(values.map((value, index) => [`?${index + 1}`, value as SQLInputValue]));
        return {
          first: async <T>() => (statement.get(parameters) as T | undefined) ?? null,
          all: async <T>() => ({ success: true, results: statement.all(parameters) as T[] }),
        };
      };
      return { ...bind(), bind };
    },
  } as unknown as D1Database;
  const expires = new Date(Date.now() + 60_000).toISOString();
  const original: ScopeSnapshot = {
    snapshot_id: "scope-1", revision: 1, resolved_scope_expression: { kind: "PROJECT", project_id: "6668" },
    participant_generations: {}, member_source_revision_refs: ["original-revision"],
    source_owner_generations: { "original-revision": "owner-generation" }, policy_authority_ref: "authority-1",
    disclosure_closure_digest: "c".repeat(64), purge_ledger_revision: 0, digest: "d".repeat(64),
    created_at: "2026-10-15T12:00:00.000Z", expires_at: expires,
  };
  const context = {
    principal_ref: "owner-1", credential_generation: "current-credential", client_class: "owner_pwa",
    request: new Request("https://owner.invalid/api/v1/research/runs"),
  } as AuthenticatedRequestContext;
  const status: WorkflowRunStatus = {
    operation_id: "old-run", investigation_id: "investigation-1", principal_ref: "owner-1",
    credential_generation: "old-credential", deployment_generation: "origin-generation",
    initial_revision: 1, current_revision: 4, next_stage_index: 3, state: "ACTIVE",
    scope_snapshot_id: "scope-1", scope_snapshot_revision: 1, cancellation_receipt_ref: null,
    current_attempt: null, final_receipt: null, first_failure: null, latest_failure: null,
    failure_history: { protocol: "eliotr.workflow-failure-history.v1", first_cause: null, consequences: [] },
  };
  const head = { principal_ref: "owner-1", scope_snapshot_id: "scope-1", scope_snapshot_revision: 1,
    deployment_generation: "origin-generation", policy_generation: "policy-1", policy_authority_ref: "authority-1" };
  vi.spyOn(WorkflowCheckpointStore.prototype, "readRunStatus").mockImplementation(async (operation, principal) =>
    operation === status.operation_id && principal.principal_ref === status.principal_ref ? status : null);
  vi.spyOn(WorkflowCheckpointStore.prototype, "head").mockImplementation(async () =>
    head as Awaited<ReturnType<WorkflowCheckpointStore["head"]>>);
  authority.load.mockResolvedValue({ snapshot: original });
  authority.requireCurrent.mockImplementation(async (scope: ScopeSnapshot) => scope);
  authority.owner.mockResolvedValue({ scope: original, requireCurrent: authority.requireCurrent });
  authority.current.mockResolvedValue({ authorization_receipt_ref: "current-read", expires_at: expires });
  authority.sources.mockResolvedValue([{ admission_expires_at: expires }]);
  authority.navigation.mockImplementation((input: { scope_snapshot: ScopeSnapshot;
    require_current: (scope: ScopeSnapshot) => Promise<ScopeSnapshot> }) => ({
    current: async () => { await input.require_current(input.scope_snapshot); return authority.current(); },
    sources: authority.sources,
  }));
  const compatible = vi.fn(async (origin: string, active: string) => {
    const row = sqlite.prepare("SELECT * FROM research_deployment_compatible WHERE origin_deployment_generation=? AND active_deployment_generation=?")
      .get(origin, active);
    if (row === undefined) throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
    return row;
  });
  const read: ResearchRunReadEnvironment = { database, work_bucket: {} as R2Bucket,
    active_deployment_generation: "active-generation", require_deployment_compatibility: compatible,
    reopen_owner_artifact_draft: vi.fn(async () => { throw new Error("No report payload read in history"); }) };
  const list: ResearchRunListPorts = { database, work_bucket: read.work_bucket, run_read: read,
    deployment_generation: "active-generation", authorize_owner_read: () => undefined,
    prepare_artifact_read: vi.fn(async () => { throw new Error("No drafts in this fixture"); }),
    reopen_owner_artifact_draft: read.reopen_owner_artifact_draft, semantic_configuration_installed: () => true };
  const workflow = { get: vi.fn(async () => { throw new Error("Recovery must be denied before native Workflow I/O"); }) };
  const control = { database, workflow, run_read: read, validate_request: () => undefined,
    client_run_read: { run_read: read }, client_spend: { core_database: database } } as unknown as ResearchRunControlEnvironment;
  return { database, context, original, status, head, read, list, control, workflow, compatible, statements };
}

describe("read-only owner run provenance versus execution compatibility", () => {
  it("keeps detailed completed-run reads on full coverage and report validation", async () => {
    const f = setup();
    const artifactRef = { id: "detail-artifact", revision: 2 };
    const scopeRef = { id: "scope-1", revision: 1 };
    const reopen = vi.fn(async () => ({ artifact_ref: artifactRef, original_scope_snapshot_ref: scopeRef,
      artifact: { status: "DRAFT", sections: [], evidence_freeze_ref: { id: "freeze-1", revision: 1 },
        dependency_manifest_ref: "manifest-1:1" } }));
    const runRead = { ...f.read, reopen_owner_artifact_draft: reopen } as unknown as ResearchRunReadEnvironment;
    const requireCurrent = vi.fn(async () => undefined);
    const read = { status: { ...f.status, state: "ENGINE_COMPLETED" }, handler_generation: "detail-generation",
      requireCurrent, controlFence: vi.fn() } as unknown as ReauthenticatedRunRead;
    historicalCoverageMock.mockReset();
    historicalCoverageMock.mockImplementation(async (input: { require_artifact: (refs: {
      artifact_ref: typeof artifactRef; original_scope_snapshot_ref: typeof scopeRef;
    }) => Promise<unknown>; require_current: () => Promise<void> }) => {
      await input.require_current();
      await input.require_artifact({ artifact_ref: artifactRef, original_scope_snapshot_ref: scopeRef });
      return { artifact_ref: artifactRef };
    });

    const answer = await readReauthenticatedRunAnswer(runRead, f.context, read, "detail-generation");

    expect(answer).toEqual({ availability: "draft", artifact_ref: artifactRef });
    expect(historicalCoverageMock).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith(f.context, artifactRef);
    expect(requireCurrent).toHaveBeenCalledTimes(2);
  });

  it("lists a retained incompatible origin under current rights while recovery remains forbidden", async () => {
    const f = setup();
    const before = sqlite.prepare("SELECT total_changes() AS n").get();

    const history = await readOwnerResearchRuns(f.list, f.context, "6668");

    expect(history.runs).toEqual([expect.objectContaining({ query: "Retained failed O1 question",
      status: expect.objectContaining({ workflow_instance_id: "old-run", execution_state: "ACTIVE" }) })]);
    expect(f.compatible).not.toHaveBeenCalled();
    expect(authority.owner).toHaveBeenCalledWith(expect.objectContaining({ access: f.context,
      original_ref: { id: "scope-1", revision: 1 }, original: f.original }));
    expect(authority.sources).toHaveBeenCalledWith(["original-revision"], expect.anything());
    await expect(recoverResearchRun(f.control, f.context, "old-run", {}))
      .rejects.toMatchObject({ code: "RESEARCH_CONTROL_DENIED", status: 403 });
    expect(f.compatible).toHaveBeenCalledWith("origin-generation", "active-generation");
    expect(f.workflow.get).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it("keeps the detailed status reader fast path for same-owner current runs", async () => {
    const f = setup();
    sqlite.exec("UPDATE research_workflow_run SET credential_generation='current-credential',deployment_generation='active-generation';" +
      "UPDATE scope_access_grant SET credential_generation='current-credential'");
    await expect(prepareReauthenticatedRunRead(f.read, f.context, "old-run")).resolves.toBeNull();
    expect(authority.owner).not.toHaveBeenCalled();
    expect(f.compatible).not.toHaveBeenCalled();
  });

  it("history metadata still checks current owner and source rights for same-owner current runs", async () => {
    const f = setup();
    sqlite.exec("UPDATE research_workflow_run SET credential_generation='current-credential',deployment_generation='active-generation';" +
      "UPDATE scope_access_grant SET credential_generation='current-credential'");
    f.head.deployment_generation = "active-generation";
    vi.spyOn(WorkflowCheckpointStore.prototype, "readRunStatus").mockResolvedValue({
      ...f.status, credential_generation: "current-credential", deployment_generation: "active-generation",
    });

    const read = await prepareReauthenticatedRunMetadataRead(f.read, f.context, "old-run");

    expect(read).not.toBeNull();
    expect(authority.owner).toHaveBeenCalledWith(expect.objectContaining({ access: f.context,
      original_ref: { id: "scope-1", revision: 1 } }));
    expect(authority.sources).toHaveBeenCalledWith(["original-revision"], expect.anything());
    expect(f.compatible).not.toHaveBeenCalled();
  });

  it("never reauthorizes an unknown origin or discloses its stored question", async () => {
    const f = setup();
    sqlite.exec("DELETE FROM investigation_current_deployment WHERE deployment_generation='origin-generation'");
    const history = await readOwnerResearchRuns(f.list, f.context, "6668");
    expect(history.runs).toEqual([]);
    expect(JSON.stringify(history)).not.toContain("Retained failed O1 question");
    expect(authority.owner).not.toHaveBeenCalled();
  });

  it("does not issue a control fence from a read-only authorization and rechecks retained provenance", async () => {
    const f = setup();
    const read = await prepareReauthenticatedRunRead(f.read, f.context, "old-run");
    if (read === null) throw new Error("Expected historical read authorization");
    await expect(read.controlFence()).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    sqlite.exec("DELETE FROM investigation_current_deployment WHERE deployment_generation='origin-generation'");
    await expect(read.requireCurrent()).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(f.compatible).not.toHaveBeenCalled();
  });

  it("keeps control compatibility and epoch fences effective after initial admission", async () => {
    const f = setup();
    sqlite.prepare("UPDATE investigation_current_deployment SET backend_fingerprint=? WHERE state='ACTIVE'").run("a".repeat(64));
    const read = await prepareReauthenticatedRunRead(f.read, f.context, "old-run", true);
    if (read === null) throw new Error("Expected compatible control authorization");
    expect(await read.controlFence()).toMatchObject({ ledger_epoch: 7, orientation_epoch: 9 });
    sqlite.prepare("UPDATE investigation_current_deployment SET backend_fingerprint=? WHERE state='ACTIVE'").run("b".repeat(64));
    await expect(read.requireCurrent()).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    await expect(read.controlFence()).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("authorizes cancellation across incompatible known deployments without authorizing recovery", async () => {
    const f = setup();
    const read = await prepareReauthenticatedRunCancellation(f.read, f.context, "old-run");
    if (read === null) throw new Error("Expected current-owner cancellation authority");
    expect(await read.controlFence()).toMatchObject({ ledger_epoch: 7, orientation_epoch: 9,
      scope_ref: { id: "scope-1", revision: 1 }, authorization_receipt_ref: "current-read" });
    expect(f.compatible).not.toHaveBeenCalled();
    await expect(recoverResearchRun(f.control, f.context, "old-run", {}))
      .rejects.toMatchObject({ code: "RESEARCH_CONTROL_DENIED", status: 403 });
    expect(f.workflow.get).not.toHaveBeenCalled();
  });

  it.each(["origin", "active", "lineage"] as const)("rechecks cancellation %s before issuing its SQL fence", async changed => {
    const f = setup();
    const read = await prepareReauthenticatedRunCancellation(f.read, f.context, "old-run");
    if (read === null) throw new Error("Expected current-owner cancellation authority");
    if (changed === "origin") sqlite.exec("DELETE FROM investigation_current_deployment WHERE deployment_generation='origin-generation'");
    else if (changed === "active") sqlite.exec("UPDATE investigation_current_deployment SET state='RETIRED' WHERE deployment_generation='active-generation'");
    else f.head.deployment_generation = "different-origin";
    await expect(read.requireCurrent()).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    await expect(read.controlFence()).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(f.compatible).not.toHaveBeenCalled();
  });

  it("retains current source denial in cancellation authorization", async () => {
    const f = setup();
    const read = await prepareReauthenticatedRunCancellation(f.read, f.context, "old-run");
    if (read === null) throw new Error("Expected current-owner cancellation authority");
    authority.sources.mockRejectedValue(new ScopeServiceError("SCOPE_SNAPSHOT_STALE", "Source read revoked"));
    await expect(read.controlFence()).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(f.compatible).not.toHaveBeenCalled();
  });

  it.each(["owner", "source"] as const)("omits history when current %s permissions are denied", async denied => {
    const f = setup();
    const failure = new ScopeServiceError("SCOPE_SNAPSHOT_STALE", "Read permission removed");
    (denied === "owner" ? authority.owner : authority.sources).mockRejectedValue(failure);
    const history = await readOwnerResearchRuns(f.list, f.context, "6668");
    expect(history.runs).toEqual([]);
    expect(JSON.stringify(history)).not.toContain("Retained failed O1 question");
  });

  it("fails the whole result on a late source denial or changed project generation", async () => {
    const f = setup();
    let reads = 0;
    authority.sources.mockImplementation(async () => {
      if (++reads === 4) throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
      return [];
    });
    await expect(readOwnerResearchRuns(f.list, f.context, "6668"))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    authority.sources.mockImplementation(async () => {
      sqlite.exec("UPDATE project SET generation=2 WHERE project_id='6668'");
      return [];
    });
    await expect(readOwnerResearchRuns(f.list, f.context, "6668"))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_CHANGED" });
  });

  it("denies foreign owners, stale sessions and changed run-origin linkage", async () => {
    const f = setup();
    await expect(prepareReauthenticatedRunRead(f.read, { ...f.context, principal_ref: "foreign-owner" }, "old-run"))
      .resolves.toBeNull();
    const expired = { ...f.context, access: { principal_ref: "owner-1", credential_generation: "current-credential",
      expires_at: new Date(Date.now() - 1).toISOString() } } as AuthenticatedRequestContext;
    await expect(prepareReauthenticatedRunRead(f.read, expired, "old-run"))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    f.head.deployment_generation = "different-origin";
    await expect(prepareReauthenticatedRunRead(f.read, f.context, "old-run"))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });
});
