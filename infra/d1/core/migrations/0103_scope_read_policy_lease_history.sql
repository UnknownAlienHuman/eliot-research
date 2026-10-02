-- One atomic renewal batch: PREPARED receipt, exact policy CAS, APPLIED receipt.
-- Policy history is shared; login never writes into every previous snapshot.
CREATE TABLE scope_read_policy_lease_refresh_receipt (
  receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  refresh_id TEXT NOT NULL UNIQUE CHECK(
    length(refresh_id)=84 AND substr(refresh_id,1,20)='scope-lease-refresh-' AND
    substr(refresh_id,21) NOT GLOB '*[^0-9a-f]*'
  ),
  source_namespace_id TEXT NOT NULL CHECK(length(source_namespace_id) BETWEEN 1 AND 256),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  client_class TEXT NOT NULL CHECK(client_class='owner_pwa'),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  access_expires_at TEXT NOT NULL CHECK(
    access_expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(access_expires_at) IS NOT NULL AND
    strftime('%Y-%m-%dT%H:%M:%fZ',access_expires_at) IS access_expires_at
  ),
  owner_incarnation_ref TEXT NOT NULL CHECK(length(owner_incarnation_ref) BETWEEN 1 AND 256),
  source_owner_generation TEXT NOT NULL CHECK(length(source_owner_generation) BETWEEN 1 AND 256),
  ownership_record_revision INTEGER NOT NULL CHECK(ownership_record_revision>0),
  source_admission_policy_revision INTEGER NOT NULL CHECK(source_admission_policy_revision>0),
  policy_ref TEXT NOT NULL CHECK(length(policy_ref) BETWEEN 1 AND 256),
  old_generation INTEGER NOT NULL CHECK(old_generation>0),
  new_generation INTEGER NOT NULL CHECK(new_generation=old_generation+1),
  old_allowed_use_json TEXT NOT NULL CHECK(json_valid(old_allowed_use_json) AND json_type(old_allowed_use_json)='array'),
  old_disclosure_ceiling TEXT NOT NULL CHECK(length(old_disclosure_ceiling) BETWEEN 1 AND 256),
  old_created_at TEXT NOT NULL,
  old_expires_at TEXT NOT NULL CHECK(
    old_expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(old_expires_at) IS NOT NULL AND
    strftime('%Y-%m-%dT%H:%M:%fZ',old_expires_at) IS old_expires_at
  ),
  new_expires_at TEXT NOT NULL CHECK(
    new_expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(new_expires_at) IS NOT NULL AND
    strftime('%Y-%m-%dT%H:%M:%fZ',new_expires_at) IS new_expires_at
  ),
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at
  ),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','APPLIED')),
  CHECK(julianday(old_expires_at)<julianday(new_expires_at)),
  CHECK(new_expires_at=access_expires_at),
  CHECK(julianday(created_at)<julianday(access_expires_at))
) STRICT;

CREATE INDEX scope_read_policy_lease_receipt_owner_idx
  ON scope_read_policy_lease_refresh_receipt(principal_ref,client_class,created_at,refresh_id);


CREATE INDEX scope_read_policy_lease_prepared_owner_idx
  ON scope_read_policy_lease_refresh_receipt(principal_ref,client_class,source_namespace_id) WHERE state='PREPARED';
CREATE INDEX scope_read_policy_lease_applied_sequence_idx
  ON scope_read_policy_lease_refresh_receipt(receipt_sequence) WHERE state='APPLIED';

CREATE TABLE scope_read_policy_history_event (
  history_event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  source_namespace_id TEXT NOT NULL, principal_ref TEXT NOT NULL, client_class TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('LEASE_REFRESH','SEMANTIC_CHANGE','POLICY_INSERT','POLICY_DELETE')),
  receipt_sequence INTEGER UNIQUE REFERENCES scope_read_policy_lease_refresh_receipt(receipt_sequence),
  refresh_id TEXT UNIQUE REFERENCES scope_read_policy_lease_refresh_receipt(refresh_id),
  old_policy_ref TEXT, old_generation INTEGER, old_allowed_use_json TEXT, old_disclosure_ceiling TEXT,
  old_state TEXT, old_expires_at TEXT, old_created_at TEXT,
  new_policy_ref TEXT, new_generation INTEGER, new_allowed_use_json TEXT, new_disclosure_ceiling TEXT,
  new_state TEXT, new_expires_at TEXT, new_created_at TEXT,
  created_at TEXT NOT NULL,
  CHECK((event_kind='LEASE_REFRESH' AND receipt_sequence IS NOT NULL AND refresh_id IS NOT NULL)
    OR (event_kind<>'LEASE_REFRESH' AND receipt_sequence IS NULL AND refresh_id IS NULL))
) STRICT;
CREATE INDEX scope_read_policy_history_key_idx ON scope_read_policy_history_event
  (principal_ref,client_class,source_namespace_id,history_event_sequence);

