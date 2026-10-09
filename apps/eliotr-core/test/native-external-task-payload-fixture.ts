import type { ProjectClientGrant } from "@eliotr/contracts";
import type { CreateLedgerInput, LedgerD1Database } from "@eliotr/research";
import type { StageRequest, WorkflowExecutionPorts } from "@eliotr/cloudflare-workflows";
import { createD1InvestigationLedgerStore, createInvestigationLedgerService } from "@eliotr/research";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { createWorkflowCheckpointExecutor } from "@eliotr/cloudflare-workflows";
import { digest, fail } from "@eliotr/cloudflare-workflows";
import { NATIVE_EXTERNAL_TASK_HANDLER_GENERATION } from "@eliotr/cloudflare-workflows";

// Local D1/W2 transport qualification. Scientific handlers, admission, pinned
// production route/configuration and public API remain separate acceptance.
export async function seedNativePayloadWorkflow(
  env: { readonly CORE_DB: D1Database; readonly WORK_BUCKET: R2Bucket },
  tag: string, durationMs = 15000,
) {
  const db = env.CORE_DB;
  const bucket = env.WORK_BUCKET;
  const now = new Date().toISOString();
  const expires = new Date(Date.parse(now) + 3600000).toISOString();
  const projectId = `canonical-project-${tag}`;
  const operationId = `run-${(await digest(new TextEncoder().encode(`canonical-run-${tag}`))).slice(0,48)}`;
  const principal = { principal_ref: `canonical-actor-${tag}`,
    credential_generation: `canonical-credential-${tag}`, deployment_generation: "canonical-deployment" };
  const grant: ProjectClientGrant = { protocol: "eliotr.project-client-grant.v1", grant_id: `canonical-grant-${tag}`, revision: 1,
    project_id: projectId, grantor_principal_ref: `canonical-owner-${tag}`,
    grantee: { issuer: "canonical-issuer", authentication_method: "service_token", subject: principal.principal_ref },
    state: "ACTIVE", allowed_operations: ["run", "recover", "evidence"], ingest_namespace_ids: [], spend_policy_ref: `canonical-spend-${tag}`,
    expires_at: expires, created_at: now, updated_at: now };
  const grantText = canonicalEvidenceJson(grant);
  await db.batch([
    db.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES(?1,'canonical fixture','private','fixture-retention','fixture-source','fixture-model','fixture-depth',1,?2)").bind(projectId, now),
    db.prepare("INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)").bind(projectId, grant.grantor_principal_ref, principal.deployment_generation, now),
    db.prepare("INSERT INTO project_client_grant(grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256,spend_policy_sha256,spend_deployment_generation,spend_expires_at,spend_policy_protocol) VALUES(?1,1,?2,?3,?4,'service_token',?5,'ACTIVE',?6,?7,?8,?9,?8,?8,?10,?6,'eliotr.research-owner-spend-template.v1')")
      .bind(grant.grant_id, projectId, grant.grantor_principal_ref, grant.grantee.issuer, principal.principal_ref, expires, `grant-${tag}`, await digest(new TextEncoder().encode(grantText)), grantText,principal.deployment_generation),
    db.prepare("INSERT OR IGNORE INTO investigation_current_policy VALUES('canonical-policy','canonical-authority','ACTIVE',?1)").bind(now),
    db.prepare("INSERT OR IGNORE INTO investigation_current_deployment(deployment_generation,state,created_at) VALUES(?1,'ACTIVE',?2)").bind(principal.deployment_generation, now),
  ]);
  const scopeIdentity = { protocol: "eliotr.scope-snapshot.v1", revision: 1,
    resolved_scope_expression: { kind: "PROJECT", project_id: projectId },
    participant_generations: { "member-policy-closure": "canonical-authority" },
    member_source_revision_refs: [], source_owner_generations: {}, policy_authority_ref: "canonical-authority",
    disclosure_closure_digest: "d".repeat(64), purge_ledger_revision: 0, client_fence_ref:principal.credential_generation,created_at: now, expires_at: expires };
  const scopeId = `scope-${(await digest(new TextEncoder().encode(canonicalEvidenceJson(scopeIdentity)))).slice(0,48)}`;
  const scopeDigest = await digest(new TextEncoder().encode(canonicalEvidenceJson({ snapshot_id: scopeId, ...scopeIdentity })));
  const orientationHash=await digest(new TextEncoder().encode(`canonical-orientation-${tag}`));
  await db.prepare("INSERT INTO orientation_request(operation_id,principal_ref,client_class,credential_generation,idempotency_key,request_digest,state,created_at,expires_at,execution_operation_id,execution_client_grant_id,execution_client_grant_revision) VALUES(?1,?2,'trusted_agent',?3,?4,?5,'PREPARED',?6,?7,?8,?9,1)")
    .bind(`orientation-${tag}`,principal.principal_ref,principal.credential_generation,`research-execution:${operationId}`,orientationHash,now,expires,operationId,grant.grant_id).run();
  await db.batch([
    db.prepare("INSERT INTO scope_snapshot(snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,snapshot_digest,created_at,expires_at,client_fence_ref) VALUES(?1,1,?2,?3,'[]','{}','canonical-authority',?4,0,?5,?6,?7,?8)")
      .bind(scopeId, canonicalEvidenceJson(scopeIdentity.resolved_scope_expression), canonicalEvidenceJson(scopeIdentity.participant_generations), scopeIdentity.disclosure_closure_digest, scopeDigest, now, expires,principal.credential_generation),
    db.prepare("UPDATE orientation_request SET snapshot_id=?1,snapshot_revision=1 WHERE operation_id=?2").bind(scopeId,`orientation-${tag}`),
    db.prepare("INSERT INTO scope_access_grant(snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at,created_at,project_client_grant_id,project_client_grant_revision,project_client_operation,project_client_project_generation,project_client_run_operation_id,project_client_authority_epoch) VALUES(?1,1,?2,'trusted_agent',?3,'canonical-authority','[\"research\"]','exact',?4,'ACTIVE',?5,?6,?7,1,'run',1,?8,(SELECT generation FROM orientation_authority_epoch WHERE singleton=1))")
      .bind(scopeId, principal.principal_ref, principal.credential_generation, `canonical-authorization-${tag}`, expires, now,grant.grant_id,operationId),
  ]);
  const orientationResult=JSON.stringify({execution:{operation_id:operationId,deadline:expires,request_digest:orientationHash},result:{evidence_pack:{scope_snapshot_ref:{id:scopeId,revision:1}}}});
  await db.prepare("UPDATE orientation_request SET state='COMPLETE',result_json=?1,result_digest=?2 WHERE operation_id=?3")
    .bind(orientationResult,await digest(new TextEncoder().encode(orientationResult)),`orientation-${tag}`).run();
  const bytes = new TextEncoder().encode(`Canonical native input ${tag}`);
  const hash = await digest(bytes);
  const key = `canonical-input-${tag}`;
  await bucket.put(key, bytes, { sha256: hash });
  const ledgerInput: CreateLedgerInput = { investigation_id: `canonical-investigation-${tag}`, goal: "Canonical local W2 native transport qualification",
    scope_snapshot_id: scopeId, scope_snapshot_revision: 1, evidence_grade: "E2", lane: "exploratory",
    lane_registrations: [], obligations: [], hypotheses: [], portfolio_ref: key, debt_refs: [],
    principal_ref: principal.principal_ref, input_digest: hash, policy_generation: "canonical-policy",
    policy_authority_ref: "canonical-authority", deployment_generation: principal.deployment_generation,
    idempotency_key: `ledger-${tag}`, model_profile_ref: "controlled-model-v1", event_id: `ledger-event-${tag}`,
    payload_handle_ref: key, payload_digest: hash, created_at: now };
  const ledger = createInvestigationLedgerService(createD1InvestigationLedgerStore(db as unknown as LedgerD1Database), {
    current: async () => ({ principal_ref: principal.principal_ref, scope_snapshot_id: scopeId, scope_snapshot_revision: 1,
      policy_generation: "canonical-policy", policy_authority_ref: "canonical-authority",
      deployment_generation: principal.deployment_generation, purge_revision: 0, scope_purge_revision: 0 }),
  }, { has: async (ref) => (await bucket.head(ref)) !== null, digestFor: async () => hash });
  await ledger.create(ledgerInput);
  let request: StageRequest = { protocol: "eliotr.workflow-stage.v1", operation_id: operationId,
    investigation_ref: { id: ledgerInput.investigation_id, revision: 1 }, stage: "FREEZE_PROTOCOL_AND_SCOPE",
    idempotency_key: `canonical-idempotency-${tag}`, handler_generation: NATIVE_EXTERNAL_TASK_HANDLER_GENERATION,
    input_manifest: { object_ref: key, sha256: hash, byte_length: bytes.byteLength, residency: {
      scope_domain_id: scopeId, access_domain_id: principal.principal_ref, confidentiality_domain_id: "private",
      encryption_key_domain_id: "fixture-key", retention_domain_id: "fixture-retention", erasure_domain_id: "fixture-erasure",
      content_digest: { algorithm: "sha256", digest: hash } } } };
  const budget = { receipt_ref: `canonical-budget-${tag}`, expires_at_ms: Date.now()+300000 };
  const ports: WorkflowExecutionPorts = {
    authorizeResidency: async (value, actor) => {
      if (value.input_manifest.residency.scope_domain_id !== scopeId ||
          value.input_manifest.residency.access_domain_id !== actor.principal_ref) fail("WORKFLOW_AUTHORITY_STALE");
    }, checkBudget: async () => budget,
  };
  const executor = createWorkflowCheckpointExecutor(db, bucket, ports);
  for (const stage of RESEARCH_WORKFLOW_STAGES.slice(0,8)) {
    const receipt = await executor.execute({ ...request, stage }, principal, async () => new TextEncoder().encode(`Fixture predecessor ${stage}`));
    request = { ...request, investigation_ref: receipt.investigation_ref, input_manifest: receipt.output_manifest };
  }
  const clock = await db.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now_ms").first<{ now_ms: number }>();
  if (clock === null) throw new Error("Fixture D1 clock is unavailable");
  budget.expires_at_ms = clock.now_ms + durationMs;
  return { request: { ...request, stage: "ANALYZE_BRANCHES" as const }, principal, grant, budget, ports };
}
