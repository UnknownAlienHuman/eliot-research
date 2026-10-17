import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { vi } from "vitest";
import { readOwnerResearchRuns } from "@eliotr/cloudflare-research-runtime";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import { ArtifactReadNotFoundError, type AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { WorkflowRunStatus } from "@eliotr/cloudflare-workflows";
import type * as RunReadAuthorization from "../../../packages/cloudflare-research-runtime/src/research-run-read-authorization.js";

const { prepareMetadataReadMock } = vi.hoisted(() => ({ prepareMetadataReadMock: vi.fn() }));
vi.mock("../../../packages/cloudflare-research-runtime/src/research-run-read-authorization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RunReadAuthorization>();
  return { ...actual, prepareReauthenticatedRunMetadataRead: prepareMetadataReadMock };
});

// Actual native D1 candidate SQL, with explicit synthetic upstream tables and
// controlled authority ports. Existing full-schema/current-authority receipts
// remain separate; these cases do not qualify JWT, provider, Workflow or live I/O.
const bindings = env as unknown as { CORE_DB: D1Database; WORK_BUCKET: R2Bucket };
const db = bindings.CORE_DB;
const principal = "recent-owner";
const generation = "recent-generation";
const timestamp = "2026-10-13T00:00:00.000Z";
const scope = { id: "scope-recent", revision: 1 };
const context = (): AuthenticatedRequestContext => ({
  request: new Request("https://research.example/api/v1/research/runs"), principal_ref: principal,
  client_class: "owner_pwa", credential_generation: "recent-credential", trace_id: "recent-native",
});
beforeEach(async () => {
  await reset();
  await db.batch([
    db.prepare("CREATE TABLE research_deployment_compatible(origin_deployment_generation TEXT,active_deployment_generation TEXT)"),
    db.prepare("CREATE TABLE research_workflow_run(operation_id TEXT PRIMARY KEY,created_at TEXT,principal_ref TEXT, deployment_generation TEXT,credential_generation TEXT,handler_generation TEXT,scope_snapshot_id TEXT, scope_snapshot_revision INTEGER,authorization_receipt_ref TEXT,investigation_id TEXT)"),
    db.prepare("CREATE TABLE scope_snapshot(snapshot_id TEXT,revision INTEGER,resolved_scope_expression_json TEXT)"),
    db.prepare("CREATE TABLE investigation_ledger_head(investigation_id TEXT,principal_ref TEXT,goal TEXT)"),
    db.prepare("CREATE TABLE research_report_admission(operation_id TEXT,principal_ref TEXT,scope_snapshot_id TEXT,scope_snapshot_revision INTEGER,intent_id TEXT,intent_revision INTEGER,client_class TEXT)"),
    db.prepare("CREATE TABLE owner_machine_run_origin(operation_id TEXT,reader_principal_ref TEXT,origin_client_class TEXT)"),
    db.prepare("CREATE TABLE scope_access_grant(snapshot_id TEXT,snapshot_revision INTEGER,principal_ref TEXT, credential_generation TEXT,authorization_receipt_ref TEXT,client_class TEXT,project_client_grant_id TEXT)"),
    db.prepare("CREATE TABLE artifact_draft_binding(artifact_id TEXT,revision INTEGER,scope_snapshot_id TEXT, scope_snapshot_revision INTEGER,intent_id TEXT,intent_revision INTEGER,created_at TEXT,principal_ref TEXT,PRIMARY KEY(artifact_id,revision))"),
    db.prepare("CREATE TABLE owner_artifact_read_origin(artifact_id TEXT,artifact_revision INTEGER,reader_principal_ref TEXT,origin_client_class TEXT)"),
  ]);
  await db.prepare("INSERT INTO research_deployment_compatible VALUES (?1,?1)").bind(generation).run();
  await db.prepare("INSERT INTO scope_snapshot VALUES (?1,1,?2)")
    .bind(scope.id, JSON.stringify({ kind: "PROJECT", project_id: "recent-project" })).run();
});

