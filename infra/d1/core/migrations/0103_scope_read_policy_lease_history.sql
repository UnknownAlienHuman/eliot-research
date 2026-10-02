-- A lease refresh is a narrowly evidenced change to an existing owner read policy.
-- The receipt is inserted in the same D1 batch as the policy CAS and is promoted
-- to APPLIED only by the exact update trigger below.
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

CREATE TABLE scope_read_policy_history_event (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision>0),
  principal_ref TEXT,
  event_kind TEXT NOT NULL CHECK(event_kind IN (
    'LEASE_REFRESH','SEMANTIC_CHANGE','POLICY_INSERT','POLICY_DELETE','PRE_MIGRATION_SEMANTIC','SNAPSHOT_BASELINE'
  )),
  receipt_sequence INTEGER CHECK(receipt_sequence IS NULL OR receipt_sequence>=0),
  refresh_id TEXT,
  old_source_namespace_id TEXT,
  old_principal_ref TEXT,
  old_policy_ref TEXT,
  old_generation INTEGER,
  old_allowed_use_json TEXT,
  old_disclosure_ceiling TEXT,
  old_state TEXT,
  old_expires_at TEXT,
  old_created_at TEXT,
  new_source_namespace_id TEXT,
  new_principal_ref TEXT,
  new_policy_ref TEXT,
  new_generation INTEGER,
  new_allowed_use_json TEXT,
  new_disclosure_ceiling TEXT,
  new_state TEXT,
  new_expires_at TEXT,
  new_created_at TEXT,
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at
  ),
  FOREIGN KEY(snapshot_id,snapshot_revision) REFERENCES scope_snapshot(snapshot_id,revision),
  FOREIGN KEY(refresh_id) REFERENCES scope_read_policy_lease_refresh_receipt(refresh_id),
  CHECK(
    (event_kind='LEASE_REFRESH' AND receipt_sequence IS NOT NULL AND refresh_id IS NOT NULL AND
      old_source_namespace_id IS NOT NULL AND old_principal_ref IS NOT NULL AND old_policy_ref IS NOT NULL AND
      old_generation IS NOT NULL AND old_allowed_use_json IS NOT NULL AND old_disclosure_ceiling IS NOT NULL AND
      old_state='ACTIVE' AND old_expires_at IS NOT NULL AND old_created_at IS NOT NULL AND
      new_source_namespace_id=old_source_namespace_id AND new_principal_ref=old_principal_ref AND
      new_policy_ref=old_policy_ref AND new_generation=old_generation+1 AND
      new_allowed_use_json=old_allowed_use_json AND new_disclosure_ceiling=old_disclosure_ceiling AND
      new_state='ACTIVE' AND new_expires_at IS NOT NULL AND new_created_at=old_created_at)
    OR
    (event_kind='SEMANTIC_CHANGE' AND receipt_sequence IS NULL AND refresh_id IS NULL AND
      old_source_namespace_id IS NOT NULL AND old_principal_ref IS NOT NULL AND old_policy_ref IS NOT NULL AND
      old_generation IS NOT NULL AND old_allowed_use_json IS NOT NULL AND old_disclosure_ceiling IS NOT NULL AND
      old_state IN ('ACTIVE','REVOKED') AND old_expires_at IS NOT NULL AND old_created_at IS NOT NULL AND
      new_source_namespace_id IS NOT NULL AND new_principal_ref IS NOT NULL AND new_policy_ref IS NOT NULL AND
      new_generation IS NOT NULL AND new_allowed_use_json IS NOT NULL AND new_disclosure_ceiling IS NOT NULL AND
      new_state IN ('ACTIVE','REVOKED') AND new_expires_at IS NOT NULL AND new_created_at IS NOT NULL)
    OR
    (event_kind='POLICY_INSERT' AND receipt_sequence IS NULL AND refresh_id IS NULL AND
      old_source_namespace_id IS NULL AND old_principal_ref IS NULL AND old_policy_ref IS NULL AND
      old_generation IS NULL AND old_allowed_use_json IS NULL AND old_disclosure_ceiling IS NULL AND
      old_state IS NULL AND old_expires_at IS NULL AND old_created_at IS NULL AND
      new_source_namespace_id IS NOT NULL AND new_principal_ref IS NOT NULL AND new_policy_ref IS NOT NULL AND
      new_generation IS NOT NULL AND new_allowed_use_json IS NOT NULL AND new_disclosure_ceiling IS NOT NULL AND
      new_state IN ('ACTIVE','REVOKED') AND new_expires_at IS NOT NULL AND new_created_at IS NOT NULL)
    OR
    (event_kind='POLICY_DELETE' AND receipt_sequence IS NULL AND refresh_id IS NULL AND
      old_source_namespace_id IS NOT NULL AND old_principal_ref IS NOT NULL AND old_policy_ref IS NOT NULL AND
      old_generation IS NOT NULL AND old_allowed_use_json IS NOT NULL AND old_disclosure_ceiling IS NOT NULL AND
      old_state IN ('ACTIVE','REVOKED') AND old_expires_at IS NOT NULL AND old_created_at IS NOT NULL AND
      new_source_namespace_id IS NULL AND new_principal_ref IS NULL AND new_policy_ref IS NULL AND
      new_generation IS NULL AND new_allowed_use_json IS NULL AND new_disclosure_ceiling IS NULL AND
      new_state IS NULL AND new_expires_at IS NULL AND new_created_at IS NULL)
    OR
    (event_kind='PRE_MIGRATION_SEMANTIC' AND receipt_sequence IS NULL AND refresh_id IS NULL AND principal_ref IS NULL AND
      old_source_namespace_id IS NULL AND old_principal_ref IS NULL AND old_policy_ref IS NULL AND
      old_generation IS NULL AND old_allowed_use_json IS NULL AND old_disclosure_ceiling IS NULL AND
      old_state IS NULL AND old_expires_at IS NULL AND old_created_at IS NULL AND
      new_source_namespace_id IS NULL AND new_principal_ref IS NULL AND new_policy_ref IS NULL AND
      new_generation IS NULL AND new_allowed_use_json IS NULL AND new_disclosure_ceiling IS NULL AND
      new_state IS NULL AND new_expires_at IS NULL AND new_created_at IS NULL)
    OR
    (event_kind='SNAPSHOT_BASELINE' AND refresh_id IS NULL AND principal_ref IS NULL AND
      receipt_sequence IS NOT NULL AND old_source_namespace_id IS NULL AND old_principal_ref IS NULL AND
      old_policy_ref IS NULL AND old_generation IS NULL AND old_allowed_use_json IS NULL AND
      old_disclosure_ceiling IS NULL AND old_state IS NULL AND old_expires_at IS NULL AND old_created_at IS NULL AND
      new_source_namespace_id IS NULL AND new_principal_ref IS NULL AND new_policy_ref IS NULL AND
      new_generation IS NULL AND new_allowed_use_json IS NULL AND new_disclosure_ceiling IS NULL AND
      new_state IS NULL AND new_expires_at IS NULL AND new_created_at IS NULL)
  )
) STRICT;

