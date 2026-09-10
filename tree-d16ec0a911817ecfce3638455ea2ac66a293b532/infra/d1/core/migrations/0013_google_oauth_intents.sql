-- One durable initial OAuth attempt. No Google request is permitted until its claim is read back.
CREATE TABLE google_oauth_intent (
  intent_id TEXT PRIMARY KEY CHECK(length(intent_id) BETWEEN 1 AND 64),
  operation_ref TEXT NOT NULL CHECK(length(operation_ref) BETWEEN 1 AND 256),
  principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 256),
  session_generation TEXT NOT NULL CHECK(length(session_generation) BETWEEN 1 AND 256),
  configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json) AND length(configuration_json)<=4096),
  state_sha256 TEXT NOT NULL UNIQUE CHECK(length(state_sha256)=64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'),
  encrypted_secrets BLOB NOT NULL CHECK(length(encrypted_secrets) BETWEEN 17 AND 4112),
  secret_nonce BLOB NOT NULL CHECK(length(secret_nonce)=12),
  secret_key_version INTEGER NOT NULL CHECK(secret_key_version BETWEEN 1 AND 2147483647),
  created_at_epoch_ms INTEGER NOT NULL CHECK(created_at_epoch_ms>=0),
  expires_at_epoch_ms INTEGER NOT NULL CHECK(expires_at_epoch_ms>created_at_epoch_ms AND expires_at_epoch_ms-created_at_epoch_ms<=600000),
  state TEXT NOT NULL CHECK(state IN ('PENDING','EXCHANGING','ADMITTED','DENIED','FAILED')),
  attempt_id TEXT CHECK(attempt_id IS NULL OR length(attempt_id) BETWEEN 1 AND 256),
  code_sha256 TEXT CHECK(code_sha256 IS NULL OR (length(code_sha256)=64 AND code_sha256 NOT GLOB '*[^0-9a-f]*')),
  id_token_sha256 TEXT CHECK(id_token_sha256 IS NULL OR (length(id_token_sha256)=64 AND id_token_sha256 NOT GLOB '*[^0-9a-f]*')),
  credential_sha256 TEXT CHECK(credential_sha256 IS NULL OR (length(credential_sha256)=64 AND credential_sha256 NOT GLOB '*[^0-9a-f]*')),
  UNIQUE(principal_id,operation_ref),
  CHECK ((state IN ('PENDING','DENIED') AND attempt_id IS NULL AND code_sha256 IS NULL)
    OR (state IN ('EXCHANGING','ADMITTED','FAILED') AND attempt_id IS NOT NULL AND code_sha256 IS NOT NULL)),
  CHECK ((state='ADMITTED') = (id_token_sha256 IS NOT NULL)),
  CHECK ((state='ADMITTED') = (credential_sha256 IS NOT NULL))
) STRICT;
CREATE INDEX google_oauth_pending_owner ON google_oauth_intent(principal_id,state,expires_at_epoch_ms);
ALTER TABLE google_exchange_connection ADD COLUMN admission_intent_id TEXT REFERENCES google_oauth_intent(intent_id);
CREATE UNIQUE INDEX google_initial_admission ON google_exchange_connection(admission_intent_id) WHERE admission_intent_id IS NOT NULL;
CREATE TRIGGER google_oauth_intent_immutable BEFORE UPDATE ON google_oauth_intent
WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.operation_ref IS NOT OLD.operation_ref
  OR NEW.principal_id IS NOT OLD.principal_id OR NEW.session_generation IS NOT OLD.session_generation
  OR NEW.configuration_json IS NOT OLD.configuration_json OR NEW.state_sha256 IS NOT OLD.state_sha256
  OR NEW.encrypted_secrets IS NOT OLD.encrypted_secrets OR NEW.secret_nonce IS NOT OLD.secret_nonce
  OR NEW.secret_key_version IS NOT OLD.secret_key_version OR NEW.created_at_epoch_ms IS NOT OLD.created_at_epoch_ms
  OR NEW.expires_at_epoch_ms IS NOT OLD.expires_at_epoch_ms
  OR NOT ((OLD.state='PENDING' AND NEW.state IN ('EXCHANGING','DENIED'))
    OR (OLD.state='EXCHANGING' AND NEW.state IN ('ADMITTED','FAILED')
      AND NEW.attempt_id IS OLD.attempt_id AND NEW.code_sha256 IS OLD.code_sha256))
BEGIN SELECT RAISE(ABORT,'google_oauth_intent_conflict'); END;
CREATE TRIGGER google_initial_admission_guard BEFORE INSERT ON google_exchange_connection
WHEN NEW.admission_intent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM google_oauth_intent i WHERE i.intent_id=NEW.admission_intent_id AND i.state='EXCHANGING'
    AND json_extract(i.configuration_json,'$.connection_id')=NEW.connection_id AND i.principal_id=NEW.principal_id
    AND json_extract(i.configuration_json,'$.oauth_client_id')=NEW.oauth_client_id
    AND json_extract(i.configuration_json,'$.google_subject')=NEW.google_subject
    AND json_extract(i.configuration_json,'$.google_email')=NEW.google_email
    AND NEW.credential_generation='oauth-grant:'||i.intent_id AND NEW.credential_revision=1
    AND NEW.state='AUTHORIZING' AND NEW.oauth_publishing_status='In production')
BEGIN SELECT RAISE(ABORT,'google_oauth_admission_conflict'); END;
INSERT INTO schema_state(key,value,updated_at) VALUES('google_oauth_intents_generation','google-oauth-intents-v1','2026-09-05T00:00:00Z');
