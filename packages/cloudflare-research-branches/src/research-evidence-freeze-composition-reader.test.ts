import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@eliotr/cloudflare-workflows", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, readCommittedStageLineage: vi.fn(), readWorkflowObject: vi.fn() };
});

vi.mock("./research-evidence-freeze.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, decodeEvidenceFreezeStageInput: vi.fn() };
});

vi.mock("./research-evidence-freeze-synthesis-lineage.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, parseCommittedFreeze: vi.fn() };
});

import {
  WorkflowCheckpointError,
  digest,
  readCommittedStageLineage,
  readWorkflowObject,
  type StageReceipt,
  type StageRequest,
  type WorkflowObject,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { ReferenceManifestError, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  createEvidenceFreezePostSynthesisContextReader,
  createEvidenceFreezeMaterializeContextReader,
  createEvidenceFreezePredecessorReader,
  createEvidenceFreezeSynthesisContextReader,
  type EvidenceFreezeCommittedReaders,
  type EvidenceFreezeSynthesisReaderEnvironment,
} from "./research-evidence-freeze-composition.js";
import { decodeEvidenceFreezeStageInput } from "./research-evidence-freeze.js";
import { parseCommittedFreeze } from "./research-evidence-freeze-synthesis-lineage.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workflowObject(objectRef: string, sha256: string, residency = {
  scope_domain_id: "scope-1", access_domain_id: "owner-1",
}, byteLength = 1): WorkflowObject {
  return { object_ref: objectRef, sha256, byte_length: byteLength, residency } as unknown as WorkflowObject;
}

function request(stage: StageRequest["stage"], revision: number, inputManifest: WorkflowObject): StageRequest {
  return {
    protocol: "eliotr.workflow-stage.v1",
    operation_id: "operation-1",
    investigation_ref: { id: "investigation-1", revision },
    stage,
    idempotency_key: "workflow-key-1",
    handler_generation: "research-handler-v1",
    input_manifest: inputManifest,
  } as StageRequest;
}

function postSynthesisReader() {
  return createEvidenceFreezePostSynthesisContextReader(
    {
      database: {} as D1Database,
      work_bucket: {} as R2Bucket,
      manifest_store: { get: vi.fn() },
      read_stage_five: vi.fn(),
    } as unknown as EvidenceFreezeSynthesisReaderEnvironment,
    {} as NavigationReadAuthority,
    {} as EvidenceFreezeCommittedReaders,
    "AUDIT_CLAIMS",
  );
}