-- One retained identity per policy key, including deleted keys. Endpoint seeks
-- enumerate policy identities, never the entire login history.
CREATE TABLE scope_read_policy_identity (
  source_namespace_id TEXT NOT NULL, principal_ref TEXT NOT NULL, client_class TEXT NOT NULL,
  birth_sequence INTEGER NOT NULL, last_event_sequence INTEGER NOT NULL, semantic_sequence INTEGER NOT NULL,
  PRIMARY KEY(source_namespace_id,principal_ref,client_class)
) STRICT, WITHOUT ROWID;
CREATE INDEX scope_read_policy_identity_owner_idx ON scope_read_policy_identity(principal_ref,client_class,source_namespace_id);
INSERT INTO scope_read_policy_identity SELECT source_namespace_id,principal_ref,client_class,0,0,0 FROM scope_read_policy;

CREATE TABLE scope_read_policy_snapshot_baseline (
  snapshot_id TEXT NOT NULL, snapshot_revision INTEGER NOT NULL,
  history_event_sequence_floor INTEGER NOT NULL, receipt_sequence_floor INTEGER NOT NULL,
  pre_migration_semantic INTEGER NOT NULL CHECK(pre_migration_semantic IN (0,1)),
  PRIMARY KEY(snapshot_id,snapshot_revision),
  FOREIGN KEY(snapshot_id,snapshot_revision) REFERENCES scope_snapshot(snapshot_id,revision)
) STRICT, WITHOUT ROWID;
INSERT INTO scope_read_policy_snapshot_baseline
  SELECT snapshot_id,revision,0,0,CASE WHEN invalidation_reason IN ('READ_POLICY_CHANGED','READ_POLICY_DELETED') THEN 1 ELSE 0 END
  FROM scope_snapshot;
CREATE TRIGGER scope_read_policy_snapshot_baseline_insert AFTER INSERT ON scope_snapshot BEGIN
  INSERT INTO scope_read_policy_snapshot_baseline VALUES(NEW.snapshot_id,NEW.revision,
    COALESCE((SELECT MAX(history_event_sequence) FROM scope_read_policy_history_event),0),
    COALESCE((SELECT MAX(receipt_sequence) FROM scope_read_policy_lease_refresh_receipt WHERE state='APPLIED'),0),0);
END;
CREATE TRIGGER scope_read_policy_snapshot_baseline_no_update BEFORE UPDATE ON scope_read_policy_snapshot_baseline
  BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER scope_read_policy_snapshot_baseline_no_delete BEFORE DELETE ON scope_read_policy_snapshot_baseline
  BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER scope_read_policy_history_event_no_update BEFORE UPDATE ON scope_read_policy_history_event
  BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER scope_read_policy_history_event_no_delete BEFORE DELETE ON scope_read_policy_history_event
  BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER scope_read_policy_history_continuity BEFORE INSERT ON scope_read_policy_history_event
