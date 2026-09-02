import { describe, expect, it } from "vitest";
import { APPLICATION_MODEL_ROUTES, ModelGatewayPolicyError, decodeDynamicRouteFingerprint, decodeModelCallReceipt, decodeModelRouteDeployment, prepareModelGatewayCall } from "../../packages/platform-cloudflare/dist/model-gateway.js";

const DIGEST = "a".repeat(64);
function ref(id, revision = 1) { return { id, revision }; }
function deployment(overrides = {}) { return { route_ref: "dynamic/eliotr-balanced", route_version: "route-v3", prompt_generation: "prompt-v2", schema_generation: "schema-v4", parameters_digest: DIGEST, pricing_snapshot_ref: "pricing-2026-09-01", ...overrides }; }
function evidence(overrides = {}) { return { handle: { handle_ref: ref("handle-1"), terminal_state: "LIVE" }, exact_excerpt: "Exact evidence.", ...overrides }; }
function input(overrides = {}) { return { route_ref: "dynamic/eliotr-balanced", prompt_generation: "prompt-v2", schema_generation: "schema-v4", evidence_pack: { pack_ref: ref("pack-1"), scope_snapshot_ref: ref("scope-1"), resolved_evidence: [evidence()], omitted_candidates: [], trace_ref: ref("trace-1"), total_utf8_bytes: 64 }, output_object_ref: "output-object-1", max_input_bytes: 4_096, max_output_bytes: 8_192, budget_reservation_ref: "budget-reservation-1", ...overrides }; }
function receipt(overrides = {}) { return { receipt_ref: "receipt-1", route_fingerprint_ref: "route-fingerprint-1", output_object_ref: "output-object-1", output_sha256: DIGEST, input_tokens: 120, output_tokens: 30, billed_usd: 0.0125, ...overrides }; }
function rejects(call, message) { expect(call).toThrowError(ModelGatewayPolicyError); expect(call).toThrow(message); }

