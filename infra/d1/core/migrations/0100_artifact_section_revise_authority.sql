-- Dedicated artifact section revision W2/W3 authority; existing research stages remain unchanged.
-- Dedicated artifact COW W2 authority: do not create synthetic research_workflow_run/attempt rows.
PRAGMA foreign_keys = ON;

CREATE TABLE artifact_section_revise_run (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
  protocol TEXT NOT NULL CHECK(protocol = 'eliotr.artifact.section.revise.v1'),
  report_intent_id TEXT NOT NULL,
  report_intent_revision INTEGER NOT NULL CHECK(report_intent_revision > 0),
  artifact_id TEXT NOT NULL,
  parent_revision INTEGER NOT NULL CHECK(parent_revision BETWEEN 1 AND 999999),
  section_contract_id TEXT NOT NULL CHECK(length(section_contract_id) BETWEEN 1 AND 128),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  authorization_receipt_ref TEXT NOT NULL CHECK(length(authorization_receipt_ref) BETWEEN 1 AND 256),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision > 0),
  purge_revision INTEGER NOT NULL CHECK(purge_revision >= 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  handler_generation TEXT NOT NULL CHECK(length(handler_generation) BETWEEN 1 AND 256),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB)) <= 65536),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  run_revision INTEGER NOT NULL CHECK(run_revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','CANCELLED','COMPLETED')),
  current_attempt_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(report_intent_id, report_intent_revision) REFERENCES operation_intent(intent_id, revision),
  FOREIGN KEY(artifact_id, parent_revision) REFERENCES artifact_revision(artifact_id, revision),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision) REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK((state = 'ACTIVE' AND current_attempt_ref IS NOT NULL) OR
        (state IN ('CANCELLED','COMPLETED') AND current_attempt_ref IS NOT NULL))
) STRICT;
CREATE INDEX artifact_section_revise_run_parent_idx
  ON artifact_section_revise_run(artifact_id, parent_revision, section_contract_id, state);
CREATE INDEX artifact_section_revise_run_owner_state_idx
  ON artifact_section_revise_run(principal_ref, state, updated_at);
CREATE UNIQUE INDEX artifact_section_revise_one_active_idx
  ON artifact_section_revise_run(artifact_id, parent_revision, section_contract_id)
  WHERE state = 'ACTIVE';

CREATE TABLE artifact_section_revise_attempt (
  operation_id TEXT NOT NULL REFERENCES artifact_section_revise_run(operation_id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number = 1),
  expected_run_revision INTEGER NOT NULL CHECK(expected_run_revision >= 1),
  attempt_ref TEXT NOT NULL UNIQUE CHECK(length(attempt_ref) BETWEEN 1 AND 128),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB)) <= 65536),
  request_sha256 TEXT NOT NULL UNIQUE CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  budget_receipt_ref TEXT NOT NULL CHECK(length(budget_receipt_ref) BETWEEN 1 AND 256),
  budget_expires_at_ms INTEGER NOT NULL,
  budget_max_total_usd REAL NOT NULL CHECK(budget_max_total_usd>=0 AND budget_max_total_usd<=1.7976931348623157e308),
  state TEXT NOT NULL CHECK(state IN ('STARTED','OUTPUT_RECORDED','COMMITTED','UNKNOWN','CANCELLED')),
  output_json TEXT CHECK(output_json IS NULL OR (json_valid(output_json) AND length(CAST(output_json AS BLOB)) <= 65536)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(operation_id, attempt_number),
  UNIQUE(operation_id, attempt_ref),
  CHECK((state IN ('STARTED','UNKNOWN','CANCELLED') AND output_json IS NULL) OR
        (state IN ('OUTPUT_RECORDED','COMMITTED') AND output_json IS NOT NULL))
) STRICT;
CREATE INDEX artifact_section_revise_attempt_binding_idx
  ON artifact_section_revise_attempt(attempt_ref, request_sha256, budget_receipt_ref, state);

