import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readFrozenGoldenExpectedCaseSet } from "./frozen-case-reader.js";

const corpusDirectory = dirname(fileURLToPath(import.meta.url));

it("requires an exact pin and refuses to reinterpret the existing V1 corpus as a V2 frozen set", async () => {
  const manifestPath = join(corpusDirectory, "manifest.json");
  const manifestBytes = new Uint8Array(await readFile(manifestPath));
  const registry = JSON.parse(await readFile(join(corpusDirectory, "../fixtures/registry.json"), "utf8")) as {
    readonly golden_corpus: { readonly generation: string };
  };
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const source = {
    manifest_path: manifestPath,
    case_directory: join(corpusDirectory, "cases"),
    pin: { generation: registry.golden_corpus.generation, manifest_sha256: manifestSha256 },
  };

  await expect(readFrozenGoldenExpectedCaseSet(source))
    .rejects.toThrow("GOLDEN_FROZEN_EXPECTED_SET_INVALID");
  await expect(readFrozenGoldenExpectedCaseSet({
    ...source,
    pin: { ...source.pin, manifest_sha256: "0".repeat(64) },
  })).rejects.toThrow("GOLDEN_FROZEN_MANIFEST_DIGEST_MISMATCH");
});
