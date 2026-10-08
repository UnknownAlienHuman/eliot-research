import { describe, expect, it } from "vitest";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import {
  projectWorkspaceMcpEnvironment,
  type WorkspaceMcpEnvironmentSource,
} from "./workspace-mcp-env.js";

describe("projectWorkspaceMcpEnvironment", () => {
  it("copies the explicit MCP field set into a detached top-level object", () => {
    const source = {
      CORE_DB: {} as D1Database,
      SEARCH_DB: {} as D1Database,
      EVIDENCE_BUCKET: {} as R2Bucket,
      WORK_BUCKET: {} as R2Bucket,
      JOB_QUEUE: {} as Queue<unknown>,
      RESEARCH_SESSION: {} as DurableObjectNamespace,
      RESEARCH_WORKFLOW: {} as Workflow,
      AI_SEARCH: {} as AiSearchNamespaceLike,
      AI: { marker: "ai-binding" },
      METRICS: {} as AnalyticsEngineDataset,
      ASSETS: {} as Fetcher,
      ENVIRONMENT: "production" as const,
      DEPLOYMENT_GENERATION: "generation-a",
      AI_GATEWAY_REASONING_URL: "https://gateway.example/reasoning",
      AI_GATEWAY_RETRIEVAL_URL: "https://gateway.example/retrieval",
      ELIOTR_MODEL_GATEWAY_TOKEN: "gateway-token",
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "{}",
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "model-profile-v1",
      ELIOTR_MODEL_SPEND_POLICY_JSON: "{}",
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "spend-policy-v1",
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: "{}",
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "report-policy-v1",
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: "semantic-config-v1",
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: "a".repeat(64),
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: "{}",
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: undefined,
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: undefined,
      ACCESS_AUDIENCE: "owner-audience",
      GOOGLE_EXTERNAL_TRANSPORT: "disabled" as const,
      MCP_HOSTNAME: "mcp.example",
      MCP_ACCESS_AUTH_PROFILE: "managed-oauth" as const,
      MCP_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      MCP_ACCESS_AUDIENCE: undefined,
      MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: undefined,
      MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: ["client-a"],
      BACKUP_PARTS_BUCKET: {} as R2Bucket,
      VERSION_METADATA: {},
      GOOGLE_CLIENT_SECRET: "must-not-copy",
    } satisfies WorkspaceMcpEnvironmentSource<{ readonly marker: string }> & {
      readonly BACKUP_PARTS_BUCKET: R2Bucket;
      readonly VERSION_METADATA: object;
      readonly GOOGLE_CLIENT_SECRET: string;
    };

    const projected = projectWorkspaceMcpEnvironment(source);

    expect(projected).not.toBe(source);
    expect(projected.CORE_DB).toBe(source.CORE_DB);
    expect(projected.AI_SEARCH).toBe(source.AI_SEARCH);
    expect(projected.DEPLOYMENT_GENERATION).toBe("generation-a");
    expect(projected.MCP_ACCESS_AUDIENCE).toBeUndefined();
    expect(Object.hasOwn(projected, "MCP_ACCESS_AUDIENCE")).toBe(true);
    source.DEPLOYMENT_GENERATION = "generation-b";
    expect(projected.DEPLOYMENT_GENERATION).toBe("generation-a");
    expect("BACKUP_PARTS_BUCKET" in projected).toBe(false);
    expect("VERSION_METADATA" in projected).toBe(false);
    expect("GOOGLE_CLIENT_SECRET" in projected).toBe(false);
    expect(Object.keys(projected).sort()).toEqual([
      "ACCESS_AUDIENCE",
      "AI",
      "AI_GATEWAY_REASONING_URL",
      "AI_GATEWAY_RETRIEVAL_URL",
      "AI_SEARCH",
      "ASSETS",
      "CORE_DB",
      "DEPLOYMENT_GENERATION",
      "ELIOTR_MODEL_GATEWAY_TOKEN",
      "ELIOTR_MODEL_PROFILE_DEFINITION_JSON",
      "ELIOTR_MODEL_PROFILE_PROVENANCE_REF",
      "ELIOTR_MODEL_SPEND_POLICY_JSON",
      "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF",
      "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
      "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF",
      "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON",
      "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0",
      "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1",
      "ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF",
      "ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256",
      "ENVIRONMENT",
      "EVIDENCE_BUCKET",
      "GOOGLE_EXTERNAL_TRANSPORT",
      "JOB_QUEUE",
      "MCP_ACCESS_AUDIENCE",
      "MCP_ACCESS_AUTH_PROFILE",
      "MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID",
      "MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS",
      "MCP_ACCESS_TEAM_DOMAIN",
      "MCP_HOSTNAME",
      "METRICS",
      "RESEARCH_SESSION",
      "RESEARCH_WORKFLOW",
      "SEARCH_DB",
      "WORK_BUCKET",
    ]);
  });
});