WHEN EXISTS(SELECT 1 FROM scope_read_policy_identity i JOIN scope_read_policy_history_event p
  ON p.history_event_sequence=i.last_event_sequence WHERE i.source_namespace_id=NEW.source_namespace_id
  AND i.principal_ref=NEW.principal_ref AND i.client_class=NEW.client_class AND (p.new_policy_ref IS NOT NEW.old_policy_ref OR p.new_generation IS NOT NEW.old_generation OR p.new_allowed_use_json IS NOT NEW.old_allowed_use_json OR p.new_disclosure_ceiling IS NOT NEW.old_disclosure_ceiling OR p.new_state IS NOT NEW.old_state OR p.new_expires_at IS NOT NEW.old_expires_at OR p.new_created_at IS NOT NEW.old_created_at))
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_HISTORY_DISCONTINUITY'); END;
CREATE TRIGGER scope_read_policy_history_receipt_guard BEFORE INSERT ON scope_read_policy_history_event
WHEN NEW.event_kind='LEASE_REFRESH' AND NOT EXISTS (
  SELECT 1 FROM scope_read_policy_lease_refresh_receipt r
  WHERE r.receipt_sequence=NEW.receipt_sequence AND r.refresh_id=NEW.refresh_id AND r.state='APPLIED'
    AND r.source_namespace_id=NEW.source_namespace_id AND r.principal_ref=NEW.principal_ref
    AND r.client_class=NEW.client_class AND r.policy_ref=NEW.old_policy_ref
    AND r.old_generation=NEW.old_generation AND r.new_generation=NEW.new_generation
    AND r.old_allowed_use_json=NEW.old_allowed_use_json AND r.old_disclosure_ceiling=NEW.old_disclosure_ceiling
    AND r.old_created_at=NEW.old_created_at AND r.old_expires_at=NEW.old_expires_at
    AND r.new_expires_at=NEW.new_expires_at AND r.access_expires_at=NEW.new_expires_at
    AND NEW.old_state='ACTIVE' AND NEW.new_state='ACTIVE' AND NEW.new_policy_ref=NEW.old_policy_ref
    AND NEW.new_allowed_use_json=NEW.old_allowed_use_json AND NEW.new_disclosure_ceiling=NEW.old_disclosure_ceiling
    AND NEW.new_created_at=NEW.old_created_at
)
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_HISTORY_RECEIPT_INVALID'); END;
CREATE TRIGGER scope_read_policy_lease_receipt_insert_guard
BEFORE INSERT ON scope_read_policy_lease_refresh_receipt
WHEN NEW.state<>'PREPARED' OR NOT EXISTS (
  SELECT 1 FROM scope_read_policy rp
  JOIN source_namespace_initialization i ON i.source_namespace_id=rp.source_namespace_id
    AND i.principal_ref=rp.principal_ref AND i.ownership_record_revision=NEW.ownership_record_revision
    AND i.owner_incarnation_ref=NEW.owner_incarnation_ref AND i.source_owner_generation=NEW.source_owner_generation
    AND i.source_admission_policy_revision=NEW.source_admission_policy_revision AND i.scope_policy_ref=rp.policy_ref
  JOIN source_namespace_ownership o ON o.source_namespace_id=i.source_namespace_id
    AND o.ownership_record_revision=i.ownership_record_revision
    AND o.owner_incarnation_ref=i.owner_incarnation_ref AND o.source_owner_generation=i.source_owner_generation
    AND o.source_admission_policy_revision=i.source_admission_policy_revision
  JOIN source_admission_policy p ON p.source_namespace_id=i.source_namespace_id
    AND p.revision=i.source_admission_policy_revision
  WHERE rp.source_namespace_id=NEW.source_namespace_id AND rp.principal_ref=NEW.principal_ref
    AND rp.client_class=NEW.client_class AND rp.policy_ref=NEW.policy_ref AND rp.generation=NEW.old_generation
    AND rp.allowed_use_json=NEW.old_allowed_use_json AND rp.disclosure_ceiling=NEW.old_disclosure_ceiling
    AND rp.state='ACTIVE' AND rp.created_at=NEW.old_created_at AND rp.expires_at=NEW.old_expires_at
    AND o.owner_system_id='eliotr' AND o.status='ACTIVE'
    AND p.instruction_taint='DATA_ONLY' AND p.allowed_effects='READ_ONLY'
    AND p.disclosure_ceiling=NEW.old_disclosure_ceiling
    AND EXISTS(SELECT 1 FROM json_each(p.authorized_principal_refs_json) WHERE value=NEW.principal_ref)
    AND EXISTS(SELECT 1 FROM json_each(p.allowed_ownership_modes_json) WHERE value='immutable_import')
    AND EXISTS(SELECT 1 FROM json_each(p.allowed_use_json) WHERE value='research')
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.old_allowed_use_json) u
      WHERE NOT EXISTS(SELECT 1 FROM json_each(p.allowed_use_json) a WHERE a.value=u.value))
)
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_LEASE_RECEIPT_INVALID'); END;