-- This view is the database-time fence for pre-effect admission. A copied DRAFT,
-- purged scope, stale grant, policy, deployment, or artifact head yields no row.
CREATE VIEW artifact_section_revise_current AS
SELECT r.*, a.spec_digest, a.evidence_freeze_id, a.evidence_freeze_revision,
       b.intent_id AS parent_intent_id, b.intent_revision AS parent_intent_revision
FROM artifact_section_revise_run r
JOIN artifact_draft_head h
  ON (h.artifact_id, h.head_revision) = (r.artifact_id, r.parent_revision)
JOIN artifact_revision a
  ON (a.artifact_id, a.revision, a.status) = (r.artifact_id, r.parent_revision, 'DRAFT')
JOIN artifact_draft_binding b
  ON (b.artifact_id, b.revision) = (r.artifact_id, r.parent_revision)
JOIN owner_artifact_read_origin o
  ON (o.artifact_id,o.artifact_revision,o.reader_principal_ref)
   = (r.artifact_id,r.parent_revision,r.principal_ref)
JOIN scope_snapshot s
  ON (s.snapshot_id, s.revision, s.policy_authority_ref, s.purge_ledger_revision)
   = (r.scope_snapshot_id, r.scope_snapshot_revision, r.policy_authority_ref, r.purge_revision)
JOIN scope_access_grant_effective g
  ON (g.snapshot_id, g.snapshot_revision, g.principal_ref, g.credential_generation,
      g.policy_authority_ref, g.authorization_receipt_ref, g.state)
   = (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref, r.credential_generation,
      r.policy_authority_ref, r.authorization_receipt_ref, 'ACTIVE')
WHERE r.state = 'ACTIVE' AND o.origin_client_class = 'owner_pwa'
  AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday('now')
  AND r.purge_revision = COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
  AND julianday(g.expires_at) > julianday('now')
  AND json_type(g.allowed_use_json) = 'array'
  AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE (u.type, u.value) = ('text','research'))
  AND EXISTS (SELECT 1 FROM investigation_current_policy p
    WHERE (p.policy_generation, p.policy_authority_ref, p.state) = (r.policy_generation, r.policy_authority_ref, 'ACTIVE'))
  AND EXISTS (SELECT 1 FROM research_deployment_compatible d
    WHERE d.origin_deployment_generation = r.deployment_generation)
  AND EXISTS (SELECT 1 FROM operation_intent i
    WHERE (i.intent_id,i.revision,i.operation_kind,i.principal_ref)=(r.report_intent_id,r.report_intent_revision,'REPORT',r.principal_ref));

