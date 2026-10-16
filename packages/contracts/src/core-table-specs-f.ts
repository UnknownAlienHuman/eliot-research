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
  // Global service-provider connection metadata only. `alias` refers to the existing
  // Cloudflare BYOK secret; the secret value is never stored in Core or exported here.
  { manifest: "heads", table: "service_model_provider_operation", order_by: "owner_id, operation_id", columns: {
    owner_id: "text", operation_id: "text", provider_id: "text", display_name: "text",
    base_url: "text-or-null", model_ids_json: "text", request_sha256: "text", alias: "text",
    state: "text", provider_config_id: "text-or-null", provider_slug: "text-or-null",
    metadata_sha256: "text-or-null", failure_code: "text-or-null", provider_http_status: "int-or-null",
    created_at: "text", updated_at: "text", model_registration_mode: "text",
  }, required: true },
  // Owner presentation filters persist through supported backups; they carry no model-use authority.
  { manifest: "heads", table: "service_model_provider_catalog_preference", order_by: "owner_id, provider_id", columns: {
    owner_id: "text", provider_id: "text", visibility_json: "text", search_text: "text", updated_at: "text",
  }, required: true },
  // Workflow-native and authorized-read stage results are durable completion receipts.
  { manifest: "heads", table: "research_workflow_native_stage_completion", order_by: "operation_id, stage_index", columns: {
    operation_id: "text", stage_index: "int", stage: "text", request_json: "text", request_sha256: "text",
    handler_generation: "text", effect_policy_generation: "text", effect_class: "text",
    authority_policy_generation: "text", policy_authority_ref: "text", principal_ref: "text",
    credential_generation: "text", deployment_generation: "text", scope_snapshot_id: "text",
    scope_snapshot_revision: "int", authorization_receipt_ref: "text", purge_revision: "int",
    expected_revision: "int", input_manifest_json: "text", output_manifest_json: "text", receipt_json: "text",
    receipt_sha256: "text", ledger_event_id: "text", created_at: "text",
  }, required: true },
  { manifest: "heads", table: "research_workflow_authorized_read_stage_completion", order_by: "operation_id, stage_index", columns: {
    operation_id: "text", stage_index: "int", stage: "text", request_json: "text", request_sha256: "text",
    handler_generation: "text", effect_policy_generation: "text", effect_class: "text",
    authority_policy_generation: "text", policy_authority_ref: "text", principal_ref: "text",
    credential_generation: "text", deployment_generation: "text", scope_snapshot_id: "text",
    scope_snapshot_revision: "int", authorization_receipt_ref: "text", purge_revision: "int",
    expected_revision: "int", input_manifest_json: "text", output_manifest_json: "text", receipt_json: "text",
    receipt_sha256: "text", ledger_event_id: "text", created_at: "text",
  }, required: true },
  // Immutable queue receipts prevent transport replay from becoming a new business effect.
  { manifest: "heads", table: "queue_terminal_observation", order_by: "queue_name, platform_message_id", columns: {
    queue_name: "text", platform_message_id: "text", platform_attempt: "int", observed_at_ms: "int",
    disposition: "text", outbox_id: "text-or-null", original_message_json: "text-or-null",
    completed_receipt_ref: "text-or-null",
  }, required: true },
  { manifest: "heads", table: "queue_owner_replay", order_by: "queue_name, platform_message_id", columns: {
    queue_name: "text", platform_message_id: "text", outbox_id: "text", original_message_id: "text",
    replay_outbox_attempt: "int", principal_ref: "text", credential_generation: "text",
    request_key: "text", authorized_at_ms: "int",
  }, required: true },
  // Immutable per-item effect intent/readback reconciles external projection writes.
  { manifest: "heads", table: "projection_managed_item_effect", order_by: "source_revision_ref, projection_generation, item_key", columns: {
    source_revision_ref: "text", projection_generation: "text", job_id: "text", item_key: "text",
    desired_index: "int", normalized_start_byte: "int", normalized_end_byte: "int", intent_id: "text",
    intent_revision: "int", attempt_id: "text", execution_operation_id: "text",
    dispatch_lease_generation: "int-or-null", managed_instance_id: "text", managed_generation: "text",
    provider_source: "text", provider_key: "text", section_content_sha256: "text", document_sha256: "text",
    document_size_bytes: "int", metadata_json: "text", state: "text", provider_item_id: "text-or-null",
    readback_receipt_json: "text-or-null", readback_sha256: "text-or-null", created_at: "text", updated_at: "text",
  }, required: true },
  // Outbox state and external issue receipts stay with incidents to prevent duplicate deliveries.
  { manifest: "heads", table: "doctor_delivery_outbox", order_by: "delivery_id", columns: {
    delivery_id: "text", incident_id: "text", sink_ref: "text", marker: "text", state: "text",
    diagnosis_state: "text", diagnosis: "text-or-null", external_issue_number: "int-or-null",
    external_issue_url: "text-or-null", last_error_code: "text-or-null", lease_owner: "text-or-null",
    lease_until: "int-or-null", lease_generation: "int", created_at: "text", updated_at: "text",
  }, required: true },
];
