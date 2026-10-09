/** Exact legacy Connections semantics through injected owner HTTP, error and epoch ports. */
import type { LegacyErrorFactory, LegacyErrorDetails, LegacyHttpAdapter } from '../legacy/http';
import type { EpochPort } from '../transport/client';
import { ProjectClientGrantListSchema, ProjectClientGrantPutSchema, ProjectClientGrantRevokeSchema, ProjectClientGrantSchema, type ProjectClientGrant, type ProjectClientGrantList, type ProjectClientGrantPut, } from "@eliotr/contracts";
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
export function createClientGrantApi(http: Pick<LegacyHttpAdapter, 'requestApiWithStatuses'>, errors: LegacyErrorFactory, epoch: EpochPort, clock: { readonly now: () => number }, identity: { readonly mint: () => string }) {
const { requestApiWithStatuses } = http;

const fail = (details: Omit<LegacyErrorDetails, 'traceId' | 'retryable'> & Partial<Pick<LegacyErrorDetails, 'traceId' | 'retryable'>>): Error => errors({ traceId: null, retryable: false, ...details });
const closed = (): never => { throw fail({ status: 503, code: 'API_SESSION_CLOSED', message: 'Owner session is closed', retryable: false }); };
const currentResult = <T>(captured: object, result: T): T => { if (!epoch.isCurrent(captured)) closed(); return result; };
const currentCapture = (): object => { const captured = epoch.capture(); if (captured === undefined || !epoch.isCurrent(captured)) return closed(); return captured; };
const guarded = async <T>(captured: object, result: Promise<T>): Promise<T> => currentResult(captured, await result);
function invalid(message: string, input = false): never {
    throw fail({ status: input ? 400 : 502,
        code: input ? "CLIENT_GRANT_INPUT_INVALID" : "CLIENT_GRANT_RESPONSE_INVALID", message });
}
function clientGrantIdentifier(value: string): string {
    if (typeof value !== "string" || /[\u0000-\u0020\u007f]/u.test(value) || !IDENTIFIER.test(value)) {
        invalid("Enter a valid project or grant identifier.", true);
    }
    return value;
}
function envelope(value: unknown, expected: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value))
        invalid("Grant response is not an envelope.");
    const data = value as Record<string, unknown>;
    if (Object.keys(data).length !== 3 || !Object.hasOwn(data, "data") ||
        typeof data.trace_id !== "string" || !TRACE.test(data.trace_id) || /\s/u.test(data.trace_id) ||
        typeof data.deployment_generation !== "string" || !IDENTIFIER.test(data.deployment_generation)) {
        invalid("Grant response has missing or unknown fields.");
    }
    if (data.deployment_generation !== expected) {
        throw fail({ status: 409, code: "CLIENT_GRANT_GENERATION_CHANGED",
            message: "Deployment changed. Discard local state and reload grants.", retryable: true });
    }
    return data.data;
}
function checkedGrant(raw: unknown, projectId: string): ProjectClientGrant {
    const parsed = ProjectClientGrantSchema.safeParse(raw);
    if (!parsed.success)
        invalid("Grant response does not match the shared contract.");
    const grant = parsed.data;
    if (grant.project_id !== projectId || new Set(grant.allowed_operations).size !== grant.allowed_operations.length ||
        new Set(grant.ingest_namespace_ids).size !== grant.ingest_namespace_ids.length ||
        [grant.created_at, grant.updated_at, grant.expires_at].some((date) => new Date(date).toISOString() !== date) ||
        grant.created_at > grant.updated_at)
        invalid("Grant response has inconsistent identity or dates.");
    Object.freeze(grant.grantee);
    Object.freeze(grant.allowed_operations);
    Object.freeze(grant.ingest_namespace_ids);
    return Object.freeze(grant);
}
function path(projectId: string, grantId?: string): string {
    const base = `/api/v1/research/projects/${encodeURIComponent(clientGrantIdentifier(projectId))}/client-grants`;
    return grantId === undefined ? base : `${base}/${encodeURIComponent(clientGrantIdentifier(grantId))}`;
}
async function readClientGrants(projectId: string, generation: string, after?: string, signal?: AbortSignal): Promise<ProjectClientGrantList> {
    const captured = currentCapture();
    clientGrantIdentifier(generation);
    const suffix = after === undefined ? "" : `?after_grant_id=${encodeURIComponent(clientGrantIdentifier(after))}`;
    const raw = await guarded(captured, requestApiWithStatuses(path(projectId) + suffix, { method: "GET", ...(signal === undefined ? {} : { signal }) }, [200]));
    const parsed = ProjectClientGrantListSchema.safeParse(envelope(raw, generation));
    if (!parsed.success)
        invalid("Grant list does not match the shared contract.");
    const grants = parsed.data.grants.map((grant) => checkedGrant(grant, projectId));
    if (grants.some((grant, index) => grant.grant_id <= (grants[index - 1]?.grant_id ?? after ?? "")) ||
        (parsed.data.next_grant_id !== undefined &&
            (grants.length !== 20 || parsed.data.next_grant_id !== grants.at(-1)?.grant_id))) {
        invalid("Grant list order or continuation is invalid.");
    }
    return currentResult(captured, { ...parsed.data, grants });
}
function prepareClientGrantMutation(projectId: string, generation: string, input: unknown, previous?: ProjectClientGrant, revoke = false): ClientGrantMutation {
    clientGrantIdentifier(projectId);
    clientGrantIdentifier(generation);
    if (previous && previous.project_id !== projectId)
        invalid("Grant belongs to another project.", true);
    if (revoke && (!previous || previous.state !== "ACTIVE"))
        invalid("Select an active grant to revoke.", true);
    const raw = revoke ? ProjectClientGrantRevokeSchema.safeParse(input) : ProjectClientGrantPutSchema.safeParse(input);
    if (!raw.success)
        invalid("Grant fields do not match the shared contract.", true);
    if (raw.data.expected_revision !== (previous?.revision ?? 0))
        invalid("Reload the current grant revision.", true);
    let normalized: ProjectClientGrantPut | {
        expected_revision: number;
    } = raw.data;
    if (!revoke) {
        const rights = ProjectClientGrantPutSchema.parse(raw.data);
        if (new Set(rights.allowed_operations).size !== rights.allowed_operations.length ||
            new Set(rights.ingest_namespace_ids).size !== rights.ingest_namespace_ids.length)
            invalid("Duplicate rights or namespaces.", true);
        if (previous && (rights.grantee.issuer !== previous.grantee.issuer || rights.grantee.subject !== previous.grantee.subject)) {
            invalid("An existing grant cannot be assigned to another client.", true);
        }
        const imports = rights.allowed_operations.some((op) => op === "ingest.bundle" || op === "workspace.admit");
        if (imports !== (rights.ingest_namespace_ids.length > 0))
            invalid("Import rights need explicit namespaces; other rights do not use them.", true);
        if (rights.spend_policy_ref !== undefined && !rights.allowed_operations.some((op) => op === "run" || op === "recover")) {
            invalid("Spend sponsorship requires explicit run or recover permission; read access cannot spend.", true);
        }
        if (Date.parse(rights.expires_at) <= clock.now())
            invalid("Grant expiry must be in the future.", true);
        normalized = { ...rights, allowed_operations: [...rights.allowed_operations].sort(),
            ingest_namespace_ids: [...rights.ingest_namespace_ids].sort(), expires_at: new Date(rights.expires_at).toISOString() };
    }
    const body = JSON.stringify(normalized);
    if (new TextEncoder().encode(body).byteLength > MAX_GRANT_BYTES)
        invalid("Grant exceeds the request byte limit.", true);
    return Object.freeze({ projectId, generation, grantId: previous?.grant_id ?? `grant-${identity.mint()}`,
        key: `grant-change-${identity.mint()}`, method: revoke ? "DELETE" : "PUT", body,
        ...(previous === undefined ? {} : { previous }) });
}
/** A replayed receipt is not a claim that its revision is still current. Reload the list afterward. */
async function sendClientGrantMutation(attempt: ClientGrantMutation, signal?: AbortSignal): Promise<ProjectClientGrant> {
    const captured = currentCapture();
    const raw = await guarded(captured, requestApiWithStatuses(path(attempt.projectId, attempt.grantId), {
        method: attempt.method, headers: { "content-type": "application/json", "idempotency-key": attempt.key, "x-eliotr-csrf": "1" },
        body: attempt.body, ...(signal === undefined ? {} : { signal }),
    }, [200]));
    const grant = checkedGrant(envelope(raw, attempt.generation), attempt.projectId);
    const input: unknown = JSON.parse(attempt.body);
    const mutation = attempt.method === "PUT" ? ProjectClientGrantPutSchema.parse(input) : ProjectClientGrantRevokeSchema.parse(input);
    if (grant.grant_id !== attempt.grantId || grant.revision !== mutation.expected_revision + 1 ||
        grant.state !== (attempt.method === "PUT" ? "ACTIVE" : "REVOKED") ||
        (attempt.previous && (grant.grantor_principal_ref !== attempt.previous.grantor_principal_ref ||
            grant.created_at !== attempt.previous.created_at)))
        invalid("Grant receipt differs from the intended change.");
    const rights = attempt.method === "PUT" ? ProjectClientGrantPutSchema.parse(input) : attempt.previous;
    if (!rights || grant.grantee.issuer !== rights.grantee.issuer || grant.grantee.subject !== rights.grantee.subject ||
        grant.expires_at !== rights.expires_at || grant.spend_policy_ref !== rights.spend_policy_ref ||
        JSON.stringify([...grant.allowed_operations].sort()) !== JSON.stringify([...rights.allowed_operations].sort()) ||
        JSON.stringify([...grant.ingest_namespace_ids].sort()) !== JSON.stringify([...rights.ingest_namespace_ids].sort())) {
        invalid("Grant receipt rights do not match this operation.");
    }
    return currentResult(captured, grant);
}
return { clientGrantIdentifier, readClientGrants, prepareClientGrantMutation, sendClientGrantMutation };
}
