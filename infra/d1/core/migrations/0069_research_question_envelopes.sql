-- S24 / ER-13: replace the character quota with the existing full Research HTTP byte envelope.
-- Apply atomically through the D1 migration runner. Existing IDs, versions, goals, digests,
-- events, workflow references and authority masks remain byte-for-byte unchanged.
-- A staging copy avoids renaming the live table (which would retarget FKs/views/triggers).
-- The dependent research_workflow_run FK is NO ACTION; no cascaded data is deleted.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE investigation_ledger_head_s24_copy AS SELECT * FROM investigation_ledger_head;
DROP TABLE investigation_ledger_head;
CREATE TABLE investigation_ledger_head (
  investigation_id TEXT PRIMARY KEY CHECK(length(investigation_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000),
  protocol_version TEXT NOT NULL CHECK(protocol_version='eliotr.investigation.v1'),
  goal TEXT NOT NULL CHECK(length(CAST(goal AS BLOB)) BETWEEN 1 AND 262144),
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
INSERT INTO investigation_ledger_head SELECT * FROM investigation_ledger_head_s24_copy;
DROP TABLE investigation_ledger_head_s24_copy;

CREATE INDEX investigation_ledger_idempotency_idx
  ON investigation_ledger_head(idempotency_key);

CREATE TRIGGER investigation_ledger_grade_protocol_frozen
BEFORE UPDATE ON investigation_ledger_head
WHEN OLD.evidence_grade IS NOT NEW.evidence_grade OR OLD.protocol_version IS NOT NEW.protocol_version
BEGIN SELECT RAISE(ABORT,'protocol/grade change requires explicit supersession'); END;

CREATE TRIGGER ledger_cmd_head_insert BEFORE INSERT ON investigation_ledger_head
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_command c WHERE c.op_kind IN ('CREATE', 'SUPERSEDE')
AND c.nh_investigation_id IS NEW.investigation_id AND c.nh_revision IS NEW.revision AND c.nh_protocol_version IS NEW.protocol_version
AND c.nh_goal IS NEW.goal AND c.nh_scope_snapshot_id IS NEW.scope_snapshot_id AND c.nh_scope_snapshot_revision IS NEW.scope_snapshot_revision
AND c.nh_evidence_grade IS NEW.evidence_grade AND c.nh_lane IS NEW.lane AND c.nh_lane_registrations_json IS NEW.lane_registrations_json
AND c.nh_obligations_json IS NEW.obligations_json AND c.nh_hypotheses_json IS NEW.hypotheses_json AND c.nh_portfolio_ref IS NEW.portfolio_ref
AND c.nh_debt_refs_json IS NEW.debt_refs_json AND c.nh_checkpoint_head IS NEW.checkpoint_head AND c.nh_principal_ref IS NEW.principal_ref
AND c.nh_input_digest IS NEW.input_digest AND c.nh_policy_generation IS NEW.policy_generation AND c.nh_policy_authority_ref IS NEW.policy_authority_ref
AND c.nh_deployment_generation IS NEW.deployment_generation AND c.nh_idempotency_key IS NEW.idempotency_key AND c.nh_model_profile_ref IS NEW.model_profile_ref
AND c.nh_observed_execution IS NEW.observed_execution AND c.nh_observed_fidelity IS NEW.observed_fidelity AND c.nh_observed_assurance IS NEW.observed_assurance
AND c.nh_status IS NEW.status AND c.nh_supersedes_id IS NEW.supersedes_id AND c.nh_supersession_reason IS NEW.supersession_reason
AND c.nh_event_head IS NEW.event_head AND c.nh_created_at IS NEW.created_at AND c.nh_updated_at IS NEW.updated_at)
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: head insert without atomic command authorization'); END;

CREATE TRIGGER ledger_cmd_head_update BEFORE UPDATE ON investigation_ledger_head
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_command c WHERE NEW.revision = OLD.revision + 1 AND NEW.event_head = OLD.event_head + 1
AND OLD.revision IS c.expected_old_revision AND OLD.event_head IS c.expected_old_event_head
AND ((c.op_kind = 'APPEND' AND c.nh_investigation_id IS NEW.investigation_id AND c.nh_investigation_id IS OLD.investigation_id
AND c.nh_revision IS NEW.revision AND c.nh_protocol_version IS NEW.protocol_version AND c.nh_goal IS NEW.goal
AND c.nh_scope_snapshot_id IS NEW.scope_snapshot_id AND c.nh_scope_snapshot_revision IS NEW.scope_snapshot_revision
AND c.nh_evidence_grade IS NEW.evidence_grade AND c.nh_lane IS NEW.lane AND c.nh_lane_registrations_json IS NEW.lane_registrations_json
AND c.nh_obligations_json IS NEW.obligations_json AND c.nh_hypotheses_json IS NEW.hypotheses_json AND c.nh_portfolio_ref IS NEW.portfolio_ref
AND c.nh_debt_refs_json IS NEW.debt_refs_json AND c.nh_checkpoint_head IS NEW.checkpoint_head AND c.nh_principal_ref IS NEW.principal_ref
AND c.nh_input_digest IS NEW.input_digest AND c.nh_policy_generation IS NEW.policy_generation AND c.nh_policy_authority_ref IS NEW.policy_authority_ref
AND c.nh_deployment_generation IS NEW.deployment_generation AND c.nh_idempotency_key IS NEW.idempotency_key AND c.nh_model_profile_ref IS NEW.model_profile_ref
AND c.nh_observed_execution IS NEW.observed_execution AND c.nh_observed_fidelity IS NEW.observed_fidelity AND c.nh_observed_assurance IS NEW.observed_assurance
AND c.nh_status IS NEW.status AND c.nh_supersedes_id IS NEW.supersedes_id AND c.nh_supersession_reason IS NEW.supersession_reason
AND c.nh_event_head IS NEW.event_head AND c.nh_created_at IS NEW.created_at AND c.nh_updated_at IS NEW.updated_at)
OR (c.op_kind = 'SUPERSEDE' AND c.oh_investigation_id IS NEW.investigation_id AND c.oh_investigation_id IS OLD.investigation_id
AND c.oh_revision IS NEW.revision AND c.oh_protocol_version IS NEW.protocol_version AND c.oh_goal IS NEW.goal
AND c.oh_scope_snapshot_id IS NEW.scope_snapshot_id AND c.oh_scope_snapshot_revision IS NEW.scope_snapshot_revision
AND c.oh_evidence_grade IS NEW.evidence_grade AND c.oh_lane IS NEW.lane AND c.oh_lane_registrations_json IS NEW.lane_registrations_json
AND c.oh_obligations_json IS NEW.obligations_json AND c.oh_hypotheses_json IS NEW.hypotheses_json AND c.oh_portfolio_ref IS NEW.portfolio_ref
AND c.oh_debt_refs_json IS NEW.debt_refs_json AND c.oh_checkpoint_head IS NEW.checkpoint_head AND c.oh_principal_ref IS NEW.principal_ref
AND c.oh_input_digest IS NEW.input_digest AND c.oh_policy_generation IS NEW.policy_generation AND c.oh_policy_authority_ref IS NEW.policy_authority_ref
AND c.oh_deployment_generation IS NEW.deployment_generation AND c.oh_idempotency_key IS NEW.idempotency_key AND c.oh_model_profile_ref IS NEW.model_profile_ref
AND c.oh_observed_execution IS NEW.observed_execution AND c.oh_observed_fidelity IS NEW.observed_fidelity AND c.oh_observed_assurance IS NEW.observed_assurance
AND c.oh_status IS NEW.status AND c.oh_supersedes_id IS NEW.supersedes_id AND c.oh_supersession_reason IS NEW.supersession_reason
AND c.oh_event_head IS NEW.event_head AND c.oh_created_at IS NEW.created_at AND c.oh_updated_at IS NEW.updated_at)))
BEGIN SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: head update without atomic command authorization'); END;

CREATE TRIGGER ledger_cmd_head_no_delete BEFORE DELETE ON investigation_ledger_head
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: ledger heads are append-only; supersede instead of deleting'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('research_question_generation','research-question-v2-utf8-envelopes','2026-09-20T00:00:00Z');
PRAGMA defer_foreign_keys = OFF;
