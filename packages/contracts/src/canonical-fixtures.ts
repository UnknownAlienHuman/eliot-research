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
import { MCP_DIAGNOSTIC_PROTOCOL } from "./mcp-diagnostic.js";
import { CONTRACT_SCHEMA_REGISTRY_GENERATION } from "./schema-registry.js";
import { RESEARCH_CATALOG_MODEL_USE_REQUEST_PROTOCOL } from "./research-catalog-model-use.js";
import { PROJECT_GUIDE_PROTOCOL } from "./project-guide.js";

export const CANONICAL_FIXTURE_REGISTRY =
  CanonicalFixtureRegistryDocumentSchema.parse({
    protocol: CANONICAL_FIXTURE_REGISTRY_PROTOCOL,
    registry_generation: CONTRACT_SCHEMA_REGISTRY_GENERATION,
    fixtures: [
      {
        fixture_id: "project-guide-request-v1",
        protocol: PROJECT_GUIDE_PROTOCOL,
        schema_export: "ProjectGuideRequestSchema",
        fixture_path: "docs/contracts/fixtures/eliotr.project-guide.request.v1.json",
        media_type: "application/json",
        canonical_body_sha256: "4faaa2558673c237530555d1f0e561640b073025938b39e27e8e638a7b401549",
      },
      {
        fixture_id: "project-guide-partial-v1",
        protocol: PROJECT_GUIDE_PROTOCOL,
        schema_export: "ProjectGuideViewSchema",
        fixture_path: "docs/contracts/fixtures/eliotr.project-guide.partial.v1.json",
        media_type: "application/json",
        canonical_body_sha256: "c875bec8035558d975755d785312c940e7a06736ca4ecbd1baf5938b994a7fa8",
      },
      {
        fixture_id: "research-catalog-model-use-tilde-v1",
        protocol: RESEARCH_CATALOG_MODEL_USE_REQUEST_PROTOCOL,
        schema_export: "ResearchCatalogModelUseRequestSchema",
        fixture_path: "docs/contracts/fixtures/eliotr.research.catalog-model-use-tilde.v1.json",
        media_type: "application/json",
        canonical_body_sha256: "ad51264c0ebd3ed9489e1b6796440e94373ad5a80699bba039974745cf2d4f5d",
      },
      {
        fixture_id: "research-catalog-model-use-request-v1",
        protocol: RESEARCH_CATALOG_MODEL_USE_REQUEST_PROTOCOL,
        schema_export: "ResearchCatalogModelUseRequestSchema",
        fixture_path: "docs/contracts/fixtures/eliotr.research.catalog-model-use-request.v1.json",
        media_type: "application/json",
        canonical_body_sha256: "a09eefe74414b993eaf546b7dd98c3983503ba998c52d1172d6ea08ff531e3fb",
      },
      {
        "fixture_id": "research-run-history-visibility-v4",
        "protocol": "eliotr.research-runs.v4",
        "schema_export": "ResearchRunHistoryVisibilitySchema",
        "fixture_path": "tests/fixtures/contracts/eliotr.research-run-history-visibility.v4.json",
        "media_type": "application/json",
        "canonical_body_sha256": "92b4a1d6e1ab8dc6ce9e1673b2ace7d7531a89be4bd1889f88d129a8fdef2a77"
      },
      {
        "fixture_id": "research-branch-reconciliation-pending-v1",
        "protocol": "eliotr.research.branch-reconciliation-pending.v1",
        "schema_export": "ResearchBranchReconciliationPendingCheckpointSchema",
        "fixture_path": "tests/fixtures/contracts/eliotr.research.branch-reconciliation-pending.v1.json",
        "media_type": "application/json",
        "canonical_body_sha256": "dcc8fd19399092a95acac1a2b8ba0f0895c792ace9181c31f245f42b8a31a872"
      },
      {
        "fixture_id": "research-branch-query-budget-exhaustion-v1",
        "protocol": "eliotr.research.branch-query-result.v1",
        "schema_export": "BranchQueryResultSchema",
        "fixture_path": "tests/fixtures/contracts/eliotr.research.branch-query-budget-exhaustion.v1.json",
        "media_type": "application/json",
        "canonical_body_sha256": "9c2e16cbbba9450c8e7bca6b1b7a012c0cd31d283c736d36d3551a37bcba219e"
      },
      {
        fixture_id: "research-session-binding-v1",
        protocol: "eliotr.research-session-binding.v1",
        schema_export: "ResearchSessionBindingDescriptorSchema",
        fixture_path: "docs/contracts/fixtures/eliotr.research-session-binding.v1.json",
        media_type: "application/json",
        canonical_body_sha256:
          "d01e543f9a8773859f6e6e937a00bd9b8d1cf7dab33e78a645299aa22f73d18d",
      },
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
        fixture_id: "workspace-mcp-plan-input-v2",
        protocol: "eliotr.google-sync.plan.v2",
        schema_export: "WorkspaceMcpPlanV2InputSchema",
        fixture_path: "tests/fixtures/contracts/eliotr.workspace-mcp-plan-input.v2.json",
        media_type: "application/json",
        canonical_body_sha256:
          "3946aea772f88011d0e131b731f7d9e49875adf349efcbd27f7e49d839d61716",
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
      {
        fixture_id: "mcp-client-diagnostic-issued-v1",
        protocol: MCP_DIAGNOSTIC_PROTOCOL,
        schema_export: "McpDiagnosticChallengeResultSchema",
        fixture_path:
          "docs/contracts/fixtures/eliotr.mcp-client-diagnostic.issued.v1.json",
        media_type: "application/json",
        canonical_body_sha256:
          "0bad253a2472409be442720c34098057586c3ca5a7a3fc76ef2b5dbac37076e6",
      },
      {
        fixture_id: "mcp-client-diagnostic-confirmed-v1",
        protocol: MCP_DIAGNOSTIC_PROTOCOL,
        schema_export: "McpDiagnosticConsumeResultSchema",
        fixture_path:
          "docs/contracts/fixtures/eliotr.mcp-client-diagnostic.confirmed.v1.json",
        media_type: "application/json",
        canonical_body_sha256:
          "ecfdb017f8c7bdb7c3d01f313a0d54d7bfe330b6e2c2125c27e8b815a0af4a83",
      },
    ],
  });
