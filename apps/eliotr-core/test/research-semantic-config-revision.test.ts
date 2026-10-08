import { describe, expect, it } from "vitest";
import { evidenceSha256Bytes, evidenceUtf8Bytes } from "@eliotr/cloudflare-evidence";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { ResearchSemanticConfigRevisionError } from "@eliotr/cloudflare-research";
import type { Env } from "../src/env.js";
import {
  migrateLegacySemanticConfigToRevision,
  readResearchSemanticConfigSource,
  resolveResearchSemanticConfig,
  semanticConfigCheckpointError,
} from "../src/research-semantic-config-revision.js";

const PROTOCOL_JSON = JSON.stringify({ protocol: "eliotr.research-semantic-config.v1", test: true });

function envWith(values: Record<string, string>): Env {
  return values as unknown as Env;
}

/** Stateful D1 mock: SELECT by revision_ref and INSERT ... ON CONFLICT DO NOTHING. */
function createMockDb(initial: Array<Record<string, unknown>> = []) {
  const rows = new Map<string, Record<string, unknown>>(
    initial.map((row) => [row.revision_ref as string, row]),
  );
  const db = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            first: async () => {
              if (query.includes("WHERE revision_ref=?1")) return rows.get(params[0] as string) ?? null;
              return null;
            },
            run: async () => {
              if (query.includes("INSERT INTO research_semantic_config_revision")) {
                const [revision_ref, config_sha256, config_json, byte_length, protocol, created_at, created_by_principal_ref] = params;
                if (!rows.has(revision_ref as string)) {
                  rows.set(revision_ref as string, {
                    revision_ref, config_sha256, config_json, byte_length, protocol, created_at, created_by_principal_ref,
                  });
                }
              }
              return {};
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, rows };
}

async function installRow(json: string, createdBy = "owner:test"): Promise<Record<string, unknown>> {
  const digest = await evidenceSha256Bytes(evidenceUtf8Bytes(json));
  return {
    revision_ref: `scr-${digest.slice(0, 12)}`,
    config_sha256: digest,
    config_json: json,
    byte_length: new TextEncoder().encode(json).byteLength,
    protocol: "eliotr.research-semantic-config.v1",
    created_at: "2026-10-01T00:00:00.000Z",
    created_by_principal_ref: createdBy,
  };
}

async function revisionEnv(json: string): Promise<{ env: Env; row: Record<string, unknown> }> {
  const row = await installRow(json);
  return {
    env: envWith({
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: row.revision_ref as string,
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: row.config_sha256 as string,
    }),
    row,
  };
}

