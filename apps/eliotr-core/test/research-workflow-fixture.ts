import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createD1InvestigationLedgerStore, createInvestigationLedgerService,
  type CreateLedgerInput, type LedgerD1Database,
} from "@eliotr/research";
import {
  createWorkflowCheckpointExecutor, digest, fail, type StageRequest, type WorkflowExecutionPorts,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-research";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";

export const runtime = env as unknown as {
  CORE_DB: D1Database; SEARCH_DB: D1Database; WORK_BUCKET: R2Bucket; CORE_MIGRATIONS: { name: string; queries: string[] }[];
};
export const principal: WorkflowPrincipal = {
  principal_ref: "workflow-owner", credential_generation: "workflow-credential", deployment_generation: "workflow-deployment",
};
export async function workflowFixture(tag: string, lane: "confirmatory" | "exploratory" = "confirmatory") {
  await reset();
  const db = runtime.CORE_DB;
  const bucket = runtime.WORK_BUCKET;
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86400_000).toISOString();
  const operationId = `workflow-run-${tag}`;
  const scopeExpression = { kind: "GLOBAL_LIBRARY" as const };
  const participantGenerations = { "member-policy-closure": "workflow-policy-authority" };
  const sourceOwnerGenerations: Record<string, string> = {};
  const scopeIdentity = {
    protocol: "eliotr.scope-snapshot.v1", revision: 1, resolved_scope_expression: scopeExpression,
    participant_generations: participantGenerations, member_source_revision_refs: [],
    source_owner_generations: sourceOwnerGenerations, policy_authority_ref: "workflow-policy-authority",
    disclosure_closure_digest: "d".repeat(64), purge_ledger_revision: 0,
    created_at: now, expires_at: expires,
  };
  const scopeId = `scope-${(await digest(new TextEncoder().encode(canonicalEvidenceJson(scopeIdentity)))).slice(0, 48)}`;
  const scopeDigest = await digest(new TextEncoder().encode(canonicalEvidenceJson({ snapshot_id: scopeId, ...scopeIdentity })));
  const bytes = lane === "exploratory"
    ? new TextEncoder().encode(JSON.stringify({
      investigation_id: `workflow-investigation-${tag}`, operation_id: operationId,
      query: "durable stage over actual local D1/R2", scope_snapshot_ref: { id: scopeId, revision: 1 },
      evidence_grade: "E2", principal_ref: principal.principal_ref,
    }))
    : new TextEncoder().encode("immutable research input — Ж🙂");
  const hash = await digest(bytes);
  await db.batch([
    db.prepare("INSERT INTO investigation_current_policy VALUES ('workflow-policy','workflow-policy-authority','ACTIVE',?1)").bind(now),
    db.prepare("INSERT INTO investigation_current_deployment VALUES ('workflow-deployment','ACTIVE',?1)").bind(now),
    db.prepare(`INSERT INTO scope_snapshot (snapshot_id, revision, resolved_scope_expression_json,
      participant_generations_json, member_source_revision_refs_json, source_owner_generations_json,
      policy_authority_ref, disclosure_closure_digest, purge_ledger_revision, snapshot_digest, created_at, expires_at)
      VALUES (?1,1,?2,?3,'[]',?4,'workflow-policy-authority',?5,0,?6,?7,?8)`).bind(
        scopeId, canonicalEvidenceJson(scopeExpression), canonicalEvidenceJson(participantGenerations),
        canonicalEvidenceJson(sourceOwnerGenerations), scopeIdentity.disclosure_closure_digest, scopeDigest, now, expires),
    db.prepare(`INSERT INTO scope_access_grant (snapshot_id, snapshot_revision, principal_ref, client_class,
      credential_generation, policy_authority_ref, allowed_use_json, disclosure_ceiling, authorization_receipt_ref,
      state, expires_at, created_at) VALUES (?1,1,'workflow-owner','owner_pwa','workflow-credential',
      'workflow-policy-authority','["research"]','exact','workflow-authorization','ACTIVE',?2,?3)`).bind(scopeId, expires, now),
  ]);
  const key = `workflow-portfolio-${tag}`;
  await bucket.put(key, bytes, { sha256: hash });
  const ledgerInput: CreateLedgerInput = {
    investigation_id: `workflow-investigation-${tag}`, goal: "durable stage over actual local D1/R2",
    scope_snapshot_id: scopeId, scope_snapshot_revision: 1, evidence_grade: "E2", lane,
    lane_registrations: [], obligations: [], hypotheses: [], portfolio_ref: key, debt_refs: [],
    principal_ref: principal.principal_ref, input_digest: hash, policy_generation: "workflow-policy",
    policy_authority_ref: "workflow-policy-authority", deployment_generation: principal.deployment_generation,
    idempotency_key: `ledger-${tag}`, model_profile_ref: "controlled-model-v1", event_id: `ledger-event-${tag}`,
    payload_handle_ref: key, payload_digest: hash, created_at: now,
  };
  const ledger = createInvestigationLedgerService(
    createD1InvestigationLedgerStore(db as unknown as LedgerD1Database),
    { current: async () => ({ principal_ref: principal.principal_ref, scope_snapshot_id: scopeId, scope_snapshot_revision: 1,
      policy_generation: "workflow-policy", policy_authority_ref: "workflow-policy-authority",
      deployment_generation: principal.deployment_generation, purge_revision: 0, scope_purge_revision: 0 }) },
    { has: async (ref) => (await bucket.head(ref)) !== null, digestFor: async () => hash },
  );
  await ledger.create(ledgerInput);
  const request: StageRequest = {
    protocol: "eliotr.workflow-stage.v1", operation_id: operationId,
    investigation_ref: { id: ledgerInput.investigation_id, revision: 1 }, stage: "FREEZE_PROTOCOL_AND_SCOPE",
    idempotency_key: `workflow-idempotency-${tag}`, handler_generation: lane === "exploratory" ? "research-handlers.exploratory.v1" : "controlled-handlers.v1",
    input_manifest: { object_ref: key, sha256: hash, byte_length: bytes.byteLength, residency: {
      scope_domain_id: scopeId, access_domain_id: "workflow-owner", confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
      content_digest: { algorithm: "sha256", digest: hash },
    } },
  };
  const budget = { receipt_ref: `budget-${tag}`, expires_at_ms: Date.now() + 300_000 };
  const ports: WorkflowExecutionPorts = {
    authorizeResidency: async (value, actor) => {
      if (value.input_manifest.residency.scope_domain_id !== scopeId ||
          value.input_manifest.residency.access_domain_id !== actor.principal_ref) fail("WORKFLOW_AUTHORITY_STALE");
    },
    checkBudget: async () => budget,
  };
  return { db, bucket, request, ledger, bytes, budget, ports, executor: createWorkflowCheckpointExecutor(db, bucket, ports) };
}

