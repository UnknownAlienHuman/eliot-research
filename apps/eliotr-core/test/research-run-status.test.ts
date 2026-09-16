import { beforeEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { createD1InvestigationLedgerStore, createInvestigationLedgerService, type LedgerD1Database } from "@eliotr/research";
import { createMonotoneStageExecutor, digest, WorkflowCheckpointStore, type StageRequest } from "@eliotr/cloudflare-research";
import { createEvidenceFreezePostSynthesisContextReader, type ResearchArtifactReportPolicy } from "@eliotr/cloudflare-research";
import { createResearchCoverageStageHandlerFromFreeze, createResearchCoverageMaterializeStageHandlerFromFreeze } from "@eliotr/cloudflare-research-stages";
import { createResearchStageHandlerFactory, SERVER_OWNED_FREEZE_HANDLER_GENERATION, SERVER_OWNED_SEMANTIC_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import { researchClaimAuditStageFixture } from "./research-claim-audit-fixture.js";
import { principal as freezePrincipal } from "./research-evidence-freeze-fixture.js";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import type { ResearchEngineStatus, ResearchRunStatus } from "@eliotr/interfaces";
import { handleHttp } from "../src/http.js";
import { body, db, principal, credential, run, runtime, seedSource, setupOrientationDatabase, verifier, observeDatabase } from "./orientation-fixture.js";

beforeEach(async () => {
  await reset();
  await setupOrientationDatabase();
  await seedSource("run-status");
});

/** Real W1 create and W2 reservation isolate status reading from the installed
 * model configuration. No fake completed rows or model-success fixtures. */
async function storedRun(completed = false) {
  const access = { principal_ref: principal, client_class: "owner_pwa" as const, credential_generation: credential };
  const authority = createOwnerScopeAuthority(db, access);
  const scope = await createD1ScopeService(db, authority).freeze(
    { kind: "SELECTED_SOURCES", source_ids: ["run-status"] }, credential,
  );
  await authority.grant(scope);
  const createdAt = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO investigation_current_policy VALUES ('status-policy',?1,'ACTIVE',?2)")
      .bind(scope.policy_authority_ref, createdAt),
    db.prepare("INSERT INTO investigation_current_deployment(deployment_generation,state,created_at) VALUES (?1,'ACTIVE',?2)")
      .bind(runtime.DEPLOYMENT_GENERATION, createdAt),
  ]);
  const bytes = new TextEncoder().encode("status fixture, not a model result");
  const hash = await digest(bytes);
  const key = "status-portfolio";
  await runtime.WORK_BUCKET.put(key, bytes, { sha256: hash });
  const actor = { principal_ref: principal, credential_generation: credential, deployment_generation: runtime.DEPLOYMENT_GENERATION };
  const ledger = createInvestigationLedgerService(
    createD1InvestigationLedgerStore(db as unknown as LedgerD1Database),
    { current: async () => ({ principal_ref: principal, scope_snapshot_id: scope.snapshot_id, scope_snapshot_revision: 1,
      policy_generation: "status-policy", policy_authority_ref: scope.policy_authority_ref,
      deployment_generation: runtime.DEPLOYMENT_GENERATION, purge_revision: 0, scope_purge_revision: 0 }) },
    { has: async (ref) => (await runtime.WORK_BUCKET.head(ref)) !== null, digestFor: async () => hash },
  );
  await ledger.create({ investigation_id: "status-investigation", goal: "read status", scope_snapshot_id: scope.snapshot_id,
    scope_snapshot_revision: 1, evidence_grade: "E0", lane: "exploratory", lane_registrations: [], obligations: [],
    hypotheses: [], portfolio_ref: key, debt_refs: [], principal_ref: principal, input_digest: hash,
    policy_generation: "status-policy", policy_authority_ref: scope.policy_authority_ref,
    deployment_generation: runtime.DEPLOYMENT_GENERATION, idempotency_key: "status-key", model_profile_ref: "status-test-only",
    event_id: "status-created", payload_handle_ref: key, payload_digest: hash, created_at: createdAt });
  const request: StageRequest = {
    protocol: "eliotr.workflow-stage.v1", operation_id: "status-run", investigation_ref: { id: "status-investigation", revision: 1 },
    stage: "FREEZE_PROTOCOL_AND_SCOPE", idempotency_key: "status-key", handler_generation: "status-test-only",
    input_manifest: { object_ref: key, sha256: hash, byte_length: bytes.byteLength, residency: {
      scope_domain_id: scope.snapshot_id, access_domain_id: principal, confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
      content_digest: { algorithm: "sha256", digest: hash },
    } },
  };
  const store = new WorkflowCheckpointStore(db);
  await store.ensureRun(request, actor);
  if (completed) {
    const budgetExpiry = Date.now() + 60_000;
    await createMonotoneStageExecutor(db, runtime.WORK_BUCKET, {
      authorizeResidency: async (value, who) => {
        expect(value.input_manifest.residency.access_domain_id).toBe(who.principal_ref);
        expect(value.input_manifest.residency.scope_domain_id).toBe(scope.snapshot_id);
      },
      checkBudget: async () => ({ receipt_ref: "status-budget", expires_at_ms: budgetExpiry }),
    }).executeOperation({ operation_id: request.operation_id, investigation_id: "status-investigation", initial_revision: 1,
      idempotency_key: request.idempotency_key, handler_generation: request.handler_generation,
      initial_input_manifest: request.input_manifest }, actor, () => async () => bytes);
  }
  return { scope, actor, request, store };
}

