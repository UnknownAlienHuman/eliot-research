PRAGMA foreign_keys = ON;

CREATE TABLE ai_search_generation_registry (
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
    AND json_extract(artifact_json, '$.schema') =
      'eliotr.ai-search-generation-registry.v1'
    AND json_extract(artifact_json, '$.namespace') = namespace
    AND json_extract(artifact_json, '$.revision') = revision
    AND json_type(artifact_json, '$.registry') = 'object'
    AND json_type(artifact_json, '$.registry.generations') = 'array'
    AND json_array_length(artifact_json, '$.registry.generations') <= 64
  )
) STRICT;

UPDATE schema_state
SET value = 'search-v4-ai-search-generation-registry',
    updated_at = '2026-09-04T02:20:00Z'
WHERE key = 'schema_generation';
