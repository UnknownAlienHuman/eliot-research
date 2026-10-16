import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import { readNativeBuiltinQualificationContext } from "../src/research-catalog-native-builtin-context.js";

const ports = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/research-run-service.js", () => ({ createResearchQueryService: () => ({ query: ports.query }) }));
afterEach(() => vi.resetAllMocks());
const operation = "11111111-1111-4111-8111-111111111111";
const context = { principal_ref: "owner-1", credential_generation: "session-1", client_class: "owner_pwa",
  request: new Request("https://research.example/model-use", { method: "POST" }), trace_id: "trace-1" } as AuthenticatedRequestContext;

async function fixture(initial: "missing" | "present" | "corrupt", admitted = true) {
  const pack = { pack_ref: { id: "pack-1", revision: 1 }, scope_snapshot_ref: { id: "scope-1", revision: 1 },
    trace_ref: { id: "trace-1", revision: 1 }, omitted_candidates: [], total_utf8_bytes: 5,
    resolved_evidence: [{ exact_excerpt: "exact", handle: { handle_ref: { id: "handle-1", revision: 1 }, excerpt_sha256: "a".repeat(64) } }] };
  const body = canonicalModelGatewayJson({ evidence_pack: pack });
  const row = { result_json: body, result_digest: initial === "corrupt" ? "0".repeat(64) : await modelGatewaySha256(body),
    scope_snapshot_id: "scope-1", scope_snapshot_revision: 1, expires_at: "2030-01-01T00:00:00.000Z" };
  let created = initial !== "missing";
  ports.query.mockImplementation(async () => { created = true; });
  const env = { CORE_DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () =>
    sql.startsWith("SELECT q.result_json") ? created ? row : null : admitted ? { source_id: "source-1", title: "Admitted document" } : null,
  }) }) } } as unknown as Env;
  return { env };
}

describe("native model context without a previous chat", () => {
  it("prepares one source through normal authorization with an operation-derived request identity", async () => {
    const f = await fixture("missing");
    const result = await readNativeBuiltinQualificationContext(f.env, context, "project-1", operation);
    expect(result.scope_snapshot_id).toBe("scope-1");
    expect(ports.query).toHaveBeenCalledOnce();
    const [actor, request] = ports.query.mock.calls[0] ?? [];
    expect(actor.principal_ref).toBe(context.principal_ref);
    expect(actor.credential_generation).toBe(context.credential_generation);
    expect(actor.request.headers.get("idempotency-key")).toBe(`${operation}:native-context`);
    expect(request).toMatchObject({ product: "FAST_SEARCH", budget_ref: "retrieval-fast-v1", max_results: 1,
      scope_expression: { kind: "INTERSECT", left: { kind: "PROJECT", project_id: "project-1" },
        right: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] } } });
    await readNativeBuiltinQualificationContext(f.env, context, "project-1", operation);
    expect(ports.query).toHaveBeenCalledOnce();
  });

  it("reuses an intact held result without a new query", async () => {
    const f = await fixture("present");
    await readNativeBuiltinQualificationContext(f.env, context, "project-1", operation);
    expect(ports.query).not.toHaveBeenCalled();
  });

  it("does not replace a corrupt saved result with a fresh query", async () => {
    const f = await fixture("corrupt");
    await expect(readNativeBuiltinQualificationContext(f.env, context, "project-1", operation)).rejects.toThrow("intact held");
    expect(ports.query).not.toHaveBeenCalled();
  });

  it("does not query or dispatch a model when the project has no admitted source", async () => {
    const f = await fixture("missing", false);
    await expect(readNativeBuiltinQualificationContext(f.env, context, "project-1", operation)).rejects.toThrow("admitted project source");
    expect(ports.query).not.toHaveBeenCalled();
  });
});
