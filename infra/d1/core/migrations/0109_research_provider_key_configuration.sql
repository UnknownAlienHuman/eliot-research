-- Intent and safe readback metadata for owner-created, non-default OpenRouter
-- AI Gateway BYOK aliases. Provider credentials are write-only and never live
-- in Core D1. A configured alias is not a qualified or selected model.

CREATE TABLE research_provider_key_configuration_operation (
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
  account_id TEXT NOT NULL CHECK (
    length(account_id) = 32 AND account_id NOT GLOB '*[^A-Fa-f0-9]*'
  ),
  gateway_id TEXT NOT NULL CHECK (
    length(gateway_id) BETWEEN 1 AND 64
    AND substr(gateway_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND gateway_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  alias TEXT NOT NULL CHECK (
    length(alias) = 55
    AND substr(alias, 1, 7) = 'eliotr-'
    AND substr(alias, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('PENDING','SUBMITTING','CONFIGURED','UNCERTAIN','FAILED_NO_EFFECT')),
  provider_config_id TEXT CHECK (
    provider_config_id IS NULL OR
    (length(provider_config_id) BETWEEN 1 AND 128 AND provider_config_id NOT GLOB '*[^A-Za-z0-9._:-]*')
  ),
  metadata_sha256 TEXT CHECK (
    metadata_sha256 IS NULL OR
    (length(metadata_sha256) = 64 AND metadata_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID',
      'OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED',
      'OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT',
      'OPENROUTER_PROVIDER_KEY_INPUT_INVALID'
    )
  ),
  provider_http_status INTEGER CHECK (
    provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  PRIMARY KEY (owner_id, project_id, provider_id, operation_id),
  UNIQUE (account_id, gateway_id, alias),
  CHECK (
    (state = 'CONFIGURED' AND provider_config_id IS NOT NULL AND metadata_sha256 IS NOT NULL
      AND failure_code IS NULL AND provider_http_status IS NULL)
    OR (state = 'FAILED_NO_EFFECT' AND provider_config_id IS NULL AND metadata_sha256 IS NULL
      AND failure_code IS NOT NULL)
    OR (state IN ('PENDING','SUBMITTING','UNCERTAIN') AND provider_config_id IS NULL AND metadata_sha256 IS NULL
      AND failure_code IS NULL AND provider_http_status IS NULL)
  )
) STRICT;

CREATE INDEX research_provider_key_configuration_history
  ON research_provider_key_configuration_operation(owner_id, project_id, provider_id, created_at DESC, operation_id DESC);

CREATE TRIGGER research_provider_key_configuration_owner_insert
BEFORE INSERT ON research_provider_key_configuration_operation
WHEN NOT EXISTS (
  SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
  WHERE p.project_id=NEW.project_id AND o.principal_ref=NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'current project owner authority is required');
END;

CREATE TRIGGER research_provider_key_configuration_owner_claim
BEFORE UPDATE ON research_provider_key_configuration_operation
WHEN NEW.state='SUBMITTING' AND OLD.state='PENDING' AND NOT EXISTS (
  SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
  WHERE p.project_id=NEW.project_id AND o.principal_ref=NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'current project owner authority is required to submit provider key configuration');
END;

CREATE TRIGGER research_provider_key_configuration_transition
BEFORE UPDATE ON research_provider_key_configuration_operation
WHEN NEW.owner_id <> OLD.owner_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.provider_id <> OLD.provider_id
  OR NEW.operation_id <> OLD.operation_id
  OR NEW.account_id <> OLD.account_id
  OR NEW.gateway_id <> OLD.gateway_id
  OR NEW.request_sha256 <> OLD.request_sha256
  OR NEW.alias <> OLD.alias
  OR NEW.created_at <> OLD.created_at
  OR NOT (
    (OLD.state='PENDING' AND NEW.state='SUBMITTING'
      AND NEW.provider_config_id IS NULL AND NEW.metadata_sha256 IS NULL)
    OR (OLD.state='SUBMITTING' AND NEW.state='UNCERTAIN'
      AND NEW.provider_config_id IS NULL AND NEW.metadata_sha256 IS NULL)
    OR (OLD.state='SUBMITTING' AND NEW.state='CONFIGURED'
      AND NEW.provider_config_id IS NOT NULL AND NEW.metadata_sha256 IS NOT NULL)
    OR (OLD.state='SUBMITTING' AND NEW.state='FAILED_NO_EFFECT'
      AND NEW.provider_config_id IS NULL AND NEW.metadata_sha256 IS NULL AND NEW.failure_code IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'provider key operation identity is immutable and state transitions are monotone');
END;

CREATE TRIGGER research_provider_key_configuration_no_delete
BEFORE DELETE ON research_provider_key_configuration_operation
BEGIN
  SELECT RAISE(ABORT, 'provider key configuration operation history is immutable');
END;
