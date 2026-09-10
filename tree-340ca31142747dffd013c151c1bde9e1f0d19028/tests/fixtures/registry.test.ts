import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const fixturesDir = dirname(fileURLToPath(import.meta.url));

function lfSha256(text: string): string {
  return createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

describe("fixture registry", () => {
  it("pins contract fixtures by LF SHA-256 and tracks the golden generation", async () => {
    const registry = JSON.parse(await readFile(join(fixturesDir, "registry.json"), "utf8"));
    expect(registry.protocol).toBe("eliotr.fixture-registry.v1");
    expect(registry.fixtures.length).toBe(2);
    for (const entry of registry.fixtures) {
      const text = await readFile(join(fixturesDir, entry.path), "utf8");
      expect(lfSha256(text)).toBe(entry.sha256);
    }
    const goldenManifest = JSON.parse(await readFile(join(fixturesDir, "../golden-corpus/manifest.json"), "utf8"));
    expect(goldenManifest.generation).toBe(registry.golden_corpus.generation);
    expect(goldenManifest.protocol).toBe("eliotr.golden-corpus.v1");
  });

  it("rejects unknown fixture kinds without breaking offline determinism", async () => {
    const registry = JSON.parse(await readFile(join(fixturesDir, "registry.json"), "utf8"));
    for (const entry of registry.fixtures) {
      expect(["contract"]).toContain(entry.kind);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
