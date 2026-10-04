import { describe, expect, it } from "vitest";
import { createResearchOwnerRuntimeConfiguration } from "../src/research-owner-runtime-config.js";
import type { Env } from "../src/env.js";
import { readResearchConfigurationStatus } from "../src/research-configuration-status.js";
import { readResearchSemanticConfigSource } from "../src/research-semantic-config-revision.js";
import { admissionTestConfiguration } from "./research-current-dispatch-config.js";

const OWNER = Object.freeze({
  principal_ref: "legacy-configuration-status-owner",
  credential_generation: "legacy-configuration-status-credential",
  client_class: "owner_pwa" as const,
});

const MAX_CONFIGURATION_BYTES = 65_536;
const SEMANTIC_JSON_FIELD = "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON";

interface SemanticPromptConfig {
  readonly trusted_parameters: Readonly<Record<string, unknown>>;
  readonly request_timeout_ms: number;
}

interface SemanticDocument {
  readonly synthesis: SemanticPromptConfig;
  readonly [key: string]: unknown;
}

async function runtimeFixture() {
  const compiled = await createResearchOwnerRuntimeConfiguration(
    admissionTestConfiguration("legacy-status-generation", OWNER.principal_ref, "legacy-status"),
  );
  const vars = compiled.vars as unknown as Record<string, string | undefined>;
  const installedJson = vars[SEMANTIC_JSON_FIELD];
  if (installedJson === undefined) throw new Error("test fixture is missing installed semantic JSON");
  const installed = JSON.parse(installedJson) as SemanticDocument;
  const prompt = {
    ...installed.synthesis.trusted_parameters,
    reasoning_effort: "max",
  };
  const document: SemanticDocument = {
    ...installed,
    synthesis: {
      ...installed.synthesis,
      trusted_parameters: prompt,
    },
    roles: {
      trusted_parameters: prompt,
      request_timeout_ms: installed.synthesis.request_timeout_ms,
    },
  };
  return { vars, semanticJson: JSON.stringify(document) };
}

function padToUtf8Bytes(value: string, targetBytes: number): string {
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength > targetBytes) throw new Error("test semantic JSON exceeds requested byte length");
  return `${value}${" ".repeat(targetBytes - byteLength)}`;
}

function readLegacyStatus(vars: Record<string, string | undefined>, semanticJson: string) {
  const env = {
    ...vars,
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "legacy-status-generation",
    AI_GATEWAY_REASONING_URL: "https://gateway.example/v1",
    AI: { gateway: async () => new Response() },
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: undefined,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: undefined,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: semanticJson,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: undefined,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: undefined,
  } as unknown as Env;
  expect(readResearchSemanticConfigSource(env).kind).toBe("legacy");
  return readResearchConfigurationStatus(env, OWNER);
}

describe("legacy semantic configuration status validation", () => {
  it("accepts roles with max effort through 65,536 bytes and rejects unknown or oversized JSON", async () => {
    const { vars, semanticJson } = await runtimeFixture();
    const encoder = new TextEncoder();

    expect(encoder.encode(semanticJson).byteLength).toBeLessThanOrEqual(MAX_CONFIGURATION_BYTES);
    expect(readLegacyStatus(vars, semanticJson).configuration).toBe("present");

    const atLimit = padToUtf8Bytes(semanticJson, MAX_CONFIGURATION_BYTES);
    expect(encoder.encode(atLimit).byteLength).toBe(MAX_CONFIGURATION_BYTES);
    expect(readLegacyStatus(vars, atLimit).configuration).toBe("present");

    const document = JSON.parse(semanticJson) as SemanticDocument;
    const withUnknownField = JSON.stringify({ ...document, unexpected_semantic_field: true });
    expect(readLegacyStatus(vars, withUnknownField).invalid_fields).toContain(SEMANTIC_JSON_FIELD);

    const overLimit = padToUtf8Bytes(semanticJson, MAX_CONFIGURATION_BYTES + 1);
    expect(encoder.encode(overLimit).byteLength).toBe(MAX_CONFIGURATION_BYTES + 1);
    expect(readLegacyStatus(vars, overLimit).invalid_fields).toContain(SEMANTIC_JSON_FIELD);
  });
});
