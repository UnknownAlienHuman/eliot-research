import { describe, expect, it } from "vitest";

import diagnosticConfirmedFixtureRaw from "../../../docs/contracts/fixtures/eliotr.mcp-client-diagnostic.confirmed.v1.json?raw";
import diagnosticIssuedFixtureRaw from "../../../docs/contracts/fixtures/eliotr.mcp-client-diagnostic.issued.v1.json?raw";
import {
  McpDiagnosticConsumeResultSchema,
  McpDiagnosticLatestStatusSchema,
} from "./index.js";

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("ER-01 MCP diagnostic contract registry", () => {
  it("rejects diagnostic challenge tokens from status and consume readback", () => {
    const issued = parseJson(diagnosticIssuedFixtureRaw);
    const confirmed = McpDiagnosticConsumeResultSchema.parse(
      parseJson(diagnosticConfirmedFixtureRaw),
    );
    if (!isObject(issued)) throw new Error("issued fixture must be an object");
    const challengeToken = issued.challenge_token;
    if (typeof challengeToken !== "string") {
      throw new Error("issued fixture must carry a challenge token");
    }

    expect(McpDiagnosticLatestStatusSchema.safeParse(issued).success).toBe(false);
    expect(
      McpDiagnosticConsumeResultSchema.safeParse({
        ...confirmed,
        challenge_token: challengeToken,
      }).success,
    ).toBe(false);
    expect(Object.hasOwn(confirmed, "challenge_token")).toBe(false);
  });
});
