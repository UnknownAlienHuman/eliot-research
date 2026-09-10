-- ER-27: explicit server-owned authorization for private REPORT drafts.
-- A scope grant permits research reads; it is not itself a REPORT decision.
-- This row records the separate decision and its complete currentness fence.
PRAGMA foreign_keys = ON;

CREATE TABLE research_report_admission (
  decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 256),
  decision_revision INTEGER NOT NULL CHECK(decision_revision = 1),
  decision TEXT NOT NULL CHECK(decision IN ('ALLOW','ALLOW_WITH_MINIMIZATION')),
  decision_json TEXT NOT NULL CHECK(json_valid(decision_json) AND length(CAST(decision_json AS BLOB)) <= 65536),
  decision_sha256 TEXT NOT NULL CHECK(length(decision_sha256) = 64 AND decision_sha256 NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND length(CAST(input_json AS BLOB)) <= 65536),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND length(CAST(policy_json AS BLOB)) <= 65536),
  policy_ref TEXT NOT NULL CHECK(length(policy_ref) BETWEEN 1 AND 256),
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  policy_expires_at TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 1 AND 256),
  intent_revision INTEGER NOT NULL CHECK(intent_revision = 1),
  outbox_id TEXT NOT NULL CHECK(length(outbox_id) BETWEEN 1 AND 256),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  client_class TEXT NOT NULL CHECK(client_class = 'owner_pwa'),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision > 0),
  scope_snapshot_digest TEXT NOT NULL CHECK(length(scope_snapshot_digest) = 64 AND scope_snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  authorization_receipt_ref TEXT NOT NULL CHECK(length(authorization_receipt_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  source_revision_refs_json TEXT NOT NULL CHECK(json_valid(source_revision_refs_json) AND json_type(source_revision_refs_json) = 'array'),
  requested_output_class TEXT NOT NULL CHECK(requested_output_class = 'private-draft'),
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 256),
  disclosure_ceiling TEXT NOT NULL CHECK(length(disclosure_ceiling) BETWEEN 1 AND 256),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(operation_id, principal_ref, idempotency_key),
  FOREIGN KEY(intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision),
  FOREIGN KEY(outbox_id) REFERENCES outbox(outbox_id)
) STRICT;

CREATE INDEX research_report_admission_run_idx
  ON research_report_admission(operation_id, principal_ref, idempotency_key);

-- The module performs the same reads before batching. This trigger is the
-- transaction-time fence that prevents a stale caller from minting admission.
CREATE TRIGGER research_report_admission_current_guard
BEFORE INSERT ON research_report_admission
WHEN NOT EXISTS (
  SELECT 1
  FROM research_workflow_run r
  JOIN scope_snapshot s ON s.snapshot_id = r.scope_snapshot_id
    AND s.revision = r.scope_snapshot_revision
  JOIN scope_access_grant g ON g.snapshot_id = r.scope_snapshot_id
    AND g.snapshot_revision = r.scope_snapshot_revision
    AND g.principal_ref = r.principal_ref
    AND g.client_class = NEW.client_class
    AND g.credential_generation = r.credential_generation
    AND g.authorization_receipt_ref = r.authorization_receipt_ref
  JOIN investigation_current_policy p ON p.policy_generation = r.policy_generation
    AND p.policy_authority_ref = r.policy_authority_ref
  JOIN investigation_current_deployment d ON d.deployment_generation = r.deployment_generation
  JOIN investigation_ledger_head h ON h.investigation_id = r.investigation_id
  WHERE r.operation_id = NEW.operation_id
    AND r.state = 'ACTIVE' AND r.next_stage_index = 17
    AND r.principal_ref = NEW.principal_ref
    AND r.credential_generation = NEW.credential_generation
    AND r.policy_generation = NEW.policy_generation
    AND r.policy_authority_ref = NEW.policy_authority_ref
    AND r.deployment_generation = NEW.deployment_generation
    AND r.scope_snapshot_id = NEW.scope_snapshot_id
    AND r.scope_snapshot_revision = NEW.scope_snapshot_revision
    AND s.snapshot_digest = NEW.scope_snapshot_digest
    AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday(NEW.created_at)
    AND g.state = 'ACTIVE' AND julianday(g.expires_at) > julianday(NEW.created_at)
    AND json_type(g.allowed_use_json) = 'array'
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type = 'text' AND u.value = 'research')
    AND g.policy_authority_ref = r.policy_authority_ref
    AND g.disclosure_ceiling = NEW.disclosure_ceiling
    AND p.state = 'ACTIVE' AND d.state = 'ACTIVE'
    AND h.revision = r.current_revision AND h.status = 'OPEN'
    AND h.principal_ref = r.principal_ref
    AND h.scope_snapshot_id = r.scope_snapshot_id
    AND h.scope_snapshot_revision = r.scope_snapshot_revision
    AND h.policy_generation = r.policy_generation
    AND h.policy_authority_ref = r.policy_authority_ref
    AND h.deployment_generation = r.deployment_generation
    AND json(s.member_source_revision_refs_json) = json(NEW.source_revision_refs_json)
)
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_AUTHORITY_STALE'); END;

CREATE TRIGGER research_report_admission_intent_guard
AFTER INSERT ON research_report_admission
WHEN NOT EXISTS (
  SELECT 1 FROM operation_intent i JOIN outbox o
    ON o.intent_id = i.intent_id AND o.intent_revision = i.revision
  WHERE i.intent_id = NEW.intent_id AND i.revision = NEW.intent_revision
    AND i.operation_kind = 'REPORT' AND i.principal_ref = NEW.principal_ref
    AND i.idempotency_key = NEW.idempotency_key
    AND i.policy_decision_ref = NEW.decision_id
    AND o.outbox_id = NEW.outbox_id
    AND o.topic = 'research.artifact-draft'
    AND o.payload_ref = i.payload_ref
)
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_INTENT_GUARD'); END;

CREATE TRIGGER research_report_admission_immutable
BEFORE UPDATE ON research_report_admission
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_CONFLICT'); END;

CREATE TRIGGER research_report_admission_no_delete
BEFORE DELETE ON research_report_admission
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_CONFLICT'); END;
