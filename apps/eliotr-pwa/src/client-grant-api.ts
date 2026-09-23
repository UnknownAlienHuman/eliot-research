import {
  ProjectClientGrantListSchema, ProjectClientGrantPutSchema, ProjectClientGrantRevokeSchema,
  ProjectClientGrantSchema, type ProjectClientGrant, type ProjectClientGrantList, type ProjectClientGrantPut,
} from "@eliotr/contracts";
import { ApiRequestError, requestApiWithStatuses } from "./api.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const TRACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_GRANT_BYTES = 24 * 1024;

export interface ClientGrantMutation {
  readonly projectId: string;
  readonly grantId: string;
  readonly generation: string;
  readonly key: string;
  readonly method: "PUT" | "DELETE";
  readonly body: string;
  readonly previous?: ProjectClientGrant;
}

function invalid(message: string, input = false): never {
  throw new ApiRequestError({ status: input ? 400 : 502,
    code: input ? "CLIENT_GRANT_INPUT_INVALID" : "CLIENT_GRANT_RESPONSE_INVALID", message });
}
export function clientGrantIdentifier(value: string): string {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/u.test(value) || !IDENTIFIER.test(value)) {
    invalid("Enter a valid project or grant identifier.", true);
  }
  return value;
}
function envelope(value: unknown, expected: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Grant response is not an envelope.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 3 || !Object.hasOwn(data, "data") ||
      typeof data.trace_id !== "string" || !TRACE.test(data.trace_id) || /\s/u.test(data.trace_id) ||
      typeof data.deployment_generation !== "string" || !IDENTIFIER.test(data.deployment_generation)) {
    invalid("Grant response has missing or unknown fields.");
  }
  if (data.deployment_generation !== expected) {
    throw new ApiRequestError({ status: 409, code: "CLIENT_GRANT_GENERATION_CHANGED",
      message: "Deployment changed. Discard local state and reload grants.", retryable: true });
  }
  return data.data;
}
function checkedGrant(raw: unknown, projectId: string): ProjectClientGrant {
  const parsed = ProjectClientGrantSchema.safeParse(raw);
  if (!parsed.success) invalid("Grant response does not match the shared contract.");
  const grant = parsed.data;
  if (grant.project_id !== projectId || new Set(grant.allowed_operations).size !== grant.allowed_operations.length ||
      new Set(grant.ingest_namespace_ids).size !== grant.ingest_namespace_ids.length ||
      [grant.created_at, grant.updated_at, grant.expires_at].some((date) => new Date(date).toISOString() !== date) ||
      grant.created_at > grant.updated_at) invalid("Grant response has inconsistent identity or dates.");
  Object.freeze(grant.grantee); Object.freeze(grant.allowed_operations); Object.freeze(grant.ingest_namespace_ids);
  return Object.freeze(grant);
}
function path(projectId: string, grantId?: string): string {
  const base = `/api/v1/research/projects/${encodeURIComponent(clientGrantIdentifier(projectId))}/client-grants`;
  return grantId === undefined ? base : `${base}/${encodeURIComponent(clientGrantIdentifier(grantId))}`;
}
export async function readClientGrants(projectId: string, generation: string, after?: string,
  signal?: AbortSignal): Promise<ProjectClientGrantList> {
  clientGrantIdentifier(generation);
  const suffix = after === undefined ? "" : `?after_grant_id=${encodeURIComponent(clientGrantIdentifier(after))}`;
  const raw = await requestApiWithStatuses(path(projectId) + suffix, { method: "GET", ...(signal === undefined ? {} : { signal }) }, [200]);
  const parsed = ProjectClientGrantListSchema.safeParse(envelope(raw, generation));
  if (!parsed.success) invalid("Grant list does not match the shared contract.");
  const grants = parsed.data.grants.map((grant) => checkedGrant(grant, projectId));
  if (grants.some((grant, index) => grant.grant_id <= (grants[index - 1]?.grant_id ?? after ?? "")) ||
      (parsed.data.next_grant_id !== undefined &&
        (grants.length !== 20 || parsed.data.next_grant_id !== grants.at(-1)?.grant_id))) {
    invalid("Grant list order or continuation is invalid.");
  }
  return { ...parsed.data, grants };
}
export function prepareClientGrantMutation(projectId: string, generation: string, input: unknown,
  previous?: ProjectClientGrant, revoke = false): ClientGrantMutation {
  clientGrantIdentifier(projectId); clientGrantIdentifier(generation);
  if (previous && previous.project_id !== projectId) invalid("Grant belongs to another project.", true);
  if (revoke && (!previous || previous.state !== "ACTIVE")) invalid("Select an active grant to revoke.", true);
  const raw = revoke ? ProjectClientGrantRevokeSchema.safeParse(input) : ProjectClientGrantPutSchema.safeParse(input);
  if (!raw.success) invalid("Grant fields do not match the shared contract.", true);
  if (raw.data.expected_revision !== (previous?.revision ?? 0)) invalid("Reload the current grant revision.", true);
  let normalized: ProjectClientGrantPut | { expected_revision: number } = raw.data;
  if (!revoke) {
    const rights = ProjectClientGrantPutSchema.parse(raw.data);
    if (new Set(rights.allowed_operations).size !== rights.allowed_operations.length ||
        new Set(rights.ingest_namespace_ids).size !== rights.ingest_namespace_ids.length) invalid("Duplicate rights or namespaces.", true);
    if (previous && (rights.grantee.issuer !== previous.grantee.issuer || rights.grantee.subject !== previous.grantee.subject)) {
      invalid("An existing grant cannot be assigned to another client.", true);
    }
    const imports = rights.allowed_operations.some((op) => op === "ingest.bundle" || op === "workspace.admit");
    if (imports !== (rights.ingest_namespace_ids.length > 0)) invalid("Import rights need explicit namespaces; other rights do not use them.", true);
    if (Date.parse(rights.expires_at) <= Date.now()) invalid("Grant expiry must be in the future.", true);
    normalized = { ...rights, allowed_operations: [...rights.allowed_operations].sort(),
      ingest_namespace_ids: [...rights.ingest_namespace_ids].sort(), expires_at: new Date(rights.expires_at).toISOString() };
  }
  const body = JSON.stringify(normalized);
  if (new TextEncoder().encode(body).byteLength > MAX_GRANT_BYTES) invalid("Grant exceeds the request byte limit.", true);
  return Object.freeze({ projectId, generation, grantId: previous?.grant_id ?? `grant-${crypto.randomUUID()}`,
    key: `grant-change-${crypto.randomUUID()}`, method: revoke ? "DELETE" : "PUT", body,
    ...(previous === undefined ? {} : { previous }) });
}

