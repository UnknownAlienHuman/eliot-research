-- ER-36 durable Workspace MCP candidate plans and exact readback observations.
-- These rows are server-issued candidate records only. They do not admit source
-- material, promote evidence, or perform a Google action.
CREATE TABLE workspace_mcp_plan (
  plan_id TEXT PRIMARY KEY CHECK(length(plan_id) BETWEEN 1 AND 256),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  auth_profile TEXT NOT NULL CHECK(auth_profile IN ('service-token','managed-oauth')),
  google_transport TEXT NOT NULL CHECK(google_transport='gemini-mcp'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint)=64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND length(plan_json) <= 65536),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state='ISSUED'),
  created_at TEXT NOT NULL,
  UNIQUE(principal_ref, deployment_generation, auth_profile, google_transport, idempotency_key)
) STRICT;

CREATE INDEX workspace_mcp_plan_owner_idx
  ON workspace_mcp_plan(principal_ref, deployment_generation, created_at DESC);

CREATE TABLE workspace_mcp_observation (
  observation_id TEXT PRIMARY KEY CHECK(length(observation_id) BETWEEN 1 AND 256),
  plan_id TEXT NOT NULL,
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  auth_profile TEXT NOT NULL CHECK(auth_profile IN ('service-token','managed-oauth')),
  google_transport TEXT NOT NULL CHECK(google_transport='gemini-mcp'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json) <= 32768),
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json) AND length(observation_json) <= 65536),
  observation_sha256 TEXT NOT NULL CHECK(length(observation_sha256)=64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*'),
  disposition TEXT NOT NULL CHECK(disposition IN ('OBSERVED_MATCH','OBSERVED_MISMATCH')),
  reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND length(reason_codes_json) <= 16384),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(plan_id, receipt_sha256),
  FOREIGN KEY(plan_id) REFERENCES workspace_mcp_plan(plan_id)
) STRICT;

CREATE INDEX workspace_mcp_observation_plan_idx
  ON workspace_mcp_observation(plan_id, observed_at DESC);