const id = (kind: string, ordinal: number) => `${kind}-${String(ordinal).padStart(3, "0")}`;
async function insertRun(operation: string) {
  await db.prepare("INSERT INTO research_workflow_run(operation_id,created_at,principal_ref,deployment_generation,credential_generation,handler_generation,scope_snapshot_id,scope_snapshot_revision,authorization_receipt_ref) VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8)")
    .bind(operation, timestamp, principal, generation, "recent-credential", "recent-controlled-handler", scope.id, "recent-auth").run();
}
async function insertDraft(artifact: string, revision = 1) {
  await db.batch([
    db.prepare("INSERT INTO artifact_draft_binding VALUES (?1,?2,?3,1,?4,1,?5,?6)")
      .bind(artifact, revision, scope.id, "intent-recent", timestamp, principal),
    db.prepare("INSERT INTO owner_artifact_read_origin VALUES (?1,?2,?3,'trusted_agent')")
      .bind(artifact, revision, principal),
  ]);
}
async function seed(count: number) {
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await insertRun(id("run", ordinal));
    await insertDraft(id("draft", ordinal));
  }
}

function ports(input: { deniedRuns?: ReadonlySet<string>; deniedDrafts?: ReadonlySet<string>;
  deniedDraftRevisions?: ReadonlySet<number>; finalDenial?: string } = {}) {
  const counts = { run_candidate_queries: 0, draft_candidate_queries: 0, run_authorizations: 0, draft_authorizations: 0 };
  const currentCalls = new Map<string, number>();
  const database = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (sql.startsWith("SELECT r.operation_id, r.created_at")) counts.run_candidate_queries += 1;
      if (sql.startsWith("SELECT b.artifact_id,b.revision")) counts.draft_candidate_queries += 1;
      return target.prepare(sql);
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const status = (operation: string): WorkflowRunStatus => ({
    operation_id: operation, investigation_id: `investigation-${operation}`, current_revision: 1,
    scope_snapshot_id: scope.id, scope_snapshot_revision: scope.revision,
    state: "ACTIVE", next_stage_index: 0, cancellation_receipt_ref: null,
  } as unknown as WorkflowRunStatus);
  const value: Parameters<typeof readOwnerResearchRuns>[0] = {
    database, work_bucket: bindings.WORK_BUCKET, deployment_generation: generation,
    run_read: { database, work_bucket: bindings.WORK_BUCKET, active_deployment_generation: generation,
      require_deployment_compatibility: async () => {}, reopen_owner_artifact_draft: async () => { throw new Error("unused owner draft port"); },
      run_status: async (actor: AuthenticatedRequestContext, operation: string) => {
        expect(actor.principal_ref).toBe(principal); counts.run_authorizations += 1;
        if (input.deniedRuns?.has(operation)) throw new CatalogInputError("RESEARCH_HISTORY_AUTHORITY_STALE", "denied", 403);
        return status(operation);
      } },
    authorize_owner_read: actor => { expect(actor.client_class).toBe("owner_pwa"); },
    prepare_artifact_read: async (actor, ref) => {
      expect(actor.principal_ref).toBe(principal); counts.draft_authorizations += 1;
      if (input.deniedDrafts?.has(ref.id) || input.deniedDraftRevisions?.has(ref.revision)) throw new ArtifactReadNotFoundError();
      return { original_scope_snapshot_ref: scope, requireCurrent: async () => {
        const calls = (currentCalls.get(ref.id) ?? 0) + 1; currentCalls.set(ref.id, calls);
        if (input.finalDenial === ref.id && calls > 1) throw new ArtifactReadNotFoundError();
      } };
    },
    reopen_owner_artifact_draft: async () => { throw new Error("unused owner draft port"); },
    semantic_configuration_installed: () => true,
  };
  prepareMetadataReadMock.mockImplementation(async (runRead: { run_status: (actor: AuthenticatedRequestContext, operation: string) => Promise<ResearchRunStatus> },
    actor: AuthenticatedRequestContext, operation: string) => ({
    status: await runRead.run_status(actor, operation),
    handler_generation: "recent-controlled-handler",
    requireCurrent: async () => undefined,
  }));
  return { value, counts, currentCalls };
}