CREATE TRIGGER artifact_section_revise_run_shape_guard
BEFORE INSERT ON artifact_section_revise_run
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE json_extract(NEW.request_json, '$.protocol') IS NOT NEW.protocol
    OR json_extract(NEW.request_json, '$.operation_id') IS NOT NEW.operation_id
    OR json_extract(NEW.request_json, '$.report_intent_ref.id') IS NOT NEW.report_intent_id
    OR json_extract(NEW.request_json, '$.report_intent_ref.revision') IS NOT NEW.report_intent_revision
    OR json_extract(NEW.request_json, '$.report_admission_witness.protocol') IS NOT 'eliotr.artifact-section-report-admission.v1'
    OR json_extract(NEW.request_json, '$.report_admission_witness.decision_sha256') IS NOT
      (SELECT i.policy_decision_ref FROM operation_intent i
        WHERE (i.intent_id,i.revision)=(NEW.report_intent_id,NEW.report_intent_revision))
    OR json_extract(NEW.request_json, '$.report_admission_witness.request.artifact_ref.id') IS NOT NEW.artifact_id
    OR json_extract(NEW.request_json, '$.report_admission_witness.request.artifact_ref.revision') IS NOT NEW.parent_revision
    OR json_extract(NEW.request_json, '$.report_admission_witness.request.section_id') IS NOT NEW.section_contract_id
    OR json_extract(NEW.request_json, '$.report_admission_witness.request.expected_artifact_revision') IS NOT NEW.parent_revision
    OR json_extract(NEW.request_json, '$.report_admission_witness.request.idempotency_key') IS NOT NEW.idempotency_key
    OR NOT EXISTS (SELECT 1 FROM operation_intent i
      WHERE (i.intent_id,i.revision,i.operation_kind,i.principal_ref)
        = (NEW.report_intent_id,NEW.report_intent_revision,'REPORT',NEW.principal_ref))
    OR json_extract(NEW.request_json, '$.artifact_ref.id') IS NOT NEW.artifact_id
    OR json_extract(NEW.request_json, '$.artifact_ref.revision') IS NOT NEW.parent_revision
    OR json_extract(NEW.request_json, '$.section_id') IS NOT NEW.section_contract_id
    OR json_extract(NEW.request_json, '$.idempotency_key') IS NOT NEW.idempotency_key
    OR json_extract(NEW.request_json, '$.handler_generation') IS NOT NEW.handler_generation
    OR NOT EXISTS (SELECT 1 FROM artifact_draft_head h
      JOIN artifact_revision a ON (a.artifact_id,a.revision,a.status)=(h.artifact_id,h.head_revision,'DRAFT')
      JOIN owner_artifact_read_origin o ON (o.artifact_id,o.artifact_revision,o.reader_principal_ref)
        =(a.artifact_id,a.revision,NEW.principal_ref)
      JOIN scope_snapshot s ON (s.snapshot_id,s.revision,s.policy_authority_ref,s.purge_ledger_revision)
        =(NEW.scope_snapshot_id,NEW.scope_snapshot_revision,NEW.policy_authority_ref,NEW.purge_revision)
      JOIN scope_access_grant_effective g ON (g.snapshot_id,g.snapshot_revision,g.principal_ref,g.credential_generation,
        g.policy_authority_ref,g.authorization_receipt_ref,g.state)
        =(NEW.scope_snapshot_id,NEW.scope_snapshot_revision,NEW.principal_ref,NEW.credential_generation,
          NEW.policy_authority_ref,NEW.authorization_receipt_ref,'ACTIVE')
      WHERE (h.artifact_id,h.head_revision)=(NEW.artifact_id,NEW.parent_revision)
        AND s.invalidated_at IS NULL AND julianday(s.expires_at)>julianday('now')
        AND NEW.purge_revision=COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger),0)
        AND julianday(g.expires_at)>julianday('now')
        AND g.client_class='owner_pwa'
        AND json_type(g.allowed_use_json)='array'
        AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE (u.type,u.value)=('text','research'))
        AND EXISTS (SELECT 1 FROM investigation_current_policy p
          WHERE (p.policy_generation,p.policy_authority_ref,p.state)=(NEW.policy_generation,NEW.policy_authority_ref,'ACTIVE'))
        AND EXISTS (SELECT 1 FROM research_deployment_compatible d
          WHERE d.origin_deployment_generation=NEW.deployment_generation))
    OR NOT EXISTS (SELECT 1 FROM artifact_revision a JOIN artifact_draft_head h
      ON (h.artifact_id,h.head_revision)=(a.artifact_id,a.revision)
      JOIN owner_artifact_read_origin o ON (o.artifact_id,o.artifact_revision,o.reader_principal_ref)
        =(a.artifact_id,a.revision,NEW.principal_ref)
      WHERE (a.artifact_id,a.revision,a.status,a.spec_digest,a.evidence_freeze_id,a.evidence_freeze_revision)
        = (NEW.artifact_id,NEW.parent_revision,'DRAFT',json_extract(NEW.request_json,'$.spec_digest'),
           json_extract(NEW.request_json,'$.evidence_freeze_ref.id'),json_extract(NEW.request_json,'$.evidence_freeze_ref.revision')));
