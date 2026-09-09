CREATE TABLE google_exchange_provisioning_intent (
  principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 256),
  operation_ref TEXT NOT NULL CHECK(length(operation_ref) BETWEEN 1 AND 256),
  connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 256) REFERENCES google_exchange_connection(connection_id),
  expected_credential_generation TEXT NOT NULL CHECK(length(expected_credential_generation) BETWEEN 1 AND 256),
  expected_credential_revision INTEGER NOT NULL CHECK (expected_credential_revision > 0 AND expected_credential_revision < 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('PENDING','QUALIFIED','ACTIVATED','FAILED')),
  folder_id TEXT CHECK(folder_id IS NULL OR length(folder_id) BETWEEN 1 AND 256),
  spreadsheet_id TEXT CHECK(spreadsheet_id IS NULL OR length(spreadsheet_id) BETWEEN 1 AND 256),
  sheet_ids_json TEXT CHECK (sheet_ids_json IS NULL OR (json_valid(sheet_ids_json) AND length(sheet_ids_json) <= 4096)),
  start_page_token TEXT CHECK(start_page_token IS NULL OR length(start_page_token) BETWEEN 1 AND 1024),
  generation_id TEXT CHECK(generation_id IS NULL OR length(generation_id) BETWEEN 1 AND 256),
  failure_code TEXT CHECK(failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK(length(updated_at) BETWEEN 1 AND 64),
  PRIMARY KEY (principal_id, operation_ref),
  UNIQUE (connection_id, generation_id)
) STRICT;

CREATE INDEX google_exchange_provisioning_connection_idx
  ON google_exchange_provisioning_intent(connection_id, state, updated_at);

INSERT INTO schema_state(key,value,updated_at)
  VALUES ('google_exchange_provisioning_generation','google-exchange-provisioning-v1','2026-09-09T00:00:00Z');
