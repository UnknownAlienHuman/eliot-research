import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  decodeSystemHealthEnvelope,
  getSystemHealth,
} from "./api.js";

const health = {
  ready: true,
  deployment_generation: "generation-1",
  core_schema_generation: "core-v1",
  search_schema_generation: "search-v1",
  blocking_reason_codes: [],
  checked_at: "2026-08-30T00:00:00.000Z",
} as const;

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: health,
    trace_id: "trace-1",
    deployment_generation: "generation-1",
    ...overrides,
  };
}

function captureDecoderError(value: unknown): ApiRequestError {
  try {
    decodeSystemHealthEnvelope(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRequestError);
    return error as ApiRequestError;
  }
  throw new Error("decoder unexpectedly accepted invalid input");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("system health API decoder", () => {
  it("accepts the exact Worker envelope", () => {
    expect(decodeSystemHealthEnvelope(envelope())).toEqual(health);
  });

  it("rejects the legacy raw health shape", () => {
    expect(captureDecoderError(health).code).toBe("API_RESPONSE_SCHEMA_MISMATCH");
  });

  it("rejects deployment generation drift between envelope and payload", () => {
    expect(captureDecoderError(envelope({
      deployment_generation: "generation-2",
    })).code).toBe("API_GENERATION_MISMATCH");
  });

  it("rejects unknown load-bearing fields", () => {
    expect(captureDecoderError(envelope({ unexpected: true })).code).toBe(
      "API_RESPONSE_SCHEMA_MISMATCH",
    );
  });

  it("preserves typed API problem fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      type: "urn:eliotr:problem:schema_not_ready",
      title: "Required D1 migrations are not applied",
      status: 503,
      code: "SCHEMA_NOT_READY",
      trace_id: "trace-2",
      retryable: true,
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })));

    let error: unknown;
    try {
      await getSystemHealth();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 503,
      code: "SCHEMA_NOT_READY",
      traceId: "trace-2",
      retryable: true,
    });
  });
});