END;
CREATE TRIGGER artifact_section_revise_run_immutable
BEFORE UPDATE ON artifact_section_revise_run
WHEN (NEW.operation_id,NEW.protocol,NEW.artifact_id,NEW.parent_revision,NEW.section_contract_id,
      NEW.report_intent_id,NEW.report_intent_revision,NEW.principal_ref,NEW.credential_generation,NEW.deployment_generation,NEW.policy_generation,
      NEW.policy_authority_ref,NEW.authorization_receipt_ref,NEW.scope_snapshot_id,NEW.scope_snapshot_revision,
      NEW.purge_revision,NEW.idempotency_key,NEW.handler_generation,NEW.request_json,NEW.request_sha256,NEW.created_at)
  IS NOT (OLD.operation_id,OLD.protocol,OLD.artifact_id,OLD.parent_revision,OLD.section_contract_id,
      OLD.report_intent_id,OLD.report_intent_revision,OLD.principal_ref,OLD.credential_generation,OLD.deployment_generation,OLD.policy_generation,
      OLD.policy_authority_ref,OLD.authorization_receipt_ref,OLD.scope_snapshot_id,OLD.scope_snapshot_revision,
      OLD.purge_revision,OLD.idempotency_key,OLD.handler_generation,OLD.request_json,OLD.request_sha256,OLD.created_at)
  OR NOT ((OLD.state='ACTIVE' AND NEW.state IN ('ACTIVE','CANCELLED','COMPLETED'))
       AND NEW.run_revision=OLD.run_revision+CASE WHEN NEW.state=OLD.state THEN 0 ELSE 1 END)
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COW_IDENTITY_CONFLICT'); END;
CREATE TRIGGER artifact_section_revise_run_no_delete
BEFORE DELETE ON artifact_section_revise_run
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COW_IMMUTABLE'); END;

CREATE TRIGGER artifact_section_revise_attempt_shape_guard
BEFORE INSERT ON artifact_section_revise_attempt
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE json_extract(NEW.request_json, '$.request.protocol') IS NOT 'eliotr.artifact.section.revise.v1'
    OR json_extract(NEW.request_json, '$.request.operation_id') IS NOT NEW.operation_id
    OR json_extract(NEW.request_json, '$.attempt_ref') IS NOT NEW.attempt_ref
    OR json_extract(NEW.request_json, '$.request.artifact_ref.revision') IS NOT (SELECT parent_revision FROM artifact_section_revise_run WHERE operation_id=NEW.operation_id)
    OR NEW.state IS NOT 'STARTED' OR NEW.output_json IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM artifact_section_revise_current c JOIN artifact_section_revise_run r USING(operation_id)
      WHERE c.operation_id=NEW.operation_id AND r.run_revision=NEW.expected_run_revision
        AND r.current_attempt_ref=NEW.attempt_ref
        AND unixepoch('now')*1000 < NEW.budget_expires_at_ms);
END;
CREATE TRIGGER artifact_section_revise_attempt_budget_guard
BEFORE INSERT ON artifact_section_revise_attempt
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_SPEND_LIMIT')
  WHERE json_type(NEW.request_json,'$.request.report_admission_witness.material.spend_policy.rules') IS NOT 'array'
    OR (SELECT COUNT(*) FROM json_each(NEW.request_json,'$.request.report_admission_witness.material.spend_policy.rules') rule
        WHERE json_extract(rule.value,'$.stage') IN ('SYNTHESIZE','AUDIT_CLAIMS'))<>2
    OR (SELECT COUNT(DISTINCT json_extract(rule.value,'$.stage'))
        FROM json_each(NEW.request_json,'$.request.report_admission_witness.material.spend_policy.rules') rule
        WHERE json_extract(rule.value,'$.stage') IN ('SYNTHESIZE','AUDIT_CLAIMS'))<>2
    OR NEW.budget_max_total_usd IS NOT (SELECT SUM(json_extract(rule.value,'$.quote.max_total_usd'))
        FROM json_each(NEW.request_json,'$.request.report_admission_witness.material.spend_policy.rules') rule
        WHERE json_extract(rule.value,'$.stage') IN ('SYNTHESIZE','AUDIT_CLAIMS'))
    OR NEW.budget_receipt_ref IS NOT 'artifact-cow-budget-'||json_extract(NEW.request_json,'$.request.report_admission_witness.input_sha256');
