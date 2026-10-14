-- Private #242 additive proposal: the sole publisher must allocate its filename
-- against the reconciled current migration frontier, separately from ER13.
-- No applied migration is changed. Admission uses existing 0021 PENDING requests
-- and existing operation intent/attempt/lease; there is no second query ledger.
-- Execute these guards before enabling the owned PENDING settlement path.

CREATE TRIGGER retrieval_query_pending_completion_authority
BEFORE UPDATE ON retrieval_query_result
WHEN OLD.state = 'PENDING' AND NEW.state = 'COMPLETE' AND NOT EXISTS (
  SELECT 1 FROM scope_snapshot s
  JOIN scope_access_grant_effective g ON g.snapshot_id = s.snapshot_id
    AND g.snapshot_revision = s.revision
    AND g.principal_ref = NEW.principal_ref AND g.client_class = NEW.client_class
    AND g.credential_generation = NEW.credential_generation
  WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision
    AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday('now')
    AND g.state = 'ACTIVE' AND g.policy_authority_ref = s.policy_authority_ref
    AND julianday(g.expires_at) > julianday('now')
    AND s.purge_ledger_revision = COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
    AND NOT EXISTS (
      SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (
        SELECT 1 FROM source_revision sr JOIN source src ON src.source_id = sr.source_id
        JOIN source_namespace_ownership o ON o.source_namespace_id = src.source_namespace_id
          AND o.status = 'ACTIVE'
        JOIN json_each(s.source_owner_generations_json) gen ON gen.key = member.value
        WHERE sr.source_revision_ref = member.value AND sr.purge_state = 'LIVE'
          AND sr.source_owner_generation = o.source_owner_generation
          AND gen.value = sr.source_owner_generation
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_AUTHORITY_STALE'); END;

CREATE TRIGGER retrieval_query_pending_completion_trace_binding
BEFORE UPDATE ON retrieval_query_result
WHEN OLD.state = 'PENDING' AND NEW.state = 'COMPLETE' AND NOT EXISTS (
  WITH incoming(body) AS (
    SELECT CASE WHEN json_extract(NEW.result_json, '$.protocol') = 'eliotr.retrieval-result.managed.v1'
      AND json_extract(NEW.result_json, '$.numeric_codec') = 'eliotr.json-number.ecma-json-finite.v1'
      THEN json_extract(NEW.result_json, '$.result') ELSE NEW.result_json END
  )
  SELECT 1 FROM incoming b JOIN retrieval_query_trace t JOIN scope_snapshot s
    ON s.snapshot_id = t.scope_snapshot_id AND s.revision = t.scope_snapshot_revision
  WHERE t.trace_id = NEW.trace_id AND t.revision = NEW.trace_revision
    AND t.scope_snapshot_id = NEW.scope_snapshot_id AND t.scope_snapshot_revision = NEW.scope_snapshot_revision
    AND json_extract(b.body, '$.trace.trace_ref.id') IS t.trace_id
    AND json_extract(b.body, '$.trace.trace_ref.revision') IS t.revision
    AND json_extract(b.body, '$.evidence_pack.trace_ref.id') IS t.trace_id
    AND json_extract(b.body, '$.evidence_pack.trace_ref.revision') IS t.revision
    AND json_extract(b.body, '$.evidence_pack.scope_snapshot_ref.id') IS NEW.scope_snapshot_id
    AND json_extract(b.body, '$.evidence_pack.scope_snapshot_ref.revision') IS NEW.scope_snapshot_revision
    AND json_extract(b.body, '$.trace.scope_snapshot.digest') IS s.snapshot_digest
    AND json_extract(b.body, '$.trace') IS json(t.trace_json)
    AND json_extract(b.body, '$.coverage_claim') IS NEW.coverage_claim
)
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_TRACE_CORRUPT'); END;
