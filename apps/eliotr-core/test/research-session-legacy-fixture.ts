import { createD1EvidenceAuthorityPort } from "@eliotr/cloudflare-evidence";
import { applyD1Migrations } from "cloudflare:test";
import { WorkflowCheckpointStore, type StageRequest, type WorkflowObject, type WorkflowPrincipal } from "@eliotr/cloudflare-research";
import { createD1ScopeProfilePort } from "@eliotr/retrieval";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { principal as workflowPrincipal, workflowFixture } from "./research-workflow-fixture.js";
import {
  fixture as indexedRetrievalFixture,
  principal as indexedRetrievalPrincipal,
  profile as indexedRetrievalProfile,
  runtime as indexedRetrievalRuntime,
} from "./research-retrieve-fixture.js";
import { SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION, SERVER_RETRIEVAL_SCOPE_PROFILE } from "../src/research-stage-handlers.js";

export interface HistoricalV2SessionFixture {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly scope: ScopeSnapshot;
  readonly initial_manifest: WorkflowObject;
  readonly session_headers: Record<string, string>;
  readonly session_body: {
    readonly session_id: string;
    readonly investigation_id: string;
    readonly investigation_revision: number;
    readonly operation_id: string;
    readonly idempotency_key: string;
    readonly handler_generation: string;
    readonly initial_input_manifest: WorkflowObject;
    readonly principal_ref: string;
    readonly credential_generation: string;
    readonly deployment_generation: string;
  };
}

async function registerHistoricalSession(
  tag: string,
  db: D1Database,
  bucket: R2Bucket,
  scope: ScopeSnapshot,
  principal: WorkflowPrincipal,
  request: StageRequest,
): Promise<HistoricalV2SessionFixture> {
  if (request.handler_generation !== SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION) {
    throw new Error("historical fixture must be registered with the supported v2 handler generation");
  }
  await new WorkflowCheckpointStore(db).ensureRun(request, principal);
  const run = await db.prepare(`SELECT handler_generation, initial_manifest_json FROM research_workflow_run
    WHERE operation_id = ?1 AND principal_ref = ?2 LIMIT 1`)
    .bind(request.operation_id, principal.principal_ref)
    .first<{ handler_generation: string; initial_manifest_json: string }>();
  if (run === null || run.handler_generation !== request.handler_generation) {
    throw new Error("historical workflow registration did not read back exactly");
  }
  const initialManifest = JSON.parse(run.initial_manifest_json) as WorkflowObject;
  const sessionId = `sess-${tag}`;
  return {
    db,
    bucket,
    request,
    principal,
    scope,
    initial_manifest: initialManifest,
    session_headers: {
      "content-type": "application/json",
      "x-research-principal": principal.principal_ref,
      "x-research-credential": principal.credential_generation,
      "x-research-deployment": principal.deployment_generation,
    },
    session_body: {
      session_id: sessionId,
      investigation_id: request.investigation_ref.id,
      investigation_revision: request.investigation_ref.revision,
      operation_id: request.operation_id,
      idempotency_key: request.idempotency_key,
      handler_generation: request.handler_generation,
      initial_input_manifest: initialManifest,
      principal_ref: principal.principal_ref,
      credential_generation: principal.credential_generation,
      deployment_generation: principal.deployment_generation,
    },
  };
}

/** Register the supported legacy v2 generation from a fresh, current GLOBAL_LIBRARY owner fixture. */
export async function prepareHistoricalV2Workflow(tag: string): Promise<HistoricalV2SessionFixture> {
  const f = await workflowFixture(tag, "exploratory");
  await applyD1Migrations(indexedRetrievalRuntime.SEARCH_DB, indexedRetrievalRuntime.SEARCH_MIGRATIONS);
  const scope = await createD1EvidenceAuthorityPort({ core_database: f.db, search_database: indexedRetrievalRuntime.SEARCH_DB })
    .loadScope({ id: f.request.input_manifest.residency.scope_domain_id, revision: 1 });
  if (scope === null) throw new Error("historical workflow fixture has no current owner scope");
  await createD1ScopeProfilePort(f.db).recordBinding(scope.snapshot, SERVER_RETRIEVAL_SCOPE_PROFILE);
  const request = { ...f.request, handler_generation: SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION };
  return registerHistoricalSession(tag, f.db, f.bucket, scope.snapshot, workflowPrincipal, request);
}

/** Register the same historical generation over an actual indexed Q1 source and current owner scope. */
export async function prepareIndexedHistoricalV2Workflow(tag: string, query: string): Promise<HistoricalV2SessionFixture> {
  const f = await indexedRetrievalFixture(SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION, { query });
  await createD1ScopeProfilePort(f.db).recordBinding(f.scope, { ...indexedRetrievalProfile, max_results: 1 });
  return registerHistoricalSession(tag, f.db, indexedRetrievalRuntime.WORK_BUCKET, f.scope, indexedRetrievalPrincipal, f.stage0);
}
