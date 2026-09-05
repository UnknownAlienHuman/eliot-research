-- Explicit read authority; admission/upload permission is never a read grant.
CREATE TABLE scope_read_policy (
  source_namespace_id TEXT NOT NULL,
  principal_ref TEXT NOT NULL,
  client_class TEXT NOT NULL CHECK (client_class = 'owner_pwa'),
  policy_ref TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  allowed_use_json TEXT NOT NULL CHECK (json_valid(allowed_use_json)),
  disclosure_ceiling TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','REVOKED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_namespace_id, principal_ref, client_class)
) STRICT;

CREATE INDEX scope_read_policy_principal_idx ON scope_read_policy(principal_ref, client_class, state, expires_at);

-- Synchronous bounded operation: reservation -> frozen scope -> immutable result/readback.
CREATE TABLE orientation_request (
  operation_id TEXT PRIMARY KEY,
  principal_ref TEXT NOT NULL,
  client_class TEXT NOT NULL CHECK (client_class = 'owner_pwa'),
  credential_generation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','COMPLETE','INVALIDATED')),
  snapshot_id TEXT,
  snapshot_revision INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 450000)),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(principal_ref, client_class, credential_generation, idempotency_key),
  FOREIGN KEY(snapshot_id, snapshot_revision) REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK ((snapshot_id IS NULL) = (snapshot_revision IS NULL)),
  CHECK ((result_json IS NULL) = (result_digest IS NULL)),
  CHECK (state <> 'COMPLETE' OR (snapshot_id IS NOT NULL AND result_json IS NOT NULL))
) STRICT;
CREATE INDEX orientation_scope_idx ON orientation_request(snapshot_id, snapshot_revision);

CREATE TRIGGER orientation_request_identity_immutable
BEFORE UPDATE ON orientation_request
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.principal_ref IS NOT OLD.principal_ref
 OR NEW.client_class IS NOT OLD.client_class OR NEW.credential_generation IS NOT OLD.credential_generation
 OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_digest IS NOT OLD.request_digest
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.snapshot_id IS NOT NULL AND (NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.snapshot_revision IS NOT OLD.snapshot_revision))
 OR (OLD.state <> 'PREPARED' AND NEW.state <> 'INVALIDATED')
 OR (NEW.state = 'INVALIDATED' AND (NEW.result_json IS NOT NULL OR NEW.result_digest IS NOT NULL))
BEGIN
 SELECT RAISE(ABORT, 'orientation identity/result is immutable');
END;

CREATE TRIGGER orientation_snapshot_invalidation
AFTER UPDATE OF invalidated_at ON scope_snapshot
WHEN NEW.invalidated_at IS NOT NULL
BEGIN
 UPDATE orientation_request SET state='INVALIDATED', result_json=NULL, result_digest=NULL
 WHERE snapshot_id=NEW.snapshot_id AND snapshot_revision=NEW.revision;
END;

CREATE TRIGGER orientation_source_purge
AFTER UPDATE OF purge_state ON source_revision
WHEN NEW.purge_state <> 'LIVE'
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SOURCE_NOT_LIVE'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM json_each(member_source_revision_refs_json) m
   WHERE m.value=NEW.source_revision_ref);
END;

CREATE TRIGGER orientation_read_policy_changed
AFTER UPDATE ON scope_read_policy
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='READ_POLICY_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM scope_access_grant g
   WHERE g.snapshot_id=scope_snapshot.snapshot_id AND g.snapshot_revision=scope_snapshot.revision
   AND g.principal_ref=OLD.principal_ref AND g.client_class=OLD.client_class);
END;

CREATE TRIGGER orientation_read_policy_deleted
AFTER DELETE ON scope_read_policy
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='READ_POLICY_DELETED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM scope_access_grant g
   WHERE g.snapshot_id=scope_snapshot.snapshot_id AND g.snapshot_revision=scope_snapshot.revision
   AND g.principal_ref=OLD.principal_ref AND g.client_class=OLD.client_class);
END;

CREATE TRIGGER orientation_grant_revoked
AFTER UPDATE ON scope_access_grant
WHEN NEW.state <> 'ACTIVE' OR NEW.policy_authority_ref IS NOT OLD.policy_authority_ref
 OR NEW.allowed_use_json IS NOT OLD.allowed_use_json OR NEW.disclosure_ceiling IS NOT OLD.disclosure_ceiling
 OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
 UPDATE orientation_request SET state='INVALIDATED', result_json=NULL, result_digest=NULL
 WHERE snapshot_id=OLD.snapshot_id AND snapshot_revision=OLD.snapshot_revision
 AND principal_ref=OLD.principal_ref AND client_class=OLD.client_class AND credential_generation=OLD.credential_generation;
