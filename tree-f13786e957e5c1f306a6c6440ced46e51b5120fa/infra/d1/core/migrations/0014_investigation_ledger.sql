-- ER-08/ER-13: durable versioned Investigation ledger heads plus append-only events.
-- Additive only: existing investigation tables are untouched. Large payloads stay in R2
-- behind immutable handle refs; this migration stores only handles and digests.

CREATE TABLE IF NOT EXISTS investigation_ledger_head (
  investigation_id TEXT PRIMARY KEY CHECK(length(investigation_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000),
  protocol_version TEXT NOT NULL CHECK(protocol_version='eliotr.investigation.v1'),
  goal TEXT NOT NULL CHECK(length(goal) BETWEEN 1 AND 2000),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision BETWEEN 1 AND 1000000),
  evidence_grade TEXT NOT NULL CHECK(evidence_grade IN ('E0','E1','E2','E3')),
  lane TEXT NOT NULL CHECK(lane IN ('confirmatory','exploratory','mixed_with_declared_split')),
  lane_registrations_json TEXT NOT NULL CHECK(json_valid(lane_registrations_json) AND length(lane_registrations_json)<=8192),
  obligations_json TEXT NOT NULL CHECK(json_valid(obligations_json) AND length(obligations_json)<=16384),
  hypotheses_json TEXT NOT NULL CHECK(json_valid(hypotheses_json) AND length(hypotheses_json)<=16384),
  portfolio_ref TEXT NOT NULL CHECK(length(portfolio_ref) BETWEEN 1 AND 256),
  debt_refs_json TEXT NOT NULL CHECK(json_valid(debt_refs_json) AND length(debt_refs_json)<=8192),
  checkpoint_head INTEGER NOT NULL CHECK(checkpoint_head BETWEEN 0 AND 1000000),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  model_profile_ref TEXT NOT NULL CHECK(length(model_profile_ref) BETWEEN 1 AND 256),
  observed_execution TEXT CHECK(observed_execution IS NULL OR length(observed_execution) BETWEEN 1 AND 1024),
  observed_fidelity TEXT CHECK(observed_fidelity IS NULL OR length(observed_fidelity) BETWEEN 1 AND 1024),
  observed_assurance TEXT CHECK(observed_assurance IS NULL OR length(observed_assurance) BETWEEN 1 AND 1024),
  status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED','SUPERSEDED')),
  supersedes_id TEXT CHECK(supersedes_id IS NULL OR length(supersedes_id) BETWEEN 1 AND 128),
  supersession_reason TEXT CHECK(supersession_reason IS NULL OR length(supersession_reason) BETWEEN 1 AND 1024),
  event_head INTEGER NOT NULL CHECK(event_head BETWEEN 0 AND 1000000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS investigation_ledger_event (
  investigation_id TEXT NOT NULL CHECK(length(investigation_id) BETWEEN 1 AND 128),
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 1000000),
  event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK(kind IN ('CREATED','LANE_REGISTERED','OBLIGATION_REGISTERED','OBLIGATION_ACCEPTED','CHECKPOINT','HYPOTHESIS_RECORDED','OBSERVED','DEVIATION','SUPERSEDED','CLOSED','REOPENED')),
  payload_handle_ref TEXT NOT NULL CHECK(length(payload_handle_ref) BETWEEN 1 AND 256),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  actor_ref TEXT NOT NULL CHECK(length(actor_ref) BETWEEN 1 AND 256),
  verifier_ref TEXT CHECK(verifier_ref IS NULL OR length(verifier_ref) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  PRIMARY KEY(investigation_id, sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS investigation_ledger_idempotency_idx
  ON investigation_ledger_head(idempotency_key);

CREATE TRIGGER IF NOT EXISTS investigation_ledger_event_no_update
BEFORE UPDATE ON investigation_ledger_event
BEGIN SELECT RAISE(ABORT,'ledger events are append-only'); END;

CREATE TRIGGER IF NOT EXISTS investigation_ledger_event_no_delete
BEFORE DELETE ON investigation_ledger_event
BEGIN SELECT RAISE(ABORT,'ledger events are append-only'); END;

CREATE TRIGGER IF NOT EXISTS investigation_ledger_grade_protocol_frozen
BEFORE UPDATE ON investigation_ledger_head
WHEN OLD.evidence_grade IS NOT NEW.evidence_grade OR OLD.protocol_version IS NOT NEW.protocol_version
BEGIN SELECT RAISE(ABORT,'protocol/grade change requires explicit supersession'); END;

UPDATE schema_state SET value='core-v11-owner-orientation', updated_at='2026-09-05T00:00:00Z'
WHERE key='schema_generation';
INSERT INTO schema_state(key,value,updated_at) VALUES('investigation_ledger_generation','investigation-ledger-v1','2026-09-05T00:00:00Z');
