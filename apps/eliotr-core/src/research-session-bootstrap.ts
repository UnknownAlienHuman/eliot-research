import { StageRequestSchema, MAX_WORKFLOW_RECEIPT_BYTES } from "@eliotr/cloudflare-workflows";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
import { createResearchRunService } from "./research-run-service.js";

interface RunBindingRow {
  initial_revision: number;
  idempotency_key: string;
  handler_generation: string;
  initial_manifest_json: string;
  principal_ref: string;
  credential_generation: string;
  deployment_generation: string;
}

/** Materialize presentation state from an authorized canonical run, without starting execution. */
export async function bootstrapResearchSession(
  env: Env,
  context: AuthenticatedRequestContext,
  operationId: string,
  headers: Headers,
): Promise<Response | null> {
  const status = await createResearchRunService(env).runStatus(context, operationId);
  const row = await env.CORE_DB.prepare(
    "SELECT initial_revision,idempotency_key,handler_generation,initial_manifest_json," +
    "principal_ref,credential_generation,deployment_generation FROM research_workflow_run " +
    "WHERE operation_id=?1 AND principal_ref=?2 LIMIT 1",
  ).bind(operationId, context.principal_ref).first<RunBindingRow>();
  if (row === null || row.credential_generation !== context.credential_generation ||
      row.deployment_generation !== env.DEPLOYMENT_GENERATION) {
    throw new HttpRequestError("SESSION_AUTHORITY_STALE", 409, "research session requires its original authority");
  }
  let manifest: unknown;
  try {
    if (typeof row.initial_manifest_json !== "string" ||
        new TextEncoder().encode(row.initial_manifest_json).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) throw new Error();
    manifest = JSON.parse(row.initial_manifest_json) as unknown;
  } catch {
    throw new HttpRequestError("WORKFLOW_OUTPUT_CORRUPT", 409, "research run binding is inconsistent");
  }
  const initial = StageRequestSchema.safeParse({
    protocol: "eliotr.workflow-stage.v1", operation_id: operationId,
    investigation_ref: { id: status.investigation_ref.id, revision: row.initial_revision },
    stage: "FREEZE_PROTOCOL_AND_SCOPE", idempotency_key: row.idempotency_key,
    handler_generation: row.handler_generation, input_manifest: manifest,
  });
  if (!initial.success || status.workflow_instance_id !== operationId ||
      initial.data.input_manifest.residency.access_domain_id !== context.principal_ref) {
    throw new HttpRequestError("WORKFLOW_OUTPUT_CORRUPT", 409, "research run binding is inconsistent");
  }
  const internalHeaders = new Headers();
  for (const name of ["x-research-principal", "x-research-credential", "x-research-deployment", "cf-ray"]) {
    const value = headers.get(name);
    if (value !== null) internalHeaders.set(name, value);
  }
  internalHeaders.set("content-type", "application/json");
  const stub = env.RESEARCH_SESSION.get(env.RESEARCH_SESSION.idFromName(operationId));
  const initialized = await stub.fetch(new Request("https://research-session.invalid/session/start", {
    method: "POST", headers: internalHeaders, signal: context.request.signal,
    body: JSON.stringify({
      session_id: operationId, investigation_id: initial.data.investigation_ref.id,
      investigation_revision: initial.data.investigation_ref.revision, operation_id: operationId,
      idempotency_key: initial.data.idempotency_key, handler_generation: initial.data.handler_generation,
      initial_input_manifest: initial.data.input_manifest, principal_ref: row.principal_ref,
      credential_generation: row.credential_generation, deployment_generation: row.deployment_generation,
    }),
  }));
  if (initialized.status !== 200) return initialized;
  const binding = await initialized.json().catch(() => null) as {
    protocol?: unknown; session_id?: unknown; state?: unknown; operation_id?: unknown;
    investigation_ref?: { id?: unknown; revision?: unknown };
  } | null;
  const expectedRevision = binding?.state === "ENGINE_COMPLETED" && status.execution_state === "ENGINE_COMPLETED"
    ? status.investigation_ref.revision : initial.data.investigation_ref.revision;
  if (binding === null || binding.session_id !== operationId || binding.operation_id !== operationId ||
      binding.protocol !== "eliotr.research-session.v1" ||
      (binding.state !== "ACTIVE" && binding.state !== "CANCELLED" && binding.state !== "ENGINE_COMPLETED") ||
      (binding.state === "ENGINE_COMPLETED" && status.execution_state !== "ENGINE_COMPLETED") ||
      binding.investigation_ref?.id !== initial.data.investigation_ref.id ||
      binding.investigation_ref.revision !== expectedRevision) {
    throw new HttpRequestError("SESSION_SETTLEMENT_UNCERTAIN", 503, "research session binding did not read back", true);
  }
  return null;
}