async function postSynthesisInput() {
  const inputBytes = new TextEncoder().encode("committed audit input");
  return {
    input_bytes: inputBytes,
    request: request("AUDIT_CLAIMS", 15, workflowObject("audit-input", await digest(inputBytes), undefined, inputBytes.byteLength)),
    principal: { principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1" } as WorkflowPrincipal,
  };
}

function synthesisLineageFixtures(inputManifest: WorkflowObject) {
  const residency = inputManifest.residency;
  const stageTenRequest = request("RECONCILE", 10, workflowObject("stage-ten-input", "1".repeat(64), residency));
  const stageTenOutput = workflowObject("stage-ten-output", "2".repeat(64), residency);
  const stageTen = {
    request: stageTenRequest,
    request_sha256: "a".repeat(64),
    attempt_ref: "attempt-ten",
    receipt: {
      protocol: "eliotr.workflow-checkpoint.v1",
      operation_id: "operation-1",
      stage: "RECONCILE",
      request_sha256: "a".repeat(64),
      receipt_ref: "receipt-ten",
      attempt_ref: "attempt-ten",
      investigation_ref: { id: "investigation-1", revision: 11 },
      input_manifest_ref: stageTenRequest.input_manifest.object_ref,
      output_manifest: stageTenOutput,
      budget_receipt_ref: "budget-ten",
      cancellation_checked_at: "2026-10-16T00:00:00.000Z",
      engine_state: "CHECKPOINTED",
    } as StageReceipt,
  };
  const stageElevenRequest = request("FREEZE_EVIDENCE", 11, stageTenOutput);
  const stageElevenOutput = workflowObject(inputManifest.object_ref, inputManifest.sha256, residency);
  const stageEleven = {
    request: stageElevenRequest,
    request_sha256: "b".repeat(64),
    attempt_ref: "attempt-eleven",
    receipt: {
      protocol: "eliotr.workflow-checkpoint.v1",
      operation_id: "operation-1",
      stage: "FREEZE_EVIDENCE",
      request_sha256: "b".repeat(64),
      receipt_ref: "receipt-eleven",
      attempt_ref: "attempt-eleven",
      investigation_ref: { id: "investigation-1", revision: 12 },
      input_manifest_ref: stageElevenRequest.input_manifest.object_ref,
      output_manifest: stageElevenOutput,
      budget_receipt_ref: "budget-eleven",
      cancellation_checked_at: "2026-10-16T00:00:00.000Z",
      engine_state: "CHECKPOINTED",
    } as StageReceipt,
  };
  return { stageTen, stageEleven, stageTenOutput, stageElevenOutput };
}

beforeEach(() => vi.resetAllMocks());

function predecessorReaderFixture() {
  const authority = { policy_authority_ref: "policy-1" };
  const scope = { snapshot_id: "scope-1", revision: 2, digest: "scope-digest" };
  const principal = { principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1" };
  const stageZero = {
    operation_id: "operation-1", investigation_ref: { id: "investigation-1", revision: 7 },
    principal_ref: "owner-1", scope_snapshot_ref: { id: "scope-1", revision: 2 },
  };
  const stageFive = {
    operation_id: "operation-1", investigation_ref: { id: "investigation-1", revision: 7 },
    principal_ref: "owner-1", scope_snapshot_ref: { id: "scope-1", revision: 2 },
  };
  const head = {
    investigation_id: "investigation-1", revision: 7, principal_ref: "owner-1",
    deployment_generation: "deployment-1", scope_snapshot_id: "scope-1", scope_snapshot_revision: 2,
  };
  const navigation = {
    access: { principal_ref: principal.principal_ref, credential_generation: principal.credential_generation },
    scope,
    current: vi.fn(async () => authority),
  } as unknown as NavigationReadAuthority;
  const readers = {
    read_stage_zero: vi.fn(async () => stageZero),
    read_stage_five: vi.fn(async () => stageFive),
    read_w1_head: vi.fn(async () => head),
    read_authorization_receipt_ref: vi.fn(async () => "authorization-1"),
  } as unknown as EvidenceFreezeCommittedReaders;
  const reader = createEvidenceFreezePredecessorReader(navigation, readers);
  const stageRequest = request("RECONCILE", 7, workflowObject("reconcile-input", "1".repeat(64)));
  return { authority, navigation, readers, reader, stageRequest, principal, stageZero, stageFive, head };
}

describe("evidence-freeze predecessor read concurrency", () => {
  it("starts independent stage-zero and stage-five reads together after initial authority", async () => {
    const f = predecessorReaderFixture();
    const stageZeroRead = deferred<typeof f.stageZero>();
    const stageFiveRead = deferred<typeof f.stageFive>();
    const started = new Set<string>();
    const bothStarted = deferred<void>();
    vi.mocked(f.readers.read_stage_zero).mockImplementation(() => {
      started.add("stage-zero");
      if (started.size === 2) bothStarted.resolve();
      return stageZeroRead.promise as never;
    });
    vi.mocked(f.readers.read_stage_five).mockImplementation(() => {
      started.add("stage-five");
      if (started.size === 2) bothStarted.resolve();
      return stageFiveRead.promise as never;
    });

    let finished = false;
    const result = f.reader(f.stageRequest, f.principal).then((value) => { finished = true; return value; });
    await bothStarted.promise;
    expect(f.navigation.current).toHaveBeenCalledOnce();
    expect(finished).toBe(false);

    stageZeroRead.resolve(f.stageZero);
    await Promise.resolve();
    expect(finished).toBe(false);
    stageFiveRead.resolve(f.stageFive);
    await result;

    expect(f.readers.read_stage_zero).toHaveBeenCalledOnce();
    expect(f.readers.read_stage_five).toHaveBeenCalledOnce();
    expect(f.readers.read_w1_head).toHaveBeenCalledTimes(2);
    expect(f.readers.read_authorization_receipt_ref).toHaveBeenCalledOnce();
    expect(f.navigation.current).toHaveBeenCalledTimes(2);
  });

  it("joins both reads and reports the earlier stage-zero failure first", async () => {
    const f = predecessorReaderFixture();
    const stageZeroRead = deferred<typeof f.stageZero>();
    const stageFiveRead = deferred<typeof f.stageFive>();
    const bothStarted = deferred<void>();
    const zeroError = new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
    const fiveError = new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
    let starts = 0;
    vi.mocked(f.readers.read_stage_zero).mockImplementation(() => {
      if (++starts === 2) bothStarted.resolve();
      return stageZeroRead.promise as never;
    });
    vi.mocked(f.readers.read_stage_five).mockImplementation(() => {
      if (++starts === 2) bothStarted.resolve();
      return stageFiveRead.promise as never;
    });

    let finished = false;
    const result = f.reader(f.stageRequest, f.principal).then(
      () => { finished = true; return null; },
      (error: unknown) => { finished = true; return error; },
    );
    await bothStarted.promise;
    stageFiveRead.reject(fiveError);
    await Promise.resolve();
    expect(finished).toBe(false);
    stageZeroRead.reject(zeroError);

    expect(await result).toBe(zeroError);
    expect(f.readers.read_w1_head).not.toHaveBeenCalled();
    expect(f.readers.read_authorization_receipt_ref).not.toHaveBeenCalled();
  });

  it("rejects authority revoked while both predecessor reads are in flight", async () => {
    const f = predecessorReaderFixture();
    const stageZeroRead = deferred<typeof f.stageZero>();
    const stageFiveRead = deferred<typeof f.stageFive>();
    const bothStarted = deferred<void>();
    vi.mocked(f.navigation.current).mockResolvedValueOnce(f.authority as never)
      .mockResolvedValue({ policy_authority_ref: "revoked" } as never);
    vi.mocked(f.readers.read_stage_zero).mockImplementation(() => {
      bothStarted.resolve();
      return stageZeroRead.promise as never;
    });
    vi.mocked(f.readers.read_stage_five).mockImplementation(() => stageFiveRead.promise as never);

    const result = f.reader(f.stageRequest, f.principal);
    await bothStarted.promise;
    stageZeroRead.resolve(f.stageZero);
    stageFiveRead.resolve(f.stageFive);

    await expect(result).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(f.navigation.current).toHaveBeenCalledTimes(2);
    expect(f.readers.read_w1_head).toHaveBeenCalledTimes(2);
  });

  it("rejects a stage-five predecessor from a different operation", async () => {
    const f = predecessorReaderFixture();
    vi.mocked(f.readers.read_stage_five).mockResolvedValue({ ...f.stageFive, operation_id: "foreign-operation" } as never);

    await expect(f.reader(f.stageRequest, f.principal)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(f.readers.read_stage_zero).toHaveBeenCalledOnce();
    expect(f.readers.read_stage_five).toHaveBeenCalledOnce();
    expect(f.readers.read_w1_head).toHaveBeenCalledOnce();
    expect(f.navigation.current).toHaveBeenCalledOnce();
  });
});

describe("evidence-freeze context read concurrency", () => {
  it("joins predecessor reads and reports earlier corrupt lineage before a later read failure", async () => {
    const laterRead = deferred<Awaited<ReturnType<typeof readCommittedStageLineage>>>();
    const starts = new Set<string>();
    const bothStarted = deferred<void>();
    const corruptFirst = {
      request: request("SYNTHESIZE", 13, workflowObject("synthesis-input", "3".repeat(64))),
      request_sha256: "c".repeat(64),
      attempt_ref: "attempt-synthesis",
      receipt: {
        operation_id: "operation-1",
        stage: "SYNTHESIZE",
        investigation_ref: { id: "investigation-1", revision: 14 },
        engine_state: "ENGINE_COMPLETED",
      },
    } as unknown as Awaited<ReturnType<typeof readCommittedStageLineage>>;
    vi.mocked(readCommittedStageLineage).mockImplementation((_store, _operation, stage) => {
      starts.add(stage);
      if (starts.size === 2) bothStarted.resolve();
      return stage === "SYNTHESIZE" ? Promise.resolve(corruptFirst) : laterRead.promise;
    });

    const input = await postSynthesisInput();
    let finished = false;
    const result = postSynthesisReader().read(input).then(
      () => { finished = true; return null; },
      (error: unknown) => { finished = true; return error; },
    );
    await bothStarted.promise;
    expect(finished).toBe(false);

    laterRead.reject(new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE"));
    const error = await result;
    expect(error).toBeInstanceOf(WorkflowCheckpointError);
    expect(error).toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect([...starts]).toEqual(["SYNTHESIZE", "VERIFY"]);
    expect(readWorkflowObject).not.toHaveBeenCalled();
  });

  it("joins all predecessor reads and selects read failures in workflow order", async () => {
    const laterRead = deferred<Awaited<ReturnType<typeof readCommittedStageLineage>>>();
    const starts = new Set<string>();
    const bothStarted = deferred<void>();
    const firstError = new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
    const secondError = new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
    vi.mocked(readCommittedStageLineage).mockImplementation((_store, _operation, stage) => {
      starts.add(stage);
      if (starts.size === 2) bothStarted.resolve();
      return stage === "SYNTHESIZE" ? Promise.reject(firstError) : laterRead.promise;
    });

    const input = await postSynthesisInput();
    let finished = false;
    const result = postSynthesisReader().read(input).then(
      () => { finished = true; return null; },
      (error: unknown) => { finished = true; return error; },
    );
    await bothStarted.promise;
    expect(finished).toBe(false);

    laterRead.reject(secondError);
    const error = await result;
    expect(error).toBe(firstError);
    expect([...starts]).toEqual(["SYNTHESIZE", "VERIFY"]);
    expect(readWorkflowObject).not.toHaveBeenCalled();
  });

  it("rejects authority changed while overlapping stage-five and manifest reads", async () => {
    const authorityBefore = { policy_authority_ref: "policy-before" };
    const authorityDuringReads = { policy_authority_ref: "policy-after" };
    let currentAuthority = authorityBefore;
    const scopeRef = { id: "scope-1", revision: 2 };
    const residency = { scope_domain_id: "scope-1", access_domain_id: "owner-1" };
    const inputBytes = new Uint8Array([7]);
    const inputManifest = workflowObject("synthesis-input", await digest(inputBytes), residency);
    const { stageTen, stageEleven, stageTenOutput } = synthesisLineageFixtures(inputManifest);
    const synthesisRequest = request("SYNTHESIZE", 12, inputManifest);
    const stageTenInput = {
      manifest_ref: { id: "manifest-1", revision: 1 },
      stage_five_attempt_ref: "attempt-five",
      stage_five_request_sha256: "f".repeat(64),
      stage_zero_attempt_ref: "attempt-zero",
      protocol_digest: "protocol-digest",
      coverage_denominator_ref: { id: "denominator-1", revision: 1 },
      protocol_profile: { profile: "profile-1" },
      model_profile_definition: { definition_ref: { revision: 1 } },
      freeze_ref: { id: "freeze-1", revision: 1 },
    };
    const freeze = {
      scope_snapshot_ref: scopeRef,
      freeze_ref: { id: "freeze-1", revision: 1 },
      included_evidence: [],
      client_fence_ref: "credential-1",
    };
    const stageFive = {
      operation_id: "operation-1",
      investigation_ref: { id: "investigation-1", revision: 1 },
      principal_ref: "owner-1",
      stage_attempt_ref: "attempt-five",
      stage_request_sha256: "f".repeat(64),
      scope_snapshot_ref: scopeRef,
      denominator_digest: "denominator-digest",
      evidence_pack: { scope_snapshot_ref: scopeRef, resolved_evidence: [] },
    };
    const stageZero = {
      investigation_ref: { id: "investigation-1", revision: 1 },
      principal_ref: "owner-1",
      attempt_ref: "attempt-zero",
      scope_snapshot_ref: scopeRef,
      protocol_digest: "protocol-digest",
      denominator_digest: "denominator-digest",
      coverage_denominator: { denominator_ref: { id: "denominator-1", revision: 1 } },
      protocol_profile: { profile: "profile-1" },
    };
    const manifest = {
      manifest_ref: { id: "manifest-1", revision: 1 },
      manifest_digest: "d".repeat(64),
      scope_snapshot_ref: scopeRef,
      allowed_evidence_handle_refs: [],
    };
    const manifestRead = deferred<typeof manifest>();
    const stageFiveRead = deferred<typeof stageFive>();
    const manifestStarted = deferred<void>();
    const stageFiveStarted = deferred<void>();
    vi.mocked(readCommittedStageLineage).mockImplementation(async (_store, _operation, stage) =>
      stage === "RECONCILE" ? stageTen : stageEleven);
    vi.mocked(readWorkflowObject).mockImplementation(async (_bucket, expected) =>
      expected.object_ref === stageTenOutput.object_ref ? new Uint8Array([8]) : inputBytes);
    vi.mocked(decodeEvidenceFreezeStageInput).mockResolvedValue(stageTenInput as never);
    vi.mocked(parseCommittedFreeze).mockResolvedValue({ freeze } as never);

    const principal: WorkflowPrincipal = {
      principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1",
    };
    const navigation = {
      access: { principal_ref: principal.principal_ref, credential_generation: principal.credential_generation },
      scope: { snapshot_id: "scope-1", revision: 2, digest: "scope-digest" },
      current: vi.fn(async () => currentAuthority),
    } as unknown as NavigationReadAuthority;
    const readers = {
      read_stage_zero: vi.fn(async () => stageZero),
      read_stage_five: vi.fn(async () => stageFive),
      read_w1_head: vi.fn(async () => ({
        investigation_id: "investigation-1", revision: 12, principal_ref: "owner-1",
        deployment_generation: "deployment-1", scope_snapshot_id: "scope-1", scope_snapshot_revision: 2,
      })),
      read_authorization_receipt_ref: vi.fn(async () => "authorization-1"),
    } as unknown as EvidenceFreezeCommittedReaders;
    const environment = {
      database: {} as D1Database,
      work_bucket: {} as R2Bucket,
      manifest_store: {
        get: vi.fn(() => { manifestStarted.resolve(); return manifestRead.promise; }),
      },
      read_stage_five: vi.fn(() => {
        currentAuthority = authorityDuringReads;
        stageFiveStarted.resolve();
        return stageFiveRead.promise;
      }),
    } as unknown as EvidenceFreezeSynthesisReaderEnvironment;

    let finished = false;
    const result = createEvidenceFreezeSynthesisContextReader(environment, navigation, readers)
      .read({ request: synthesisRequest, principal, input_bytes: inputBytes })
      .then(() => { finished = true; return null; }, (error: unknown) => { finished = true; return error; });
    await Promise.all([stageFiveStarted.promise, manifestStarted.promise]);
    expect(finished).toBe(false);

    stageFiveRead.resolve(stageFive);
    await Promise.resolve();
    expect(finished).toBe(false);
    manifestRead.resolve(manifest as never);
    const error = await result;

    expect(error).toBeInstanceOf(WorkflowCheckpointError);
    expect(error).toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(environment.read_stage_five).toHaveBeenCalledOnce();
    expect(environment.manifest_store.get).toHaveBeenCalledOnce();
    expect(readers.read_authorization_receipt_ref).toHaveBeenCalledTimes(2);
    expect(readers.read_w1_head).toHaveBeenCalledOnce();
  });
});

async function retainedFixture(stage: "SYNTHESIZE" | "VERIFY" | "AUDIT_CLAIMS" | "RESOLVE_CITATIONS" | "CALCULATE_COVERAGE" | "MATERIALIZE") {
  const scopeRef = { id: "scope-1", revision: 2 };
  const principal = { principal_ref: "owner-1", credential_generation: "credential-1", deployment_generation: "deployment-1" };
  const frozenBytes = new Uint8Array([7]);
  const modelBytes = new Uint8Array([9]);
  const frozenObject = workflowObject("synthesis-input", await digest(frozenBytes));
  const { stageTen, stageEleven, stageTenOutput } = synthesisLineageFixtures(frozenObject);
  const expiredAt = "2026-10-16T18:23:29.418Z";
  const profile = { definition_ref: { id: "profile-1", revision: 1 }, expires_at: expiredAt };
  const bindingRef = { id: "binding-1", revision: 1 };
  const stageTenInput = { manifest_ref: { id: "manifest-1", revision: 1 }, stage_five_attempt_ref: "attempt-five",
    stage_five_request_sha256: "f".repeat(64), stage_zero_attempt_ref: "attempt-zero", protocol_digest: "protocol-digest",
    coverage_denominator_ref: { id: "denominator-1", revision: 1 }, protocol_profile: { profile: "profile-1" },
    model_profile_definition: profile, model_profile_binding_ref: bindingRef, freeze_ref: { id: "freeze-1", revision: 1 } };
  const stageFive = { operation_id: "operation-1", investigation_ref: { id: "investigation-1", revision: 1 },
    principal_ref: "owner-1", stage_attempt_ref: "attempt-five", stage_request_sha256: "f".repeat(64),
    scope_snapshot_ref: scopeRef, denominator_digest: "denominator-digest",
    evidence_pack: { scope_snapshot_ref: scopeRef, resolved_evidence: [] } };
  const stageZero = { investigation_ref: { id: "investigation-1", revision: 1 }, principal_ref: "owner-1",
    attempt_ref: "attempt-zero", scope_snapshot_ref: scopeRef, protocol_digest: "protocol-digest",
    denominator_digest: "denominator-digest", coverage_denominator: { denominator_ref: { id: "denominator-1", revision: 1 } },
    protocol_profile: stageTenInput.protocol_profile };
  const manifest = { manifest_ref: stageTenInput.manifest_ref, manifest_digest: "d".repeat(64), scope_snapshot_ref: scopeRef,
    allowed_evidence_handle_refs: [], expires_at: expiredAt };
  const stages = ["SYNTHESIZE", "VERIFY", "AUDIT_CLAIMS", "RESOLVE_CITATIONS", "CALCULATE_COVERAGE", "MATERIALIZE"] as const;
  const commits = new Map<StageRequest["stage"], Awaited<ReturnType<typeof readCommittedStageLineage>>>();
  let previous = frozenObject;
  for (const [index, name] of stages.entries()) {
    const output = workflowObject(`${name}-output`, await digest(modelBytes));
    const req = request(name, index + 12, previous);
    commits.set(name, { request: req, request_sha256: String(index + 1).repeat(64), attempt_ref: `attempt-${name}`,
      receipt: { operation_id: "operation-1", stage: name, investigation_ref: { id: "investigation-1", revision: index + 13 },
        engine_state: "CHECKPOINTED", output_manifest: output, receipt_ref: `receipt-${name}` } as StageReceipt });
    previous = output;
  }
  const invocation = commits.get(stage);
  if (invocation === undefined) throw new Error("Missing invocation fixture");
  vi.mocked(readCommittedStageLineage).mockImplementation(async (_store, _operation, name) => {
    if (name === "RECONCILE") return stageTen;
    if (name === "FREEZE_EVIDENCE") return stageEleven;
    const found = commits.get(name);
    if (found === undefined) throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
    return found;
  });
  vi.mocked(readWorkflowObject).mockImplementation(async (_bucket, expected) =>
    expected.object_ref === stageTenOutput.object_ref ? new Uint8Array([8]) : frozenBytes);
  vi.mocked(decodeEvidenceFreezeStageInput).mockResolvedValue(stageTenInput as never);
  vi.mocked(parseCommittedFreeze).mockResolvedValue({ freeze: { scope_snapshot_ref: scopeRef,
    freeze_ref: stageTenInput.freeze_ref, included_evidence: [], client_fence_ref: "credential-1" } } as never);
  let currentAuthority = { policy_authority_ref: "policy-1" };
  const navigation = { access: principal, scope: { snapshot_id: "scope-1", revision: 2, digest: "scope-digest" },
    current: vi.fn(async () => currentAuthority) } as unknown as NavigationReadAuthority;
  const readers = { read_stage_zero: vi.fn(async () => stageZero), read_stage_five: vi.fn(async () => stageFive),
    read_w1_head: vi.fn(async () => ({ investigation_id: "investigation-1", revision: invocation.request.investigation_ref.revision,
      principal_ref: "owner-1", deployment_generation: "deployment-1", scope_snapshot_id: "scope-1", scope_snapshot_revision: 2 })),
    read_authorization_receipt_ref: vi.fn(async () => "authorization-1") } as unknown as EvidenceFreezeCommittedReaders;
  const get = vi.fn(async () => { throw new ReferenceManifestError("REFERENCE_MANIFEST_SCOPE_STALE", "expired"); });
  const retainedGet = vi.fn(async () => manifest);
  const binding = vi.fn(async () => ({ binding_ref: bindingRef }));
  const environment = { database: {} as D1Database, work_bucket: {} as R2Bucket,
    manifest_store: { get, getForPostModelReadback: retainedGet }, read_stage_five: readers.read_stage_five,
    resolve_post_model_binding: binding } as unknown as EvidenceFreezeSynthesisReaderEnvironment;
  const reader = stage === "SYNTHESIZE" ? createEvidenceFreezeSynthesisContextReader(environment, navigation, readers)
    : createEvidenceFreezePostSynthesisContextReader(environment, navigation, readers, stage);
  return { reader, input: { request: invocation.request, principal, input_bytes: stage === "SYNTHESIZE" ? frozenBytes : modelBytes },
    stageEleven, stageTenOutput,
    manifest, profile, commits, retainedGet, get, binding, environment, navigation, readers,
    changeAuthority: () => { currentAuthority = { policy_authority_ref: "revoked" }; } };
}

describe("materialize context request-local lineage reuse", () => {
  it("reads each committed predecessor once while preserving exact output bindings and fresh fences", async () => {
    const f = await retainedFixture("MATERIALIZE");
    const context = await createEvidenceFreezeMaterializeContextReader(f.environment, f.navigation, f.readers).read(f.input);
    const synthesis = f.commits.get("SYNTHESIZE");
    const coverage = f.commits.get("CALCULATE_COVERAGE");
    expect(context).toMatchObject({
      stage_twelve_request: synthesis?.request, stage_twelve_request_sha256: synthesis?.request_sha256,
      stage_twelve_attempt_ref: synthesis?.attempt_ref, stage_twelve_receipt: synthesis?.receipt,
      stage_sixteen_request: coverage?.request, stage_sixteen_request_sha256: coverage?.request_sha256,
      stage_sixteen_attempt_ref: coverage?.attempt_ref, stage_sixteen_receipt: coverage?.receipt,
    });
    const stages = vi.mocked(readCommittedStageLineage).mock.calls.map(call => call[2]);
    expect(stages).toHaveLength(7);
    for (const stage of ["RECONCILE", "FREEZE_EVIDENCE", "SYNTHESIZE", "VERIFY", "AUDIT_CLAIMS",
      "RESOLVE_CITATIONS", "CALCULATE_COVERAGE"] as const) {
      expect(stages.filter(value => value === stage)).toHaveLength(1);
    }
    expect(readWorkflowObject).toHaveBeenCalledTimes(2);
    expect(f.navigation.current).toHaveBeenCalledTimes(4);
    expect(f.readers.read_authorization_receipt_ref).toHaveBeenCalledTimes(2);
    expect(f.readers.read_w1_head).toHaveBeenCalledTimes(3);
    expect(f.retainedGet).toHaveBeenCalledOnce();
    expect(f.binding).toHaveBeenCalledOnce();
  });

  it("does not carry immutable reads or authority across invocations", async () => {
    const f = await retainedFixture("MATERIALIZE");
    const reader = createEvidenceFreezeMaterializeContextReader(f.environment, f.navigation, f.readers);
    await reader.read(f.input);
    await reader.read(f.input);
    expect(readCommittedStageLineage).toHaveBeenCalledTimes(14);
    expect(readWorkflowObject).toHaveBeenCalledTimes(4);
    expect(f.navigation.current).toHaveBeenCalledTimes(8);
    expect(f.retainedGet).toHaveBeenCalledTimes(2);
    expect(f.binding).toHaveBeenCalledTimes(2);
    vi.mocked(f.navigation.current).mockRejectedValueOnce(new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE"));
    await expect(reader.read(f.input)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(readCommittedStageLineage).toHaveBeenCalledTimes(14);
  });

  it.each(["revocation", "policy", "grant"])("rejects late %s after immutable lineage reuse", async mode => {
    const f = await retainedFixture("MATERIALIZE");
    const current = vi.mocked(f.navigation.current);
    const original = current.getMockImplementation();
    if (original === undefined) throw new Error("Missing current authority fixture");
    let calls = 0;
    current.mockImplementation(async () => {
      const grant = await original();
      if (++calls !== 4) return grant;
      if (mode === "revocation") throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
      return mode === "policy" ? { ...grant, policy_authority_ref: "changed-policy" }
        : { ...grant, authorization_receipt_ref: "changed-grant" };
    });
    await expect(createEvidenceFreezeMaterializeContextReader(f.environment, f.navigation, f.readers).read(f.input))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(current).toHaveBeenCalledTimes(4);
    expect(f.retainedGet).toHaveBeenCalledOnce();
  });

  it.each(["owner", "scope", "revision", "deployment"])("rejects late %s head drift after immutable lineage reuse", async mode => {
    const f = await retainedFixture("MATERIALIZE");
    const head = vi.mocked(f.readers.read_w1_head);
    const original = head.getMockImplementation();
    if (original === undefined) throw new Error("Missing ledger head fixture");
    let calls = 0;
    head.mockImplementation(async (...args) => {
      const value = await original(...args);
      if (++calls !== 3) return value;
      return { ...value, ...(mode === "owner" ? { principal_ref: "different-owner" }
        : mode === "scope" ? { scope_snapshot_id: "different-scope" }
          : mode === "revision" ? { revision: 99 } : { deployment_generation: "different-deployment" }) } as typeof value;
    });
    await expect(createEvidenceFreezeMaterializeContextReader(f.environment, f.navigation, f.readers).read(f.input))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(head).toHaveBeenCalledTimes(3);
    expect(f.navigation.current).toHaveBeenCalledTimes(4);
  });

  it.each(["SYNTHESIZE", "CALCULATE_COVERAGE"] as const)("refuses broken %s output hashes before reuse", async stage => {
    const f = await retainedFixture("MATERIALIZE");
    const committed = f.commits.get(stage);
    if (committed === undefined) throw new Error("Missing committed lineage fixture");
    Object.assign(committed.receipt, { output_manifest: { ...committed.receipt.output_manifest, sha256: "f".repeat(64) } });
    await expect(createEvidenceFreezeMaterializeContextReader(f.environment, f.navigation, f.readers).read(f.input))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(f.retainedGet).not.toHaveBeenCalled();
    expect(f.binding).not.toHaveBeenCalled();
  });
});

describe("post-model retained context purpose", () => {
  it("reuses the verified stage-eleven output within one post-model context", async () => {
    const f = await retainedFixture("RESOLVE_CITATIONS");

    await f.reader.read(f.input);

    expect(vi.mocked(readWorkflowObject).mock.calls.map((call) => call[1].object_ref)).toEqual([
      f.commits.get("SYNTHESIZE")?.request.input_manifest.object_ref,
      f.stageTenOutput.object_ref,
    ]);
  });

  it("requires complete stage-eleven manifest identity before reusing bytes", async () => {
    const f = await retainedFixture("RESOLVE_CITATIONS");
    Object.assign(f.stageEleven.receipt.output_manifest, { byte_length: 2 });

    await expect(f.reader.read(f.input)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(readWorkflowObject).toHaveBeenCalledOnce();
    expect(f.readers.read_stage_zero).not.toHaveBeenCalled();
  });

  it.each(["RESOLVE_CITATIONS", "CALCULATE_COVERAGE", "MATERIALIZE"] as const)("admits original expired artifacts for %s after all model commits", async stage => {
    const f = await retainedFixture(stage);
    const context = await f.reader.read(f.input);
    expect(context.manifest).toBe(f.manifest);
    expect(context.stage_ten_input.model_profile_definition).toBe(f.profile);
    expect(f.retainedGet).toHaveBeenCalledWith(f.manifest.manifest_ref, expect.objectContaining({
      purpose: "POST_MODEL_READBACK", stage, committed_model_stages: [
        expect.objectContaining({ stage: "SYNTHESIZE", attempt_ref: "attempt-SYNTHESIZE" }),
        expect.objectContaining({ stage: "VERIFY", attempt_ref: "attempt-VERIFY" }),
        expect.objectContaining({ stage: "AUDIT_CLAIMS", attempt_ref: "attempt-AUDIT_CLAIMS" }),
      ],
    }));
    expect(f.binding).toHaveBeenCalledWith(expect.objectContaining({ frozen_definition: f.profile }));
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["SYNTHESIZE", "VERIFY", "AUDIT_CLAIMS"] as const)("keeps %s on strict expiry guards", async stage => {
    const f = await retainedFixture(stage);
    await expect(f.reader.read(f.input)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(f.get).toHaveBeenCalledOnce();
    expect(f.retainedGet).not.toHaveBeenCalled();
    expect(f.binding).not.toHaveBeenCalled();
  });

  it.each(["missing", "corrupt", "foreign"])("requires exact committed audit lineage: %s", async fault => {
    const f = await retainedFixture("RESOLVE_CITATIONS");
    const audit = f.commits.get("AUDIT_CLAIMS");
    if (audit === undefined) throw new Error("Missing audit fixture");
    if (fault === "missing") f.commits.delete("AUDIT_CLAIMS");
    if (fault === "corrupt") Object.assign(audit.receipt, { engine_state: "ENGINE_COMPLETED" });
    if (fault === "foreign") Object.assign(audit.request, { operation_id: "foreign-operation" });
    await expect(f.reader.read(f.input)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(f.retainedGet).not.toHaveBeenCalled();
    expect(f.binding).not.toHaveBeenCalled();
  });

  it("rejects current authority changes during historical IO", async () => {
    const f = await retainedFixture("RESOLVE_CITATIONS");
    f.retainedGet.mockImplementation(async () => { f.changeAuthority(); return f.manifest; });
    await expect(f.reader.read(f.input)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("requires the producer to return the original binding identity", async () => {
    const f = await retainedFixture("RESOLVE_CITATIONS");
    f.binding.mockResolvedValue({ binding_ref: { id: "renewed-binding", revision: 1 } });
    await expect(f.reader.read(f.input)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("preserves unavailable classification for uncertain immutable storage", async () => {
    const f = await retainedFixture("RESOLVE_CITATIONS");
    f.retainedGet.mockRejectedValue(new ReferenceManifestError("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", "unknown object outcome", true));
    await expect(f.reader.read(f.input)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_UNAVAILABLE" });
  });
});