CREATE TRIGGER scope_read_policy_lease_receipt_update_immutable
BEFORE UPDATE ON scope_read_policy_lease_refresh_receipt
WHEN NEW.refresh_id IS NOT OLD.refresh_id OR NEW.source_namespace_id IS NOT OLD.source_namespace_id
  OR NEW.receipt_sequence IS NOT OLD.receipt_sequence
  OR NEW.principal_ref IS NOT OLD.principal_ref OR NEW.client_class IS NOT OLD.client_class
  OR NEW.credential_generation IS NOT OLD.credential_generation OR NEW.access_expires_at IS NOT OLD.access_expires_at
  OR NEW.owner_incarnation_ref IS NOT OLD.owner_incarnation_ref
  OR NEW.source_owner_generation IS NOT OLD.source_owner_generation
  OR NEW.ownership_record_revision IS NOT OLD.ownership_record_revision
  OR NEW.source_admission_policy_revision IS NOT OLD.source_admission_policy_revision
  OR NEW.policy_ref IS NOT OLD.policy_ref OR NEW.old_generation IS NOT OLD.old_generation
  OR NEW.new_generation IS NOT OLD.new_generation OR NEW.old_allowed_use_json IS NOT OLD.old_allowed_use_json
  OR NEW.old_disclosure_ceiling IS NOT OLD.old_disclosure_ceiling OR NEW.old_created_at IS NOT OLD.old_created_at
  OR NEW.old_expires_at IS NOT OLD.old_expires_at
  OR NEW.new_expires_at IS NOT OLD.new_expires_at OR NEW.created_at IS NOT OLD.created_at
  OR OLD.state<>'PREPARED' OR NEW.state<>'APPLIED'
  OR NOT EXISTS (
    SELECT 1 FROM scope_read_policy rp
    JOIN source_namespace_initialization i ON i.source_namespace_id=rp.source_namespace_id
      AND i.principal_ref=rp.principal_ref AND i.ownership_record_revision=NEW.ownership_record_revision
      AND i.owner_incarnation_ref=NEW.owner_incarnation_ref AND i.source_owner_generation=NEW.source_owner_generation
      AND i.source_admission_policy_revision=NEW.source_admission_policy_revision AND i.scope_policy_ref=rp.policy_ref
    JOIN source_namespace_ownership o ON o.source_namespace_id=i.source_namespace_id
      AND o.ownership_record_revision=i.ownership_record_revision
      AND o.owner_incarnation_ref=i.owner_incarnation_ref AND o.source_owner_generation=i.source_owner_generation
      AND o.source_admission_policy_revision=i.source_admission_policy_revision
    JOIN source_admission_policy p ON p.source_namespace_id=i.source_namespace_id
      AND p.revision=i.source_admission_policy_revision
    WHERE rp.source_namespace_id=NEW.source_namespace_id AND rp.principal_ref=NEW.principal_ref
      AND rp.client_class=NEW.client_class AND rp.policy_ref=NEW.policy_ref
      AND rp.generation=NEW.new_generation AND rp.allowed_use_json=NEW.old_allowed_use_json
      AND rp.disclosure_ceiling=NEW.old_disclosure_ceiling AND rp.state='ACTIVE' AND rp.created_at=NEW.old_created_at
      AND rp.expires_at=NEW.new_expires_at AND NEW.new_expires_at=NEW.access_expires_at
      AND julianday('now')<julianday(NEW.access_expires_at)
      AND o.owner_system_id='eliotr' AND o.status='ACTIVE'
      AND p.instruction_taint='DATA_ONLY' AND p.allowed_effects='READ_ONLY'
      AND p.disclosure_ceiling=NEW.old_disclosure_ceiling
      AND EXISTS(SELECT 1 FROM json_each(p.authorized_principal_refs_json) WHERE value=NEW.principal_ref)
      AND EXISTS(SELECT 1 FROM json_each(p.allowed_ownership_modes_json) WHERE value='immutable_import')
      AND EXISTS(SELECT 1 FROM json_each(p.allowed_use_json) WHERE value='research')
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.old_allowed_use_json) u
        WHERE NOT EXISTS(SELECT 1 FROM json_each(p.allowed_use_json) a WHERE a.value=u.value))
  )
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_LEASE_RECEIPT_IMMUTABLE'); END;

CREATE TRIGGER scope_read_policy_lease_receipt_no_delete
BEFORE DELETE ON scope_read_policy_lease_refresh_receipt
WHEN OLD.state='APPLIED'
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_LEASE_RECEIPT_IMMUTABLE'); END;


