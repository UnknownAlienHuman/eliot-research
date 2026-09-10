import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  canonicalEvidenceJson,
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createNavigationReadAuthority,
  createR2EvidenceContentPort,
  type CloudflareEvidenceResolver,
} from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { createD1InvestigationLedgerStore, createInvestigationLedgerService, type CreateLedgerInput, type InvestigationLedgerStore, type LedgerD1Database } from "@eliotr/research";
import type { ReferenceManifestStore } from "@eliotr/policy";
import {
  createPersistedModelProfileBindingProducer,
  createResearchReferenceManifestStore,
  createWorkflowCheckpointExecutor,
  createFreezeProtocolAndScopeStageHandler,
  digest,
  fail,
  type EvidenceFreezeModelDefinition,
  type StageReceipt,
  type StageRequest,
  type WorkflowExecutionPorts,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-research";
import { createRetrieveBranchesStageHandler, type RetrieveBranchesStageDependencies } from "../src/research-retrieve-branches.js";
import { createEvidenceFreezeComposition, createEvidenceFreezePredecessorReader, createEvidenceFreezeWorkflowReaders } from "../src/research-evidence-freeze-composition.js";
import { SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import { modelGatewayRequestParametersSha256, modelGatewaySha256, canonicalModelGatewayJson } from "@eliotr/cloudflare-ai";
import { importAndProject, prepareQ1Namespace, type Q1Runtime } from "./retrieval-q1-fixture.js";

const runtime = env as unknown as Q1Runtime;
const access = { principal_ref: "freeze-owner", client_class: "owner_pwa" as const, credential_generation: "freeze-credential-v1" };
export const principal: WorkflowPrincipal = { ...access, deployment_generation: "freeze-deployment-v1" };
const retrievalProfile = { version: "retrieval-scope-v1", max_sources: 64, max_results: 16 } as const;

export interface FreezeFixture {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly scope: ScopeSnapshot;
  readonly navigation: ReturnType<typeof createNavigationReadAuthority>;
  readonly ledger: InvestigationLedgerStore;
  readonly executor: ReturnType<typeof createWorkflowCheckpointExecutor>;
  readonly retrieve: RetrieveBranchesStageDependencies;
  readonly resolver: CloudflareEvidenceResolver;
  readonly readers: ReturnType<typeof createEvidenceFreezeWorkflowReaders>;
  readonly stage_zero: StageRequest;
  readonly stage_five: StageReceipt;
  readonly pre_reconcile: StageReceipt;
  readonly composition: ReturnType<typeof createEvidenceFreezeComposition>;
  readonly freeze_store: ReferenceManifestStore;
  readonly profile_definition: EvidenceFreezeModelDefinition;
  readonly operation_id: string;
  readonly investigation_id: string;
}

async function signedProfile(scope: ScopeSnapshot, policyAuthorityRef: string, policyGeneration: string): Promise<EvidenceFreezeModelDefinition> {
  const expiresAt = scope.expires_at;
  const policy = Object.freeze({
    allowed_tool_definition_refs: [], allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: ["normalized-text-coordinates-v1"],
    provider_and_policy_generations: { policy: policyGeneration },
    permitted_acquisition_or_expansion_routes: [], disclosure_ceiling: "owner-only",
    allowed_use: ["research"], expires_at: expiresAt,
  });
  const parameters_digest = await modelGatewayRequestParametersSha256({ max_tokens: 32, stream: false });
  const deployment = Object.freeze({
    route_ref: "dynamic/eliotr-balanced",
    route_version: "route-v1",
    prompt_generation: "prompt-v1",
    schema_generation: "schema-v1",
    parameters_digest,
    pricing_snapshot_ref: "pricing-v1",
  });
  const material = {
    schema: "eliotr.research.model-profile-definition.v1" as const,
    config_provenance_ref: "fixture-model-profile-definition-v1",
    model_profile_ref: "freeze-model-v1",
    max_context_bytes: 64 * 1024,
    expires_at: expiresAt,
    deployment,
    policy,
    policy_authority_ref: policyAuthorityRef,
  };
  // The persisted definition intentionally excludes current-scope fields; those
  // are supplied by the producer's current authority read.
  const { policy_authority_ref: _authority, ...definitionMaterial } = material;
  const sha = await modelGatewaySha256(canonicalModelGatewayJson(definitionMaterial));
  return Object.freeze({
    ...definitionMaterial,
    definition_ref: { id: `eliotr.research.model-profile-definition-${sha}`, revision: 1 },
    definition_sha256: sha,
  });
}

export async function freezeFixture(): Promise<FreezeFixture> {
  await reset();
  const db = runtime.CORE_DB;
  const bucket = runtime.WORK_BUCKET;
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
  const world = { db, searchDb: runtime.SEARCH_DB, runtime, owner: access.principal_ref,
    ...(await prepareQ1Namespace(runtime, db, runtime.SEARCH_DB, access.principal_ref)) };
  await importAndProject(world);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + 3_600_000).toISOString();
  const decision = await db.prepare("SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref=?1 LIMIT 1")
    .bind(world.revision).first<{ allowed_use_json: string; disclosure_ceiling: string }>();
  if (decision === null) throw new Error("missing source admission decision");
  await db.prepare("INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation,allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)")
    .bind(world.namespace, access.principal_ref, `freeze-read-${world.namespace}`, decision.allowed_use_json, decision.disclosure_ceiling, expiresAt, now).run();
  const owner = createOwnerScopeAuthority(db, access, () => nowMs);
  const scopes = createD1ScopeService(db, owner, { now: () => nowMs, ttl_ms: 3_600_000 });
  const scope = await scopes.freeze({ kind: "SELECTED_SOURCES", source_ids: [`source-${world.namespace}`] }, access.credential_generation);
  await owner.grant(scope);
  await db.batch([
    db.prepare("INSERT INTO investigation_current_policy (policy_generation,policy_authority_ref,state,created_at) VALUES (?1,?2,'ACTIVE',?3)").bind("freeze-policy-v1", scope.policy_authority_ref, now),
    db.prepare("INSERT INTO investigation_current_deployment (deployment_generation,state,created_at) VALUES (?1,'ACTIVE',?2)").bind(principal.deployment_generation, now),
  ]);

  const operationId = "freeze-workflow-operation";
  const investigationId = "freeze-workflow-investigation";
  const payload = { investigation_id: investigationId, operation_id: operationId, query: "Pinned",
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision }, evidence_grade: "E0" as const, principal_ref: principal.principal_ref };
  const payloadBytes = new TextEncoder().encode(canonicalEvidenceJson(payload));
  const payloadKey = "freeze-workflow-input";
  const payloadDigest = await digest(payloadBytes);
  await bucket.put(payloadKey, payloadBytes, { sha256: payloadDigest });
  const ledgerInput: CreateLedgerInput = {
    investigation_id: investigationId, goal: payload.query, scope_snapshot_id: scope.snapshot_id, scope_snapshot_revision: scope.revision,
    evidence_grade: "E0", lane: "exploratory", lane_registrations: [], obligations: [], hypotheses: [], portfolio_ref: payloadKey, debt_refs: [],
    principal_ref: principal.principal_ref, input_digest: payloadDigest, policy_generation: "freeze-policy-v1", policy_authority_ref: scope.policy_authority_ref,
    deployment_generation: principal.deployment_generation, idempotency_key: "freeze-ledger-idempotency", model_profile_ref: "freeze-model-v1",
    event_id: "freeze-ledger-created", payload_handle_ref: payloadKey, payload_digest: payloadDigest, created_at: now,
  };
  const ledgerStore = createD1InvestigationLedgerStore(db as unknown as LedgerD1Database);
  const ledgerService = createInvestigationLedgerService(ledgerStore, {
    current: async () => ({ principal_ref: principal.principal_ref, scope_snapshot_id: scope.snapshot_id,
      scope_snapshot_revision: scope.revision, policy_generation: ledgerInput.policy_generation,
      policy_authority_ref: scope.policy_authority_ref, deployment_generation: principal.deployment_generation,
      purge_revision: 0, scope_purge_revision: scope.purge_ledger_revision }),
  }, { has: async (ref) => (await bucket.head(ref)) !== null,
    digestFor: async (ref) => ref === ledgerInput.payload_handle_ref ? ledgerInput.payload_digest : null });
  await ledgerService.create(ledgerInput);
  const navigation = createNavigationReadAuthority({ database: db, scope_snapshot: scope, access,
    require_current: (requested) => scopes.requireCurrent(requested), now: () => nowMs });
  const stage_zero: StageRequest = {
    protocol: "eliotr.workflow-stage.v1", operation_id: operationId, investigation_ref: { id: investigationId, revision: 1 },
    stage: "FREEZE_PROTOCOL_AND_SCOPE", idempotency_key: "freeze-workflow-idempotency", handler_generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
    input_manifest: { object_ref: payloadKey, sha256: payloadDigest, byte_length: payloadBytes.byteLength,
      residency: { scope_domain_id: scope.snapshot_id, access_domain_id: principal.principal_ref, confidentiality_domain_id: "private",
        encryption_key_domain_id: "freeze-key-v1", retention_domain_id: "freeze-retention-v1", erasure_domain_id: "freeze-erasure-v1",
        content_digest: { algorithm: "sha256", digest: payloadDigest } } },
  };
  const ports: WorkflowExecutionPorts = {
    authorizeResidency: async (request, actor) => {
      await navigation.current();
      if (request.input_manifest.residency.scope_domain_id !== scope.snapshot_id || request.input_manifest.residency.access_domain_id !== actor.principal_ref) {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
    },
    checkBudget: async () => ({ receipt_ref: "freeze-workflow-budget", expires_at_ms: nowMs + 300_000 }),
  };
  const executor = createWorkflowCheckpointExecutor(db, bucket, ports);
  let previous = await executor.execute(stage_zero, principal, createFreezeProtocolAndScopeStageHandler({ navigation, ledger: ledgerStore }));
  for (const stage of ["ORIENT", "INTERPRET", "COMPILE_OBLIGATIONS", "PLAN"] as const) {
    previous = await executor.execute({ ...stage_zero, stage, investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest }, principal,
      async ({ request, input_bytes }) => new TextEncoder().encode(JSON.stringify({ stage: request.stage, input_sha: await digest(input_bytes) })));
  }
  const retrieve: RetrieveBranchesStageDependencies = { database: db, search_database: runtime.SEARCH_DB, work_bucket: runtime.WORK_BUCKET,
    evidence_bucket: runtime.EVIDENCE_BUCKET, access, navigation, ledger: ledgerStore, profile: retrievalProfile };
  const retrieveRequest: StageRequest = { ...stage_zero, stage: "RETRIEVE_BRANCHES", investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest };
  const stage_five = await executor.execute(retrieveRequest, principal, createRetrieveBranchesStageHandler(retrieve));
  previous = stage_five;
  for (const stage of ["ACQUIRE_AND_CAPTURE", "READ_AND_EXTRACT", "ANALYZE_BRANCHES", "COUNTER_SEARCH"] as const) {
    previous = await executor.execute({ ...stage_zero, stage, investigation_ref: previous.investigation_ref, input_manifest: previous.output_manifest }, principal,
      async ({ request, input_bytes }) => new TextEncoder().encode(JSON.stringify({ stage: request.stage, input_sha: await digest(input_bytes) })));
  }
  const pre_reconcile = previous;
  const current = await ledgerStore.read(investigationId);
  if (current === null) throw new Error("missing current W1 head");
  const definition = await signedProfile(scope, current.head.policy_authority_ref, current.head.policy_generation);
  const deployment = definition.deployment;
  const profileProducer = createPersistedModelProfileBindingProducer({
    config: { raw: JSON.stringify(definition), provenance_ref: definition.config_provenance_ref },
    authority: { database: db, navigation, operation_id: operationId, investigation_id: investigationId, principal },
    routeAuthority: { resolve: async () => deployment }, now: () => nowMs });
  const evidenceAuthority = createD1EvidenceAuthorityPort({ core_database: db, search_database: runtime.SEARCH_DB });
  const resolver: CloudflareEvidenceResolver = createCloudflareEvidenceResolver({ authority: evidenceAuthority, content: createR2EvidenceContentPort({ evidence_bucket: runtime.EVIDENCE_BUCKET }) });
  const { navigation: _navigation, ledger: _ledger, ...retrieveEnvironment } = retrieve;
  const readers = createEvidenceFreezeWorkflowReaders({ database: db, work_bucket: bucket, retrieve: retrieveEnvironment }, navigation, ledgerStore);
  const reader = createEvidenceFreezePredecessorReader(navigation, readers);
  let committedStore: ReturnType<typeof createResearchReferenceManifestStore> | null = null;
  const freezeStore: ReferenceManifestStore = { put: async (manifest) => { if (committedStore === null) throw new Error("manifest store not initialized"); return committedStore.put(manifest); }, get: async (ref) => committedStore?.get(ref) ?? null };
  const composition = createEvidenceFreezeComposition({ navigation, resolver, read_predecessors: reader,
    resolve_model_binding: async ({ protocol_scope, w1_head }) => (await profileProducer.resolve({ model_profile_ref: protocol_scope.protocol_profile.model_profile_ref,
      policy_generation: w1_head.policy_generation, policy_authority_ref: w1_head.policy_authority_ref, deployment_generation: w1_head.deployment_generation,
      scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision }, scope_snapshot_digest: scope.digest })).binding,
    manifest_store_factory: { create(context) { committedStore = createResearchReferenceManifestStore({ database: db, work_bucket: bucket, context, navigation }); return committedStore; } },
    manifest_residency_template: { scope_domain_id: scope.snapshot_id, access_domain_id: principal.principal_ref, confidentiality_domain_id: "private",
      encryption_key_domain_id: "freeze-key-v1", retention_domain_id: "freeze-retention-v1", erasure_domain_id: "freeze-erasure-v1" },
    max_context_bytes: definition.max_context_bytes, manifest_store: freezeStore });
  return { db, bucket, scope, navigation, ledger: ledgerStore, executor, retrieve, resolver, readers, stage_zero, stage_five, pre_reconcile,
    composition, freeze_store: freezeStore, profile_definition: definition, operation_id: operationId, investigation_id: investigationId };
}