END;
CREATE TRIGGER artifact_section_revise_attempt_transition
BEFORE UPDATE ON artifact_section_revise_attempt
WHEN (NEW.operation_id,NEW.attempt_number,NEW.expected_run_revision,NEW.attempt_ref,NEW.request_json,NEW.request_sha256,
      NEW.budget_receipt_ref,NEW.budget_expires_at_ms,NEW.budget_max_total_usd,NEW.created_at)
  IS NOT (OLD.operation_id,OLD.attempt_number,OLD.expected_run_revision,OLD.attempt_ref,OLD.request_json,OLD.request_sha256,
      OLD.budget_receipt_ref,OLD.budget_expires_at_ms,OLD.budget_max_total_usd,OLD.created_at)
  OR NOT ((OLD.state='STARTED' AND NEW.state IN ('OUTPUT_RECORDED','UNKNOWN','CANCELLED'))
       OR (OLD.state='OUTPUT_RECORDED' AND NEW.state='COMMITTED'))
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COW_ATTEMPT_CONFLICT'); END;
CREATE TRIGGER artifact_section_revise_attempt_no_delete
BEFORE DELETE ON artifact_section_revise_attempt
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COW_IMMUTABLE'); END;

-- COW model spend admission is a separate exact authority table so the fixed
-- research workflow stage range and migration 0096 trigger stay byte-for-byte
-- unchanged. Mirror the shape/authority/deployment/immutable guards from the
-- existing spend-admission table, and bind the one product protocol to this run.
CREATE TABLE artifact_section_revise_spend_admission (
  authorization_ref TEXT PRIMARY KEY CHECK(length(authorization_ref) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id) BETWEEN 1 AND 128),
  call_slot TEXT NOT NULL CHECK(call_slot IN ('SYNTHESIZE','INDEPENDENT_VERIFY')),
  workflow_operation_id TEXT NOT NULL REFERENCES artifact_section_revise_run(operation_id),
  stage_attempt_ref TEXT NOT NULL,
  stage_request_sha256 TEXT NOT NULL CHECK(length(stage_request_sha256)=64 AND stage_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  workflow_budget_receipt_ref TEXT NOT NULL,
  stage_request_json TEXT NOT NULL CHECK(json_valid(stage_request_json) AND length(CAST(stage_request_json AS BLOB)) <= 65536),
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK(intent_revision > 0),
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json) AND length(CAST(intent_json AS BLOB)) <= 65536),
  reservation_id TEXT NOT NULL,
  quote_ref TEXT NOT NULL,
  quote_json TEXT NOT NULL CHECK(json_valid(quote_json) AND length(CAST(quote_json AS BLOB)) <= 65536),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json) AND length(CAST(authority_json AS BLOB)) <= 65536),
  principal_ref TEXT NOT NULL,
  client_class TEXT NOT NULL CHECK(client_class='owner_pwa'),
  credential_generation TEXT NOT NULL,
  deployment_generation TEXT NOT NULL,
  policy_decision_ref TEXT NOT NULL,
  policy_generation TEXT NOT NULL,
  currentness_digest TEXT NOT NULL CHECK(length(currentness_digest)=64 AND currentness_digest NOT GLOB '*[^0-9a-f]*'),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision > 0),
  workflow_authorization_receipt_ref TEXT NOT NULL,
  route_ref TEXT NOT NULL,
  expected_deployment_json TEXT NOT NULL CHECK(json_valid(expected_deployment_json) AND length(CAST(expected_deployment_json AS BLOB)) <= 65536),
  approval_json TEXT NOT NULL CHECK(json_valid(approval_json) AND length(CAST(approval_json AS BLOB)) <= 65536),
  admission_revision INTEGER NOT NULL CHECK(admission_revision=1),
  admission_sha256 TEXT NOT NULL CHECK(length(admission_sha256)=64 AND admission_sha256 NOT GLOB '*[^0-9a-f]*'),
  decision_digest TEXT NOT NULL CHECK(length(decision_digest)=64 AND decision_digest NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB)) <= 65536),
  max_input_bytes INTEGER NOT NULL CHECK(max_input_bytes BETWEEN 1 AND 262144),
  max_output_bytes INTEGER NOT NULL CHECK(max_output_bytes BETWEEN 1 AND 262144),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workflow_operation_id,stage_attempt_ref,stage_request_sha256,call_slot),
  FOREIGN KEY(workflow_operation_id,stage_attempt_ref) REFERENCES artifact_section_revise_attempt(operation_id,attempt_ref),
  FOREIGN KEY(scope_snapshot_id,scope_snapshot_revision) REFERENCES scope_snapshot(snapshot_id,revision),
  CHECK(json_extract(quote_json,'$.reservation_id') IS reservation_id),
  CHECK(json_extract(quote_json,'$.quote_ref') IS quote_ref),
  CHECK(json_extract(intent_json,'$.intent_ref.id') IS intent_id),
  CHECK(json_extract(intent_json,'$.intent_ref.revision') IS intent_revision),
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK(julianday(expires_at)<=julianday(json_extract(quote_json,'$.expires_at'))),
  CHECK(julianday(expires_at)<=julianday(json_extract(authority_json,'$.expires_at')))
) STRICT;
CREATE INDEX artifact_section_revise_spend_lookup_idx
  ON artifact_section_revise_spend_admission(principal_ref,operation_id,workflow_operation_id,stage_attempt_ref,stage_request_sha256);
