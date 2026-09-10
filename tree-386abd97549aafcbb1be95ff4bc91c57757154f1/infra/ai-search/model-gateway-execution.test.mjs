import { describe, expect, it, vi } from "vitest";

import {
  ModelGatewayExecutionError,
  canonicalModelGatewayJson,
  createModelGatewayFetchAdapter,
  decodeModelGatewayResponse,
  executeObservedModelGatewayCall,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  prepareModelGatewayHttpRequest,
  rejectModelGatewayHttpFailure,
} from "../../packages/cloudflare-ai/dist/index.js";

const ACCOUNT_ID = "a".repeat(32);
const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/eliotr-reasoning`;
const TOKEN = "gateway-token-1";
const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cf-aig-provider": "openai",
  "cf-aig-model": "openai/model-v1",
  "cf-aig-log-id": "01K4MODELLOG000000000000001",
  "cf-aig-cache-status": "MISS",
  "cf-aig-step": "route-step-2",
};

function ref(id, revision = 1) {
  return { id, revision };
}

function evidence() {
  return {
    handle: {
      handle_ref: ref("handle-1"),
      terminal_state: "LIVE",
    },
    exact_excerpt: "Exact evidence.",
  };
}

function input(overrides = {}) {
  return {
    route_ref: "dynamic/eliotr-balanced",
    prompt_generation: "prompt-v2",
    schema_generation: "schema-v4",
    evidence_pack: {
      pack_ref: ref("pack-1"),
      scope_snapshot_ref: ref("scope-1"),
      resolved_evidence: [evidence()],
      omitted_candidates: [],
      trace_ref: ref("trace-1"),
      total_utf8_bytes: 64,
    },
    output_object_ref: "output-object-1",
    max_input_bytes: 4_096,
    max_output_bytes: 8_192,
    budget_reservation_ref: "budget-reservation-1",
    ...overrides,
  };
}

function requestBody(overrides = {}) {
  return {
    model: "dynamic/eliotr-balanced",
    messages: [
      {
        role: "system",
        content: "Trusted instructions.\n\nReturn exact JSON.",
      },
      {
        role: "user",
        content: "Evidence:\nExact evidence.",
      },
    ],
    max_tokens: 512,
    temperature: 0,
    top_p: 1,
    seed: 7,
    stop: "\n\n",
    stream: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    },
    ...overrides,
  };
}

async function deployment(body = requestBody(), overrides = {}) {
  return {
    route_ref: "dynamic/eliotr-balanced",
    route_version: "route-v3",
    prompt_generation: "prompt-v2",
    schema_generation: "schema-v4",
    parameters_digest: await modelGatewayRequestParametersSha256(body),
    pricing_snapshot_ref: "pricing-2026-09-01",
    ...overrides,
  };
}

function fingerprint(deployed, overrides = {}) {
  return {
    ...deployed,
    provider: "openai",
    exact_model_id: "openai/model-v1",
    ...overrides,
  };
}

async function compiled(body = requestBody(), overrides = {}) {
  const canonical = canonicalModelGatewayJson(body);
  return {
    request_body: body,
    request_body_sha256: await modelGatewaySha256(canonical),
    request_timeout_ms: 30_000,
    ...overrides,
  };
}

function responseBody(overrides = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1_788_402_400,
    model: "model-v1-2026-09-01",
    service_tier: "default",
    system_fingerprint: "fingerprint-v1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: '{"answer":"ok"}',
          refusal: null,
          annotations: [],
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
    ...overrides,
  };
}

function gatewayResponse(body = responseBody(), options = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new globalThis.Response(text, {
    status: options.status ?? 200,
    headers: {
      ...RESPONSE_HEADERS,
      ...(options.headers ?? {}),
    },
  });
}

async function fixture(overrides = {}) {
  const body = overrides.request_body ?? requestBody();
  const deployed = overrides.deployment ?? (await deployment(body));
  const compiledPrompt =
    overrides.compiled ?? (await compiled(body));
  const response = overrides.response ?? gatewayResponse();
  const outputBodies = [];
  const deployments = {
    resolve: vi.fn(async () => deployed),
  };
  const prompts = {
    compile: vi.fn(async () => compiledPrompt),
  };
  const credentials = {
    readGatewayToken: vi.fn(async () => TOKEN),
  };
  const transport = {
    fetch: vi.fn(async () => response),
  };
  const outputs = {
    putImmutable: vi.fn(async (objectRef, stream, expectedSha256) => {
      outputBodies.push(new Uint8Array(await new globalThis.Response(stream).arrayBuffer()));
      return {
        object_ref: objectRef,
        readback_sha256: expectedSha256,
      };
    }),
  };
  const fingerprints = {
    putImmutable: vi.fn(async (_value, expectedSha256) => ({
      fingerprint_ref: "route-fingerprint-1",
      readback_sha256: expectedSha256,
    })),
    getLatest: vi.fn(async () => fingerprint(deployed)),
  };
  const pricing = {
    quote: vi.fn(async ({ pricing_snapshot_ref }) => ({
      quote_ref: "pricing-quote-1",
      pricing_snapshot_ref,
      billed_usd: 0.0125,
    })),
  };
  const dependencies = {
    reasoning_gateway_base_url: BASE_URL,
    deployments,
    prompts,
    credentials,
    transport,
    outputs,
    fingerprints,
    pricing,
    ...(overrides.dependencies ?? {}),
  };
  return {
    body,
    deployed,
    compiledPrompt,
    response,
    outputBodies,
    dependencies,
    deployments,
    prompts,
    credentials,
    transport,
    outputs,
    fingerprints,
    pricing,
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelGatewayExecutionError);
    expect(error.code).toBe(code);
    return error;
  }
}

describe("ER-16 reasoning gateway fetch execution boundary", () => {
  it("prepares the authenticated dynamic-route endpoint without leaking a provider Authorization header", async () => {
    const body = requestBody();
    const deployed = await deployment(body);
    const prepared = await prepareModelGatewayHttpRequest(
      input(),
      deployed,
      await compiled(body),
      BASE_URL,
      TOKEN,
    );
    expect(prepared.url).toBe(
      `${BASE_URL}/compat/chat/completions`,
    );
    expect(prepared.method).toBe("POST");
    expect(prepared.headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/json",
      "cf-aig-authorization": `Bearer ${TOKEN}`,
      "cf-aig-collect-log": "true",
      "cf-aig-collect-log-payload": "false",
      "cf-aig-skip-cache": "true",
      "cf-aig-request-timeout": "30000",
      "cf-aig-max-attempts": "1",
    });
    expect(prepared.headers).not.toHaveProperty("Authorization");
    expect(prepared.body).toBe(canonicalModelGatewayJson(body));
    expect(prepared.body_sha256).toBe(
      await modelGatewaySha256(prepared.body),
    );
    expect(prepared.parameters_sha256).toBe(deployed.parameters_digest);
    expect(Object.isFrozen(prepared)).toBe(true);
  });

  it("preserves multiline prompts and newline stop sequences", async () => {
    const body = requestBody({ stop: ["\n\n", "\r\nEND"] });
    const prepared = await prepareModelGatewayHttpRequest(
      input(),
      await deployment(body),
      await compiled(body),
      BASE_URL,
      TOKEN,
    );
    const decoded = JSON.parse(prepared.body);
    expect(decoded.messages[0].content).toContain("\n\n");
    expect(decoded.stop).toEqual(["\n\n", "\r\nEND"]);
  });

  it("rejects wrong endpoints, malformed tokens, unsafe body fields, and reservation overflow before fetch", async () => {
    const body = requestBody();
    const deployed = await deployment(body);
    const compiledPrompt = await compiled(body);
    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        compiledPrompt,
        `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/other-gateway`,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    const unsafeBody = requestBody({ tools: [] });
    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        await compiled(unsafeBody),
        BASE_URL,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    await expectCode(
      prepareModelGatewayHttpRequest(
        input({ max_input_bytes: 64 }),
        deployed,
        compiledPrompt,
        BASE_URL,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    const oversizedOutput = requestBody({ max_tokens: 9_000 });
    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        await deployment(oversizedOutput),
        await compiled(oversizedOutput),
        BASE_URL,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    for (const invalidToken of [`Bearer ${TOKEN}`, " token-with-space "]) {
      await expectCode(
        prepareModelGatewayHttpRequest(
          input(),
          deployed,
          compiledPrompt,
          BASE_URL,
          invalidToken,
        ),
        "MODEL_GATEWAY_CREDENTIAL_INVALID",
      );
    }
  });

  it("rejects request-body and deployed-parameter digest drift", async () => {
    const body = requestBody();
    const deployed = await deployment(body);
    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        deployed,
        await compiled(body, { request_body_sha256: "b".repeat(64) }),
        BASE_URL,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    await expectCode(
      prepareModelGatewayHttpRequest(
        input(),
        { ...deployed, parameters_digest: "c".repeat(64) },
        await compiled(body),
        BASE_URL,
        TOKEN,
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
  });

  it("executes exactly once, persists exact response and fingerprint readbacks, and prices pinned usage", async () => {
    const state = await fixture();
    const observation = await executeObservedModelGatewayCall(
      state.dependencies,
      input(),
    );
    expect(state.transport.fetch).toHaveBeenCalledOnce();
    const [url, init] = state.transport.fetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/compat/chat/completions`);
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(init.headers["cf-aig-authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["cf-aig-max-attempts"]).toBe("1");
    expect(state.outputs.putImmutable).toHaveBeenCalledOnce();
    expect(state.fingerprints.putImmutable).toHaveBeenCalledOnce();
    expect(state.pricing.quote).toHaveBeenCalledWith({
      fingerprint: fingerprint(state.deployed),
      pricing_snapshot_ref: "pricing-2026-09-01",
      input_tokens: 120,
      output_tokens: 30,
    });
    const persistedText = new globalThis.TextDecoder().decode(state.outputBodies[0]);
    expect(JSON.parse(persistedText)).toEqual(responseBody());
    expect(observation).toMatchObject({
      receipt: {
        receipt_ref: expect.stringMatching(/^model-call-[a-f0-9]{48}$/u),
        route_fingerprint_ref: "route-fingerprint-1",
        output_object_ref: "output-object-1",
        input_tokens: 120,
        output_tokens: 30,
        billed_usd: 0.0125,
      },
      route_fingerprint: fingerprint(state.deployed),
      gateway_log_id: RESPONSE_HEADERS["cf-aig-log-id"],
      pricing_quote_ref: "pricing-quote-1",
      response_model: "model-v1-2026-09-01",
      successful_step: "route-step-2",
    });
    expect(observation.receipt.output_sha256).toBe(
      await modelGatewaySha256(new globalThis.TextEncoder().encode(persistedText)),
    );
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it("exposes the narrow ModelGatewayAdapter interface", async () => {
    const state = await fixture();
    const adapter = createModelGatewayFetchAdapter(state.dependencies);
    const receipt = await adapter.execute(input());
    expect(receipt.route_fingerprint_ref).toBe("route-fingerprint-1");
    expect(state.transport.fetch).toHaveBeenCalledOnce();
    expect(Object.keys(adapter).sort()).toEqual(["execute", "resolveFingerprint"]);
  });

  it("fails before transport when deployment, input, prompt, or credential authority is unavailable", async () => {
    const missingDeployment = await fixture({
      dependencies: { deployments: { resolve: vi.fn(async () => null) } },
    });
    await expectCode(
      executeObservedModelGatewayCall(missingDeployment.dependencies, input()),
      "MODEL_GATEWAY_DEPLOYMENT_MISSING",
    );
    expect(missingDeployment.transport.fetch).not.toHaveBeenCalled();

    const invalidInput = await fixture();
    await expectCode(
      executeObservedModelGatewayCall(
        invalidInput.dependencies,
        input({ prompt_generation: "wrong-prompt" }),
      ),
      "MODEL_GATEWAY_REQUEST_INVALID",
    );
    expect(invalidInput.prompts.compile).not.toHaveBeenCalled();

    const failedPrompt = await fixture({
      dependencies: {
        prompts: {
          compile: vi.fn(async () => {
            throw new Error("compiler unavailable");
          }),
        },
      },
    });
    await expectCode(
      executeObservedModelGatewayCall(failedPrompt.dependencies, input()),
      "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
    );
    expect(failedPrompt.transport.fetch).not.toHaveBeenCalled();

    const failedCredential = await fixture({
      dependencies: {
        credentials: { readGatewayToken: vi.fn(async () => "bad token") },
      },
    });
    await expectCode(
      executeObservedModelGatewayCall(failedCredential.dependencies, input()),
      "MODEL_GATEWAY_CREDENTIAL_INVALID",
    );
    expect(failedCredential.transport.fetch).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous transport failure", async () => {
    const transport = {
      fetch: vi.fn(async () => {
        throw new Error("connection closed after upstream acceptance");
      }),
    };
    const state = await fixture({ dependencies: { transport } });
    const error = await expectCode(
      executeObservedModelGatewayCall(state.dependencies, input()),
      "MODEL_GATEWAY_TRANSPORT_FAILED",
    );
    expect(error.retryable).toBe(false);
    expect(transport.fetch).toHaveBeenCalledOnce();
    expect(state.outputs.putImmutable).not.toHaveBeenCalled();
    expect(state.pricing.quote).not.toHaveBeenCalled();
  });

  it("classifies auth, limit, policy, and upstream HTTP failures without persistence", async () => {
    const cases = [
      [401, { error: { code: 10000 } }, {}, "MODEL_GATEWAY_AUTH_REJECTED"],
      [429, { errors: [{ code: 2003 }] }, {}, "MODEL_GATEWAY_LIMIT_REJECTED"],
      [424, { errors: [{ code: 2016 }] }, {}, "MODEL_GATEWAY_POLICY_REJECTED"],
      [400, { errors: [{ code: 2029 }] }, {
        "cf-aig-dlp": JSON.stringify({
          action: "BLOCK",
          findings: [{ check: "REQUEST" }],
        }),
      }, "MODEL_GATEWAY_POLICY_REJECTED"],
      [503, { error: { code: 5000 } }, {}, "MODEL_GATEWAY_UPSTREAM_REJECTED"],
    ];
    for (const [status, body, headers, code] of cases) {
      const state = await fixture({
        response: gatewayResponse(body, { status, headers }),
      });
      const error = await expectCode(
        executeObservedModelGatewayCall(state.dependencies, input()),
        code,
      );
      expect(error.http_status).toBe(status);
      expect(state.transport.fetch).toHaveBeenCalledOnce();
      expect(state.outputs.putImmutable).not.toHaveBeenCalled();
      expect(state.fingerprints.putImmutable).not.toHaveBeenCalled();
    }
  });

  it("fails closed on DLP flags, cache hits, truncation, refusal, and token drift", async () => {
    const variants = [
      [gatewayResponse(responseBody(), {
        headers: {
          "cf-aig-dlp": JSON.stringify({
            action: "FLAG",
            findings: [{ check: "RESPONSE" }],
          }),
        },
      }), "MODEL_GATEWAY_POLICY_REJECTED"],
      [gatewayResponse(responseBody(), {
        headers: { "cf-aig-cache-status": "HIT" },
      }), "MODEL_GATEWAY_RESPONSE_INVALID"],
      [gatewayResponse(responseBody({
        choices: [{
          index: 0,
          message: { role: "assistant", content: "partial" },
          finish_reason: "length",
          logprobs: null,
        }],
      })), "MODEL_GATEWAY_OUTPUT_TRUNCATED"],
      [gatewayResponse(responseBody({
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "blocked",
            refusal: "policy",
          },
          finish_reason: "stop",
          logprobs: null,
        }],
      })), "MODEL_GATEWAY_POLICY_REJECTED"],
      [gatewayResponse(responseBody({
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 149,
        },
      })), "MODEL_GATEWAY_RESPONSE_INVALID"],
    ];
    for (const [response, code] of variants) {
      const state = await fixture({ response });
      await expectCode(
        executeObservedModelGatewayCall(state.dependencies, input()),
        code,
      );
      expect(state.outputs.putImmutable).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed content, metadata, and reserved response byte overflow", async () => {
    const deployed = await deployment();
    const invalidResponses = [
      new globalThis.Response("not-json", {
        headers: { ...RESPONSE_HEADERS, "content-type": "text/plain" },
      }),
      gatewayResponse({ ...responseBody(), unknown: true }),
      gatewayResponse(responseBody(), {
        headers: { "cf-aig-provider": "bad provider" },
      }),
      gatewayResponse(responseBody(), {
        headers: { "cf-aig-log-id": "bad log id" },
      }),
    ];
    for (const response of invalidResponses) {
      await expectCode(
        decodeModelGatewayResponse(response, deployed, 8_192),
        "MODEL_GATEWAY_RESPONSE_INVALID",
      );
    }
    await expectCode(
      decodeModelGatewayResponse(
        gatewayResponse(responseBody()),
        deployed,
        16,
      ),
      "MODEL_GATEWAY_RESPONSE_INVALID",
    );
  });

  it("requires exact immutable output, fingerprint, and pricing readbacks", async () => {
    const badOutput = await fixture({
      dependencies: {
        outputs: {
          putImmutable: vi.fn(async () => ({
            object_ref: "output-object-1",
            readback_sha256: "b".repeat(64),
          })),
        },
      },
    });
    await expectCode(
      executeObservedModelGatewayCall(badOutput.dependencies, input()),
      "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
    );
    expect(badOutput.fingerprints.putImmutable).not.toHaveBeenCalled();

    const badFingerprint = await fixture({
      dependencies: {
        fingerprints: {
          putImmutable: vi.fn(async () => ({
            fingerprint_ref: "route-fingerprint-1",
            readback_sha256: "b".repeat(64),
          })),
          getLatest: vi.fn(async () => null),
        },
      },
    });
    await expectCode(
      executeObservedModelGatewayCall(badFingerprint.dependencies, input()),
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    );
    expect(badFingerprint.outputs.putImmutable).toHaveBeenCalledOnce();
    expect(badFingerprint.pricing.quote).not.toHaveBeenCalled();

    const badPricing = await fixture({
      dependencies: {
        pricing: {
          quote: vi.fn(async () => ({
            quote_ref: "pricing-quote-1",
            pricing_snapshot_ref: "different-pricing-snapshot",
            billed_usd: 0.01,
          })),
        },
      },
    });
    await expectCode(
      executeObservedModelGatewayCall(badPricing.dependencies, input()),
      "MODEL_GATEWAY_PRICING_FAILED",
    );
    expect(badPricing.outputs.putImmutable).toHaveBeenCalledOnce();
    expect(badPricing.fingerprints.putImmutable).toHaveBeenCalledOnce();
  });

  it("strictly resolves only the latest fingerprint for the requested route", async () => {
    const state = await fixture();
    const adapter = createModelGatewayFetchAdapter(state.dependencies);
    await expect(adapter.resolveFingerprint("dynamic/eliotr-balanced")).resolves.toEqual(
      fingerprint(state.deployed),
    );
    const mismatched = await fixture({
      dependencies: {
        fingerprints: {
          putImmutable: vi.fn(),
          getLatest: vi.fn(async () =>
            fingerprint(await deployment(requestBody(), {
              route_ref: "dynamic/eliotr-strong",
            })),
          ),
        },
      },
    });
    await expectCode(
      createModelGatewayFetchAdapter(mismatched.dependencies).resolveFingerprint(
        "dynamic/eliotr-balanced",
      ),
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    );

    const malformed = await fixture({
      dependencies: {
        fingerprints: {
          putImmutable: vi.fn(),
          getLatest: vi.fn(async () => ({
            ...fingerprint(await deployment()),
            parameters_digest: "not-a-sha256-digest",
          })),
        },
      },
    });
    await expectCode(
      createModelGatewayFetchAdapter(malformed.dependencies).resolveFingerprint(
        "dynamic/eliotr-balanced",
      ),
      "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
    );
  });

  it("classifies standalone policy failures without depending on execution fixtures", async () => {
    await expectCode(
      rejectModelGatewayHttpFailure(
        gatewayResponse(
          { errors: [{ code: 2030 }] },
          { status: 400 },
        ),
      ),
      "MODEL_GATEWAY_POLICY_REJECTED",
    );
  });
});