CREATE INDEX scope_read_policy_history_snapshot_idx
  ON scope_read_policy_history_event(snapshot_id,snapshot_revision,event_id);
CREATE UNIQUE INDEX scope_read_policy_history_snapshot_baseline_unique
  ON scope_read_policy_history_event(snapshot_id,snapshot_revision) WHERE event_kind='SNAPSHOT_BASELINE';
CREATE UNIQUE INDEX scope_read_policy_history_snapshot_receipt_unique
  ON scope_read_policy_history_event(snapshot_id,snapshot_revision,receipt_sequence) WHERE event_kind='LEASE_REFRESH';

-- Receipt order, not wall-clock time, identifies every transition after a
-- snapshot's immutable baseline. Receipt sequences are globally monotonic.
INSERT INTO scope_read_policy_history_event(snapshot_id,snapshot_revision,event_kind,receipt_sequence,created_at)
SELECT snapshot_id,revision,'SNAPSHOT_BASELINE',
  COALESCE((SELECT MAX(receipt_sequence) FROM scope_read_policy_lease_refresh_receipt WHERE state='APPLIED'),0),
  strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM scope_snapshot;

CREATE TRIGGER scope_read_policy_history_snapshot_baseline_insert
AFTER INSERT ON scope_snapshot
BEGIN
  INSERT INTO scope_read_policy_history_event(snapshot_id,snapshot_revision,event_kind,receipt_sequence,created_at)
  SELECT NEW.snapshot_id,NEW.revision,'SNAPSHOT_BASELINE',
    COALESCE(MAX(CASE WHEN state='APPLIED' THEN receipt_sequence END),0),
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM scope_read_policy_lease_refresh_receipt;
END;

CREATE TRIGGER scope_read_policy_history_event_immutable_update
BEFORE UPDATE ON scope_read_policy_history_event
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_HISTORY_IMMUTABLE'); END;

