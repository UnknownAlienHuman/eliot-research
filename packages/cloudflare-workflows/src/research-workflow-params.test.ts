/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { parseResearchWorkflowParams } from "./research-workflow-params.js";

const QUALIFICATION_MARKER = "research-qualification-renewal.v1" as const;

type ExhaustiveRequest = { readonly query: string };

const residency = {
  scope_domain_id: "scope-1",
  access_domain_id: "access-1",
  confidentiality_domain_id: "confidential",
  encryption_key_domain_id: "key-1",
  retention_domain_id: "retention-1",
  erasure_domain_id: "erasure-1",
  content_digest: { algorithm: "sha256", digest: "a".repeat(64) },
} as const;

const initialManifest = { object_ref: "manifest-1", sha256: "a".repeat(64), byte_length: 1, residency };

function researchEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: "operation-1",
    investigation_ref: { id: "investigation-1", revision: 1 },
    idempotency_key: "idem-1",
    handler_generation: "handler-1",
    initial_input_manifest: initialManifest,
    principal_ref: "principal-1",
    credential_generation: "credential-1",
    deployment_generation: "deployment-1",
    ...extra,
  };
}

function exhaustiveEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflow_kind: "EXHAUSTIVE_QUERY",
    operation_id: "operation-2",
    idempotency_key: "idem-2",
    principal_ref: "principal-2",
    credential_generation: "credential-2",
    deployment_generation: "deployment-2",
    exhaustive_request: { query: "find" },
    ...extra,
  };
}

function parse(value: unknown) {
  return parseResearchWorkflowParams<ExhaustiveRequest, typeof QUALIFICATION_MARKER>(value, {
    parse_exhaustive_request: (input) => input as ExhaustiveRequest,
    qualification_renewal_marker: QUALIFICATION_MARKER,
  });
}

describe("research workflow params envelope discriminant", () => {
  it("accepts the legacy envelope with the workflow_kind omitted", () => {
    const params = parse(researchEnvelope());
    expect(params).toEqual({ ...researchEnvelope() });
    expect(params).not.toHaveProperty("workflow_kind");
  });

  it("accepts the explicit RESEARCH discriminant with unchanged normalization", () => {
    expect(parse(researchEnvelope({ workflow_kind: "RESEARCH" })))
      .toEqual({ ...researchEnvelope() });
    expect(parse(researchEnvelope({ workflow_kind: "RESEARCH" })))
      .toEqual(parse(researchEnvelope()));
  });

  it("keeps the explicit RESEARCH normalization of requested_by_principal_ref and the qualification marker", () => {
    const envelope = researchEnvelope({
      workflow_kind: "RESEARCH",
      requested_by_principal_ref: "principal-1",
      qualification_renewal: QUALIFICATION_MARKER,
    });
    expect(parse(envelope)).toEqual({
      requested_by_principal_ref: "principal-1",
      qualification_renewal: QUALIFICATION_MARKER,
      operation_id: "operation-1",
      investigation_ref: researchEnvelope().investigation_ref,
      idempotency_key: "idem-1",
      handler_generation: "handler-1",
      initial_input_manifest: initialManifest,
      principal_ref: "principal-1",
      credential_generation: "credential-1",
      deployment_generation: "deployment-1",
    });
    expect(parse(envelope)).not.toHaveProperty("workflow_kind");
  });

  it("delegates once to the injected exhaustive decoder for a valid EXHAUSTIVE_QUERY envelope", () => {
    const decoder = vi.fn((input: unknown) => input as ExhaustiveRequest);
    const params = parseResearchWorkflowParams<ExhaustiveRequest, typeof QUALIFICATION_MARKER>(exhaustiveEnvelope(), {
      parse_exhaustive_request: decoder,
      qualification_renewal_marker: QUALIFICATION_MARKER,
    });
    expect(params).toEqual({ ...exhaustiveEnvelope(), workflow_kind: "EXHAUSTIVE_QUERY" });
    expect(decoder).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown supplied workflow_kind before the exhaustive decoder or any handler runs", () => {
    for (const kind of ["RESEARCH_VNEXT", "EXHAUSTIVE_QUERY_V2", "RESEARCH ", "research", "", "legacy", 7, null, true, {}, []]) {
      const decoder = vi.fn((input: unknown) => input as ExhaustiveRequest);
      expect(() => parseResearchWorkflowParams<ExhaustiveRequest, typeof QUALIFICATION_MARKER>(
        exhaustiveEnvelope({ workflow_kind: kind }),
        { parse_exhaustive_request: decoder, qualification_renewal_marker: QUALIFICATION_MARKER },
      )).toThrowError(expect.objectContaining({ code: "WORKFLOW_INPUT_INVALID" }));
      expect(() => parseResearchWorkflowParams<ExhaustiveRequest, typeof QUALIFICATION_MARKER>(
        researchEnvelope({ workflow_kind: kind }),
        { parse_exhaustive_request: decoder, qualification_renewal_marker: QUALIFICATION_MARKER },
      )).toThrowError(expect.objectContaining({ code: "WORKFLOW_INPUT_INVALID" }));
      expect(decoder).not.toHaveBeenCalled();
    }
  });

  it("rejects a malformed supplied workflow_kind before persisting any accepted legacy shape", () => {
    const envelope = { ...researchEnvelope(), workflow_kind: "RESEARCH_VNEXT" };
    expect(() => parse(envelope)).toThrowError(expect.objectContaining({ code: "WORKFLOW_INPUT_INVALID" }));
  });
});
