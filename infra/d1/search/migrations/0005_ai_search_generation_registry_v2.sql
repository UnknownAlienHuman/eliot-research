PRAGMA foreign_keys = ON;

CREATE TABLE ai_search_generation_registry_next (
  namespace TEXT PRIMARY KEY CHECK (
    length(namespace) BETWEEN 1 AND 256
    AND substr(namespace, 1, 1) GLOB '[A-Za-z0-9]'
    AND namespace NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64
    AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_json TEXT NOT NULL CHECK (
    length(CAST(artifact_json AS BLOB)) <= 262144
    AND json_valid(artifact_json)
    AND json_extract(artifact_json, '$.schema') IN (
      'eliotr.ai-search-generation-registry.v1',
      'eliotr.ai-search-generation-registry.v2'
    )
    AND json_extract(artifact_json, '$.namespace') = namespace
    AND json_extract(artifact_json, '$.revision') = revision
    AND json_type(artifact_json, '$.registry') = 'object'
    AND json_type(artifact_json, '$.registry.generations') = 'array'
    AND json_array_length(artifact_json, '$.registry.generations') <= 64
  )
) STRICT;

INSERT INTO ai_search_generation_registry_next(
  namespace,
  revision,
  artifact_sha256,
  artifact_json
)
SELECT namespace, revision, artifact_sha256, artifact_json
FROM ai_search_generation_registry;

DROP TABLE ai_search_generation_registry;
ALTER TABLE ai_search_generation_registry_next
  RENAME TO ai_search_generation_registry;

CREATE TABLE ai_search_generation_registry_transition (
  namespace TEXT NOT NULL CHECK (
    length(namespace) BETWEEN 1 AND 256
    AND substr(namespace, 1, 1) GLOB '[A-Za-z0-9]'
    AND namespace NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation TEXT NOT NULL CHECK (operation IN (
    'BASELINE', 'DECLARE', 'OBSERVE', 'QUALIFY', 'PROMOTE', 'ROLLBACK', 'ARCHIVE'
  )),
  generation TEXT CHECK (
    generation IS NULL OR (
      length(generation) BETWEEN 1 AND 256
      AND substr(generation, 1, 1) GLOB '[A-Za-z0-9]'
      AND generation NOT GLOB '*[^A-Za-z0-9._:@/-]*'
    )
  ),
  previous_revision INTEGER CHECK (previous_revision IS NULL OR previous_revision > 0),
  previous_artifact_sha256 TEXT CHECK (
    previous_artifact_sha256 IS NULL OR (
      length(previous_artifact_sha256) = 64
      AND previous_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64
    AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  previous_active_head_generation TEXT,
  active_head_generation TEXT,
  transition_json TEXT NOT NULL CHECK (
    length(CAST(transition_json AS BLOB)) <= 786432
    AND json_valid(transition_json)
    AND json_extract(transition_json, '$.protocol') =
      'eliotr.ai-search-generation-registry-transition.v1'
    AND json_extract(transition_json, '$.namespace') = namespace
    AND json_extract(transition_json, '$.revision') = revision
    AND json_extract(transition_json, '$.operation') = operation
    AND json_extract(transition_json, '$.artifact_sha256') = artifact_sha256
  ),
  transition_sha256 TEXT CHECK (
    transition_sha256 IS NULL OR (
      length(transition_sha256) = 64
      AND transition_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  PRIMARY KEY(namespace, revision),
  FOREIGN KEY(namespace) REFERENCES ai_search_generation_registry(namespace),
  CHECK (
    (operation = 'BASELINE' AND transition_sha256 IS NULL AND generation IS NULL)
    OR (operation != 'BASELINE' AND transition_sha256 IS NOT NULL AND generation IS NOT NULL)
  ),
  CHECK (
    operation = 'BASELINE'
    OR revision = COALESCE(previous_revision, 0) + 1
  ),
  CHECK (
    (previous_revision IS NULL AND previous_artifact_sha256 IS NULL)
    OR (previous_revision IS NOT NULL AND previous_artifact_sha256 IS NOT NULL)
  )
) STRICT;

INSERT INTO ai_search_generation_registry_transition(
  namespace,
  revision,
  operation,
  generation,
  previous_revision,
  previous_artifact_sha256,
  artifact_sha256,
  previous_active_head_generation,
  active_head_generation,
  transition_json,
  transition_sha256
)
SELECT
  namespace,
  revision,
  'BASELINE',
  NULL,
  NULL,
  NULL,
  artifact_sha256,
  NULL,
  json_extract(artifact_json, '$.registry.active_head_generation'),
  json_object(
    'active_head_generation', json_extract(artifact_json, '$.registry.active_head_generation'),
    'artifact_json', artifact_json,
    'artifact_sha256', artifact_sha256,
    'changed_generations', json('[]'),
    'generation', NULL,
    'namespace', namespace,
    'operation', 'BASELINE',
    'previous_active_head_generation', NULL,
    'previous_artifact_sha256', NULL,
    'previous_revision', NULL,
    'protocol', 'eliotr.ai-search-generation-registry-transition.v1',
    'revision', revision
  ),
  NULL
FROM ai_search_generation_registry;

CREATE TRIGGER ai_search_generation_registry_transition_no_update
BEFORE UPDATE ON ai_search_generation_registry_transition
BEGIN
  SELECT RAISE(ABORT, 'generation registry transition history is append-only');
END;

CREATE TRIGGER ai_search_generation_registry_transition_no_delete
BEFORE DELETE ON ai_search_generation_registry_transition
BEGIN
  SELECT RAISE(ABORT, 'generation registry transition history is append-only');
END;

CREATE TABLE ai_search_generation_instance_history (
  namespace TEXT NOT NULL CHECK (
    length(namespace) BETWEEN 1 AND 256
    AND substr(namespace, 1, 1) GLOB '[A-Za-z0-9]'
    AND namespace NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  instance_id TEXT NOT NULL CHECK (
    length(instance_id) BETWEEN 1 AND 256
    AND substr(instance_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND instance_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  generation TEXT NOT NULL CHECK (
    length(generation) BETWEEN 1 AND 256
    AND substr(generation, 1, 1) GLOB '[A-Za-z0-9]'
    AND generation NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  first_registry_revision INTEGER NOT NULL CHECK (first_registry_revision > 0),
  profile_json TEXT NOT NULL CHECK (
    length(CAST(profile_json AS BLOB)) <= 16384
    AND json_valid(profile_json)
    AND json_type(profile_json) = 'object'
  ),
  profile_sha256 TEXT CHECK (
    profile_sha256 IS NULL OR (
      length(profile_sha256) = 64
      AND profile_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  PRIMARY KEY(namespace, generation),
  FOREIGN KEY(namespace) REFERENCES ai_search_generation_registry(namespace)
) STRICT;

INSERT INTO ai_search_generation_instance_history(
  namespace,
  instance_id,
  generation,
  first_registry_revision,
  profile_json,
  profile_sha256
)
SELECT
  registry.namespace,
  json_extract(generation.value, '$.profile.id'),
  json_extract(generation.value, '$.generation'),
  registry.revision,
  json_extract(generation.value, '$.profile'),
  NULL
FROM ai_search_generation_registry AS registry,
  json_each(registry.artifact_json, '$.registry.generations') AS generation;

CREATE TRIGGER ai_search_generation_instance_history_profile_immutable
BEFORE INSERT ON ai_search_generation_instance_history
WHEN EXISTS (
  SELECT 1
  FROM ai_search_generation_instance_history AS prior
  WHERE prior.namespace = NEW.namespace
    AND prior.instance_id = NEW.instance_id
    AND (
      (
        prior.profile_sha256 IS NOT NULL
        AND NEW.profile_sha256 IS NOT NULL
        AND prior.profile_sha256 != NEW.profile_sha256
      )
      OR (
        (prior.profile_sha256 IS NULL OR NEW.profile_sha256 IS NULL)
        AND json_remove(prior.profile_json, '$.generation') !=
            json_remove(NEW.profile_json, '$.generation')
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'AI Search physical instance profile is immutable');
END;

CREATE TRIGGER ai_search_generation_instance_history_no_update
BEFORE UPDATE ON ai_search_generation_instance_history
BEGIN
  SELECT RAISE(ABORT, 'generation instance history is append-only');
END;

CREATE TRIGGER ai_search_generation_instance_history_no_delete
BEFORE DELETE ON ai_search_generation_instance_history
BEGIN
  SELECT RAISE(ABORT, 'generation instance history is append-only');
END;

UPDATE schema_state
SET value = 'search-v5-ai-search-generation-registry-v2-audit',
    updated_at = '2026-10-14T00:00:00Z'
WHERE key = 'schema_generation';