describe("Cloudflare AI Gateway policy boundary", () => {
  it("compiles only the reasoning gateway dynamic route with metadata-only logs and cache bypass", () => {
    const policy = prepareModelGatewayCall(input(), deployment());
    expect(policy).toEqual({ gateway_id: "eliotr-reasoning", provider: "compat", endpoint: "chat/completions", route_ref: "dynamic/eliotr-balanced", headers: { "cf-aig-collect-log": "true", "cf-aig-collect-log-payload": "false", "cf-aig-metadata": expect.any(String), "cf-aig-skip-cache": "true" } });
    const metadata = JSON.parse(policy.headers["cf-aig-metadata"]);
    expect(metadata).toEqual({ budget_reservation_ref: "budget-reservation-1", evidence_pack_ref: "pack-1:1", output_object_ref: "output-object-1", prompt_generation: "prompt-v2", schema_generation: "schema-v4" });
    expect(Object.keys(metadata)).toHaveLength(5);
    expect(policy).not.toHaveProperty("model");
    expect(policy).not.toHaveProperty("provider_model");
  });

  it("admits exactly the application route allowlist", () => {
    for (const route of APPLICATION_MODEL_ROUTES) expect(decodeModelRouteDeployment(deployment({ route_ref: route })).route_ref).toBe(route);
    rejects(() => decodeModelRouteDeployment(deployment({ route_ref: "openai/gpt-5.5" })), "unsupported application route");
    rejects(() => decodeModelRouteDeployment({ ...deployment(), provider: "openai" }), "unsupported field provider");
  });

  it("rejects route, prompt, schema, and immutable-parameter drift", () => {
    rejects(() => prepareModelGatewayCall(input({ route_ref: "dynamic/eliotr-strong" }), deployment()), "does not match");
    rejects(() => prepareModelGatewayCall(input({ prompt_generation: "prompt-v3" }), deployment()), "prompt or schema generation");
    rejects(() => prepareModelGatewayCall(input({ schema_generation: "schema-v5" }), deployment()), "prompt or schema generation");
    rejects(() => decodeModelRouteDeployment(deployment({ parameters_digest: "A".repeat(64) })), "lowercase hexadecimal");
  });

  it("enforces bounded model input/output and declared EvidencePack bytes", () => {
    rejects(() => prepareModelGatewayCall(input({ max_input_bytes: 0 }), deployment()), "between 1 and");
    rejects(() => prepareModelGatewayCall(input({ max_output_bytes: 262_145 }), deployment()), "between 1 and");
    rejects(() => prepareModelGatewayCall(input({ evidence_pack: { ...input().evidence_pack, total_utf8_bytes: 8 } }), deployment()), "understates exact excerpt");
    rejects(() => prepareModelGatewayCall(input({ evidence_pack: { ...input().evidence_pack, total_utf8_bytes: 5_000 }, max_input_bytes: 4_096 }), deployment()), "exceeds the reserved");
  });

  it("requires unique LIVE exact evidence and strict versioned references", () => {
    const duplicate = evidence();
    rejects(() => prepareModelGatewayCall(input({ evidence_pack: { ...input().evidence_pack, resolved_evidence: [duplicate, duplicate] } }), deployment()), "duplicate evidence handle");
    rejects(() => prepareModelGatewayCall(input({ evidence_pack: { ...input().evidence_pack, resolved_evidence: [evidence({ handle: { handle_ref: ref("handle-1"), terminal_state: "STALE" } })] } }), deployment()), "LIVE resolved evidence");
    rejects(() => prepareModelGatewayCall(input({ evidence_pack: { ...input().evidence_pack, pack_ref: { id: "pack-1", revision: 0 } } }), deployment()), "revision must be positive");
    rejects(() => prepareModelGatewayCall({ ...input(), provider: "openai" }, deployment()), "unsupported field provider");
  });

  it("records the actual fallback provider and exact model from dynamic-route response headers", () => {
    const fingerprint = decodeDynamicRouteFingerprint(new globalThis.Headers({ "cf-aig-provider": "workers-ai", "cf-aig-model": "@cf/moonshotai/kimi-k2.6" }), deployment());
    expect(fingerprint).toEqual({ ...deployment(), provider: "workers-ai", exact_model_id: "@cf/moonshotai/kimi-k2.6" });
    expect(Object.isFrozen(fingerprint)).toBe(true);
  });

  it("fails closed when dynamic-route response metadata is missing, duplicated, or malformed", () => {
    rejects(() => decodeDynamicRouteFingerprint({ "cf-aig-provider": "openai" }, deployment()), "missing");
    rejects(() => decodeDynamicRouteFingerprint({ "cf-aig-provider": "openai", "CF-AIG-PROVIDER": "workers-ai", "cf-aig-model": "openai/gpt-5.5" }, deployment()), "duplicate cf-aig-provider");
    rejects(() => decodeDynamicRouteFingerprint({ "cf-aig-provider": "openai", "cf-aig-model": "bad model" }, deployment()), "bounded identifier");
    rejects(() => decodeDynamicRouteFingerprint(null, deployment()), "headers must be");
  });

  it("decodes a receipt only when route fingerprint and output reservation remain exact", () => {
    const decoded = decodeModelCallReceipt(input(), "route-fingerprint-1", receipt());
    expect(decoded).toEqual(receipt());
    expect(Object.isFrozen(decoded)).toBe(true);
    rejects(() => decodeModelCallReceipt(input(), "route-fingerprint-2", receipt()), "does not match");
    rejects(() => decodeModelCallReceipt(input(), "route-fingerprint-1", receipt({ output_object_ref: "other-output" })), "reserved output object");
    rejects(() => decodeModelCallReceipt(input(), "route-fingerprint-1", { ...receipt(), provider: "openai" }), "unsupported field provider");
  });

  it("rejects noncanonical hashes, counters, and cost observations", () => {
    rejects(() => decodeModelCallReceipt(input(), "route-fingerprint-1", receipt({ output_sha256: "A".repeat(64) })), "lowercase hexadecimal");
    rejects(() => decodeModelCallReceipt(input(), "route-fingerprint-1", receipt({ input_tokens: -1 })), "nonnegative safe integer");
    rejects(() => decodeModelCallReceipt(input(), "route-fingerprint-1", receipt({ output_tokens: 1.5 })), "nonnegative safe integer");
    rejects(() => decodeModelCallReceipt(input(), "route-fingerprint-1", receipt({ billed_usd: Number.NaN })), "finite nonnegative");
  });

  it("keeps gateway policy free of authorization secrets and provider selection", () => {
    const policy = prepareModelGatewayCall(input({ cancellation_ref: "cancel-1" }), deployment());
    const serialized = JSON.stringify(policy);
    expect(serialized).not.toMatch(/authorization|api[_-]?key|bearer|openai\/gpt/iu);
    expect(policy.headers["cf-aig-skip-cache"]).toBe("true");
  });
});
