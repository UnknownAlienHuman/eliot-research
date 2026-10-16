-- Generic provider-native qualification is a separate immutable authority from
-- provider-native-v1. A row is bound to one exact owner-consented catalog
-- operation, existing configured connection, model and trusted pricing snapshot.
PRAGMA foreign_keys=ON;

CREATE TABLE provider_native_model_catalog_v2_evidence (
  owner_ref TEXT NOT NULL CHECK(length(owner_ref) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
  consent_operation_id TEXT NOT NULL CHECK(length(consent_operation_id)=36),
  stage TEXT NOT NULL CHECK(stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 64),
  provider_slug TEXT NOT NULL CHECK(length(provider_slug) BETWEEN 1 AND 128),
  provider_operation_id TEXT NOT NULL CHECK(length(provider_operation_id)=36),
  model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 256),
  alias TEXT NOT NULL CHECK(length(alias)=55 AND substr(alias,1,7)='eliotr-' AND substr(alias,8) NOT GLOB '*[^0-9a-f]*'),
  provider_config_id TEXT NOT NULL CHECK(length(provider_config_id) BETWEEN 1 AND 128),
  configuration_metadata_sha256 TEXT NOT NULL CHECK(length(configuration_metadata_sha256)=64 AND configuration_metadata_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  pricing_snapshot_ref TEXT NOT NULL CHECK(length(pricing_snapshot_ref) BETWEEN 1 AND 256),
  pricing_snapshot_sha256 TEXT NOT NULL CHECK(length(pricing_snapshot_sha256)=64 AND pricing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  preparation_ref TEXT NOT NULL CHECK(length(preparation_ref) BETWEEN 1 AND 256),
  preparation_sha256 TEXT NOT NULL CHECK(length(preparation_sha256)=64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*'),
  preparation_json TEXT NOT NULL CHECK(json_valid(preparation_json) AND length(CAST(preparation_json AS BLOB)) BETWEEN 2 AND 65536),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','CLAIMED','OBSERVED','COMPLETED','UNCERTAIN')),
  observation_ref TEXT CHECK(observation_ref IS NULL OR length(observation_ref) BETWEEN 1 AND 256),
  observation_sha256 TEXT CHECK(observation_sha256 IS NULL OR (length(observation_sha256)=64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*')),
  observation_json TEXT CHECK(observation_json IS NULL OR (json_valid(observation_json) AND length(CAST(observation_json AS BLOB)) BETWEEN 2 AND 32768)),
  request_body_base64 TEXT CHECK(request_body_base64 IS NULL OR length(request_body_base64)<=43692),
  response_body_base64 TEXT CHECK(response_body_base64 IS NULL OR length(response_body_base64)<=349528),
  candidate_ref TEXT CHECK(candidate_ref IS NULL OR length(candidate_ref) BETWEEN 1 AND 256),
  candidate_sha256 TEXT CHECK(candidate_sha256 IS NULL OR (length(candidate_sha256)=64 AND candidate_sha256 NOT GLOB '*[^0-9a-f]*')),
  candidate_json TEXT CHECK(candidate_json IS NULL OR (json_valid(candidate_json) AND length(CAST(candidate_json AS BLOB)) BETWEEN 2 AND 65536)),
  qualification_ref TEXT CHECK(qualification_ref IS NULL OR length(qualification_ref) BETWEEN 1 AND 256),
  qualification_sha256 TEXT CHECK(qualification_sha256 IS NULL OR (length(qualification_sha256)=64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*')),
  qualification_json TEXT CHECK(qualification_json IS NULL OR (json_valid(qualification_json) AND length(CAST(qualification_json AS BLOB)) BETWEEN 2 AND 65536)),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z' AND julianday(updated_at) IS NOT NULL),
  PRIMARY KEY(owner_ref,project_id,consent_operation_id,stage),
  UNIQUE(preparation_ref,preparation_sha256),
  UNIQUE(candidate_ref,candidate_sha256),
  UNIQUE(qualification_ref,qualification_sha256),
  FOREIGN KEY(owner_ref,project_id,consent_operation_id)
    REFERENCES research_catalog_model_use_authorization(owner_id,project_id,operation_id),
  FOREIGN KEY(owner_ref,provider_operation_id)
    REFERENCES service_model_provider_operation(owner_id,operation_id),
  CHECK((observation_ref IS NULL)=(observation_sha256 IS NULL)),
  CHECK((observation_ref IS NULL)=(observation_json IS NULL)),
  CHECK((observation_ref IS NULL)=(request_body_base64 IS NULL)),
  CHECK((observation_ref IS NULL)=(response_body_base64 IS NULL)),
  CHECK((candidate_ref IS NULL)=(candidate_sha256 IS NULL)),
  CHECK((candidate_ref IS NULL)=(candidate_json IS NULL)),
  CHECK((qualification_ref IS NULL)=(qualification_sha256 IS NULL)),
  CHECK((qualification_ref IS NULL)=(qualification_json IS NULL)),
  CHECK((state IN ('PREPARED','CLAIMED','UNCERTAIN') AND observation_ref IS NULL AND candidate_ref IS NULL AND qualification_ref IS NULL)
     OR (state='OBSERVED' AND observation_ref IS NOT NULL AND candidate_ref IS NULL AND qualification_ref IS NULL)
     OR (state='COMPLETED' AND observation_ref IS NOT NULL AND candidate_ref IS NOT NULL AND qualification_ref IS NOT NULL))
) STRICT;

CREATE INDEX provider_native_model_catalog_v2_candidate_lookup
  ON provider_native_model_catalog_v2_evidence(candidate_ref,candidate_sha256,owner_ref,project_id,stage);

CREATE TRIGGER provider_native_model_catalog_v2_owner_consent_guard
BEFORE INSERT ON provider_native_model_catalog_v2_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM research_catalog_model_use_authorization a
  JOIN service_model_provider_operation g ON g.owner_id=a.owner_id AND g.operation_id=a.provider_operation_id
  JOIN project p ON p.project_id=a.project_id
  JOIN project_owner o ON o.project_id=p.project_id
  WHERE a.owner_id=NEW.owner_ref AND a.project_id=NEW.project_id AND a.operation_id=NEW.consent_operation_id
    AND a.provider_id=NEW.provider_id AND a.provider_operation_id=NEW.provider_operation_id
    AND a.route_provider_id=NEW.provider_slug AND a.model_id=NEW.model_id
    AND a.alias=NEW.alias AND a.provider_config_id=NEW.provider_config_id
    AND a.configuration_metadata_sha256=NEW.configuration_metadata_sha256
    AND a.request_sha256=NEW.request_sha256 AND a.state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING')
    AND g.provider_id=NEW.provider_id AND g.provider_slug=NEW.provider_slug
    AND g.state='CONFIGURED' AND g.failure_code IS NULL AND g.provider_http_status IS NULL
    AND g.alias=NEW.alias AND g.provider_config_id=NEW.provider_config_id
    AND g.metadata_sha256=NEW.configuration_metadata_sha256
    AND p.generation=a.project_generation AND o.principal_ref=a.owner_id
)
BEGIN SELECT RAISE(ABORT,'exact current catalog consent and configured provider authority are required'); END;

CREATE TRIGGER provider_native_model_catalog_v2_preparation_identity_guard
BEFORE INSERT ON provider_native_model_catalog_v2_evidence
WHEN json_extract(NEW.preparation_json,'$.protocol') IS NOT 'eliotr.provider-native-model-preparation.v2'
  OR json_extract(NEW.preparation_json,'$.owner_ref') IS NOT NEW.owner_ref
  OR json_extract(NEW.preparation_json,'$.project_id') IS NOT NEW.project_id
  OR json_extract(NEW.preparation_json,'$.owner_operation_id') IS NOT NEW.consent_operation_id
  OR json_extract(NEW.preparation_json,'$.consent_operation_id') IS NOT NEW.consent_operation_id
  OR json_extract(NEW.preparation_json,'$.stage') IS NOT NEW.stage
  OR json_extract(NEW.preparation_json,'$.provider_id') IS NOT NEW.provider_id
  OR json_extract(NEW.preparation_json,'$.provider_slug') IS NOT NEW.provider_slug
  OR json_extract(NEW.preparation_json,'$.provider_operation_id') IS NOT NEW.provider_operation_id
  OR json_extract(NEW.preparation_json,'$.model_id') IS NOT NEW.model_id
  OR json_extract(NEW.preparation_json,'$.pricing_snapshot_ref') IS NOT NEW.pricing_snapshot_ref
  OR json_extract(NEW.preparation_json,'$.pricing_snapshot_sha256') IS NOT NEW.pricing_snapshot_sha256
  OR json_extract(NEW.preparation_json,'$.request_sha256') IS NOT NEW.request_sha256
  OR json_extract(NEW.preparation_json,'$.catalog_sdk') IS NULL
  OR length(json_extract(NEW.preparation_json,'$.catalog_sdk')) NOT BETWEEN 1 AND 256
  OR json_extract(NEW.preparation_json,'$.sdk_base_url') IS NULL
  OR json_extract(NEW.preparation_json,'$.sdk_base_url') NOT GLOB 'https://*'
  OR json_extract(NEW.preparation_json,'$.catalog_metadata_sha256') IS NULL
  OR length(json_extract(NEW.preparation_json,'$.catalog_metadata_sha256'))<>64
  OR json_extract(NEW.preparation_json,'$.catalog_metadata_sha256') GLOB '*[^0-9a-f]*'
BEGIN SELECT RAISE(ABORT,'catalog native v2 preparation must match exact consent and trusted metadata'); END;

CREATE TRIGGER provider_native_model_catalog_v2_transport_binding_guard
BEFORE INSERT ON provider_native_model_catalog_v2_evidence
WHEN json_extract(NEW.preparation_json,'$.key_binding.operation_id') IS NOT NEW.provider_operation_id
  OR json_extract(NEW.preparation_json,'$.key_binding.owner_ref') IS NOT NEW.owner_ref
  OR json_extract(NEW.preparation_json,'$.key_binding.project_id') IS NOT NEW.project_id
  OR json_extract(NEW.preparation_json,'$.key_binding.provider_id') IS NOT NEW.provider_id
  OR json_extract(NEW.preparation_json,'$.key_binding.provider_slug') IS NOT NEW.provider_slug
  OR json_extract(NEW.preparation_json,'$.key_binding.alias') IS NOT NEW.alias
  OR json_extract(NEW.preparation_json,'$.key_binding.provider_config_id') IS NOT NEW.provider_config_id
  OR json_extract(NEW.preparation_json,'$.key_binding.configuration_metadata_sha256') IS NOT NEW.configuration_metadata_sha256
  OR json_extract(NEW.preparation_json,'$.transport_policy.provider') IS NOT NEW.provider_slug
  OR json_extract(NEW.preparation_json,'$.transport_policy.model') IS NOT NEW.model_id
  OR json_extract(NEW.preparation_json,'$.transport_policy.billing.mode') IS NOT 'byok'
  OR json_extract(NEW.preparation_json,'$.transport_policy.billing.alias') IS NOT NEW.alias
  OR json_extract(NEW.preparation_json,'$.transport_policy.api') IS 'compat-chat-completions'
  OR julianday(json_extract(NEW.preparation_json,'$.prepared_at')) IS NULL
  OR julianday(json_extract(NEW.preparation_json,'$.preparation_expires_at')) IS NULL
  OR julianday(json_extract(NEW.preparation_json,'$.pricing_snapshot_expires_at')) IS NULL
  OR julianday(json_extract(NEW.preparation_json,'$.prepared_at'))>=julianday(json_extract(NEW.preparation_json,'$.preparation_expires_at'))
  OR julianday(json_extract(NEW.preparation_json,'$.preparation_expires_at'))>julianday(json_extract(NEW.preparation_json,'$.pricing_snapshot_expires_at'))
BEGIN SELECT RAISE(ABORT,'catalog native v2 transport or provider binding differs from exact consent'); END;

CREATE TRIGGER provider_native_model_catalog_v2_transition
BEFORE UPDATE ON provider_native_model_catalog_v2_evidence
WHEN NEW.owner_ref IS NOT OLD.owner_ref OR NEW.project_id IS NOT OLD.project_id OR
  NEW.consent_operation_id IS NOT OLD.consent_operation_id OR NEW.stage IS NOT OLD.stage OR
  NEW.provider_id IS NOT OLD.provider_id OR NEW.provider_slug IS NOT OLD.provider_slug OR
  NEW.provider_operation_id IS NOT OLD.provider_operation_id OR NEW.model_id IS NOT OLD.model_id OR
  NEW.alias IS NOT OLD.alias OR NEW.provider_config_id IS NOT OLD.provider_config_id OR
  NEW.configuration_metadata_sha256 IS NOT OLD.configuration_metadata_sha256 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR
  NEW.pricing_snapshot_ref IS NOT OLD.pricing_snapshot_ref OR NEW.pricing_snapshot_sha256 IS NOT OLD.pricing_snapshot_sha256 OR
  NEW.preparation_ref IS NOT OLD.preparation_ref OR NEW.preparation_sha256 IS NOT OLD.preparation_sha256 OR
  NEW.preparation_json IS NOT OLD.preparation_json OR NEW.created_at IS NOT OLD.created_at OR
  (OLD.observation_ref IS NOT NULL AND (NEW.observation_ref IS NOT OLD.observation_ref OR
    NEW.observation_sha256 IS NOT OLD.observation_sha256 OR NEW.observation_json IS NOT OLD.observation_json OR
    NEW.request_body_base64 IS NOT OLD.request_body_base64 OR NEW.response_body_base64 IS NOT OLD.response_body_base64)) OR
  (OLD.candidate_ref IS NOT NULL AND (NEW.candidate_ref IS NOT OLD.candidate_ref OR
    NEW.candidate_sha256 IS NOT OLD.candidate_sha256 OR NEW.candidate_json IS NOT OLD.candidate_json OR
    NEW.qualification_ref IS NOT OLD.qualification_ref OR NEW.qualification_sha256 IS NOT OLD.qualification_sha256 OR
    NEW.qualification_json IS NOT OLD.qualification_json)) OR
  NOT ((OLD.state='PREPARED' AND NEW.state IN ('CLAIMED','UNCERTAIN')) OR
       (OLD.state='CLAIMED' AND NEW.state IN ('OBSERVED','UNCERTAIN')) OR
       (OLD.state='OBSERVED' AND NEW.state='COMPLETED'))
BEGIN SELECT RAISE(ABORT,'catalog native v2 evidence is immutable and one-shot'); END;

CREATE TRIGGER provider_native_model_catalog_v2_observation_guard
BEFORE UPDATE OF state ON provider_native_model_catalog_v2_evidence
WHEN NEW.state='OBSERVED' AND NOT (
  json_valid(NEW.observation_json) AND
  json_extract(NEW.observation_json,'$.protocol') IS 'eliotr.provider-native-model-observation.v2' AND
  json_extract(NEW.observation_json,'$.provider_id') IS NEW.provider_id AND
  json_extract(NEW.observation_json,'$.provider_slug') IS NEW.provider_slug AND
  json_extract(NEW.observation_json,'$.model_id') IS NEW.model_id AND
  json_extract(NEW.observation_json,'$.response_model') IS NEW.model_id AND
  json_extract(NEW.observation_json,'$.consent_request_sha256') IS NEW.request_sha256 AND
  json_extract(NEW.preparation_json,'$.transport_policy.api') IS json_extract(NEW.observation_json,'$.api') AND
  json_extract(NEW.observation_json,'$.qualification_purpose') IS 'structured-output-connectivity'
)
BEGIN SELECT RAISE(ABORT,'catalog provider observation must prove the exact selected model request'); END;

CREATE TRIGGER provider_native_model_catalog_v2_complete_guard
BEFORE UPDATE OF state ON provider_native_model_catalog_v2_evidence
WHEN NEW.state='COMPLETED' AND NOT (
  json_valid(NEW.candidate_json) AND json_valid(NEW.qualification_json) AND
  json_extract(NEW.candidate_json,'$.protocol') IS 'eliotr.provider-native-model-candidate.v2' AND
  json_extract(NEW.candidate_json,'$.candidate_kind') IS 'provider-native-v2' AND
  json_extract(NEW.candidate_json,'$.preparation_ref') IS NEW.preparation_ref AND
  json_extract(NEW.candidate_json,'$.preparation_sha256') IS NEW.preparation_sha256 AND
  json_extract(NEW.candidate_json,'$.observation_ref') IS NEW.observation_ref AND
  json_extract(NEW.candidate_json,'$.observation_sha256') IS NEW.observation_sha256 AND
  json_extract(NEW.candidate_json,'$.preparation.owner_ref') IS NEW.owner_ref AND
  json_extract(NEW.candidate_json,'$.preparation.project_id') IS NEW.project_id AND
  json_extract(NEW.candidate_json,'$.preparation.consent_operation_id') IS NEW.consent_operation_id AND
  json_extract(NEW.candidate_json,'$.preparation.provider_id') IS NEW.provider_id AND
  json_extract(NEW.candidate_json,'$.preparation.provider_slug') IS NEW.provider_slug AND
  json_extract(NEW.candidate_json,'$.preparation.provider_operation_id') IS NEW.provider_operation_id AND
  json_extract(NEW.candidate_json,'$.preparation.model_id') IS NEW.model_id AND
  json_extract(NEW.qualification_json,'$.protocol') IS 'eliotr.provider-native-model-qualification.v2' AND
  json_extract(NEW.qualification_json,'$.candidate_kind') IS 'provider-native-v2' AND
  json_extract(NEW.qualification_json,'$.candidate_ref') IS NEW.candidate_ref AND
  json_extract(NEW.qualification_json,'$.candidate_sha256') IS NEW.candidate_sha256 AND
  json_extract(NEW.qualification_json,'$.observation_ref') IS NEW.observation_ref AND
  json_extract(NEW.qualification_json,'$.observation_sha256') IS NEW.observation_sha256 AND
  json_extract(NEW.qualification_json,'$.owner_ref') IS NEW.owner_ref AND
  json_extract(NEW.qualification_json,'$.project_id') IS NEW.project_id AND
  json_extract(NEW.qualification_json,'$.consent_operation_id') IS NEW.consent_operation_id AND
  json_extract(NEW.qualification_json,'$.provider_id') IS NEW.provider_id AND
  json_extract(NEW.qualification_json,'$.provider_slug') IS NEW.provider_slug AND
  json_extract(NEW.qualification_json,'$.provider_operation_id') IS NEW.provider_operation_id AND
  json_extract(NEW.qualification_json,'$.model_id') IS NEW.model_id AND
  json_extract(NEW.qualification_json,'$.pricing_snapshot_ref') IS NEW.pricing_snapshot_ref AND
  json_extract(NEW.qualification_json,'$.pricing_snapshot_sha256') IS NEW.pricing_snapshot_sha256 AND
  json_extract(NEW.qualification_json,'$.catalog_sdk') IS json_extract(NEW.preparation_json,'$.catalog_sdk') AND
  json_extract(NEW.qualification_json,'$.sdk_base_url') IS json_extract(NEW.preparation_json,'$.sdk_base_url') AND
  json_extract(NEW.qualification_json,'$.catalog_metadata_sha256') IS json_extract(NEW.preparation_json,'$.catalog_metadata_sha256') AND
  json_extract(NEW.qualification_json,'$.qualification_tier') IS 'LIVE'
)
BEGIN SELECT RAISE(ABORT,'catalog native v2 candidate and proof must match exact consent, binding and observation'); END;

CREATE TRIGGER provider_native_model_catalog_v2_no_delete
BEFORE DELETE ON provider_native_model_catalog_v2_evidence
BEGIN SELECT RAISE(ABORT,'catalog native v2 qualification history is immutable'); END;

CREATE TABLE provider_native_model_catalog_v2_revocation (
  owner_ref TEXT NOT NULL,
  project_id TEXT NOT NULL,
  consent_operation_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  qualification_ref TEXT NOT NULL,
  qualification_sha256 TEXT NOT NULL CHECK(length(qualification_sha256)=64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*'),
  revoked_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1024),
  revoked_at TEXT NOT NULL CHECK(revoked_at GLOB '????-??-??T??:??:??.???Z' AND julianday(revoked_at) IS NOT NULL),
  PRIMARY KEY(owner_ref,project_id,qualification_ref,qualification_sha256),
  FOREIGN KEY(owner_ref,project_id,consent_operation_id,stage)
    REFERENCES provider_native_model_catalog_v2_evidence(owner_ref,project_id,consent_operation_id,stage)
) STRICT;

CREATE TRIGGER provider_native_model_catalog_v2_revocation_guard
BEFORE INSERT ON provider_native_model_catalog_v2_revocation
WHEN NEW.revoked_by IS NOT NEW.owner_ref OR NOT EXISTS (
  SELECT 1 FROM provider_native_model_catalog_v2_evidence e
  WHERE e.owner_ref=NEW.owner_ref AND e.project_id=NEW.project_id AND e.consent_operation_id=NEW.consent_operation_id
    AND e.stage=NEW.stage AND e.state='COMPLETED' AND e.qualification_ref=NEW.qualification_ref
    AND e.qualification_sha256=NEW.qualification_sha256
)
BEGIN SELECT RAISE(ABORT,'only the exact proof owner may revoke a completed catalog native v2 qualification'); END;

CREATE TRIGGER provider_native_model_catalog_v2_revocation_immutable_update
BEFORE UPDATE ON provider_native_model_catalog_v2_revocation
BEGIN SELECT RAISE(ABORT,'catalog native v2 revocations are immutable'); END;
CREATE TRIGGER provider_native_model_catalog_v2_revocation_immutable_delete
BEFORE DELETE ON provider_native_model_catalog_v2_revocation
BEGIN SELECT RAISE(ABORT,'catalog native v2 revocations are immutable'); END;

-- Permit v2 proof references on selected owner model configurations while
-- retaining the v1 OpenRouter-only proof predicate above as its own branch.
DROP TRIGGER research_catalog_model_use_authorization_selected_readback;
CREATE TRIGGER research_catalog_model_use_authorization_selected_readback_v1
BEFORE UPDATE OF state ON research_catalog_model_use_authorization
WHEN NEW.state='SELECTED' AND NEW.provider_operation_id IS NOT NULL AND NEW.provider_id='openrouter' AND NOT EXISTS (
  SELECT 1 FROM research_project_model_configuration_selection s
  JOIN research_project_model_configuration_revision r ON r.owner_id=s.owner_id AND r.project_id=s.project_id
    AND r.configuration_ref=s.configuration_ref AND r.configuration_sha256=s.configuration_sha256
  WHERE s.owner_id=NEW.owner_id AND s.project_id=NEW.project_id AND s.configuration_ref=NEW.selected_configuration_ref
    AND s.configuration_sha256=NEW.selected_configuration_sha256 AND s.selection_revision=NEW.selection_revision
    AND json_valid(r.configuration_json)
    AND EXISTS (SELECT 1 FROM json_each(r.configuration_json,'$.model_selections') m
      WHERE json_extract(m.value,'$.stage')='SYNTHESIZE'
        AND json_extract(m.value,'$.candidate_kind')='provider-native-v1'
        AND json_extract(m.value,'$.transport_policy.provider')=NEW.route_provider_id
        AND json_extract(m.value,'$.transport_policy.model')=NEW.model_id
        AND json_extract(m.value,'$.transport_policy.api')='openrouter-chat-completions'
        AND json_extract(m.value,'$.transport_policy.billing.mode')='byok'
        AND json_extract(m.value,'$.transport_policy.billing.alias')=NEW.alias
        AND json_extract(m.value,'$.transport_policy.billing.free_only')=1
        AND EXISTS (SELECT 1 FROM provider_native_model_candidate c
          JOIN provider_native_model_qualification_proof q
            ON q.qualification_ref=json_extract(m.value,'$.qualification_ref')
            AND q.qualification_sha256=json_extract(m.value,'$.qualification_sha256')
          WHERE c.candidate_ref=json_extract(m.value,'$.candidate_ref')
            AND c.candidate_sha256=json_extract(m.value,'$.candidate_sha256')
            AND c.owner_ref=NEW.owner_id AND c.project_id=NEW.project_id AND c.stage='SYNTHESIZE'
            AND c.route_ref=json_extract(m.value,'$.route_ref') AND c.route_version=json_extract(m.value,'$.route_version')
            AND q.owner_ref=NEW.owner_id AND q.project_id=NEW.project_id AND q.stage='SYNTHESIZE'
            AND q.route_ref=json_extract(m.value,'$.route_ref') AND q.route_version=json_extract(m.value,'$.route_version')
            AND q.candidate_ref=c.candidate_ref AND q.candidate_sha256=c.candidate_sha256
            AND c.qualification_tier='LIVE' AND q.qualification_tier='LIVE'
            AND json_extract(c.candidate_json,'$.preparation.transport_policy.provider')=NEW.route_provider_id
            AND json_extract(c.candidate_json,'$.preparation.transport_policy.model')=NEW.model_id)
    )
)
BEGIN SELECT RAISE(ABORT,'selected OpenRouter model must match the exact v1 qualified project proof'); END;

CREATE TRIGGER research_catalog_model_use_authorization_selected_readback_v2
BEFORE UPDATE OF state ON research_catalog_model_use_authorization
WHEN NEW.state='SELECTED' AND NEW.provider_operation_id IS NOT NULL AND NEW.provider_id<>'openrouter' AND NOT EXISTS (
  SELECT 1 FROM research_project_model_configuration_selection s
  JOIN research_project_model_configuration_revision r ON r.owner_id=s.owner_id AND r.project_id=s.project_id
    AND r.configuration_ref=s.configuration_ref AND r.configuration_sha256=s.configuration_sha256
  WHERE s.owner_id=NEW.owner_id AND s.project_id=NEW.project_id AND s.configuration_ref=NEW.selected_configuration_ref
    AND s.configuration_sha256=NEW.selected_configuration_sha256 AND s.selection_revision=NEW.selection_revision
    AND json_valid(r.configuration_json)
    AND EXISTS (SELECT 1 FROM json_each(r.configuration_json,'$.model_selections') m
      WHERE json_extract(m.value,'$.stage')='SYNTHESIZE'
        AND json_extract(m.value,'$.candidate_kind')='provider-native-v2'
        AND json_extract(m.value,'$.transport_policy.provider')=NEW.route_provider_id
        AND json_extract(m.value,'$.transport_policy.model')=NEW.model_id
        AND json_extract(m.value,'$.transport_policy.billing.mode')='byok'
        AND json_extract(m.value,'$.transport_policy.billing.alias')=NEW.alias
        AND json_extract(m.value,'$.transport_policy.api')<>'compat-chat-completions'
        AND EXISTS (SELECT 1 FROM provider_native_model_catalog_v2_evidence e
          WHERE e.owner_ref=NEW.owner_id AND e.project_id=NEW.project_id AND e.consent_operation_id=NEW.operation_id
            AND e.stage='SYNTHESIZE' AND e.state='COMPLETED'
            AND e.provider_id=NEW.provider_id AND e.provider_slug=NEW.route_provider_id
            AND e.provider_operation_id=NEW.provider_operation_id AND e.model_id=NEW.model_id
            AND e.alias=NEW.alias AND e.provider_config_id=NEW.provider_config_id
            AND e.configuration_metadata_sha256=NEW.configuration_metadata_sha256
            AND e.candidate_ref=json_extract(m.value,'$.candidate_ref')
            AND e.candidate_sha256=json_extract(m.value,'$.candidate_sha256')
            AND e.qualification_ref=json_extract(m.value,'$.qualification_ref')
            AND e.qualification_sha256=json_extract(m.value,'$.qualification_sha256')
            AND NOT EXISTS (SELECT 1 FROM provider_native_model_catalog_v2_revocation v
              WHERE v.owner_ref=e.owner_ref AND v.project_id=e.project_id
                AND v.qualification_ref=e.qualification_ref AND v.qualification_sha256=e.qualification_sha256)))
)
BEGIN SELECT RAISE(ABORT,'selected catalog model must match exact v2 proof and configured provider binding'); END;
