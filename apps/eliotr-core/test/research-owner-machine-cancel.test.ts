import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import type { ProjectClientGrant } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority, createProjectOwnerService } from "@eliotr/cloudflare-navigation";
import { createD1InvestigationLedgerStore, createInvestigationLedgerService, type LedgerD1Database } from "@eliotr/research";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { createWorkflowCheckpointExecutor, digest, type StageRequest } from "@eliotr/cloudflare-workflows";
import { WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import { handleHttp } from "../src/http.js";
import { body, db, insert, observeDatabase, principal as grantor, runtime, seedSource, setupOrientationDatabase } from "./orientation-fixture.js";

beforeEach(async () => {
  await reset(); await setupOrientationDatabase();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Real scope/source policies, machine origin, eight canonical checkpoints and
 * public HTTP control. Fixture stage outputs and native Workflow I/O are controlled. */
async function fixture() {
  await seedSource("owner-machine-cancel-source");
  const createdAt = new Date().toISOString(), expires = new Date(Date.now() + 3_600_000).toISOString();
  await insert("source_admission_policy", { source_namespace_id: "ns-owner-machine-cancel-source", revision: 1,
    authorized_principal_refs_json: JSON.stringify([grantor]), allowed_ownership_modes_json: '["immutable_import"]',
    source_class: "document", assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY",
    allowed_use_json: '["research"]', disclosure_ceiling: "private", license_policy_ref: "license-1",
    default_storage_policy: "NORMALIZED_CLOUD_ONLY", default_residency_profile_id: "residency-1",
    default_retention_policy_id: "retention-1", minimum_quality_state: "standard", created_at: createdAt });
  const principal = { principal_ref: "cancel-machine.access", credential_generation: "original-machine-credential",
    deployment_generation: runtime.DEPLOYMENT_GENERATION };
  const ownerContext: AuthenticatedRequestContext = {
    principal_ref: grantor, client_class: "owner_pwa", credential_generation: principal.credential_generation,
    trace_id: "owner-cancel-fixture", request: new Request("https://research.example/api/v1/research/projects", {
      method: "POST", headers: { "idempotency-key": "old-owner-cancel-project" },
    }),
    access: { principal_ref: grantor, credential_generation: principal.credential_generation, expires_at: expires },
  };
  const project = await createProjectOwnerService({ database: db, deployment_generation: principal.deployment_generation })
    .create(ownerContext, { idempotency_key: "old-owner-cancel-project", title: "Machine cancellation",
      source_ids: ["owner-machine-cancel-source"] });
  const operationId = `run-${(await digest(new TextEncoder().encode("old-owner-cancel"))).slice(0, 48)}`;
  const grant: ProjectClientGrant = { protocol: "eliotr.project-client-grant.v1", grant_id: "old-owner-cancel-grant",
    revision: 1, project_id: project.project_ref.id, grantor_principal_ref: grantor,
    grantee: { issuer: "https://cancel-fixture.cloudflareaccess.com", authentication_method: "service_token",
      subject: principal.principal_ref }, state: "ACTIVE", allowed_operations: ["run", "recover", "evidence"],
    ingest_namespace_ids: [], spend_policy_ref: "cancel-fixture-spend", expires_at: expires,
    created_at: createdAt, updated_at: createdAt };
  const grantJson = canonicalEvidenceJson(grant), grantDigest = await digest(new TextEncoder().encode(grantJson));
  await db.prepare("INSERT INTO project_client_grant(grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256,spend_policy_sha256,spend_deployment_generation,spend_expires_at,spend_policy_protocol) VALUES(?1,1,?2,?3,?4,'service_token',?5,'ACTIVE',?6,'old-owner-cancel-grant',?7,?8,?7,?7,?9,?6,'eliotr.research-owner-spend-template.v1')")
    .bind(grant.grant_id, grant.project_id, grantor, grant.grantee.issuer, principal.principal_ref,
      expires, grantDigest, grantJson, principal.deployment_generation).run();
  // Freeze/grant through the real owner authority so historical source-policy
  // baselines and participant identities are valid, unlike a transport-only scope.
  const authority = createOwnerScopeAuthority(db, ownerContext);
  const scope = await createD1ScopeService(db, authority).freeze(
    { kind: "PROJECT", project_id: grant.project_id }, principal.credential_generation);
  await authority.grant(scope);
  const requestDigest = await digest(new TextEncoder().encode("old-owner-cancel-request"));
  await db.prepare("INSERT INTO orientation_request(operation_id,principal_ref,client_class,credential_generation,idempotency_key,request_digest,state,created_at,expires_at,execution_operation_id,execution_client_grant_id,execution_client_grant_revision) VALUES('old-owner-cancel-orientation',?1,'trusted_agent',?2,?3,?4,'PREPARED',?5,?6,?7,?8,1)")
    .bind(principal.principal_ref, principal.credential_generation, `research-execution:${operationId}`,
      requestDigest, scope.created_at, scope.expires_at, operationId, grant.grant_id).run();
  await db.prepare("UPDATE orientation_request SET snapshot_id=?1,snapshot_revision=1 WHERE operation_id='old-owner-cancel-orientation'")
    .bind(scope.snapshot_id).run();
  await db.prepare("INSERT INTO scope_access_grant(snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at,created_at,project_client_grant_id,project_client_grant_revision,project_client_operation,project_client_project_generation,project_client_run_operation_id,project_client_authority_epoch) VALUES(?1,1,?2,'trusted_agent',?3,?4,'[\"research\"]','private','old-owner-cancel-machine-authorization','ACTIVE',?5,?6,?7,1,'run',?8,?9,(SELECT generation FROM orientation_authority_epoch WHERE singleton=1))")
    .bind(scope.snapshot_id, principal.principal_ref, principal.credential_generation, scope.policy_authority_ref,
      scope.expires_at, createdAt, grant.grant_id, project.revision, operationId).run();
  const orientationResult = JSON.stringify({ execution: { operation_id: operationId, deadline: scope.expires_at,
    request_digest: requestDigest }, result: { evidence_pack: { scope_snapshot_ref: { id: scope.snapshot_id, revision: 1 } } } });
  await db.prepare("UPDATE orientation_request SET state='COMPLETE',result_json=?1,result_digest=?2 WHERE operation_id='old-owner-cancel-orientation'")
    .bind(orientationResult, await digest(new TextEncoder().encode(orientationResult))).run();
  await db.batch([
    db.prepare("INSERT INTO investigation_current_policy VALUES ('old-owner-cancel-policy',?1,'ACTIVE',?2)")
      .bind(scope.policy_authority_ref, createdAt),
    db.prepare("INSERT OR IGNORE INTO investigation_current_deployment(deployment_generation,state,created_at) VALUES (?1,'ACTIVE',?2)")
      .bind(principal.deployment_generation, createdAt),
  ]);
  const bytes = new TextEncoder().encode("Machine run fixture; no provider dispatch"), hash = await digest(bytes);
  const objectRef = "old-owner-cancel-input";
  await runtime.WORK_BUCKET.put(objectRef, bytes, { sha256: hash });
  const ledger = createInvestigationLedgerService(createD1InvestigationLedgerStore(db as unknown as LedgerD1Database), {
    current: async () => ({ principal_ref: principal.principal_ref, scope_snapshot_id: scope.snapshot_id,
      scope_snapshot_revision: 1, policy_generation: "old-owner-cancel-policy", policy_authority_ref: scope.policy_authority_ref,
      deployment_generation: principal.deployment_generation, purge_revision: 0, scope_purge_revision: 0 }),
  }, { has: async ref => (await runtime.WORK_BUCKET.head(ref)) !== null, digestFor: async () => hash });
  await ledger.create({ investigation_id: "old-owner-cancel-investigation", goal: "Retained failed machine run",
    scope_snapshot_id: scope.snapshot_id, scope_snapshot_revision: 1, evidence_grade: "E1", lane: "exploratory",
    lane_registrations: [], obligations: [], hypotheses: [], portfolio_ref: objectRef, debt_refs: [],
    principal_ref: principal.principal_ref, input_digest: hash, policy_generation: "old-owner-cancel-policy",
    policy_authority_ref: scope.policy_authority_ref, deployment_generation: principal.deployment_generation,
    idempotency_key: "old-owner-cancel-run", model_profile_ref: "controlled-model", event_id: "old-owner-cancel-created",
    payload_handle_ref: objectRef, payload_digest: hash, created_at: createdAt });
  let request: StageRequest = { protocol: "eliotr.workflow-stage.v1", operation_id: operationId,
    investigation_ref: { id: "old-owner-cancel-investigation", revision: 1 }, stage: "FREEZE_PROTOCOL_AND_SCOPE",
    idempotency_key: "old-owner-cancel-run", handler_generation: "research-handlers.exploratory.v7",
    input_manifest: { object_ref: objectRef, sha256: hash, byte_length: bytes.byteLength, residency: {
      scope_domain_id: scope.snapshot_id, access_domain_id: principal.principal_ref, confidentiality_domain_id: "private",
      encryption_key_domain_id: "fixture-key", retention_domain_id: "fixture-retention", erasure_domain_id: "fixture-erasure",
      content_digest: { algorithm: "sha256", digest: hash } } } };
  const budget = { receipt_ref: "old-owner-cancel-budget", expires_at_ms: Date.now() + 300_000 };
  const executor = createWorkflowCheckpointExecutor(db, runtime.WORK_BUCKET, {
    authorizeResidency: async () => {}, checkBudget: async () => budget,
  });
  for (const stage of RESEARCH_WORKFLOW_STAGES.slice(0, 8)) {
    const receipt = await executor.execute({ ...request, stage }, principal, async () => bytes);
    request = { ...request, investigation_ref: receipt.investigation_ref, input_manifest: receipt.output_manifest };
  }
  const original = { principal, grant, request };
  const active = "changed-owner-control-deployment";
  await db.batch([
    db.prepare("UPDATE investigation_current_deployment SET state='RETIRED',backend_fingerprint=?1 WHERE deployment_generation=?2")
      .bind("a".repeat(64), original.principal.deployment_generation),
    db.prepare("INSERT INTO investigation_current_deployment(deployment_generation,state,created_at,backend_fingerprint) VALUES (?1,'ACTIVE',?2,?3)")
      .bind(active, new Date().toISOString(), "b".repeat(64)),
  ]);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM research_deployment_compatible WHERE origin_deployment_generation=?1 AND active_deployment_generation=?2")
    .bind(original.principal.deployment_generation, active).first<number>("n")).toBe(0);
  expect(await db.prepare("SELECT reader_principal_ref FROM owner_machine_run_origin WHERE operation_id=?1")
    .bind(original.request.operation_id).first()).toMatchObject({ reader_principal_ref: original.grant.grantor_principal_ref });
  const owner: AccessVerifier = { verify: async () => ({ principal_ref: original.grant.grantor_principal_ref,
    credential_generation: "current-owner-control-credential", authentication_method: "cloudflare_access",
    expires_at: new Date(Date.now() + 3_600_000).toISOString() }) };
  const terminate = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const restart = vi.fn(async () => {});
  const get = vi.fn(async (id: string) => ({ id, terminate, resume, restart,
    status: async () => ({ status: "errored", output: null, error: null }) }));
  const provider = vi.fn(async () => { throw new Error("Run control must not dispatch a provider"); });
  vi.stubGlobal("fetch", provider);
  const controlRequest = (operation: "cancel" | "recover") => new Request(
    `https://research.example/api/v1/research/run/${original.request.operation_id}/${operation}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": `owner-${operation}-once` }, body: "{}",
    });
  const call = (operation: "cancel" | "recover", database = db) => handleHttp(controlRequest(operation), {
    ...runtime, CORE_DB: database, DEPLOYMENT_GENERATION: active,
    RESEARCH_WORKFLOW: { get } as unknown as typeof runtime.RESEARCH_WORKFLOW,
  }, {} as ExecutionContext, { accessVerifier: owner });
  const run = () => db.prepare("SELECT * FROM research_workflow_run WHERE operation_id=?1")
    .bind(original.request.operation_id).first<Record<string, unknown>>();
  const execution = () => Promise.all(["research_workflow_attempt", "research_workflow_checkpoint", "research_model_attempt",
    "investigation_ledger_head", "investigation_ledger_event", "outbox"].map(async table =>
    (await db.prepare(`SELECT * FROM ${table}`).all()).results));
  return { ...original, call, run, execution, get, terminate, resume, restart, provider };
}

describe("current-owner cancellation of retired machine runs on native D1", () => {
  it("cancels the exact old run while recovery remains incompatible and execution records remain unchanged", async () => {
    const f = await fixture();
    const before = await f.run(), execution = await f.execution();
    const deniedRecovery = await f.call("recover");
    expect(deniedRecovery.status, await deniedRecovery.clone().text()).toBe(403);
    expect(f.get).not.toHaveBeenCalled();
    const response = await f.call("cancel");
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await body<ResearchRunStatus>(response)).data).toMatchObject({
      workflow_instance_id: f.request.operation_id, execution_state: "CANCELLED", next_stage_index: 8,
      cancellation_receipt_ref: `workflow-cancelled:${f.request.operation_id}`,
    });
    expect(await f.run()).toEqual({ ...before, state: "CANCELLED",
      cancellation_receipt_ref: `workflow-cancelled:${f.request.operation_id}` });
    expect(await f.execution()).toEqual(execution);
    expect((await new WorkflowCheckpointStore(db).readRunStatus(f.request.operation_id, f.principal, "owner-read"))?.state)
      .toBe("CANCELLED");
    expect(f.terminate).toHaveBeenCalledTimes(1);
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  }, 60_000);

  it("retains current-grant and SQL epoch fences when owner authority is revoked just before cancellation", async () => {
    const f = await fixture();
    const before = await f.run();
    let revoked = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (revoked || phase !== "before" || !sql.startsWith("UPDATE research_workflow_run SET state='CANCELLED'")) return;
      revoked = true;
      await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1 AND client_class='owner_pwa'")
        .bind(f.grant.grantor_principal_ref).run();
    });
    const response = await f.call("cancel", observed);
    expect(revoked).toBe(true);
    expect(response.status, await response.clone().text()).toBe(503);
    expect(await response.json()).toMatchObject({ code: "RESEARCH_CONTROL_UNCONFIRMED", retryable: true });
    expect(await f.run()).toEqual(before);
    expect((await db.prepare("SELECT a.state,a.error_code FROM operation_intent i JOIN operation_attempt a " +
      "ON a.intent_id=i.intent_id AND a.intent_revision=i.revision WHERE i.operation_kind='research.run.cancel.v1'")
      .all<{ state: string; error_code: string | null }>()).results).toEqual([{ state: "STARTED", error_code: null }]);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  }, 60_000);
});
