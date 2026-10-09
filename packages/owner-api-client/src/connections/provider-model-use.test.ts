import type { ResearchProjectModelConfiguration } from '../research/configuration/models';
// Adapted to the extracted C3-C factories. Transport, error construction, epoch and the
// research-model-configuration collaborator arrive as caller-owned collaborators.
import { describe, expect, it, vi } from "vitest";
import { createProviderModelUseApi } from "./provider-model-use";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";
const KEY_ID = "0f9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c";
const OP_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const envelope = (data: unknown) => ({
    data,
    trace_id: "trace-mu-1",
    deployment_generation: "deploy-1",
});
const SELECTED_REF = "rpmc-" + "a".repeat(64);
const selectedOperation = {
    protocol: "eliotr.research.provider-key-model-use.v1",
    project_id: "proj-1",
    operation_id: OP_ID,
    key_operation_id: KEY_ID,
    state: "selected",
    phase: "complete",
    selected_configuration_ref: SELECTED_REF,
    selection_revision: 3,
    failure_code: null,
    created_at: "2026-10-09T12:00:00.000Z",
    updated_at: "2026-10-09T12:02:00.000Z",
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
type ModelUseHttp = Pick<LegacyHttpAdapter, "requestApiWithStatuses">;
function modelUseHttp(respond: (path: string, init: RequestInit | undefined, statuses: readonly number[]) => Promise<unknown>) {
    const requestApiWithStatuses = vi.fn<LegacyHttpAdapter["requestApiWithStatuses"]>(async (path, init, accepted) => respond(String(path), init, accepted));
    return { http: { requestApiWithStatuses } as ModelUseHttp, requestApiWithStatuses };
}
function makeApi(data: unknown, selection: ResearchProjectModelConfiguration = configuration) {
    const { epoch, close } = liveEpoch();
    const { http, requestApiWithStatuses } = modelUseHttp(async () => data);
    return {
        api: createProviderModelUseApi(http, errors, epoch, modelsWith(selection)),
        requestApiWithStatuses,
        close,
    };
}
function deadApi() {
    const { http, requestApiWithStatuses } = modelUseHttp(async () => envelope(selectedOperation));
    const epoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
    return {
        api: createProviderModelUseApi(http, errors, epoch, modelsWith(configuration)),
        requestApiWithStatuses,
    };
}

const configuration: ResearchProjectModelConfiguration = {
  protocol:'eliotr.research-project-model-configuration.v1', project_id:'proj-1',
  selection_revision:3, selected:null, revisions:[], next_cursor:null,
};
const selectedConfiguration: NonNullable<ResearchProjectModelConfiguration['selected']> = {
  configuration_ref:SELECTED_REF, configuration_sha256:'a'.repeat(64), created_at:'2026-10-09T12:00:00.000Z',
  qualification_state:'qualified', semantic_revision:{revision_ref:'semantic-1',config_sha256:'b'.repeat(64)}, model_selections:[],
};
const modelsWith = (selection: ResearchProjectModelConfiguration) => ({ readResearchProjectModelConfiguration: vi.fn(async () => selection) });

describe("createProviderModelUseApi", () => {
    it("reads a selected operation through the injected seam", async () => {
        const { api, requestApiWithStatuses } = makeApi(envelope(selectedOperation));
        await expect(api.readResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID))
            .resolves.toMatchObject({ state: "selected", phase: "complete" });
        const call = requestApiWithStatuses.mock.calls[0];
        expect(call?.[0]).toBe("/api/v1/projects/proj-1/model-provider-key/model-use/" + OP_ID);
        expect(call?.[2]).toEqual([200]);
        expect(call?.[1]?.method).toBe("GET");
    });
    it("reads the selection through the injected models collaborator", async () => {
        const reader = vi.fn(async (): Promise<ResearchProjectModelConfiguration> => ({ ...configuration, selected: selectedConfiguration }));
        const { http } = modelUseHttp(async () => envelope(selectedOperation));
        const api = createProviderModelUseApi(http, errors, liveEpoch().epoch, {
            readResearchProjectModelConfiguration: reader,
        });
        await expect(api.readResearchProviderKeyModelSelection("proj-1", "deploy-1"))
            .resolves.toEqual({ selection_revision: 3, selected_configuration_ref: SELECTED_REF, qualification_state: "qualified" });
        expect(reader).toHaveBeenCalledTimes(1);
    });
    it("starts a model-use operation with CSRF and idempotency", async () => {
        const { api, requestApiWithStatuses } = makeApi(envelope(selectedOperation));
        await expect(api.startResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID, 3))
            .resolves.toMatchObject({ state: "selected" });
        const call = requestApiWithStatuses.mock.calls[0];
        expect(call?.[0]).toBe("/api/v1/projects/proj-1/model-provider-key/" + KEY_ID + "/check-and-use");
        expect(call?.[2]).toEqual([200, 202]);
        expect(new Headers(call?.[1]?.headers).get("x-eliotr-csrf")).toBe("1");
        expect(new Headers(call?.[1]?.headers).get("idempotency-key")).toBe(OP_ID);
    });
    it("rejects a selected operation missing its complete readback", async () => {
        const { api } = makeApi(envelope({ ...selectedOperation, phase: "intent" }));
        await expect(api.readResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID))
            .rejects.toThrow(/complete selected-configuration readback/);
    });
    it("rejects a non-selected operation that still claims a selection", async () => {
        const { api } = makeApi(envelope({ ...selectedOperation, state: "preparing", phase: "intent" }));
        await expect(api.readResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID))
            .rejects.toThrow(/cannot claim a selected configuration/);
    });
    it("rejects a blocked operation without a failure code", async () => {
        const { api } = makeApi(envelope({
            ...selectedOperation, state: "blocked", phase: "native_prepare",
            selected_configuration_ref: null, selection_revision: null,
        }));
        await expect(api.readResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID))
            .rejects.toThrow(/failure code is invalid/);
    });
    it("rejects an uncertain operation with the wrong terminal code", async () => {
        const { api } = makeApi(envelope({
            ...selectedOperation, state: "uncertain", phase: "complete",
            selected_configuration_ref: null, selection_revision: null,
            failure_code: "STORAGE_UNAVAILABLE",
        }));
        await expect(api.readResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID))
            .rejects.toThrow(/terminal failure code/);
    });
    it("rejects an unexpected generation", async () => {
        const { api } = makeApi(envelope(selectedOperation));
        await expect(api.readResearchProviderKeyModelUse("proj-1", "deploy-2", KEY_ID, OP_ID))
            .rejects.toThrow(/Deployment changed/);
    });
    it("rejects a non-uuid operation identity before any request", async () => {
        const { api, requestApiWithStatuses } = makeApi(envelope(selectedOperation));
        await expect(api.readResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, "not-a-uuid"))
            .rejects.toThrow(/operation identity is invalid/);
        expect(requestApiWithStatuses).not.toHaveBeenCalled();
    });
    it("rejects a start request with an invalid expected revision", async () => {
        const { api, requestApiWithStatuses } = makeApi(envelope(selectedOperation));
        await expect(api.startResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID, 0))
            .rejects.toThrow(/request is invalid/);
        expect(requestApiWithStatuses).not.toHaveBeenCalled();
    });
    it("fails closed on a closed epoch without dispatching the request", async () => {
        const { api, requestApiWithStatuses } = deadApi();
        await expect(api.readResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID))
            .rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
        expect(requestApiWithStatuses).not.toHaveBeenCalled();
    });
    it("fails closed when the epoch closes during the awaited read", async () => {
        let release: (value: unknown) => void = () => { };
        const gate = new Promise<unknown>((resolve) => { release = resolve; });
        const { api, close } = makeApi(gate);
        const pending = api.readResearchProviderKeyModelUse("proj-1", "deploy-1", KEY_ID, OP_ID);
        close();
        release(envelope(selectedOperation));
        await expect(pending).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    });
});
