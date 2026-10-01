import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_CANDIDATE_BYTES,
  WORKSPACE_CANDIDATE_ADMISSION_PROTOCOL,
  WorkspaceCandidateAdmissionError,
  evaluateWorkspaceCandidateAdmission,
  type WorkspaceCandidateAdmissionInput,
} from "./workspace-candidate-admission.js";
import type { McpToolCallContext } from "./gemini-mcp-protocol.js";
import type { WorkspaceMcpObservationReadback } from "./workspace-mcp-ledger.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PAYLOAD = new TextEncoder().encode("candidate document bytes");

function readback(overrides: {
  disposition?: string;
  state?: string;
  readback_performed?: boolean;
  readback_payload_sha256?: string | undefined;
  principal_ref?: string;
  deployment_generation?: string;
} = {}): WorkspaceMcpObservationReadback {
  return {
    plan: { plan_id: "workspace-mcp-plan-1" } as unknown as WorkspaceMcpObservationReadback["plan"],
    observation: {
      protocol: "eliotr.workspace-mcp.observation.v2",
      observation_id: "workspace-mcp-observation-1",
      plan_id: "workspace-mcp-plan-1",
      idempotency_key: "key-1",
      plan_sha256: "a".repeat(64),
      state: overrides.state ?? "OBSERVED",
      disposition: overrides.disposition ?? "OBSERVED_MATCH",
      receipt_sha256: "b".repeat(64),
      reason_codes: [],
      candidate_only: true,
      source_evidence_authority_changed: false,
    } as unknown as WorkspaceMcpObservationReadback["observation"],
    receipt: {
      connector: "google-workspace",
      google_product: "drive",
      action: "read",
      resource_id: "file-1",
      observed_revision: "rev-1",
      observed_at: "2026-09-09T12:10:00.000Z",
      readback_performed: overrides.readback_performed ?? true,
      ...("readback_payload_sha256" in overrides
        ? { readback_payload_sha256: overrides.readback_payload_sha256 }
        : {}),
    } as unknown as WorkspaceMcpObservationReadback["receipt"],
    provenance: {
      principal_ref: overrides.principal_ref ?? "mcp-actor-1",
      deployment_generation: overrides.deployment_generation ?? "deploy-1",
      auth_profile: "managed-oauth",
      google_transport: "gemini-mcp",
      idempotency_key: "key-1",
      plan_id: "workspace-mcp-plan-1",
      plan_sha256: "a".repeat(64),
      input_fingerprint: "c".repeat(64),
      observation_id: "workspace-mcp-observation-1",
      observation_sha256: "d".repeat(64),
      receipt_sha256: "b".repeat(64),
      issued_at: "2026-09-09T12:00:00.000Z",
      expires_at: "2026-09-09T12:15:00.000Z",
      observed_at: "2026-09-09T12:10:00.000Z",
    },
  };
}

const context: McpToolCallContext = {
  principal_ref: "mcp-actor-1",
  trace_id: "trace-1",
  deployment_generation: "deploy-1",
};

async function input(overrides: Partial<WorkspaceCandidateAdmissionInput> = {}): Promise<WorkspaceCandidateAdmissionInput> {
  const payloadDigest = await sha256Hex(PAYLOAD);
  return {
    readback: readback({ readback_payload_sha256: payloadDigest }),
    candidate_bytes: PAYLOAD,
    owner_authorization_ref: "owner-authz-1",
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceCandidateAdmissionError);
    return (error as WorkspaceCandidateAdmissionError).code;
  }
  throw new Error("expected admission to fail");
}