CREATE TRIGGER scope_read_policy_lease_update_guard
BEFORE UPDATE ON scope_read_policy
WHEN EXISTS (
  SELECT 1 FROM scope_read_policy_lease_refresh_receipt r
  WHERE r.source_namespace_id=OLD.source_namespace_id AND r.principal_ref=OLD.principal_ref
    AND r.client_class=OLD.client_class AND r.state='PREPARED'
)
AND NOT EXISTS (
  SELECT 1 FROM scope_read_policy_lease_refresh_receipt r
  WHERE r.source_namespace_id=OLD.source_namespace_id AND r.principal_ref=OLD.principal_ref
    AND r.client_class=OLD.client_class AND r.state='PREPARED'
    AND OLD.state='ACTIVE' AND NEW.state='ACTIVE'
    AND NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref
    AND NEW.client_class=OLD.client_class AND NEW.policy_ref=OLD.policy_ref
    AND NEW.allowed_use_json=OLD.allowed_use_json AND NEW.disclosure_ceiling=OLD.disclosure_ceiling
    AND NEW.created_at=OLD.created_at AND NEW.generation=OLD.generation+1
    AND julianday(OLD.expires_at)<julianday(NEW.expires_at)
    AND r.policy_ref=OLD.policy_ref AND r.old_generation=OLD.generation AND r.new_generation=NEW.generation
    AND r.old_allowed_use_json=OLD.allowed_use_json AND r.old_disclosure_ceiling=OLD.disclosure_ceiling
    AND r.old_created_at=OLD.created_at AND r.old_expires_at=OLD.expires_at AND r.new_expires_at=NEW.expires_at
    AND r.access_expires_at=NEW.expires_at
)
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_LEASE_RECEIPT_MISMATCH'); END;


CREATE TRIGGER scope_read_policy_lease_applied_history AFTER UPDATE ON scope_read_policy_lease_refresh_receipt
WHEN OLD.state='PREPARED' AND NEW.state='APPLIED' BEGIN
  INSERT INTO scope_read_policy_history_event(source_namespace_id,principal_ref,client_class,event_kind,
    receipt_sequence,refresh_id,old_policy_ref,old_generation,old_allowed_use_json,old_disclosure_ceiling,old_state,old_expires_at,old_created_at,new_policy_ref,new_generation,new_allowed_use_json,new_disclosure_ceiling,new_state,new_expires_at,new_created_at,created_at)
  VALUES(NEW.source_namespace_id,NEW.principal_ref,NEW.client_class,'LEASE_REFRESH',NEW.receipt_sequence,NEW.refresh_id,
    NEW.policy_ref,NEW.old_generation,NEW.old_allowed_use_json,NEW.old_disclosure_ceiling,'ACTIVE',NEW.old_expires_at,NEW.old_created_at,
    NEW.policy_ref,NEW.new_generation,NEW.old_allowed_use_json,NEW.old_disclosure_ceiling,'ACTIVE',NEW.new_expires_at,NEW.old_created_at,NEW.created_at);
  UPDATE scope_read_policy_identity SET last_event_sequence=last_insert_rowid()
  WHERE source_namespace_id=NEW.source_namespace_id AND principal_ref=NEW.principal_ref AND client_class=NEW.client_class;
END;

DROP TRIGGER orientation_read_policy_changed;
DROP TRIGGER orientation_read_policy_deleted;
CREATE TRIGGER orientation_read_policy_changed AFTER UPDATE ON scope_read_policy
WHEN NOT EXISTS (SELECT 1 FROM scope_read_policy_lease_refresh_receipt r
    WHERE r.source_namespace_id=OLD.source_namespace_id AND r.principal_ref=OLD.principal_ref
      AND r.client_class=OLD.client_class AND r.state='PREPARED') BEGIN
  INSERT INTO scope_read_policy_history_event(source_namespace_id,principal_ref,client_class,event_kind,old_policy_ref,old_generation,old_allowed_use_json,old_disclosure_ceiling,old_state,old_expires_at,old_created_at,new_policy_ref,new_generation,new_allowed_use_json,new_disclosure_ceiling,new_state,new_expires_at,new_created_at,created_at) VALUES(OLD.source_namespace_id,OLD.principal_ref,OLD.client_class,
    'SEMANTIC_CHANGE',OLD.policy_ref,OLD.generation,OLD.allowed_use_json,OLD.disclosure_ceiling,OLD.state,OLD.expires_at,OLD.created_at,CASE WHEN NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class THEN NEW.policy_ref ELSE NULL END,CASE WHEN NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class THEN NEW.generation ELSE NULL END,CASE WHEN NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class THEN NEW.allowed_use_json ELSE NULL END,CASE WHEN NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class THEN NEW.disclosure_ceiling ELSE NULL END,CASE WHEN NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class THEN NEW.state ELSE NULL END,CASE WHEN NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class THEN NEW.expires_at ELSE NULL END,CASE WHEN NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class THEN NEW.created_at ELSE NULL END,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  UPDATE scope_read_policy_identity SET last_event_sequence=last_insert_rowid(),semantic_sequence=last_insert_rowid()
  WHERE source_namespace_id=OLD.source_namespace_id AND principal_ref=OLD.principal_ref AND client_class=OLD.client_class;
  INSERT INTO scope_read_policy_history_event(source_namespace_id,principal_ref,client_class,event_kind,old_policy_ref,old_generation,old_allowed_use_json,old_disclosure_ceiling,old_state,old_expires_at,old_created_at,new_policy_ref,new_generation,new_allowed_use_json,new_disclosure_ceiling,new_state,new_expires_at,new_created_at,created_at)
  SELECT NEW.source_namespace_id,NEW.principal_ref,NEW.client_class,'POLICY_INSERT',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NEW.policy_ref,NEW.generation,NEW.allowed_use_json,NEW.disclosure_ceiling,NEW.state,NEW.expires_at,NEW.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NOT (NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class);
  INSERT INTO scope_read_policy_identity(source_namespace_id,principal_ref,client_class,birth_sequence,last_event_sequence,semantic_sequence)
  SELECT NEW.source_namespace_id,NEW.principal_ref,NEW.client_class,last_insert_rowid(),last_insert_rowid(),last_insert_rowid()
  WHERE NOT (NEW.source_namespace_id=OLD.source_namespace_id AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class)
  ON CONFLICT(source_namespace_id,principal_ref,client_class) DO UPDATE SET last_event_sequence=excluded.last_event_sequence,semantic_sequence=excluded.semantic_sequence;
  UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),invalidation_reason='READ_POLICY_CHANGED'
  WHERE invalidated_at IS NULL AND EXISTS(SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id=scope_snapshot.snapshot_id
    AND g.snapshot_revision=scope_snapshot.revision AND g.principal_ref=OLD.principal_ref AND g.client_class=OLD.client_class);
