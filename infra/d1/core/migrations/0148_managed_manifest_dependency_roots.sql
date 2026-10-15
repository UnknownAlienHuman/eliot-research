-- Extend the existing source dependency registry. Legacy rows retain their
-- original meaning; no target prefix becomes a source deletion authority.
ALTER TABLE erasure_dependency_registry ADD COLUMN managed_root_ref TEXT;
ALTER TABLE erasure_dependency_registry ADD COLUMN managed_object_kind TEXT
  CHECK (managed_object_kind IS NULL OR managed_object_kind IN
    ('CANONICAL','COPY_REF','SHARED_REF'));
ALTER TABLE erasure_dependency_registry ADD COLUMN managed_root_state TEXT
  CHECK (managed_root_state IS NULL OR managed_root_state IN
    ('BUILDING','ACTIVE','BLOCKED'));
ALTER TABLE erasure_dependency_registry ADD COLUMN managed_source_fence_json TEXT
  CHECK (managed_source_fence_json IS NULL OR json_valid(managed_source_fence_json));

CREATE INDEX erasure_dependency_managed_root_idx
  ON erasure_dependency_registry(managed_root_ref,managed_root_state,state)
  WHERE managed_root_ref IS NOT NULL;

CREATE TRIGGER erasure_dependency_managed_shape_insert
BEFORE INSERT ON erasure_dependency_registry
WHEN (NEW.managed_object_kind IS NULL AND
      (NEW.managed_root_ref IS NOT NULL OR NEW.managed_root_state IS NOT NULL
       OR NEW.managed_source_fence_json IS NOT NULL))
  OR (NEW.managed_object_kind IS NOT NULL AND NEW.managed_source_fence_json IS NULL)
  OR (NEW.managed_object_kind='CANONICAL' AND
      (NEW.managed_root_ref IS NOT NULL OR NEW.managed_root_state IS NOT NULL))
  OR (NEW.managed_object_kind IN ('COPY_REF','SHARED_REF') AND
      (NEW.managed_root_ref IS NULL OR NEW.managed_root_state IS NULL))
BEGIN SELECT RAISE(ABORT,'managed dependency root shape is invalid'); END;

CREATE TRIGGER erasure_dependency_managed_identity_immutable
BEFORE UPDATE ON erasure_dependency_registry
WHEN OLD.managed_object_kind IS NOT NULL AND
  (NEW.exact_subject_ref IS NOT OLD.exact_subject_ref
   OR NEW.location IS NOT OLD.location
   OR NEW.canonical_ref IS NOT OLD.canonical_ref
   OR NEW.object_identity_digest IS NOT OLD.object_identity_digest
   OR NEW.shared_reference_key IS NOT OLD.shared_reference_key
   OR NEW.managed_root_ref IS NOT OLD.managed_root_ref
   OR NEW.managed_object_kind IS NOT OLD.managed_object_kind
   OR NEW.managed_source_fence_json IS NOT OLD.managed_source_fence_json
   OR (OLD.managed_root_state='BLOCKED' AND NEW.managed_root_state IS NOT 'BLOCKED'))
BEGIN SELECT RAISE(ABORT,'managed dependency identity cannot be replaced'); END;

CREATE TRIGGER erasure_dependency_managed_root_no_late_member
BEFORE INSERT ON erasure_dependency_registry
WHEN NEW.managed_root_ref IS NOT NULL AND EXISTS (
  SELECT 1 FROM erasure_dependency_registry d
  WHERE d.managed_root_ref=NEW.managed_root_ref
    AND d.managed_root_state IN ('ACTIVE','BLOCKED'))
BEGIN SELECT RAISE(ABORT,'managed root is sealed or blocked'); END;

-- The existing erasure quarantine transaction changes source_revision. Its
-- first purge transition blocks all roots that contain that exact revision,
-- including shared roots, without deleting any other source's bytes.
CREATE TRIGGER source_revision_blocks_managed_manifest_roots
AFTER UPDATE OF purge_state ON source_revision
WHEN NEW.purge_state<>'LIVE'
BEGIN
  UPDATE erasure_dependency_registry SET managed_root_state='BLOCKED'
  WHERE managed_root_ref IN (
    SELECT managed_root_ref FROM erasure_dependency_registry
    WHERE exact_subject_ref='source-revision:'||NEW.source_revision_ref
      AND managed_root_ref IS NOT NULL)
    AND managed_root_state IN ('BUILDING','ACTIVE');
END;

CREATE TRIGGER source_revision_delete_blocks_managed_manifest_roots
BEFORE DELETE ON source_revision
BEGIN
  UPDATE erasure_dependency_registry SET managed_root_state='BLOCKED'
  WHERE managed_root_ref IN (
    SELECT managed_root_ref FROM erasure_dependency_registry
    WHERE exact_subject_ref='source-revision:'||OLD.source_revision_ref
      AND managed_root_ref IS NOT NULL)
    AND managed_root_state IN ('BUILDING','ACTIVE');
END;
