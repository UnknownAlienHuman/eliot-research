-- Global owner service-model provider operations. This table deliberately has
-- no project identity and no credential column; Cloudflare owns the secret.
CREATE TABLE service_model_provider_operation (
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 64),
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 63),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 128),
  base_url TEXT,
  model_ids_json TEXT NOT NULL CHECK(json_valid(model_ids_json) AND json_type(model_ids_json) = 'array'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
  alias TEXT NOT NULL CHECK(length(alias) BETWEEN 1 AND 63),
  state TEXT NOT NULL CHECK(state IN ('PENDING', 'SUBMITTING', 'CONFIGURED', 'UNCERTAIN', 'FAILED_NO_EFFECT')),
  provider_config_id TEXT,
  provider_slug TEXT,
  metadata_sha256 TEXT CHECK(metadata_sha256 IS NULL OR length(metadata_sha256) = 64),
  failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN (
    'SERVICE_MODEL_PROVIDER_CREDENTIAL_INVALID',
    'SERVICE_MODEL_PROVIDER_INPUT_INVALID',
    'SERVICE_MODEL_PROVIDER_PREFLIGHT_FAILED',
    'SERVICE_MODEL_PROVIDER_ALIAS_CONFLICT'
  )),
  provider_http_status INTEGER CHECK(provider_http_status IS NULL OR (provider_http_status BETWEEN 100 AND 599)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, operation_id),
  UNIQUE(owner_id, provider_id, alias),
  CHECK(
    (state IN ('PENDING', 'SUBMITTING', 'UNCERTAIN') AND provider_config_id IS NULL AND provider_slug IS NULL AND metadata_sha256 IS NULL AND failure_code IS NULL AND provider_http_status IS NULL)
    OR
    (state = 'CONFIGURED' AND provider_config_id IS NOT NULL AND provider_slug IS NOT NULL AND metadata_sha256 IS NOT NULL AND failure_code IS NULL AND provider_http_status IS NULL)
    OR
    (state = 'FAILED_NO_EFFECT' AND provider_config_id IS NULL AND provider_slug IS NULL AND metadata_sha256 IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX service_model_provider_operation_owner_created
  ON service_model_provider_operation(owner_id, created_at DESC, operation_id DESC);
