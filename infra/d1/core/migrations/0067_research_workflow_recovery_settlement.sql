-- Permit readback-only recovery to settle an already-authorized W2 attempt after
-- its spend reservation expires.  A fresh provider invocation still requires
-- the original unexpired reservation: only the exact owner-authorized recovery
-- action for this run/stage can relax the settlement-time expiry check.
DROP TRIGGER research_workflow_output_authority;
CREATE TRIGGER research_workflow_output_authority BEFORE UPDATE ON research_workflow_attempt
WHEN NEW.state = 'OUTPUT_RECORDED' AND (
 (NEW.budget_expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
   AND NOT EXISTS (
     SELECT 1 FROM operation_intent i
     JOIN operation_attempt oa ON oa.intent_id=i.intent_id AND oa.intent_revision=i.revision
     JOIN research_workflow_run rr ON rr.operation_id=NEW.operation_id
     WHERE i.intent_id='research-recover:' || NEW.operation_id || ':' || NEW.stage_index
       AND i.revision=1 AND i.operation_kind='research.run.recover.v1'
       AND i.principal_ref=rr.principal_ref
       AND i.payload_ref='research-run:' || NEW.operation_id || ':' || NEW.stage_index
       AND i.policy_decision_ref='research-recovery-authorized:' || NEW.operation_id || ':' || NEW.stage_index
       AND oa.attempt_id='research-recover-attempt:' || NEW.operation_id || ':' || NEW.stage_index
       AND oa.attempt_number=1 AND oa.state IN ('CHECKPOINTED','SUCCEEDED')
   ))
 OR NOT EXISTS (SELECT 1 FROM research_workflow_current r WHERE r.operation_id = NEW.operation_id
   AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
   AND r.current_revision = NEW.expected_revision AND r.ledger_revision = NEW.expected_revision)
 OR json_extract(NEW.output_json, '$.object_ref') IS NOT ('workflow/' || NEW.request_sha256 || '/' || NEW.attempt_ref)
 OR json_extract(NEW.output_json, '$.byte_length') NOT BETWEEN 0 AND 8388608
 OR length(json_extract(NEW.output_json, '$.sha256')) IS NOT 64
 OR json_extract(NEW.output_json, '$.sha256') GLOB '*[^0-9a-f]*'
 OR json_extract(NEW.output_json, '$.residency.content_digest.digest') IS NOT json_extract(NEW.output_json, '$.sha256')
 OR json_extract(NEW.output_json, '$.residency.content_digest.algorithm') IS NOT 'sha256'
 OR json_extract(NEW.output_json, '$.residency.scope_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.scope_domain_id')
 OR json_extract(NEW.output_json, '$.residency.access_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.access_domain_id')
 OR json_extract(NEW.output_json, '$.residency.confidentiality_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.confidentiality_domain_id')
 OR json_extract(NEW.output_json, '$.residency.encryption_key_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.encryption_key_domain_id')
 OR json_extract(NEW.output_json, '$.residency.retention_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.retention_domain_id')
 OR json_extract(NEW.output_json, '$.residency.erasure_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.erasure_domain_id')
)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

DROP TRIGGER research_workflow_checkpoint_guard;
CREATE TRIGGER research_workflow_checkpoint_guard BEFORE INSERT ON research_workflow_checkpoint
WHEN NOT EXISTS (
 SELECT 1 FROM research_workflow_current r
 JOIN research_workflow_attempt a ON a.operation_id = r.operation_id AND a.stage_index = NEW.stage_index
 JOIN investigation_ledger_event e ON e.event_id = NEW.ledger_event_id
 WHERE r.operation_id = NEW.operation_id AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
 AND a.state = 'OUTPUT_RECORDED' AND a.request_sha256 = NEW.request_sha256
 AND (a.budget_expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
   OR EXISTS (
     SELECT 1 FROM operation_intent i
     JOIN operation_attempt oa ON oa.intent_id=i.intent_id AND oa.intent_revision=i.revision
     WHERE i.intent_id='research-recover:' || NEW.operation_id || ':' || NEW.stage_index
       AND i.revision=1 AND i.operation_kind='research.run.recover.v1'
       AND i.principal_ref=r.principal_ref
       AND i.payload_ref='research-run:' || NEW.operation_id || ':' || NEW.stage_index
       AND i.policy_decision_ref='research-recovery-authorized:' || NEW.operation_id || ':' || NEW.stage_index
       AND oa.attempt_id='research-recover-attempt:' || NEW.operation_id || ':' || NEW.stage_index
       AND oa.attempt_number=1 AND oa.state IN ('CHECKPOINTED','SUCCEEDED')
   ))
 AND r.current_revision = a.expected_revision AND r.ledger_revision = a.expected_revision + 1
 AND e.investigation_id = r.investigation_id AND e.sequence = r.event_head AND e.kind = 'CHECKPOINT'
 AND e.actor_ref = r.principal_ref AND e.verifier_ref IS NULL
 AND e.payload_handle_ref = json_extract(a.output_json, '$.object_ref')
 AND e.payload_digest = json_extract(a.output_json, '$.sha256')
 AND NEW.ledger_event_id = 'wcp:' || NEW.request_sha256
 AND json_extract(NEW.receipt_json, '$.protocol') = 'eliotr.workflow-checkpoint.v1'
 AND json_extract(NEW.receipt_json, '$.operation_id') = r.operation_id
 AND json_extract(NEW.receipt_json, '$.request_sha256') = a.request_sha256
 AND json_extract(NEW.receipt_json, '$.stage') = json_extract(a.request_json, '$.stage')
 AND json_extract(NEW.receipt_json, '$.attempt_ref') = a.attempt_ref
 AND json_extract(NEW.receipt_json, '$.receipt_ref') = 'wcp:' || NEW.request_sha256
 AND json_extract(NEW.receipt_json, '$.investigation_ref.id') = r.investigation_id
 AND json_extract(NEW.receipt_json, '$.investigation_ref.revision') = r.ledger_revision
 AND json_extract(NEW.receipt_json, '$.input_manifest_ref') = json_extract(a.request_json, '$.input_manifest.object_ref')
 AND json_extract(NEW.receipt_json, '$.output_manifest') = a.output_json
 AND json_extract(NEW.receipt_json, '$.budget_receipt_ref') = a.budget_receipt_ref
 AND json_extract(NEW.receipt_json, '$.cancellation_checked_at') = NEW.created_at
 AND json_extract(NEW.receipt_json, '$.engine_state') = CASE WHEN NEW.stage_index = 17 THEN 'ENGINE_COMPLETED' ELSE 'CHECKPOINTED' END
)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;
