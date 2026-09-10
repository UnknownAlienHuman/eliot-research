PRAGMA foreign_keys = ON;

CREATE TABLE schema_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO schema_state(key, value, updated_at)
VALUES ('schema_generation', 'core-v1', '2026-08-28T00:00:00Z');

CREATE TABLE source_namespace_ownership (
  source_namespace_id TEXT NOT NULL,
  ownership_record_revision INTEGER NOT NULL CHECK (ownership_record_revision > 0),
  owner_system_id TEXT NOT NULL,
  owner_incarnation_ref TEXT NOT NULL,
  source_owner_generation TEXT NOT NULL,
  source_admission_policy_revision INTEGER NOT NULL CHECK (source_admission_policy_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','CUTOVER_PREPARED','FENCED','RETIRED')),
  cutover_receipt_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_namespace_id, ownership_record_revision)
) STRICT;
CREATE UNIQUE INDEX one_active_owner_per_namespace
  ON source_namespace_ownership(source_namespace_id)
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX owner_generation_unique
  ON source_namespace_ownership(source_namespace_id, source_owner_generation);

CREATE TABLE source (
  source_id TEXT PRIMARY KEY,
  source_namespace_id TEXT NOT NULL,
  source_owner_system_id TEXT NOT NULL,
  source_owner_generation TEXT NOT NULL,
  ownership_mode TEXT NOT NULL CHECK (ownership_mode IN ('erc_owned','federated_reference','immutable_import','ownership_cutover')),
  kind TEXT NOT NULL,
  origin_uri TEXT,
  title TEXT NOT NULL,
  default_storage_policy TEXT NOT NULL,
  default_residency_profile_id TEXT NOT NULL,
  source_class TEXT NOT NULL,
  license_policy_ref TEXT NOT NULL,
  default_retention_policy_id TEXT NOT NULL,
  head_rev TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX source_namespace_idx ON source(source_namespace_id);
CREATE INDEX source_class_idx ON source(source_class);

CREATE TABLE source_revision (
  source_revision_ref TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(source_id),
  source_owner_generation TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  object_residency_key_digest TEXT NOT NULL CHECK (length(object_residency_key_digest) = 64),
  original_r2_key TEXT,
  normalized_artifact_ref TEXT,
  captured_at TEXT NOT NULL,
  parser_profile_generation TEXT,
  quality_state TEXT NOT NULL CHECK (quality_state IN ('high_fidelity','standard','degraded','unqualified')),
  purge_state TEXT NOT NULL CHECK (purge_state IN ('LIVE','QUARANTINED','PURGE_REQUESTED','REDACTED','RETENTION_BLOCKED')),
  currentness_state TEXT NOT NULL DEFAULT 'unknown' CHECK (currentness_state IN ('current_confirmed','observed_with_age','gap_detected','unknown')),
  source_view_ref TEXT NOT NULL,
  workspace_view_revision_ref TEXT,
  admitted_at TEXT NOT NULL
) STRICT;
CREATE INDEX source_revision_source_idx ON source_revision(source_id, captured_at DESC);
CREATE INDEX source_revision_residency_idx ON source_revision(object_residency_key_digest, content_sha256);
CREATE INDEX source_revision_live_idx ON source_revision(source_id) WHERE purge_state = 'LIVE';

CREATE TABLE source_readiness (
  source_revision_ref TEXT NOT NULL REFERENCES source_revision(source_revision_ref),
  channel TEXT NOT NULL CHECK (channel IN ('captured','normalized','structure_qualified','exact_ready','lexical_ready','semantic_ready','sourcecard_ready','atlas_included','distillates_ready','wiki_published')),
  state TEXT NOT NULL CHECK (state IN ('not_requested','queued','running','ready','degraded','failed','stale','redacted')),
  generation TEXT,
  reason_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reason_codes_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_revision_ref, channel)
) STRICT;

