-- Owner-explicit OpenRouter key qualification, per-stage native receipts, and
-- immutable free-price observations. Provider-native candidate/proof authority
-- is separately owned by migration 0111.

CREATE TABLE research_provider_key_model_use_operation (
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  provider_id TEXT NOT NULL CHECK (provider_id = 'openrouter'),
  operation_id TEXT NOT NULL CHECK (
    length(operation_id) = 36
    AND substr(operation_id, 9, 1) = '-'
    AND substr(operation_id, 14, 1) = '-'
    AND substr(operation_id, 19, 1) = '-'
    AND substr(operation_id, 24, 1) = '-'
    AND operation_id = lower(operation_id)
    AND substr(operation_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
  ),
  key_operation_id TEXT NOT NULL CHECK (
    length(key_operation_id) = 36
    AND substr(key_operation_id, 9, 1) = '-'
    AND substr(key_operation_id, 14, 1) = '-'
    AND substr(key_operation_id, 19, 1) = '-'
    AND substr(key_operation_id, 24, 1) = '-'
    AND key_operation_id = lower(key_operation_id)
    AND substr(key_operation_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
    AND substr(key_operation_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(key_operation_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(key_operation_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(key_operation_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
  ),
  account_id TEXT NOT NULL CHECK (length(account_id) = 32 AND account_id NOT GLOB '*[^A-Fa-f0-9]*'),
  gateway_id TEXT NOT NULL CHECK (
    length(gateway_id) BETWEEN 1 AND 64 AND substr(gateway_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    gateway_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  alias TEXT NOT NULL CHECK (
    length(alias) = 55 AND substr(alias, 1, 7) = 'eliotr-' AND substr(alias, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  provider_config_id TEXT NOT NULL CHECK (
    length(provider_config_id) BETWEEN 1 AND 128 AND provider_config_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  configuration_metadata_sha256 TEXT NOT NULL CHECK (
    length(configuration_metadata_sha256) = 64 AND configuration_metadata_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_basis_json TEXT NOT NULL CHECK (length(configuration_basis_json) BETWEEN 2 AND 524288),
  owner_credential_generation TEXT NOT NULL CHECK (length(owner_credential_generation) BETWEEN 1 AND 256),
  project_generation INTEGER NOT NULL CHECK (project_generation BETWEEN 1 AND 2147483647),
  deployment_generation TEXT NOT NULL CHECK (length(deployment_generation) BETWEEN 1 AND 256),
  deadline_at TEXT NOT NULL CHECK (length(deadline_at) BETWEEN 1 AND 64),
  expected_selection_revision INTEGER CHECK (expected_selection_revision IS NULL OR expected_selection_revision BETWEEN 1 AND 999999),
  source_configuration_ref TEXT CHECK (
    source_configuration_ref IS NULL OR
    (length(source_configuration_ref) = 69 AND substr(source_configuration_ref, 1, 5) = 'rpmc-' AND
      substr(source_configuration_ref, 6) NOT GLOB '*[^0-9a-f]*')
  ),
  source_configuration_sha256 TEXT CHECK (
    source_configuration_sha256 IS NULL OR
    (length(source_configuration_sha256) = 64 AND source_configuration_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  planned_stage_set_sha256 TEXT NOT NULL CHECK (length(planned_stage_set_sha256) = 64 AND planned_stage_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','SELECTED','BLOCKED','UNCERTAIN','CONFLICT')),
  phase TEXT NOT NULL CHECK (phase IN ('INTENT','FREE_PRICE_CHECK','NATIVE_PREPARE','NATIVE_QUALIFY','CONFIGURATION_IMPORT','SELECTION_READBACK','COMPLETE')),
  active_stage TEXT CHECK (active_stage IS NULL OR active_stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  target_configuration_ref TEXT CHECK (
    target_configuration_ref IS NULL OR
    (length(target_configuration_ref) = 69 AND substr(target_configuration_ref, 1, 5) = 'rpmc-' AND
      substr(target_configuration_ref, 6) NOT GLOB '*[^0-9a-f]*')
  ),
  target_configuration_sha256 TEXT CHECK (
    target_configuration_sha256 IS NULL OR
    (length(target_configuration_sha256) = 64 AND target_configuration_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  target_configuration_json TEXT CHECK (
    target_configuration_json IS NULL OR length(target_configuration_json) BETWEEN 2 AND 262144
  ),
  selected_configuration_ref TEXT CHECK (
    selected_configuration_ref IS NULL OR
    (length(selected_configuration_ref) = 69 AND substr(selected_configuration_ref, 1, 5) = 'rpmc-' AND
      substr(selected_configuration_ref, 6) NOT GLOB '*[^0-9a-f]*')
  ),
  selection_revision INTEGER CHECK (selection_revision IS NULL OR selection_revision BETWEEN 1 AND 999999),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'NO_SELECTED_CONFIGURATION','FREE_PRICE_NOT_PROVEN','FREE_PRICE_NOT_ZERO',
    'SERVER_POLICY_UNAVAILABLE','PREPARATION_REJECTED','QUALIFICATION_NO_EFFECT',
    'QUALIFICATION_OUTCOME_UNCERTAIN','NATIVE_RECEIPT_INVALID',
    'SELECTION_CAS_CONFLICT','AUTHORITY_CHANGED','STORAGE_UNAVAILABLE'
  )),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  PRIMARY KEY (owner_id, project_id, operation_id),
  FOREIGN KEY (owner_id, project_id, provider_id, key_operation_id)
    REFERENCES research_provider_key_configuration_operation(owner_id, project_id, provider_id, operation_id),
  CHECK ((source_configuration_ref IS NULL) = (source_configuration_sha256 IS NULL)),
  CHECK ((source_configuration_ref IS NULL) = (expected_selection_revision IS NULL)),
  CHECK ((target_configuration_ref IS NULL) = (target_configuration_sha256 IS NULL)),
  CHECK ((target_configuration_ref IS NULL) = (target_configuration_json IS NULL)),
  CHECK (target_configuration_ref IS NULL OR target_configuration_ref = 'rpmc-' || target_configuration_sha256),
  CHECK ((selected_configuration_ref IS NULL) = (selection_revision IS NULL)),
  CHECK (selected_configuration_ref IS NULL OR selected_configuration_ref = target_configuration_ref),
  CHECK (
    (state = 'SELECTED' AND phase = 'COMPLETE' AND target_configuration_ref IS NOT NULL AND
      selected_configuration_ref IS NOT NULL AND selection_revision IS NOT NULL AND failure_code IS NULL) OR
    (state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING') AND selected_configuration_ref IS NULL AND
      selection_revision IS NULL AND failure_code IS NULL) OR
    (state = 'BLOCKED' AND selected_configuration_ref IS NULL AND selection_revision IS NULL AND failure_code IS NOT NULL) OR
    (state = 'UNCERTAIN' AND selected_configuration_ref IS NULL AND selection_revision IS NULL AND
      failure_code = 'QUALIFICATION_OUTCOME_UNCERTAIN' AND phase = 'NATIVE_QUALIFY') OR
    (state = 'CONFLICT' AND selected_configuration_ref IS NULL AND selection_revision IS NULL AND
      failure_code = 'SELECTION_CAS_CONFLICT')
  ),
  CHECK (
    (state = 'ACCEPTED' AND phase = 'INTENT') OR
    (state = 'PREPARING' AND phase IN ('FREE_PRICE_CHECK','NATIVE_PREPARE')) OR
    (state = 'QUALIFYING' AND phase = 'NATIVE_QUALIFY') OR
    (state = 'IMPORTING' AND phase IN ('CONFIGURATION_IMPORT','SELECTION_READBACK')) OR
    (state = 'SELECTED' AND phase = 'COMPLETE') OR
    (state = 'BLOCKED' AND phase IN ('INTENT','FREE_PRICE_CHECK','NATIVE_PREPARE','NATIVE_QUALIFY','CONFIGURATION_IMPORT')) OR
    (state = 'UNCERTAIN' AND phase = 'NATIVE_QUALIFY') OR
    (state = 'CONFLICT' AND phase IN ('INTENT','FREE_PRICE_CHECK','NATIVE_PREPARE','NATIVE_QUALIFY','SELECTION_READBACK'))
  )
) STRICT;

CREATE UNIQUE INDEX research_provider_key_model_use_unresolved
  ON research_provider_key_model_use_operation(owner_id, project_id)
  WHERE state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','UNCERTAIN');

CREATE INDEX research_provider_key_model_use_history
  ON research_provider_key_model_use_operation(owner_id, project_id, created_at DESC, operation_id DESC);

CREATE TRIGGER research_provider_key_model_use_owner_insert
BEFORE INSERT ON research_provider_key_model_use_operation
WHEN NOT EXISTS (
  SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
  WHERE p.project_id=NEW.project_id AND o.principal_ref=NEW.owner_id AND p.generation=NEW.project_generation
)
BEGIN
  SELECT RAISE(ABORT, 'current project owner authority is required');
END;

CREATE TRIGGER research_provider_key_model_use_transition
BEFORE UPDATE ON research_provider_key_model_use_operation
WHEN NEW.owner_id <> OLD.owner_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.provider_id <> OLD.provider_id
  OR NEW.operation_id <> OLD.operation_id
  OR NEW.key_operation_id <> OLD.key_operation_id
  OR NEW.account_id <> OLD.account_id
  OR NEW.gateway_id <> OLD.gateway_id
  OR NEW.alias <> OLD.alias
  OR NEW.provider_config_id <> OLD.provider_config_id
  OR NEW.configuration_metadata_sha256 <> OLD.configuration_metadata_sha256
  OR NEW.request_sha256 <> OLD.request_sha256
  OR NEW.configuration_basis_json <> OLD.configuration_basis_json
  OR NEW.owner_credential_generation <> OLD.owner_credential_generation
  OR NEW.project_generation <> OLD.project_generation
  OR NEW.deployment_generation <> OLD.deployment_generation
  OR NEW.deadline_at <> OLD.deadline_at
  OR NEW.expected_selection_revision IS NOT OLD.expected_selection_revision
  OR NEW.source_configuration_ref IS NOT OLD.source_configuration_ref
  OR NEW.source_configuration_sha256 IS NOT OLD.source_configuration_sha256
  OR NEW.planned_stage_set_sha256 <> OLD.planned_stage_set_sha256
  OR NEW.plan_sha256 <> OLD.plan_sha256
  OR NEW.created_at <> OLD.created_at
  OR (OLD.target_configuration_ref IS NOT NULL AND NEW.target_configuration_ref IS NOT OLD.target_configuration_ref)
  OR (OLD.target_configuration_sha256 IS NOT NULL AND NEW.target_configuration_sha256 IS NOT OLD.target_configuration_sha256)
  OR (OLD.target_configuration_json IS NOT NULL AND NEW.target_configuration_json IS NOT OLD.target_configuration_json)
  OR (OLD.selected_configuration_ref IS NOT NULL AND NEW.selected_configuration_ref IS NOT OLD.selected_configuration_ref)
  OR (OLD.selection_revision IS NOT NULL AND NEW.selection_revision IS NOT OLD.selection_revision)
  OR NOT (
    (OLD.state='ACCEPTED' AND NEW.state IN ('PREPARING','BLOCKED','CONFLICT'))
    OR (OLD.state='PREPARING' AND NEW.state IN ('PREPARING','QUALIFYING','BLOCKED','CONFLICT'))
    OR (OLD.state='QUALIFYING' AND NEW.state IN ('QUALIFYING','IMPORTING','BLOCKED','UNCERTAIN','CONFLICT'))
    OR (OLD.state='IMPORTING' AND NEW.state IN ('IMPORTING','SELECTED','BLOCKED','CONFLICT'))
  )
BEGIN
  SELECT RAISE(ABORT, 'model-use operation identity is immutable and state transitions are monotone');
END;

CREATE TRIGGER research_provider_key_model_use_no_delete
BEFORE DELETE ON research_provider_key_model_use_operation
BEGIN
  SELECT RAISE(ABORT, 'provider-key model-use history is immutable');
END;

CREATE TABLE research_provider_key_model_use_stage_operation (
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
  sequence_number INTEGER NOT NULL CHECK (sequence_number BETWEEN 0 AND 3),
  stage TEXT NOT NULL CHECK (stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  route_ref TEXT NOT NULL CHECK (route_ref IN (
    'dynamic/eliotr-economy','dynamic/eliotr-balanced','dynamic/eliotr-strong','dynamic/eliotr-frontier',
    'dynamic/eliotr-audit-writer','dynamic/eliotr-audit-verifier','dynamic/eliotr-vision',
    'dynamic/eliotr-extract','dynamic/eliotr-report-section','dynamic/eliotr-report-integrator'
  )),
  route_version TEXT NOT NULL CHECK (length(route_version) BETWEEN 1 AND 256),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64 AND schema_sha256 NOT GLOB '*[^0-9a-f]*'),
  parameters_sha256 TEXT NOT NULL CHECK (length(parameters_sha256) = 64 AND parameters_sha256 NOT GLOB '*[^0-9a-f]*'),
  probe_prompt_sha256 TEXT NOT NULL CHECK (length(probe_prompt_sha256) = 64 AND probe_prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
  probe_schema_sha256 TEXT NOT NULL CHECK (length(probe_schema_sha256) = 64 AND probe_schema_sha256 NOT GLOB '*[^0-9a-f]*'),
  probe_parameters_sha256 TEXT NOT NULL CHECK (length(probe_parameters_sha256) = 64 AND probe_parameters_sha256 NOT GLOB '*[^0-9a-f]*'),
  pricing_snapshot_ref TEXT CHECK (pricing_snapshot_ref IS NULL OR length(pricing_snapshot_ref) BETWEEN 1 AND 256),
  pricing_snapshot_sha256 TEXT CHECK (pricing_snapshot_sha256 IS NULL OR
    (length(pricing_snapshot_sha256) = 64 AND pricing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*')),
  preparation_ref TEXT CHECK (preparation_ref IS NULL OR length(preparation_ref) BETWEEN 1 AND 256),
  preparation_sha256 TEXT CHECK (preparation_sha256 IS NULL OR
    (length(preparation_sha256) = 64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*')),
  candidate_ref TEXT CHECK (candidate_ref IS NULL OR length(candidate_ref) BETWEEN 1 AND 256),
  candidate_sha256 TEXT CHECK (candidate_sha256 IS NULL OR
    (length(candidate_sha256) = 64 AND candidate_sha256 NOT GLOB '*[^0-9a-f]*')),
  qualification_ref TEXT CHECK (qualification_ref IS NULL OR length(qualification_ref) BETWEEN 1 AND 256),
  qualification_sha256 TEXT CHECK (qualification_sha256 IS NULL OR
    (length(qualification_sha256) = 64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK (state IN ('PENDING','PREPARED','QUALIFYING','QUALIFIED','BLOCKED','UNCERTAIN')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'NO_SELECTED_CONFIGURATION','FREE_PRICE_NOT_PROVEN','FREE_PRICE_NOT_ZERO',
    'SERVER_POLICY_UNAVAILABLE','PREPARATION_REJECTED','QUALIFICATION_NO_EFFECT',
    'QUALIFICATION_OUTCOME_UNCERTAIN','NATIVE_RECEIPT_INVALID','SELECTION_CAS_CONFLICT',
    'AUTHORITY_CHANGED','STORAGE_UNAVAILABLE'
  )),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  PRIMARY KEY (owner_id, project_id, operation_id, stage),
  UNIQUE (owner_id, project_id, operation_id, sequence_number),
  FOREIGN KEY (owner_id, project_id, operation_id)
    REFERENCES research_provider_key_model_use_operation(owner_id, project_id, operation_id),
  CHECK ((pricing_snapshot_ref IS NULL) = (pricing_snapshot_sha256 IS NULL)),
  CHECK ((preparation_ref IS NULL) = (preparation_sha256 IS NULL)),
  CHECK ((candidate_ref IS NULL) = (candidate_sha256 IS NULL)),
  CHECK ((qualification_ref IS NULL) = (qualification_sha256 IS NULL)),
  CHECK ((candidate_ref IS NULL) = (qualification_ref IS NULL)),
  CHECK (state = 'PENDING' OR pricing_snapshot_ref IS NOT NULL),
  CHECK (state NOT IN ('PREPARED','QUALIFYING','QUALIFIED','UNCERTAIN') OR preparation_ref IS NOT NULL),
  CHECK (state <> 'QUALIFIED' OR (candidate_ref IS NOT NULL AND qualification_ref IS NOT NULL)),
  CHECK ((state IN ('BLOCKED','UNCERTAIN')) = (failure_code IS NOT NULL)),
  CHECK (state <> 'UNCERTAIN' OR failure_code = 'QUALIFICATION_OUTCOME_UNCERTAIN')
) STRICT;

CREATE TRIGGER research_provider_key_model_use_stage_transition
BEFORE UPDATE ON research_provider_key_model_use_stage_operation
WHEN NEW.owner_id <> OLD.owner_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.operation_id <> OLD.operation_id
  OR NEW.sequence_number <> OLD.sequence_number
  OR NEW.stage <> OLD.stage
  OR NEW.route_ref <> OLD.route_ref
  OR NEW.route_version <> OLD.route_version
  OR NEW.prompt_sha256 <> OLD.prompt_sha256
  OR NEW.schema_sha256 <> OLD.schema_sha256
  OR NEW.parameters_sha256 <> OLD.parameters_sha256
  OR NEW.probe_prompt_sha256 <> OLD.probe_prompt_sha256
  OR NEW.probe_schema_sha256 <> OLD.probe_schema_sha256
  OR NEW.probe_parameters_sha256 <> OLD.probe_parameters_sha256
  OR NEW.created_at <> OLD.created_at
  OR (OLD.pricing_snapshot_ref IS NOT NULL AND NEW.pricing_snapshot_ref IS NOT OLD.pricing_snapshot_ref)
  OR (OLD.pricing_snapshot_sha256 IS NOT NULL AND NEW.pricing_snapshot_sha256 IS NOT OLD.pricing_snapshot_sha256)
  OR (OLD.preparation_ref IS NOT NULL AND NEW.preparation_ref IS NOT OLD.preparation_ref)
  OR (OLD.preparation_sha256 IS NOT NULL AND NEW.preparation_sha256 IS NOT OLD.preparation_sha256)
  OR (OLD.candidate_ref IS NOT NULL AND NEW.candidate_ref IS NOT OLD.candidate_ref)
  OR (OLD.candidate_sha256 IS NOT NULL AND NEW.candidate_sha256 IS NOT OLD.candidate_sha256)
  OR (OLD.qualification_ref IS NOT NULL AND NEW.qualification_ref IS NOT OLD.qualification_ref)
  OR (OLD.qualification_sha256 IS NOT NULL AND NEW.qualification_sha256 IS NOT OLD.qualification_sha256)
  OR NOT (
    (OLD.state='PENDING' AND NEW.state IN ('PENDING','PREPARED','BLOCKED'))
    OR (OLD.state='PREPARED' AND NEW.state IN ('QUALIFYING','BLOCKED'))
    OR (OLD.state='QUALIFYING' AND NEW.state IN ('QUALIFIED','BLOCKED','UNCERTAIN'))
  )
BEGIN
  SELECT RAISE(ABORT, 'model-use stage identity is immutable and state transitions are monotone');
END;

CREATE TRIGGER research_provider_key_model_use_stage_no_delete
BEFORE DELETE ON research_provider_key_model_use_stage_operation
BEGIN
  SELECT RAISE(ABORT, 'provider-key model-use stage history is immutable');
END;

-- Raw official model-price observations are control-plane evidence. They do
-- not become corpus Evidence objects or claim an R2 residency classification.
-- response_base64 is canonical padded RFC 4648 standard Base64 of exact raw
-- source response bytes; byte_length and SHA fields are verified after decode.
CREATE TABLE research_provider_key_model_price_observation (
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
  stage TEXT NOT NULL CHECK (stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  key_operation_id TEXT NOT NULL CHECK (length(key_operation_id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 32 AND account_id NOT GLOB '*[^A-Fa-f0-9]*'),
  gateway_id TEXT NOT NULL CHECK (
    length(gateway_id) BETWEEN 1 AND 64 AND substr(gateway_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    gateway_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  alias TEXT NOT NULL CHECK (
    length(alias) = 55 AND substr(alias, 1, 7) = 'eliotr-' AND substr(alias, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  provider_config_id TEXT NOT NULL CHECK (
    length(provider_config_id) BETWEEN 1 AND 128 AND provider_config_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  configuration_metadata_sha256 TEXT NOT NULL CHECK (
    length(configuration_metadata_sha256) = 64 AND configuration_metadata_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  owner_credential_generation TEXT NOT NULL CHECK (length(owner_credential_generation) BETWEEN 1 AND 256),
  project_generation INTEGER NOT NULL CHECK (project_generation BETWEEN 1 AND 2147483647),
  deployment_generation TEXT NOT NULL CHECK (length(deployment_generation) BETWEEN 1 AND 256),
  route_ref TEXT NOT NULL CHECK (route_ref IN (
    'dynamic/eliotr-economy','dynamic/eliotr-balanced','dynamic/eliotr-strong','dynamic/eliotr-frontier',
    'dynamic/eliotr-audit-writer','dynamic/eliotr-audit-verifier','dynamic/eliotr-vision',
    'dynamic/eliotr-extract','dynamic/eliotr-report-section','dynamic/eliotr-report-integrator'
  )),
  route_version TEXT NOT NULL CHECK (length(route_version) BETWEEN 1 AND 256),
  provider_id TEXT NOT NULL CHECK (provider_id = 'openrouter'),
  exact_model_id TEXT NOT NULL CHECK (exact_model_id = 'stealth/space-bunny-alpha'),
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  observation_ref TEXT NOT NULL UNIQUE CHECK (length(observation_ref) BETWEEN 1 AND 256),
  source_response_sha256 TEXT NOT NULL CHECK (length(source_response_sha256) = 64 AND source_response_sha256 NOT GLOB '*[^0-9a-f]*'),
  response_base64 TEXT NOT NULL CHECK (
    length(response_base64) BETWEEN 4 AND 43692 AND response_base64 NOT GLOB '*[^A-Za-z0-9+/=]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 32768),
  readback_sha256 TEXT NOT NULL CHECK (length(readback_sha256) = 64 AND readback_sha256 NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND 64),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 1 AND 64),
  approval_receipt_ref TEXT NOT NULL CHECK (length(approval_receipt_ref) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  PRIMARY KEY (owner_id, project_id, operation_id, stage),
  FOREIGN KEY (owner_id, project_id, operation_id, stage)
    REFERENCES research_provider_key_model_use_stage_operation(owner_id, project_id, operation_id, stage),
  CHECK (length(response_base64) = 4 * ((byte_length + 2) / 3)),
  CHECK (source_response_sha256 = readback_sha256),
  CHECK (approval_receipt_ref = operation_id)
) STRICT;

CREATE TRIGGER research_provider_key_model_price_observation_owner_insert
BEFORE INSERT ON research_provider_key_model_price_observation
WHEN NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_operation u
  JOIN research_provider_key_model_use_stage_operation s
    ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
  JOIN research_provider_key_configuration_operation k
    ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id
      AND k.operation_id=u.key_operation_id
  JOIN project p ON p.project_id=u.project_id
  JOIN project_owner o ON o.project_id=p.project_id
  WHERE u.owner_id=NEW.owner_id AND u.project_id=NEW.project_id AND u.operation_id=NEW.operation_id
    AND u.key_operation_id=NEW.key_operation_id AND u.request_sha256=NEW.request_sha256
    AND u.account_id=NEW.account_id AND u.gateway_id=NEW.gateway_id AND u.alias=NEW.alias
    AND u.provider_config_id=NEW.provider_config_id
    AND u.configuration_metadata_sha256=NEW.configuration_metadata_sha256
    AND u.owner_credential_generation=NEW.owner_credential_generation
    AND u.project_generation=NEW.project_generation AND u.deployment_generation=NEW.deployment_generation
    AND u.deadline_at=NEW.expires_at
    AND u.state='PREPARING' AND u.phase='FREE_PRICE_CHECK' AND u.active_stage=NEW.stage
    AND s.stage=NEW.stage AND s.route_ref=NEW.route_ref AND s.route_version=NEW.route_version
    AND k.state='CONFIGURED' AND k.account_id=NEW.account_id AND k.gateway_id=NEW.gateway_id
    AND k.alias=NEW.alias AND k.provider_config_id=NEW.provider_config_id
    AND k.metadata_sha256=NEW.configuration_metadata_sha256
    AND p.generation=NEW.project_generation AND o.principal_ref=NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'current owner check/use operation and exact stage are required');
END;

CREATE TRIGGER research_provider_key_model_price_observation_immutable_update
BEFORE UPDATE ON research_provider_key_model_price_observation
BEGIN
  SELECT RAISE(ABORT, 'provider-key model price observations are immutable');
END;

CREATE TRIGGER research_provider_key_model_price_observation_immutable_delete
BEFORE DELETE ON research_provider_key_model_price_observation
BEGIN
  SELECT RAISE(ABORT, 'provider-key model price observations are immutable');
END;
