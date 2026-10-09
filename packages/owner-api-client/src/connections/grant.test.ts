import type { ProjectClientGrant } from '@eliotr/contracts';
// Adapted to the extracted C3-C factories. Transport, error construction, epoch, the expiry
// clock and the operation-identity mint all arrive as caller-owned collaborators.
import { describe, expect, it, vi } from "vitest";
import { createClientGrantApi } from "./grant";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";
const GRANTEE = {
    issuer: "https://example.cloudflareaccess.com",
    authentication_method: "service_token",
    subject: "subject-1.access",
} as const;
const GRANTS_PATH = "/api/v1/research/projects/proj-1/client-grants";
const envelope = (data: unknown, generation = "deploy-1") => ({
    data,
    trace_id: "trace-grant-1",
    deployment_generation: generation,
});
const grant = (overrides: Record<string, unknown> = {}): ProjectClientGrant => ({
    protocol: "eliotr.project-client-grant.v1",
    grant_id: "grant-1",
    project_id: "proj-1",
    grantor_principal_ref: "grantor-1",
    grantee: GRANTEE,
    allowed_operations: ["run"],
    ingest_namespace_ids: [],
    revision: 1,
    state: "ACTIVE",
    created_at: "2026-10-09T12:00:00.000Z",
    updated_at: "2026-10-09T12:00:00.000Z",
    expires_at: "2026-12-09T12:00:00.000Z",
    ...overrides,
});
const putInput = {
    grantee: GRANTEE,
    allowed_operations: ["run"],
    ingest_namespace_ids: [],
    expected_revision: 0,
    expires_at: "2026-12-09T12:00:00.000Z",
};
class LegacyError extends Error {
    public readonly status: number;
    public readonly code: string;
    public readonly traceId: string | null;
    public readonly retryable: boolean;
    public constructor(details: LegacyErrorDetails) {
        super(details.message);
        this.name = "LegacyError";
        this.status = details.status;
        this.code = details.code;
        this.traceId = details.traceId;
        this.retryable = details.retryable;
    }
}
const errors: LegacyErrorFactory = (details) => new LegacyError(details);
function liveEpoch() {
    let closed = false;
    const stamp = {};
    const epoch: EpochPort = {
        capture: () => (closed ? undefined : stamp),
        isCurrent: (capture: unknown) => !closed && capture === stamp,
    };
    return { epoch, close: () => { closed = true; } };
}
type GrantHttp = Pick<LegacyHttpAdapter, "requestApiWithStatuses">;
function grantHttp(respond: (path: string, init: RequestInit | undefined, statuses: readonly number[]) => Promise<unknown>) {
    const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>(async (path, init, accepted) => respond(String(path), init, accepted));
    return { http: { requestApiWithStatuses } as GrantHttp, requestApiWithStatuses };
}
const clock = { now: () => Date.parse("2026-10-09T12:30:00.000Z") };
const identity = { mint: () => "11111111-2222-4333-8444-555555555555" };
function makeApi(response: unknown) {
    const { epoch, close } = liveEpoch();
    const { http, requestApiWithStatuses } = grantHttp(async () => response);
    return {
        api: createClientGrantApi(http, errors, epoch, clock, identity),
        requestApiWithStatuses,
        close,
    };
}
function deadApi() {
    const { http, requestApiWithStatuses } = grantHttp(async () => envelope({ protocol: "eliotr.project-client-grants.v1", grants: [] }));
    const epoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
    return { api: createClientGrantApi(http, errors, epoch, clock, identity), requestApiWithStatuses };
}
describe("createClientGrantApi", () => {
    it("accepts a safe identifier and rejects a hostile one", () => {
        const { api } = makeApi(envelope({ protocol: "eliotr.project-client-grants.v1", grants: [] }));
        expect(api.clientGrantIdentifier("proj-1")).toBe("proj-1");
        expect(() => api.clientGrantIdentifier("proj 1")).toThrow(/valid project or grant identifier/);
        expect(() => api.clientGrantIdentifier("../escape")).toThrow(/valid project or grant identifier/);
    });
    it("reads the project grants list and returns frozen grants", async () => {
        const { api } = makeApi(envelope({ protocol: "eliotr.project-client-grants.v1", grants: [grant()] }));
        const page = await api.readClientGrants("proj-1", "deploy-1");
        expect(page.grants).toHaveLength(1);
        expect(Object.isFrozen(page.grants[0])).toBe(true);
        expect(page.protocol).toBe("eliotr.project-client-grants.v1");
    });
    it("rejects a grants envelope for another deployment", async () => {
        const { api } = makeApi(envelope({ protocol: "eliotr.project-client-grants.v1", grants: [] }, "deploy-2"));
        await expect(api.readClientGrants("proj-1", "deploy-1")).rejects.toThrow(/Deployment changed/);
    });
    it("rejects a grant whose project does not match the request", async () => {
        const { api } = makeApi(envelope({ protocol: "eliotr.project-client-grants.v1", grants: [grant({ project_id: "proj-9" })] }));
        await expect(api.readClientGrants("proj-1", "deploy-1")).rejects.toThrow(/inconsistent identity or dates/);
    });
    it("rejects a list with continuation that is not exactly twenty grants", async () => {
        const { api } = makeApi(envelope({
            protocol: "eliotr.project-client-grants.v1",
            grants: [grant()],
            next_grant_id: "grant-1",
        }));
        await expect(api.readClientGrants("proj-1", "deploy-1")).rejects.toThrow(/order or continuation/);
    });
    it("mints grant and key identity through the injected supplier", () => {
        const mint = vi.fn(() => "minted-uuid-1");
        const { http } = grantHttp(async () => envelope({ protocol: "eliotr.project-client-grants.v1", grants: [] }));
        const api = createClientGrantApi(http, errors, liveEpoch().epoch, clock, { mint });
        const attempt = api.prepareClientGrantMutation("proj-1", "deploy-1", putInput);
        expect(attempt.grantId).toBe("grant-minted-uuid-1");
        expect(attempt.key).toBe("grant-change-minted-uuid-1");
        expect(mint).toHaveBeenCalledTimes(2);
    });
    it("rejects a mutation expiry that is not in the future against the injected clock", () => {
        const { api } = makeApi(envelope({ protocol: "eliotr.project-client-grants.v1", grants: [] }));
        expect(() => api.prepareClientGrantMutation("proj-1", "deploy-1", {
            ...putInput,
            expires_at: "2026-10-08T12:00:00.000Z",
        })).toThrow(/expiry must be in the future/);
    });
    it("rejects duplicate rights and import rights without namespaces", () => {
        const { api } = makeApi(envelope({ protocol: "eliotr.project-client-grants.v1", grants: [] }));
        expect(() => api.prepareClientGrantMutation("proj-1", "deploy-1", {
            ...putInput,
            allowed_operations: ["run", "run"],
        })).toThrow(/Duplicate rights/);
        expect(() => api.prepareClientGrantMutation("proj-1", "deploy-1", {
            ...putInput,
            allowed_operations: ["ingest.bundle"],
        })).toThrow(/Import rights need explicit namespaces/);
    });
    // A successful PUT echoes the attempted grant at revision expected_revision + 1.
    const receiptGrant = (overrides: Record<string, unknown> = {}) => ({
        ...grant({
            grant_id: "grant-11111111-2222-4333-8444-555555555555",
            revision: 1,
            ...overrides,
        }),
    });
    it("sends the mutation with CSRF and idempotency headers", async () => {
        const { api, requestApiWithStatuses } = makeApi(envelope(receiptGrant()));
        const attempt = api.prepareClientGrantMutation("proj-1", "deploy-1", putInput);
        await expect(api.sendClientGrantMutation(attempt)).resolves.toMatchObject({ state: "ACTIVE" });
        const call = requestApiWithStatuses.mock.calls[0];
        expect(call?.[0]).toBe(GRANTS_PATH + "/grant-11111111-2222-4333-8444-555555555555");
        expect(new Headers(call?.[1]?.headers).get("x-eliotr-csrf")).toBe("1");
        expect(new Headers(call?.[1]?.headers).get("idempotency-key")).toBe(attempt.key);
        expect(call?.[2]).toEqual([200]);
    });
    // Effect identity: a receipt that does not match the attempted change is rejected rather
    // than reported as a successful mutation.
    it("rejects a grant receipt that differs from the intended change", async () => {
        const { api } = makeApi(envelope(grant({ revision: 9 })));
        const attempt = api.prepareClientGrantMutation("proj-1", "deploy-1", putInput);
        await expect(api.sendClientGrantMutation(attempt)).rejects.toThrow(/differs from the intended change/);
    });
    it("rejects a receipt that changes the grantee", async () => {
        const { api } = makeApi(envelope(receiptGrant({
            grantee: { issuer: "https://other.cloudflareaccess.com", authentication_method: "service_token", subject: "other.access" },
        })));
        const attempt = api.prepareClientGrantMutation("proj-1", "deploy-1", putInput);
        await expect(api.sendClientGrantMutation(attempt)).rejects.toThrow(/receipt rights do not match/);
    });
    it("prepares a revoke that only needs the previous grant", async () => {
        const { api } = makeApi(envelope({ protocol: "eliotr.project-client-grants.v1", grants: [] }));
        const attempt = api.prepareClientGrantMutation("proj-1", "deploy-1", { expected_revision: 1 }, grant(), true);
        expect(attempt.method).toBe("DELETE");
        expect(attempt.grantId).toBe("grant-1");
    });
    it("fails closed on a closed epoch without dispatching the request", async () => {
        const { api, requestApiWithStatuses } = deadApi();
        await expect(api.readClientGrants("proj-1", "deploy-1")).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
        expect(requestApiWithStatuses).not.toHaveBeenCalled();
    });
    it("fails closed when the epoch closes during the awaited read", async () => {
        let release: (value: unknown) => void = () => { };
        const gate = new Promise<unknown>((resolve) => { release = resolve; });
        const { api, close } = makeApi(gate);
        const pending = api.readClientGrants("proj-1", "deploy-1");
        close();
        release(envelope({ protocol: "eliotr.project-client-grants.v1", grants: [] }));
        await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    });
});
