import { describe, expect, it } from "vitest";
import { RESEARCH_RUN_REQUEST_V2 } from "@eliotr/cloudflare-research";
import { INSTALLED_INQUIRY_PROTOCOL_REFS } from "@eliotr/cloudflare-research";
import {
  parseResearchRunRequest,
  parseResearchRunTransportRequest,
  RESEARCH_RUN_REQUEST_V3,
  researchRunIdentityDigest,
} from "../src/research-run-service.js";
import { ResearchServiceError } from "../src/research-service-error.js";

const query = "What does the owner contract specify?";
const base = {
  query,
  product: "RESEARCH",
  scope_expression: { kind: "UNION", left: { kind: "PROJECT", project_id: "project-alpha" },
    right: { kind: "PROJECT", project_id: "project-beta" } },
  literals: [],
  evidence_grade: "E1",
  budget_ref: "research-budget-v1",
  max_results: 8,
} as const;
const v3 = { ...base, request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: "project-beta" } as const;

/** The exact canonical body the wire request carries once the selector is removed. */
const canonical = (fields: Record<string, unknown>) => JSON.stringify({ ...base, ...fields });

function failureOf(run: () => unknown): { readonly code: string; readonly status: number } {
  try { run(); }
  catch (error) {
    if (error instanceof ResearchServiceError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error("expected the request to be rejected");
}

describe("research run request v3 transport selection", () => {
  it("keeps configuration_project_id off the canonical QueryRequest and out of the persisted body", () => {
    const parsed = parseResearchRunTransportRequest(v3);
    expect(parsed.selection).toEqual({ request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: "project-beta" });
    expect(Object.hasOwn(parsed.request, "configuration_project_id")).toBe(false);
    expect(Object.hasOwn(parsed.request, "request_version")).toBe(false);
    expect(JSON.parse(JSON.stringify(parsed.request))).toEqual(JSON.parse(canonical({})));
    expect(JSON.stringify(parsed.request)).not.toContain("configuration_project_id");
  });

  it("fails closed on an unknown v3 key", () => {
    expect(failureOf(() => parseResearchRunTransportRequest({ ...v3,
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup })))
      .toEqual({ code: "RESEARCH_INPUT_INVALID", status: 400 });
    expect(failureOf(() => parseResearchRunTransportRequest({ ...v3, extra: "value" })))
      .toEqual({ code: "RESEARCH_INPUT_INVALID", status: 400 });
  });

  it("fails closed on a missing selector and on a conflicting version", () => {
    const { configuration_project_id: _omitted, ...withoutSelector } = v3;
    expect(failureOf(() => parseResearchRunTransportRequest(withoutSelector)))
      .toEqual({ code: "RESEARCH_INPUT_INVALID", status: 400 });
    expect(failureOf(() => parseResearchRunTransportRequest({ ...v3, request_version: RESEARCH_RUN_REQUEST_V2 })))
      .toEqual({ code: "RESEARCH_PROFILE_UNSUPPORTED", status: 422 });
    expect(failureOf(() => parseResearchRunTransportRequest({ ...base,
      request_version: "eliotr.research-run-request.v4", configuration_project_id: "project-beta" })))
      .toEqual({ code: "RESEARCH_PROFILE_UNSUPPORTED", status: 422 });
  });

  it("preserves v1 and v2 exact key sets and rejects any configuration_project_id presence", () => {
    expect(parseResearchRunRequest(base)).toEqual(JSON.parse(canonical({})));
    const v2 = parseResearchRunRequest({ ...base, request_version: RESEARCH_RUN_REQUEST_V2,
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup });
    expect(v2.request_version).toBe(RESEARCH_RUN_REQUEST_V2);
    expect(v2.inquiry_protocol_ref).toEqual(INSTALLED_INQUIRY_PROTOCOL_REFS.lookup);
    expect(Object.hasOwn(v2, "configuration_project_id")).toBe(false);
    for (const invalid of [
      { ...base, configuration_project_id: "project-beta" },
      { ...base, request_version: RESEARCH_RUN_REQUEST_V2, configuration_project_id: "project-beta" },
      { ...base, request_version: RESEARCH_RUN_REQUEST_V2,
        inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup, configuration_project_id: "project-beta" },
    ]) {
      expect(failureOf(() => parseResearchRunRequest(invalid)).code).toBe("RESEARCH_INPUT_INVALID");
    }
    // A v1 body carries no version tag, so the transport envelope reports no selector
    // while its canonical request stays byte-identical to the plain v1 parse.
    expect(parseResearchRunTransportRequest(base)).toEqual({ request: parseResearchRunRequest(base), selection: null });
    // A v2 body carries no selector, so it parses identically here and its
    // canonical request keeps its own version tag and protocol reference.
    const v2body = { ...base, request_version: RESEARCH_RUN_REQUEST_V2,
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup };
    expect(parseResearchRunTransportRequest(v2body)).toEqual({ request: parseResearchRunRequest(v2body), selection: null });
    // A v2 body that also carries the selector is a version conflict.
    expect(failureOf(() => parseResearchRunTransportRequest({ ...v2body, configuration_project_id: "project-beta" })).code)
      .toBe("RESEARCH_PROFILE_UNSUPPORTED");
  });

  it("separates the same canonical body from the body that carries a different selector", () => {
    const first = parseResearchRunTransportRequest(v3);
    const changed = parseResearchRunTransportRequest({ ...v3, configuration_project_id: "project-alpha" });
    expect(first.selection?.configuration_project_id).toBe("project-beta");
    expect(changed.selection?.configuration_project_id).toBe("project-alpha");
    // The canonical request is unchanged, so the persisted body bytes cannot
    // distinguish the two: identity binding must use the selector, not the body.
    expect(JSON.stringify(first.request)).toBe(JSON.stringify(changed.request));
    expect(JSON.stringify(first.selection)).not.toBe(JSON.stringify(changed.selection));
    // Replaying the identical body and selector returns the identical capture.
    expect(parseResearchRunTransportRequest(v3)).toEqual(first);
  });

  it("derives one operation identity from the canonical request alone for v1 and v2", async () => {
    // No selection means the digest is exactly the pre-existing canonical request
    // digest, so every already-shipped v1/v2 idempotency identity is unchanged.
    const canonical = await researchRunIdentityDigest(parseResearchRunRequest(base), null);
    expect(await researchRunIdentityDigest(parseResearchRunRequest(base), null)).toBe(canonical);
    expect(canonical).not.toBe(await researchRunIdentityDigest(parseResearchRunTransportRequest(v3).request,
      parseResearchRunTransportRequest(v3).selection));
  });

  it("binds a same-idempotency-key request to a different configuration project to a different identity", async () => {
    const first = parseResearchRunTransportRequest(v3);
    const changed = parseResearchRunTransportRequest({ ...v3, configuration_project_id: "project-alpha" });
    // A different selector under one idempotency key must not resolve to the
    // originally captured configuration_ref: these run identities differ.
    expect(await researchRunIdentityDigest(first.request, first.selection))
      .not.toBe(await researchRunIdentityDigest(changed.request, changed.selection));
  });

  it("replays an identical body and selector as the identical identity so the captured configuration_ref is reused", async () => {
    const replay = parseResearchRunTransportRequest(v3);
    const original = parseResearchRunTransportRequest(v3);
    expect(await researchRunIdentityDigest(replay.request, replay.selection))
      .toBe(await researchRunIdentityDigest(original.request, original.selection));
  });
});

