/// <reference types="vite/client" />
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import migration0097 from "../../../infra/d1/core/migrations/0097_research_semantic_config_revision.sql?raw";
import {
  createResearchSemanticConfigRevisionStore,
  deriveResearchSemanticConfigRevisionRef,
  RESEARCH_SEMANTIC_CONFIG_PROTOCOL,
  ResearchSemanticConfigRevisionError,
} from "./research-semantic-config-revision-store.js";

/** Minimal D1Database shim over node:sqlite with real SQL semantics. */
function createD1Shim(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      const statement = db.prepare(query);
      return {
        bind(...parameters: SQLInputValue[]) {
          return {
            first: async <T,>() => {
              const row = statement.get(...parameters) as T | undefined;
              return row === undefined ? null : row;
            },
            all: async <T,>() => ({ results: (statement.all(...parameters) as T[]) ?? [] }),
            run: async () => {
              statement.run(...parameters);
              return {};
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const MIGRATION_SQL: string = migration0097;

function configJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ protocol: RESEARCH_SEMANTIC_CONFIG_PROTOCOL, ...extra });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("research semantic config revision store", () => {
  let db: DatabaseSync;
  let d1: D1Database;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(MIGRATION_SQL);
    d1 = createD1Shim(db);
  });

  it("round-trips a revision with digest readback", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    const json = configJson({ synthesis: { prompt: "x" } });
    const receipt = await store.putImmutable({ config_json: json, created_by_principal_ref: "owner:test" });
    expect(receipt.config_sha256).toBe(sha256Hex(json));
    expect(receipt.revision_ref).toBe(`scr-${receipt.config_sha256.slice(0, 12)}`);
    expect(receipt.created).toBe(true);

    const revision = await store.getRevision(receipt.revision_ref);
    expect(revision?.config_json).toBe(json);
    expect(revision?.config_sha256).toBe(receipt.config_sha256);
    expect(revision?.byte_length).toBe(new TextEncoder().encode(json).byteLength);
    expect(revision?.protocol).toBe(RESEARCH_SEMANTIC_CONFIG_PROTOCOL);
    expect(revision?.created_by_principal_ref).toBe("owner:test");
  });

  it("replays identical bytes idempotently", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    const json = configJson({ marker: "replay" });
    const first = await store.putImmutable({ config_json: json, created_by_principal_ref: "owner:a" });
    const second = await store.putImmutable({ config_json: json, created_by_principal_ref: "owner:b" });
    expect(second.created).toBe(false);
    expect(second.revision_ref).toBe(first.revision_ref);
    expect(second.config_sha256).toBe(first.config_sha256);
    expect(db.prepare("SELECT COUNT(*) AS n FROM research_semantic_config_revision").get() as { n: number }).toMatchObject({ n: 1 });
  });

  it("returns null for an unknown revision reference", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    await expect(store.getRevision("scr-0123456789ab")).resolves.toBeNull();
  });

  it("rejects malformed revision references", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    await expect(store.getRevision("nope")).rejects.toMatchObject({
      code: "SEMANTIC_CONFIG_REVISION_INPUT_INVALID",
    });
  });

  it("rejects non-JSON and wrong-protocol payloads", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    await expect(
      store.putImmutable({ config_json: "not json", created_by_principal_ref: "owner:test" }),
    ).rejects.toMatchObject({ code: "SEMANTIC_CONFIG_REVISION_INPUT_INVALID" });
    await expect(
      store.putImmutable({ config_json: JSON.stringify({ protocol: "other" }), created_by_principal_ref: "owner:test" }),
    ).rejects.toMatchObject({ code: "SEMANTIC_CONFIG_REVISION_INPUT_INVALID" });
  });

  it("rejects oversized payloads", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    const big = configJson({ pad: "x".repeat(70_000) });
    await expect(
      store.putImmutable({ config_json: big, created_by_principal_ref: "owner:test" }),
    ).rejects.toMatchObject({ code: "SEMANTIC_CONFIG_REVISION_INPUT_INVALID" });
  });

  it("fails closed when stored bytes do not match their digest (tamper)", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    const json = configJson({ marker: "tamper" });
    const digest = sha256Hex(json);
    const ref = deriveResearchSemanticConfigRevisionRef(digest);
    // Direct insert with a valid shape but a digest that does not match the bytes.
    db.prepare(
      `INSERT INTO research_semantic_config_revision
         (revision_ref,config_sha256,config_json,byte_length,protocol,created_at,created_by_principal_ref)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).run(ref, "f".repeat(64), json, new TextEncoder().encode(json).byteLength, RESEARCH_SEMANTIC_CONFIG_PROTOCOL, "2026-10-01T00:00:00Z", "owner:test");
    await expect(store.getRevision(ref)).rejects.toMatchObject({
      code: "SEMANTIC_CONFIG_REVISION_CONFLICT",
    });
  });

  it("fails closed on a reference collision with different bytes", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    const jsonA = configJson({ marker: "a" });
    const digestA = sha256Hex(jsonA);
    const ref = deriveResearchSemanticConfigRevisionRef(digestA);
    // Simulate a 48-bit reference collision: the reference is taken, but the
    // stored bytes (and digest) belong to a different payload.
    const jsonB = configJson({ marker: "b" });
    const digestB = sha256Hex(jsonB);
    db.prepare(
      `INSERT INTO research_semantic_config_revision
         (revision_ref,config_sha256,config_json,byte_length,protocol,created_at,created_by_principal_ref)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).run(ref, digestB, jsonB, new TextEncoder().encode(jsonB).byteLength, RESEARCH_SEMANTIC_CONFIG_PROTOCOL, "2026-10-01T00:00:00Z", "owner:test");
    await expect(
      store.putImmutable({ config_json: jsonA, created_by_principal_ref: "owner:test" }),
    ).rejects.toMatchObject({ code: "SEMANTIC_CONFIG_REVISION_CONFLICT" });
  });

  it("derives the short reference from the digest", () => {
    const digest = "ab".repeat(32);
    expect(deriveResearchSemanticConfigRevisionRef(digest)).toBe(`scr-${"ab".repeat(6)}`);
    expect(() => deriveResearchSemanticConfigRevisionRef("nope")).toThrow(ResearchSemanticConfigRevisionError);
  });

  it("exposes the specific error codes", async () => {
    const store = createResearchSemanticConfigRevisionStore(d1);
    const error = await store.putImmutable({ config_json: "", created_by_principal_ref: "owner:test" }).catch((e) => e);
    expect(error).toBeInstanceOf(ResearchSemanticConfigRevisionError);
    expect(error.code).toBe("SEMANTIC_CONFIG_REVISION_INPUT_INVALID");
  });
});