CREATE TRIGGER scope_read_policy_history_event_immutable_delete
BEFORE DELETE ON scope_read_policy_history_event
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_HISTORY_IMMUTABLE'); END;

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
    AND rp.state='ACTIVE' AND rp.expires_at=NEW.old_expires_at
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
  OR NEW.old_disclosure_ceiling IS NOT OLD.old_disclosure_ceiling OR NEW.old_expires_at IS NOT OLD.old_expires_at
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
      AND rp.disclosure_ceiling=NEW.old_disclosure_ceiling AND rp.state='ACTIVE'
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

-- Track every owner snapshot identity, including reservations that have not yet
-- received their first grant. An unrelated namespace policy still participates
-- in the immutable orientation-generation closure for this principal.
CREATE VIEW scope_read_policy_owner_snapshot_subject AS
  SELECT snapshot_id,snapshot_revision,principal_ref FROM orientation_request
    WHERE client_class='owner_pwa' AND snapshot_id IS NOT NULL
  UNION
  SELECT snapshot_id,snapshot_revision,principal_ref FROM scope_access_grant
    WHERE client_class='owner_pwa';

-- Old policy invalidations are intentionally a permanent semantic denial. Seed
-- an immutable marker so later scope-input changes cannot erase that boundary.
INSERT INTO scope_read_policy_history_event(
  snapshot_id,snapshot_revision,event_kind,created_at
)
SELECT snapshot_id,revision,'PRE_MIGRATION_SEMANTIC',
  COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
FROM scope_snapshot WHERE invalidation_reason IN ('READ_POLICY_CHANGED','READ_POLICY_DELETED');

DROP TRIGGER orientation_read_policy_changed;
DROP TRIGGER orientation_read_policy_deleted;

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
    AND r.old_expires_at=OLD.expires_at AND r.new_expires_at=NEW.expires_at
    AND r.access_expires_at=NEW.expires_at
)
BEGIN SELECT RAISE(ABORT,'SCOPE_READ_POLICY_LEASE_RECEIPT_MISMATCH'); END;

CREATE TRIGGER orientation_read_policy_changed
AFTER UPDATE ON scope_read_policy
BEGIN
  INSERT INTO scope_read_policy_history_event(
    snapshot_id,snapshot_revision,principal_ref,event_kind,receipt_sequence,refresh_id,
    old_source_namespace_id,old_principal_ref,old_policy_ref,old_generation,old_allowed_use_json,
    old_disclosure_ceiling,old_state,old_expires_at,old_created_at,
    new_source_namespace_id,new_principal_ref,new_policy_ref,new_generation,new_allowed_use_json,
    new_disclosure_ceiling,new_state,new_expires_at,new_created_at,created_at
  )
  SELECT subject.snapshot_id,subject.snapshot_revision,subject.principal_ref,
    CASE WHEN exact.refresh_id IS NULL THEN 'SEMANTIC_CHANGE' ELSE 'LEASE_REFRESH' END,
    exact.receipt_sequence,exact.refresh_id,
    OLD.source_namespace_id,OLD.principal_ref,OLD.policy_ref,OLD.generation,OLD.allowed_use_json,
    OLD.disclosure_ceiling,OLD.state,OLD.expires_at,OLD.created_at,
    NEW.source_namespace_id,NEW.principal_ref,NEW.policy_ref,NEW.generation,NEW.allowed_use_json,
    NEW.disclosure_ceiling,NEW.state,NEW.expires_at,NEW.created_at,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM scope_read_policy_owner_snapshot_subject subject
  LEFT JOIN (
    SELECT r.refresh_id,r.receipt_sequence FROM scope_read_policy_lease_refresh_receipt r
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
      AND r.old_expires_at=OLD.expires_at AND r.new_expires_at=NEW.expires_at
      AND r.access_expires_at=NEW.expires_at
    LIMIT 1
  ) exact ON 1=1
  WHERE subject.principal_ref IN (OLD.principal_ref,NEW.principal_ref);

  UPDATE scope_read_policy_lease_refresh_receipt SET state='APPLIED'
  WHERE state='PREPARED' AND source_namespace_id=OLD.source_namespace_id AND principal_ref=OLD.principal_ref
    AND client_class=OLD.client_class AND policy_ref=OLD.policy_ref AND old_generation=OLD.generation
    AND new_generation=NEW.generation AND old_allowed_use_json=OLD.allowed_use_json
    AND old_disclosure_ceiling=OLD.disclosure_ceiling AND old_expires_at=OLD.expires_at
    AND new_expires_at=NEW.expires_at AND access_expires_at=NEW.expires_at
    AND OLD.state='ACTIVE' AND NEW.state='ACTIVE' AND NEW.source_namespace_id=OLD.source_namespace_id
    AND NEW.principal_ref=OLD.principal_ref AND NEW.client_class=OLD.client_class
    AND NEW.policy_ref=OLD.policy_ref AND NEW.allowed_use_json=OLD.allowed_use_json
    AND NEW.disclosure_ceiling=OLD.disclosure_ceiling AND NEW.created_at=OLD.created_at
    AND NEW.generation=OLD.generation+1 AND julianday(OLD.expires_at)<julianday(NEW.expires_at);

  UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    invalidation_reason=CASE WHEN EXISTS (
      SELECT 1 FROM scope_read_policy_lease_refresh_receipt r
      WHERE r.source_namespace_id=OLD.source_namespace_id AND r.principal_ref=OLD.principal_ref
        AND r.client_class=OLD.client_class AND r.policy_ref=OLD.policy_ref
        AND r.old_generation=OLD.generation AND r.new_generation=NEW.generation AND r.state='APPLIED'
        AND r.old_allowed_use_json=OLD.allowed_use_json AND r.old_disclosure_ceiling=OLD.disclosure_ceiling
        AND r.old_expires_at=OLD.expires_at AND r.new_expires_at=NEW.expires_at
        AND r.access_expires_at=NEW.expires_at
    ) THEN 'READ_POLICY_LEASE_REFRESHED' ELSE 'READ_POLICY_CHANGED' END
  WHERE invalidated_at IS NULL AND EXISTS (
    SELECT 1 FROM scope_read_policy_owner_snapshot_subject subject
    WHERE subject.snapshot_id=scope_snapshot.snapshot_id AND subject.snapshot_revision=scope_snapshot.revision
      AND subject.principal_ref IN (OLD.principal_ref,NEW.principal_ref)
  );
