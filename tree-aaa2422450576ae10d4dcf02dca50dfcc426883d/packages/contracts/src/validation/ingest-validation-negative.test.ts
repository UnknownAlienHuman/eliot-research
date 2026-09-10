import { describe, expect, it } from "vitest";
import {
  IngestStorageError,
  assertIdentifier,
  assertPath,
  assertSha256,
  parseHashesDocument,
  safeHashEntries,
  validateFileSet,
  validateResidency,
} from "./ingest-validation.js";
import { objectResidencyKeyDigest, sha256Utf8 } from "./hash.js";
import { authorityFail, decodePolicyRow } from "./d1-ingest-validation.js";
import type { NormalizedBundleManifest } from "../normalized-bundle.js";
import type { ObjectResidencyKey } from "../residency.js";

const GOOD_SHA = "a".repeat(64);

function residency(): ObjectResidencyKey {
  return {
    scope_domain_id: "scope-1",
    access_domain_id: "access-1",
    confidentiality_domain_id: "conf-1",
    encryption_key_domain_id: "enc-1",
    retention_domain_id: "ret-1",
    erasure_domain_id: "era-1",
    content_digest: { algorithm: "sha256", digest: GOOD_SHA },
  };
}

function manifest(): NormalizedBundleManifest {
  return {
    protocol: "eliotr.normalized.v1",
    origin: {
      owner_system_id: "owner-1",
      source_namespace_id: "ns-1",
      source_owner_generation: "gen-1",
      source_revision_ref: "rev-1",
      source_view_ref: "view-1",
      ownership_mode: "immutable_import",
    },
    source: {
      logical_id: "src-1",
      original_name: "a.md",
      original_sha256: GOOD_SHA,
      origin_location_class: "local_only",
      mime_type: "text/markdown",
    },
    residency_and_disclosure: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "conf-1",
      encryption_key_domain_id: "enc-1",
      retention_domain_id: "ret-1",
      erasure_domain_id: "era-1",
      disclosure_ceiling: "read",
      license_policy_ref: "lic-1",
    },
    content: {
      markdown_sha256: GOOD_SHA,
      structure: "structure.json",
      mappings: undefined,
      tables: undefined,
    },
    quality: { state: "high_fidelity" },
  } as unknown as NormalizedBundleManifest;
}

describe("moved ingest validators fail closed", () => {
  it("rejects unsafe identifiers and paths", () => {
    expect(() => assertIdentifier("", "id")).toThrow(IngestStorageError);
    expect(() => assertIdentifier("../escape", "id")).toThrow(IngestStorageError);
    expect(() => assertPath("/absolute", "p")).toThrow(IngestStorageError);
    expect(() => assertPath("a/../b", "p")).toThrow(IngestStorageError);
    expect(() => assertPath("a//b", "p")).toThrow(IngestStorageError);
  });

  it("rejects malformed digests and hash maps", () => {
    expect(() => assertSha256("ABC", "d")).toThrow(IngestStorageError);
    expect(() => assertSha256(GOOD_SHA.toUpperCase(), "d")).toThrow(IngestStorageError);
    expect(() => safeHashEntries({ "a.md": GOOD_SHA }, 1024)).toThrow(IngestStorageError);
    expect(() => parseHashesDocument("not-a-hash  a.md\n")).toThrow(IngestStorageError);
    expect(() => parseHashesDocument(`${GOOD_SHA}  hashes.sha256\n`)).toThrow(IngestStorageError);
  });

  it("rejects incomplete file sets and residency mismatch", () => {
    const entries = [
      { path: "content.md", sha256: GOOD_SHA },
      { path: "manifest.json", sha256: GOOD_SHA },
      { path: "hashes.sha256", sha256: GOOD_SHA },
      { path: "structure.json", sha256: GOOD_SHA },
    ];
    expect(() => validateFileSet(manifest(), entries)).not.toThrow();
    expect(() => validateFileSet(manifest(), entries.slice(0, 2))).toThrow(IngestStorageError);
    expect(() => validateResidency(manifest(), residency())).not.toThrow();
    expect(() => validateResidency(manifest(), { ...residency(), scope_domain_id: "other" })).toThrow(
      IngestStorageError,
    );
  });

  it("rejects malformed policy rows and separates hash identities", async () => {
    expect(() =>
      decodePolicyRow({
        source_namespace_id: "",
        revision: 1,
        authorized_principal_refs_json: "[]",
        allowed_ownership_modes_json: '["immutable_import"]',
        source_class: "s",
        assurance_ceiling: "EXACT",
        instruction_taint: "CLEARED",
        allowed_effects: "READ_ONLY",
        allowed_use_json: "[]",
        disclosure_ceiling: "read",
        license_policy_ref: "lic",
        default_storage_policy: "p",
        default_residency_profile_id: "r",
        default_retention_policy_id: "t",
        minimum_quality_state: "high_fidelity",
        created_at: new Date(0).toISOString(),
      }),
    ).toThrow();
    const a = await sha256Utf8("alpha");
    const b = await sha256Utf8("beta");
    expect(a).not.toBe(b);
    const d1 = await objectResidencyKeyDigest(residency());
    const d2 = await objectResidencyKeyDigest({ ...residency(), scope_domain_id: "scope-2" });
    expect(d1).not.toBe(d2);
    expect(() => authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "nope")).toThrow();
  });
});