END;
CREATE TRIGGER orientation_read_policy_inserted AFTER INSERT ON scope_read_policy BEGIN
  INSERT INTO scope_read_policy_history_event(source_namespace_id,principal_ref,client_class,event_kind,old_policy_ref,old_generation,old_allowed_use_json,old_disclosure_ceiling,old_state,old_expires_at,old_created_at,new_policy_ref,new_generation,new_allowed_use_json,new_disclosure_ceiling,new_state,new_expires_at,new_created_at,created_at) VALUES(NEW.source_namespace_id,NEW.principal_ref,NEW.client_class,
    'POLICY_INSERT',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NEW.policy_ref,NEW.generation,NEW.allowed_use_json,NEW.disclosure_ceiling,NEW.state,NEW.expires_at,NEW.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO scope_read_policy_identity(source_namespace_id,principal_ref,client_class,birth_sequence,last_event_sequence,semantic_sequence)
  VALUES(NEW.source_namespace_id,NEW.principal_ref,NEW.client_class,last_insert_rowid(),last_insert_rowid(),last_insert_rowid())
  ON CONFLICT(source_namespace_id,principal_ref,client_class) DO UPDATE SET last_event_sequence=excluded.last_event_sequence,semantic_sequence=excluded.semantic_sequence;
END;
CREATE TRIGGER orientation_read_policy_deleted AFTER DELETE ON scope_read_policy BEGIN
  INSERT INTO scope_read_policy_history_event(source_namespace_id,principal_ref,client_class,event_kind,old_policy_ref,old_generation,old_allowed_use_json,old_disclosure_ceiling,old_state,old_expires_at,old_created_at,new_policy_ref,new_generation,new_allowed_use_json,new_disclosure_ceiling,new_state,new_expires_at,new_created_at,created_at) VALUES(OLD.source_namespace_id,OLD.principal_ref,OLD.client_class,
    'POLICY_DELETE',OLD.policy_ref,OLD.generation,OLD.allowed_use_json,OLD.disclosure_ceiling,OLD.state,OLD.expires_at,OLD.created_at,NULL,NULL,NULL,NULL,NULL,NULL,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  UPDATE scope_read_policy_identity SET last_event_sequence=last_insert_rowid(),semantic_sequence=last_insert_rowid()
  WHERE source_namespace_id=OLD.source_namespace_id AND principal_ref=OLD.principal_ref AND client_class=OLD.client_class;
  UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),invalidation_reason='READ_POLICY_DELETED'
  WHERE invalidated_at IS NULL AND EXISTS(SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id=scope_snapshot.snapshot_id
    AND g.snapshot_revision=scope_snapshot.revision AND g.principal_ref=OLD.principal_ref AND g.client_class=OLD.client_class);
END;