CREATE TRIGGER artifact_section_revise_spend_shape_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_COW_SPEND_ADMISSION_INVALID')
  WHERE json_extract(NEW.stage_request_json,'$.request.protocol') IS NOT 'eliotr.artifact.section.revise.v1'
    OR json_extract(NEW.stage_request_json,'$.attempt_ref') IS NOT NEW.stage_attempt_ref
    OR json_extract(NEW.stage_request_json,'$.request.operation_id') IS NOT NEW.workflow_operation_id
    OR json_extract(NEW.intent_json,'$.intent_ref.id') IS NOT NEW.intent_id
    OR json_extract(NEW.intent_json,'$.intent_ref.revision') IS NOT NEW.intent_revision
    OR json_extract(NEW.intent_json,'$.principal_ref') IS NOT NEW.principal_ref
    OR json_extract(NEW.intent_json,'$.operation_kind') IS NOT 'REPORT'
    OR json_extract(NEW.intent_json,'$.budget_reservation_ref') IS NOT NEW.reservation_id
    OR json_extract(NEW.quote_json,'$.reservation_id') IS NOT NEW.reservation_id
    OR json_extract(NEW.quote_json,'$.quote_ref') IS NOT NEW.quote_ref
    OR json_extract(NEW.quote_json,'$.operation_kind') IS NOT 'REPORT'
    OR json_extract(NEW.authority_json,'$.principal_ref') IS NOT NEW.principal_ref
    OR json_extract(NEW.authority_json,'$.client_class') IS NOT NEW.client_class
    OR json_extract(NEW.authority_json,'$.credential_generation') IS NOT NEW.credential_generation
    OR json_extract(NEW.authority_json,'$.deployment_generation') IS NOT NEW.deployment_generation
    OR json_extract(NEW.authority_json,'$.policy_decision_ref') IS NOT NEW.policy_decision_ref
    OR json_extract(NEW.authority_json,'$.policy_generation') IS NOT NEW.policy_generation
    OR json_extract(NEW.authority_json,'$.currentness_digest') IS NOT NEW.currentness_digest
    OR json_extract(NEW.authority_json,'$.scope_snapshot_ref.id') IS NOT NEW.scope_snapshot_id
    OR json_extract(NEW.authority_json,'$.scope_snapshot_ref.revision') IS NOT NEW.scope_snapshot_revision
    OR json_extract(NEW.expected_deployment_json,'$.route_ref') IS NOT NEW.route_ref
