PRAGMA foreign_keys = ON;

CREATE TABLE source_admission_policy (
  source_namespace_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  authorized_principal_refs_json TEXT NOT NULL CHECK (json_valid(authorized_principal_refs_json)),
  allowed_ownership_modes_json TEXT NOT NULL CHECK (json_valid(allowed_ownership_modes_json)),
  source_class TEXT NOT NULL,
  assurance_ceiling TEXT NOT NULL CHECK (assurance_ceiling IN ('UNVERIFIED','LOCATOR_ONLY','CAPTURED','QUALIFIED','EXACT')),
  instruction_taint TEXT NOT NULL CHECK (instruction_taint IN ('CLEARED','DATA_ONLY','UNTRUSTED','COMMAND_LIKE')),
  allowed_effects TEXT NOT NULL CHECK (allowed_effects IN ('READ_ONLY','CANDIDATE_ONLY','NO_EXTERNAL_EFFECT')),
  allowed_use_json TEXT NOT NULL CHECK (json_valid(allowed_use_json)),
  disclosure_ceiling TEXT NOT NULL,
  license_policy_ref TEXT NOT NULL,
  default_storage_policy TEXT NOT NULL,
  default_residency_profile_id TEXT NOT NULL,
  default_retention_policy_id TEXT NOT NULL,
  minimum_quality_state TEXT NOT NULL CHECK (minimum_quality_state IN ('high_fidelity','standard','degraded')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_namespace_id, revision)
) STRICT;

CREATE TABLE bundle_ingest_operation (
  operation_id TEXT PRIMARY KEY,
  principal_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL CHECK (
    length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  file_hashes_json TEXT NOT NULL CHECK (json_valid(file_hashes_json)),
  total_bytes INTEGER NOT NULL CHECK (total_bytes > 0),
  source_namespace_id TEXT NOT NULL,
  owner_system_id TEXT NOT NULL,
  source_owner_generation TEXT NOT NULL,
  source_revision_ref TEXT NOT NULL,
  source_id TEXT NOT NULL,
  expected_head_revision_ref TEXT,
  residency_key_digest TEXT NOT NULL CHECK (
    length(residency_key_digest) = 64 AND residency_key_digest NOT GLOB '*[^0-9a-f]*'
  ),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  policy_snapshot_json TEXT NOT NULL CHECK (json_valid(policy_snapshot_json)),
  policy_snapshot_sha256 TEXT NOT NULL CHECK (
    length(policy_snapshot_sha256) = 64 AND policy_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_id TEXT NOT NULL UNIQUE,
  staging_session_ref TEXT UNIQUE,
  qualification_report_ref TEXT,
  decision_receipt_ref TEXT,
  promotion_receipt_ref TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'PREPARING','UPLOAD_REQUIRED','VERIFIED','AUTHORIZED','PROMOTED','COMMITTED','REJECTED'
  )),
  bundle_receipt_json TEXT CHECK (bundle_receipt_json IS NULL OR json_valid(bundle_receipt_json)),
  bundle_receipt_sha256 TEXT CHECK (
    bundle_receipt_sha256 IS NULL OR (
      length(bundle_receipt_sha256) = 64 AND bundle_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (principal_ref, idempotency_key)
) STRICT;
CREATE INDEX bundle_ingest_state_idx
  ON bundle_ingest_operation(state, expires_at, updated_at);
CREATE INDEX bundle_ingest_source_revision_idx
  ON bundle_ingest_operation(source_revision_ref, state);

CREATE TABLE source_acquisition_candidate (
  candidate_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation_id TEXT NOT NULL UNIQUE REFERENCES bundle_ingest_operation(operation_id),
  observed_locator_identifier_or_upload_ref TEXT NOT NULL,
  proposer_principal_ref TEXT NOT NULL,
  proposer_run_ref TEXT,
  allowed_reference_manifest_id TEXT,
  allowed_reference_manifest_revision INTEGER,
  proposed_source_class TEXT NOT NULL,
  purpose TEXT NOT NULL,
  requested_scope_expression_json TEXT NOT NULL CHECK (json_valid(requested_scope_expression_json)),
  untrusted_metadata_json TEXT NOT NULL CHECK (json_valid(untrusted_metadata_json)),
  staging_object_ref TEXT,
  policy_refs_json TEXT NOT NULL CHECK (json_valid(policy_refs_json)),
  state TEXT NOT NULL CHECK (state IN ('OBSERVED','RESOLVING','CAPTURED','REJECTED','EXPIRED')),
  effect_ceiling TEXT NOT NULL CHECK (effect_ceiling = 'NO_EXTERNAL_EFFECT'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  terminal_receipt_ref TEXT,
  PRIMARY KEY (candidate_id, revision)
) STRICT;
CREATE INDEX source_candidate_state_idx
  ON source_acquisition_candidate(state, expires_at);

CREATE TABLE qualification_report (
  report_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation_id TEXT NOT NULL UNIQUE REFERENCES bundle_ingest_operation(operation_id),
  source_revision_ref TEXT NOT NULL,
  parser_profile_generation TEXT NOT NULL,
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  overall TEXT NOT NULL CHECK (overall IN ('QUALIFIED','DEGRADED','REJECTED')),
  exact_precision_ceiling TEXT NOT NULL CHECK (
    exact_precision_ceiling IN ('byte','line','page','bounding_box','table_cell')
  ),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  report_sha256 TEXT NOT NULL CHECK (
    length(report_sha256) = 64 AND report_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (report_id, revision)
) STRICT;

CREATE TABLE source_admission_decision (
  decision_receipt_ref TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES bundle_ingest_operation(operation_id),
  source_namespace_id TEXT NOT NULL,
  owner_system_id TEXT NOT NULL,
  source_owner_generation TEXT NOT NULL,
  source_revision_ref TEXT NOT NULL,
  origin_authentication_receipt_ref TEXT NOT NULL,
  source_class TEXT NOT NULL,
  assurance_ceiling TEXT NOT NULL CHECK (assurance_ceiling IN ('UNVERIFIED','LOCATOR_ONLY','CAPTURED','QUALIFIED','EXACT')),
  instruction_taint TEXT NOT NULL CHECK (instruction_taint IN ('CLEARED','DATA_ONLY','UNTRUSTED','COMMAND_LIKE')),
  allowed_effects TEXT NOT NULL CHECK (allowed_effects IN ('READ_ONLY','CANDIDATE_ONLY','NO_EXTERNAL_EFFECT')),
  object_residency_key_digest TEXT NOT NULL CHECK (
    length(object_residency_key_digest) = 64 AND object_residency_key_digest NOT GLOB '*[^0-9a-f]*'
  ),
  allowed_use_json TEXT NOT NULL CHECK (json_valid(allowed_use_json)),
  disclosure_ceiling TEXT NOT NULL,
  license_policy_ref TEXT NOT NULL,
  expires_at TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('ADMITTED','QUARANTINED','REJECTED')),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json)),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  decision_sha256 TEXT NOT NULL CHECK (
    length(decision_sha256) = 64 AND decision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX source_admission_revision_idx
  ON source_admission_decision(source_revision_ref, decision);

UPDATE schema_state
SET value = 'core-v5-ingest-admission', updated_at = '2026-08-31T00:00:00Z'
WHERE key = 'schema_generation';
