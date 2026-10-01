import { describe, expect, it } from "vitest";
import { ROUTES } from "@eliotr/interfaces";
import {
  ArtifactProductInputError,
  parseAcceptArtifactRequest,
  readAcceptArtifactRequest,
} from "../src/artifact-product-http.js";

const artifactRef = { id: "report-1", revision: 4 } as const;
const idempotencyKey = "owner-accept-2026-10-01-01";

describe("artifact publication HTTP input", () => {
  it("publishes owner-only accept and canonical publication read routes", () => {
    expect(ROUTES).toContainEqual({
      method: "POST",
      path: "/api/v1/research/artifact/:ref/accept",
      operation: "research.artifact.accept",
      auth: "owner",
      maximum_request_bytes: 2048,
      response_mode: "json",
    });
    expect(ROUTES).toContainEqual({
      method: "GET",
      path: "/api/v1/research/artifact/:ref/publication",
      operation: "research.artifact.publication",
      auth: "owner",
      maximum_request_bytes: 0,
      response_mode: "json",
    });
  });

  it("binds acceptance to the exact draft path and publication CAS revision", () => {
    expect(parseAcceptArtifactRequest({
      protocol: "eliotr.artifact-publication-accept.v1",
      expected_draft_head_revision: 4,
      expected_publication_revision: null,
    }, artifactRef, idempotencyKey)).toEqual({
      protocol: "eliotr.artifact-publication-accept.v1",
      artifact_ref: artifactRef,
      expected_draft_head_revision: 4,
      expected_publication_revision: null,
      idempotency_key: idempotencyKey,
    });
  });

  it("rejects unknown, missing, or authority-bearing request fields", () => {
    expect(() => parseAcceptArtifactRequest({
      protocol: "eliotr.artifact-publication-accept.v1",
      expected_draft_head_revision: 4,
      expected_publication_revision: null,
      policy_authority_ref: "client-selected-policy",
    }, artifactRef, idempotencyKey)).toThrow(ArtifactProductInputError);
    expect(() => parseAcceptArtifactRequest({
      protocol: "eliotr.artifact-publication-accept.v1",
      expected_draft_head_revision: 4,
    }, artifactRef, idempotencyKey)).toThrow(ArtifactProductInputError);
  });

  it("rejects path/body head disagreement and malformed idempotency keys", () => {
    expect(() => parseAcceptArtifactRequest({
      protocol: "eliotr.artifact-publication-accept.v1",
      expected_draft_head_revision: 3,
      expected_publication_revision: null,
    }, artifactRef, idempotencyKey)).toThrow(/exact artifact revision/u);
    expect(() => parseAcceptArtifactRequest({
      protocol: "eliotr.artifact-publication-accept.v1",
      expected_draft_head_revision: 4,
      expected_publication_revision: 0,
    }, artifactRef, "bad key")).toThrow(ArtifactProductInputError);
  });

  it("requires the idempotency header and a bounded JSON body", async () => {
    const body = JSON.stringify({
      protocol: "eliotr.artifact-publication-accept.v1",
      expected_draft_head_revision: 4,
      expected_publication_revision: null,
    });
    await expect(readAcceptArtifactRequest(new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }), "report-1:4", 2048)).rejects.toThrow(/idempotency-key/u);
    await expect(readAcceptArtifactRequest(new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: `${body} `,
    }), "report-1:4", body.length)).rejects.toThrow();
  });
});