;
  SELECT RAISE(ABORT, 'ARTIFACT_COW_SPEND_ADMISSION_INVALID')
  WHERE json_extract(NEW.approval_json,'$.protocol') IS NOT 'eliotr.research-model-spend-approval.v1'
    OR json_extract(NEW.approval_json,'$.approved') IS NOT 1
    OR json_extract(NEW.approval_json,'$.authorization_ref') IS NOT NEW.authorization_ref
    OR json_extract(NEW.approval_json,'$.decision_digest') IS NOT NEW.decision_digest
    OR json_extract(NEW.approval_json,'$.policy_decision_ref') IS NOT NEW.policy_decision_ref
    OR json_extract(NEW.approval_json,'$.policy_generation') IS NOT NEW.policy_generation
    OR json_extract(NEW.approval_json,'$.currentness_digest') IS NOT NEW.currentness_digest
    OR json_extract(NEW.approval_json,'$.expires_at') IS NOT NEW.expires_at
    OR json_extract(NEW.approval_json,'$.expected_deployment.route_ref') IS NOT json_extract(NEW.expected_deployment_json,'$.route_ref')
    OR json_extract(NEW.approval_json,'$.expected_deployment.route_version') IS NOT json_extract(NEW.expected_deployment_json,'$.route_version')
    OR json_extract(NEW.approval_json,'$.expected_deployment.prompt_generation') IS NOT json_extract(NEW.expected_deployment_json,'$.prompt_generation')
    OR json_extract(NEW.approval_json,'$.expected_deployment.schema_generation') IS NOT json_extract(NEW.expected_deployment_json,'$.schema_generation')
    OR json_extract(NEW.approval_json,'$.expected_deployment.parameters_digest') IS NOT json_extract(NEW.expected_deployment_json,'$.parameters_digest')
    OR json_extract(NEW.approval_json,'$.expected_deployment.pricing_snapshot_ref') IS NOT json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref')
    OR NOT EXISTS (SELECT 1 FROM artifact_section_revise_current r JOIN artifact_section_revise_attempt a
      ON a.operation_id=r.operation_id AND a.attempt_ref=NEW.stage_attempt_ref
      WHERE r.operation_id=NEW.workflow_operation_id AND a.request_sha256=NEW.stage_request_sha256
        AND a.state='STARTED' AND a.output_json IS NULL AND a.request_json=NEW.stage_request_json
        AND a.budget_receipt_ref=NEW.workflow_budget_receipt_ref
        AND r.principal_ref=NEW.principal_ref
        AND r.credential_generation=NEW.credential_generation
        AND r.deployment_generation=NEW.deployment_generation
        AND r.policy_generation=NEW.policy_generation
        AND r.scope_snapshot_id=NEW.scope_snapshot_id AND r.scope_snapshot_revision=NEW.scope_snapshot_revision
        AND r.authorization_receipt_ref=NEW.workflow_authorization_receipt_ref);
END;
-- Both slots share one immutable W2 spending ceiling. This assertion runs in
-- the insertion transaction; two concurrent admissions cannot exceed the ceiling.
CREATE TRIGGER artifact_section_revise_spend_budget_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_SPEND_LIMIT')
  WHERE json_type(NEW.quote_json,'$.max_total_usd') NOT IN ('real','integer')
    OR json_extract(NEW.quote_json,'$.max_total_usd')<0
    OR NOT EXISTS (SELECT 1 FROM artifact_section_revise_attempt a
      WHERE a.operation_id=NEW.workflow_operation_id AND a.attempt_ref=NEW.stage_attempt_ref
        AND a.budget_receipt_ref=NEW.workflow_budget_receipt_ref
        AND json_extract(NEW.quote_json,'$.max_total_usd')+COALESCE(
          (SELECT SUM(json_extract(prior.quote_json,'$.max_total_usd'))
           FROM artifact_section_revise_spend_admission prior
           WHERE prior.workflow_operation_id=NEW.workflow_operation_id
             AND prior.stage_attempt_ref=NEW.stage_attempt_ref),0)<=a.budget_max_total_usd);