CREATE TABLE project (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  default_disclosure TEXT NOT NULL,
  retention_policy_ref TEXT NOT NULL,
  default_source_policy_ref TEXT NOT NULL,
  default_model_profile_ref TEXT NOT NULL,
  default_depth_profile_ref TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_source_membership (
  project_id TEXT NOT NULL REFERENCES project(project_id),
  source_id TEXT NOT NULL REFERENCES source(source_id),
  role TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
  PRIMARY KEY(project_id, source_id, valid_from)
) STRICT;
CREATE INDEX membership_active_project_idx ON project_source_membership(project_id, source_id) WHERE valid_to IS NULL;
CREATE INDEX membership_active_source_idx ON project_source_membership(source_id, project_id) WHERE valid_to IS NULL;

CREATE TABLE source_tag (
  source_id TEXT NOT NULL REFERENCES source(source_id),
  tag TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  PRIMARY KEY(source_id, tag, valid_from)
) STRICT;
CREATE INDEX source_tag_active_idx ON source_tag(tag, source_id) WHERE valid_to IS NULL;

CREATE TABLE scope_snapshot (
  snapshot_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  resolved_scope_expression_json TEXT NOT NULL CHECK (json_valid(resolved_scope_expression_json)),
  participant_generations_json TEXT NOT NULL CHECK (json_valid(participant_generations_json)),
  member_source_revision_refs_json TEXT NOT NULL CHECK (json_valid(member_source_revision_refs_json)),
  source_owner_generations_json TEXT NOT NULL CHECK (json_valid(source_owner_generations_json)),
  policy_authority_ref TEXT NOT NULL,
  disclosure_closure_digest TEXT NOT NULL CHECK (length(disclosure_closure_digest) = 64),
  purge_ledger_revision INTEGER NOT NULL CHECK (purge_ledger_revision >= 0),
  client_fence_ref TEXT,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  PRIMARY KEY(snapshot_id, revision)
) STRICT;
CREATE UNIQUE INDEX scope_snapshot_digest_unique ON scope_snapshot(snapshot_digest);

CREATE TABLE evidence_handle (
  handle_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_namespace_id TEXT NOT NULL,
  source_owner_generation TEXT NOT NULL,
  source_revision_ref TEXT NOT NULL REFERENCES source_revision(source_revision_ref),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL,
  anchor_json TEXT NOT NULL CHECK (json_valid(anchor_json)),
  excerpt_sha256 TEXT NOT NULL CHECK (length(excerpt_sha256) = 64),
  excerpt_byte_length INTEGER NOT NULL CHECK (excerpt_byte_length >= 0),
  coordinate_map_ref TEXT,
  loss_map_ref TEXT,
  object_residency_key_digest TEXT NOT NULL CHECK (length(object_residency_key_digest) = 64),
  source_assurance_ceiling TEXT NOT NULL,
  materializer_assurance_ceiling TEXT NOT NULL,
  terminal_state TEXT NOT NULL CHECK (terminal_state IN ('LIVE','STALE','COLD_RESTORABLE','REDACTED','RETENTION_BLOCKED','BROKEN_INTEGRITY')),
  invalidation_ref TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY(handle_id, revision),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision) REFERENCES scope_snapshot(snapshot_id, revision)
) STRICT;
CREATE INDEX evidence_source_idx ON evidence_handle(source_revision_ref, terminal_state);
CREATE INDEX evidence_scope_idx ON evidence_handle(scope_snapshot_id, scope_snapshot_revision);

CREATE TABLE operation_intent (
  intent_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation_kind TEXT NOT NULL,
  principal_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  policy_decision_ref TEXT NOT NULL,
  budget_reservation_ref TEXT,
  cancellation_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(intent_id, revision),
  UNIQUE(operation_kind, idempotency_key)
) STRICT;

CREATE TABLE operation_attempt (
  attempt_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  state TEXT NOT NULL CHECK (state IN ('STARTED','CHECKPOINTED','SUCCEEDED','FAILED','CANCELLED')),
  checkpoint_ref TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY(intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision),
  UNIQUE(intent_id, intent_revision, attempt_number)
) STRICT;