describe("readResearchSemanticConfigSource", () => {
  it("classifies the revision source", async () => {
    const { env } = await revisionEnv(PROTOCOL_JSON);
    expect(readResearchSemanticConfigSource(env)).toMatchObject({ kind: "revision" });
  });

  it("classifies whole and chunked legacy sources", () => {
    expect(readResearchSemanticConfigSource(envWith({ ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: PROTOCOL_JSON })))
      .toMatchObject({ kind: "legacy" });
    expect(readResearchSemanticConfigSource(envWith({
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: PROTOCOL_JSON.slice(0, 10),
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: PROTOCOL_JSON.slice(10),
    }))).toMatchObject({ kind: "legacy" });
  });

  it("classifies absent and partial-chunk sources as absent", () => {
    expect(readResearchSemanticConfigSource(envWith({}))).toMatchObject({ kind: "absent" });
    expect(readResearchSemanticConfigSource(envWith({ ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: "abc" })))
      .toMatchObject({ kind: "absent" });
  });

  it("rejects mixed revision and legacy sources", async () => {
    const { env } = await revisionEnv(PROTOCOL_JSON);
    const mixed = envWith({ ...(env as unknown as Record<string, string>), ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: PROTOCOL_JSON });
    let error: unknown;
    try {
      readResearchSemanticConfigSource(mixed);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ResearchSemanticConfigRevisionError);
    expect((error as ResearchSemanticConfigRevisionError).code).toBe("SEMANTIC_CONFIG_SOURCE_AMBIGUOUS");
  });

  it("rejects a partial revision identity", () => {
    for (const values of [
      { ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: "scr-abc123def456" },
      { ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: "a".repeat(64) },
    ]) {
      let error: unknown;
      try {
        readResearchSemanticConfigSource(envWith(values));
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(ResearchSemanticConfigRevisionError);
      expect((error as ResearchSemanticConfigRevisionError).code).toBe("SEMANTIC_CONFIG_SOURCE_AMBIGUOUS");
    }
  });

  it("rejects a malformed revision identity", () => {
    let error: unknown;
    try {
      readResearchSemanticConfigSource(envWith({
        ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: "bogus",
        ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: "a".repeat(64),
      }));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ResearchSemanticConfigRevisionError);
    expect((error as ResearchSemanticConfigRevisionError).code).toBe("SEMANTIC_CONFIG_REVISION_INPUT_INVALID");
  });
});

describe("resolveResearchSemanticConfig", () => {
  it("resolves verified bytes with revision provenance", async () => {
    const { env, row } = await revisionEnv(PROTOCOL_JSON);
    const { db } = createMockDb([row]);
    const resolved = await resolveResearchSemanticConfig({ env, database: db });
    expect(resolved.config_json).toBe(PROTOCOL_JSON);
    expect(resolved.revision_ref).toBe(row.revision_ref);
    expect(resolved.config_sha256).toBe(row.config_sha256);
  });

  it("fails closed when the environment digest disagrees with storage", async () => {
    const { row } = await revisionEnv(PROTOCOL_JSON);
    const { db } = createMockDb([row]);
    const tampered = envWith({
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: row.revision_ref as string,
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: "0".repeat(64),
    });
    await expect(resolveResearchSemanticConfig({ env: tampered, database: db }))
      .rejects.toMatchObject({ code: "SEMANTIC_CONFIG_REVISION_CONFLICT" });
  });

  it("fails closed for an unknown revision reference", async () => {
    const { env } = await revisionEnv(PROTOCOL_JSON);
    const { db } = createMockDb([]);
    await expect(resolveResearchSemanticConfig({ env, database: db }))
      .rejects.toMatchObject({ code: "SEMANTIC_CONFIG_REVISION_UNRESOLVED" });
  });

  it("fails closed when stored bytes fail their digest readback", async () => {
    const row = await installRow(PROTOCOL_JSON);
    row.config_sha256 = "f".repeat(64);
    const { db } = createMockDb([row]);
    const env = envWith({
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: row.revision_ref as string,
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: row.config_sha256 as string,
    });
    await expect(resolveResearchSemanticConfig({ env, database: db }))
      .rejects.toMatchObject({ code: "SEMANTIC_CONFIG_REVISION_CONFLICT" });
  });

  it("resolves the legacy source with a null revision", async () => {
    const env = envWith({ ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: PROTOCOL_JSON });
    const { db } = createMockDb([]);
    const resolved = await resolveResearchSemanticConfig({ env, database: db });
    expect(resolved.config_json).toBe(PROTOCOL_JSON);
    expect(resolved.revision_ref).toBeNull();
    expect(resolved.config_sha256).toBe(await evidenceSha256Bytes(evidenceUtf8Bytes(PROTOCOL_JSON)));
  });

  it("fails closed when nothing is configured or sources are mixed", async () => {
    const { db } = createMockDb([]);
    await expect(resolveResearchSemanticConfig({ env: envWith({}), database: db }))
      .rejects.toMatchObject({ code: "SEMANTIC_CONFIG_SOURCE_ABSENT" });
    const { env } = await revisionEnv(PROTOCOL_JSON);
    const mixed = envWith({ ...(env as unknown as Record<string, string>), ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: PROTOCOL_JSON });
    await expect(resolveResearchSemanticConfig({ env: mixed, database: db }))
      .rejects.toMatchObject({ code: "SEMANTIC_CONFIG_SOURCE_AMBIGUOUS" });
  });
});

describe("migrateLegacySemanticConfigToRevision", () => {
  it("installs the legacy source as one immutable revision", async () => {
    const env = envWith({ ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: PROTOCOL_JSON });
    const { db, rows } = createMockDb([]);
    const receipt = await migrateLegacySemanticConfigToRevision({
      env, database: db, created_by_principal_ref: "owner:migrator",
    });
    expect(receipt.created).toBe(true);
    expect(receipt.revision_ref).toMatch(/^scr-[0-9a-f]{12}$/);
    expect(receipt.config_sha256).toBe(await evidenceSha256Bytes(evidenceUtf8Bytes(PROTOCOL_JSON)));
    expect(rows.get(receipt.revision_ref)?.created_by_principal_ref).toBe("owner:migrator");

    // Resolving through the new identity returns the same bytes.
    const switched = envWith({
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: receipt.revision_ref,
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: receipt.config_sha256,
    });
    const resolved = await resolveResearchSemanticConfig({ env: switched, database: db });
    expect(resolved.config_json).toBe(PROTOCOL_JSON);
  });

  it("is idempotent when the revision identity is already configured", async () => {
    const { env, row } = await revisionEnv(PROTOCOL_JSON);
    const { db } = createMockDb([row]);
    const receipt = await migrateLegacySemanticConfigToRevision({
      env, database: db, created_by_principal_ref: "owner:migrator",
    });
    expect(receipt).toMatchObject({ revision_ref: row.revision_ref, config_sha256: row.config_sha256, created: false });
  });

  it("refuses to migrate an absent source", async () => {
    const { db } = createMockDb([]);
    await expect(migrateLegacySemanticConfigToRevision({
      env: envWith({}), database: db, created_by_principal_ref: "owner:migrator",
    })).rejects.toMatchObject({ code: "SEMANTIC_CONFIG_SOURCE_ABSENT" });
  });
});

describe("semanticConfigCheckpointError", () => {
  it("maps absent to MISSING and everything else to INVALID", () => {
    expect(semanticConfigCheckpointError(
      new ResearchSemanticConfigRevisionError("SEMANTIC_CONFIG_SOURCE_ABSENT", "x")).code)
      .toBe("WORKFLOW_CONFIGURATION_MISSING");
    expect(semanticConfigCheckpointError(
      new ResearchSemanticConfigRevisionError("SEMANTIC_CONFIG_SOURCE_AMBIGUOUS", "x")).code)
      .toBe("WORKFLOW_CONFIGURATION_INVALID");
    expect(semanticConfigCheckpointError(
      new ResearchSemanticConfigRevisionError("SEMANTIC_CONFIG_REVISION_CONFLICT", "x")).code)
      .toBe("WORKFLOW_CONFIGURATION_INVALID");
    expect(semanticConfigCheckpointError(new Error("boom")).code).toBe("WORKFLOW_CONFIGURATION_INVALID");
  });

  it("passes WorkflowCheckpointError through untouched", () => {
    const original = new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_MISSING");
    expect(semanticConfigCheckpointError(original)).toBe(original);
  });
});
