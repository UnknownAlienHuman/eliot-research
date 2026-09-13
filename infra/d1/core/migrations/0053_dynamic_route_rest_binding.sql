PRAGMA foreign_keys = ON;

-- The provider route binding is an immutable reconciliation record.  Its
-- canonical JSON and digest are stored together so installer retries can
-- recover an exact prior write without creating another provider route.
CREATE TABLE dynamic_route_rest_binding (
  provider_route_id TEXT PRIMARY KEY
    CHECK (length(provider_route_id) BETWEEN 1 AND 256),
  binding_sha256 TEXT NOT NULL CHECK (
    length(binding_sha256) = 64
    AND binding_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  binding_json TEXT NOT NULL CHECK (
    json_valid(binding_json)
    AND length(CAST(binding_json AS BLOB)) BETWEEN 1 AND 262144
  )
) STRICT;

CREATE TRIGGER dynamic_route_rest_binding_immutable_update
BEFORE UPDATE ON dynamic_route_rest_binding
BEGIN
  SELECT RAISE(ABORT, 'dynamic route REST bindings are immutable');
END;

CREATE TRIGGER dynamic_route_rest_binding_immutable_delete
BEFORE DELETE ON dynamic_route_rest_binding
BEGIN
  SELECT RAISE(ABORT, 'dynamic route REST bindings are immutable');
END;