END;

CREATE TRIGGER orientation_grant_deleted
AFTER DELETE ON scope_access_grant
BEGIN
 UPDATE orientation_request SET state='INVALIDATED', result_json=NULL, result_digest=NULL
 WHERE snapshot_id=OLD.snapshot_id AND snapshot_revision=OLD.snapshot_revision
 AND principal_ref=OLD.principal_ref AND client_class=OLD.client_class AND credential_generation=OLD.credential_generation;
END;

CREATE TRIGGER orientation_project_source_membership_insert
AFTER INSERT ON project_source_membership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_project_source_membership_update
AFTER UPDATE ON project_source_membership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_project_source_membership_delete
AFTER DELETE ON project_source_membership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_source_tag_insert
AFTER INSERT ON source_tag
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_source_tag_update
AFTER UPDATE ON source_tag
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_source_tag_delete
AFTER DELETE ON source_tag
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_project_update
AFTER UPDATE ON project
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_project_delete
AFTER DELETE ON project
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_source_insert
AFTER INSERT ON source
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_source_update
AFTER UPDATE ON source
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_source_delete
AFTER DELETE ON source
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_source_namespace_ownership_update
AFTER UPDATE ON source_namespace_ownership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

CREATE TRIGGER orientation_source_namespace_ownership_delete
AFTER DELETE ON source_namespace_ownership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL AND EXISTS (SELECT 1 FROM orientation_request o
   WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision);
END;

-- Cache discriminator only, never a replacement for source/policy authority. Every input mutation advances it.
CREATE TABLE orientation_authority_epoch (
 singleton INTEGER PRIMARY KEY CHECK (singleton=1), generation INTEGER NOT NULL CHECK (generation>0)
) STRICT;
INSERT INTO orientation_authority_epoch VALUES (1,1);
CREATE TRIGGER orientation_epoch_source_insert AFTER INSERT ON source
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_update AFTER UPDATE ON source
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_delete AFTER DELETE ON source
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_revision_insert AFTER INSERT ON source_revision
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_revision_update AFTER UPDATE ON source_revision
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_revision_delete AFTER DELETE ON source_revision
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_namespace_ownership_insert AFTER INSERT ON source_namespace_ownership
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_namespace_ownership_update AFTER UPDATE ON source_namespace_ownership
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_namespace_ownership_delete AFTER DELETE ON source_namespace_ownership
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_admission_decision_insert AFTER INSERT ON source_admission_decision
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_admission_decision_update AFTER UPDATE ON source_admission_decision
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_admission_decision_delete AFTER DELETE ON source_admission_decision
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_bundle_ingest_operation_insert AFTER INSERT ON bundle_ingest_operation
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_bundle_ingest_operation_update AFTER UPDATE ON bundle_ingest_operation
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_bundle_ingest_operation_delete AFTER DELETE ON bundle_ingest_operation
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_read_policy_insert AFTER INSERT ON scope_read_policy
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_read_policy_update AFTER UPDATE ON scope_read_policy
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_read_policy_delete AFTER DELETE ON scope_read_policy
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_access_grant_insert AFTER INSERT ON scope_access_grant
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_access_grant_update AFTER UPDATE ON scope_access_grant
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_access_grant_delete AFTER DELETE ON scope_access_grant
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_snapshot_insert AFTER INSERT ON scope_snapshot
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_snapshot_update AFTER UPDATE ON scope_snapshot
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_scope_snapshot_delete AFTER DELETE ON scope_snapshot
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_project_insert AFTER INSERT ON project
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_project_update AFTER UPDATE ON project
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_project_delete AFTER DELETE ON project
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_project_source_membership_insert AFTER INSERT ON project_source_membership
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_project_source_membership_update AFTER UPDATE ON project_source_membership
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_project_source_membership_delete AFTER DELETE ON project_source_membership
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_tag_insert AFTER INSERT ON source_tag
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_tag_update AFTER UPDATE ON source_tag
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_source_tag_delete AFTER DELETE ON source_tag
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_purge_ledger_insert AFTER INSERT ON purge_ledger
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_purge_ledger_update AFTER UPDATE ON purge_ledger
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER orientation_epoch_purge_ledger_delete AFTER DELETE ON purge_ledger
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;

UPDATE schema_state SET value='core-v11-owner-orientation', updated_at='2026-09-05T00:00:00Z'
WHERE key='schema_generation';
