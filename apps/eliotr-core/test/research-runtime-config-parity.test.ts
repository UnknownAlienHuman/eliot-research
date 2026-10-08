import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalModelGatewayJson } from "@eliotr/cloudflare-ai";
// @ts-expect-error The JavaScript runtime helper has no declaration file; its tested boundary is typed below.
import * as runtimeConfigModule from "../../../scripts/lib/research-runtime-config.mjs";
import {
  parseResearchPreparedModelTransportPolicies,
  RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
} from "../src/research-prepared-model-transport.js";

const POLICY_KEY = "ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON";
type RuntimeConfigEnvironment = Readonly<Record<string, string | undefined>>;
type RuntimeConfigLoader = (environment: RuntimeConfigEnvironment, root: string) => Promise<Record<string, string | undefined>>;
const loadResearchRuntimeEnvironment = (runtimeConfigModule as unknown as {
  readonly loadResearchRuntimeEnvironment: RuntimeConfigLoader;
}).loadResearchRuntimeEnvironment;

function selection(stage: "ANALYZE_BRANCHES" | "SYNTHESIZE") {
  return {
    stage,
    route_ref: `dynamic/${stage.toLowerCase()}`,
    route_version: "route-v1",
    provider: "zai",
    model: "@cf/zai-org/glm-5.3-flash",
    transport_policy: {
      version: 1,
      transport: "cloudflare-ai-gateway",
      api: "compat-chat-completions",
      provider: "zai",
      model: "@cf/zai-org/glm-5.3-flash",
      billing: { mode: "unified" },
      capabilities: {
        max_output_tokens_field: "max_completion_tokens",
        reasoning_efforts: ["low", "high", "max"],
      },
    },
  };
}

const requiredRuntimeVars = {
  ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: { protocol: "eliotr.research-semantic-config.v1" },
  ELIOTR_MODEL_PROFILE_DEFINITION_JSON: { schema: "eliotr.research.model-profile-definition.v1" },
  ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "fixture:model-profile",
  ELIOTR_MODEL_SPEND_POLICY_JSON: { protocol: "eliotr.research-owner-spend-template.v2" },
  ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "fixture:model-spend-policy",
  ELIOTR_RESEARCH_REPORT_CONFIG_JSON: { schema: "eliotr.research.report-config.v1" },
  ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "fixture:research-report-policy",
};

describe("research runtime policy writer parity", () => {
  it("writes canonical stage/key order accepted by the authoritative Core parser", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliotr-runtime-policy-parity-"));
    try {
      const configPath = resolve(root, "runtime.json");
      const policy = {
        protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
        model_selections: [selection("SYNTHESIZE"), selection("ANALYZE_BRANCHES")],
      };
      await writeFile(configPath, JSON.stringify({ protocol: "eliotr.research-runtime.v1",
        vars: { ...requiredRuntimeVars, [POLICY_KEY]: JSON.stringify(policy) } }), "utf8");

      const environment = await loadResearchRuntimeEnvironment({ ELIOTR_RESEARCH_CONFIG_FILE: configPath }, root);
      const canonical = canonicalModelGatewayJson({
        protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
        model_selections: [selection("ANALYZE_BRANCHES"), selection("SYNTHESIZE")],
      });
      expect(environment[POLICY_KEY]).toBe(canonical);
      expect(parseResearchPreparedModelTransportPolicies(environment[POLICY_KEY])?.model_selections.map((row) => row.stage))
        .toEqual(["ANALYZE_BRANCHES", "SYNTHESIZE"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects the same untrusted request fields at writer and Core parser boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliotr-runtime-policy-invalid-"));
    try {
      const configPath = resolve(root, "runtime.json");
      const invalidPolicy = {
        protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
        model_selections: [{ ...selection("SYNTHESIZE"), request: { model: "untrusted" } }],
      };
      const raw = canonicalModelGatewayJson(invalidPolicy);
      await writeFile(configPath, JSON.stringify({ protocol: "eliotr.research-runtime.v1",
        vars: { ...requiredRuntimeVars, [POLICY_KEY]: raw } }), "utf8");

      await expect(loadResearchRuntimeEnvironment({ ELIOTR_RESEARCH_CONFIG_FILE: configPath }, root))
        .rejects.toThrow(/Research runtime configuration is invalid/u);
      expect(() => parseResearchPreparedModelTransportPolicies(raw)).toThrow(/unsupported field request/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
