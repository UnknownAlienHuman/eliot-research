-- Catalog management is additive metadata on the existing provider operation.
-- The existing Cloudflare BYOK secret/config alias remains the only credential store.
ALTER TABLE service_model_provider_operation
  ADD COLUMN model_registration_mode TEXT NOT NULL DEFAULT 'explicit_allowlist'
  CHECK(model_registration_mode IN ('explicit_allowlist','catalog_managed'));

CREATE TRIGGER service_model_provider_registration_mode_insert
BEFORE INSERT ON service_model_provider_operation
WHEN (NEW.model_registration_mode='explicit_allowlist' AND
      json_array_length(NEW.model_ids_json) NOT BETWEEN 1 AND 64)
  OR (NEW.model_registration_mode='catalog_managed' AND
      json_array_length(NEW.model_ids_json)<>0)
BEGIN
  SELECT RAISE(ABORT,'SERVICE_MODEL_PROVIDER_REGISTRATION_MODE_INVALID');
END;

CREATE TRIGGER service_model_provider_registration_mode_update
BEFORE UPDATE OF model_registration_mode,model_ids_json ON service_model_provider_operation
WHEN NEW.model_registration_mode IS NOT OLD.model_registration_mode
  OR (NEW.model_registration_mode='explicit_allowlist' AND
      json_array_length(NEW.model_ids_json) NOT BETWEEN 1 AND 64)
  OR (NEW.model_registration_mode='catalog_managed' AND
      json_array_length(NEW.model_ids_json)<>0)
BEGIN
  SELECT RAISE(ABORT,'SERVICE_MODEL_PROVIDER_REGISTRATION_MODE_IMMUTABLE');
END;

-- Owner presentation preferences contain no credential, project grant, model qualification,
-- or provider operation reference. They survive credential rotation and never authorize inference.
CREATE TABLE service_model_provider_catalog_preference (
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256),
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 63),
  visibility_json TEXT NOT NULL CHECK(json_valid(visibility_json) AND json_type(visibility_json)='object'),
  search_text TEXT NOT NULL CHECK(length(search_text)<=512),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,provider_id),
  CHECK(
    ((json_extract(visibility_json,'$.mode') IS 'all' OR json_extract(visibility_json,'$.mode') IS 'none') AND
      json_type(visibility_json,'$.model_ids') IS NULL)
    OR
    ((json_extract(visibility_json,'$.mode') IS 'include' OR json_extract(visibility_json,'$.mode') IS 'exclude') AND
      json_type(visibility_json,'$.model_ids') IS 'array' AND
      json_array_length(visibility_json,'$.model_ids') BETWEEN 1 AND 512)
  )
) WITHOUT ROWID;