END;
CREATE TRIGGER artifact_section_revise_spend_deployment_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM dynamic_route_active_generation active
    JOIN dynamic_route_candidate candidate ON candidate.candidate_ref=active.candidate_ref AND candidate.candidate_sha256=active.candidate_sha256
    LEFT JOIN dynamic_route_active_qualification latest ON latest.route_ref=active.route_ref AND latest.route_version=active.route_version
    LEFT JOIN dynamic_route_qualification_proof proof ON proof.qualification_ref=latest.qualification_ref AND proof.proof_sha256=latest.qualification_sha256
      AND proof.route_ref=latest.route_ref AND proof.route_version=latest.route_version AND proof.candidate_ref=latest.candidate_ref AND proof.candidate_sha256=latest.candidate_sha256
    WHERE active.route_ref=NEW.route_ref AND active.route_version=json_extract(NEW.expected_deployment_json,'$.route_version')
      AND json_extract(candidate.candidate_json,'$.deployment.route_ref') IS NEW.route_ref
      AND json_extract(candidate.candidate_json,'$.deployment.route_version') IS json_extract(NEW.expected_deployment_json,'$.route_version')
      AND json_extract(candidate.candidate_json,'$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json,'$.prompt_generation')
      AND json_extract(candidate.candidate_json,'$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json,'$.schema_generation')
      AND json_extract(candidate.candidate_json,'$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json,'$.parameters_digest')
      AND json_extract(candidate.candidate_json,'$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref')
      AND ((latest.route_ref IS NULL AND json_extract(candidate.candidate_json,'$.qualification_expires_at') IS NOT NULL
          AND julianday(json_extract(candidate.candidate_json,'$.qualification_expires_at'))>julianday('now'))
        OR (latest.route_ref IS NOT NULL AND latest.candidate_ref IS active.candidate_ref AND latest.candidate_sha256 IS active.candidate_sha256
          AND proof.qualification_ref IS NOT NULL AND json_extract(proof.qualification_json,'$.qualification.tier') IS 'LIVE'
          AND julianday(json_extract(proof.qualification_json,'$.qualification.expires_at'))>julianday('now')))
  );
END;
CREATE TRIGGER artifact_section_revise_spend_immutable
BEFORE UPDATE ON artifact_section_revise_spend_admission
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COW_IMMUTABLE'); END;
CREATE TRIGGER artifact_section_revise_spend_no_delete
BEFORE DELETE ON artifact_section_revise_spend_admission
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COW_IMMUTABLE'); END;

-- The existing W3 records support exactly two authority locators. Legacy
-- research stage rows are backfilled by the default; the COW branch carries a
-- dedicated run FK and attempt_ref/request_sha256 in the existing stage columns.
ALTER TABLE budget_reservation ADD COLUMN workflow_binding_kind TEXT NOT NULL DEFAULT 'RESEARCH_STAGE'
  CHECK(workflow_binding_kind IN ('RESEARCH_STAGE','ARTIFACT_SECTION_REVISE'));
ALTER TABLE budget_reservation ADD COLUMN cow_operation_id TEXT REFERENCES artifact_section_revise_run(operation_id)
  CHECK((workflow_binding_kind='ARTIFACT_SECTION_REVISE' AND cow_operation_id IS NOT NULL) OR
        (workflow_binding_kind='RESEARCH_STAGE' AND cow_operation_id IS NULL));
ALTER TABLE research_model_attempt ADD COLUMN workflow_binding_kind TEXT NOT NULL DEFAULT 'RESEARCH_STAGE'
  CHECK(workflow_binding_kind IN ('RESEARCH_STAGE','ARTIFACT_SECTION_REVISE'));
ALTER TABLE research_model_attempt ADD COLUMN cow_operation_id TEXT REFERENCES artifact_section_revise_run(operation_id)
  CHECK((workflow_binding_kind='ARTIFACT_SECTION_REVISE' AND cow_operation_id IS NOT NULL) OR
        (workflow_binding_kind='RESEARCH_STAGE' AND cow_operation_id IS NULL));
CREATE TRIGGER budget_reservation_cow_locator_immutable
BEFORE UPDATE OF workflow_binding_kind,cow_operation_id ON budget_reservation
WHEN NEW.workflow_binding_kind IS NOT OLD.workflow_binding_kind OR NEW.cow_operation_id IS NOT OLD.cow_operation_id
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COW_IMMUTABLE'); END;
CREATE TRIGGER research_model_attempt_cow_locator_immutable
BEFORE UPDATE OF workflow_binding_kind,cow_operation_id ON research_model_attempt
WHEN NEW.workflow_binding_kind IS NOT OLD.workflow_binding_kind OR NEW.cow_operation_id IS NOT OLD.cow_operation_id
BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COW_IMMUTABLE'); END;