/** A replayed receipt is not a claim that its revision is still current. Reload the list afterward. */
export async function sendClientGrantMutation(attempt: ClientGrantMutation, signal?: AbortSignal): Promise<ProjectClientGrant> {
  const raw = await requestApiWithStatuses(path(attempt.projectId, attempt.grantId), {
    method: attempt.method, headers: { "content-type": "application/json", "idempotency-key": attempt.key, "x-eliotr-csrf": "1" },
    body: attempt.body, ...(signal === undefined ? {} : { signal }),
  }, [200]);
  const grant = checkedGrant(envelope(raw, attempt.generation), attempt.projectId);
  const input: unknown = JSON.parse(attempt.body);
  const mutation = attempt.method === "PUT" ? ProjectClientGrantPutSchema.parse(input) : ProjectClientGrantRevokeSchema.parse(input);
  if (grant.grant_id !== attempt.grantId || grant.revision !== mutation.expected_revision + 1 ||
      grant.state !== (attempt.method === "PUT" ? "ACTIVE" : "REVOKED") ||
      (attempt.previous && (grant.grantor_principal_ref !== attempt.previous.grantor_principal_ref ||
        grant.created_at !== attempt.previous.created_at))) invalid("Grant receipt differs from the intended change.");
  const rights = attempt.method === "PUT" ? ProjectClientGrantPutSchema.parse(input) : attempt.previous;
  if (!rights || grant.grantee.issuer !== rights.grantee.issuer || grant.grantee.subject !== rights.grantee.subject ||
      grant.expires_at !== rights.expires_at || grant.spend_policy_ref !== rights.spend_policy_ref ||
      JSON.stringify([...grant.allowed_operations].sort()) !== JSON.stringify([...rights.allowed_operations].sort()) ||
      JSON.stringify([...grant.ingest_namespace_ids].sort()) !== JSON.stringify([...rights.ingest_namespace_ids].sort())) {
    invalid("Grant receipt rights do not match this operation.");
  }
  return grant;
}
