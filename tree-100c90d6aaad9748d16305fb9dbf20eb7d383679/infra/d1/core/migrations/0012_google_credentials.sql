-- OAuth credential ownership and CAS fencing. Legacy rows are deliberately NOT admitted.
-- No source, artifact, scope or exchange generation is created or modified here.
ALTER TABLE google_exchange_connection ADD COLUMN principal_id TEXT;
ALTER TABLE google_exchange_connection ADD COLUMN oauth_client_id TEXT;
ALTER TABLE google_exchange_connection ADD COLUMN credential_generation TEXT;
ALTER TABLE google_exchange_connection ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0
  CHECK (credential_revision >= 0 AND credential_revision < 9007199254740991);
ALTER TABLE google_exchange_connection ADD COLUMN oauth_publishing_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
  CHECK (oauth_publishing_status IN ('UNVERIFIED','Testing','In production'));
ALTER TABLE google_exchange_connection ADD COLUMN refresh_expires_at_epoch_ms INTEGER
  CHECK (refresh_expires_at_epoch_ms IS NULL OR (refresh_expires_at_epoch_ms >= 0 AND refresh_expires_at_epoch_ms <= 9007199254740991));
ALTER TABLE google_exchange_connection ADD COLUMN last_error_code TEXT;
-- Separate feature generation: core-v11 behavior is unchanged until Drive is composed.
INSERT INTO schema_state(key,value,updated_at) VALUES ('google_credentials_generation','google-credentials-v1','2026-09-05T00:00:00Z');