describe("bounded Recent visible history over native D1 candidate SQL", () => {
  it("backfills eight denied newest runs and drafts with the ninth currently readable entry", async () => {
    await seed(9);
    const deniedRuns = new Set(Array.from({ length: 8 }, (_item, index) => id("run", index + 2)));
    const deniedDrafts = new Set(Array.from({ length: 8 }, (_item, index) => id("draft", index + 2)));
    const reads = ports({ deniedRuns, deniedDrafts });
    const result = await readOwnerResearchRuns(reads.value, context());
    expect(result.protocol).toBe("eliotr.research-runs.v5");
    expect(result.runs.map(row => row.status.workflow_instance_id)).toEqual([id("run", 1)]);
    expect(result.saved_drafts.map(row => row.artifact_ref.id)).toEqual([id("draft", 1)]);
    expect(result.visibility_scan).toEqual({ runs: "SOURCE_EXHAUSTED", saved_drafts: "SOURCE_EXHAUSTED" });
    // The final currentness recheck is separate from the nine candidate reads.
    expect(reads.counts).toEqual({ run_candidate_queries: 2, draft_candidate_queries: 2, run_authorizations: 9, draft_authorizations: 9 });
    for (const denied of [...deniedRuns, ...deniedDrafts]) expect(JSON.stringify(result)).not.toContain(denied);
  });

  it("keeps independent latest-visible ordering and eight-entry targets through mixed denials", async () => {
    await seed(18);
    const deniedRuns = new Set(Array.from({ length: 9 }, (_item, index) => id("run", index * 2 + 1)));
    const deniedDrafts = new Set(Array.from({ length: 9 }, (_item, index) => id("draft", index * 2 + 1)));
    const reads = ports({ deniedRuns, deniedDrafts });
    const result = await readOwnerResearchRuns(reads.value, context());
    const expected = Array.from({ length: 8 }, (_item, index) => 18 - index * 2);
    expect(result.runs.map(row => row.status.workflow_instance_id)).toEqual(expected.map(n => id("run", n)));
    expect(result.saved_drafts.map(row => row.artifact_ref.id)).toEqual(expected.map(n => id("draft", n)));
    expect(result.visibility_scan).toEqual({ runs: "TARGET_REACHED", saved_drafts: "TARGET_REACHED" });
    expect(reads.counts.run_candidate_queries).toBe(2); expect(reads.counts.draft_candidate_queries).toBe(2);
    for (const denied of [...deniedRuns, ...deniedDrafts]) expect(JSON.stringify(result)).not.toContain(denied);
  });

  it("fails the whole result when a selected draft loses authority during the final currentness recheck", async () => {
    await insertDraft("draft-race");
    const reads = ports({ finalDenial: "draft-race" });
    await expect(readOwnerResearchRuns(reads.value, context())).rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_NOT_FOUND" });
    expect(reads.currentCalls.get("draft-race")).toBe(2);
  });

  it("stops a long denied prefix at four candidate queries and 32 authority attempts per collection without disclosure", async () => {
    await seed(40);
    const deniedRuns = new Set(Array.from({ length: 40 }, (_item, index) => id("run", index + 1)));
    const deniedDrafts = new Set(Array.from({ length: 40 }, (_item, index) => id("draft", index + 1)));
    const reads = ports({ deniedRuns, deniedDrafts });
    const result = await readOwnerResearchRuns(reads.value, context());
    expect(result.runs).toEqual([]); expect(result.saved_drafts).toEqual([]);
    expect(result.visibility_scan).toEqual({ runs: "BUDGET_STOPPED", saved_drafts: "BUDGET_STOPPED" });
    expect(reads.counts).toEqual({ run_candidate_queries: 4, draft_candidate_queries: 4, run_authorizations: 32, draft_authorizations: 32 });
    expect(Object.keys(result.visibility_scan).sort()).toEqual(["runs", "saved_drafts"]);
    for (const denied of [...deniedRuns, ...deniedDrafts]) expect(JSON.stringify(result)).not.toContain(denied);
  });

  it("exhausts a short draft source independently while the run candidate budget stops", async () => {
    for (let n = 1; n <= 40; n += 1) await insertRun(id("run", n));
    await insertDraft("draft-independent");
    const reads = ports({ deniedRuns: new Set(Array.from({ length: 40 }, (_item, index) => id("run", index + 1))) });
    const result = await readOwnerResearchRuns(reads.value, context());
    expect(result.visibility_scan).toEqual({ runs: "BUDGET_STOPPED", saved_drafts: "SOURCE_EXHAUSTED" });
    expect(result.saved_drafts.map(row => row.artifact_ref.id)).toEqual(["draft-independent"]);
    expect(reads.counts.draft_candidate_queries).toBe(1);
  });

  it("backfills same-time same-artifact rows using revision as the stable keyset tie-break", async () => {
    for (let revision = 1; revision <= 10; revision += 1) await insertDraft("draft-versioned", revision);
    const reads = ports({ deniedDraftRevisions: new Set([3, 4, 5, 6, 7, 8, 9, 10]) });
    const result = await readOwnerResearchRuns(reads.value, context());
    expect(result.saved_drafts.map(row => row.artifact_ref.revision)).toEqual([2, 1]);
    expect(result.visibility_scan.saved_drafts).toBe("SOURCE_EXHAUSTED");
    expect(reads.counts.draft_candidate_queries).toBe(2);
  });
});
