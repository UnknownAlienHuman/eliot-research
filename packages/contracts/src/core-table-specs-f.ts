import type { TableSpec } from "./backup-table-spec-types.js";

// Provider-key operation history and provider-native qualification provenance
// added by Core migrations 0109–0111. Current credentials and active owner
// selections remain installation-local and are not portable authority.
export const DURABLE_CORE_TABLE_SPECS_F: readonly TableSpec[] = [
  { manifest: "heads", table: "research_provider_key_configuration_operation", order_by: "owner_id, project_id, provider_id, operation_id", columns: {
    owner_id: "text", project_id: "text", provider_id: "text", operation_id: "text",
    account_id: "text", gateway_id: "text", request_sha256: "text", alias: "text", state: "text",
    provider_config_id: "text-or-null", metadata_sha256: "text-or-null", failure_code: "text-or-null",
    provider_http_status: "int-or-null", created_at: "text", updated_at: "text",
  }, required: true },
  { manifest: "heads", table: "research_provider_key_model_use_operation", order_by: "owner_id, project_id, operation_id", columns: {
    owner_id: "text", project_id: "text", provider_id: "text", operation_id: "text", key_operation_id: "text",
    account_id: "text", gateway_id: "text", alias: "text", provider_config_id: "text",
    configuration_metadata_sha256: "text", request_sha256: "text", configuration_basis_json: "text",
    owner_credential_generation: "text", project_generation: "int", deployment_generation: "text",
    deadline_at: "text", expected_selection_revision: "int-or-null", source_configuration_ref: "text-or-null",
    source_configuration_sha256: "text-or-null", planned_stage_set_sha256: "text", plan_sha256: "text",
    state: "text", phase: "text", active_stage: "text-or-null", target_configuration_ref: "text-or-null",
    target_configuration_sha256: "text-or-null", target_configuration_json: "text-or-null",
    selected_configuration_ref: "text-or-null", selection_revision: "int-or-null", failure_code: "text-or-null",
    created_at: "text", updated_at: "text",
  }, required: true },
  { manifest: "heads", table: "research_provider_key_model_use_stage_operation", order_by: "owner_id, project_id, operation_id, sequence_number", columns: {
    owner_id: "text", project_id: "text", operation_id: "text", sequence_number: "int", stage: "text",
    route_ref: "text", route_version: "text", prompt_sha256: "text", schema_sha256: "text",
    probe_prompt_sha256: "text", probe_schema_sha256: "text", probe_parameters_sha256: "text",
    parameters_sha256: "text", pricing_snapshot_ref: "text-or-null", pricing_snapshot_sha256: "text-or-null",
    preparation_ref: "text-or-null", preparation_sha256: "text-or-null", candidate_ref: "text-or-null",
    candidate_sha256: "text-or-null", qualification_ref: "text-or-null", qualification_sha256: "text-or-null",
    state: "text", failure_code: "text-or-null", created_at: "text", updated_at: "text",
  }, required: true },
  { manifest: "generations", table: "research_provider_key_model_price_observation", order_by: "owner_id, project_id, operation_id, stage", columns: {
    owner_id: "text", project_id: "text", operation_id: "text", stage: "text", key_operation_id: "text",
    account_id: "text", gateway_id: "text", alias: "text", provider_config_id: "text",
    configuration_metadata_sha256: "text", request_sha256: "text", owner_credential_generation: "text",
    project_generation: "int", deployment_generation: "text", route_ref: "text", route_version: "text",
    provider_id: "text", exact_model_id: "text", source_url: "text", observation_ref: "text",
    source_response_sha256: "text", response_base64: "text", byte_length: "int", readback_sha256: "text",
    observed_at: "text", expires_at: "text", approval_receipt_ref: "text", created_at: "text",
  }, required: true },
  { manifest: "generations", table: "provider_native_model_preparation", order_by: "preparation_ref", columns: {
    preparation_ref: "text", preparation_sha256: "text", preparation_json: "text", owner_ref: "text",
    project_id: "text", owner_operation_id: "text", stage: "text", route_ref: "text",
    route_version: "text", request_sha256: "text", created_at: "text",
  }, required: true },
  { manifest: "generations", table: "provider_native_model_qualification_attempt", order_by: "owner_ref, project_id, owner_operation_id, stage", columns: {
    owner_ref: "text", project_id: "text", owner_operation_id: "text", stage: "text", preparation_ref: "text",
    preparation_sha256: "text", state: "text", observation_ref: "text-or-null", observation_sha256: "text-or-null",
    candidate_ref: "text-or-null", candidate_sha256: "text-or-null", qualification_ref: "text-or-null",
    qualification_sha256: "text-or-null", started_at: "text", completed_at: "text-or-null",
  }, required: true },
  { manifest: "generations", table: "provider_native_model_qualification_observation", order_by: "observation_ref", columns: {
    observation_ref: "text", observation_sha256: "text", observation_json: "text",
    request_body_base64: "text", response_body_base64: "text", owner_ref: "text", project_id: "text",
    owner_operation_id: "text", stage: "text", preparation_ref: "text", preparation_sha256: "text",
    created_at: "text",
  }, required: true },
  { manifest: "generations", table: "provider_native_model_candidate", order_by: "candidate_ref", columns: {
    candidate_ref: "text", candidate_sha256: "text", candidate_json: "text", owner_ref: "text",
    project_id: "text", stage: "text", route_ref: "text", route_version: "text", preparation_ref: "text",
    preparation_sha256: "text", observation_ref: "text", observation_sha256: "text", qualification_tier: "text",
    verified_at: "text", qualification_expires_at: "text", created_at: "text",
  }, required: true },
  { manifest: "generations", table: "provider_native_model_qualification_proof", order_by: "qualification_ref", columns: {
    qualification_ref: "text", qualification_sha256: "text", qualification_json: "text", owner_ref: "text",
    project_id: "text", stage: "text", route_ref: "text", route_version: "text", candidate_ref: "text",
    candidate_sha256: "text", observation_ref: "text", observation_sha256: "text", qualification_tier: "text",
    verified_at: "text", expires_at: "text", created_at: "text",
  }, required: true },
  { manifest: "generations", table: "provider_native_model_qualification_revocation", order_by: "qualification_ref, qualification_sha256", columns: {
    qualification_ref: "text", qualification_sha256: "text", owner_ref: "text", project_id: "text",
    reason: "text", revoked_by: "text", revoked_at: "text",
  }, required: true },
];