describe("workspace candidate admission gate", () => {
  it("binds matching bytes to an exact-match observation with owner authorization", async () => {
    const payloadDigest = await sha256Hex(PAYLOAD);
    const admission = await evaluateWorkspaceCandidateAdmission(await input(), context);
    expect(admission.protocol).toBe(WORKSPACE_CANDIDATE_ADMISSION_PROTOCOL);
    expect(admission.observation_id).toBe("workspace-mcp-observation-1");
    expect(admission.plan_id).toBe("workspace-mcp-plan-1");
    expect(admission.receipt_sha256).toBe("b".repeat(64));
    expect(admission.observation_sha256).toBe("d".repeat(64));
    expect(admission.candidate_bytes_sha256).toBe(payloadDigest);
    expect(admission.candidate_byte_length).toBe(PAYLOAD.byteLength);
    expect(admission.principal_ref).toBe("mcp-actor-1");
    expect(admission.deployment_generation).toBe("deploy-1");
    expect(admission.auth_profile).toBe("managed-oauth");
    expect(admission.google_transport).toBe("gemini-mcp");
    expect(admission.owner_authorization_ref).toBe("owner-authz-1");
    expect(admission.candidate_only).toBe(true);
    expect(admission.source_evidence_authority_changed).toBe(false);
    expect(Object.isFrozen(admission)).toBe(true);
  });

  it("refuses a mismatched observation disposition", async () => {
    const payloadDigest = await sha256Hex(PAYLOAD);
    const bad = await input({ readback: readback({ disposition: "OBSERVED_MISMATCH", readback_payload_sha256: payloadDigest }) });
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(bad, context))).toBe("CANDIDATE_OBSERVATION_NOT_MATCHED");
  });

  it("refuses an unknown observation", async () => {
    const payloadDigest = await sha256Hex(PAYLOAD);
    const bad = await input({ readback: readback({ disposition: "UNKNOWN", state: "UNKNOWN", readback_payload_sha256: payloadDigest }) });
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(bad, context))).toBe("CANDIDATE_OBSERVATION_NOT_MATCHED");
  });

  it("refuses when exact readback was not performed", async () => {
    const payloadDigest = await sha256Hex(PAYLOAD);
    const bad = await input({ readback: readback({ readback_performed: false, readback_payload_sha256: payloadDigest }) });
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(bad, context))).toBe("CANDIDATE_READBACK_MISSING");
  });

  it("refuses when the observation carries no payload digest", async () => {
    const bad = await input({ readback: readback({ readback_payload_sha256: undefined }) });
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(bad, context))).toBe("CANDIDATE_PAYLOAD_DIGEST_UNBOUND");
  });

  it("refuses bytes that do not match the observed digest", async () => {
    const payloadDigest = await sha256Hex(PAYLOAD);
    const bad = await input({
      readback: readback({ readback_payload_sha256: payloadDigest }),
      candidate_bytes: new TextEncoder().encode("different bytes"),
    });
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(bad, context))).toBe("CANDIDATE_PAYLOAD_DIGEST_MISMATCH");
  });

  it("refuses cross-actor admission", async () => {
    const foreign: McpToolCallContext = { principal_ref: "mcp-actor-2", trace_id: "trace-1", deployment_generation: "deploy-1" };
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(await input(), foreign))).toBe("CANDIDATE_PRINCIPAL_MISMATCH");
  });

  it("refuses cross-deployment admission", async () => {
    const foreign: McpToolCallContext = { principal_ref: "mcp-actor-1", trace_id: "trace-1", deployment_generation: "deploy-2" };
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(await input(), foreign))).toBe("CANDIDATE_PRINCIPAL_MISMATCH");
  });

  it("refuses a missing owner authorization reference", async () => {
    const bad = await input({ owner_authorization_ref: "" });
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(bad, context))).toBe("CANDIDATE_AUTHORIZATION_MISSING");
  });

  it("refuses oversized candidate bytes", async () => {
    const payloadDigest = await sha256Hex(PAYLOAD);
    const bad = await input({
      readback: readback({ readback_payload_sha256: payloadDigest }),
      candidate_bytes: new Uint8Array(MAX_WORKSPACE_CANDIDATE_BYTES + 1),
    });
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(bad, context))).toBe("CANDIDATE_BYTES_OVERSIZED");
  });

  it("refuses empty candidate bytes", async () => {
    const bad = await input({ candidate_bytes: new Uint8Array(0) });
    expect(await codeOf(evaluateWorkspaceCandidateAdmission(bad, context))).toBe("CANDIDATE_INPUT_INVALID");
  });
});
