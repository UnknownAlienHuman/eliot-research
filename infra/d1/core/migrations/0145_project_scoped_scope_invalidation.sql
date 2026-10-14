PRAGMA foreign_keys = ON;

-- Scope invalidation is project-specific. Match a PROJECT atom by its sibling
-- kind/project_id keys in the validated recursive expression; do not match
-- strings elsewhere in GLOBAL_LIBRARY, SELECTED_SOURCES, TAG or other atoms.
DROP TRIGGER orientation_project_update;
DROP TRIGGER orientation_project_delete;
DROP TRIGGER orientation_project_source_membership_insert;
DROP TRIGGER orientation_project_source_membership_update;
DROP TRIGGER orientation_project_source_membership_delete;

CREATE TRIGGER orientation_project_update
AFTER UPDATE ON project
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.default_disclosure IS NOT OLD.default_disclosure
  OR NEW.retention_policy_ref IS NOT OLD.retention_policy_ref
  OR NEW.default_source_policy_ref IS NOT OLD.default_source_policy_ref
  OR NEW.default_model_profile_ref IS NOT OLD.default_model_profile_ref
  OR NEW.default_depth_profile_ref IS NOT OLD.default_depth_profile_ref
  OR NEW.membership_generation IS NOT OLD.membership_generation
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  UPDATE scope_snapshot
  SET invalidated_at = COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      invalidation_reason = 'SCOPE_INPUT_CHANGED'
  WHERE invalidated_at IS NULL
    AND EXISTS (
      SELECT 1 FROM orientation_request o
      WHERE o.snapshot_id = scope_snapshot.snapshot_id
        AND o.snapshot_revision = scope_snapshot.revision
    )
    AND EXISTS (
      SELECT 1
      FROM json_tree(scope_snapshot.resolved_scope_expression_json) AS kind_node
      JOIN json_tree(scope_snapshot.resolved_scope_expression_json) AS project_node
        ON project_node.parent = kind_node.parent
      WHERE kind_node.key = 'kind'
        AND kind_node.value = 'PROJECT'
        AND project_node.key = 'project_id'
        AND project_node.value IN (OLD.project_id, NEW.project_id)
    );
END;

CREATE TRIGGER orientation_project_delete
AFTER DELETE ON project
BEGIN
  UPDATE scope_snapshot
  SET invalidated_at = COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      invalidation_reason = 'SCOPE_INPUT_CHANGED'
  WHERE invalidated_at IS NULL
    AND EXISTS (
      SELECT 1 FROM orientation_request o
      WHERE o.snapshot_id = scope_snapshot.snapshot_id
        AND o.snapshot_revision = scope_snapshot.revision
    )
    AND EXISTS (
      SELECT 1
      FROM json_tree(scope_snapshot.resolved_scope_expression_json) AS kind_node
      JOIN json_tree(scope_snapshot.resolved_scope_expression_json) AS project_node
        ON project_node.parent = kind_node.parent
      WHERE kind_node.key = 'kind'
        AND kind_node.value = 'PROJECT'
        AND project_node.key = 'project_id'
        AND project_node.value = OLD.project_id
    );
END;

CREATE TRIGGER orientation_project_source_membership_insert
AFTER INSERT ON project_source_membership
BEGIN
  UPDATE scope_snapshot
  SET invalidated_at = COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      invalidation_reason = 'SCOPE_INPUT_CHANGED'
  WHERE invalidated_at IS NULL
    AND EXISTS (
      SELECT 1 FROM orientation_request o
      WHERE o.snapshot_id = scope_snapshot.snapshot_id
        AND o.snapshot_revision = scope_snapshot.revision
    )
    AND EXISTS (
      SELECT 1
      FROM json_tree(scope_snapshot.resolved_scope_expression_json) AS kind_node
      JOIN json_tree(scope_snapshot.resolved_scope_expression_json) AS project_node
        ON project_node.parent = kind_node.parent
      WHERE kind_node.key = 'kind'
        AND kind_node.value = 'PROJECT'
        AND project_node.key = 'project_id'
        AND project_node.value = NEW.project_id
    );
END;

CREATE TRIGGER orientation_project_source_membership_update
AFTER UPDATE ON project_source_membership
BEGIN
  UPDATE scope_snapshot
  SET invalidated_at = COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      invalidation_reason = 'SCOPE_INPUT_CHANGED'
  WHERE invalidated_at IS NULL
    AND EXISTS (
      SELECT 1 FROM orientation_request o
      WHERE o.snapshot_id = scope_snapshot.snapshot_id
        AND o.snapshot_revision = scope_snapshot.revision
    )
    AND EXISTS (
      SELECT 1
      FROM json_tree(scope_snapshot.resolved_scope_expression_json) AS kind_node
      JOIN json_tree(scope_snapshot.resolved_scope_expression_json) AS project_node
        ON project_node.parent = kind_node.parent
      WHERE kind_node.key = 'kind'
        AND kind_node.value = 'PROJECT'
        AND project_node.key = 'project_id'
        AND project_node.value IN (OLD.project_id, NEW.project_id)
    );
END;

CREATE TRIGGER orientation_project_source_membership_delete
AFTER DELETE ON project_source_membership
BEGIN
  UPDATE scope_snapshot
  SET invalidated_at = COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      invalidation_reason = 'SCOPE_INPUT_CHANGED'
  WHERE invalidated_at IS NULL
    AND EXISTS (
      SELECT 1 FROM orientation_request o
      WHERE o.snapshot_id = scope_snapshot.snapshot_id
        AND o.snapshot_revision = scope_snapshot.revision
    )
    AND EXISTS (
      SELECT 1
      FROM json_tree(scope_snapshot.resolved_scope_expression_json) AS kind_node
      JOIN json_tree(scope_snapshot.resolved_scope_expression_json) AS project_node
        ON project_node.parent = kind_node.parent
      WHERE kind_node.key = 'kind'
        AND kind_node.value = 'PROJECT'
        AND project_node.key = 'project_id'
        AND project_node.value = OLD.project_id
    );
END;