function refreshed(who = principal, expiresAt = Date.now() + 60_000): AccessVerifier {
  return { async verify() { return { principal_ref: who, credential_generation: "cf-access-jwt:new-key:1789492800",
    authentication_method: "cloudflare_access", expires_at: new Date(expiresAt).toISOString() }; } };
}
function statusRequest() { return new Request("https://research.example/api/v1/research/run/status-run"); }
async function executionSnapshot() {
  const tables = ["research_workflow_run", "research_workflow_attempt", "research_workflow_checkpoint", "research_model_attempt",
    "investigation_ledger_head", "investigation_ledger_event", "outbox"];
  return Promise.all(tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results));
}

describe("owner run status after reauthentication over real HTTP/D1/R2", () => {
  it("reads completed history through both credentials without rewriting execution or creating model work", async () => {
    await storedRun(true);
    const before = await executionSnapshot();
    const original = await run(statusRequest());
    expect(original.status, JSON.stringify(await original.clone().json())).toBe(200);
    const next = await run(statusRequest(), refreshed());
    expect(next.status, JSON.stringify(await next.clone().json())).toBe(200);
    expect((await body<ResearchRunStatus>(next)).data).toEqual((await body<ResearchRunStatus>(original)).data);
    expect((await run(statusRequest(), refreshed())).status).toBe(200);
    expect(await executionSnapshot()).toEqual(before);
  }, 30_000);

  it("includes a pre-login run in history without requiring the new credential to have created it", async () => {
    await storedRun();
    const response = await run(new Request("https://research.example/api/v1/research/runs"), refreshed());
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const result = await body<{ runs: { status: ResearchRunStatus }[] }>(response);
    expect(result.data.runs.map((item) => item.status.workflow_instance_id)).toEqual(["status-run"]);
  });

  it("keeps the original run readable under an equal-backend PWA-only deployment", async () => {
    await storedRun();
    const before = await executionSnapshot();
    const fingerprint = "a".repeat(64);
    const nextDeployment = "status-pwa-only";
    await db.prepare("UPDATE investigation_current_deployment SET state='RETIRED',backend_fingerprint=?2 WHERE deployment_generation=?1")
      .bind(runtime.DEPLOYMENT_GENERATION, fingerprint).run();
    await db.prepare("INSERT INTO investigation_current_deployment(deployment_generation,state,created_at,backend_fingerprint) VALUES (?1,'ACTIVE',?2,?3)")
      .bind(nextDeployment, new Date().toISOString(), fingerprint).run();
    const nextRuntime = { ...runtime, DEPLOYMENT_GENERATION: nextDeployment };
    const status = await handleHttp(statusRequest(), nextRuntime, {} as ExecutionContext, { accessVerifier: verifier() });
    expect(status.status, JSON.stringify(await status.clone().json())).toBe(200);
    const history = await handleHttp(new Request("https://research.example/api/v1/research/runs"), nextRuntime,
      {} as ExecutionContext, { accessVerifier: verifier() });
    expect(history.status, JSON.stringify(await history.clone().json())).toBe(200);
    expect((await body<{ runs: { status: ResearchRunStatus }[] }>(history)).data.runs
      .map((item) => item.status.workflow_instance_id)).toContain("status-run");
    expect(await executionSnapshot()).toEqual(before);
    await db.prepare("UPDATE investigation_current_deployment SET backend_fingerprint=?2 WHERE deployment_generation=?1")
      .bind(nextDeployment, "b".repeat(64)).run();
    const incompatible = await handleHttp(statusRequest(), nextRuntime, {} as ExecutionContext, { accessVerifier: verifier() });
    expect(incompatible.status).toBe(409);
  });

  it("preserves durable cancellation across login and does not resume the run", async () => {
    const f = await storedRun();
    const receipt = await f.store.cancel(f.request.operation_id, f.actor);
    const before = await executionSnapshot();
    const response = await run(statusRequest(), refreshed());
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect((await body<ResearchRunStatus>(response)).data).toMatchObject({ execution_state: "CANCELLED", cancellation_receipt_ref: receipt });
    expect(await executionSnapshot()).toEqual(before);
  });

  it("denies foreign owners, service tokens and unknown operations without issuing read grants", async () => {
    await storedRun();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM scope_access_grant").first<number>("n");
    expect((await run(statusRequest(), refreshed("stranger"))).status).toBe(404);
    expect((await run(statusRequest(), verifier(principal, "service_token"))).status).toBe(403);
    expect((await run(new Request("https://research.example/api/v1/research/run/not-a-run"), refreshed())).status).toBe(404);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_access_grant").first<number>("n")).toBe(before);
  });

  it("does not turn explicit original-grant revocation into a new read permit", async () => {
    const f = await storedRun();
    await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=1")
      .bind(f.scope.snapshot_id).run();
    const before = await executionSnapshot();
    const response = await run(statusRequest(), refreshed());
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe("RESEARCH_AUTHORITY_STALE");
    expect(await executionSnapshot()).toEqual(before);
  });

  it("denies removed source permissions", async () => {
    await storedRun();
    await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE principal_ref=?1").bind(principal).run();
    expect((await run(statusRequest(), refreshed())).status).toBe(409);
  });

  it("denies purged members without rewriting or restarting the original run", async () => {
    await storedRun();
    await db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_id='run-status'").run();
    const before = await executionSnapshot();
    const response = await run(statusRequest(), refreshed());
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe("RESEARCH_AUTHORITY_STALE");
    expect(await executionSnapshot()).toEqual(before);
  });

  it("rechecks authorization after native status I/O and does not disclose a late result", async () => {
    const f = await storedRun();
    let observed = false;
    const observedRuntime = { ...runtime, RESEARCH_WORKFLOW: {
      ...runtime.RESEARCH_WORKFLOW,
      get: async () => ({ id: "status-run", status: async () => {
        observed = true;
        await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=1")
          .bind(f.scope.snapshot_id).run();
        return { status: "running" };
      } }),
    } } as unknown as typeof runtime;
    const response = await handleHttp(statusRequest(), observedRuntime, {} as ExecutionContext, { accessVerifier: refreshed() });
    expect(observed).toBe(true);
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe("RESEARCH_AUTHORITY_STALE");
  });

  it("rejects expired access without issuing another read grant", async () => {
    await storedRun();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM scope_access_grant").first<number>("n");
    const response = await run(statusRequest(), refreshed(principal, Date.now() - 1));
    expect(response.status).toBe(409);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_access_grant").first<number>("n")).toBe(before);
  });

  it("denies access that expires during native status observation", async () => {
    await storedRun();
    const expiry = Date.now() + 60_000;
    let observed = false;
    const observedRuntime = { ...runtime, RESEARCH_WORKFLOW: {
      ...runtime.RESEARCH_WORKFLOW,
      get: async () => ({ id: "status-run", status: async () => {
        observed = true;
        vi.spyOn(Date, "now").mockReturnValue(expiry + 1);
        return { status: "running" };
      } }),
    } } as unknown as typeof runtime;
    try {
      const response = await handleHttp(statusRequest(), observedRuntime, {} as ExecutionContext,
        { accessVerifier: refreshed(principal, expiry) });
      expect(observed).toBe(true);
      expect(response.status).toBe(409);
      expect((await body(response)).code).toBe("RESEARCH_AUTHORITY_STALE");
    } finally { vi.restoreAllMocks(); }
  });

  it("does not treat credential refresh as deployment compatibility", async () => {
    await storedRun();
    const response = await handleHttp(statusRequest(), { ...runtime, DEPLOYMENT_GENERATION: "other-deployment" },
      {} as ExecutionContext, { accessVerifier: refreshed() });
    expect(response.status).toBe(409);
  });

  it.each([SERVER_OWNED_FREEZE_HANDLER_GENERATION, SERVER_OWNED_SEMANTIC_HANDLER_GENERATION] as const)("reopens an actual synthesized, audited and materialized %s draft after login without rerunning the models", async (generation) => {
    const audited = await researchClaimAuditStageFixture({ include_counterevidence: true, handler_generation: generation });
    const freeze = audited.fixture.freeze;
    const environment = { database: freeze.db, work_bucket: freeze.bucket,
      manifest_store: freeze.freeze_store, read_stage_five: freeze.readers.read_stage_five };
    const workflow = new WorkflowCheckpointStore(freeze.db);
    const recheck = async () => {
      const state = await workflow.readRunStatus(freeze.operation_id, freezePrincipal);
      if (state === null) throw new Error("materialized fixture lost its run");
      return { investigation_id: state.investigation_id, scope_snapshot_id: state.scope_snapshot_id,
        scope_snapshot_revision: state.scope_snapshot_revision };
    };
    let previous = await freeze.executor.execute(audited.stage14, freezePrincipal, audited.auditHandler);
    const domains = { scope_domain_id: freeze.scope.snapshot_id, access_domain_id: freezePrincipal.principal_ref,
      confidentiality_domain_id: "status-private", encryption_key_domain_id: "status-key",
      retention_domain_id: "status-retention", erasure_domain_id: "status-erasure" };
    const reportPolicy: ResearchArtifactReportPolicy = {
      kind: "technical_audit", title: "Historical draft", audience: "owner", language: "en",
      section_contract: { section_id: "summary", title: "Summary", purpose: "Exact preserved evidence",
        required_claim_kinds: ["claim"], required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 },
      statement_labels: { claim: "UNRESOLVED" }, citation_policy_ref: "status-citations-v1",
      verification_policy_ref: "status-verification-v1", length_policy_ref: "status-length-v1",
      export_formats: ["markdown"], include_counterevidence: true, include_methodology: true,
      budget_ref: "status-report-budget", section_residency: domains, manifest_residency: domains,
    };
    const policy = await freeze.db.prepare("SELECT policy_generation,policy_authority_ref FROM research_workflow_run WHERE operation_id=?1")
      .bind(freeze.operation_id).first<{ policy_generation: string; policy_authority_ref: string }>();
    if (policy === null) throw new Error("materialized fixture lost its report policy");
    const handlers = createResearchStageHandlerFactory({ kind: "server-owned-exploratory",
      generation, navigation: freeze.navigation, ledger: freeze.ledger,
      resolve_citations: { database: freeze.db, navigation: freeze.navigation, evidence_resolver: freeze.resolver,
        context: createEvidenceFreezePostSynthesisContextReader(environment, freeze.navigation, freeze.readers, "RESOLVE_CITATIONS") },
      calculate_coverage: createResearchCoverageStageHandlerFromFreeze(environment, freeze.navigation, freeze.readers, { ledger: freeze.ledger }),
      materialize_handler: createResearchCoverageMaterializeStageHandlerFromFreeze(environment, freeze.navigation, freeze.readers, {
        database: freeze.db, work_bucket: freeze.bucket, evidence_resolver: freeze.resolver, recheck_authority: recheck,
        report_policy: reportPolicy, policy_source: { provenance_ref: "status-report-policy-source",
          read: async () => ({ schema: "eliotr.research.report-admission.v1", policy_ref: "status-report-policy", policy_revision: 1,
            config_provenance_ref: "status-report-policy-source", principal_ref: freezePrincipal.principal_ref,
            client_class: "owner_pwa", policy_generation: policy.policy_generation, policy_authority_ref: policy.policy_authority_ref,
            allowed_use: ["research"], disclosure_ceiling: "owner-only", requested_output_class: "private-draft",
            purpose: "research-report-materialization", expires_at: freeze.scope.expires_at }) },
      }),
    });
    for (const stage of ["RESOLVE_CITATIONS", "CALCULATE_COVERAGE", "MATERIALIZE"] as const) {
      const request: StageRequest = { ...audited.stage14, stage,
        investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest };
      let cause: unknown;
      const handler = handlers(stage);
      previous = await freeze.executor.execute(request, freezePrincipal, async (input) => {
        try { return await handler(input); } catch (error) { cause = error; throw error; }
      }).catch((error: unknown) => { throw cause ?? error; });
    }
    expect(previous.engine_state).toBe("ENGINE_COMPLETED");
    expect(audited.fixture.provider_calls()).toBe(1);
    expect(audited.auditProviderCalls()).toBe(1);
    const readEnv = { ...runtime, DEPLOYMENT_GENERATION: freezePrincipal.deployment_generation };
    const statusUrl = `https://research.example/api/v1/research/run/${freeze.operation_id}`;
    const oldAccess: AccessVerifier = { verify: async () => ({ ...freezePrincipal,
      authentication_method: "cloudflare_access", expires_at: new Date(Date.now() + 60_000).toISOString() }) };
    const before = await executionSnapshot();
    const first = await handleHttp(new Request(statusUrl), readEnv, {} as ExecutionContext, { accessVerifier: oldAccess });
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
    const original = (await body<ResearchRunStatus>(first)).data;
    expect(original.answer.availability).toBe("draft");
    for (let i = 0; i < 2; i += 1) {
      const response = await handleHttp(new Request(statusUrl), readEnv, {} as ExecutionContext,
        { accessVerifier: refreshed(freezePrincipal.principal_ref) });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      expect((await body<ResearchRunStatus>(response)).data).toEqual(original);
    }
    expect(await executionSnapshot()).toEqual(before);
    expect(audited.fixture.provider_calls()).toBe(1);
    expect(audited.auditProviderCalls()).toBe(1);
    await freeze.bucket.put(previous.output_manifest.object_ref, new TextEncoder().encode("corrupt saved materialization"));
    const corrupt = await handleHttp(new Request(statusUrl), readEnv, {} as ExecutionContext,
      { accessVerifier: refreshed(freezePrincipal.principal_ref) });
    expect(corrupt.status).toBe(409);
    expect((await body(corrupt)).code).toBe("RESEARCH_RUN_STATUS_INVALID");
  }, 60_000);

  it("classifies a mismatched current-view read as corruption, using the store's real batch contract", async () => {
    const row = { operation_id: "run-corrupt", investigation_id: "investigation", initial_revision: 1, current_revision: 1,
      principal_ref: "owner", credential_generation: "credential", deployment_generation: "deployment",
      scope_snapshot_id: "scope", scope_snapshot_revision: 1, next_stage_index: 0, state: "ACTIVE", cancellation_receipt_ref: null };
    const fake = { prepare: () => ({ bind: () => ({}) }), batch: async () => [
      { success: true, results: [row] }, { success: true, results: [{ ...row, ledger_revision: 2 }] }, { success: true, results: [] },
    ] } as unknown as D1Database;
    await expect(new WorkflowCheckpointStore(fake).readRunStatus("run-corrupt", {
      principal_ref: "owner", credential_generation: "credential", deployment_generation: "deployment",
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });
});


function cancelRequest(body: unknown = {}, key: string | null = "cancel-key", extra: Record<string, string> = {}) {
  return new Request("https://research.example/api/v1/research/run/status-run/cancel", {
    method: "POST", headers: { "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }), ...extra },
    body: JSON.stringify(body),
  });
}
function controlledNative(core = db, terminate = vi.fn(async () => {})) {
  const get = vi.fn(async (id: string) => ({ id, terminate }));
  const controls = { ...runtime, CORE_DB: core, RESEARCH_WORKFLOW: { get } as unknown as typeof runtime.RESEARCH_WORKFLOW };
  const call = (request = cancelRequest(), auth = verifier()) =>
    handleHttp(request, controls, {} as ExecutionContext, { accessVerifier: auth });
  return { call, get, terminate };
}

function recoverRequest(body: unknown = {}, key: string | null = "recover-key", extra: Record<string, string> = {}) {
  return new Request("https://research.example/api/v1/research/run/status-run/recover", {
    method: "POST", headers: { "content-type": "application/json", ...(key === null ? {} : { "idempotency-key": key }), ...extra },
    body: JSON.stringify(body),
  });
}
function controlledRecoveryNative(initial: ResearchEngineStatus, options: { readonly throw_after_restart?: boolean } = {}) {
  let state = initial;
  const status = vi.fn(async () => ({ status: state, output: null, error: null }));
  const resume = vi.fn(async () => { state = "running"; });
  const restart = vi.fn(async (_input?: unknown) => { state = "running"; if (options.throw_after_restart === true) throw new Error("lost native ACK"); });
  const get = vi.fn(async (id: string) => ({ id, status, resume, restart }));
  const controls = { ...runtime, RESEARCH_WORKFLOW: { get } as unknown as typeof runtime.RESEARCH_WORKFLOW };
  const call = (request = recoverRequest(), auth = verifier()) =>
    handleHttp(request, controls, {} as ExecutionContext, { accessVerifier: auth });
  return { call, get, status, resume, restart, current: () => state };
}

describe("public ordinary-run cancellation over HTTP/D1", () => {
  it("cancels before execution, returns the existing receipt and replays without another native call", async () => {
    const f = await storedRun();
    const c = controlledNative();
    const response = await c.call();
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const result = (await body<ResearchRunStatus>(response)).data;
    expect(result).toMatchObject({ execution_state: "CANCELLED", cancellation_receipt_ref: "workflow-cancelled:status-run",
      workflow_instance_id: "status-run", next_stage_index: 0, answer: { availability: "unavailable" } });
    expect((await f.store.readRunStatus("status-run", f.actor))?.state).toBe("CANCELLED");
    expect((await body<ResearchRunStatus>(await run(statusRequest()))).data).toEqual(result);
    expect((await body<ResearchRunStatus>(await c.call())).data).toEqual(result);
    expect(c.terminate).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM research_workflow_attempt").first<number>("n")).toBe(0);
  });

  it("authorizes the same owner with a new JWT, without replacing the recorded execution identity", async () => {
    const f = await storedRun();
    const before = await db.prepare("SELECT * FROM research_workflow_run").first();
    const c = controlledNative();
    expect((await c.call(cancelRequest(), refreshed())).status).toBe(200);
    const after = await db.prepare("SELECT * FROM research_workflow_run").first();
    expect(after).toEqual({ ...before, state: "CANCELLED", cancellation_receipt_ref: "workflow-cancelled:status-run" });
    expect((await body<ResearchRunStatus>(await run(statusRequest(), refreshed()))).data.execution_state).toBe("CANCELLED");
    expect((await f.store.readRunStatus("status-run", f.actor))?.next_stage_index).toBe(0);
  });

  it("rejects completion-first without undoing checkpoints", async () => {
    await storedRun(true);
    const snapshot = await executionSnapshot();
    const c = controlledNative();
    expect((await c.call()).status).toBe(409);
    expect(c.get).not.toHaveBeenCalled();
    expect(await executionSnapshot()).toEqual(snapshot);
  });

  it("does not confuse a failed write with cancellation, and reconciles a lost D1 acknowledgement", async () => {
    await storedRun();
    await db.exec("CREATE TRIGGER fail_public_cancel BEFORE UPDATE OF state ON research_workflow_run WHEN NEW.state='CANCELLED' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    const c = controlledNative();
    try {
      expect((await c.call()).status).toBe(503);
      expect(await db.prepare("SELECT state FROM research_workflow_run").first<string>("state")).toBe("ACTIVE");
      expect(c.get).not.toHaveBeenCalled();
    } finally { await db.exec("DROP TRIGGER fail_public_cancel"); }
    let lost = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (!lost && phase === "after" && sql.startsWith("UPDATE research_workflow_run SET state='CANCELLED'")) {
        lost = true; throw new Error("lost acknowledgement, durable write already happened");
      }
    });
    const reconciled = controlledNative(observed);
    expect((await reconciled.call()).status).toBe(200);
    expect(lost).toBe(true);
    expect(reconciled.terminate).toHaveBeenCalledTimes(1);
    expect((await reconciled.call()).status).toBe(200);
    expect(reconciled.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps canonical CANCELLED when native termination fails", async () => {
    await storedRun();
    const c = controlledNative(db, vi.fn(async () => { throw new Error("native timeout"); }));
    const response = await c.call();
    expect(response.status).toBe(200);
    expect((await body<ResearchRunStatus>(response)).data.execution_state).toBe("CANCELLED");
    expect((await body<ResearchRunStatus>(await run(statusRequest()))).data.execution_state).toBe("CANCELLED");
  });

  it("rejects foreign/missing/service/expired/CSRF and unknown-body requests before effects", async () => {
    await storedRun();
    const c = controlledNative();
    const snapshot = await executionSnapshot();
    expect((await c.call(cancelRequest(), refreshed("stranger"))).status).toBe(404);
    expect((await c.call(new Request("https://research.example/api/v1/research/run/missing/cancel", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "cancel" }, body: "{}",
    }))).status).toBe(404);
    expect((await c.call(cancelRequest(), verifier(principal, "service_token"))).status).toBe(403);
    expect((await c.call(cancelRequest(), refreshed(principal, Date.now() - 1000))).status).toBe(403);
    expect((await c.call(cancelRequest({ principal_ref: principal }))).status).toBe(400);
    expect((await c.call(cancelRequest({}, null))).status).toBe(400);
    expect((await c.call(cancelRequest({}, "cancel", { origin: "https://foreign.example" }))).status).toBe(403);
    expect((await c.call(cancelRequest({}, "cancel", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(c.get).not.toHaveBeenCalled();
    expect(await executionSnapshot()).toEqual(snapshot);
  });

  it("fences a read-policy revoke immediately before cancellation SQL", async () => {
    await storedRun();
    let revoked = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (!revoked && phase === "before" && sql.startsWith("UPDATE research_workflow_run SET state='CANCELLED'")) {
        revoked = true;
        await db.prepare("UPDATE scope_read_policy SET state='REVOKED'").run();
      }
    });
    const c = controlledNative(observed);
    const response = await c.call();
    expect(revoked).toBe(true);
    expect(response.status).toBe(403);
    expect(await db.prepare("SELECT state FROM research_workflow_run").first<string>("state")).toBe("ACTIVE");
    expect(c.get).not.toHaveBeenCalled();
  });

  it("does not revive explicitly revoked original grants after a new login", async () => {
    const f = await storedRun();
    await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1").bind(f.scope.snapshot_id).run();
    const c = controlledNative();
    expect((await c.call(cancelRequest(), refreshed())).status).toBe(403);
    expect(c.get).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT state FROM research_workflow_run").first<string>("state")).toBe("ACTIVE");
  });
});


describe("public ordinary-run recovery over HTTP/D1", () => {
  it("returns active and completed runs without issuing a native recovery action", async () => {
    await storedRun();
    const active = controlledRecoveryNative("running");
    expect((await active.call()).status).toBe(200);
    expect(active.resume).not.toHaveBeenCalled();
    expect(active.restart).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM operation_intent WHERE operation_kind='research.run.recover.v1'").first<number>("n")).toBe(0);

    await reset();
    await setupOrientationDatabase();
    await seedSource("run-status");
    await storedRun(true);
    const complete = controlledRecoveryNative("errored");
    const response = await complete.call();
    expect(response.status).toBe(200);
    expect((await body<ResearchRunStatus>(response)).data.execution_state).toBe("ENGINE_COMPLETED");
    expect(complete.get).not.toHaveBeenCalled();
  }, 30_000);

  it("resumes a paused instance once and reconciles repeats from durable state", async () => {
    await storedRun();
    const c = controlledRecoveryNative("paused");
    const first = await c.call();
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
    expect(c.resume).toHaveBeenCalledTimes(1);
    expect(c.restart).not.toHaveBeenCalled();
    expect(c.current()).toBe("running");
    expect((await c.call()).status).toBe(200);
    expect(c.resume).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT state FROM operation_attempt WHERE intent_id='research-recover:status-run:0'").first<string>("state")).toBe("SUCCEEDED");
  });

  it("restarts an errored instance without a current attempt and reconciles a lost native ACK", async () => {
    await storedRun();
    const c = controlledRecoveryNative("errored", { throw_after_restart: true });
    const first = await c.call();
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
    expect(c.restart).toHaveBeenCalledTimes(1);
    expect(c.restart).toHaveBeenCalledWith();
    expect(c.current()).toBe("running");
    expect((await c.call()).status).toBe(200);
    expect(c.restart).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT state FROM operation_attempt WHERE intent_id='research-recover:status-run:0'").first<string>("state")).toBe("SUCCEEDED");
  });

  it("refuses cancellation and a started stage with no registered safe recovery", async () => {
    const cancelled = await storedRun();
    await cancelled.store.cancel(cancelled.request.operation_id, cancelled.actor);
    const cancelledNative = controlledRecoveryNative("terminated");
    expect((await cancelledNative.call()).status).toBe(409);
    expect(cancelledNative.get).not.toHaveBeenCalled();

    await reset();
    await setupOrientationDatabase();
    await seedSource("run-status");
    const uncertain = await storedRun();
    const requestSha = await digest(new TextEncoder().encode(JSON.stringify(uncertain.request)));
    await uncertain.store.reserve(uncertain.request, requestSha, "unsafe-started", {
      receipt_ref: "unsafe-budget", expires_at_ms: Date.now() + 60_000,
    });
    const errored = controlledRecoveryNative("errored");
    const response = await errored.call();
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe("RESEARCH_RUN_RECOVERY_UNSAFE");
    expect(errored.restart).not.toHaveBeenCalled();
  });

  it("applies the same owner, body, origin and idempotency boundaries as cancellation", async () => {
    await storedRun();
    const c = controlledRecoveryNative("errored");
    expect((await c.call(recoverRequest(), refreshed("stranger"))).status).toBe(404);
    expect((await c.call(recoverRequest(), verifier(principal, "service_token"))).status).toBe(403);
    expect((await c.call(recoverRequest({ principal_ref: principal }))).status).toBe(400);
    expect((await c.call(recoverRequest({}, null))).status).toBe(400);
    expect((await c.call(recoverRequest({}, "recover", { origin: "https://foreign.example" }))).status).toBe(403);
    expect(c.restart).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM operation_intent WHERE operation_kind='research.run.recover.v1'").first<number>("n")).toBe(0);
  });
});


describe("public cancellation ordering", () => {
  it("concurrent requests converge on one receipt and never restart the native engine", async () => {
    await storedRun();
    const c = controlledNative();
    const responses = await Promise.all([c.call(), c.call(cancelRequest({}, "second-cancel-key"))]);
    expect(responses.map((response) => response.status).every((status) => status === 200 || status === 503)).toBe(true);
    const reconciled = await c.call();
    expect(reconciled.status).toBe(200);
    expect((await body<ResearchRunStatus>(reconciled)).data.cancellation_receipt_ref).toBe("workflow-cancelled:status-run");
    expect(c.terminate).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM research_workflow_run").first<number>("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM research_workflow_attempt").first<number>("n")).toBe(0);
  });

  it("cancel-first forbids a late in-flight stage from committing output", async () => {
    const f = await storedRun();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const budget = { receipt_ref: "cancellation-fixture-budget", expires_at_ms: Date.now() + 60_000 };
    const executor = createMonotoneStageExecutor(db, runtime.WORK_BUCKET, {
      authorizeResidency: async () => {},
      checkBudget: async () => budget,
    });
    const execution = executor.executeOperation({ operation_id: f.request.operation_id,
      investigation_id: f.request.investigation_ref.id, initial_revision: 1, idempotency_key: f.request.idempotency_key,
      handler_generation: f.request.handler_generation, initial_input_manifest: f.request.input_manifest }, f.actor,
      () => async () => { calls += 1; entered(); await waiting; return new TextEncoder().encode("late output"); });
    // Observe rejection immediately; a pre-dispatch failure must not hang this test.
    const stopped = execution.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await Promise.race([started, stopped.then(({ error }) => { throw error ?? new Error("Stage completed before the barrier"); })]);
    try { expect((await controlledNative().call()).status).toBe(200); }
    finally { release(); }
    expect((await stopped).error).toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(calls).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint").first<number>("n")).toBe(0);
    expect(await db.prepare("SELECT state FROM research_workflow_attempt").first<string>("state")).toBe("STARTED");
  });
});
