PRAGMA foreign_keys = ON;

-- Gateway fingerprints are immutable observations. They are separate from
-- model_generation qualification and dynamic route promotion authority.
CREATE TABLE research_model_fingerprint (
  observation_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint_ref TEXT NOT NULL UNIQUE,
  route_ref TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL CHECK (
    length(fingerprint_sha256) = 64
    AND fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  fingerprint_json TEXT NOT NULL CHECK (
    json_valid(fingerprint_json)
    AND length(CAST(fingerprint_json AS BLOB)) <= 65536
  ),
  observed_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX research_model_fingerprint_identity_idx
  ON research_model_fingerprint(route_ref, fingerprint_sha256);
CREATE INDEX research_model_fingerprint_latest_idx
  ON research_model_fingerprint(route_ref, observation_seq DESC);

CREATE TRIGGER research_model_fingerprint_immutable_update
BEFORE UPDATE ON research_model_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'research model fingerprints are immutable');
END;

CREATE TRIGGER research_model_fingerprint_immutable_delete
BEFORE DELETE ON research_model_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'research model fingerprints are immutable');
END;
