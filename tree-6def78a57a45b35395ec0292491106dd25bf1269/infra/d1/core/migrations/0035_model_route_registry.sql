PRAGMA foreign_keys = ON;

-- Dynamic route provider candidates and the active route head are separate from
-- model_generation. The latter stores observed model fingerprints and
-- qualification evidence; it does not carry candidate or promotion identity.
CREATE TABLE dynamic_route_candidate (
  candidate_ref TEXT PRIMARY KEY,
  route_ref TEXT NOT NULL,
  route_version TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL CHECK (
    length(candidate_sha256) = 64
    AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  candidate_json TEXT NOT NULL CHECK (
    json_valid(candidate_json)
    AND length(CAST(candidate_json AS BLOB)) <= 262144
  ),
  staged_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX dynamic_route_candidate_identity_idx
  ON dynamic_route_candidate(route_ref, route_version);

CREATE TRIGGER dynamic_route_candidate_immutable_update
BEFORE UPDATE ON dynamic_route_candidate
BEGIN
  SELECT RAISE(ABORT, 'dynamic route candidates are immutable');
END;
CREATE TRIGGER dynamic_route_candidate_immutable_delete
BEFORE DELETE ON dynamic_route_candidate
BEGIN
  SELECT RAISE(ABORT, 'dynamic route candidates are immutable');
END;

CREATE TABLE dynamic_route_active_generation (
  route_ref TEXT PRIMARY KEY,
  route_version TEXT NOT NULL,
  candidate_ref TEXT NOT NULL REFERENCES dynamic_route_candidate(candidate_ref),
  candidate_sha256 TEXT NOT NULL CHECK (
    length(candidate_sha256) = 64
    AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  promotion_ref TEXT NOT NULL UNIQUE,
  promoted_at TEXT NOT NULL
) STRICT;

CREATE INDEX dynamic_route_active_candidate_idx
  ON dynamic_route_active_generation(candidate_ref);
