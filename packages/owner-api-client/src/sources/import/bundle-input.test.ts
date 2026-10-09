import { describe, expect, it } from "vitest";
import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { createBundleInputApi, type BundleFile } from "./bundle-input.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";

/** Targeted boundaries for the moved bundle-input validation. */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) =>
  Object.assign(new Error(details.message), details)

const CONTENT_TEXT = "# collected notes\n";
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
}
const CONTENT_DIGEST = await digest(new TextEncoder().encode(CONTENT_TEXT));
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A manifest that passes `NormalizedBundleManifestSchema`, never a partial cast. */
const manifest = (contentDigest: string): NormalizedBundleManifest =>
  NormalizedBundleManifestSchema.parse({
    protocol: "eliotr.normalized.v1",
    origin: {
      owner_system_id: "owner-1",
      source_namespace_id: "namespace-1",
      source_owner_generation: "generation-1",
      source_revision_ref: "revision-1",
      source_view_ref: "view-1",
      ownership_mode: "immutable_import",
    },
    source: {
      logical_id: "source-1",
      original_name: "notes-and-datasheets",
      original_sha256: SHA_A,
      origin_location_class: "local_only",
      mime_type: "text/markdown",
    },
    residency_and_disclosure: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "confidentiality-1",
      encryption_key_domain_id: "encryption-1",
      retention_domain_id: "retention-1",
      erasure_domain_id: "erasure-1",
      disclosure_ceiling: "owner-only",
      allowed_use: ["owner-workspace"],
    },
    normalization: {
      analyzer: "analyzer-1",
      analyzer_version: "1.0.0",
      profile: "profile-1",
      config_hash: SHA_A,
      created_at: "2026-10-09T12:00:00.000Z",
    },
    content: {
      markdown: "content.md",
      markdown_sha256: contentDigest,
    },
    capabilities: {
      text_ranges: true,
      pages: false,
      bounding_boxes: false,
      tables: false,
      figures: false,
    },
    quality: {
      state: "high_fidelity",
      assurance_ceiling: "ceiling-1",
      warnings: [],
    },
    export: {
      purpose: "owner workspace import",
      receipt_ref: "receipt-1",
    },
  })

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

async function bundleFiles(extra: readonly BundleFile[] = []): Promise<readonly BundleFile[]> {
  const manifestBytes = encode(JSON.stringify(manifest(CONTENT_DIGEST)));
  const manifestDigest = await digest(manifestBytes);
  return [
    { path: "manifest.json", bytes: manifestBytes },
    { path: "content.md", bytes: encode(CONTENT_TEXT) },
    { path: "hashes.sha256", bytes: encode(CONTENT_DIGEST + " *content.md\n" + manifestDigest + " *manifest.json\n") },
    ...extra,
  ];
}
const api = () => createBundleInputApi({ digest, readText: bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes) }, errors);
describe("bundle input validation", () => {
  it("accepts a strict manifest, content and hash list and snapshots the bytes", async () => {
    const input = await bundleFiles()
    const result = await api().prepareBrowserBundle(input);
    expect(result.manifest.protocol).toBe("eliotr.normalized.v1");
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(Object.keys(result.hashes).sort())
      .toEqual(["content.md", "hashes.sha256", "manifest.json"])
  })

  it("rejects a folder below the minimum file count", async () => {
    const input = (await bundleFiles()).slice(0, 2)
    await expect(api().prepareBrowserBundle(input))
      .rejects.toMatchObject({ code: "BUNDLE_INPUT_INVALID", status: 400 })
  })

  it("rejects traversal, duplicate separators and dot paths before reading bytes", () => {
    const a = api()
    expect(() => a.safeBundlePath("../escape.md")).toThrow(
      expect.objectContaining({ code: "BUNDLE_INPUT_INVALID" }))
    expect(() => a.safeBundlePath("a//b.md")).toThrow(
      expect.objectContaining({ code: "BUNDLE_INPUT_INVALID" }))
    expect(() => a.safeBundlePath(".hidden.md")).toThrow(
      expect.objectContaining({ code: "BUNDLE_INPUT_INVALID" }))
    expect(a.safeBundlePath("assets/deep/report.md")).toBe("assets/deep/report.md");
  })

  it("rejects files the manifest does not declare", async () => {
    const input = await bundleFiles([{ path: "assets/unexpected.md", bytes: encode("x") }])
    await expect(api().prepareBrowserBundle(input))
      .rejects.toMatchObject({ code: "BUNDLE_INPUT_INVALID", status: 400 })
  })

  it("rejects a hash list that does not match the selected bytes", async () => {
    const input = await bundleFiles()
    const corrupted = input.map(file => file.path === "content.md" ? { ...file, bytes: encode("changed bytes") } : file);
    await expect(api().prepareBrowserBundle(corrupted))
      .rejects.toMatchObject({ code: "BUNDLE_INPUT_INVALID", status: 400 })
  })

  it("rejects a manifest that does not satisfy the strict normalized contract", async () => {
    const input = await bundleFiles()
    const renamed = input.map((file) =>
      file.path === "manifest.json"
        ? { path: file.path, bytes: encode(JSON.stringify(
            { ...manifest(CONTENT_DIGEST), origin: { owner_system_id: "owner-1" } })) }
        : file)
    await expect(api().prepareBrowserBundle(renamed))
      .rejects.toMatchObject({ code: "BUNDLE_INPUT_INVALID", status: 400 })
  })
});
