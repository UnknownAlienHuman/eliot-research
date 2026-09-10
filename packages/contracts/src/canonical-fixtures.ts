import {
  COORDINATE_MAP_PROTOCOL,
} from "./coordinate-map.js";
import {
  NORMALIZED_BUNDLE_CANONICAL_BODY_SHA256,
  NORMALIZED_BUNDLE_PROTOCOL,
} from "./normalized-bundle.js";
import {
  SOURCE_OWNER_CUTOVER_CANONICAL_BODY_SHA256,
  SOURCE_OWNER_CUTOVER_PROTOCOL,
} from "./owner-cutover.js";
import {
  CANONICAL_FIXTURE_REGISTRY_PROTOCOL,
  CanonicalFixtureRegistryDocumentSchema,
} from "./registry-contracts.js";
import { CONTRACT_SCHEMA_REGISTRY_GENERATION } from "./schema-registry.js";

export const CANONICAL_FIXTURE_REGISTRY =
  CanonicalFixtureRegistryDocumentSchema.parse({
    protocol: CANONICAL_FIXTURE_REGISTRY_PROTOCOL,
    registry_generation: CONTRACT_SCHEMA_REGISTRY_GENERATION,
    fixtures: [
      {
        fixture_id: "coordinate-map-v1",
        protocol: COORDINATE_MAP_PROTOCOL,
        schema_export: "CoordinateMapSchema",
        fixture_path:
          "tests/fixtures/contracts/eliotr.coordinate-map.v1.json",
        media_type: "application/json",
        canonical_body_sha256:
          "2f061e1653833e7d111b901174f0fe86a8863ee39b67524a5911b3bba7f13e54",
      },
      {
        fixture_id: "library-readiness-v1",
        protocol: "eliotr.library-readiness.v1",
        schema_export: "LibraryReadinessSchema",
        fixture_path: "tests/fixtures/contracts/eliotr.library-readiness.v1.json",
        media_type: "application/json",
        canonical_body_sha256:
          "88967c62c196dbb7f0babd89236830eb432e33ded20b539c1f78a3e4abce94f6",
      },
      {
        fixture_id: "normalized-bundle-v1",
        protocol: NORMALIZED_BUNDLE_PROTOCOL,
        schema_export: "NormalizedBundleManifestSchema",
        fixture_path:
          "tests/fixtures/contracts/eliotr.normalized.v1.yaml",
        media_type: "application/yaml",
        canonical_body_sha256: NORMALIZED_BUNDLE_CANONICAL_BODY_SHA256,
      },
      {
        fixture_id: "source-owner-cutover-v1",
        protocol: SOURCE_OWNER_CUTOVER_PROTOCOL,
        schema_export: "SourceOwnerCutoverReceiptSchema",
        fixture_path:
          "tests/fixtures/contracts/source.owner-cutover.v1.yaml",
        media_type: "application/yaml",
        canonical_body_sha256:
          SOURCE_OWNER_CUTOVER_CANONICAL_BODY_SHA256,
      },
    ],
  });