CREATE TABLE operation_receipt (
  receipt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES operation_attempt(attempt_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','DUPLICATE','SUCCEEDED','PARTIAL','FAILED','CANCELLED','BLOCKED')),
  output_refs_json TEXT NOT NULL CHECK (json_valid(output_refs_json)),
  readback_receipt_refs_json TEXT NOT NULL CHECK (json_valid(readback_receipt_refs_json)),
  reconciliation_required INTEGER NOT NULL CHECK (reconciliation_required IN (0,1)),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(receipt_id, revision),
  FOREIGN KEY(intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision)
) STRICT;

CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  topic TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','LEASED','SENT','FAILED','DEAD_LETTERED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  queue_message_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision)
) STRICT;
CREATE INDEX outbox_claim_idx ON outbox(state, next_attempt_at, lease_until);

CREATE TABLE job (
  job_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACCEPTED','RUNNING','PARTIAL','BLOCKED','CANCELLED','COMPLETED','FAILED')),
  current_stage TEXT,
  progress_cursor TEXT,
  workflow_instance_id TEXT,
  terminal_receipt_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision)
) STRICT;
CREATE INDEX job_state_idx ON job(state, updated_at);

CREATE TABLE investigation (
  investigation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  goal TEXT NOT NULL,
  intended_artifact TEXT NOT NULL,
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL,
  inquiry_protocol_id TEXT NOT NULL,
  inquiry_protocol_revision INTEGER NOT NULL,
  evidence_grade TEXT NOT NULL CHECK (evidence_grade IN ('E0','E1','E2','E3')),
  execution_product TEXT NOT NULL,
  model_profile_ref TEXT NOT NULL,
  budget_ref TEXT NOT NULL,
  stop_rule_ref TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  terminal_disposition TEXT,
  event_head INTEGER NOT NULL DEFAULT 0 CHECK (event_head >= 0),
  parent_investigation_id TEXT,
  parent_investigation_revision INTEGER,
  manifest_r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(investigation_id, revision),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision) REFERENCES scope_snapshot(snapshot_id, revision)
) STRICT;
CREATE INDEX investigation_active_idx ON investigation(investigation_id, revision DESC);

CREATE TABLE investigation_event (
  investigation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(investigation_id, sequence)
) STRICT;

CREATE TABLE investigation_checkpoint (
  investigation_id TEXT NOT NULL,
  investigation_revision INTEGER NOT NULL,
  stage TEXT NOT NULL,
  checkpoint_ref TEXT NOT NULL,
  input_manifest_ref TEXT NOT NULL,
  output_manifest_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  budget_receipt_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(investigation_id, investigation_revision, stage, checkpoint_ref),
  FOREIGN KEY(investigation_id, investigation_revision) REFERENCES investigation(investigation_id, revision)
) STRICT;

CREATE TABLE evidence_freeze (
  freeze_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  investigation_id TEXT NOT NULL,
  investigation_revision INTEGER NOT NULL,
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL,
  coverage_denominator_ref TEXT NOT NULL,
  contract_protocol_digest TEXT NOT NULL CHECK (length(contract_protocol_digest) = 64),
  lane_digest TEXT NOT NULL CHECK (length(lane_digest) = 64),
  manifest_r2_key TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  superseded_at TEXT,
  PRIMARY KEY(freeze_id, revision),
  FOREIGN KEY(investigation_id, investigation_revision) REFERENCES investigation(investigation_id, revision)
) STRICT;

