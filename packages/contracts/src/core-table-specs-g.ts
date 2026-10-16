import type { TableSpec } from "./backup-table-spec-types.js";

// Exact owner-selected catalog model authority. The provider alias is metadata only;
// no provider secret or secret-store identifier is stored or exported here.
export const DURABLE_CORE_TABLE_SPECS_G: readonly TableSpec[] = [
  { manifest: "heads", table: "research_catalog_model_use_authorization",
    order_by: "owner_id, project_id, operation_id", columns: {
      owner_id: "text", project_id: "text", operation_id: "text", provider_id: "text",
      provider_operation_id: "text-or-null", route_provider_id: "text", model_id: "text",
      account_id: "text-or-null", gateway_id: "text-or-null", alias: "text-or-null",
      provider_config_id: "text-or-null", configuration_metadata_sha256: "text-or-null",
      request_sha256: "text", owner_credential_generation: "text", project_generation: "int",
      deployment_generation: "text", expected_selection_revision: "int-or-null",
      source_configuration_ref: "text-or-null", source_configuration_sha256: "text-or-null",
      state: "text", phase: "text", selected_configuration_ref: "text-or-null",
      selected_configuration_sha256: "text-or-null", selection_revision: "int-or-null",
      failure_code: "text-or-null", created_at: "text", updated_at: "text",
    }, required: true },
  { manifest: "generations", table: "provider_native_model_catalog_v2_evidence",
    order_by: "owner_ref, project_id, consent_operation_id, stage", columns: {
      owner_ref: "text", project_id: "text", consent_operation_id: "text", stage: "text",
      provider_id: "text", provider_slug: "text", provider_operation_id: "text", model_id: "text",
      alias: "text", provider_config_id: "text", configuration_metadata_sha256: "text", request_sha256: "text",
      pricing_snapshot_ref: "text", pricing_snapshot_sha256: "text", preparation_ref: "text",
      preparation_sha256: "text", preparation_json: "text", state: "text",
      observation_ref: "text-or-null", observation_sha256: "text-or-null", observation_json: "text-or-null",
      request_body_base64: "text-or-null", response_body_base64: "text-or-null",
      candidate_ref: "text-or-null", candidate_sha256: "text-or-null", candidate_json: "text-or-null",
      qualification_ref: "text-or-null", qualification_sha256: "text-or-null", qualification_json: "text-or-null",
      created_at: "text", updated_at: "text",
    }, required: true },
  { manifest: "generations", table: "provider_native_model_catalog_v2_revocation",
    order_by: "owner_ref, project_id, qualification_ref, qualification_sha256", columns: {
      owner_ref: "text", project_id: "text", consent_operation_id: "text", stage: "text",
      qualification_ref: "text", qualification_sha256: "text", revoked_by: "text", reason: "text", revoked_at: "text",
    }, required: true },
];