export async function committedEvidenceFreezeFixture(): Promise<FreezeFixture & {
  readonly stage_ten: StageReceipt;
  readonly stage_eleven: StageReceipt;
  readonly stage_twelve: StageRequest;
}> {
  const fixture = await freezeFixture();
  const stageTen: StageRequest = { ...fixture.stage_zero, stage: "RECONCILE", investigation_ref: fixture.pre_reconcile.investigation_ref,
    input_manifest: fixture.pre_reconcile.output_manifest };
  const stageTenReceipt = await fixture.executor.execute(stageTen, principal, fixture.composition.reconcile);
  const stageEleven: StageRequest = { ...stageTen, stage: "FREEZE_EVIDENCE", investigation_ref: stageTenReceipt.investigation_ref,
    input_manifest: stageTenReceipt.output_manifest };
  const stageElevenReceipt = await fixture.executor.execute(stageEleven, principal, fixture.composition.freeze);
  const stageTwelve: StageRequest = { ...stageEleven, stage: "SYNTHESIZE", investigation_ref: stageElevenReceipt.investigation_ref,
    input_manifest: stageElevenReceipt.output_manifest };
  return Object.freeze({ ...fixture, stage_ten: stageTenReceipt, stage_eleven: stageElevenReceipt, stage_twelve: stageTwelve });
}