export function faultBucket(bucket: R2Bucket, hooks: { afterPut?: () => Promise<void>; beforeGet?: () => Promise<void> }): R2Bucket {
  const proxy = Object.create(bucket) as R2Bucket;
  proxy.head = bucket.head.bind(bucket);
  proxy.put = async (...args: Parameters<R2Bucket["put"]>) => {
    const result = await bucket.put(...args);
    await hooks.afterPut?.();
    return result;
  };
  proxy.get = (async (...args: Parameters<R2Bucket["get"]>) => {
    await hooks.beforeGet?.();
    return bucket.get(...args);
  }) as R2Bucket["get"];
  return proxy;
}
export function faultDatabase(db: D1Database, hooks: {
  beforeBatch?: () => Promise<void>; afterBatch?: () => Promise<void>; afterRun?: (sql: string) => Promise<void>;
}): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const value = Object.create(statement) as D1PreparedStatement;
    value.bind = (...params) => wrap(statement.bind(...params), sql);
    value.first = statement.first.bind(statement);
    value.all = statement.all.bind(statement);
    value.run = async <T = Record<string, unknown>>() => {
      const result = await statement.run<T>();
      await hooks.afterRun?.(sql);
      return result;
    };
    originals.set(value, statement);
    return value;
  }
  const proxy = Object.create(db) as D1Database;
  proxy.prepare = (sql) => wrap(db.prepare(sql), sql);
  proxy.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
    await hooks.beforeBatch?.();
    const result = await db.batch<T>(statements.map((statement) => originals.get(statement) ?? statement));
    await hooks.afterBatch?.();
    return result;
  };
  return proxy;
}