END;

CREATE TRIGGER orientation_read_policy_inserted
AFTER INSERT ON scope_read_policy
BEGIN
  INSERT INTO scope_read_policy_history_event(
    snapshot_id,snapshot_revision,principal_ref,event_kind,new_source_namespace_id,new_principal_ref,
    new_policy_ref,new_generation,new_allowed_use_json,new_disclosure_ceiling,new_state,new_expires_at,
    new_created_at,created_at
  )
  SELECT subject.snapshot_id,subject.snapshot_revision,subject.principal_ref,'POLICY_INSERT',
    NEW.source_namespace_id,NEW.principal_ref,NEW.policy_ref,NEW.generation,NEW.allowed_use_json,
    NEW.disclosure_ceiling,NEW.state,NEW.expires_at,NEW.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM scope_read_policy_owner_snapshot_subject subject WHERE subject.principal_ref=NEW.principal_ref;
  UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    invalidation_reason='READ_POLICY_CHANGED'
  WHERE invalidated_at IS NULL AND EXISTS (
    SELECT 1 FROM scope_read_policy_owner_snapshot_subject subject
    WHERE subject.snapshot_id=scope_snapshot.snapshot_id AND subject.snapshot_revision=scope_snapshot.revision
      AND subject.principal_ref=NEW.principal_ref
  );
END;

CREATE TRIGGER orientation_read_policy_deleted
AFTER DELETE ON scope_read_policy
BEGIN
  INSERT INTO scope_read_policy_history_event(
    snapshot_id,snapshot_revision,principal_ref,event_kind,old_source_namespace_id,old_principal_ref,
    old_policy_ref,old_generation,old_allowed_use_json,old_disclosure_ceiling,old_state,old_expires_at,
    old_created_at,created_at
  )
  SELECT subject.snapshot_id,subject.snapshot_revision,subject.principal_ref,'POLICY_DELETE',
    OLD.source_namespace_id,OLD.principal_ref,OLD.policy_ref,OLD.generation,OLD.allowed_use_json,
    OLD.disclosure_ceiling,OLD.state,OLD.expires_at,OLD.created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM scope_read_policy_owner_snapshot_subject subject WHERE subject.principal_ref=OLD.principal_ref;
  UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    invalidation_reason='READ_POLICY_DELETED'
  WHERE invalidated_at IS NULL AND EXISTS (
    SELECT 1 FROM scope_read_policy_owner_snapshot_subject subject
    WHERE subject.snapshot_id=scope_snapshot.snapshot_id AND subject.snapshot_revision=scope_snapshot.revision
      AND subject.principal_ref=OLD.principal_ref
  );
END;