CREATE TABLE claim_audit (
  audit_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  investigation_id TEXT NOT NULL,
  investigation_revision INTEGER NOT NULL,
  evidence_freeze_id TEXT NOT NULL,
  evidence_freeze_revision INTEGER NOT NULL,
  manifest_r2_key TEXT NOT NULL,
  material_claim_count INTEGER NOT NULL CHECK (material_claim_count >= 0),
  failed_claim_count INTEGER NOT NULL CHECK (failed_claim_count >= 0),
  unresolved_precision_count INTEGER NOT NULL CHECK (unresolved_precision_count >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(audit_id, revision)
) STRICT;

CREATE TABLE coverage_receipt (
  receipt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  investigation_id TEXT NOT NULL,
  investigation_revision INTEGER NOT NULL,
  denominator_kind TEXT NOT NULL CHECK (denominator_kind IN ('complete_scope','sampled_with_method','unknown')),
  eligible_count INTEGER NOT NULL CHECK (eligible_count >= 0),
  represented_count INTEGER NOT NULL CHECK (represented_count >= 0),
  cited_count INTEGER NOT NULL CHECK (cited_count >= 0),
  terminal_disposition TEXT NOT NULL,
  manifest_r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(receipt_id, revision)
) STRICT;

CREATE TABLE artifact_revision (
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  kind TEXT NOT NULL,
  spec_digest TEXT NOT NULL CHECK (length(spec_digest) = 64),
  evidence_freeze_id TEXT NOT NULL,
  evidence_freeze_revision INTEGER NOT NULL,
  manifest_r2_key TEXT NOT NULL,
  dependency_manifest_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','PENDING_REVALIDATION','REDACTED_DEPENDENCY')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(artifact_id, revision)
) STRICT;
CREATE TABLE artifact_head (
  artifact_id TEXT PRIMARY KEY,
  head_revision INTEGER NOT NULL CHECK (head_revision > 0),
  manifest_r2_key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(artifact_id, head_revision) REFERENCES artifact_revision(artifact_id, revision)
) STRICT;

CREATE TABLE wiki_revision (
  page_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  page_type TEXT NOT NULL,
  title TEXT NOT NULL,
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL,
  body_r2_key TEXT NOT NULL,
  manifest_r2_key TEXT NOT NULL,
  coverage_receipt_id TEXT NOT NULL,
  coverage_receipt_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','PENDING_REVALIDATION','REDACTED_DEPENDENCY')),
  supersedes_revision INTEGER,
  generator_generation TEXT NOT NULL,
  reviewer_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(page_id, revision)
) STRICT;
CREATE TABLE wiki_head (
  page_id TEXT PRIMARY KEY,
  head_revision INTEGER NOT NULL CHECK (head_revision > 0),
  manifest_r2_key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(page_id, head_revision) REFERENCES wiki_revision(page_id, revision)
) STRICT;

CREATE TABLE research_debt (
  debt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  investigation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  blocking_effect TEXT NOT NULL,
  next_probe TEXT NOT NULL,
  owner_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED','WAIVED','SUPERSEDED')),
  manifest_r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(debt_id, revision)
) STRICT;
CREATE INDEX research_debt_open_idx ON research_debt(investigation_id, kind) WHERE status = 'OPEN';

CREATE TABLE budget_reservation (
  reservation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL,
  project_id TEXT,
  platform_usd REAL NOT NULL CHECK (platform_usd >= 0),
  workers_ai_usd REAL NOT NULL CHECK (workers_ai_usd >= 0),
  byok_usd REAL NOT NULL CHECK (byok_usd >= 0),
  max_total_usd REAL NOT NULL CHECK (max_total_usd >= 0),
  workflow_steps INTEGER NOT NULL CHECK (workflow_steps >= 0),
  state TEXT NOT NULL CHECK (state IN ('QUOTED','RESERVED','SETTLED','RELEASED','EXPIRED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE model_generation (
  generation_id TEXT PRIMARY KEY,
  capability_class TEXT NOT NULL,
  route_fingerprint_json TEXT NOT NULL CHECK (json_valid(route_fingerprint_json)),
  pricing_snapshot_ref TEXT NOT NULL,
  golden_set_result_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('SHADOW','ACTIVE','RETIRED','ROLLED_BACK')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT
) STRICT;

CREATE TABLE erasure_case (
  erasure_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL,
  exact_subject_refs_json TEXT NOT NULL CHECK (json_valid(exact_subject_refs_json)),
  requested_locations_json TEXT NOT NULL CHECK (json_valid(requested_locations_json)),
  completed_locations_json TEXT NOT NULL CHECK (json_valid(completed_locations_json)),
  blocked_locations_json TEXT NOT NULL CHECK (json_valid(blocked_locations_json)),
  legal_basis_ref TEXT NOT NULL,
  deadline TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, revision)
) STRICT;
CREATE TABLE purge_ledger (
  ledger_revision INTEGER PRIMARY KEY AUTOINCREMENT,
  erasure_id TEXT NOT NULL,
  non_revealing_subject_digest TEXT NOT NULL CHECK (length(non_revealing_subject_digest) = 64),
  disposition TEXT NOT NULL CHECK (disposition IN ('COMPLETE','BLOCKED')),
  receipt_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE backup_epoch (
  backup_epoch_id TEXT PRIMARY KEY,
  core_export_ref TEXT NOT NULL,
  search_projection_manifest_ref TEXT NOT NULL,
  evidence_manifest_ref TEXT NOT NULL,
  work_manifest_ref TEXT NOT NULL,
  offsite_copy_ref TEXT NOT NULL,
  purge_ledger_revision INTEGER NOT NULL,
  verification_state TEXT NOT NULL CHECK (verification_state IN ('PENDING','VERIFIED','FAILED')),
  created_at TEXT NOT NULL,
  verified_at TEXT
) STRICT;

CREATE TABLE google_exchange_connection (
  connection_id TEXT PRIMARY KEY,
  google_subject TEXT NOT NULL,
  google_email TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  encrypted_refresh_token BLOB NOT NULL,
  token_nonce BLOB NOT NULL,
  token_key_version INTEGER NOT NULL CHECK (token_key_version > 0),
  state TEXT NOT NULL CHECK (state IN ('DISCONNECTED','AUTHORIZING','ACTIVE','DEGRADED','REAUTH_REQUIRED','REVOKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE exchange_generation (
  generation_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES google_exchange_connection(connection_id),
  folder_id TEXT NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  sheet_ids_json TEXT NOT NULL CHECK (json_valid(sheet_ids_json)),
  protocol_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','draining','retired')),
  created_at TEXT NOT NULL,
  retired_at TEXT
) STRICT;
CREATE UNIQUE INDEX one_active_exchange_generation ON exchange_generation(connection_id) WHERE state = 'active';
CREATE TABLE drive_cursor (
  connection_id TEXT PRIMARY KEY REFERENCES google_exchange_connection(connection_id),
  start_page_token TEXT NOT NULL,
  last_grid_extent_json TEXT NOT NULL CHECK (json_valid(last_grid_extent_json)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  lease_owner TEXT,
  lease_until INTEGER,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE drive_observation (
  generation_id TEXT NOT NULL REFERENCES exchange_generation(generation_id),
  object_kind TEXT NOT NULL CHECK (object_kind IN ('request','payload','receipt','result')),
  object_id TEXT NOT NULL,
  idempotency_key TEXT,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  observed_row INTEGER NOT NULL CHECK (observed_row > 0),
  drive_modified_time TEXT NOT NULL,
  actor_claim TEXT,
  frozen_r2_key TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('IMPORTED','DUPLICATE_IGNORED','TRANSPORT_TAMPERED','INCOMPLETE','REJECTED')),
  imported_at TEXT NOT NULL,
  PRIMARY KEY(generation_id, object_kind, object_id, content_sha256)
) STRICT;
CREATE INDEX drive_observation_idempotency_idx ON drive_observation(generation_id, idempotency_key);

CREATE TABLE incident (
  incident_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  details_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;
CREATE TABLE health_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  deployment_generation TEXT NOT NULL,
  schema_generation TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
) STRICT;
