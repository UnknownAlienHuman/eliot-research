import { beforeEach, describe, expect, it, vi } from "vitest";
import { reset } from "cloudflare:test";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { createD1InvestigationLedgerStore, createInvestigationLedgerService, type LedgerD1Database } from "@eliotr/research";
import { createMonotoneStageExecutor, digest, WorkflowCheckpointStore, type StageRequest } from "@eliotr/cloudflare-research";
import { createEvidenceFreezePostSynthesisContextReader, type ResearchArtifactReportPolicy } from "@eliotr/cloudflare-research";
import { createResearchCoverageStageHandlerFromFreeze, createResearchCoverageMaterializeStageHandlerFromFreeze } from "@eliotr/cloudflare-research-stages";
import { createResearchStageHandlerFactory, SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import { researchClaimAuditStageFixture } from "./research-claim-audit-fixture.js";
import { principal as freezePrincipal } from "./research-evidence-freeze-fixture.js";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import type { ResearchRunStatus } from "@eliotr/interfaces";
import { handleHttp } from "../src/http.js";
import { body, db, principal, credential, run, runtime, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";

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
    db.prepare("INSERT INTO investigation_current_deployment VALUES (?1,'ACTIVE',?2)")
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

  it("reopens an actual synthesized, audited and materialized v3 draft after login without rerunning the models", async () => {
    const audited = await researchClaimAuditStageFixture({ include_counterevidence: true });
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
      generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION, navigation: freeze.navigation, ledger: freeze.ledger,
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
