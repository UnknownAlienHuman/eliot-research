-- Exact connection/transport qualification reuses the immutable one-shot MCP diagnostic challenge.
-- The bearer challenge token remains absent from this table and from every status receipt.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_connection_qualification_binding (
  challenge_id TEXT PRIMARY KEY REFERENCES mcp_client_diagnostic_challenge(challenge_id),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL CHECK(connection_revision BETWEEN 1 AND 2147483647),
  transport TEXT NOT NULL CHECK(transport IN ('MCP_WRITE','WEB_INBOX')),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  owner_credential_generation TEXT NOT NULL CHECK(length(owner_credential_generation) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  issued_at TEXT NOT NULL CHECK(julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK(julianday(expires_at) IS NOT NULL),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB)) BETWEEN 1 AND 24576),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  FOREIGN KEY(connection_id,connection_revision)
    REFERENCES computer_agent_connection(connection_id,revision),
  CHECK(json_extract(binding_json,'$.protocol') IS 'eliotr.computer-agent-qualification-binding.v1'),
  CHECK(json_extract(binding_json,'$.challenge_id') IS challenge_id),
  CHECK(json_extract(binding_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(binding_json,'$.connection_revision') IS connection_revision),
  CHECK(json_extract(binding_json,'$.transport') IS transport),
  CHECK(json_extract(binding_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(binding_json,'$.owner_credential_generation') IS owner_credential_generation),
  CHECK(json_extract(binding_json,'$.deployment_generation') IS deployment_generation),
  CHECK(json_extract(binding_json,'$.issued_at') IS issued_at),
  CHECK(json_extract(binding_json,'$.expires_at') IS expires_at),
  CHECK(json_extract(binding_json,'$.created_at') IS created_at),
  CHECK(created_at IS issued_at),
  CHECK(julianday(expires_at)>julianday(issued_at))
) STRICT;

CREATE INDEX computer_agent_connection_qualification_latest_idx
  ON computer_agent_connection_qualification_binding(
    owner_principal_ref,connection_id,connection_revision,transport,issued_at DESC,challenge_id DESC
  );

CREATE VIEW computer_agent_connection_qualification_observation AS
SELECT b.*,
  d.state AS challenge_state,
  d.auth_profile,
  d.observation_ref,
  d.observed_at,
  d.trace_id,
  d.verified_actor_ref,
  d.verified_credential_generation,
  d.verified_authentication_method,
  d.verified_expires_at,
  c.owner_principal_ref AS connection_owner_principal_ref,
  c.state AS connection_state,
  c.actor_issuer,
  c.actor_subject,
  c.transport_capabilities_json,
  c.task_kinds_json,
  cc.revision AS current_connection_revision,
  cc.state AS current_connection_state
FROM computer_agent_connection_qualification_binding b
JOIN mcp_client_diagnostic_challenge d ON d.challenge_id=b.challenge_id
JOIN computer_agent_connection c
  ON c.connection_id=b.connection_id AND c.revision=b.connection_revision
LEFT JOIN computer_agent_connection_current cc ON cc.connection_id=b.connection_id;

CREATE TRIGGER computer_agent_connection_qualification_insert_guard
BEFORE INSERT ON computer_agent_connection_qualification_binding
WHEN NOT EXISTS (
  SELECT 1 FROM mcp_client_diagnostic_challenge d
  JOIN computer_agent_connection_current c
    ON c.connection_id=NEW.connection_id AND c.revision=NEW.connection_revision
  WHERE d.challenge_id=NEW.challenge_id AND d.state='ISSUED'
    AND d.owner_principal_ref=NEW.owner_principal_ref
    AND d.owner_credential_generation=NEW.owner_credential_generation
    AND d.deployment_generation=NEW.deployment_generation
    AND d.auth_profile='service-token'
    AND d.issued_at=NEW.issued_at AND d.expires_at=NEW.expires_at
    AND c.owner_principal_ref=NEW.owner_principal_ref AND c.state='ENABLED'
    AND EXISTS (SELECT 1 FROM json_each(c.transport_capabilities_json) WHERE value=NEW.transport)
    AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value='RESEARCH_BRANCH_ANALYSIS')
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_QUALIFICATION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_connection_qualification_no_update
BEFORE UPDATE ON computer_agent_connection_qualification_binding
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_QUALIFICATION_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_connection_qualification_no_delete
BEFORE DELETE ON computer_agent_connection_qualification_binding
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_QUALIFICATION_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_qualification_generation','computer-agent-qualification-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
