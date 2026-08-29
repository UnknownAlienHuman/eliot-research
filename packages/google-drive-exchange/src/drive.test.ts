import { describe, expect, it } from "vitest";
import { assembleContribution, scopesAreNarrowAndComplete } from "./index.js";

describe("Drive exchange", () => {
  it("requires narrow drive.file scope", () => {
    expect(scopesAreNarrowAndComplete(["openid", "email", "https://www.googleapis.com/auth/drive.file"])).toBe(true);
    expect(scopesAreNarrowAndComplete(["openid", "email", "https://www.googleapis.com/auth/drive"])).toBe(false);
  });

  it("rejects incomplete payload parts", () => {
    const request = {
      protocol: "eliotr.drive.exchange.v1", request_id: "r", idempotency_key: "i", actor_claim: "chatgpt-web",
      project_id: "p", operation: "audit", intelligence: "strong", scope_expression_json: "{}",
      body_encoding: "chunked_utf8", inline_body: "", payload_id: "x", part_count: 1,
      requested_budget_json: "{}", evidence_handles_json: "[]", created_at: "2026-08-28T12:00:00Z",
    } as const;
    expect(() => assembleContribution(request, [])).toThrow("INCOMPLETE_PAYLOAD_PARTS");
  });
});
